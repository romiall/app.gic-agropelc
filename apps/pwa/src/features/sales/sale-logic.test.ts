import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type GicDatabase, type OutboxCommand } from '../../storage/db.js';
import { IDS, seedSalesFixtures } from './fixtures.js';
import { activeCampaignIds, deduceChannel, saleZoneId, zonePathOf } from './pricing.js';
import { loadSalesReferences, type SalesReferences } from './references.js';
import {
  computeLine,
  linePayload,
  parseQuantity,
  parseXaf,
  requestedByProduct,
  sellingLocations,
  totalOf,
  type DraftLine,
  type PricingContext,
} from './sale-form.js';
import { localAvailable, offlineSaleDecision, pendingConsumption, settingValue } from './stock.js';
import type { SettingData, ZoneData } from './types.js';

const NOW = new Date('2026-10-10T09:00:00.000Z');

function draft(overrides: Partial<DraftLine> = {}): DraftLine {
  return {
    key: 'l1',
    productId: IDS.eggs,
    unitCode: 'U',
    quantityText: '1',
    weightText: '',
    priceText: null,
    overrideReasonId: null,
    ...overrides,
  };
}

function outbox(type: string, payload: unknown, status = 'PENDING_SYNC'): OutboxCommand {
  return { command_type: type, payload, status } as OutboxCommand;
}

describe('ventes — prix sur l’appareil', () => {
  it('chemin de zone : la zone et ses ancêtres, sans boucle', () => {
    const zones = new Map<string, ZoneData>([
      ['a', { id: 'a', parent_id: null, name: 'A', depth: 1 }],
      ['b', { id: 'b', parent_id: 'a', name: 'B', depth: 2 }],
      ['c', { id: 'c', parent_id: 'b', name: 'C', depth: 3 }],
    ]);
    expect(zonePathOf('c', zones)).toEqual(['c', 'b', 'a']);
    expect(zonePathOf(undefined, zones)).toEqual([]);
  });

  it('campagnes actives à l’instant seulement', () => {
    expect(
      activeCampaignIds(
        [
          { id: 'x', status: 'ACTIVE', valid_from: '2026-10-01', valid_to: '2026-10-31' },
          { id: 'y', status: 'ACTIVE', valid_from: '2026-11-01', valid_to: '2026-11-30' },
          { id: 'z', status: 'DRAFT', valid_from: '2026-10-01', valid_to: '2026-10-31' },
        ],
        NOW,
      ),
    ).toEqual(['x']);
  });

  it('zone de la vente (BR-VEN-022) : site au PDV, sinon client, session, site', () => {
    const base = { siteZoneId: 'zs', customerZoneId: 'zc', sessionZoneId: 'zw' };
    expect(saleZoneId({ ...base, locationType: 'POS' })).toBe('zs');
    expect(saleZoneId({ ...base, locationType: 'MOBILE' })).toBe('zc');
    expect(saleZoneId({ ...base, locationType: 'MOBILE', customerZoneId: undefined })).toBe('zw');
    expect(
      saleZoneId({
        locationType: 'PEN',
        siteZoneId: 'zs',
        customerZoneId: undefined,
        sessionZoneId: undefined,
      }),
    ).toBe('zs');
  });

  it('rôles inconnus de l’appareil : canal laissé au serveur hors PDV, stock mobile et session', () => {
    expect(
      deduceChannel({ locationType: 'STORE', roles: null, hasOpenSession: false }),
    ).toBeUndefined();
    expect(deduceChannel({ locationType: 'POS', roles: null, hasOpenSession: false })).toBe(
      'POINT_DE_VENTE',
    );
    expect(deduceChannel({ locationType: 'STORE', roles: null, hasOpenSession: true })).toBe(
      'TERRAIN',
    );
  });

  it('canal déduit comme le serveur (BR-VEN-021)', () => {
    expect(deduceChannel({ locationType: 'POS', roles: [], hasOpenSession: false })).toBe(
      'POINT_DE_VENTE',
    );
    expect(deduceChannel({ locationType: 'MOBILE', roles: [], hasOpenSession: false })).toBe(
      'TERRAIN',
    );
    expect(
      deduceChannel({
        locationType: 'STORE',
        roles: ['COMMERCIAL_SEDENTAIRE'],
        hasOpenSession: false,
      }),
    ).toBe('SEDENTAIRE');
    expect(deduceChannel({ locationType: 'PEN', roles: [], hasOpenSession: false })).toBe('DIRECT');
  });
});

describe('ventes — saisie et montants', () => {
  let db: GicDatabase;
  let refs: SalesReferences;
  let context: PricingContext;

  beforeEach(async () => {
    db = createTestDb(`test-sale-logic-${Math.random()}`);
    await seedSalesFixtures(db);
    refs = await loadSalesReferences(db);
    context = {
      at: NOW,
      siteId: IDS.site,
      zoneId: IDS.zone,
      customerCategoryId: null,
      channelCode: 'POINT_DE_VENTE',
    };
  });

  afterEach(async () => {
    await db.delete();
  });

  const product = (id: string) => refs.products.find((candidate) => candidate.id === id)!;

  it('lit les quantités et montants saisis', () => {
    expect(parseQuantity('2,5')).toBe(2.5);
    expect(parseQuantity('0')).toBeNull();
    expect(parseQuantity('1.2345')).toBeNull();
    expect(parseQuantity('abc')).toBeNull();
    expect(parseXaf('12 500')).toBe(12500);
    expect(parseXaf('12,5')).toBeNull();
  });

  it('conditionnement converti en unité de base, prix catalogue appliqué', () => {
    const line = computeLine(
      draft({ unitCode: 'PLATEAU', quantityText: '2' }),
      product(IDS.eggs),
      refs,
      context,
    );
    expect(line.issue).toBeNull();
    expect(line.quantityBase).toBe(60);
    expect(line.unitPriceXaf).toBe(100);
    expect(line.lineTotalXaf).toBe(6000);
    expect(linePayload(line)).toEqual({
      productId: IDS.eggs,
      quantity: 2,
      unitCode: 'PLATEAU',
      quantityBase: 60,
      listUnitPriceXaf: 100,
      priceRuleId: IDS.ruleEggs,
      unitPriceXaf: 100,
    });
  });

  it('règle du site retenue ; hors du site, aucun prix catalogue', () => {
    const atSite = computeLine(
      draft({ productId: IDS.chicken }),
      product(IDS.chicken),
      refs,
      context,
    );
    expect(atSite.unitPriceXaf).toBe(3500);
    const elsewhere = computeLine(draft({ productId: IDS.chicken }), product(IDS.chicken), refs, {
      ...context,
      siteId: 'autre-site',
    });
    expect(elsewhere.issue).toBe('PRICE_REQUIRED');
  });

  it('prix modifié : motif exigé, puis ligne dérogatoire avec son motif', () => {
    const missing = computeLine(draft({ priceText: '90' }), product(IDS.eggs), refs, context);
    expect(missing.issue).toBe('REASON_REQUIRED');
    const withReason = computeLine(
      draft({ priceText: '90', overrideReasonId: IDS.reason, quantityText: '10' }),
      product(IDS.eggs),
      refs,
      context,
    );
    expect(withReason.issue).toBeNull();
    expect(withReason.lineTotalXaf).toBe(900);
    expect(linePayload(withReason)).toMatchObject({
      listUnitPriceXaf: 100,
      unitPriceXaf: 90,
      overrideReasonCodeId: IDS.reason,
    });
    expect(totalOf([withReason])).toBe(900);
  });

  it('saisie démesurée : défaut de ligne, jamais d’exception ; total hors limites signalé', () => {
    expect(parseQuantity('100000000000')).toBeNull();
    const huge = computeLine(
      draft({ quantityText: '99999999999', priceText: '999999999', overrideReasonId: IDS.reason }),
      product(IDS.eggs),
      refs,
      context,
    );
    expect(huge.issue).toBe('PRICE_INVALID');
    expect(totalOf([huge])).toBe(0);
  });

  it('service (BR-VEN-031) : aucune quantité demandée au stock', () => {
    const service = { ...product(IDS.eggs), stock_family: 'SERVICE' };
    const line = computeLine(draft(), service, refs, context);
    expect(requestedByProduct([line]).size).toBe(0);
  });

  it('produit au poids : le poids est exigé', () => {
    const byWeight = { ...product(IDS.chicken), pricing_mode: 'PER_WEIGHT' as const };
    expect(computeLine(draft({ productId: IDS.chicken }), byWeight, refs, context).issue).toBe(
      'WEIGHT_REQUIRED',
    );
  });

  it('emplacements de vente : ceux dont l’appareil détient le stock', () => {
    expect(sellingLocations(refs, IDS.user).map((location) => location.id)).toEqual([IDS.pos]);
  });
});

describe('ventes — stock local et blocage hors ligne (AV-025)', () => {
  it('une vente acceptée reste décomptée jusqu’au tirage du stock qui l’inclut (ADR-051)', () => {
    const accepted = {
      ...outbox(
        'sales.sale.record',
        { fromLocationId: 'loc', lines: [{ productId: 'p', quantityBase: 4 }] },
        'SYNCED',
      ),
      synced_at: '2026-10-10T09:00:00.000Z',
    };
    // Jamais tiré, ou tiré avant l'acceptation : la quantité vendue reste retirée.
    expect(pendingConsumption([accepted], undefined).get('loc:p')).toBe(4);
    expect(pendingConsumption([accepted], '2026-10-10T08:59:59.000Z').get('loc:p')).toBe(4);
    // Tiré après l'acceptation : le solde téléchargé l'inclut, plus de décompte.
    expect(pendingConsumption([accepted], '2026-10-10T09:00:01.000Z').get('loc:p')).toBeUndefined();
  });

  it('aucun solde ni opération en attente : disponible 0, jamais « -0 »', () => {
    expect(Object.is(localAvailable(undefined, 'EXCLUSIVE_USER', 0), 0)).toBe(true);
  });

  it('ventes et commandes en attente réduisent le disponible ; livraisons et opérations confirmées non', () => {
    const pending = pendingConsumption(
      [
        outbox('sales.sale.record', {
          fromLocationId: 'loc',
          lines: [
            { productId: 'p', quantityBase: 1.5 },
            { productId: 'p', quantityBase: 0.25 },
          ],
        }),
        outbox('sales.order.place', {
          fulfilmentLocationId: 'loc',
          lines: [{ productId: 'p', quantityBase: 2 }],
        }),
        // La marchandise livrée a quitté l'emplacement à la confirmation (ADR-028) : pas de décompte.
        outbox('sales.order.fulfil', {
          orderId: 'o1',
          lines: [{ orderLineId: 'ol1', quantityBase: 5 }],
        }),
        // Acceptée sans heure d'acceptation (ligne ancienne) : plus décomptée.
        outbox(
          'sales.sale.record',
          { fromLocationId: 'loc', lines: [{ productId: 'p', quantityBase: 9 }] },
          'SYNCED',
        ),
      ],
      undefined,
    );
    expect(pending.get('loc:p')).toBe(3.75);
    const balance = {
      location_id: 'loc',
      product_id: 'p',
      qty_on_hand: '10',
      qty_reserved: '1',
      qty_allocated: '2',
    };
    expect(localAvailable(balance, 'EXCLUSIVE_USER', 3.75)).toBe(5.25);
    expect(localAvailable(balance, 'SHARED', 0)).toBe(7);
  });

  it('garde exclusive : stock local ; emplacement partagé : quota exigé, sauf dépassement autorisé', () => {
    const exclusive = { custody_mode: 'EXCLUSIVE_USER' as const };
    const shared = { custody_mode: 'SHARED' as const };
    expect(
      offlineSaleDecision({
        location: exclusive,
        requested: 2,
        available: 5,
        now: NOW,
        overAllocationAllowed: false,
      }),
    ).toEqual({ allowed: true, signalled: null });
    expect(
      offlineSaleDecision({
        location: exclusive,
        requested: 6,
        available: 5,
        now: NOW,
        overAllocationAllowed: false,
      }),
    ).toMatchObject({ allowed: false, code: 'INSUFFICIENT_STOCK' });
    expect(
      offlineSaleDecision({
        location: shared,
        requested: 1,
        available: 5,
        now: NOW,
        overAllocationAllowed: false,
      }),
    ).toMatchObject({ allowed: false, code: 'ALLOCATION_MISSING' });
    expect(
      offlineSaleDecision({
        location: shared,
        requested: 1,
        available: 5,
        now: NOW,
        overAllocationAllowed: true,
      }),
    ).toEqual({ allowed: true, signalled: 'ALLOCATION_MISSING' });
  });

  it('paramètre : réglage du site, à défaut global, le plus récent en vigueur', () => {
    const settings: SettingData[] = [
      {
        id: '1',
        key: 'k',
        value: false,
        scope_type: 'GLOBAL',
        scope_id: null,
        valid_from: '2026-01-01T00:00:00Z',
      },
      {
        id: '2',
        key: 'k',
        value: true,
        scope_type: 'SITE',
        scope_id: 's1',
        valid_from: '2026-02-01T00:00:00Z',
      },
      {
        id: '3',
        key: 'k',
        value: 'futur',
        scope_type: 'GLOBAL',
        scope_id: null,
        valid_from: '2027-01-01T00:00:00Z',
      },
    ];
    expect(settingValue(settings, 'k', 's1', NOW)).toBe(true);
    expect(settingValue(settings, 'k', 's2', NOW)).toBe(false);
    expect(settingValue(settings, 'absent', 's1', NOW)).toBeUndefined();
  });
});
