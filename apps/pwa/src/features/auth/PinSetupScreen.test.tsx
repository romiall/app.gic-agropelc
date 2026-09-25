import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PinSetupScreen } from './PinSetupScreen.js';
import * as AuthContextModule from './AuthContext.js';

function stubUseAuth(submitNewPin: ReturnType<typeof vi.fn>) {
  vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
    state: { status: 'pin_setup_required' },
    deviceId: 'device-1',
    loginWithPassword: vi.fn(),
    submitNewPin,
    unlockWithPin: vi.fn(),
    logout: vi.fn(),
  });
}

describe('PinSetupScreen (établissement du PIN, 07-security-rbac/02-securite.md §3)', () => {
  it('refuse un PIN qui ne fait pas 6 chiffres, sans appeler submitNewPin', async () => {
    const submitNewPin = vi.fn();
    stubUseAuth(submitNewPin);
    const user = userEvent.setup();
    render(<PinSetupScreen />);

    await user.type(screen.getByLabelText('Code PIN (6 chiffres)'), '12');
    await user.type(screen.getByLabelText('Confirmer le code PIN'), '12');
    await user.click(screen.getByText('Valider'));

    expect(submitNewPin).not.toHaveBeenCalled();
  });

  it('refuse deux PIN différents (pin_mismatch), sans appeler submitNewPin', async () => {
    const submitNewPin = vi.fn();
    stubUseAuth(submitNewPin);
    const user = userEvent.setup();
    render(<PinSetupScreen />);

    await user.type(screen.getByLabelText('Code PIN (6 chiffres)'), '123456');
    await user.type(screen.getByLabelText('Confirmer le code PIN'), '654321');
    await user.click(screen.getByText('Valider'));

    expect(await screen.findByText('Les deux codes ne correspondent pas.')).toBeInTheDocument();
    expect(submitNewPin).not.toHaveBeenCalled();
  });

  it('deux PIN identiques et valides : submitNewPin appelé avec le PIN', async () => {
    const submitNewPin = vi.fn(async () => {});
    stubUseAuth(submitNewPin);
    const user = userEvent.setup();
    render(<PinSetupScreen />);

    await user.type(screen.getByLabelText('Code PIN (6 chiffres)'), '123456');
    await user.type(screen.getByLabelText('Confirmer le code PIN'), '123456');
    await user.click(screen.getByText('Valider'));

    await waitFor(() => expect(submitNewPin).toHaveBeenCalledWith('123456'));
  });
});
