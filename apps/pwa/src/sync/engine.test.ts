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

vi.mock('./push.js', () => ({ runPushCycle: pushMock, PUSH_TIMEOUT_MS: 60_000 }));
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

  let seq = 0;
  /** Commande restée `SYNCING`, envoyée à `sentAt` ; renvoie son identifiant. */
  async function syncingCommand(sentAt: string | null): Promise<string> {
    seq += 1;
    const commandId = idGenerator.newId();
    await db.outbox.add({
      command_id: commandId,
      device_seq: seq,
      command_type: 'sales.sale.record',
      command_version: 1,
      author_user_id: 'user-1',
      aggregate_type: 'SALE',
      aggregate_id: idGenerator.newId(),
      base_version: null,
      depends_on: [],
      occurred_at: clock.now().toISOString(),
      client_created_at: clock.now().toISOString(),
      captured_offline: true,
      backdated_reason: null,
      attachment_ids: [],
      payload: {},
      status: 'SYNCING',
      attempts: 1,
      next_attempt_at: null,
      last_error: null,
      server_refs: null,
      sent_at: sentAt,
    });
    return commandId;
  }

  it('vide l’outbox (plusieurs lots) puis tire, et rapporte SYNCED', async () => {
    pushMock
      .mockResolvedValueOnce({ outcome: 'PUSHED', count: 50, settled: 50, stalled: [] })
      .mockResolvedValueOnce({ outcome: 'PUSHED', count: 3, settled: 3, stalled: [] })
      .mockResolvedValueOnce({ outcome: 'NOTHING_TO_PUSH' });
    pullMock.mockResolvedValueOnce({ outcome: 'SYNCED', changeCount: 0 });

    const outcome = await runSyncCycle(deps());
    expect(outcome).toBe('SYNCED');
    expect(pushMock).toHaveBeenCalledTimes(3);
    expect(pullMock).toHaveBeenCalledTimes(1);
  });

  it('lot sans rien de réglé (RETRY_LATER partout) : pas de renvoi immédiat, le tirage a lieu', async () => {
    pushMock.mockResolvedValue({ outcome: 'PUSHED', count: 2, settled: 0, stalled: [] });
    pullMock.mockResolvedValueOnce({ outcome: 'SYNCED', changeCount: 0 });

    expect(await runSyncCycle(deps())).toBe('SYNCED');
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pullMock).toHaveBeenCalledTimes(1);
  });

  it('commande bloquée (COMMAND_STALLED) : écartée des lots suivants du même cycle, renvoyée au suivant (AV-217)', async () => {
    // Écartées vues par chaque envoi, copiées au moment de l'appel (l'ensemble évolue ensuite).
    const seen: string[][] = [];
    const answers: PushCycleResult[] = [
      { outcome: 'PUSHED', count: 50, settled: 49, stalled: ['bloquee'] },
      { outcome: 'PUSHED', count: 3, settled: 3, stalled: [] },
      { outcome: 'NOTHING_TO_PUSH' },
      // Cycle suivant : la commande bloquée repart.
      { outcome: 'PUSHED', count: 1, settled: 0, stalled: ['bloquee'] },
    ];
    pushMock.mockImplementation(((...args: unknown[]) => {
      seen.push([...(args[2] as { skip: ReadonlySet<string> }).skip]);
      return Promise.resolve(answers.shift() ?? { outcome: 'NOTHING_TO_PUSH' });
    }) as () => Promise<PushCycleResult>);
    pullMock.mockResolvedValue({ outcome: 'SYNCED', changeCount: 0 });

    expect(await runSyncCycle(deps())).toBe('SYNCED');
    expect(seen).toEqual([[], ['bloquee'], ['bloquee']]);
    await runSyncCycle(deps());
    expect(seen[3]).toEqual([]);
  });

  it('moteur arrêté entre deux lots (déconnexion, relève) : plus aucun lot ni tirage', async () => {
    const onCycleComplete = vi.fn();
    const engine = new SyncEngine({ ...deps(), onCycleComplete });
    pushMock.mockImplementationOnce(async () => {
      engine.stop();
      return { outcome: 'PUSHED', count: 50, settled: 50, stalled: [] };
    });
    pushMock.mockResolvedValue({ outcome: 'PUSHED', count: 1, settled: 1, stalled: [] });
    pullMock.mockResolvedValue({ outcome: 'SYNCED', changeCount: 0 });

    expect(await engine.trigger()).toBe('STOPPED');
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pullMock).not.toHaveBeenCalled();
    // Un cycle interrompu ne dit rien de la joignabilité du serveur.
    expect(onCycleComplete).not.toHaveBeenCalled();
  });

  it('session changée pendant l’envoi ou le tirage : cycle interrompu, sans déconnexion', async () => {
    pushMock.mockResolvedValueOnce({ outcome: 'SESSION_CHANGED' });
    expect(await runSyncCycle(deps())).toBe('STOPPED');
    expect(pullMock).not.toHaveBeenCalled();
    pushMock.mockResolvedValueOnce({ outcome: 'NOTHING_TO_PUSH' });
    pullMock.mockResolvedValueOnce({ outcome: 'SESSION_CHANGED' });
    expect(await runSyncCycle(deps())).toBe('STOPPED');
    expect(onSessionInvalid).not.toHaveBeenCalled();
  });

  it('verrou entre onglets : un cycle à la fois sur l’appareil ; sous le verrou, tout envoi interrompu repart', async () => {
    const request = vi.fn((_name: string, task: () => Promise<unknown>) => task());
    vi.stubGlobal('navigator', { ...navigator, locks: { request } });
    try {
      const recent = await syncingCommand(clock.now().toISOString());
      pushMock.mockResolvedValueOnce({ outcome: 'NOTHING_TO_PUSH' });
      pullMock.mockResolvedValueOnce({ outcome: 'SYNCED', changeCount: 0 });
      await runSyncCycle(deps());
      expect(request).toHaveBeenCalledWith('gic-sync', expect.any(Function));
      expect((await db.outbox.get(recent))?.status).toBe('PENDING_SYNC');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sans verrou entre onglets : seul un envoi plus ancien que le délai d’un lot repart', async () => {
    const inFlight = await syncingCommand(new Date(clock.now().getTime() - 30_000).toISOString());
    const stale = await syncingCommand(new Date(clock.now().getTime() - 120_000).toISOString());
    const unknown = await syncingCommand(null);
    pushMock.mockResolvedValueOnce({ outcome: 'NOTHING_TO_PUSH' });
    pullMock.mockResolvedValueOnce({ outcome: 'SYNCED', changeCount: 0 });
    await runSyncCycle(deps());
    expect((await db.outbox.get(inFlight))?.status).toBe('SYNCING');
    expect((await db.outbox.get(stale))?.status).toBe('PENDING_SYNC');
    expect((await db.outbox.get(unknown))?.status).toBe('PENDING_SYNC');
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

  it('push réussi mais pull hors ligne : OFFLINE, le serveur n’est plus joignable (ADR-037)', async () => {
    pushMock
      .mockResolvedValueOnce({ outcome: 'PUSHED', count: 1, settled: 1, stalled: [] })
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

    // Le cycle reprend d'abord les envois interrompus, puis envoie.
    await vi.waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
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
