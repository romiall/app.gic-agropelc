import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, type OutboxCommand } from '../../storage/db.js';
import {
  ALLOCATION_ID,
  allocationRow,
  DEVICE_ID,
  IDS,
  meSettingRow,
  seedSalesFixtures,
} from './fixtures.js';
import { deviceQuota, offlineExitGuard, type ExitKind } from './quota.js';
import { loadSalesReferences } from './references.js';

const OTHER_USER = '01900000-0000-7000-8000-0000000000e9';
const OTHER_DEVICE = '01900000-0000-7000-8000-0000000000d9';

let seq = 0;
function command(
  type: string,
  payload: object,
  overrides: Partial<OutboxCommand> = {},
): OutboxCommand {
  seq += 1;
  const n = String(seq).padStart(4, '0');
  return {
    command_id: `01900000-0000-7000-8000-00000000${n}`,
    device_seq: seq,
    command_type: type,
    command_version: 1,
    author_user_id: IDS.user,
    aggregate_type: 'SALE',
    aggregate_id: `01900000-0000-7000-8000-00000001${n}`,
    base_version: null,
    depends_on: [],
    occurred_at: '2026-10-10T08:00:00.000Z',
    client_created_at: '2026-10-10T08:00:00.000Z',
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

/** Vente hors ligne de `quantity` œufs au comptoir. */
function sale(quantity: number, overrides: Partial<OutboxCommand> = {}): OutboxCommand {
  return command(
    'sales.sale.record',
    {
      fromLocationId: IDS.pos,
      lines: [{ productId: IDS.eggs, unitCode: 'U', quantity, quantityBase: quantity }],
      payments: [],
    },
    overrides,
  );
}

const input = { userId: IDS.user, deviceId: DEVICE_ID, locationId: IDS.pos, productId: IDS.eggs };

describe('Quota du téléphone (ADR-033, AT-003, AT-004)', () => {
  beforeEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await db.syncCursors.clear();
    await db.syncMeta.clear();
    await seedSalesFixtures(db);
    await db.syncMeta.put({
      key: 'device',
      device_id: DEVICE_ID,
      clock_skew_ms: null,
      last_sync_at: null,
      data_user_id: IDS.user,
    });
  });

  afterEach(async () => {
    const db = getDb();
    await db.projections.clear();
    await db.outbox.clear();
    await db.syncCursors.clear();
    await db.syncMeta.clear();
  });

  it('reste net des ventes de l’utilisateur en attente, jusqu’au tirage des quotas qui les inclut', async () => {
    const db = getDb();
    await db.projections.put(allocationRow({ quantity_remaining: '40.000' }));
    await db.outbox.bulkAdd([
      sale(8),
      // Vente d'un autre utilisateur de la tablette : elle ne touche pas ce quota.
      sale(5, { author_user_id: OTHER_USER }),
      // Vente acceptée après le dernier tirage des quotas : encore retranchée.
      sale(2, { status: 'SYNCED', synced_at: '2026-10-10T08:30:00.000Z' }),
      // Vente acceptée avant le dernier tirage : déjà dans le reste servi.
      sale(10, { status: 'SYNCED', synced_at: '2026-10-10T07:00:00.000Z' }),
    ]);
    await db.syncCursors.put({
      dataset: 'allocations',
      cursor: 9,
      pulled_at: '2026-10-10T08:00:00.000Z',
    });
    const refs = await loadSalesReferences(db);
    expect(deviceQuota(refs, input)).toMatchObject({
      allocation: { id: ALLOCATION_ID },
      remaining: 30,
      validUntil: new Date('2026-10-10T22:59:59.999Z'),
    });
  });

  it('pas de quota : autre utilisateur ou autre appareil, signal de révocation, libération saisie', async () => {
    const db = getDb();
    // Quota d'un autre utilisateur de la tablette, puis quota de l'utilisateur sur un autre appareil.
    await db.projections.put(allocationRow({ holder_user_id: OTHER_USER }));
    let refs = await loadSalesReferences(db);
    expect(deviceQuota(refs, input)).toBeNull();
    await db.projections.put(allocationRow({ holder_device_id: OTHER_DEVICE }));
    refs = await loadSalesReferences(db);
    expect(deviceQuota(refs, input)).toBeNull();
    // Appareil signalé (révocation en attente) : le quota ne se consomme plus.
    await db.projections.put(allocationRow({ revocation_pending: true }));
    refs = await loadSalesReferences(db);
    expect(deviceQuota(refs, input)).toBeNull();
    // Quota tenu, puis libéré sur l'appareil (pas encore sorti du jeu) : plus tenu.
    await db.projections.put(allocationRow());
    refs = await loadSalesReferences(db);
    expect(deviceQuota(refs, input)).not.toBeNull();
    await db.outbox.add(
      command(
        'inventory.allocation.release',
        { remainingBase: 40 },
        { aggregate_type: 'STOCK_ALLOCATION', aggregate_id: ALLOCATION_ID },
      ),
    );
    refs = await loadSalesReferences(db);
    expect(deviceQuota(refs, input)).toBeNull();
    // Libération refusée par le serveur : le quota reste tenu.
    await db.outbox.toCollection().modify({ status: 'REJECTED' });
    refs = await loadSalesReferences(db);
    expect(deviceQuota(refs, input)).not.toBeNull();
  });

  it('garde hors ligne des sorties (BR-STK-013, AV-303) : quota du détenteur, solde exclusif, appareil désigné', async () => {
    const db = getDb();
    await db.projections.put(allocationRow({ quantity_remaining: '30.000', valid_until: null }));
    const now = new Date('2026-10-10T09:00:00.000Z');
    let refs = await loadSalesReferences(db);
    const pos = refs.locations.find((location) => location.id === IDS.pos);
    if (!pos) throw new Error('PDV absent');
    const guard = (kind: ExitKind, quantity: number, location = pos, product: string = IDS.eggs) =>
      offlineExitGuard(refs, {
        kind,
        location,
        requested: new Map([[product, quantity]]),
        userId: IDS.user,
        deviceId: DEVICE_ID,
        now,
      });
    // Détenteur d'un quota sur un emplacement partagé : expédition et consommation dans le reste.
    expect(guard('DISPATCH', 30)).toEqual({ blocks: [], signals: [] });
    expect(guard('DISPATCH', 31).blocks).toEqual([
      { productId: IDS.eggs, code: 'ALLOCATION_EXCEEDED', available: 30, requested: 31 },
    ]);
    expect(guard('CONSUMPTION', 31).blocks).toHaveLength(1);
    // Perte au-delà : signalée, jamais refusée (fait constaté).
    expect(guard('LOSS', 31)).toEqual({
      blocks: [],
      signals: [{ productId: IDS.eggs, code: 'ALLOCATION_EXCEEDED', available: 30, requested: 31 }],
    });
    // Sans quota (le poulet) : une vente est refusée, une autre sortie suit le contrôle de l'écran.
    expect(guard('SALE', 1, pos, IDS.chicken).blocks[0]?.code).toBe('ALLOCATION_MISSING');
    expect(guard('DISPATCH', 1, pos, IDS.chicken)).toEqual({ blocks: [], signals: [] });
    // Emplacement exclusif : solde local ; confié à un autre appareil : refusé.
    const exclusive = { ...pos, custody_mode: 'EXCLUSIVE_USER' as const };
    expect(guard('CONSUMPTION', 301, exclusive).blocks[0]).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      available: 300,
    });
    const otherDevice = {
      ...pos,
      custody_mode: 'EXCLUSIVE_DEVICE' as const,
      designated_device_id: '01900000-0000-7000-8000-0000000000d9',
    };
    expect(guard('LOSS', 1, otherDevice).blocks[0]?.code).toBe('CUSTODY_DEVICE_MISMATCH');
    // Dépassement autorisé par le site (quota comme solde exclusif) : signalé.
    await db.projections.put(
      meSettingRow('sales.offline_over_allocation_allowed', true, { type: 'SITE', id: IDS.site }),
    );
    refs = await loadSalesReferences(db);
    expect(guard('DISPATCH', 31)).toEqual({
      blocks: [],
      signals: [{ productId: IDS.eggs, code: 'ALLOCATION_EXCEEDED', available: 0, requested: 31 }],
    });
  });
});
