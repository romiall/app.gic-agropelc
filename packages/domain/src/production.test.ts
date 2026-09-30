import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  PRODUCTION_LOT_TYPES,
  acceptsDailyEntries,
  acceptsLotEntries,
  allocateByWeight,
  allocateProRata,
  averageDailyGainG,
  checkCandling,
  checkHatch,
  checkLotEntry,
  checkSlaughter,
  checkWeighing,
  costPerHeadXaf,
  eggCollectionBalance,
  eggsRemaining,
  feedConversionRatio,
  hatchRates,
  headDaysInPeriod,
  incubationBalanced,
  layingRate,
  lotAcceptsProductSpecies,
  lotTypeProfile,
  mortalityRate,
  mortalityRequiresApproval,
  rate4,
  slaughterYield,
  speciesGroupOfProduct,
  unitCostXaf,
  type IncubationCounters,
} from './production.js';
import { quantityFromDecimal } from './quantity.js';

describe('lots de production', () => {
  it('AV-044 : cinq types actifs ; reproducteur suivi comme une pondeuse ; naissage et abattage', () => {
    expect(PRODUCTION_LOT_TYPES).toHaveLength(5);
    expect(lotTypeProfile('REPRODUCTEUR_VOLAILLE')).toMatchObject({ laysEggs: true });
    expect(lotTypeProfile('PONDEUSE')).toMatchObject({ laysEggs: true, farrows: false });
    expect(lotTypeProfile('PORC_NAISSAGE')).toMatchObject({ farrows: true, species: 'PORC' });
    expect(lotTypeProfile('POULET_CHAIR')).toMatchObject({ laysEggs: false, species: 'VOLAILLE' });
    expect(() => lotTypeProfile('AUTRE' as never)).toThrow(/Type de lot inconnu/);
  });

  it('D07 §8 : saisies quotidiennes seulement sur un lot ACTIVE ou SELLING', () => {
    expect(acceptsDailyEntries('ACTIVE')).toBe(true);
    expect(acceptsDailyEntries('SELLING')).toBe(true);
    for (const status of ['PLANNED', 'CLOSED', 'CANCELLED'] as const) {
      expect(acceptsDailyEntries(status)).toBe(false);
    }
  });
});

describe('collecte d’œufs (INV-OEU-01, calibres AV-046)', () => {
  it('bilan juste : total commercialisable = Σ calibres', () => {
    expect(
      eggCollectionBalance({
        collected: 300,
        broken: 6,
        nonconforming: 4,
        hatching: 50,
        marketableByGrade: [
          { grade: 'GROS', quantity: 100 },
          { grade: 'MOYEN', quantity: 120 },
          { grade: 'PETIT', quantity: 20 },
        ],
      }),
    ).toEqual({ marketable: 240 });
  });

  it('bilan faux, quantité négative ou fractionnaire, calibre en double → EGG_BALANCE_INVALID', () => {
    const base = { collected: 10, broken: 0, nonconforming: 0, hatching: 0 };
    expect(() =>
      eggCollectionBalance({ ...base, marketableByGrade: [{ grade: 'GROS', quantity: 9 }] }),
    ).toThrow(expect.objectContaining({ code: 'EGG_BALANCE_INVALID' }));
    expect(() =>
      eggCollectionBalance({
        ...base,
        broken: -1,
        marketableByGrade: [{ grade: 'GROS', quantity: 11 }],
      }),
    ).toThrow(expect.objectContaining({ code: 'EGG_BALANCE_INVALID' }));
    expect(() =>
      eggCollectionBalance({ ...base, marketableByGrade: [{ grade: 'GROS', quantity: 9.5 }] }),
    ).toThrow(expect.objectContaining({ code: 'EGG_BALANCE_INVALID' }));
    expect(() =>
      eggCollectionBalance({
        ...base,
        marketableByGrade: [
          { grade: 'GROS', quantity: 5 },
          { grade: 'GROS', quantity: 5 },
        ],
      }),
    ).toThrow(/Calibre en double/);
  });

  it('AT-028 (part domaine) : 1 850 = 25 + 15 + 1 690 + 120 ; déséquilibre refusé', () => {
    const collection = {
      collected: 1850,
      broken: 25,
      nonconforming: 15,
      hatching: 120,
      marketableByGrade: [{ grade: 'STANDARD', quantity: 1690 }],
    };
    expect(eggCollectionBalance(collection)).toEqual({ marketable: 1690 });
    expect(() => eggCollectionBalance({ ...collection, collected: 1851 })).toThrow(
      expect.objectContaining({ code: 'EGG_BALANCE_INVALID' }),
    );
  });

  it('collecte sans œuf commercialisable (tout à couver, reproducteurs)', () => {
    expect(
      eggCollectionBalance({
        collected: 80,
        broken: 2,
        nonconforming: 3,
        hatching: 75,
        marketableByGrade: [],
      }),
    ).toEqual({ marketable: 0 });
  });
});

describe('incubation (BR-INC-003 à 007, INV-INC-01)', () => {
  const set: IncubationCounters = {
    eggsSet: 1000,
    infertile: 0,
    earlyDead: 0,
    accidentalLoss: 0,
    unhatched: 0,
    hatchedViable: 0,
    hatchedNonviable: 0,
  };

  it('mirage borné par les œufs en incubateur ; éclosion = œufs restants ; bilan et taux', () => {
    checkCandling(set, { infertile: 80, earlyDead: 20 });
    expect(() => checkCandling(set, { infertile: 900, earlyDead: 101 })).toThrow(
      expect.objectContaining({ code: 'INCUBATION_BALANCE_INVALID' }),
    );
    const afterCandling = { ...set, infertile: 80, earlyDead: 20, accidentalLoss: 10 };
    expect(eggsRemaining(afterCandling)).toBe(890);
    expect(() =>
      checkHatch(afterCandling, { unhatched: 40, hatchedViable: 830, hatchedNonviable: 10 }),
    ).toThrow(expect.objectContaining({ code: 'INCUBATION_BALANCE_INVALID' }));
    checkHatch(afterCandling, { unhatched: 40, hatchedViable: 840, hatchedNonviable: 10 });
    const closed = { ...afterCandling, unhatched: 40, hatchedViable: 840, hatchedNonviable: 10 };
    expect(incubationBalanced(closed)).toBe(true);
    expect(hatchRates(closed)).toEqual({ hatchRate: 0.84, fertileHatchRate: 0.913 });
  });

  it('AT-029 (part domaine) : incubation de 600 œufs, bilan juste, taux d’éclosion 83 %', () => {
    const counters = {
      ...set,
      eggsSet: 600,
      infertile: 48,
      earlyDead: 18,
      accidentalLoss: 6,
      unhatched: 24,
      hatchedViable: 498,
      hatchedNonviable: 6,
    };
    expect(incubationBalanced(counters)).toBe(true);
    expect(hatchRates(counters).hatchRate).toBe(0.83);
  });
});

describe('mortalité (BR-PRD-006, AV-048)', () => {
  it('seuils à 0 (décision du 27/09/2026) : toute mortalité est validée', () => {
    const thresholds = { relativePct: 0, absoluteHeads: 0 };
    expect(mortalityRequiresApproval({ deaths: 1, headcountInRearing: 5000, thresholds })).toBe(
      true,
    );
    expect(mortalityRequiresApproval({ deaths: 0, headcountInRearing: 5000, thresholds })).toBe(
      false,
    );
  });

  it('seuils relatif OU absolu (paramètres) ; effectif nul', () => {
    const thresholds = { relativePct: 0.5, absoluteHeads: 20 };
    expect(mortalityRequiresApproval({ deaths: 20, headcountInRearing: 5000, thresholds })).toBe(
      false,
    );
    expect(mortalityRequiresApproval({ deaths: 21, headcountInRearing: 5000, thresholds })).toBe(
      true,
    );
    expect(mortalityRequiresApproval({ deaths: 6, headcountInRearing: 1000, thresholds })).toBe(
      true,
    );
    expect(mortalityRequiresApproval({ deaths: 5, headcountInRearing: 1000, thresholds })).toBe(
      false,
    );
    expect(mortalityRequiresApproval({ deaths: 1, headcountInRearing: 0, thresholds })).toBe(true);
    expect(() =>
      mortalityRequiresApproval({
        deaths: 1,
        headcountInRearing: 10,
        thresholds: { relativePct: -1, absoluteHeads: 0 },
      }),
    ).toThrow(expect.objectContaining({ code: 'THRESHOLD_INVALID' }));
  });

  it('taux de mortalité cumulée', () => {
    expect(mortalityRate(150, 5000)).toBe(0.03);
    expect(mortalityRate(1, 0)).toBeNull();
  });
});

describe('coûts (BR-PRD-012, ADR-026)', () => {
  it('coût par tête arrondi au franc ; effectif nul → null', () => {
    expect(costPerHeadXaf(1_000_000, quantityFromDecimal(4850))).toBe(206);
    expect(costPerHeadXaf(1_000, quantityFromDecimal(3))).toBe(333);
    expect(costPerHeadXaf(1_000, quantityFromDecimal(0))).toBeNull();
    expect(unitCostXaf(1_001, quantityFromDecimal(2))).toBe(501);
    expect(() => unitCostXaf(10, quantityFromDecimal(0))).toThrow();
  });

  it('répartition au prorata : exacte au franc, plus fort reste, poids nuls', () => {
    expect(
      allocateProRata(100, [
        { key: 'A', weight: 1 },
        { key: 'B', weight: 1 },
        { key: 'C', weight: 1 },
      ]).map((s) => s.amountXaf),
    ).toEqual([34, 33, 33]);
    expect(
      allocateProRata(1000, [
        { key: 'A', weight: 0 },
        { key: 'B', weight: 0 },
      ]).map((s) => s.amountXaf),
    ).toEqual([0, 0]);
    expect(() => allocateProRata(10, [{ key: 'A', weight: -1 }])).toThrow();
    expect(() =>
      allocateProRata(10, [
        { key: 'A', weight: 1 },
        { key: 'A', weight: 2 },
      ]),
    ).toThrow(/Clé en double/);
  });

  it('propriété : la somme des parts égale toujours le montant réparti', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000_000_000 }),
        fc.array(fc.integer({ min: 0, max: 10_000_000 }), { minLength: 1, maxLength: 12 }),
        (total, weights) => {
          const shares = allocateProRata(
            total,
            weights.map((weight, i) => ({ key: `k${i}`, weight })),
          );
          const sum = shares.reduce((acc, s) => acc + s.amountXaf, 0);
          const allZero = weights.every((w) => w === 0);
          return allZero ? sum === 0 : sum === total;
        },
      ),
    );
  });

  it('AV-043 : têtes × jours ; frais généraux d’un mois répartis entre deux lots', () => {
    const days = ['2026-09-01', '2026-09-02', '2026-09-03'];
    const lotA = headDaysInPeriod({
      openingHeadcount: 1000,
      movements: [{ day: '2026-09-02', delta: -10 }],
      days,
    });
    const lotB = headDaysInPeriod({
      openingHeadcount: 0,
      movements: [{ day: '2026-09-03', delta: 500 }],
      days,
    });
    expect(lotA).toBe(1000 + 990 + 990);
    expect(lotB).toBe(500);
    const shares = allocateProRata(348_000, [
      { key: 'A', weight: lotA },
      { key: 'B', weight: lotB },
    ]);
    expect(shares.map((s) => s.amountXaf)).toEqual([298_000, 50_000]);
  });

  it('AV-032 : coproduits d’abattage au prorata du poids', () => {
    const shares = allocateByWeight(210_000, [
      { key: 'ENTIER', weightG: 120_000 },
      { key: 'CUISSES', weightG: 60_000 },
      { key: 'ABATS', weightG: 30_000 },
    ]);
    expect(shares.map((s) => s.amountXaf)).toEqual([120_000, 60_000, 30_000]);
    expect(slaughterYield(210_000, 300_000)).toBe(0.7);
  });
});

describe('pesées et indicateurs (BR-PRD-015, AV-049)', () => {
  it('pesée valide ou WEIGHING_INVALID', () => {
    checkWeighing({ sampleSize: 50, avgWeightG: 1850.5, totalWeightKg: 92.5 });
    for (const bad of [
      { sampleSize: 0, avgWeightG: 100 },
      { sampleSize: 2.5, avgWeightG: 100 },
      { sampleSize: 10, avgWeightG: 0 },
      { sampleSize: 10, avgWeightG: 100, totalWeightKg: -1 },
    ]) {
      expect(() => checkWeighing(bad)).toThrow(
        expect.objectContaining({ code: 'WEIGHING_INVALID' }),
      );
    }
  });

  it('GMQ, indice de consommation, taux de ponte ; valeurs non significatives → null', () => {
    expect(averageDailyGainG({ fromAvgWeightG: 800, toAvgWeightG: 1500, days: 14 })).toBe(50);
    expect(averageDailyGainG({ fromAvgWeightG: 800, toAvgWeightG: 1500, days: 0 })).toBeNull();
    expect(feedConversionRatio(3_400, 2_000)).toBe(1.7);
    expect(feedConversionRatio(3_400, 0)).toBeNull();
    expect(layingRate(4_250, 5_000)).toBe(0.85);
    expect(rate4(1, 3)).toBe(0.3333);
    expect(rate4(2, 3)).toBe(0.6667);
  });
});

describe('entrées de lot (P7-05)', () => {
  it('BR-PRD-001 : produit biologique de l’espèce du type de lot', () => {
    expect(lotAcceptsProductSpecies('POULET_CHAIR', 'POULET_CHAIR')).toBe(true);
    expect(lotAcceptsProductSpecies('POULET_CHAIR', 'PONDEUSE')).toBe(false);
    expect(lotAcceptsProductSpecies('REPRODUCTEUR_VOLAILLE', 'PONDEUSE')).toBe(true);
    expect(lotAcceptsProductSpecies('REPRODUCTEUR_VOLAILLE', 'POULET_CHAIR')).toBe(true);
    expect(lotAcceptsProductSpecies('PORC_NAISSAGE', 'PORC')).toBe(true);
    expect(lotAcceptsProductSpecies('PORC_ENGRAISSEMENT', null)).toBe(false);
    expect(speciesGroupOfProduct('PONDEUSE')).toBe('VOLAILLE');
    expect(speciesGroupOfProduct('PORC')).toBe('PORC');
    expect(speciesGroupOfProduct(null)).toBeNull();
  });

  it('première entrée sur un lot planifié ; plus aucune sur un lot clos ou annulé', () => {
    expect(acceptsLotEntries('PLANNED')).toBe(true);
    expect(acceptsLotEntries('SELLING')).toBe(true);
    expect(acceptsLotEntries('CLOSED')).toBe(false);
    expect(acceptsLotEntries('CANCELLED')).toBe(false);
  });

  it('AV-111 : naissance dans un lot de porcelets lié au lot de truies ; sevrage vers l’engraissement', () => {
    expect(() =>
      checkLotEntry({
        lotType: 'PORC_NAISSAGE',
        sourceKind: 'BIRTH',
        parentLotType: 'PORC_NAISSAGE',
      }),
    ).not.toThrow();
    expect(() => checkLotEntry({ lotType: 'PORC_NAISSAGE', sourceKind: 'BIRTH' })).toThrow(
      /lot de truies/,
    );
    expect(() =>
      checkLotEntry({
        lotType: 'PORC_ENGRAISSEMENT',
        sourceKind: 'BIRTH',
        parentLotType: 'PORC_NAISSAGE',
      }),
    ).toThrow(/LOT_ENTRY_INVALID|lot de naissage/);
    expect(() =>
      checkLotEntry({
        lotType: 'PORC_ENGRAISSEMENT',
        sourceKind: 'WEANING',
        sourceLotType: 'PORC_NAISSAGE',
      }),
    ).not.toThrow();
    expect(() =>
      checkLotEntry({
        lotType: 'PORC_NAISSAGE',
        sourceKind: 'WEANING',
        sourceLotType: 'PORC_NAISSAGE',
      }),
    ).toThrow(/sevrage/);
  });

  it('transfert entre lots distincts de la même espèce ; mise en place toujours admise', () => {
    expect(() =>
      checkLotEntry({
        lotType: 'PONDEUSE',
        sourceKind: 'TRANSFER',
        sourceLotType: 'REPRODUCTEUR_VOLAILLE',
      }),
    ).not.toThrow();
    expect(() =>
      checkLotEntry({
        lotType: 'PONDEUSE',
        sourceKind: 'TRANSFER',
        sourceLotType: 'PORC_NAISSAGE',
      }),
    ).toThrow(/même espèce/);
    expect(() =>
      checkLotEntry({
        lotType: 'PONDEUSE',
        sourceKind: 'TRANSFER',
        sourceLotType: 'PONDEUSE',
        sameLot: true,
      }),
    ).toThrow(/distincts/);
    for (const lotType of PRODUCTION_LOT_TYPES) {
      expect(() => checkLotEntry({ lotType, sourceKind: 'PURCHASE' })).not.toThrow();
    }
  });
});

describe('abattage (P7-09)', () => {
  it('poids des produits, rendement, et refus des saisies incohérentes', () => {
    expect(
      checkSlaughter({
        heads: 100,
        condemnedHeads: 2,
        liveWeightG: 250_000,
        outputs: [
          { key: 'entier', weightG: 120_000 },
          { key: 'cuisses', weightG: 40_000 },
          { key: 'abats', weightG: 15_000 },
        ],
      }),
    ).toEqual({ outputWeightG: 175_000, yieldRate: 0.7 });
    const base = { heads: 10, condemnedHeads: 0, liveWeightG: 20_000 };
    expect(() => checkSlaughter({ ...base, outputs: [] })).toThrow(/au moins un produit/);
    expect(() =>
      checkSlaughter({ ...base, condemnedHeads: 11, outputs: [{ key: 'a', weightG: 1 }] }),
    ).toThrow(/saisies/);
    expect(() =>
      checkSlaughter({ ...base, condemnedHeads: 10, outputs: [{ key: 'a', weightG: 1 }] }),
    ).toThrow(/déclarer une perte/);
    expect(() => checkSlaughter({ ...base, outputs: [{ key: 'a', weightG: 20_001 }] })).toThrow(
      /poids vif/,
    );
    expect(() =>
      checkSlaughter({
        ...base,
        outputs: [
          { key: 'a', weightG: 1 },
          { key: 'a', weightG: 2 },
        ],
      }),
    ).toThrow(/double/);
  });
});
