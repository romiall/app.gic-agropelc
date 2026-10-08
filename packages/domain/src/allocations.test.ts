import { describe, expect, it } from 'vitest';
import {
  allocationEntrySign,
  allocationRemaining,
  allocationValidUntil,
  availableForConsumer,
  checkGrantCapacity,
  decideLocalConsumption,
  isAllocationExpired,
  isConsumedAfterRevocation,
  planQuotaConsumption,
  restorableQuantity,
  signedAllocationEntry,
} from './allocations.js';

describe('availableForConsumer (ADR-033 §4)', () => {
  it('garde exclusive : tout le solde, aucun quota', () => {
    expect(
      availableForConsumer({
        custodyMode: 'EXCLUSIVE_DEVICE',
        stockOnHand: 12,
        othersAllocatedRemaining: 99,
      }),
    ).toBe(12);
    expect(
      availableForConsumer({
        custodyMode: 'EXCLUSIVE_USER',
        stockOnHand: 3.5,
        othersAllocatedRemaining: 0,
      }),
    ).toBe(3.5);
  });

  it('emplacement partagé : le solde moins les restes des autres détenteurs', () => {
    expect(
      availableForConsumer({
        custodyMode: 'SHARED',
        stockOnHand: 100,
        othersAllocatedRemaining: 50,
      }),
    ).toBe(50);
  });

  it('jamais négatif : un solde négatif ou des quotas supérieurs au solde ne donnent rien', () => {
    expect(
      availableForConsumer({
        custodyMode: 'SHARED',
        stockOnHand: 10,
        othersAllocatedRemaining: 25,
      }),
    ).toBe(0);
    expect(
      availableForConsumer({
        custodyMode: 'EXCLUSIVE_DEVICE',
        stockOnHand: -4,
        othersAllocatedRemaining: 0,
      }),
    ).toBe(0);
  });

  it('calcule en millièmes exacts (0,3 − 0,1 ne laisse pas de reliquat flottant)', () => {
    expect(
      availableForConsumer({
        custodyMode: 'SHARED',
        stockOnHand: 0.3,
        othersAllocatedRemaining: 0.1,
      }),
    ).toBe(0.2);
  });
});

describe('planQuotaConsumption (ADR-033 §5)', () => {
  it('consomme d’abord le quota, puis le stock libre', () => {
    const plan = planQuotaConsumption({
      requested: 15,
      holdsQuota: true,
      quotaRemaining: 10,
      freeStock: 20,
    });
    expect(plan).toEqual({
      fromQuota: 10,
      fromFreeStock: 5,
      shortfall: 0,
      quotaExceeded: true,
      excessOverQuota: 5,
    });
  });

  it('dans le quota : aucun dépassement', () => {
    const plan = planQuotaConsumption({
      requested: 4,
      holdsQuota: true,
      quotaRemaining: 10,
      freeStock: 0,
    });
    expect(plan).toMatchObject({
      fromQuota: 4,
      fromFreeStock: 0,
      shortfall: 0,
      quotaExceeded: false,
    });
  });

  it('un détenteur qui dépasse le quota ET le stock libre : le manque est un solde négatif à signaler', () => {
    const plan = planQuotaConsumption({
      requested: 12,
      holdsQuota: true,
      quotaRemaining: 5,
      freeStock: 3,
    });
    expect(plan).toMatchObject({
      fromQuota: 5,
      fromFreeStock: 3,
      shortfall: 4,
      quotaExceeded: true,
    });
  });

  it('sans quota (garde exclusive ou utilisateur sans allocation) : tout vient du stock libre, jamais de dépassement de quota', () => {
    const plan = planQuotaConsumption({
      requested: 6,
      holdsQuota: false,
      quotaRemaining: 40,
      freeStock: 10,
    });
    expect(plan).toEqual({
      fromQuota: 0,
      fromFreeStock: 6,
      shortfall: 0,
      quotaExceeded: false,
      excessOverQuota: 0,
    });
  });

  it('refuse une quantité nulle ou négative', () => {
    expect(() =>
      planQuotaConsumption({ requested: 0, holdsQuota: false, quotaRemaining: 0, freeStock: 1 }),
    ).toThrow(/positive/);
  });

  it('AT-004 : PDV partagé de 100, quotas 40 / 30 / 20 (10 libres) — les trois tablettes ne rendent jamais le stock négatif', () => {
    // A vend 38 de son quota de 40 ; B vend 30 de 30 ; C vend 12 de 20.
    const free = 100 - (40 + 30 + 20);
    const a = planQuotaConsumption({
      requested: 38,
      holdsQuota: true,
      quotaRemaining: 40,
      freeStock: free,
    });
    const b = planQuotaConsumption({
      requested: 30,
      holdsQuota: true,
      quotaRemaining: 30,
      freeStock: free,
    });
    const c = planQuotaConsumption({
      requested: 12,
      holdsQuota: true,
      quotaRemaining: 20,
      freeStock: free,
    });
    for (const plan of [a, b, c]) {
      expect(plan.quotaExceeded).toBe(false);
      expect(plan.shortfall).toBe(0);
    }
    expect(100 - (a.fromQuota + b.fromQuota + c.fromQuota)).toBe(20);
    // Restes : 2, 0 et 8 ; B qui demanderait une 31e unité dépasse son quota.
    expect(40 - a.fromQuota).toBe(2);
    expect(30 - b.fromQuota).toBe(0);
    expect(20 - c.fromQuota).toBe(8);
  });
});

describe('decideLocalConsumption (AV-025, AT-003)', () => {
  const now = new Date('2026-10-08T10:00:00.000Z');
  const base = {
    custodyMode: 'SHARED' as const,
    requested: 1,
    localBalance: 0,
    holdsQuota: true,
    quotaRemaining: 30,
    quotaValidUntil: new Date('2026-10-08T23:00:00.000Z'),
    now,
    overAllocationAllowed: false,
  };

  it('dans le quota : autorisé, rien à signaler', () => {
    expect(decideLocalConsumption({ ...base, requested: 30 })).toEqual({
      allowed: true,
      signalled: null,
    });
  });

  it('au-delà du quota : bloqué avec un message clair en français (AT-003)', () => {
    const decision = decideLocalConsumption({ ...base, requested: 31 });
    expect(decision).toEqual({
      allowed: false,
      code: 'ALLOCATION_EXCEEDED',
      messageFr: 'Allocation dépassée : il vous reste 30, 31 demandé(s).',
      available: 30,
    });
  });

  it('sans allocation sur un emplacement partagé : bloqué', () => {
    const decision = decideLocalConsumption({ ...base, holdsQuota: false, quotaRemaining: 0 });
    expect(decision).toMatchObject({ allowed: false, code: 'ALLOCATION_MISSING', available: 0 });
  });

  it('quota échu : bloqué, même s’il reste des unités', () => {
    const decision = decideLocalConsumption({
      ...base,
      quotaValidUntil: new Date('2026-10-08T09:59:59.000Z'),
    });
    expect(decision).toMatchObject({ allowed: false, code: 'ALLOCATION_EXPIRED' });
  });

  it('garde exclusive : bloqué au-delà du solde local, autorisé jusqu’au solde', () => {
    const exclusive = {
      ...base,
      custodyMode: 'EXCLUSIVE_DEVICE' as const,
      holdsQuota: false,
      quotaRemaining: 0,
    };
    expect(decideLocalConsumption({ ...exclusive, localBalance: 5, requested: 5 })).toEqual({
      allowed: true,
      signalled: null,
    });
    expect(decideLocalConsumption({ ...exclusive, localBalance: 5, requested: 5.5 })).toEqual({
      allowed: false,
      code: 'INSUFFICIENT_STOCK',
      messageFr: 'Stock insuffisant sur cet appareil : 5 disponible(s), 5,5 demandé(s).',
      available: 5,
    });
  });

  it('option « autorisée et signalée » du site : le dépassement passe et est signalé au serveur', () => {
    expect(decideLocalConsumption({ ...base, requested: 31, overAllocationAllowed: true })).toEqual(
      {
        allowed: true,
        signalled: 'ALLOCATION_EXCEEDED',
      },
    );
    expect(
      decideLocalConsumption({ ...base, holdsQuota: false, overAllocationAllowed: true }),
    ).toEqual({ allowed: true, signalled: 'ALLOCATION_MISSING' });
  });

  it('un solde local négatif ne donne aucune disponibilité', () => {
    const decision = decideLocalConsumption({
      ...base,
      custodyMode: 'EXCLUSIVE_USER',
      holdsQuota: false,
      localBalance: -2,
    });
    expect(decision).toMatchObject({ allowed: false, available: 0 });
  });
});

describe('registre d’entrées d’un quota (INV-STK-20)', () => {
  it('le sens de chaque type', () => {
    expect(allocationEntrySign('GRANT')).toBe(1);
    expect(allocationEntrySign('INCREASE')).toBe(1);
    expect(allocationEntrySign('RESTORE')).toBe(1);
    expect(allocationEntrySign('CONSUME')).toBe(-1);
    expect(allocationEntrySign('RELEASE')).toBe(-1);
    expect(allocationEntrySign('REVOKE')).toBe(-1);
    expect(allocationEntrySign('ADJUST')).toBe(0);
  });

  it('quantité signée à écrire : positive ou négative selon le type ; ADJUST garde son signe', () => {
    expect(signedAllocationEntry('GRANT', 40)).toBe(40);
    expect(signedAllocationEntry('CONSUME', 12.5)).toBe(-12.5);
    expect(signedAllocationEntry('ADJUST', -3)).toBe(-3);
    expect(signedAllocationEntry('ADJUST', 3)).toBe(3);
    expect(() => signedAllocationEntry('CONSUME', 0)).toThrow(/strictement positive/);
  });

  it('reste = Σ des entrées signées', () => {
    expect(
      allocationRemaining([
        { entryType: 'GRANT', quantity: 40 },
        { entryType: 'CONSUME', quantity: -38 },
        { entryType: 'RESTORE', quantity: 3 },
        { entryType: 'INCREASE', quantity: 5 },
        { entryType: 'RELEASE', quantity: -10 },
      ]),
    ).toBe(0);
  });

  it('refuse une entrée de signe incohérent avec son type', () => {
    expect(() => allocationRemaining([{ entryType: 'CONSUME', quantity: 4 }])).toThrow(/signe/);
    expect(() => allocationRemaining([{ entryType: 'GRANT', quantity: -4 }])).toThrow(/signe/);
  });

  it('un registre vide a un reste nul', () => {
    expect(allocationRemaining([])).toBe(0);
  });
});

describe('restitution et capacité', () => {
  it('restorableQuantity : plafonnée à la consommation d’origine, déduction faite des restitutions', () => {
    expect(restorableQuantity({ consumed: 10, alreadyRestored: 0, requested: 4 })).toBe(4);
    expect(restorableQuantity({ consumed: 10, alreadyRestored: 8, requested: 4 })).toBe(2);
    expect(restorableQuantity({ consumed: 10, alreadyRestored: 10, requested: 4 })).toBe(0);
    expect(restorableQuantity({ consumed: 0, alreadyRestored: 0, requested: 4 })).toBe(0);
  });

  it('checkGrantCapacity (INV-STK-19) : Σ restes ≤ Σ soldes', () => {
    expect(
      checkGrantCapacity({ stockOnHand: 100, activeRemainingTotal: 90, requested: 10 }),
    ).toEqual({
      ok: true,
      capacity: 10,
    });
    expect(
      checkGrantCapacity({ stockOnHand: 100, activeRemainingTotal: 90, requested: 10.001 }),
    ).toEqual({
      ok: false,
      capacity: 10,
    });
    expect(
      checkGrantCapacity({ stockOnHand: 5, activeRemainingTotal: 9, requested: 1 }).capacity,
    ).toBe(0);
  });
});

describe('validité et révocation (AV-160, AV-161)', () => {
  it('par défaut : fin du jour métier de l’octroi (Africa/Douala = UTC+1)', () => {
    // 8 octobre 2026 10 h 00 UTC = 11 h 00 à Douala : fin du jour = 9 octobre 00 h 00 Douala = 8 octobre 23 h 00 UTC.
    expect(allocationValidUntil(new Date('2026-10-08T10:00:00.000Z')).toISOString()).toBe(
      '2026-10-08T23:00:00.000Z',
    );
    // 23 h 30 UTC = 00 h 30 le 9 à Douala : fin du jour = 10 octobre 00 h 00 Douala = 9 octobre 23 h 00 UTC.
    expect(allocationValidUntil(new Date('2026-10-08T23:30:00.000Z')).toISOString()).toBe(
      '2026-10-09T23:00:00.000Z',
    );
  });

  it('avec une durée : octroi + durée', () => {
    expect(allocationValidUntil(new Date('2026-10-08T10:00:00.000Z'), 2.5).toISOString()).toBe(
      '2026-10-08T12:30:00.000Z',
    );
    expect(() => allocationValidUntil(new Date(), 0)).toThrow(/strictement positive/);
    expect(() => allocationValidUntil(new Date(), Number.NaN)).toThrow();
  });

  it('isAllocationExpired : sans échéance jamais ; échu à l’instant exact', () => {
    const until = new Date('2026-10-08T23:00:00.000Z');
    expect(isAllocationExpired(null, new Date('2030-01-01'))).toBe(false);
    expect(isAllocationExpired(until, new Date('2026-10-08T22:59:59.999Z'))).toBe(false);
    expect(isAllocationExpired(until, until)).toBe(true);
  });

  it('ALLOCATION_REVOKED_CONSUMED seulement si le fait suit la révocation', () => {
    const revokedAt = new Date('2026-10-08T12:00:00.000Z');
    expect(isConsumedAfterRevocation(new Date('2026-10-08T11:59:00.000Z'), revokedAt)).toBe(false);
    expect(isConsumedAfterRevocation(revokedAt, revokedAt)).toBe(false);
    expect(isConsumedAfterRevocation(new Date('2026-10-08T12:00:01.000Z'), revokedAt)).toBe(true);
  });
});
