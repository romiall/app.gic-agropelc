import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixedClock } from '@gic/domain';
import type { PullResponse } from '@gic/contracts';
import { createTestDb, type GicDatabase } from '../storage/db.js';
import { runPullCycle, KNOWN_DATASETS } from './pull.js';
import { clearSessionRuntime, setSessionRuntime } from '../features/auth/session-runtime.js';

const clock = new FixedClock(new Date('2026-09-25T09:00:00.000Z'));

function emptyPullResponse(): PullResponse {
  return { changes: [], next_cursor: 0, has_more: false };
}

function stubValidSession(): void {
  setSessionRuntime({
    userId: 'user-1',
    deviceId: 'device-1',
    deviceStatus: 'ACTIVE',
    refreshToken: 'refresh-token',
    accessToken: 'valid-access-token',
    accessTokenExpiresAt: Date.now() + 60_000,
    pinKey: {} as CryptoKey,
  });
}

describe('sync/pull (runPullCycle)', () => {
  let db: GicDatabase;

  beforeEach(async () => {
    db = createTestDb(`test-pull-${Math.random()}`);
    await db.syncMeta.put({
      key: 'device',
      device_id: 'device-1',
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

  it('interroge chaque jeu de données connu et avance last_sync_at quand tout réussit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(emptyPullResponse()), { status: 200 })),
    );

    const result = await runPullCycle(db, { clock });
    expect(result).toEqual({ outcome: 'SYNCED', changeCount: 0 });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(KNOWN_DATASETS.length);

    const meta = await db.syncMeta.get('device');
    expect(meta?.last_sync_at).toBe(clock.now().toISOString());
  });

  it('UPSERT avec données : projeté, DELETE : retiré des projections', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        // Seul le premier jeu de données ('user', KNOWN_DATASETS[0]) reçoit des changements
        // dans ce test, pour ne pas dupliquer les mêmes assertions sur les 12 jeux.
        const body: PullResponse =
          call === 1
            ? {
                changes: [
                  {
                    seq: 1,
                    dataset: 'user',
                    entity_type: 'USER',
                    entity_id: 'user-1',
                    change_type: 'UPSERT',
                    scope_type: 'USER',
                    scope_id: 'user-1',
                    row_version: 1,
                    data: { full_name: 'Alpha' },
                  },
                ],
                next_cursor: 1,
                has_more: false,
              }
            : emptyPullResponse();
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );

    await runPullCycle(db, { clock });
    let projected = await db.projections.get('user:USER:user-1');
    expect(projected?.data).toEqual({ full_name: 'Alpha' });
    expect((await db.syncCursors.get('user'))?.cursor).toBe(1);

    // Second cycle : le même enregistrement est supprimé (DELETE).
    call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        const body: PullResponse =
          call === 1
            ? {
                changes: [
                  {
                    seq: 2,
                    dataset: 'user',
                    entity_type: 'USER',
                    entity_id: 'user-1',
                    change_type: 'DELETE',
                    scope_type: 'USER',
                    scope_id: 'user-1',
                    row_version: 2,
                  },
                ],
                next_cursor: 2,
                has_more: false,
              }
            : emptyPullResponse();
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    await runPullCycle(db, { clock });
    projected = await db.projections.get('user:USER:user-1');
    expect(projected).toBeUndefined();
  });

  it('pagination : boucle tant que has_more est vrai, cumule changeCount', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call += 1;
        if (call === 1) {
          const body: PullResponse = {
            changes: [
              {
                seq: 1,
                dataset: 'user',
                entity_type: 'USER',
                entity_id: 'user-1',
                change_type: 'UPSERT',
                scope_type: 'GLOBAL',
                scope_id: null,
                row_version: 1,
                data: {},
              },
            ],
            next_cursor: 1,
            has_more: true,
          };
          return new Response(JSON.stringify(body), { status: 200 });
        }
        return new Response(JSON.stringify(emptyPullResponse()), { status: 200 });
      }),
    );

    const result = await runPullCycle(db, { clock });
    expect(result.outcome).toBe('SYNCED');
    if (result.outcome === 'SYNCED') expect(result.changeCount).toBeGreaterThanOrEqual(1);
  });

  it('hors ligne : OFFLINE, aucune mise à jour de last_sync_at', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network error');
      }),
    );

    const result = await runPullCycle(db, { clock });
    expect(result).toEqual({ outcome: 'OFFLINE' });
    expect((await db.syncMeta.get('device'))?.last_sync_at).toBeNull();
  });
});
