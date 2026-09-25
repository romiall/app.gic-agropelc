import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixedClock, Uuidv7Generator } from '@gic/domain';
import type { PushResponse } from '@gic/contracts';
import { createTestDb, type GicDatabase } from '../storage/db.js';
import { enqueueCommand } from './outbox.js';
import { runPushCycle } from './push.js';
import { clearSessionRuntime, setSessionRuntime } from '../features/auth/session-runtime.js';

const clock = new FixedClock(new Date('2026-09-25T09:00:00.000Z'));
const idGenerator = new Uuidv7Generator(clock);
const DEVICE_ID = idGenerator.newId();

function stubValidSession(): void {
  setSessionRuntime({
    userId: 'user-1',
    deviceId: DEVICE_ID,
    deviceStatus: 'ACTIVE',
    refreshToken: 'refresh-token',
    accessToken: 'valid-access-token',
    accessTokenExpiresAt: Date.now() + 60_000,
    pinKey: {} as CryptoKey, // jamais utilisée : le jeton d'accès en mémoire est déjà valide
  });
}

async function enqueueOne(db: GicDatabase, note: string) {
  return enqueueCommand(
    db,
    { clock, idGenerator },
    {
      authorUserId: 'user-1',
      commandType: 'organization.setting.set',
      commandVersion: 1,
      aggregateType: 'SETTING',
      payload: { note },
      capturedOffline: true,
    },
  );
}

describe('sync/push (runPushCycle)', () => {
  let db: GicDatabase;

  beforeEach(async () => {
    db = createTestDb(`test-push-${Math.random()}`);
    await db.syncMeta.put({
      key: 'device',
      device_id: DEVICE_ID,
      clock_skew_ms: null,
      last_sync_at: null,
    });
    stubValidSession();
  });

  afterEach(async () => {
    clearSessionRuntime();
    vi.unstubAllGlobals();
    await db.delete();
  });

  it('sans commande en attente : NOTHING_TO_PUSH, aucun appel réseau', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await runPushCycle(db, { clock, idGenerator, deviceId: DEVICE_ID });
    expect(result).toEqual({ outcome: 'NOTHING_TO_PUSH' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('chemin heureux : applique results[] à l’outbox et mémorise clock_skew_ms', async () => {
    const command = await enqueueOne(db, 'un');
    const response: PushResponse = {
      results: [
        {
          command_id: command.command_id,
          status: 'APPLIED',
          server_refs: { doc_number: 'BC-0001' },
        },
      ],
      server_time: clock.now().toISOString(),
      clock_skew_ms: 1234,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })),
    );

    const result = await runPushCycle(db, { clock, idGenerator, deviceId: DEVICE_ID });
    expect(result).toEqual({ outcome: 'PUSHED', count: 1 });

    const updated = await db.outbox.get(command.command_id);
    expect(updated?.status).toBe('SYNCED');
    expect(updated?.server_refs).toEqual({ doc_number: 'BC-0001' });

    const meta = await db.syncMeta.get('device');
    expect(meta?.clock_skew_ms).toBe(1234);
  });

  it('REJECTED : statut et motif conservés sur la commande (BR-SYN-009)', async () => {
    const command = await enqueueOne(db, 'refusée');
    const response: PushResponse = {
      results: [
        {
          command_id: command.command_id,
          status: 'REJECTED',
          error: { code: 'FORBIDDEN', message_fr: 'Droit insuffisant.' },
        },
      ],
      server_time: clock.now().toISOString(),
      clock_skew_ms: 0,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })),
    );

    await runPushCycle(db, { clock, idGenerator, deviceId: DEVICE_ID });
    const updated = await db.outbox.get(command.command_id);
    expect(updated?.status).toBe('REJECTED');
    expect(updated?.last_error).toEqual({ code: 'FORBIDDEN', message_fr: 'Droit insuffisant.' });
  });

  it('hors ligne (fetch échoue) : les commandes redeviennent PENDING_SYNC, attempts incrémenté', async () => {
    const command = await enqueueOne(db, 'hors ligne');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network error');
      }),
    );

    const result = await runPushCycle(db, { clock, idGenerator, deviceId: DEVICE_ID });
    expect(result).toEqual({ outcome: 'OFFLINE' });

    const updated = await db.outbox.get(command.command_id);
    expect(updated?.status).toBe('PENDING_SYNC');
    expect(updated?.attempts).toBe(1);
  });

  it('erreur HTTP du contrôleur (ex. 400) : reportée comme OFFLINE, pas de déconnexion forcée', async () => {
    const command = await enqueueOne(db, 'malformée');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'VALIDATION_ERROR' } }), { status: 400 }),
      ),
    );

    const result = await runPushCycle(db, { clock, idGenerator, deviceId: DEVICE_ID });
    expect(result).toEqual({ outcome: 'OFFLINE' });
    expect((await db.outbox.get(command.command_id))?.status).toBe('PENDING_SYNC');
  });

  it('session révoquée (rafraîchissement refusé) : SESSION_INVALID', async () => {
    // Jeton d'accès déjà expiré : force `ensureAccessToken` à tenter un rafraîchissement.
    setSessionRuntime({
      userId: 'user-1',
      deviceId: DEVICE_ID,
      deviceStatus: 'ACTIVE',
      refreshToken: 'refresh-token',
      accessToken: undefined,
      accessTokenExpiresAt: undefined,
      pinKey: {} as CryptoKey,
    });
    const command = await enqueueOne(db, 'session révoquée');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'INVALID_REFRESH_TOKEN' } }), {
            status: 401,
          }),
      ),
    );

    const result = await runPushCycle(db, { clock, idGenerator, deviceId: DEVICE_ID });
    expect(result).toEqual({ outcome: 'SESSION_INVALID' });
    expect((await db.outbox.get(command.command_id))?.status).toBe('PENDING_SYNC');
  });
});
