import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixedClock, Uuidv7Generator } from '@gic/domain';
import type { PushResponse } from '@gic/contracts';
import { createTestDb, type GicDatabase } from '../storage/db.js';
import { enqueueCommand } from './outbox.js';
import { IN_PROGRESS_GRACE_MS, runPushCycle } from './push.js';
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
    expect(result).toEqual({ outcome: 'PUSHED', count: 1, settled: 1, stalled: [] });

    const updated = await db.outbox.get(command.command_id);
    expect(updated?.status).toBe('SYNCED');
    expect(updated?.server_refs).toEqual({ doc_number: 'BC-0001' });

    const meta = await db.syncMeta.get('device');
    expect(meta?.clock_skew_ms).toBe(1234);
  });

  it('APPLIED_WITH_WARNINGS : avertissements conservés ; indices locaux jamais envoyés', async () => {
    const command = await enqueueCommand(
      db,
      { clock, idGenerator },
      {
        authorUserId: 'user-1',
        commandType: 'procurement.receipt.record',
        commandVersion: 1,
        aggregateType: 'GOODS_RECEIPT',
        payload: { note: 'réception' },
        capturedOffline: true,
        localFlags: ['EXPECTED_QUARANTINE'],
      },
    );
    expect(command.local_flags).toEqual(['EXPECTED_QUARANTINE']);
    const response: PushResponse = {
      results: [
        {
          command_id: command.command_id,
          status: 'APPLIED_WITH_WARNINGS',
          warnings: ['RECEIPT_QUARANTINED'],
        },
      ],
      server_time: clock.now().toISOString(),
      clock_skew_ms: 0,
    };
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify(response), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    await runPushCycle(db, { clock, idGenerator, deviceId: DEVICE_ID });
    const sent = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as {
      commands: Record<string, unknown>[];
    };
    expect(sent.commands[0]).not.toHaveProperty('local_flags');
    expect(sent.commands[0]).not.toHaveProperty('warnings');
    const updated = await db.outbox.get(command.command_id);
    expect(updated).toMatchObject({
      status: 'SYNCED_WITH_WARNING',
      warnings: ['RECEIPT_QUARANTINED'],
      local_flags: ['EXPECTED_QUARANTINE'],
    });
  });

  it('déclare au serveur ce qui reste dans la file après le lot, par auteur (BR-DIS-014)', async () => {
    const command = await enqueueOne(db, 'un');
    const response: PushResponse = {
      results: [{ command_id: command.command_id, status: 'APPLIED' }],
      server_time: clock.now().toISOString(),
      clock_skew_ms: 0,
    };
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    await runPushCycle(db, { clock, idGenerator, deviceId: DEVICE_ID });
    const init = fetchSpy.mock.calls[0] as unknown as [string, { body: string }];
    const body = JSON.parse(init[1].body) as { pending_by_author?: Record<string, number> };
    expect(body.pending_by_author).toEqual({ 'user-1': 0 });
  });

  it('RETRY_LATER, statut hors protocole ou résultat manquant : la commande repart, rien de réglé', async () => {
    const retry = await enqueueOne(db, 'plus tard');
    const odd = await enqueueOne(db, 'statut inconnu');
    const missing = await enqueueOne(db, 'sans résultat');
    await db.outbox.update(odd.command_id, {
      last_error: { code: 'DEPENDENCY_PENDING', message_fr: 'Dépendance attendue.' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              results: [
                {
                  command_id: retry.command_id,
                  status: 'RETRY_LATER',
                  error: { code: 'DEPENDENCY_PENDING', message_fr: 'Dépendance attendue.' },
                },
                { command_id: odd.command_id, status: 'RECEIVED' },
              ],
              server_time: clock.now().toISOString(),
              clock_skew_ms: 0,
            }),
            { status: 200 },
          ),
      ),
    );

    const result = await runPushCycle(db, { clock, idGenerator, deviceId: DEVICE_ID });
    expect(result).toEqual({ outcome: 'PUSHED', count: 2, settled: 0, stalled: [] });
    for (const command of [retry, odd, missing]) {
      const updated = await db.outbox.get(command.command_id);
      expect(updated).toMatchObject({ status: 'PENDING_SYNC', attempts: 1 });
      expect(updated?.synced_at).toBeUndefined();
    }
    expect((await db.outbox.get(odd.command_id))?.last_error).toEqual({
      code: 'DEPENDENCY_PENDING',
      message_fr: 'Dépendance attendue.',
    });
    expect((await db.outbox.get(retry.command_id))?.last_error?.code).toBe('DEPENDENCY_PENDING');
  });

  it('échec répété : renvois SERVER_BUSY consécutifs seulement, sans les coupures réseau', async () => {
    const command = await enqueueOne(db, 'contrainte en base');
    const busy = () =>
      new Response(
        JSON.stringify({
          results: [
            {
              command_id: command.command_id,
              status: 'RETRY_LATER',
              error: { code: 'SERVER_BUSY', message_fr: 'Erreur transitoire, à réessayer.' },
            },
          ],
          server_time: clock.now().toISOString(),
          clock_skew_ms: 0,
        }),
        { status: 200 },
      );
    const now = new FixedClock(clock.now());
    const run = () => runPushCycle(db, { clock: now, idGenerator, deviceId: DEVICE_ID });
    // Deux coupures puis un SERVER_BUSY (hors du délai « en cours de traitement ») : un seul renvoi
    // compté.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network error');
      }),
    );
    await run();
    await run();
    now.advance(IN_PROGRESS_GRACE_MS);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => busy()),
    );
    await run();
    expect(await db.outbox.get(command.command_id)).toMatchObject({ attempts: 3, busy_retries: 1 });
    // Deux autres renvois consécutifs : échec répété (3).
    await run();
    await run();
    expect((await db.outbox.get(command.command_id))?.busy_retries).toBe(3);
    const answer = (code: string, message: string) =>
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                results: [
                  {
                    command_id: command.command_id,
                    status: 'RETRY_LATER',
                    error: { code, message_fr: message },
                  },
                ],
                server_time: clock.now().toISOString(),
                clock_skew_ms: 0,
              }),
              { status: 200 },
            ),
        ),
      );
    // Suspendue derrière une commande précédente (AV-210) : pas traitée, ni le compteur ni le motif
    // réel ne changent.
    answer(
      'PRECEDING_COMMAND_PENDING',
      'Une commande précédente de la file doit d’abord être renvoyée.',
    );
    await run();
    expect(await db.outbox.get(command.command_id)).toMatchObject({
      busy_retries: 3,
      last_error: { code: 'SERVER_BUSY' },
    });
    // Une attente de dépendance compte aussi (une dépendance qui ne vient pas finit signalée).
    answer('DEPENDENCY_PENDING', 'Dépendance attendue.');
    await run();
    expect((await db.outbox.get(command.command_id))?.busy_retries).toBe(4);
    // Tout autre motif remet le compteur à zéro.
    answer('AUTRE_MOTIF', 'À renvoyer.');
    await run();
    expect((await db.outbox.get(command.command_id))?.busy_retries).toBe(0);
  });

  it('SERVER_BUSY peu après un envoi sans réponse : commande en cours de traitement, pas un échec (S-45)', async () => {
    const command = await enqueueOne(db, 'lot coupé en plein traitement');
    const now = new FixedClock(clock.now());
    const run = () => runPushCycle(db, { clock: now, idGenerator, deviceId: DEVICE_ID });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network error');
      }),
    );
    await run();
    expect(await db.outbox.get(command.command_id)).toMatchObject({
      sent_at: now.now().toISOString(),
      unanswered_at: now.now().toISOString(),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              results: [
                {
                  command_id: command.command_id,
                  status: 'RETRY_LATER',
                  error: {
                    code: 'SERVER_BUSY',
                    message_fr: 'Commande en cours de traitement, à réessayer.',
                  },
                },
              ],
              server_time: now.now().toISOString(),
              clock_skew_ms: 0,
            }),
            { status: 200 },
          ),
      ),
    );
    // Renvois rapprochés pendant que le serveur la tient encore : rien n'est compté.
    for (const step of [30_000, 30_000, 30_000, IN_PROGRESS_GRACE_MS - 90_001]) {
      now.advance(step);
      await run();
    }
    expect((await db.outbox.get(command.command_id))?.busy_retries ?? 0).toBe(0);
    // Au-delà du délai : un vrai renvoi sans succès.
    now.advance(2);
    await run();
    expect((await db.outbox.get(command.command_id))?.busy_retries).toBe(1);
  });

  it('relève sur la tablette : le lot ne part pas avec le jeton du suivant, aucune commande refusée', async () => {
    const command = await enqueueOne(db, 'vente de user-1');
    // La session est désormais celle de user-2 (déconnexion de user-1, connexion de user-2).
    setSessionRuntime({
      userId: 'user-2',
      deviceId: DEVICE_ID,
      deviceStatus: 'ACTIVE',
      refreshToken: 'refresh-token-2',
      accessToken: 'access-token-2',
      accessTokenExpiresAt: Date.now() + 60_000,
      pinKey: {} as CryptoKey,
    });
    vi.stubGlobal('fetch', vi.fn());
    const result = await runPushCycle(db, {
      clock,
      idGenerator,
      deviceId: DEVICE_ID,
      userId: 'user-1',
    });
    expect(result).toEqual({ outcome: 'SESSION_CHANGED' });
    expect(fetch).not.toHaveBeenCalled();
    const after = await db.outbox.get(command.command_id);
    expect(after).toMatchObject({ status: 'PENDING_SYNC', attempts: 0, last_error: null });
    expect(after?.busy_retries ?? 0).toBe(0);
  });

  it('commande bloquée (COMMAND_STALLED) : aussitôt signalée en échec répété, rapportée au cycle', async () => {
    const command = await enqueueOne(db, 'bloquée');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              results: [
                {
                  command_id: command.command_id,
                  status: 'RETRY_LATER',
                  error: {
                    code: 'COMMAND_STALLED',
                    message_fr:
                      'Commande bloquée depuis plus de 30 min (DEPENDENCY_PENDING) : toujours à renvoyer, elle ne retient plus la suite de la file.',
                  },
                },
              ],
              server_time: clock.now().toISOString(),
              clock_skew_ms: 0,
            }),
            { status: 200 },
          ),
      ),
    );
    const result = await runPushCycle(db, { clock, idGenerator, deviceId: DEVICE_ID });
    expect(result).toEqual({
      outcome: 'PUSHED',
      count: 1,
      settled: 0,
      stalled: [command.command_id],
    });
    expect(await db.outbox.get(command.command_id)).toMatchObject({
      status: 'PENDING_SYNC',
      busy_retries: 3,
      last_error: { code: 'COMMAND_STALLED' },
    });
    // Écartée du lot suivant du même cycle.
    expect(
      await runPushCycle(
        db,
        { clock, idGenerator, deviceId: DEVICE_ID },
        { skip: new Set([command.command_id]) },
      ),
    ).toEqual({ outcome: 'NOTHING_TO_PUSH' });
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

  it('erreur HTTP du contrôleur (ex. 400) : SERVER_ERROR (serveur joignable), pas de déconnexion forcée', async () => {
    const command = await enqueueOne(db, 'malformée');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'VALIDATION_ERROR' } }), { status: 400 }),
      ),
    );

    const result = await runPushCycle(db, { clock, idGenerator, deviceId: DEVICE_ID });
    expect(result).toEqual({ outcome: 'SERVER_ERROR' });
    expect((await db.outbox.get(command.command_id))?.status).toBe('PENDING_SYNC');
  });

  it('passerelle sans serveur (503) : OFFLINE', async () => {
    await enqueueOne(db, 'passerelle');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 503 })),
    );
    const result = await runPushCycle(db, { clock, idGenerator, deviceId: DEVICE_ID });
    expect(result).toEqual({ outcome: 'OFFLINE' });
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
