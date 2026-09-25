import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider, useAuth } from './AuthContext.js';
import { getDb } from '../../storage/db.js';
import { hasLocalSession, setupPin } from '../../storage/session.js';
import { getSessionRuntime, clearSessionRuntime } from './session-runtime.js';

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

function TestHarness() {
  const { state, loginWithPassword, submitNewPin, unlockWithPin } = useAuth();
  return (
    <div>
      <p data-testid="status">{state.status}</p>
      {state.status === 'login_required' && (
        <button onClick={() => void loginWithPassword('650000000', 'secret')}>login</button>
      )}
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
