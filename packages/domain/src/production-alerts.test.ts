import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DAILY_ENTRY_WORKING_DAYS,
  DEFAULT_HIGH_MORTALITY_ALERT_HEADS,
  DEFAULT_HIGH_MORTALITY_ALERT_PCT,
  DEFAULT_STANDARD_COST_ALERT_LOOKBACK_DAYS,
  MAX_STANDARD_COST_ALERT_LOOKBACK_DAYS,
  isValidHighMortalityThreshold,
  dailyEntryExpected,
  dailyEntryWorkingDaysOrDefault,
  highMortalityAlertHeadsOrDefault,
  highMortalityAlertPctOrDefault,
  highMortalityCause,
  highMortalityRatePct,
  mortalityReferenceHeadcount,
  standardCostAlertLookbackDaysOrDefault,
} from './production-alerts.js';

describe('seuils de mortalité (AV-121)', () => {
  it('repli sur 0,5 % et 20 têtes quand le réglage manque ou est invalide', () => {
    expect(DEFAULT_HIGH_MORTALITY_ALERT_PCT).toBe(0.5);
    expect(DEFAULT_HIGH_MORTALITY_ALERT_HEADS).toBe(20);
    for (const bad of [undefined, null, '1', -1, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      expect(highMortalityAlertPctOrDefault(bad)).toBe(0.5);
      expect(highMortalityAlertHeadsOrDefault(bad)).toBe(20);
    }
  });

  it('prédicat de validité : un nombre fini positif ou nul', () => {
    for (const ok of [0, 0.5, 20, 1e6]) expect(isValidHighMortalityThreshold(ok)).toBe(true);
    for (const bad of ['30', null, undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      expect(isValidHighMortalityThreshold(bad)).toBe(false);
    }
  });

  it('0 est une valeur valide (toute mortalité alerte) ; les autres nombres sont conservés', () => {
    expect(highMortalityAlertPctOrDefault(0)).toBe(0);
    expect(highMortalityAlertHeadsOrDefault(0)).toBe(0);
    expect(highMortalityAlertPctOrDefault(1.25)).toBe(1.25);
    expect(highMortalityAlertHeadsOrDefault(35)).toBe(35);
  });
});

describe('highMortalityCause : comparaisons strictes (D13 « > 0,5 % de l’effectif ou > 20 têtes »)', () => {
  const base = { pct: 0.5, headsThreshold: 20 };

  it('20 morts n’alertent pas, 21 oui (seuil absolu)', () => {
    expect(highMortalityCause({ ...base, heads: 20, referenceHeadcount: 0 })).toBeNull();
    expect(highMortalityCause({ ...base, heads: 21, referenceHeadcount: 0 })).toBe('ABSOLUTE');
  });

  it('5 sur 1 000 (0,5 %) n’alerte pas, 6 sur 1 000 oui (seuil relatif)', () => {
    expect(highMortalityCause({ ...base, heads: 5, referenceHeadcount: 1000 })).toBeNull();
    expect(highMortalityCause({ ...base, heads: 6, referenceHeadcount: 1000 })).toBe('RELATIVE');
  });

  it('les deux seuils dépassés : BOTH ; un seul : sa cause', () => {
    expect(highMortalityCause({ ...base, heads: 30, referenceHeadcount: 1000 })).toBe('BOTH');
    // 30 morts sur 100 000 : 0,03 % — seul le seuil absolu.
    expect(highMortalityCause({ ...base, heads: 30, referenceHeadcount: 100_000 })).toBe(
      'ABSOLUTE',
    );
    // 10 morts sur 100 : 10 % — seul le seuil relatif.
    expect(highMortalityCause({ ...base, heads: 10, referenceHeadcount: 100 })).toBe('RELATIVE');
  });

  it('sans effectif de référence positif, seul le seuil absolu joue', () => {
    expect(highMortalityCause({ ...base, heads: 3, referenceHeadcount: 0 })).toBeNull();
    expect(highMortalityCause({ ...base, heads: 3, referenceHeadcount: -5 })).toBeNull();
    expect(highMortalityCause({ ...base, heads: 25, referenceHeadcount: -5 })).toBe('ABSOLUTE');
  });

  it('aucune mort : jamais d’alerte, même avec des seuils nuls', () => {
    expect(
      highMortalityCause({ heads: 0, referenceHeadcount: 100, pct: 0, headsThreshold: 0 }),
    ).toBeNull();
  });

  it('égalité stricte avec un pourcentage décimal non représentable en binaire : jamais d’alerte', () => {
    // 5 500 × 1,4 vaut 7 699,999… en flottant : 77 sur 5 500 (1,4 % exactement) ne doit pas alerter.
    const cases: readonly [number, number, number][] = [
      [1.4, 5500, 77],
      [0.7, 11_000, 77],
      [2.8, 2750, 77],
      [1.4, 10_500, 147],
    ];
    for (const [pct, referenceHeadcount, heads] of cases) {
      expect(
        highMortalityCause({ heads, referenceHeadcount, pct, headsThreshold: 10_000 }),
        `${heads}/${referenceHeadcount} à ${pct} %`,
      ).toBeNull();
      expect(
        highMortalityCause({ heads: heads + 1, referenceHeadcount, pct, headsThreshold: 10_000 }),
      ).toBe('RELATIVE');
    }
  });

  it('seuils à 0 : toute mortalité alerte', () => {
    expect(
      highMortalityCause({ heads: 1, referenceHeadcount: 100_000, pct: 0, headsThreshold: 0 }),
    ).toBe('BOTH');
  });

  it('un seuil invalide revient au défaut et ne lève jamais', () => {
    expect(
      highMortalityCause({ heads: 21, referenceHeadcount: 0, pct: -3, headsThreshold: Number.NaN }),
    ).toBe('ABSOLUTE');
    expect(
      highMortalityCause({ heads: 20, referenceHeadcount: 0, pct: -3, headsThreshold: Number.NaN }),
    ).toBeNull();
  });
});

describe('effectif de référence et taux du jour (AV-411)', () => {
  it('l’effectif en début de journée prime ; le repli sert un lot mis en place le jour même', () => {
    expect(mortalityReferenceHeadcount({ startOfDayHeadcount: 800, fallbackHeadcount: 1000 })).toBe(
      800,
    );
    expect(mortalityReferenceHeadcount({ startOfDayHeadcount: 0, fallbackHeadcount: 1000 })).toBe(
      1000,
    );
    expect(mortalityReferenceHeadcount({ startOfDayHeadcount: -2, fallbackHeadcount: 40 })).toBe(
      40,
    );
  });

  it('sans effectif positif, la référence est 0 (jamais négative, jamais NaN)', () => {
    expect(mortalityReferenceHeadcount({ startOfDayHeadcount: 0, fallbackHeadcount: 0 })).toBe(0);
    expect(
      mortalityReferenceHeadcount({ startOfDayHeadcount: Number.NaN, fallbackHeadcount: -4 }),
    ).toBe(0);
  });

  it('taux en % à deux décimales, nul sans référence', () => {
    expect(highMortalityRatePct(6, 1000)).toBe(0.6);
    expect(highMortalityRatePct(1, 3)).toBe(33.33);
    expect(highMortalityRatePct(21, 0)).toBeNull();
    expect(highMortalityRatePct(21, -1)).toBeNull();
  });
});

describe('saisie du jour attendue (AV-412)', () => {
  it('sept jours par défaut ; une liste valide est triée et dédoublonnée', () => {
    expect(DEFAULT_DAILY_ENTRY_WORKING_DAYS).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(dailyEntryWorkingDaysOrDefault(undefined)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(dailyEntryWorkingDaysOrDefault([])).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(dailyEntryWorkingDaysOrDefault(['x', 0, 8, 2.5])).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(dailyEntryWorkingDaysOrDefault([6, 1, '3', 1])).toEqual([1, 3, 6]);
    expect(dailyEntryWorkingDaysOrDefault('1,2')).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  const lot = {
    status: 'ACTIVE',
    startDay: '2026-10-01',
    examinedDay: '2026-10-14',
    endOfDayHeadcount: 120,
  } as const;

  it('lot actif ou en vente, mis en place avant le jour, avec des animaux : saisie attendue', () => {
    expect(dailyEntryExpected(lot)).toBe(true);
    expect(dailyEntryExpected({ ...lot, status: 'SELLING' })).toBe(true);
  });

  it('lot planifié, clos ou annulé : aucune saisie attendue', () => {
    for (const status of ['PLANNED', 'CLOSED', 'CANCELLED'] as const) {
      expect(dailyEntryExpected({ ...lot, status })).toBe(false);
    }
  });

  it('mis en place le jour examiné ou après, ou sans date de mise en place : aucune saisie attendue', () => {
    expect(dailyEntryExpected({ ...lot, startDay: '2026-10-14' })).toBe(false);
    expect(dailyEntryExpected({ ...lot, startDay: '2026-10-15' })).toBe(false);
    expect(dailyEntryExpected({ ...lot, startDay: '2026-10-13' })).toBe(true);
    expect(dailyEntryExpected({ ...lot, startDay: null })).toBe(false);
  });

  it('sans animal en élevage à la fin du jour : aucune saisie attendue', () => {
    expect(dailyEntryExpected({ ...lot, endOfDayHeadcount: 0 })).toBe(false);
    expect(dailyEntryExpected({ ...lot, endOfDayHeadcount: -3 })).toBe(false);
    expect(dailyEntryExpected({ ...lot, endOfDayHeadcount: 0.5 })).toBe(true);
  });
});

describe('fenêtre de revue du coût standard (AV-413)', () => {
  it('30 jours par défaut ; un entier strictement positif est conservé', () => {
    expect(DEFAULT_STANDARD_COST_ALERT_LOOKBACK_DAYS).toBe(30);
    for (const bad of [undefined, null, 0, -7, 1.5, '30', Number.NaN]) {
      expect(standardCostAlertLookbackDaysOrDefault(bad)).toBe(30);
    }
    expect(standardCostAlertLookbackDaysOrDefault(7)).toBe(7);
    expect(standardCostAlertLookbackDaysOrDefault(1)).toBe(1);
  });

  it('plafond de dix ans : une grande valeur (« illimité ») est ramenée au plafond', () => {
    expect(MAX_STANDARD_COST_ALERT_LOOKBACK_DAYS).toBe(3650);
    expect(standardCostAlertLookbackDaysOrDefault(3650)).toBe(3650);
    expect(standardCostAlertLookbackDaysOrDefault(3651)).toBe(3650);
    expect(standardCostAlertLookbackDaysOrDefault(999_999)).toBe(3650);
    expect(standardCostAlertLookbackDaysOrDefault(Number.MAX_SAFE_INTEGER)).toBe(3650);
  });
});
