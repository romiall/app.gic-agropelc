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

describe('synchronisation durcie (ADR-037)', () => {
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

  it('envoi coupé : l’enveloppe renvoyée est identique (empreinte d’idempotence du serveur)', async () => {
    const command = await enqueueSale(db);
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        bodies.push(String(init?.body));
        throw new TypeError('connexion coupée après l’envoi');
      }),
    );
    await runPushCycle(db, { clock, idGenerator, deviceId: DEVICE_ID });
    await runPushCycle(db, { clock, idGenerator, deviceId: DEVICE_ID });
    const envelopes = bodies.map(
      (body) => (JSON.parse(body) as { commands: unknown[] }).commands[0],
    );
    expect(envelopes).toHaveLength(2);
    expect(envelopes[1]).toEqual(envelopes[0]);
    expect(await db.outbox.get(command.command_id)).toMatchObject({
      captured_offline: false,
      attempts: 2,
      status: 'PENDING_SYNC',
    });
  });

  it('erreur HTTP 500 : serveur joignable (SERVER_ERROR), l’appareil reste en ligne', async () => {
    await enqueueSale(db);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 })),
    );
    const result = await runPushCycle(db, { clock, idGenerator, deviceId: DEVICE_ID });
    expect(result).toEqual({ outcome: 'SERVER_ERROR' });
    reportSyncOutcome('SERVER_ERROR');
    expect(isEffectivelyOnline()).toBe(true);
  });

  it('seules les commandes de l’utilisateur de la session partent', async () => {
    const mine = await enqueueSale(db);
    const other = await enqueueCommand(
      db,
      { clock, idGenerator },
      {
        authorUserId: 'user-2',
        commandType: 'sales.sale.record',
        commandVersion: 1,
        aggregateType: 'SALE',
        payload: {},
        capturedOffline: true,
      },
    );
    const sent: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { commands: { command_id: string }[] };
        sent.push(...body.commands.map((command) => command.command_id));
        throw new TypeError('network');
      }),
    );
    await runPushCycle(db, { clock, idGenerator, deviceId: DEVICE_ID, userId: 'user-1' });
    expect(sent).toEqual([mine.command_id]);
    expect((await db.outbox.get(other.command_id))?.status).toBe('LOCAL_ONLY');
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

  it('erreur HTTP sur un jeu : les autres jeux sont tirés, synchronisation incomplète', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) =>
        String(url).includes('dataset=stock&')
          ? new Response('{}', { status: 500 })
          : new Response(JSON.stringify(emptyPull()), { status: 200 }),
      ),
    );
    const result = await runPullCycle(db, { clock });
    expect(result).toEqual({ outcome: 'SERVER_ERROR', changeCount: 0 });
    expect(await db.syncCursors.get('stock')).toBeUndefined();
    expect((await db.syncCursors.get('product'))?.pulled_at).toBe('2026-10-10T09:00:00.000Z');
    expect((await db.syncMeta.get('device'))?.last_sync_at).toBeNull();
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
    // Appareil antérieur au champ : les jeux sont adoptés par l'utilisateur courant, sans effacement.
    expect(await ensureDataOwner(db, 'user-1')).toBe(false);
    expect(await db.syncCursors.count()).toBe(1);
    expect(await db.projections.count()).toBe(1);
    expect(await ensureDataOwner(db, 'user-1')).toBe(false);

    expect(await ensureDataOwner(db, 'user-2')).toBe(true);
    expect(await db.projections.count()).toBe(0);
    expect(await db.syncCursors.count()).toBe(0);
    expect(await db.outbox.get(command.command_id)).toBeDefined();
    expect((await db.syncMeta.get('device'))?.data_user_id).toBe('user-2');
  });
});
