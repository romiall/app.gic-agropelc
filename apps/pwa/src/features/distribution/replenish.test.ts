import { describe, expect, it } from 'vitest';
import type { OutboxCommand } from '../../storage/db.js';
import type {
  LocationData,
  PointOfSaleData,
  ProductData,
  StockBalanceData,
  StockThresholdData,
  StockTransferData,
} from '../sales/types.js';
import {
  cancellable,
  candidateSources,
  pendingRequests,
  pointsOfSaleOf,
  replenishPayload,
  replenishSuggestions,
  requestedByProduct,
} from './replenish.js';

const POS = 'pdv';
const STORE = 'magasin';

function location(id: string, overrides: Partial<LocationData> = {}): LocationData {
  return {
    id,
    site_id: 'site',
    code: id,
    name: id,
    location_type: 'STORE',
    is_virtual: false,
    custody_mode: 'SHARED',
    custodian_user_id: null,
    designated_device_id: null,
    status: 'ACTIVE',
    ...overrides,
  } as LocationData;
}

function product(id: string, name: string): ProductData {
  return { id, name, base_unit_code: 'U', status: 'ACTIVE' } as ProductData;
}

function threshold(
  productId: string,
  min: string,
  target: string,
  active = true,
): StockThresholdData {
  return {
    id: `th-${productId}`,
    location_id: POS,
    product_id: productId,
    min_qty_base: min,
    target_qty_base: target,
    is_active: active,
  };
}

function balance(productId: string, onHand: string): StockBalanceData {
  return {
    location_id: POS,
    product_id: productId,
    qty_on_hand: onHand,
    qty_reserved: '0',
    qty_allocated: '0',
    lots: [],
  } as unknown as StockBalanceData;
}

function transfer(id: string, overrides: Partial<StockTransferData> = {}): StockTransferData {
  return {
    id,
    doc_number: `TRF-${id}`,
    transfer_kind: 'STANDARD',
    from_location_id: STORE,
    to_location_id: POS,
    status: 'REQUESTED',
    requested_by: 'moi',
    dispatched_at: null,
    carrier_name: null,
    notes: null,
    occurred_at: '2026-10-10T07:00:00.000Z',
    version: 1,
    lines: [
      {
        id: `${id}-l`,
        product_id: 'oeuf',
        lot_id: null,
        unit_code: 'U',
        requested_qty_base: '20.000',
        dispatched_qty_base: null,
        received_qty_base: null,
      },
    ],
    ...overrides,
  };
}

let seq = 0;
function command(
  type: string,
  payload: object,
  overrides: Partial<OutboxCommand> = {},
): OutboxCommand {
  seq += 1;
  return {
    command_id: `cmd-${seq}`,
    device_seq: seq,
    command_type: type,
    command_version: 1,
    author_user_id: 'moi',
    aggregate_type: 'STOCK_TRANSFER',
    aggregate_id: `trf-${seq}`,
    base_version: null,
    depends_on: [],
    occurred_at: '2026-10-10T09:00:00.000Z',
    client_created_at: '2026-10-10T09:00:00.000Z',
    captured_offline: true,
    backdated_reason: null,
    attachment_ids: [],
    payload,
    status: 'LOCAL_ONLY',
    attempts: 0,
    next_attempt_at: null,
    last_error: null,
    server_refs: null,
    ...overrides,
  };
}

describe('Réapprovisionnement d’un PDV (ECR-DIS-03)', () => {
  it('PDV vus par l’appareil, source configurée ou magasins proposés', () => {
    const pos: PointOfSaleData = {
      site_id: 'site',
      sales_location_id: POS,
      replenishment_source_location_id: STORE,
      custody_mode: 'SHARED',
      designated_device_id: null,
      opening_hours: null,
      version: 1,
    };
    const locations = [
      location(POS, { location_type: 'POS', name: 'Comptoir' }),
      location(STORE, { name: 'Magasin' }),
      location('virtuel', { is_virtual: true }),
      location('ferme', { status: 'INACTIVE' }),
      location('chambre', { location_type: 'COLD_ROOM' }),
    ];
    expect(pointsOfSaleOf({ pointsOfSale: new Map([['site', pos]]), locations })).toEqual([
      { siteId: 'site', salesLocation: locations[0], source: locations[1] },
    ]);
    // Source non configurée, ou emplacement de vente inconnu de l'appareil.
    expect(
      pointsOfSaleOf({
        pointsOfSale: new Map([['site', { ...pos, replenishment_source_location_id: null }]]),
        locations,
      })[0]?.source,
    ).toBeNull();
    expect(
      pointsOfSaleOf({
        pointsOfSale: new Map([['site', { ...pos, sales_location_id: 'inconnu' }]]),
        locations,
      }),
    ).toEqual([]);
    expect(candidateSources(locations, POS).map((candidate) => candidate.id)).toEqual([STORE]);
  });

  it('suggestion : cible − disponible − transit − déjà demandé, ruptures d’abord (BR-STK-051)', () => {
    const products = [
      product('oeuf', 'Œufs'),
      product('poulet', 'Poulet'),
      product('sel', 'Sel'),
      product('riz', 'Riz'),
    ];
    const refs = {
      products,
      thresholds: [
        threshold('oeuf', '20', '50'),
        threshold('poulet', '5', '10'),
        threshold('sel', '1', '5'),
        // Seuil désactivé : sans effet, même en rupture.
        threshold('riz', '1', '9', false),
        { ...threshold('oeuf', '1', '999'), location_id: 'ailleurs' },
      ],
      stock: new Map([
        [`${POS}:oeuf`, balance('oeuf', '10')],
        [`${POS}:poulet`, balance('poulet', '12')],
      ]),
      pending: new Map([[`${POS}:oeuf`, 2]]),
      transfers: new Map([
        [
          'route',
          transfer('route', {
            status: 'DISPATCHED',
            lines: [
              {
                id: 'r-l',
                product_id: 'oeuf',
                lot_id: null,
                unit_code: 'U',
                requested_qty_base: '5',
                dispatched_qty_base: '5',
                received_qty_base: null,
              },
            ],
          }),
        ],
      ]),
      outbox: [],
    };
    const suggestions = replenishSuggestions(refs, POS, new Map([['oeuf', 10]]));
    // Sel sans solde : rupture, suggéré à la cible ; œufs : 50 − 8 − 5 − 10 = 27 ; poulet au-delà.
    expect(
      suggestions.map((s) => [s.product.id, s.state, s.available, s.inTransit, s.suggestedQty]),
    ).toEqual([
      ['sel', 'STOCK_OUT', 0, 0, 5],
      ['oeuf', 'STOCK_LOW', 8, 5, 27],
    ]);
    // Tout déjà demandé : plus de suggestion.
    expect(
      replenishSuggestions(
        refs,
        POS,
        new Map([
          ['oeuf', 37],
          ['sel', 5],
        ]),
      ).map((s) => s.product.id),
    ).toEqual([]);
  });

  it('demandes en attente : jeu `transfers` et appareil, annulations, quantités déjà demandées', () => {
    const own = command('inventory.transfer.request', {
      fromLocationId: STORE,
      toLocationId: POS,
      lines: [{ productId: 'oeuf', unitCode: 'U', quantityBase: 7 }],
    });
    const known = command(
      'inventory.transfer.request',
      { fromLocationId: STORE, toLocationId: POS, lines: [] },
      { aggregate_id: 'serveur', status: 'SYNCED', synced_at: '2026-10-10T09:30:00.000Z' },
    );
    const outbox = [
      own,
      known,
      // Refusée, ou vers un autre emplacement : pas en attente ici.
      command(
        'inventory.transfer.request',
        { fromLocationId: STORE, toLocationId: POS, lines: [] },
        { status: 'REJECTED' },
      ),
      command('inventory.transfer.request', {
        fromLocationId: STORE,
        toLocationId: 'autre',
        lines: [],
      }),
      // Annulation en attente de la demande du serveur.
      command('inventory.transfer.cancel', { transferId: 'serveur' }, { aggregate_id: 'serveur' }),
    ];
    const transfers = new Map([
      ['serveur', transfer('serveur')],
      ['expediee', transfer('expediee', { status: 'DISPATCHED' })],
      ['autre-pdv', transfer('autre-pdv', { to_location_id: 'autre' })],
    ]);
    const requests = pendingRequests(
      { transfers, outbox, transfersPulledAt: '2026-10-10T08:00:00.000Z' },
      POS,
    );
    expect(requests.map((r) => [r.id, r.docNumber, r.onDevice, r.commandId, r.cancelling])).toEqual(
      [
        ['serveur', 'TRF-serveur', false, null, true],
        [own.aggregate_id, null, true, own.command_id, false],
      ],
    );
    // La demande annulée ne compte plus dans le déjà demandé.
    expect(requestedByProduct(requests)).toEqual(new Map([['oeuf', 7]]));
    // Seul le demandeur annule une demande connue du serveur, sans annulation en cours.
    const server = { ...requests[0]!, cancelling: false };
    expect(cancellable(server, 'moi')).toBe(true);
    expect(cancellable(server, 'autre')).toBe(false);
    expect(cancellable(requests[0]!, 'moi')).toBe(false);
    expect(cancellable(requests[1]!, 'moi')).toBe(false);
  });

  it('charge utile : lignes sans lot, note rognée ou absente', () => {
    const line = {
      draft: { key: 'k', productId: 'oeuf', unitCode: 'PLATEAU', quantityText: '2' },
      quantity: 2,
      quantityBase: 60,
      issue: null,
    };
    expect(
      replenishPayload({
        fromLocationId: STORE,
        toLocationId: POS,
        lines: [line],
        notes: '  Urgent  ',
      }),
    ).toEqual({
      fromLocationId: STORE,
      toLocationId: POS,
      lines: [{ productId: 'oeuf', unitCode: 'PLATEAU', quantityBase: 60 }],
      notes: 'Urgent',
    });
    expect(
      replenishPayload({ fromLocationId: STORE, toLocationId: POS, lines: [line], notes: '   ' }),
    ).not.toHaveProperty('notes');
  });
});
