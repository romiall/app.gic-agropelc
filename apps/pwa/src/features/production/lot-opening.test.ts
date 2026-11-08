import { describe, expect, it } from 'vitest';
import {
  checkLotOpeningDraft,
  EMPTY_LOT_OPENING,
  knownOpening,
  lotOpeningPayload,
  parseAmountXaf,
  parseHeadcount,
  parseWeightG,
  type LotOpeningDraft,
} from './lot-opening.js';

/** Le 9 novembre 2026 à 10 h, heure de Douala. */
const NOW = new Date('2026-11-09T09:00:00.000Z');
const UUID_A = '01900000-0000-7000-8000-0000000000a1';
const UUID_B = '01900000-0000-7000-8000-0000000000a2';
const UUID_C = '01900000-0000-7000-8000-0000000000a3';
const BROILER = { species: 'POULET_CHAIR' };

const draft = (overrides: Partial<LotOpeningDraft> = {}): LotOpeningDraft => ({
  ...EMPTY_LOT_OPENING,
  siteId: UUID_A,
  productId: UUID_B,
  mainLocationId: UUID_C,
  placedOn: '2026-10-05',
  quantityText: '4 800',
  valueText: '5 760 000',
  ...overrides,
});

describe('lecture des saisies', () => {
  it('effectif : entier, espaces tolérés', () => {
    expect(parseHeadcount('4800')).toBe(4800);
    expect(parseHeadcount('4 800')).toBe(4800);
    expect(parseHeadcount('4\u00a0800')).toBe(4800);
    for (const text of ['', '12,5', '-3', 'abc', '123456789']) {
      expect(parseHeadcount(text), text).toBeNull();
    }
  });

  it('valeur : francs entiers, espaces tolérés', () => {
    expect(parseAmountXaf('5 760 000')).toBe(5_760_000);
    expect(parseAmountXaf('0')).toBe(0);
    for (const text of ['', '1,5', '-1', 'cinq', '1234567890123456']) {
      expect(parseAmountXaf(text), text).toBeNull();
    }
  });

  it('poids moyen : positif, une décimale au plus, virgule ou point', () => {
    expect(parseWeightG('1250')).toBe(1250);
    expect(parseWeightG('42,5')).toBe(42.5);
    expect(parseWeightG('42.5')).toBe(42.5);
    for (const text of ['', '0', '42,55', '-3', 'lourd']) {
      expect(parseWeightG(text), text).toBeNull();
    }
  });
});

describe('contrôle du brouillon (mêmes règles que le serveur)', () => {
  it('un brouillon complet et cohérent n’a aucun défaut', () => {
    expect(checkLotOpeningDraft(draft(), BROILER, NOW)).toEqual([]);
  });

  it('un brouillon vide réclame les champs sans les reprocher', () => {
    const issues = checkLotOpeningDraft(EMPTY_LOT_OPENING, undefined, NOW);
    expect(issues.map((issue) => issue.field).sort()).toEqual([
      'farm',
      'location',
      'placedOn',
      'product',
      'quantity',
      'value',
    ]);
    expect(issues.every((issue) => issue.kind === 'REQUIRED')).toBe(true);
  });

  it('rend les défauts du domaine : date future, valeur par tête démesurée, espèce', () => {
    const invalid = (overrides: Partial<LotOpeningDraft>, product = BROILER) =>
      checkLotOpeningDraft(draft(overrides), product, NOW)
        .filter((issue) => issue.kind === 'INVALID')
        .map((issue) => issue.field);
    expect(invalid({ placedOn: '2026-11-10' })).toEqual(['placedOn']);
    expect(invalid({ quantityText: '10', valueText: '2000000000' })).toEqual(['value']);
    expect(invalid({}, { species: 'PONDEUSE' })).toEqual(['product']);
    expect(invalid({ quantityText: '12,5' })).toEqual(['quantity']);
    expect(invalid({ valueText: '1,5' })).toEqual(['value']);
    expect(invalid({ avgWeightText: '0' })).toEqual(['weight']);
  });
});

describe('charge utile de production.lot_opening.post', () => {
  it('lit les saisies et ne garde que ce qui est renseigné', () => {
    expect(lotOpeningPayload(draft())).toEqual({
      lotType: 'POULET_CHAIR',
      productId: UUID_B,
      mainLocationId: UUID_C,
      placedOn: '2026-10-05',
      quantity: 4800,
      valueXaf: 5_760_000,
    });
    expect(
      lotOpeningPayload(
        draft({
          supplierId: UUID_A,
          strain: '  Cobb 500  ',
          avgWeightText: '1250,5',
          notes: ' reprise ',
        }),
      ),
    ).toMatchObject({
      supplierId: UUID_A,
      strain: 'Cobb 500',
      avgWeightG: 1250.5,
      notes: 'reprise',
    });
  });

  it('null tant que la déclaration est incomplète ou illisible', () => {
    expect(lotOpeningPayload(EMPTY_LOT_OPENING)).toBeNull();
    expect(lotOpeningPayload(draft({ quantityText: '12,5' }))).toBeNull();
    expect(lotOpeningPayload(draft({ valueText: '' }))).toBeNull();
    expect(lotOpeningPayload(draft({ avgWeightText: 'lourd' }))).toBeNull();
    expect(lotOpeningPayload(draft({ productId: 'pas-un-uuid' }))).toBeNull();
  });
});

describe('lot réel déjà connu de l’appareil', () => {
  const lot = (overrides: Record<string, unknown> = {}) => ({
    id: UUID_A,
    lot_code: 'LOT-MFO-2026-001',
    lot_type: 'POULET_CHAIR',
    product_id: UUID_B,
    stock_lot_id: UUID_A,
    site_id: UUID_A,
    main_location_id: UUID_C,
    strain: null,
    status: 'ACTIVE',
    start_date: '2026-10-05',
    planned_end_date: null,
    initial_quantity: 4800,
    occurred_at: '2026-10-05T08:00:00.000Z',
    ...overrides,
  });
  const command = (status: string, overrides: Record<string, unknown> = {}) => ({
    command_id: 'cmd-1',
    command_type: 'production.lot_opening.post',
    aggregate_id: 'opening-1',
    status,
    payload: { mainLocationId: UUID_C, productId: UUID_B, placedOn: '2026-10-05' },
    ...overrides,
  });
  const group = { locationId: UUID_C, productId: UUID_B, placedOn: '2026-10-05' };
  const refs = (lots: readonly unknown[], outbox: readonly unknown[]) =>
    ({ productionLots: lots, outbox }) as never;

  it('un lot du même emplacement, produit et jour de mise en place', () => {
    expect(knownOpening(refs([lot()], []), group)).toEqual({
      kind: 'LOT',
      lotCode: 'LOT-MFO-2026-001',
    });
    // Un autre jour, un autre produit, un lot annulé : pas le même lot.
    expect(knownOpening(refs([lot({ start_date: '2026-10-06' })], []), group)).toBeNull();
    expect(knownOpening(refs([lot({ product_id: UUID_A })], []), group)).toBeNull();
    expect(knownOpening(refs([lot({ status: 'CANCELLED' })], []), group)).toBeNull();
  });

  it('une reprise identique encore dans l’outbox, sans réponse du serveur', () => {
    expect(knownOpening(refs([], [command('PENDING_SYNC')]), group)).toEqual({ kind: 'UNSENT' });
    expect(knownOpening(refs([], [command('SYNCING')]), group)).toEqual({ kind: 'UNSENT' });
    // Déjà envoyée (acceptée ou refusée) : le serveur juge, l’appareil ne bloque pas.
    for (const status of ['SYNCED', 'REJECTED', 'CONFLICT']) {
      expect(knownOpening(refs([], [command(status)]), group), status).toBeNull();
    }
    // Elle-même ne se reconnaît pas.
    expect(
      knownOpening(refs([], [command('PENDING_SYNC')]), { ...group, selfId: 'opening-1' }),
    ).toBeNull();
  });
});
