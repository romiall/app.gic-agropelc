import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginScreen } from './LoginScreen.js';
import * as AuthContextModule from './AuthContext.js';

function stubUseAuth(
  error?: 'INVALID_CREDENTIALS' | 'OFFLINE' | 'LOCKED' | 'SERVER_ERROR',
  loginWithPassword: ReturnType<typeof vi.fn> = vi.fn(),
) {
  vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
    state: { status: 'login_required', ...(error ? { error } : {}) },
    deviceId: 'device-1',
    loginWithPassword,
    submitNewPin: vi.fn(),
    unlockWithPin: vi.fn(),
    logout: vi.fn(),
  });
}

describe('LoginScreen (ECR-ADM-01)', () => {
  it('affiche la marque et le formulaire', () => {
    stubUseAuth();
    render(<LoginScreen />);
    expect(screen.getByText('GIC AGROPELC')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Connexion' })).toBeInTheDocument();
    expect(screen.getByLabelText('Téléphone')).toBeInTheDocument();
    expect(screen.getByLabelText('Mot de passe')).toHaveAttribute('type', 'password');
  });

  it('affiche et masque le mot de passe à la demande', async () => {
    stubUseAuth();
    const user = userEvent.setup();
    render(<LoginScreen />);
    await user.click(screen.getByRole('button', { name: 'Afficher' }));
    expect(screen.getByLabelText('Mot de passe')).toHaveAttribute('type', 'text');
    await user.click(screen.getByRole('button', { name: 'Masquer' }));
    expect(screen.getByLabelText('Mot de passe')).toHaveAttribute('type', 'password');
  });

  it.each([
    ['INVALID_CREDENTIALS', 'Identifiants invalides.'],
    ['OFFLINE', 'Pas de réseau : la première connexion doit se faire en ligne.'],
    ['LOCKED', 'Trop de tentatives : réessayez plus tard.'],
    ['SERVER_ERROR', 'Le service est momentanément indisponible. Réessayez dans un instant.'],
  ] as const)('erreur %s : message distinct, annoncé comme alerte', (error, message) => {
    stubUseAuth(error);
    render(<LoginScreen />);
    expect(screen.getByRole('alert')).toHaveTextContent(message);
  });

  it('envoie le téléphone et le mot de passe saisis', async () => {
    const loginWithPassword = vi.fn(async () => {});
    stubUseAuth(undefined, loginWithPassword);
    const user = userEvent.setup();
    render(<LoginScreen />);
    await user.type(screen.getByLabelText('Téléphone'), '+237600000000');
    await user.type(screen.getByLabelText('Mot de passe'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    expect(loginWithPassword).toHaveBeenCalledWith('+237600000000', 'secret');
  });
});
