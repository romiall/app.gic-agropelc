/**
 * État « une nouvelle version attend » (ADR-052, AV-505) : notification des abonnés une seule fois par changement,
 * mise à jour à la demande qui active le nouveau service worker et recharge la page, sans rien faire s'il n'attend pas.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyUpdateNow,
  isUpdateWaiting,
  markUpdateWaiting,
  setUpdateApplier,
  subscribeUpdateWaiting,
} from './update-state.js';

afterEach(() => {
  markUpdateWaiting(false);
  setUpdateApplier(undefined);
});

describe('état de la version en attente', () => {
  it('prévient les abonnés à chaque changement, jamais deux fois pour la même valeur', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeUpdateWaiting(listener);
    markUpdateWaiting(true);
    markUpdateWaiting(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(isUpdateWaiting()).toBe(true);
    markUpdateWaiting(false);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    markUpdateWaiting(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('la mise à jour à la demande active le nouveau service worker et recharge la page', async () => {
    const applier = vi.fn(async () => undefined);
    setUpdateApplier(applier);
    markUpdateWaiting(true);
    await expect(applyUpdateNow()).resolves.toBe(true);
    expect(applier).toHaveBeenCalledTimes(1);
    expect(applier).toHaveBeenCalledWith(true);
    expect(isUpdateWaiting()).toBe(false);
  });

  it('rien n’attend, ou rien pour l’appliquer : aucune action', async () => {
    const applier = vi.fn(async () => undefined);
    setUpdateApplier(applier);
    await expect(applyUpdateNow()).resolves.toBe(false);
    expect(applier).not.toHaveBeenCalled();

    setUpdateApplier(undefined);
    markUpdateWaiting(true);
    await expect(applyUpdateNow()).resolves.toBe(false);
    expect(isUpdateWaiting()).toBe(true);
  });
});
