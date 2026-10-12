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
      .mockResolvedValueOnce({ outcome: 'PUSHED', count: 50, settled: 50 })
      .mockResolvedValueOnce({ outcome: 'PUSHED', count: 3, settled: 3 })
      .mockResolvedValueOnce({ outcome: 'NOTHING_TO_PUSH' });
    pullMock.mockResolvedValueOnce({ outcome: 'SYNCED', changeCount: 0 });

    const outcome = await runSyncCycle(deps());
    expect(outcome).toBe('SYNCED');
    expect(pushMock).toHaveBeenCalledTimes(3);
    expect(pullMock).toHaveBeenCalledTimes(1);
  });

  it('lot sans rien de réglé (RETRY_LATER partout) : pas de renvoi immédiat, le tirage a lieu', async () => {
    pushMock.mockResolvedValue({ outcome: 'PUSHED', count: 2, settled: 0 });
    pullMock.mockResolvedValueOnce({ outcome: 'SYNCED', changeCount: 0 });

    expect(await runSyncCycle(deps())).toBe('SYNCED');
    expect(pushMock).toHaveBeenCalledTimes(1);
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

  it('push réussi mais pull hors ligne : OFFLINE, le serveur n’est plus joignable (ADR-051)', async () => {
    pushMock
      .mockResolvedValueOnce({ outcome: 'PUSHED', count: 1, settled: 1 })
      .mockResolvedValueOnce({ outcome: 'NOTHING_TO_PUSH' });
    pullMock.mockResolvedValueOnce({ outcome: 'OFFLINE' });

    expect(await runSyncCycle(deps())).toBe('OFFLINE');
  });

  it('erreur HTTP à l’envoi : le lot attend, le tirage a lieu, issue SERVER_ERROR', async () => {
    pushMock.mockResolvedValueOnce({ outcome: 'SERVER_ERROR' });
    pullMock.mockResolvedValueOnce({ outcome: 'SYNCED', changeCount: 2 });

    expect(await runSyncCycle(deps())).toBe('SERVER_ERROR');
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pullMock).toHaveBeenCalledTimes(1);
  });

  it('SyncEngine.trigger() pendant un cycle : même promesse, puis un seul cycle de plus', async () => {
    let resolvePush!: (value: PushCycleResult) => void;
    pushMock.mockImplementationOnce(
      () =>
        new Promise<PushCycleResult>((resolve) => {
          resolvePush = resolve;
        }),
    );
    pullMock.mockResolvedValue({ outcome: 'SYNCED', changeCount: 0 });

    pushMock.mockResolvedValue({ outcome: 'NOTHING_TO_PUSH' });
    const engine = new SyncEngine(deps());
    const first = engine.trigger();
    const second = engine.trigger();
    const third = engine.trigger();
    expect(first).toBe(second); // même promesse : pas de cycle concurrent
    expect(second).toBe(third);

    resolvePush({ outcome: 'NOTHING_TO_PUSH' });
    await first;
    // Les déclenchements reçus pendant le cycle donnent un seul cycle de plus, aussitôt.
    expect(pullMock).toHaveBeenCalledTimes(2);
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
