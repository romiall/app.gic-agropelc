import { describe, expect, it } from 'vitest';
import type { OutboxCommand } from '../../storage/db.js';
import { pendingConsumption } from '../sales/stock.js';
import type { LocationData, PurchaseOrderData, SettingData } from '../sales/types.js';
import {
  duplicateDeliveryNote,
  inFlightAccepted,
  receiptLocations,
  receiptSettings,
  receivableOrders,
} from './receipt.js';

const NOW = new Date('2026-10-10T09:00:00.000Z');

const location = (overrides: Partial<LocationData>): LocationData => ({
  id: 'loc',
  site_id: 'site-a',
  code: 'L',
  name: 'Emplacement',
  location_type: 'STORE',
  is_virtual: false,
  custody_mode: 'SHARED',
  custodian_user_id: null,
  designated_device_id: null,
  status: 'ACTIVE',
  ...overrides,
});

const order = (overrides: Partial<PurchaseOrderData>): PurchaseOrderData =>
  ({
    id: 'po',
    doc_number: 'BC-1',
    site_id: 'site-a',
    supplier_id: 'sup',
    delivery_location_id: 'store-b',
    expected_delivery_date: null,
    status: 'SENT',
    lines: [],
    ...overrides,
  }) as PurchaseOrderData;

const setting = (key: string, value: unknown, scope: 'GLOBAL' | 'SITE' = 'GLOBAL'): SettingData =>
  ({
    key,
    value,
    scope_type: scope,
    scope_id: scope === 'SITE' ? 'site-a' : null,
    valid_from: '2026-01-01T00:00:00.000Z',
  }) as SettingData;

function receipt(overrides: Partial<OutboxCommand>): OutboxCommand {
  return {
    command_id: 'c1',
    device_seq: 1,
    command_type: 'procurement.receipt.record',
    command_version: 1,
    author_user_id: 'u',
    aggregate_type: 'GOODS_RECEIPT',
    aggregate_id: 'r1',
    base_version: null,
    depends_on: [],
    occurred_at: '2026-10-10T08:00:00.000Z',
    client_created_at: '2026-10-10T08:00:00.000Z',
    captured_offline: true,
    backdated_reason: null,
    attachment_ids: [],
    payload: {
      purchaseOrderId: 'po',
      locationId: 'store-b',
      lines: [{ poLineId: 'l1', productId: 'p', qtyDeliveredBase: 10, qtyRejectedBase: 2 }],
    },
    status: 'LOCAL_ONLY',
    attempts: 0,
    next_attempt_at: null,
    last_error: null,
    server_refs: null,
    ...overrides,
  };
}

describe('Réception d’achat : emplacements, paramètres, quarantaine', () => {
  it('emplacements du site du bon, actifs et physiques, celui de livraison en tête, sans solde exigé', () => {
    const locations = [
      location({ id: 'store-a', name: 'Annexe' }),
      location({ id: 'store-b', name: 'Magasin' }),
      location({ id: 'closed', name: 'Ancien', status: 'INACTIVE' }),
      location({ id: 'virtual', name: 'Fournisseur', is_virtual: true }),
      location({ id: 'other', name: 'Autre site', site_id: 'site-b' }),
    ];
    expect(receiptLocations(locations, order({})).map((l) => l.id)).toEqual(['store-b', 'store-a']);
    expect(
      receiptLocations(locations, order({ delivery_location_id: null })).map((l) => l.id),
    ).toEqual(['store-a', 'store-b']);
  });

  it('bons recevables : envoyés ou reçus en partie, sans dépendre des soldes de l’appareil', () => {
    const orders = [
      order({ id: 'a', status: 'SENT', doc_number: 'BC-2' }),
      order({ id: 'b', status: 'PARTIALLY_RECEIVED', doc_number: 'BC-1' }),
      order({ id: 'c', status: 'RECEIVED', doc_number: 'BC-3' }),
    ];
    expect(receivableOrders(orders).map((o) => o.id)).toEqual(['b', 'a']);
  });

  it('paramètres lus en portée globale seulement, défauts du serveur', () => {
    expect(receiptSettings([], NOW)).toEqual({
      tolerancePct: 0,
      offlineOverMode: 'QUARANTINE',
      photoThresholdXaf: 100_000,
    });
    const settings = [
      setting('procurement.receipt_over_tolerance_pct', 5),
      setting('procurement.receipt_over_tolerance_pct', 50, 'SITE'),
      setting('procurement.offline_over_receipt_mode', 'APPLY_WITH_REVIEW'),
      setting('procurement.receipt_photo_threshold_xaf', 250_000),
    ];
    expect(receiptSettings(settings, NOW)).toEqual({
      tolerancePct: 5,
      offlineOverMode: 'APPLY_WITH_REVIEW',
      photoThresholdXaf: 250_000,
    });
  });

  it('réception en quarantaine (annoncée ou renvoyée par le serveur) : rien au disponible local', () => {
    expect(pendingConsumption([receipt({})], undefined).get('store-b:p')).toBe(-8);
    expect(
      pendingConsumption([receipt({ local_flags: ['EXPECTED_QUARANTINE'] })], undefined).get(
        'store-b:p',
      ),
    ).toBeUndefined();
    expect(
      pendingConsumption(
        [
          receipt({
            status: 'SYNCED_WITH_WARNING',
            synced_at: '2026-10-10T08:30:00.000Z',
            warnings: ['RECEIPT_QUARANTINED'],
          }),
        ],
        undefined,
      ).get('store-b:p'),
    ).toBeUndefined();
  });
  it('bon de livraison déjà reçu : quarantaine prévue ; indice local sans effet après la réponse', () => {
    const posted = {
      id: 'r0',
      supplier_id: 'sup',
      supplier_delivery_note_ref: 'BL-7',
      status: 'POSTED',
    };
    expect(duplicateDeliveryNote('sup', ' BL-7 ', [posted], [])).toBe(true);
    expect(duplicateDeliveryNote('autre', 'BL-7', [posted], [])).toBe(false);
    expect(duplicateDeliveryNote('sup', 'BL-7', [{ ...posted, status: 'REJECTED' }], [])).toBe(
      false,
    );
    const sent = receipt({
      payload: {
        purchaseOrderId: 'po',
        supplierId: 'sup',
        supplierDeliveryNoteRef: 'BL-8',
        locationId: 'store-b',
        lines: [],
      },
    });
    expect(duplicateDeliveryNote('sup', 'BL-8', [], [sent])).toBe(true);
    expect(
      duplicateDeliveryNote('sup', 'BL-8', [], [{ ...sent, local_flags: ['EXPECTED_QUARANTINE'] }]),
    ).toBe(false);
    // Accepté sans quarantaine : la réponse du serveur fait foi, l'indice local ne retient plus rien.
    expect(
      pendingConsumption(
        [
          receipt({
            status: 'SYNCED',
            synced_at: '2026-10-10T08:30:00.000Z',
            local_flags: ['EXPECTED_QUARANTINE'],
          }),
        ],
        undefined,
      ).get('store-b:p'),
    ).toBe(-8);
  });

  it('bon de livraison d’une réception annulée : ressaisie sans faux doublon', () => {
    // La réception r1 (BL-7) est téléchargée annulée ; sa commande acceptée reste dans l'outbox.
    const cancelled = {
      id: 'r1',
      supplier_id: 'sup',
      supplier_delivery_note_ref: 'BL-7',
      status: 'CANCELLED',
    };
    const accepted = receipt({
      status: 'SYNCED',
      synced_at: '2026-10-10T08:30:00.000Z',
      payload: { supplierId: 'sup', supplierDeliveryNoteRef: 'BL-7', lines: [] },
    });
    expect(duplicateDeliveryNote('sup', 'BL-7', [cancelled], [accepted])).toBe(false);
    // Commande acceptée et déjà retéléchargée (tirage postérieur) : le jeu fait foi.
    expect(duplicateDeliveryNote('sup', 'BL-7', [], [accepted], '2026-10-10T08:45:00.000Z')).toBe(
      false,
    );
    // Encore en vol : doublon.
    expect(duplicateDeliveryNote('sup', 'BL-7', [], [accepted], '2026-10-10T08:00:00.000Z')).toBe(
      true,
    );
  });

  it('reste à recevoir : une réception en quarantaine n’avance pas le bon', () => {
    const line = (overrides: Partial<OutboxCommand>) =>
      receipt({
        payload: { lines: [{ poLineId: 'pol', qtyDeliveredBase: 100, qtyRejectedBase: 0 }] },
        ...overrides,
      });
    expect(inFlightAccepted([line({})], undefined).get('pol')).toBe(100);
    expect(
      inFlightAccepted([line({ local_flags: ['EXPECTED_QUARANTINE'] })], undefined).get('pol'),
    ).toBeUndefined();
    expect(
      inFlightAccepted(
        [
          line({
            status: 'SYNCED_WITH_WARNING',
            synced_at: '2026-10-10T08:30:00.000Z',
            warnings: ['RECEIPT_QUARANTINED'],
          }),
        ],
        undefined,
      ).get('pol'),
    ).toBeUndefined();
  });
});
