import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SYNC_ERROR_EXCLUDED_CODES,
  MAX_SYNC_ALERT_HOURS,
  MAX_SYNC_STALE_HORIZON_DAYS,
  agedSequenceGaps,
  clockSkewMinutes,
  deviceStaleness,
  gapsExplainedByPending,
  isSyncErrorAlertable,
  missingSequenceCount,
  nextKnownGaps,
  parseKnownGaps,
  sameSequenceGaps,
  syncErrorAlertWindowHoursOrDefault,
  syncErrorCodeOf,
  syncErrorExcludedCodesOrDefault,
  syncSeqGapAlertHoursOrDefault,
  syncStaleHoursOrDefault,
  syncStaleHorizonDaysOrDefault,
  unsignaledSequenceGaps,
} from './sync-alerts.js';

const at = (iso: string) => new Date(iso);

describe('réglages de synchronisation : défauts et bornes', () => {
  it.each([
    ['sync.stale_hours', syncStaleHoursOrDefault],
    ['sync.error_alert_window_hours', syncErrorAlertWindowHoursOrDefault],
    ['sync.seq_gap_alert_hours', syncSeqGapAlertHoursOrDefault],
  ])('%s : nombre strictement positif, plafonné, sinon 24', (_key, read) => {
    expect(read(6)).toBe(6);
    expect(read(0.5)).toBe(0.5);
    expect(read(1e12)).toBe(MAX_SYNC_ALERT_HOURS);
    for (const invalid of [0, -3, NaN, Infinity, '12', null, undefined, {}]) {
      expect(read(invalid)).toBe(24);
    }
  });

  it('sync.stale_horizon_days : entier ≥ 0 (0 : aucun horizon), plafonné, sinon 30', () => {
    expect(syncStaleHorizonDaysOrDefault(7)).toBe(7);
    expect(syncStaleHorizonDaysOrDefault(7.9)).toBe(7);
    expect(syncStaleHorizonDaysOrDefault(0)).toBe(0);
    expect(syncStaleHorizonDaysOrDefault(1e9)).toBe(MAX_SYNC_STALE_HORIZON_DAYS);
    for (const invalid of [-1, NaN, Infinity, '30', null, undefined]) {
      expect(syncStaleHorizonDaysOrDefault(invalid)).toBe(30);
    }
  });

  it('sync.error_alert_excluded_codes : liste de chaînes, vide admise, sinon le défaut', () => {
    expect(syncErrorExcludedCodesOrDefault(['A', ' B '])).toEqual(['A', 'B']);
    expect(syncErrorExcludedCodesOrDefault([])).toEqual([]);
    expect(syncErrorExcludedCodesOrDefault(['A', 3, '', '  ', null])).toEqual(['A']);
    for (const invalid of ['A', 3, null, undefined, {}]) {
      expect(syncErrorExcludedCodesOrDefault(invalid)).toEqual([
        'COMMAND_DISCARDED',
        'DEPENDENCY_REJECTED',
      ]);
    }
    expect(DEFAULT_SYNC_ERROR_EXCLUDED_CODES).toEqual(['COMMAND_DISCARDED', 'DEPENDENCY_REJECTED']);
  });
});

describe('syncErrorCodeOf — regroupement des causes (AV-471)', () => {
  it('le code détaillé est ramené à sa famille', () => {
    expect(
      syncErrorCodeOf({ errorCode: 'VALIDATION_ERROR:quantity', openConflictType: null }),
    ).toBe('VALIDATION_ERROR');
    expect(syncErrorCodeOf({ errorCode: 'FORBIDDEN', openConflictType: null })).toBe('FORBIDDEN');
  });

  it('un code propre l’emporte sur le conflit ; sans code, le type du conflit ouvert', () => {
    expect(syncErrorCodeOf({ errorCode: 'DEVICE_REVOKED', openConflictType: 'X' })).toBe(
      'DEVICE_REVOKED',
    );
    expect(syncErrorCodeOf({ errorCode: null, openConflictType: 'STOCK_NEGATIVE' })).toBe(
      'STOCK_NEGATIVE',
    );
  });

  it('ni code ni conflit ouvert, ou code vide : rien à signaler', () => {
    expect(syncErrorCodeOf({ errorCode: null, openConflictType: null })).toBeNull();
    expect(syncErrorCodeOf({ errorCode: '', openConflictType: null })).toBeNull();
    expect(syncErrorCodeOf({ errorCode: ':x', openConflictType: null })).toBeNull();
  });

  it('les codes exclus ne sont pas signalés', () => {
    const excluded = ['COMMAND_DISCARDED'];
    expect(isSyncErrorAlertable('COMMAND_DISCARDED', excluded)).toBe(false);
    expect(isSyncErrorAlertable('FORBIDDEN', excluded)).toBe(true);
    expect(isSyncErrorAlertable('COMMAND_DISCARDED', [])).toBe(true);
  });
});

describe('deviceStaleness — appareil actif sans synchronisation (AV-472)', () => {
  const base = {
    activatedAt: at('2026-10-01T08:00:00.000Z'),
    staleHours: 24,
    horizonDays: 30,
  };

  it('plus de 24 h depuis le dernier contact : en retard (borne exclue)', () => {
    const lastContactAt = at('2026-10-10T08:00:00.000Z');
    expect(
      deviceStaleness({ ...base, lastContactAt, now: at('2026-10-11T08:00:00.000Z') }),
    ).toMatchObject({
      stale: false,
      hoursSince: 24,
    });
    expect(
      deviceStaleness({ ...base, lastContactAt, now: at('2026-10-11T08:00:00.001Z') }),
    ).toMatchObject({
      stale: true,
      hoursSince: 24,
    });
    expect(
      deviceStaleness({ ...base, lastContactAt, now: at('2026-10-11T09:30:00.000Z') }),
    ).toMatchObject({
      stale: true,
      hoursSince: 25,
      sinceAt: lastContactAt,
    });
  });

  it('jamais contacté : compté depuis l’activation, pas dès l’approbation', () => {
    expect(
      deviceStaleness({ ...base, lastContactAt: null, now: at('2026-10-02T07:00:00.000Z') }).stale,
    ).toBe(false);
    expect(
      deviceStaleness({ ...base, lastContactAt: null, now: at('2026-10-02T09:00:00.000Z') }),
    ).toMatchObject({
      stale: true,
      sinceAt: base.activatedAt,
    });
  });

  it('activation postérieure au dernier contact (réactivé après blocage) : l’activation fait référence', () => {
    const result = deviceStaleness({
      ...base,
      lastContactAt: at('2026-09-01T08:00:00.000Z'),
      now: at('2026-10-01T20:00:00.000Z'),
    });
    expect(result).toMatchObject({ stale: false, sinceAt: base.activatedAt, hoursSince: 12 });
  });

  it('au-delà de l’horizon d’oubli, l’appareil n’est plus signalé ; 0 supprime l’horizon', () => {
    const lastContactAt = at('2026-09-01T08:00:00.000Z');
    const now = at('2026-10-15T08:00:00.000Z'); // 44 jours
    expect(deviceStaleness({ ...base, activatedAt: lastContactAt, lastContactAt, now }).stale).toBe(
      false,
    );
    expect(
      deviceStaleness({ ...base, activatedAt: lastContactAt, lastContactAt, now, horizonDays: 0 })
        .stale,
    ).toBe(true);
    // Dans l'horizon (borne comprise) : encore signalé.
    expect(
      deviceStaleness({
        ...base,
        activatedAt: lastContactAt,
        lastContactAt,
        now: at('2026-10-01T08:00:00.000Z'),
      }).stale,
    ).toBe(true);
  });

  it('une horloge en avance sur le contact ne produit pas d’heures négatives', () => {
    const result = deviceStaleness({
      ...base,
      lastContactAt: at('2026-10-12T08:00:00.000Z'),
      now: at('2026-10-11T08:00:00.000Z'),
    });
    expect(result).toMatchObject({ stale: false, hoursSince: 0 });
  });
});

describe('trous de séquence (AV-473)', () => {
  const gap = (from: number, to: number, openedAt: string) => ({
    from,
    to,
    openedAt: at(openedAt),
  });

  it('compte les numéros manquants', () => {
    expect(missingSequenceCount([])).toBe(0);
    expect(
      missingSequenceCount([
        gap(5, 5, '2026-10-01T00:00:00.000Z'),
        gap(8, 11, '2026-10-01T00:00:00.000Z'),
      ]),
    ).toBe(5);
  });

  it('ne retient que les plages visibles depuis plus de N heures (borne exclue)', () => {
    const now = at('2026-10-02T12:00:00.000Z');
    const gaps = [
      gap(3, 3, '2026-10-01T12:00:00.000Z'), // exactement 24 h : pas encore
      gap(6, 7, '2026-10-01T11:59:59.999Z'), // un instant de plus
      gap(9, 9, '2026-10-02T08:00:00.000Z'),
    ];
    expect(agedSequenceGaps(gaps, now, 24).map((g) => g.from)).toEqual([6]);
    expect(agedSequenceGaps(gaps, now, 4).map((g) => g.from)).toEqual([3, 6]);
  });

  it('les restes déclarés expliquent les numéros manquants s’ils les couvrent tous', () => {
    const gaps = [
      { from: 4, to: 6 },
      { from: 9, to: 9 },
    ]; // 4 manquants
    expect(gapsExplainedByPending(gaps, 4)).toBe(true);
    expect(gapsExplainedByPending(gaps, 12)).toBe(true);
    expect(gapsExplainedByPending(gaps, 3)).toBe(false);
    expect(gapsExplainedByPending(gaps, 0)).toBe(false);
    // Sans déclaration, rien n'est supposé.
    expect(gapsExplainedByPending(gaps, null)).toBe(false);
    expect(gapsExplainedByPending([], 0)).toBe(true);
    // Aucun numéro manquant mais aucune déclaration : rien n'est expliqué (rien à expliquer non plus).
    expect(gapsExplainedByPending([], null)).toBe(false);
  });

  it('les plages mémorisées se lisent en paires valides, le reste est ignoré', () => {
    expect(
      parseKnownGaps([
        [3, 5],
        [9, 9],
      ]),
    ).toEqual([
      [3, 5],
      [9, 9],
    ]);
    expect(parseKnownGaps([[3, 5], [5, 3], [0, 2], [1], 'x', [1.5, 2], null])).toEqual([[3, 5]]);
    // Une triplette n'est pas une paire.
    expect(
      parseKnownGaps([
        [3, 5, 9],
        [7, 8],
      ]),
    ).toEqual([[7, 8]]);
    expect(parseKnownGaps(null)).toEqual([]);
    expect(parseKnownGaps({})).toEqual([]);
    expect(parseKnownGaps('[[1,2]]')).toEqual([]);
  });

  it('une plage nouvelle ou plus large est à signaler, une plage déjà signalée ou réduite non', () => {
    const known: readonly (readonly [number, number])[] = [[4, 6]];
    // Déjà signalée, ou réduite par l'arrivée d'une commande tardive, ou scindée : contenue dans la mémoire.
    expect(unsignaledSequenceGaps([{ from: 4, to: 6 }], known)).toEqual([]);
    expect(unsignaledSequenceGaps([{ from: 5, to: 6 }], known)).toEqual([]);
    expect(unsignaledSequenceGaps([{ from: 5, to: 5 }], known)).toEqual([]);
    expect(
      unsignaledSequenceGaps(
        [
          { from: 4, to: 4 },
          { from: 6, to: 6 },
        ],
        known,
      ),
    ).toEqual([]);
    // Plus large (un bout dépasse), décalée ou nouvelle : à signaler.
    expect(unsignaledSequenceGaps([{ from: 4, to: 7 }], known)).toEqual([{ from: 4, to: 7 }]);
    expect(unsignaledSequenceGaps([{ from: 3, to: 6 }], known)).toEqual([{ from: 3, to: 6 }]);
    expect(unsignaledSequenceGaps([{ from: 7, to: 9 }], known)).toEqual([{ from: 7, to: 9 }]);
    expect(
      unsignaledSequenceGaps(
        [
          { from: 4, to: 6 },
          { from: 9, to: 9 },
        ],
        known,
      ),
    ).toEqual([{ from: 9, to: 9 }]);
    expect(unsignaledSequenceGaps([{ from: 4, to: 6 }], [])).toEqual([{ from: 4, to: 6 }]);
    // Une plage couverte par la seconde plage mémorisée.
    expect(
      unsignaledSequenceGaps(
        [{ from: 10, to: 11 }],
        [
          [4, 6],
          [9, 12],
        ],
      ),
    ).toEqual([]);
  });

  describe('nextKnownGaps — mémoire des plages signalées', () => {
    const present = (...pairs: readonly (readonly [number, number])[]) =>
      pairs.map(([from, to]) => ({ from, to }));

    it('garde une plage signalée tant qu’un de ses numéros manque, même réduite', () => {
      expect(nextKnownGaps({ known: [[4, 6]], present: present([4, 6]), signaled: [] })).toEqual([
        [4, 6],
      ]);
      // Une commande tardive est arrivée : il ne reste que {5, 6}, la plage d'origine reste mémorisée.
      expect(nextKnownGaps({ known: [[4, 6]], present: present([5, 6]), signaled: [] })).toEqual([
        [4, 6],
      ]);
      // Une plage qui touche le trou présent par une seule extrémité reste mémorisée.
      expect(nextKnownGaps({ known: [[4, 6]], present: present([6, 9]), signaled: [] })).toEqual([
        [4, 6],
      ]);
      expect(nextKnownGaps({ known: [[4, 6]], present: present([2, 4]), signaled: [] })).toEqual([
        [4, 6],
      ]);
    });

    it('oublie une plage dont toutes les commandes sont arrivées', () => {
      expect(nextKnownGaps({ known: [[4, 6]], present: [], signaled: [] })).toEqual([]);
      expect(nextKnownGaps({ known: [[4, 6]], present: present([8, 9]), signaled: [] })).toEqual(
        [],
      );
      expect(nextKnownGaps({ known: [[4, 6]], present: present([1, 3]), signaled: [] })).toEqual(
        [],
      );
      expect(
        nextKnownGaps({
          known: [
            [4, 6],
            [10, 12],
          ],
          present: present([10, 12]),
          signaled: [],
        }),
      ).toEqual([[10, 12]]);
    });

    it('ajoute les plages signalées et trie le résultat', () => {
      expect(
        nextKnownGaps({
          known: [[10, 12]],
          present: present([10, 12], [3, 4]),
          signaled: present([3, 4]),
        }),
      ).toEqual([
        [3, 4],
        [10, 12],
      ]);
      expect(
        nextKnownGaps({
          known: [],
          present: present([5, 5], [2, 3]),
          signaled: present([5, 5], [2, 3]),
        }),
      ).toEqual([
        [2, 3],
        [5, 5],
      ]);
    });

    it('ne garde pas deux fois une plage, ni une plage contenue dans une autre', () => {
      // Plage signalée plus large que la mémoire : la plus petite est absorbée.
      expect(
        nextKnownGaps({ known: [[4, 5]], present: present([4, 7]), signaled: present([4, 7]) }),
      ).toEqual([[4, 7]]);
      // Doublon exact entre la mémoire et le signalement.
      expect(
        nextKnownGaps({ known: [[4, 5]], present: present([4, 5]), signaled: present([4, 5]) }),
      ).toEqual([[4, 5]]);
      // Doublon exact dans la mémoire elle-même.
      expect(
        nextKnownGaps({
          known: [
            [4, 5],
            [4, 5],
          ],
          present: present([4, 5]),
          signaled: [],
        }),
      ).toEqual([[4, 5]]);
      // Deux plages qui se chevauchent sans se contenir sont toutes deux gardées.
      expect(
        nextKnownGaps({
          known: [[4, 6]],
          present: present([4, 6], [6, 8]),
          signaled: present([6, 8]),
        }),
      ).toEqual([
        [4, 6],
        [6, 8],
      ]);
    });

    it('deux plages de même début : la plus large seule est gardée', () => {
      expect(
        nextKnownGaps({
          known: [[4, 9]],
          present: present([4, 9], [4, 5]),
          signaled: [],
        }),
      ).toEqual([[4, 9]]);
      // Une plage plus large signalée absorbe la plus étroite de même début.
      expect(
        nextKnownGaps({ known: [[7, 8]], present: present([7, 9]), signaled: present([7, 9]) }),
      ).toEqual([[7, 9]]);
    });
  });

  it('comparaison des listes mémorisées', () => {
    expect(sameSequenceGaps([[1, 2]], [[1, 2]])).toBe(true);
    expect(sameSequenceGaps([[1, 2]], [[1, 3]])).toBe(false);
    expect(
      sameSequenceGaps(
        [[1, 2]],
        [
          [1, 2],
          [4, 4],
        ],
      ),
    ).toBe(false);
    expect(sameSequenceGaps([], [])).toBe(true);
  });
});

describe('clockSkewMinutes', () => {
  it('minutes entières signées', () => {
    expect(clockSkewMinutes(0)).toBe(0);
    expect(clockSkewMinutes(7 * 60_000)).toBe(7);
    expect(clockSkewMinutes(-7 * 60_000 - 29_999)).toBe(-7);
    expect(clockSkewMinutes(-7 * 60_000 - 30_001)).toBe(-8);
    expect(clockSkewMinutes(2_147_483_647)).toBe(35_791);
  });
});
