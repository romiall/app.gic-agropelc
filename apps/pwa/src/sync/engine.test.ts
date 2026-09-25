import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixedClock, Uuidv7Generator } from '@gic/domain';
import { createTestDb, type GicDatabase } from '../storage/db.js';
import { runSyncCycle, SyncEngine } from './engine.js';
import type { PushCycleResult } from './push.js';
import type { PullCycleResult } from './pull.js';

const { pushMock, pullMock } = vi.hoisted(() => ({
  pushMock: vi.fn<() => Promise<PushCycleResult>>(),
  pullMock: vi.fn<() => Promise<PullCycleResult>>(),
}));

vi.mock('./push.js', () => ({ runPushCycle: pushMock }));
vi.mock('./pull.js', () => ({ runPullCycle: pullMock }));

const clock = new FixedClock(new Date('2026-09-25T09:00:00.000Z'));
const idGenerator = new Uuidv7Generator(clock);

describe('sync/engine (runSyncCycle)', () => {
  let db: GicDatabase;
  let onSessionInvalid: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = createTestDb(`test-engine-${Math.random()}`);
    onSessionInvalid = vi.fn();
    pushMock.mockReset();
    pullMock.mockReset();
  });

  afterEach(async () => {
    await db.delete();
  });

  function deps() {
    return { db, clock, idGenerator, deviceId: 'device-1', onSessionInvalid };
  }

  it('vide l’outbox (plusieurs lots) puis tire, et rapporte SYNCED', async () => {
    pushMock
      .mockResolvedValueOnce({ outcome: 'PUSHED', count: 50 })
      .mockResolvedValueOnce({ outcome: 'PUSHED', count: 3 })
      .mockResolvedValueOnce({ outcome: 'NOTHING_TO_PUSH' });
    pullMock.mockResolvedValueOnce({ outcome: 'SYNCED', changeCount: 0 });

    const outcome = await runSyncCycle(deps());
    expect(outcome).toBe('SYNCED');
    expect(pushMock).toHaveBeenCalledTimes(3);
    expect(pullMock).toHaveBeenCalledTimes(1);
  });

  it('rien à pousser ni à tirer : NOTHING_TO_DO', async () => {
    pushMock.mockResolvedValueOnce({ outcome: 'NOTHING_TO_PUSH' });
    pullMock.mockResolvedValueOnce({ outcome: 'SYNCED', changeCount: 0 });

    expect(await runSyncCycle(deps())).toBe('NOTHING_TO_DO');
  });

  it('hors ligne dès le push : OFFLINE, jamais d’appel à pull', async () => {
    pushMock.mockResolvedValueOnce({ outcome: 'OFFLINE' });

    expect(await runSyncCycle(deps())).toBe('OFFLINE');
    expect(pullMock).not.toHaveBeenCalled();
  });

  it('session invalide au push : SESSION_INVALID, callback appelé, pas de pull', async () => {
    pushMock.mockResolvedValueOnce({ outcome: 'SESSION_INVALID' });

    expect(await runSyncCycle(deps())).toBe('SESSION_INVALID');
    expect(onSessionInvalid).toHaveBeenCalledOnce();
    expect(pullMock).not.toHaveBeenCalled();
  });

  it('push réussi mais pull hors ligne : tout de même SYNCED (le push a eu un effet réel)', async () => {
    pushMock
      .mockResolvedValueOnce({ outcome: 'PUSHED', count: 1 })
      .mockResolvedValueOnce({ outcome: 'NOTHING_TO_PUSH' });
    pullMock.mockResolvedValueOnce({ outcome: 'OFFLINE' });

    expect(await runSyncCycle(deps())).toBe('SYNCED');
  });

  it('SyncEngine.trigger() ne relance pas un cycle déjà en vol (un seul appel concurrent)', async () => {
    let resolvePush!: (value: PushCycleResult) => void;
    pushMock.mockImplementationOnce(
      () =>
        new Promise<PushCycleResult>((resolve) => {
          resolvePush = resolve;
        }),
    );
    pullMock.mockResolvedValue({ outcome: 'SYNCED', changeCount: 0 });

    const engine = new SyncEngine(deps());
    const first = engine.trigger();
    const second = engine.trigger();
    expect(first).toBe(second); // même promesse : pas de second cycle empilé

    resolvePush({ outcome: 'NOTHING_TO_PUSH' });
    await first;
  });

  it('onCycleComplete est appelé avec le résultat du cycle', async () => {
    pushMock.mockResolvedValueOnce({ outcome: 'NOTHING_TO_PUSH' });
    pullMock.mockResolvedValueOnce({ outcome: 'SYNCED', changeCount: 0 });
    const onCycleComplete = vi.fn();

    const engine = new SyncEngine({ ...deps(), onCycleComplete });
    await engine.trigger();
    expect(onCycleComplete).toHaveBeenCalledWith('NOTHING_TO_DO');
  });
});
