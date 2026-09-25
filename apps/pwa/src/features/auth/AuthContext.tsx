/**
 * État d'authentification de l'application (ECR-ADM-01, 02) : machine à 5 états côté
 * appareil (distincte de SM-USER/SM-DEVICE, qui vivent côté serveur) —
 * `loading` → `login_required` ⇄ `pin_setup_required` → `unlocked` ⇄ `locked`.
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
import { login as loginRequest } from './login.js';
import { decodeAccessTokenClaims } from '../../platform/jwt-decode.js';
import { clearSessionRuntime, setSessionRuntime } from './session-runtime.js';

interface StagedLogin {
  readonly userId: string;
  readonly refreshToken: string;
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly deviceStatus: 'PENDING' | 'ACTIVE';
}

export type AuthState =
  | { readonly status: 'loading' }
  | {
      readonly status: 'login_required';
      readonly error?: 'INVALID_CREDENTIALS' | 'OFFLINE' | 'LOCKED';
    }
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
        const error = result.reason === 'UNKNOWN' ? 'OFFLINE' : result.reason;
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
      });
      setState({ status: 'pin_setup_required' });
    },
    [deviceId],
  );

  const submitNewPin = useCallback(
    async (pin: string) => {
      if (!staged || !deviceId) return;
      const pinKey = await persistPin(db, {
        userId: staged.userId,
        deviceStatus: staged.deviceStatus,
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
    await db.session.clear();
    await db.pinLocks.clear();
    setState({ status: 'login_required' });
  }, [db]);

  const value = useMemo<AuthContextValue>(
    () => ({ state, deviceId, loginWithPassword, submitNewPin, unlockWithPin, logout }),
    [state, deviceId, loginWithPassword, submitNewPin, unlockWithPin, logout],
  );

  return <AuthReactContext.Provider value={value}>{children}</AuthReactContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthReactContext);
  if (!ctx) throw new Error('useAuth doit être utilisé sous <AuthProvider>.');
  return ctx;
}
