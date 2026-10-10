import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixedClock, Uuidv7Generator } from '@gic/domain';
import type { PullResponse, PushResponse } from '@gic/contracts';
import { createTestDb, type GicDatabase } from '../storage/db.js';
import { enqueueCommand, resetInterruptedPushes } from './outbox.js';
import { runPushCycle } from './push.js';
import { ensureDataOwner, runPullCycle } from './pull.js';
import { clearSessionRuntime, setSessionRuntime } from '../features/auth/session-runtime.js';
import {
  isEffectivelyOnline,
  reportSyncOutcome,
  resetConnectivityForTests,
} from '../platform/connectivity.js';

const clock = new FixedClock(new Date('2026-10-10T09:00:00.000Z'));
const idGenerator = new Uuidv7Generator(clock);
const DEVICE_ID = idGenerator.newId();

function stubValidSession(userId = 'user-1'): void {
  setSessionRuntime({
    userId,
    deviceId: DEVICE_ID,
    deviceStatus: 'ACTIVE',
    refreshToken: 'refresh-token',
    accessToken: 'valid-access-token',
    accessTokenExpiresAt: Date.now() + 60_000,
    pinKey: {} as CryptoKey,
  });
}

async function enqueueSale(db: GicDatabase, capturedOffline = false) {
  return enqueueCommand(
    db,
    { clock, idGenerator },
    {
      authorUserId: 'user-1',
      commandType: 'sales.sale.record',
      commandVersion: 1,
      aggregateType: 'SALE',
      payload: { fromLocationId: 'loc', lines: [{ productId: 'p', quantityBase: 1 }] },
      capturedOffline,
    },
  );
}

const emptyPull = (): PullResponse => ({ changes: [], next_cursor: 0, has_more: false });

describe('synchronisation durcie (ADR-051)', () => {
  let db: GicDatabase;

  beforeEach(async () => {
    db = createTestDb(`test-hardening-${Math.random()}`);
    await db.syncMeta.put({
      key: 'device',
      device_id: DEVICE_ID,
      clock_skew_ms: null,
      last_sync_at: null,
    });
    stubValidSession();
    resetConnectivityForTests();
  });

  afterEach(async () => {
    clearSessionRuntime();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetConnectivityForTests();
    await db.delete();
  });

  it('serveur injoignable au dernier cycle : hors ligne même si l’interface réseau est active', () => {
    expect(isEffectivelyOnline()).toBe(true);
    reportSyncOutcome('OFFLINE');
    expect(isEffectivelyOnline()).toBe(false);
    reportSyncOutcome('NOTHING_TO_DO');
    expect(isEffectivelyOnline()).toBe(true);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(isEffectivelyOnline()).toBe(false);
  });

  it('premier envoi sans serveur joignable : la saisie devient un fait hors ligne ; une erreur HTTP non', async () => {
    const first = await enqueueSale(db);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network');
      }),
    );
    await runPushCycle(db, { clock, idGenerator, deviceId: DEVICE_ID });
    expect(await db.outbox.get(first.command_id)).toMatchObject({
      captured_offline: true,
      attempts: 1,
      status: 'PENDING_SYNC',
    });

    const second = await enqueueSale(db);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 })),
    );
    await runPushCycle(db, { clock, idGenerator, deviceId: DEVICE_ID });
    expect((await db.outbox.get(second.command_id))?.captured_offline).toBe(false);
  });

  it('commande acceptée : heure d’acceptation retenue', async () => {
    const command = await enqueueSale(db);
    const response = {
      server_time: '2026-10-10T09:00:00.000Z',
      clock_skew_ms: 0,
      results: [
        { command_id: command.command_id, status: 'APPLIED', server_refs: { docNumber: 'VTE-1' } },
      ],
    } as unknown as PushResponse;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })),
    );
    await runPushCycle(db, { clock, idGenerator, deviceId: DEVICE_ID });
    expect(await db.outbox.get(command.command_id)).toMatchObject({
      status: 'SYNCED',
      synced_at: '2026-10-10T09:00:00.000Z',
    });
  });

  it('tirage complet d’un jeu : heure de départ de la dernière requête retenue', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(emptyPull()), { status: 200 })),
    );
    await runPullCycle(db, { clock });
    expect((await db.syncCursors.get('stock'))?.pulled_at).toBe('2026-10-10T09:00:00.000Z');
  });

  it('envoi interrompu (onglet fermé) : la commande repart', async () => {
    const command = await enqueueSale(db);
    await db.outbox.update(command.command_id, { status: 'SYNCING' });
    expect(await resetInterruptedPushes(db)).toBe(1);
    expect((await db.outbox.get(command.command_id))?.status).toBe('PENDING_SYNC');
  });

  it('autre utilisateur sur l’appareil : projections et curseurs effacés, outbox gardée', async () => {
    const command = await enqueueSale(db, true);
    await db.projections.put({
      key: 'customers:CUSTOMER:c1',
      dataset: 'customers',
      entity_type: 'CUSTOMER',
      entity_id: 'c1',
      scope_type: 'USER',
      scope_id: 'user-1',
      row_version: 1,
      data: { display_name: 'Client de user-1' },
      seq: 1,
    });
    await db.syncCursors.put({ dataset: 'customers', cursor: 10 });
    expect(await ensureDataOwner(db, 'user-1')).toBe(true); // propriétaire inconnu : effacement unique
    await db.syncCursors.put({ dataset: 'customers', cursor: 12 });
    expect(await ensureDataOwner(db, 'user-1')).toBe(false);
    expect(await db.syncCursors.count()).toBe(1);

    expect(await ensureDataOwner(db, 'user-2')).toBe(true);
    expect(await db.projections.count()).toBe(0);
    expect(await db.syncCursors.count()).toBe(0);
    expect(await db.outbox.get(command.command_id)).toBeDefined();
    expect((await db.syncMeta.get('device'))?.data_user_id).toBe('user-2');
  });
});
