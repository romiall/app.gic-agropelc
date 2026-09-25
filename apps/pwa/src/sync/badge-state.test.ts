import { describe, expect, it } from 'vitest';
import { computeBadgeState } from './badge-state.js';

const NOW = new Date('2026-09-25T12:00:00.000Z');

describe('computeBadgeState (UX-04)', () => {
  it('rouge quand des opérations exigent attention (conflit ou rejet), même en ligne et à jour', () => {
    const state = computeBadgeState({
      online: true,
      pendingCount: 0,
      attentionCount: 2,
      lastSyncAt: null,
      now: NOW,
    });
    expect(state.color).toBe('red');
    expect(state.labelParams).toEqual({ count: 2 });
  });

  it('gris hors ligne, avec le nombre d’heures écoulées depuis la dernière synchronisation', () => {
    const lastSyncAt = new Date(NOW.getTime() - 3 * 3_600_000).toISOString();
    const state = computeBadgeState({
      online: false,
      pendingCount: 0,
      attentionCount: 0,
      lastSyncAt,
      now: NOW,
    });
    expect(state.color).toBe('grey');
    expect(state.labelKey).toBe('sync.badge.offline_since');
    expect(state.labelParams).toEqual({ hours: 3 });
  });

  it('gris hors ligne sans historique de synchronisation (jamais synchronisé)', () => {
    const state = computeBadgeState({
      online: false,
      pendingCount: 0,
      attentionCount: 0,
      lastSyncAt: null,
      now: NOW,
    });
    expect(state.color).toBe('grey');
    expect(state.labelKey).toBe('sync.badge.offline_unknown');
  });

  it('orange en ligne avec des opérations en attente', () => {
    const state = computeBadgeState({
      online: true,
      pendingCount: 5,
      attentionCount: 0,
      lastSyncAt: null,
      now: NOW,
    });
    expect(state.color).toBe('orange');
    expect(state.labelParams).toEqual({ count: 5 });
  });

  it('vert en ligne, rien en attente, aucune attention requise', () => {
    const state = computeBadgeState({
      online: true,
      pendingCount: 0,
      attentionCount: 0,
      lastSyncAt: null,
      now: NOW,
    });
    expect(state.color).toBe('green');
  });

  it('l’attention prime sur le hors ligne (rouge, pas gris)', () => {
    const state = computeBadgeState({
      online: false,
      pendingCount: 0,
      attentionCount: 1,
      lastSyncAt: null,
      now: NOW,
    });
    expect(state.color).toBe('red');
  });
});
