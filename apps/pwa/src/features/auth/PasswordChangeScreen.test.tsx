import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PasswordChangeScreen } from './PasswordChangeScreen.js';
import * as AuthContextModule from './AuthContext.js';
import type { PasswordChangeError } from './AuthContext.js';

function stubUseAuth(error?: PasswordChangeError) {
  const changeProvisionalPassword = vi.fn(async () => undefined);
  const cancelPasswordChange = vi.fn();
  vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
    state: { status: 'password_change_required', ...(error ? { error } : {}) },
    deviceId: 'device-1',
    loginWithPassword: vi.fn(),
    changeProvisionalPassword,
    cancelPasswordChange,
    submitNewPin: vi.fn(),
    unlockWithPin: vi.fn(),
    logout: vi.fn(),
  });
  return { changeProvisionalPassword, cancelPasswordChange };
}

async function fill(current: string, next: string, confirm: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Mot de passe provisoire'), current);
  await user.type(screen.getByLabelText('Nouveau mot de passe (8 caractères au moins)'), next);
  await user.type(screen.getByLabelText('Confirmer le nouveau mot de passe'), confirm);
  await user.click(screen.getByRole('button', { name: 'Enregistrer mon mot de passe' }));
}

describe('PasswordChangeScreen (MP-08, AV-251, AV-280)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('règles partagées vérifiées avant l’envoi : longueur, différent du provisoire, confirmation', async () => {
    const { changeProvisionalPassword } = stubUseAuth();
    render(<PasswordChangeScreen />);
    expect(screen.getByLabelText('Mot de passe provisoire')).toHaveAttribute('type', 'password');
    await fill('provisoire1', 'court', 'court');
    expect(screen.getByRole('alert')).toHaveTextContent('8 caractères au moins');
    cleanup();
    render(<PasswordChangeScreen />);
    await fill('provisoire1', 'provisoire1', 'provisoire1');
    expect(screen.getByRole('alert')).toHaveTextContent('différent du mot de passe provisoire');
    cleanup();
    render(<PasswordChangeScreen />);
    await fill('provisoire1', 'personnel-123', 'personnel-124');
    expect(screen.getByRole('alert')).toHaveTextContent('ne correspondent pas');
    expect(changeProvisionalPassword).not.toHaveBeenCalled();
    cleanup();
    render(<PasswordChangeScreen />);
    await fill('provisoire1', 'personnel-123', 'personnel-123');
    expect(changeProvisionalPassword).toHaveBeenCalledWith('provisoire1', 'personnel-123');
  });

  it('erreur du serveur affichée ; affichage des saisies ; abandon', async () => {
    const { cancelPasswordChange } = stubUseAuth('INVALID_CURRENT');
    const user = userEvent.setup();
    render(<PasswordChangeScreen />);
    expect(screen.getByRole('alert')).toHaveTextContent('Mot de passe provisoire incorrect.');
    await user.click(screen.getByLabelText('Afficher les mots de passe'));
    expect(screen.getByLabelText('Mot de passe provisoire')).toHaveAttribute('type', 'text');
    await user.click(screen.getByRole('button', { name: 'Annuler et se déconnecter' }));
    expect(cancelPasswordChange).toHaveBeenCalled();
  });
});
