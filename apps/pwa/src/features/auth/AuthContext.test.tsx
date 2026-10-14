import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider, useAuth } from './AuthContext.js';
import { getDb } from '../../storage/db.js';
import { hasLocalSession, setupPin } from '../../storage/session.js';
import { getSessionRuntime, clearSessionRuntime } from './session-runtime.js';
import { login } from './login.js';
import { changePassword } from './change-password.js';

const FAKE_USER_ID = '11111111-1111-7111-8111-111111111111';

function fakeAccessToken(claims: Record<string, string>): string {
  const part = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  // Jamais vérifié côté appareil (`jwt-decode.ts`) : signature factice, seul le payload compte.
  return `${part({ alg: 'none' })}.${part(claims)}.`;
}

vi.mock('./login.js', () => ({
  login: vi.fn(async () => ({
    ok: true,
    accessToken: fakeAccessToken({ sub: FAKE_USER_ID, device_id: 'd', session_id: 's' }),
    refreshToken: 'refresh-token-1',
    expiresIn: 900,
    mustChangePassword: false,
    deviceStatus: 'ACTIVE' as const,
  })),
}));

vi.mock('./change-password.js', () => ({ changePassword: vi.fn() }));

function TestHarness() {
  const {
    state,
    loginWithPassword,
    changeProvisionalPassword,
    cancelPasswordChange,
    submitNewPin,
    unlockWithPin,
  } = useAuth();
  return (
    <div>
      <p data-testid="status">{state.status}</p>
      {state.status === 'login_required' && (
        <button onClick={() => void loginWithPassword('650000000', 'secret')}>login</button>
      )}
      {state.status === 'password_change_required' && (
        <>
          <p data-testid="error">{state.error ?? ''}</p>
          <button onClick={() => void changeProvisionalPassword('provisoire1', 'personnel-123')}>
            change-password
          </button>
          <button onClick={cancelPasswordChange}>cancel</button>
        </>
      )}
      {state.status === 'login_required' && state.error ? (
        <p data-testid="login-error">{state.error}</p>
      ) : null}
      {state.status === 'pin_setup_required' && (
        <button onClick={() => void submitNewPin('123456')}>set-pin</button>
      )}
      {state.status === 'locked' && (
        <button onClick={() => void unlockWithPin('123456')}>unlock</button>
      )}
    </div>
  );
}

describe('AuthContext (machine à états ECR-ADM-01/02)', () => {
  beforeEach(async () => {
    await getDb().delete();
    await getDb().open();
    clearSessionRuntime();
  });

  afterEach(async () => {
    clearSessionRuntime();
    await getDb().delete();
    await getDb().open();
  });

  it('mot de passe provisoire (MP-08, AV-251) : changement imposé avant le PIN, erreurs, abandon', async () => {
    const provisionalLogin = {
      ok: true as const,
      accessToken: fakeAccessToken({ sub: FAKE_USER_ID, device_id: 'd', session_id: 's' }),
      refreshToken: 'refresh-token-1',
      expiresIn: 900,
      mustChangePassword: true,
      deviceStatus: 'ACTIVE' as const,
    };
    vi.mocked(login).mockResolvedValueOnce(provisionalLogin);
    vi.mocked(changePassword).mockResolvedValueOnce({ ok: false, reason: 'INVALID_CURRENT' });
    const user = userEvent.setup();
    render(
      <AuthProvider>
        <TestHarness />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('login_required'));
    await user.click(screen.getByText('login'));
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('password_change_required'),
    );
    // Mot de passe provisoire faux : l'écran reste, avec l'erreur.
    await user.click(screen.getByText('change-password'));
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('INVALID_CURRENT'));
    expect(vi.mocked(changePassword)).toHaveBeenLastCalledWith({
      accessToken: provisionalLogin.accessToken,
      currentPassword: 'provisoire1',
      newPassword: 'personnel-123',
    });
    // Réussite : création du PIN, puis session ouverte, sans nouvelle connexion.
    vi.mocked(changePassword).mockResolvedValueOnce({ ok: true });
    await user.click(screen.getByText('change-password'));
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('pin_setup_required'),
    );
    await user.click(screen.getByText('set-pin'));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unlocked'));
    expect(getSessionRuntime()?.refreshToken).toBe('refresh-token-1');
  });

  it('changement imposé : abandon ou connexion expirée ramènent à la connexion, sans session', async () => {
    const provisionalLogin = {
      ok: true as const,
      accessToken: fakeAccessToken({ sub: FAKE_USER_ID, device_id: 'd', session_id: 's' }),
      refreshToken: 'refresh-token-1',
      expiresIn: 900,
      mustChangePassword: true,
      deviceStatus: 'ACTIVE' as const,
    };
    // Deux connexions : l'une abandonnée, l'autre expirée.
    vi.mocked(login)
      .mockResolvedValueOnce(provisionalLogin)
      .mockResolvedValueOnce(provisionalLogin);
    const user = userEvent.setup();
    render(
      <AuthProvider>
        <TestHarness />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('login_required'));
    await user.click(screen.getByText('login'));
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('password_change_required'),
    );
    await user.click(screen.getByText('cancel'));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('login_required'));
    expect(await hasLocalSession(getDb())).toBe(false);

    vi.mocked(changePassword).mockResolvedValueOnce({ ok: false, reason: 'SESSION_EXPIRED' });
    await user.click(screen.getByText('login'));
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('password_change_required'),
    );
    await user.click(screen.getByText('change-password'));
    await waitFor(() =>
      expect(screen.getByTestId('login-error')).toHaveTextContent('SESSION_EXPIRED'),
    );
    expect(await hasLocalSession(getDb())).toBe(false);
  });

  it('changement imposé : une réponse arrivée après « Annuler » est ignorée (MP-11)', async () => {
    vi.mocked(login).mockResolvedValueOnce({
      ok: true as const,
      accessToken: fakeAccessToken({ sub: FAKE_USER_ID, device_id: 'd', session_id: 's' }),
      refreshToken: 'refresh-token-1',
      expiresIn: 900,
      mustChangePassword: true,
      deviceStatus: 'ACTIVE' as const,
    });
    let answer: (result: { ok: true }) => void = () => undefined;
    vi.mocked(changePassword).mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const user = userEvent.setup();
    render(
      <AuthProvider>
        <TestHarness />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('login_required'));
    await user.click(screen.getByText('login'));
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('password_change_required'),
    );
    await user.click(screen.getByText('change-password'));
    await user.click(screen.getByText('cancel'));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('login_required'));
    answer({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Ni écran du PIN sans connexion, ni session.
    expect(screen.getByTestId('status')).toHaveTextContent('login_required');
    expect(await hasLocalSession(getDb())).toBe(false);
  });

  it('échéance du jeton d’accès : courue depuis la connexion, pas depuis le PIN (MP-11)', async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider>
        <TestHarness />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('login_required'));
    await user.click(screen.getByText('login'));
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('pin_setup_required'),
    );
    const loggedInBy = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await user.click(screen.getByText('set-pin'));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unlocked'));
    expect(getSessionRuntime()!.accessTokenExpiresAt).toBeLessThanOrEqual(loggedInBy + 900_000);
  });

  it('parcours complet : login_required -> pin_setup_required -> unlocked', async () => {
    const user = userEvent.setup();
    render(
      <AuthProvider>
        <TestHarness />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('login_required'));

    await user.click(screen.getByText('login'));
    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('pin_setup_required'),
    );

    await user.click(screen.getByText('set-pin'));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unlocked'));

    expect(await hasLocalSession(getDb())).toBe(true);
    expect(getSessionRuntime()?.userId).toBe(FAKE_USER_ID);
  });

  it('une session locale existante (PIN déjà établi) démarre verrouillée, puis se déverrouille par PIN', async () => {
    // Simule un appareil déjà enrôlé, PIN déjà établi (ex. un précédent démarrage de
    // l'application) : `setupPin` directement, sans repasser par l'écran de connexion.
    await setupPin(getDb(), {
      userId: FAKE_USER_ID,
      deviceStatus: 'ACTIVE',
      refreshToken: 'refresh-token-1',
      pin: '123456',
    });

    const user = userEvent.setup();
    render(
      <AuthProvider>
        <TestHarness />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('locked'));

    await user.click(screen.getByText('unlock'));
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unlocked'));
    expect(getSessionRuntime()?.userId).toBe(FAKE_USER_ID);
  });
});
