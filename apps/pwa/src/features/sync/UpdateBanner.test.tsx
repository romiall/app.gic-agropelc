/**
 * Bandeau « nouvelle version disponible » (ADR-052, AV-505) : absent tant qu'aucune version n'attend ; annonce la
 * version, dit combien d'opérations attendent leur envoi (elles restent sur le téléphone) et offre de l'installer
 * tout de suite.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markUpdateWaiting, setUpdateApplier } from '../../platform/update-state.js';
import { UpdateBanner } from './UpdateBanner.js';

let pending = 0;
vi.mock('../../sync/outbox.js', () => ({ countPending: vi.fn(async () => pending) }));

describe('UpdateBanner', () => {
  beforeEach(() => {
    pending = 0;
  });

  afterEach(() => {
    cleanup();
    markUpdateWaiting(false);
    setUpdateApplier(undefined);
  });

  it('ne montre rien tant qu’aucune version n’attend', () => {
    render(<UpdateBanner />);
    expect(screen.queryByText(/nouvelle version/i)).toBeNull();
  });

  it('annonce la version qui attend, sans opération en attente', async () => {
    render(<UpdateBanner />);
    act(() => markUpdateWaiting(true));
    expect(
      await screen.findByText(/nouvelle version de l’application est disponible/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mettre à jour maintenant' })).toBeEnabled();
    expect(screen.queryByText(/attend encore son envoi|attendent encore leur envoi/)).toBeNull();
  });

  it('dit combien d’opérations attendent leur envoi et ce qu’il en advient', async () => {
    pending = 3;
    render(<UpdateBanner />);
    act(() => markUpdateWaiting(true));
    expect(await screen.findByText(/3 opérations attendent encore leur envoi/)).toBeInTheDocument();
    expect(screen.getByText(/partiront après la mise à jour/)).toBeInTheDocument();
  });

  it('au clic, active la nouvelle version et le dit', async () => {
    const applier = vi.fn(() => new Promise<void>(() => undefined)); // la page se recharge : jamais de retour
    setUpdateApplier(applier);
    const user = userEvent.setup();
    render(<UpdateBanner />);
    act(() => markUpdateWaiting(true));
    await user.click(await screen.findByRole('button', { name: 'Mettre à jour maintenant' }));
    await waitFor(() => expect(applier).toHaveBeenCalledTimes(1));
    expect(applier).toHaveBeenCalledWith(true);
    expect(await screen.findByRole('button', { name: 'Mise à jour en cours…' })).toBeDisabled();
  });
});
