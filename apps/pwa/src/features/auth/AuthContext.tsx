/**
 * État d'authentification de l'application (ECR-ADM-01, 02) : machine à 6 états côté
 * appareil (distincte de SM-USER/SM-DEVICE, qui vivent côté serveur) —
 * `loading` → `login_required` ⇄ (`password_change_required` →) `pin_setup_required` → `unlocked` ⇄
 * `locked`.
 *
 * MP-08 (AV-251) : un compte au mot de passe provisoire (`must_change_password` rendu par la connexion)
 * passe par l'écran de changement juste après la connexion, avant la création du PIN : rien d'autre ne
 * s'ouvre avant. Aucun mot de passe n'est conservé par l'appareil.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { getDb } from '../../storage/db.js';
import { getOrCreateDeviceId } from '../../storage/device.js';
import { idGenerator } from '../../platform/composition.js';
import {
  hasLocalSession,
  setupPin as persistPin,
  unlockWithPin as tryUnlockWithPin,
} from '../../storage/session.js';
import { login as loginRequest, type DeviceRefusal } from './login.js';
import { decodeAccessTokenClaims } from '../../platform/jwt-decode.js';
import { clearSessionRuntime, setSessionRuntime } from './session-runtime.js';
import { changePassword as changePasswordRequest } from './change-password.js';
import type { NewPasswordProblem } from '@gic/domain';

interface StagedLogin {
  readonly userId: string;
  readonly refreshToken: string;
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly deviceStatus: 'PENDING' | 'ACTIVE';
  readonly deviceShortCode?: string;
}

/** Échec du changement imposé du mot de passe (MP-08). */
export type PasswordChangeError =
  'INVALID_CURRENT' | 'LOCKED' | 'OFFLINE' | 'SERVER_ERROR' | NewPasswordProblem;

export type AuthState =
  | { readonly status: 'loading' }
  | {
      readonly status: 'login_required';
      readonly error?:
        | 'INVALID_CREDENTIALS'
        | 'OFFLINE'
        | 'LOCKED'
        | 'SERVER_ERROR'
        | 'SESSION_EXPIRED'
        | DeviceRefusal;
    }
  | { readonly status: 'password_change_required'; readonly error?: PasswordChangeError }
  | { readonly status: 'pin_setup_required' }
  | { readonly status: 'locked'; readonly pinError?: { readonly attemptsLeft: number } | 'WIPED' }
  | {
      readonly status: 'unlocked';
      readonly userId: string;
      readonly deviceStatus: 'PENDING' | 'ACTIVE';
    };

export interface AuthContextValue {
  readonly state: AuthState;
  readonly deviceId: string | undefined;
  loginWithPassword(phone: string, password: string): Promise<void>;
  /** Changement imposé du mot de passe provisoire, avant le PIN (MP-08, AV-251). */
  changeProvisionalPassword(currentPassword: string, newPassword: string): Promise<void>;
  /** Abandon du changement imposé : retour à la connexion, sans session. */
  cancelPasswordChange(): void;
  submitNewPin(pin: string): Promise<void>;
  unlockWithPin(pin: string): Promise<void>;
  logout(): Promise<void>;
}

const AuthReactContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { readonly children: ReactNode }) {
  const db = useMemo(() => getDb(), []);
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  const [deviceId, setDeviceId] = useState<string>();
  const [staged, setStaged] = useState<StagedLogin>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const id = await getOrCreateDeviceId(db, idGenerator);
      const locked = await hasLocalSession(db);
      if (cancelled) return;
      setDeviceId(id);
      setState(locked ? { status: 'locked' } : { status: 'login_required' });
    })();
    return () => {
      cancelled = true;
    };
  }, [db]);

  const loginWithPassword = useCallback(
    async (phone: string, password: string) => {
      if (!deviceId) return;
      const result = await loginRequest({ phone, password, deviceId });
      if (!result.ok) {
        // Une réponse HTTP inattendue (500, 503…) n'est pas une absence de réseau : message distinct.
        const error = result.reason === 'UNKNOWN' ? 'SERVER_ERROR' : result.reason;
        setState({ status: 'login_required', error });
        return;
      }
      const claims = decodeAccessTokenClaims(result.accessToken);
      setStaged({
        userId: claims.sub,
        refreshToken: result.refreshToken,
        accessToken: result.accessToken,
        expiresIn: result.expiresIn,
        deviceStatus: result.deviceStatus,
        ...(result.deviceShortCode !== undefined
          ? { deviceShortCode: result.deviceShortCode }
          : {}),
      });
      setState(
        result.mustChangePassword
          ? { status: 'password_change_required' }
          : { status: 'pin_setup_required' },
      );
    },
    [deviceId],
  );

  const changeProvisionalPassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      if (!staged) return;
      const result = await changePasswordRequest({
        accessToken: staged.accessToken,
        currentPassword,
        newPassword,
      });
      if (result.ok) {
        setState({ status: 'pin_setup_required' });
        return;
      }
      if (result.reason === 'SESSION_EXPIRED') {
        // Jeton de la connexion expiré (15 min) : reprendre la connexion.
        setStaged(undefined);
        setState({ status: 'login_required', error: 'SESSION_EXPIRED' });
        return;
      }
      const error: PasswordChangeError =
        result.reason === 'INVALID_NEW'
          ? result.problem
          : result.reason === 'UNKNOWN'
            ? 'SERVER_ERROR'
            : result.reason;
      setState({ status: 'password_change_required', error });
    },
    [staged],
  );

  const cancelPasswordChange = useCallback(() => {
    setStaged(undefined);
    setState({ status: 'login_required' });
  }, []);

  const submitNewPin = useCallback(
    async (pin: string) => {
      if (!staged || !deviceId) return;
      const pinKey = await persistPin(db, {
        userId: staged.userId,
        deviceStatus: staged.deviceStatus,
        ...(staged.deviceShortCode !== undefined
          ? { deviceShortCode: staged.deviceShortCode }
          : {}),
        refreshToken: staged.refreshToken,
        pin,
      });
      setSessionRuntime({
        userId: staged.userId,
        deviceId,
        deviceStatus: staged.deviceStatus,
        refreshToken: staged.refreshToken,
        accessToken: staged.accessToken,
        accessTokenExpiresAt: Date.now() + staged.expiresIn * 1000,
        pinKey,
      });
      setStaged(undefined);
      setState({ status: 'unlocked', userId: staged.userId, deviceStatus: staged.deviceStatus });
    },
    [staged, deviceId, db],
  );

  const unlockWithPin = useCallback(
    async (pin: string) => {
      if (!deviceId) return;
      const result = await tryUnlockWithPin(db, pin);
      if (!result.ok) {
        if (result.reason === 'INVALID_PIN') {
          setState({ status: 'locked', pinError: { attemptsLeft: result.attemptsLeft } });
          return;
        }
        setState({ status: 'login_required' });
        return;
      }
      setSessionRuntime({
        userId: result.userId,
        deviceId,
        deviceStatus: result.deviceStatus,
        refreshToken: result.refreshToken,
        accessToken: undefined,
        accessTokenExpiresAt: undefined,
        pinKey: result.pinKey,
      });
      setState({ status: 'unlocked', userId: result.userId, deviceStatus: result.deviceStatus });
    },
    [deviceId, db],
  );

  const logout = useCallback(async () => {
    clearSessionRuntime();
    setStaged(undefined);
    await db.session.clear();
    await db.pinLocks.clear();
    await db.navigation.clear();
    setState({ status: 'login_required' });
  }, [db]);

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      deviceId,
      loginWithPassword,
      changeProvisionalPassword,
      cancelPasswordChange,
      submitNewPin,
      unlockWithPin,
      logout,
    }),
    [
      state,
      deviceId,
      loginWithPassword,
      changeProvisionalPassword,
      cancelPasswordChange,
      submitNewPin,
      unlockWithPin,
      logout,
    ],
  );

  return <AuthReactContext.Provider value={value}>{children}</AuthReactContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthReactContext);
  if (!ctx) throw new Error('useAuth doit être utilisé sous <AuthProvider>.');
  return ctx;
}
