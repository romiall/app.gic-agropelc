import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixedClock, Uuidv7Generator } from '@gic/domain';
import { createTestDb, type GicDatabase } from '../storage/db.js';
import { DEFAULT_SYNC_TIMING, nextCycleDelayMs, runSyncCycle, SyncEngine } from './engine.js';
import type { PushCycleResult } from './push.js';
import type { PullCycleResult } from './pull.js';
import type { UploadCycleResult } from './attachment-upload.js';

const { pushMock, pullMock, uploadMock } = vi.hoisted(() => ({
  pushMock: vi.fn<() => Promise<PushCycleResult>>(),
  pullMock: vi.fn<() => Promise<PullCycleResult>>(),
  uploadMock: vi.fn<() => Promise<UploadCycleResult>>(),
}));

vi.mock('./push.js', () => ({ runPushCycle: pushMock, PUSH_TIMEOUT_MS: 60_000 }));
vi.mock('./pull.js', () => ({ runPullCycle: pullMock }));
vi.mock('./attachment-upload.js', () => ({ runAttachmentUploadCycle: uploadMock }));

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
    uploadMock.mockReset();
    uploadMock.mockResolvedValue({ outcome: 'NOTHING_TO_UPLOAD', sent: 0 });
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

  it('MP-10 : photos envoyées après les commandes, avant le tirage ; une photo envoyée suffit à SYNCED', async () => {
    const order: string[] = [];
    pushMock.mockImplementation(async () => {
      order.push('push');
      return { outcome: 'NOTHING_TO_PUSH' };
    });
    uploadMock.mockImplementation(async () => {
      order.push('upload');
      return { outcome: 'UPLOADED', sent: 1 };
    });
    pullMock.mockImplementation(async () => {
      order.push('pull');
      return { outcome: 'SYNCED', changeCount: 0 };
    });
    expect(await runSyncCycle({ ...deps(), userId: 'user-1' })).toBe('SYNCED');
    expect(order).toEqual(['push', 'upload', 'pull']);
    expect(uploadMock).toHaveBeenCalledWith(db, expect.objectContaining({ userId: 'user-1' }));
  });

  it('MP-10 : réseau coupé pendant une photo — le tirage a lieu quand même ; session invalide ou changée : pas de tirage', async () => {
    pushMock.mockResolvedValue({ outcome: 'NOTHING_TO_PUSH' });
    // Revue de MP-10 : une photo bloquée ne prive pas l'appareil de ses données.
    uploadMock.mockResolvedValueOnce({ outcome: 'INTERRUPTED', sent: 0 });
    pullMock.mockResolvedValueOnce({ outcome: 'SYNCED', changeCount: 2 });
    expect(await runSyncCycle(deps())).toBe('SYNCED');
    expect(pullMock).toHaveBeenCalledTimes(1);
    pullMock.mockClear();
    uploadMock.mockResolvedValueOnce({ outcome: 'SESSION_INVALID', sent: 0 });
    expect(await runSyncCycle(deps())).toBe('SESSION_INVALID');
    expect(onSessionInvalid).toHaveBeenCalledTimes(1);
    uploadMock.mockResolvedValueOnce({ outcome: 'SESSION_CHANGED', sent: 0 });
    expect(await runSyncCycle(deps())).toBe('STOPPED');
    expect(pullMock).not.toHaveBeenCalled();
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

describe('sync/engine (cadence, MP-12 / AV-319)', () => {
  let db: GicDatabase;
  const timing = { intervalMs: 1_000, maxBackoffMs: 8_000, visibleResyncMs: 15_000 };
  /** Moteurs démarrés par un test : arrêtés à la fin (minuteries et écouteurs). */
  const started: SyncEngine[] = [];
  /** Cycles menés à leur terme par les moteurs du test (un cycle en vol d'un test précédent ne compte pas). */
  let cycles = 0;
  let outcomes: string[] = [];

  function engineOf(overrides: Partial<typeof timing> = {}): SyncEngine {
    return new SyncEngine(
      {
        db,
        clock,
        idGenerator,
        deviceId: 'device-1',
        onSessionInvalid: vi.fn(),
        onCycleComplete: (outcome) => {
          cycles += 1;
          outcomes.push(outcome);
        },
      },
      { ...timing, ...overrides },
    );
  }

  /** Passe l'onglet à `state` et prévient comme le navigateur (événement `visibilitychange`). */
  function setVisibility(state: 'visible' | 'hidden', dispatch = true): void {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    if (dispatch) document.dispatchEvent(new Event('visibilitychange'));
  }

  beforeEach(() => {
    db = createTestDb(`test-engine-cadence-${Math.random()}`);
    cycles = 0;
    outcomes = [];
    pushMock.mockReset();
    pullMock.mockReset();
    uploadMock.mockReset();
    uploadMock.mockResolvedValue({ outcome: 'NOTHING_TO_UPLOAD', sent: 0 });
    pushMock.mockResolvedValue({ outcome: 'NOTHING_TO_PUSH' });
    pullMock.mockResolvedValue({ outcome: 'SYNCED', changeCount: 0 });
  });

  afterEach(async () => {
    for (const engine of started.splice(0)) engine.stop();
    vi.restoreAllMocks();
    // L'accesseur posé par le test retombe sur celui du document.
    delete (document as unknown as Record<string, unknown>).visibilityState;
    await db.delete();
  });

  it('attente entre deux cycles : 30 s, doublées à chaque échec, plafonnées à 2 min', () => {
    const delays = [0, 1, 2, 3, 4, 5, 50].map((streak) => nextCycleDelayMs(streak));
    expect(delays).toEqual([30_000, 60_000, 120_000, 120_000, 120_000, 120_000, 120_000]);
    expect(DEFAULT_SYNC_TIMING).toEqual({
      intervalMs: 30_000,
      maxBackoffMs: 120_000,
      visibleResyncMs: 15_000,
    });
    // Une série négative ou fractionnaire ne fait jamais descendre sous l'intervalle.
    expect(nextCycleDelayMs(-3)).toBe(30_000);
    expect(nextCycleDelayMs(1.9)).toBe(60_000);
    expect(nextCycleDelayMs(2, { intervalMs: 10, maxBackoffMs: 25, visibleResyncMs: 0 })).toBe(25);
    // L'exposant est borné : un intervalle nul avec des milliers d'échecs ne donne pas NaN.
    expect(nextCycleDelayMs(5_000, { intervalMs: 0, maxBackoffMs: 25, visibleResyncMs: 0 })).toBe(
      0,
    );
  });

  it('hors ligne ou erreur du serveur : l’attente double ; un cycle réussi la ramène à l’intervalle', async () => {
    const engine = engineOf();
    expect(engine.nextDelayMs).toBe(1_000);

    pushMock.mockResolvedValue({ outcome: 'OFFLINE' });
    await engine.trigger();
    expect(engine.nextDelayMs).toBe(2_000);
    await engine.trigger();
    expect(engine.nextDelayMs).toBe(4_000);

    pushMock.mockResolvedValue({ outcome: 'SERVER_ERROR' });
    await engine.trigger();
    expect(engine.nextDelayMs).toBe(8_000);
    await engine.trigger();
    expect(engine.nextDelayMs).toBe(8_000); // plafond

    pushMock.mockResolvedValue({ outcome: 'NOTHING_TO_PUSH' });
    await engine.trigger();
    expect(engine.nextDelayMs).toBe(1_000);
  });

  it('session invalide : l’attente ne change pas', async () => {
    const engine = engineOf();
    pushMock.mockResolvedValue({ outcome: 'OFFLINE' });
    await engine.trigger();
    expect(engine.nextDelayMs).toBe(2_000);

    pushMock.mockResolvedValue({ outcome: 'SESSION_INVALID' });
    await engine.trigger();
    expect(engine.nextDelayMs).toBe(2_000);
  });

  it('un cycle qui lève (réponse inattendue, base locale fermée) : issue SERVER_ERROR, attente allongée, aucun rejet', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    pullMock.mockRejectedValue(new Error('base locale fermée'));
    const engine = engineOf();
    await expect(engine.trigger()).resolves.toBe('SERVER_ERROR');
    expect(engine.nextDelayMs).toBe(2_000);
    expect(outcomes).toEqual(['SERVER_ERROR']);
    expect(logged).toHaveBeenCalled();
  });

  it('un cycle qui lève ne tue pas la boucle périodique', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setVisibility('visible', false);
    pullMock.mockRejectedValue(new Error('réponse sans corps'));
    const engine = engineOf({ intervalMs: 10, maxBackoffMs: 40 });
    started.push(engine);
    engine.start();
    await vi.waitFor(() => expect(cycles).toBeGreaterThanOrEqual(3));
  });

  describe('minuterie réellement armée', () => {
    // Durées peu courantes : elles se distinguent des autres minuteries du navigateur de test.
    const armed = { intervalMs: 7_000, maxBackoffMs: 56_000, visibleResyncMs: 15_000 };
    const ours = [7_000, 14_000, 28_000, 56_000];
    function lastArmedDelay(spy: {
      mock: { calls: readonly (readonly unknown[])[] };
    }): number | undefined {
      const delays = spy.mock.calls
        .map((call) => call[1])
        .filter((delay): delay is number => typeof delay === 'number' && ours.includes(delay));
      return delays.at(-1);
    }

    it('au démarrage, l’intervalle ; après un cycle en échec, l’attente doublée', async () => {
      const setTimer = vi.spyOn(globalThis, 'setTimeout');
      pushMock.mockResolvedValue({ outcome: 'OFFLINE' });
      const engine = engineOf(armed);
      started.push(engine);
      engine.start();
      expect(lastArmedDelay(setTimer)).toBe(7_000);
      await vi.waitFor(() => expect(cycles).toBe(1));
      expect(lastArmedDelay(setTimer)).toBe(14_000);
    });

    it('retour du réseau : la minuterie déjà armée est remplacée, et l’attente repart de l’intervalle', async () => {
      const setTimer = vi.spyOn(globalThis, 'setTimeout');
      const clearTimer = vi.spyOn(globalThis, 'clearTimeout');
      pushMock.mockResolvedValue({ outcome: 'OFFLINE' });
      const engine = engineOf(armed);
      started.push(engine);
      engine.start();
      await vi.waitFor(() => expect(cycles).toBe(1));
      window.dispatchEvent(new Event('online'));
      await vi.waitFor(() => expect(cycles).toBe(2));
      // Un seul échec depuis le retour du réseau (14 s), pas deux (28 s).
      expect(lastArmedDelay(setTimer)).toBe(14_000);
      expect(clearTimer).toHaveBeenCalled();

      pushMock.mockResolvedValue({ outcome: 'NOTHING_TO_PUSH' });
      window.dispatchEvent(new Event('online'));
      await vi.waitFor(() => expect(cycles).toBe(3));
      expect(lastArmedDelay(setTimer)).toBe(7_000);
    });

    it('retour au premier plan : l’attente accumulée est remise à l’intervalle aussitôt', async () => {
      const setTimer = vi.spyOn(globalThis, 'setTimeout');
      pushMock.mockResolvedValue({ outcome: 'OFFLINE' });
      const engine = engineOf({ ...armed, visibleResyncMs: 60_000 });
      started.push(engine);
      engine.start();
      await vi.waitFor(() => expect(cycles).toBe(1));
      await engine.trigger();
      expect(lastArmedDelay(setTimer)).toBe(28_000);

      setVisibility('hidden');
      setVisibility('visible'); // dernier cycle trop récent pour en relancer un
      expect(cycles).toBe(2);
      expect(engine.nextDelayMs).toBe(7_000);
      expect(lastArmedDelay(setTimer)).toBe(7_000);
    });

    it('un moteur non démarré (ou arrêté) n’arme aucune minuterie', async () => {
      const setTimer = vi.spyOn(globalThis, 'setTimeout');
      const notStarted = engineOf(armed);
      await notStarted.trigger();
      expect(lastArmedDelay(setTimer)).toBeUndefined();

      const stopped = engineOf(armed);
      stopped.start();
      stopped.stop();
      setTimer.mockClear();
      await stopped.trigger();
      expect(lastArmedDelay(setTimer)).toBeUndefined();
    });

    it('un cycle lancé par une saisie replanifie la minuterie sur l’état courant', async () => {
      const setTimer = vi.spyOn(globalThis, 'setTimeout');
      const engine = engineOf(armed);
      started.push(engine);
      engine.start();
      await vi.waitFor(() => expect(cycles).toBe(1));
      pushMock.mockResolvedValue({ outcome: 'SERVER_ERROR' });
      await engine.trigger(); // comme submitCommand
      expect(lastArmedDelay(setTimer)).toBe(14_000);
    });
  });

  it('onglet masqué : aucun cycle périodique ; le cycle de démarrage a lieu', async () => {
    setVisibility('hidden', false);
    const engine = engineOf({ intervalMs: 20, maxBackoffMs: 40 });
    started.push(engine);
    engine.start();
    await vi.waitFor(() => expect(cycles).toBe(1));
    // Plusieurs échéances périodiques passent : toutes sautées.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(cycles).toBe(1);

    // La chaîne de minuteries survit à l'onglet masqué : revenu au premier plan (sans événement), un
    // cycle périodique repart seul.
    setVisibility('visible', false);
    await vi.waitFor(() => expect(cycles).toBeGreaterThanOrEqual(2));
  });

  it('onglet visible : les cycles périodiques reprennent', async () => {
    setVisibility('visible', false);
    const engine = engineOf({ intervalMs: 20, maxBackoffMs: 40 });
    started.push(engine);
    engine.start();
    await vi.waitFor(() => expect(cycles).toBeGreaterThanOrEqual(3));
  });

  it('passage en arrière-plan : aucun cycle, l’attente accumulée est gardée', async () => {
    pushMock.mockResolvedValue({ outcome: 'OFFLINE' });
    const engine = engineOf({ intervalMs: 60_000, maxBackoffMs: 240_000, visibleResyncMs: 0 });
    started.push(engine);
    engine.start();
    await vi.waitFor(() => expect(cycles).toBe(1));
    expect(engine.nextDelayMs).toBe(120_000);

    setVisibility('hidden');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(cycles).toBe(1);
    expect(engine.nextDelayMs).toBe(120_000);
  });

  it('retour au premier plan : cycle aussitôt si le dernier est ancien, sinon rien', async () => {
    setVisibility('hidden', false);
    const engine = engineOf({ intervalMs: 60_000, maxBackoffMs: 120_000, visibleResyncMs: 300 });
    started.push(engine);
    engine.start();
    await vi.waitFor(() => expect(cycles).toBe(1));

    // Retour aussitôt après le dernier cycle : trop tôt, aucun cycle.
    setVisibility('visible');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cycles).toBe(1);

    // Plus tard que le délai : un cycle part.
    setVisibility('hidden');
    await new Promise((resolve) => setTimeout(resolve, 350));
    setVisibility('visible');
    await vi.waitFor(() => expect(cycles).toBe(2));
  });

  it('retour au premier plan pendant un cycle récent : aucun second cycle n’est mis en file', async () => {
    let resolvePush!: (value: PushCycleResult) => void;
    pushMock.mockImplementationOnce(
      () =>
        new Promise<PushCycleResult>((resolve) => {
          resolvePush = resolve;
        }),
    );
    const engine = engineOf({ intervalMs: 60_000, maxBackoffMs: 120_000, visibleResyncMs: 60_000 });
    started.push(engine);
    engine.start();
    await vi.waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));

    setVisibility('visible'); // l'onglet n'a jamais été masqué : le cycle est récent
    resolvePush({ outcome: 'NOTHING_TO_PUSH' });
    await vi.waitFor(() => expect(cycles).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(cycles).toBe(1);
  });

  it('retour au premier plan pendant un cycle commencé avant la mise en arrière-plan : un cycle neuf le suit', async () => {
    let resolvePush!: (value: PushCycleResult) => void;
    pushMock.mockImplementationOnce(
      () =>
        new Promise<PushCycleResult>((resolve) => {
          resolvePush = resolve;
        }),
    );
    const engine = engineOf({ intervalMs: 60_000, maxBackoffMs: 120_000, visibleResyncMs: 60_000 });
    started.push(engine);
    engine.start();
    await vi.waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));

    // Le téléphone se verrouille en plein cycle ; au réveil la connexion en vol est perdue.
    setVisibility('hidden');
    setVisibility('visible');
    resolvePush({ outcome: 'OFFLINE' });
    await vi.waitFor(() => expect(cycles).toBe(2));
    expect(outcomes).toEqual(['OFFLINE', 'NOTHING_TO_DO']);
  });

  it('arrêt : plus de minuterie ni d’écouteur', async () => {
    setVisibility('visible', false);
    const engine = engineOf({ intervalMs: 20, maxBackoffMs: 40, visibleResyncMs: 0 });
    engine.start();
    await vi.waitFor(() => expect(cycles).toBeGreaterThanOrEqual(2));
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout');
    const removeFromDocument = vi.spyOn(document, 'removeEventListener');
    const removeFromWindow = vi.spyOn(window, 'removeEventListener');
    engine.stop();
    expect(clearTimer).toHaveBeenCalled();
    expect(removeFromDocument).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(removeFromWindow).toHaveBeenCalledWith('online', expect.any(Function));
    clearTimer.mockRestore();
    removeFromDocument.mockRestore();
    removeFromWindow.mockRestore();
    await new Promise((resolve) => setTimeout(resolve, 30)); // un cycle en vol se termine
    const settled = pullMock.mock.calls.length;
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(pullMock.mock.calls.length).toBe(settled);
  });
});
