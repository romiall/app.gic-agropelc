import { describe, expect, it } from 'vitest';
import type { OutboxCommand } from '../../storage/db.js';
import { pendingConsumption, stockKey } from '../sales/stock.js';
import type {
  LocationData,
  LotLossData,
  ProductData,
  ProductionLotData,
  SettingData,
  StockBalanceData,
} from '../sales/types.js';
import {
  eggStorageLocations,
  locationHeadcount,
  rearingHeadcount,
  rearingLocations,
  todayJournal,
} from './daily.js';
import { eggSetup } from './eggs.js';

const NOW = new Date('2026-10-10T09:00:00.000Z');
const TODAY = '2026-10-10';

const lot: ProductionLotData = {
  id: 'lot',
  lot_code: 'PC-1',
  lot_type: 'POULET_CHAIR',
  product_id: 'broiler',
  stock_lot_id: 'stock-lot',
  site_id: 'farm',
  main_location_id: 'b1',
  strain: null,
  status: 'ACTIVE',
  start_date: '2026-09-20',
  planned_end_date: null,
  initial_quantity: 500,
  occurred_at: '2026-09-20T06:00:00.000Z',
};

const location = (
  id: string,
  type: string,
  overrides: Partial<LocationData> = {},
): LocationData => ({
  id,
  site_id: 'farm',
  code: id,
  name: id,
  location_type: type,
  is_virtual: false,
  custody_mode: 'SHARED',
  custodian_user_id: null,
  designated_device_id: null,
  status: 'ACTIVE',
  ...overrides,
});

const balance = (locationId: string, heads: string): StockBalanceData => ({
  location_id: locationId,
  product_id: 'broiler',
  qty_on_hand: heads,
  qty_reserved: '0',
  qty_allocated: '0',
  lots: [
    {
      lot_id: 'stock-lot',
      lot_code: 'PC-1',
      expiry_date: null,
      qty_on_hand: heads,
      qty_reserved: '0',
      qty_allocated: '0',
      last_move_at: null,
    },
  ],
});

function mortality(
  overrides: Partial<OutboxCommand>,
  quantity = 3,
  locationId = 'b1',
): OutboxCommand {
  return {
    command_id: `m-${locationId}-${quantity}`,
    device_seq: 1,
    command_type: 'production.mortality.record',
    command_version: 1,
    author_user_id: 'u',
    aggregate_type: 'STOCK_LOSS',
    aggregate_id: `loss-${locationId}-${quantity}`,
    base_version: null,
    depends_on: [],
    occurred_at: '2026-10-10T07:00:00.000Z',
    client_created_at: '2026-10-10T07:00:00.000Z',
    captured_offline: true,
    backdated_reason: null,
    attachment_ids: [],
    payload: { productionLotId: 'lot', locationId, quantity },
    status: 'LOCAL_ONLY',
    attempts: 0,
    next_attempt_at: null,
    last_error: null,
    server_refs: null,
    ...overrides,
  };
}

const locations = [location('b1', 'BUILDING'), location('b2', 'BUILDING')];
const stock = new Map([
  [stockKey('b1', 'broiler'), balance('b1', '300')],
  [stockKey('b2', 'broiler'), balance('b2', '200')],
]);

describe('Production : effectif, journal, calibres, emplacements', () => {
  it('effectif : une mortalité acceptée n’est retirée qu’avant le tirage du jeu stock qui la porte', () => {
    const accepted = mortality({ status: 'SYNCED', synced_at: '2026-10-10T08:00:00.000Z' });
    const refs = { stock, locations, outbox: [accepted] };
    // Stock tiré après l'acceptation : la mortalité y est déjà, quel que soit le curseur production.
    expect(rearingHeadcount({ ...refs, stockPulledAt: '2026-10-10T08:30:00.000Z' }, lot)).toBe(500);
    // Stock tiré avant : la mortalité est encore à retirer.
    expect(rearingHeadcount({ ...refs, stockPulledAt: '2026-10-10T07:30:00.000Z' }, lot)).toBe(497);
  });

  it('effectif par emplacement : solde du bâtiment moins ses seules mortalités en attente', () => {
    const refs = {
      stock,
      outbox: [mortality({}, 3, 'b1'), mortality({}, 5, 'b2')],
      stockPulledAt: undefined,
    };
    expect(locationHeadcount(refs, lot, 'b1')).toBe(297);
    expect(locationHeadcount(refs, lot, 'b2')).toBe(195);
    expect(locationHeadcount(refs, lot, 'b3')).toBeNull();
  });

  it('effectif borné par le reste physique : une vente depuis le bâtiment le réduit aussi', () => {
    const refs = {
      stock,
      outbox: [],
      stockPulledAt: undefined,
      // Vente hors ligne de 30 têtes depuis b1, sans lot désigné.
      pending: new Map([[stockKey('b1', 'broiler'), 30]]),
    };
    expect(locationHeadcount(refs, lot, 'b1')).toBe(270);
    expect(rearingHeadcount({ ...refs, locations }, lot)).toBe(470);
  });

  it('mortalité de l’appareil retirée du disponible local du bâtiment (produit du lot)', () => {
    const pending = pendingConsumption(
      [mortality({}, 3, 'b1')],
      undefined,
      new Map(),
      new Map([['lot', lot]]),
    );
    expect(pending.get(stockKey('b1', 'broiler'))).toBe(3);
    expect(pendingConsumption([mortality({}, 3, 'b1')], undefined).size).toBe(0);
  });

  it('journal : une mortalité retournée (erreur de déclaration) ou annulée ne compte plus', () => {
    const loss = (id: string, status: string): LotLossData => ({
      id,
      doc_number: id,
      production_lot_id: 'lot',
      location_id: 'b1',
      quantity_base: 2,
      category: 'MORTALITE',
      reason_code_id: null,
      comment: null,
      status,
      occurred_at: '2026-10-10T06:00:00.000Z',
    });
    const refs = {
      lotLosses: [
        loss('ok', 'RECORDED'),
        loss('wait', 'PENDING_APPROVAL'),
        loss('back', 'REJECTED_RETURNED'),
        loss('gone', 'CANCELLED'),
      ],
      lotConsumptions: [],
      lotWeighings: [],
      lotObservations: [],
      eggCollections: [],
      outbox: [],
      productionPulledAt: undefined,
      products: [],
    } as unknown as Parameters<typeof todayJournal>[0];
    expect(todayJournal(refs, 'lot', TODAY).map((entry) => entry.id)).toEqual(['ok', 'wait']);
  });

  it('emplacements : inactifs écartés ; œufs stockés hors incubateur, éclosoir, abattoir, magasin d’abord', () => {
    const farm = [
      location('b1', 'BUILDING'),
      location('old', 'BUILDING', { status: 'INACTIVE' }),
      location('inc', 'INCUBATOR'),
      location('hat', 'HATCHER'),
      location('abat', 'SLAUGHTERHOUSE'),
      location('mag', 'STORE', { name: 'Zz magasin' }),
    ];
    expect(rearingLocations(farm, lot).map((l) => l.id)).toEqual(['b1']);
    expect(eggStorageLocations(farm, lot).map((l) => l.id)).toEqual(['mag', 'b1']);
  });

  it('calibres : actifs, non biologiques, hors produit des œufs à couver ; paramètres globaux', () => {
    const product = (id: string, overrides: Partial<ProductData> = {}): ProductData => ({
      id,
      code: id.toUpperCase(),
      name: id,
      category_id: 'c',
      base_unit_code: 'U',
      lot_tracking: 'NONE',
      stock_family: 'PRODUCTION_COMMERCIALISABLE',
      is_sellable: true,
      pricing_mode: 'PER_UNIT',
      status: 'ACTIVE',
      ...overrides,
    });
    const products = [
      product('gros'),
      product('moyen', { status: 'INACTIVE' }),
      product('couver'),
      product('poule', { stock_family: 'BIOLOGIQUE' }),
    ];
    const setting = (key: string, value: unknown, scope = 'GLOBAL'): SettingData => ({
      id: `${key}-${scope}`,
      key,
      value,
      scope_type: scope,
      scope_id: scope === 'SITE' ? 'farm' : null,
      valid_from: '2026-01-01T00:00:00.000Z',
    });
    const setup = eggSetup(
      products,
      [
        setting('production.egg_grade_product_codes', ['GROS', 'MOYEN', 'COUVER', 'POULE']),
        setting('production.egg_grade_product_codes', ['POULE'], 'SITE'),
        setting('production.hatching_egg_product_code', 'COUVER'),
      ],
      NOW,
    );
    expect(setup.gradesConfigured).toBe(true);
    expect(setup.grades.map((p) => p.id)).toEqual(['gros']);
    expect(setup.hatchingProduct?.id).toBe('couver');
    // Produit des œufs à couver biologique : refusé comme au serveur.
    expect(
      eggSetup(products, [setting('production.hatching_egg_product_code', 'POULE')], NOW)
        .hatchingProduct,
    ).toBeUndefined();
  });
});
