/**
 * Protocole d'envoi (P5-21) : date future jugée après correction de l'écart d'horloge mesuré
 * (INV-GLO-02, BR-SYN-011, ADR-016 : `occurred_at` gardé tel quel), et ordre d'un lot après une
 * commande à renvoyer.
 *
 * Ordre d'un lot après une commande à renvoyer (AV-210 ; INV-SYN-04, BR-SYN-004) : dès qu'une
 * commande d'un lot reçoit `RETRY_LATER`, les suivantes du même lot (un seul auteur) ne sont ni traitées
 * ni enregistrées (`PRECEDING_COMMAND_PENDING`) ; l'appareil les renvoie dans l'ordre. Une dépendance
 * reçue mais pas encore réglée (`RECEIVED`, `FAILED_RETRYABLE`) fait attendre la dépendante.
 *
 * Défaut révélé par AT-004 (`p5-pdv-three-tablets.test.ts`, trois tablettes qui synchronisent en même
 * temps) : une vente renvoyée pour cause d'interblocage passait après la libération du quota qu'elle
 * précédait, et retombait sur le stock commun avec une fausse alerte de dépassement.
 *
 * Revue adverse de P5-21 : réclamation par tentative (un renvoi simultané d'une commande reprise ne la
 * traite jamais deux fois ; l'abandon se mesure depuis la dernière réclamation, `claimed_at`) ; commande
 * bloquée au-delà de `sync.retry_hold_minutes` (AV-217 : elle ne retient plus la suite du lot et elle
 * est signalée) ; délai du lot (§3.1) ; restes de l'appareil comptés avec ce qui n'est pas réglé
 * (BR-DIS-014) ; correction de l'écart d'horloge réservée à une horloge en avance.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { z } from 'zod';
import { FixedClock, Uuidv7Generator } from '@gic/domain';
import { rawCommandEnvelopeSchema, type RawCommandEnvelope } from '@gic/contracts';
import { canonicalJsonStringify } from '../src/platform/canonical-json.js';
import { sha256Hex } from '../src/platform/hash.js';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { SyncPushService } from '../src/sync/sync-push.service.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import { registerSettingCommands } from '../src/modules/organization/application/commands/setting-commands.js';
import { jsonValue } from '../src/platform/kysely/json-value.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { DEVICE_DATASET, authorDataset } from '../src/sync/sync-push.service.js';
import { OfflineDevice, type CommandSpec } from './device-harness.js';
import { SETTING_PERMISSION } from './sync-harness.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestRole,
  insertTestUser,
} from './helpers.js';

const DAY = '2026-10-08';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

describe('protocole d’envoi : date future et ordre d’un lot (P5-21)', () => {
  const clock = new FixedClock(new Date(at('13:00')));
  let pipeline: CommandPipelineService;
  let services: { push: SyncPushService; pull: SyncPullService };
  let userA: string;
  let userB: string;
  /** Appels du gestionnaire-sonde, par étiquette : une commande appliquée deux fois s'y verrait. */
  const probeCalls = new Map<string, number>();

  beforeAll(async () => {
    const registry = new CommandHandlerRegistry();
    registerSettingCommands(registry);
    // Sonde lente (droit des paramètres) : compte ses appels, attend, n'écrit rien de métier.
    registry.register({
      commandType: 'organization.probe.run',
      version: 1,
      payloadSchema: z.object({ label: z.string(), delayMs: z.number().int().nonnegative() }),
      permissionCode: SETTING_PERMISSION,
      handler: async (_uow, envelope) => {
        const { label, delayMs } = envelope.payload;
        probeCalls.set(label, (probeCalls.get(label) ?? 0) + 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return { status: 'APPLIED' };
      },
    });
    pipeline = new CommandPipelineService(db, registry, clock, new Uuidv7Generator(clock));
    services = { push: new SyncPushService(pipeline, db, clock), pull: new SyncPullService(db) };
    await db.transaction().execute(async (trx) => {
      const admin = await insertTestUser(trx);
      const role = await insertTestRole(trx, admin);
      await grantTestPermission(trx, role, SETTING_PERMISSION, admin);
      userA = await insertTestUser(trx);
      userB = await insertTestUser(trx);
      await assignTestRole(trx, userA, role, admin);
      await assignTestRole(trx, userB, role, admin);
    });
  });

  afterAll(closeTestDb);

  const tablet = async (owner: string) =>
    new OfflineDevice(
      services,
      await db.transaction().execute((trx) => insertTestDevice(trx, owner, { status: 'ACTIVE' })),
      clock,
    );
  const setting = (key: string, dependsOn: readonly string[] = []): CommandSpec => ({
    type: 'organization.setting.set',
    aggregateType: 'SETTING',
    occurredAt: at('09:00'),
    payload: { key, value: true, scopeType: 'GLOBAL', isClientVisible: false },
    dependsOn,
  });
  const key = (label: string) => `p521.${label}.${freshUuid()}`;
  /** Empreinte que le pipeline calcule pour une enveloppe (rejeu à l'identique). */
  const payloadHashOf = async (envelope: RawCommandEnvelope) =>
    sha256Hex(canonicalJsonStringify(rawCommandEnvelopeSchema.parse(envelope)));
  const inboxOf = (commandId: string) =>
    db
      .selectFrom('sync_command_inbox')
      .select(['status', 'error_code', 'applied_at', 'attempts'])
      .where('command_id', '=', toBin(commandId))
      .executeTakeFirst();
  const probe = (label: string, delayMs = 0): CommandSpec => ({
    type: 'organization.probe.run',
    aggregateType: 'PROBE',
    occurredAt: at('09:00'),
    payload: { label, delayMs },
  });
  /** Ligne d'inbox posée comme si une requête antérieure l'avait reçue (`received_at`, `claimed_at` relatifs à NOW). */
  async function seedInbox(
    device: OfflineDevice,
    envelope: RawCommandEnvelope,
    row: {
      readonly status: 'RECEIVED' | 'FAILED_RETRYABLE';
      readonly errorCode?: string;
      readonly receivedMinutesAgo: number;
      readonly claimedMinutesAgo?: number;
    },
  ): Promise<void> {
    await db
      .insertInto('sync_command_inbox')
      .values({
        command_id: toBin(envelope.command_id),
        device_id: toBin(device.deviceId),
        user_id: toBin(envelope.author_user_id),
        device_seq: envelope.device_seq,
        transport: 'SYNC_PUSH',
        command_type: envelope.command_type,
        aggregate_type: envelope.aggregate_type,
        aggregate_id: toBin(envelope.aggregate_id),
        depends_on: jsonValue(envelope.depends_on),
        payload: jsonValue(envelope.payload),
        payload_hash: await payloadHashOf(envelope),
        occurred_at: new Date(envelope.occurred_at),
        status: row.status,
        error_code: row.errorCode ?? null,
        received_at: sql<Date>`NOW(6) - INTERVAL ${row.receivedMinutesAgo * 60} SECOND`,
        claimed_at:
          row.claimedMinutesAgo === undefined
            ? null
            : sql<Date>`NOW(6) - INTERVAL ${row.claimedMinutesAgo * 60} SECOND`,
      })
      .execute();
  }
  const stalledSignals = (commandId: string) =>
    db
      .selectFrom('sync_sync_conflicts')
      .select(['status', 'resolution', 'owner_role', 'applied'])
      .where('conflict_type', '=', 'SYNC_COMMAND_STALLED')
      .where('entity_id', '=', toBin(commandId))
      .execute();

  it('tablette en avance de deux heures : la date future se juge après correction de l’écart (INV-GLO-02)', async () => {
    const a = await tablet(userA);
    a.setClockOffset(2 * 3_600_000);
    const deviceTime = (minutesBefore: number) =>
      new Date(a.deviceNow().getTime() - minutesBefore * 60_000).toISOString();
    // Saisie à 14:59 heure de la tablette (12:59 vraie), envoyée à 15:00 heure de la tablette.
    const justNow = a.enqueue(userA, { ...setting(key('avance')), occurredAt: deviceTime(1) });
    // Datée une heure après l'heure d'envoi de la tablette : vraiment future, refusée.
    const future = a.enqueue(userA, {
      ...setting(key('futur')),
      occurredAt: new Date(a.deviceNow().getTime() + 3_600_000).toISOString(),
    });
    const results = await a.sync(userA);
    const accepted = results.find((r) => r.command_id === justNow.command_id);
    expect(accepted).toMatchObject({ status: 'APPLIED', warnings: ['CLOCK_SUSPECT'] });
    expect(results.find((r) => r.command_id === future.command_id)).toMatchObject({
      status: 'REJECTED',
      error: { code: 'OCCURRED_AT_FUTURE' },
    });
    // Aucune correction silencieuse : la date de la tablette est gardée, l'écart enregistré.
    const row = await db
      .selectFrom('sync_command_inbox')
      .select(['occurred_at', 'clock_skew_ms'])
      .where('command_id', '=', toBin(justNow.command_id))
      .executeTakeFirstOrThrow();
    expect(row.occurred_at.toISOString()).toBe(justNow.occurred_at);
    expect(Number(row.clock_skew_ms)).toBe(-2 * 3_600_000);
  });

  it('une dépendance pas encore reçue suspend la suite du lot ; renvoyée, la file s’applique dans l’ordre', async () => {
    const a = await tablet(userA);
    const b = await tablet(userB);
    const awaited = b.enqueue(userB, setting(key('dependance')));
    const first = a.enqueue(userA, setting(key('premiere')));
    const dependent = a.enqueue(userA, setting(key('dependante'), [awaited.command_id]));
    const after = a.enqueue(userA, setting(key('suivante')));

    const results = await a.sync(userA);
    expect(results.map((r) => [r.status, 'error' in r ? r.error?.code : undefined])).toEqual([
      ['APPLIED', undefined],
      ['RETRY_LATER', 'DEPENDENCY_PENDING'],
      ['RETRY_LATER', 'PRECEDING_COMMAND_PENDING'],
    ]);
    // La suivante n'a pas été reçue : rien dans l'inbox, aucun effet ; la dépendante est reprenable.
    expect(await inboxOf(after.command_id)).toBeUndefined();
    expect(await inboxOf(dependent.command_id)).toMatchObject({
      status: 'FAILED_RETRYABLE',
      error_code: 'DEPENDENCY_PENDING',
    });
    expect(a.pending(userA)).toBe(2);

    await b.sync(userB);
    const resent = await a.syncUntilSettled(userA);
    expect(resent.map((r) => r.status)).toEqual(['APPLIED', 'APPLIED']);
    const dependentRow = await inboxOf(dependent.command_id);
    const afterRow = await inboxOf(after.command_id);
    expect(dependentRow?.status).toBe('APPLIED');
    expect(afterRow?.status).toBe('APPLIED');
    expect(afterRow!.applied_at!.getTime()).toBeGreaterThanOrEqual(
      dependentRow!.applied_at!.getTime(),
    );
    expect((await inboxOf(first.command_id))?.status).toBe('APPLIED');
  });

  it('le renvoi d’une enveloppe encore en cours de traitement répond « réessayer », jamais `RECEIVED`', async () => {
    const a = await tablet(userA);
    const envelope = a.enqueue(userA, setting(key('en-cours')));
    // L'enveloppe est enregistrée (RECEIVED) par une autre requête qui ne l'a pas encore conclue.
    await db
      .insertInto('sync_command_inbox')
      .values({
        command_id: toBin(envelope.command_id),
        device_id: toBin(a.deviceId),
        user_id: toBin(userA),
        device_seq: envelope.device_seq,
        transport: 'SYNC_PUSH',
        command_type: envelope.command_type,
        payload: jsonValue(envelope.payload),
        payload_hash: await payloadHashOf(envelope),
        occurred_at: new Date(envelope.occurred_at),
        status: 'RECEIVED',
      })
      .execute();
    const [result] = await a.sync(userA);
    expect(result).toMatchObject({ status: 'RETRY_LATER', error: { code: 'SERVER_BUSY' } });
    expect((await inboxOf(envelope.command_id))?.status).toBe('RECEIVED');
  });

  it.each(['RECEIVED', 'FAILED_RETRYABLE'] as const)(
    'une dépendance reçue mais non réglée (%s) fait attendre la dépendante',
    async (status) => {
      const a = await tablet(userA);
      const ghostDevice = await db
        .transaction()
        .execute((trx) => insertTestDevice(trx, userB, { status: 'ACTIVE' }));
      const ghost = freshUuid();
      await db
        .insertInto('sync_command_inbox')
        .values({
          command_id: toBin(ghost),
          device_id: toBin(ghostDevice),
          user_id: toBin(userB),
          device_seq: 1,
          transport: 'SYNC_PUSH',
          command_type: 'organization.setting.set',
          payload: jsonValue({}),
          payload_hash: '0'.repeat(64),
          occurred_at: new Date(at('08:00')),
          status,
        })
        .execute();
      const dependent = a.enqueue(userA, setting(key(`attente-${status}`), [ghost]));
      const [result] = await a.sync(userA);
      expect(result).toMatchObject({
        status: 'RETRY_LATER',
        error: { code: 'DEPENDENCY_PENDING' },
      });
      // Pas encore traitée, sans effet ; reprenable au renvoi identique.
      expect(await inboxOf(dependent.command_id)).toMatchObject({
        status: 'FAILED_RETRYABLE',
        error_code: 'DEPENDENCY_PENDING',
        applied_at: null,
      });
    },
  );

  it('renvoi d’une commande reprise pendant que son premier traitement tourne encore (reçue il y a une heure) : un seul la traite (réclamation par tentative)', async () => {
    const a = await tablet(userA);
    const label = `simultane-${freshUuid()}`;
    const envelope = a.enqueue(userA, probe(label, 600));
    // Échec transitoire antérieur : première réception il y a une heure (bien au-delà de 120 s).
    await seedInbox(a, envelope, {
      status: 'FAILED_RETRYABLE',
      errorCode: 'SERVER_BUSY',
      receivedMinutesAgo: 60,
    });
    const ctx = {
      authenticatedUserId: userA,
      authenticatedDeviceId: a.deviceId,
      transport: 'SYNC_PUSH' as const,
    };
    // Le premier renvoi réclame la ligne et entre dans le gestionnaire ; le second arrive pendant ce temps.
    const firstCall = pipeline.handle(envelope, ctx);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const second = await pipeline.handle(envelope, ctx);
    const first = await firstCall;
    expect(first.status).toBe('APPLIED');
    expect(second).toMatchObject({ status: 'RETRY_LATER', error: { code: 'SERVER_BUSY' } });
    expect(probeCalls.get(label)).toBe(1);
    expect(await inboxOf(envelope.command_id)).toMatchObject({ status: 'APPLIED', attempts: 2 });
    // Deux renvois exactement simultanés : la comparaison-échange n'en laisse passer aucun en double.
    const both = await Promise.all([
      pipeline.handle(envelope, ctx),
      pipeline.handle(envelope, ctx),
    ]);
    expect(both.map((r) => r.status)).toEqual(['APPLIED', 'APPLIED']);
    expect(probeCalls.get(label)).toBe(1);
  });

  it('l’abandon se mesure depuis la dernière réclamation : reçue il y a une heure, réclamée à l’instant → « réessayer » ; réclamée il y a dix minutes → reprise', async () => {
    const a = await tablet(userA);
    const ctx = {
      authenticatedUserId: userA,
      authenticatedDeviceId: a.deviceId,
      transport: 'SYNC_PUSH' as const,
    };
    const busyLabel = `en-cours-${freshUuid()}`;
    const busy = a.enqueue(userA, probe(busyLabel));
    await seedInbox(a, busy, { status: 'RECEIVED', receivedMinutesAgo: 60, claimedMinutesAgo: 0 });
    expect(await pipeline.handle(busy, ctx)).toMatchObject({
      status: 'RETRY_LATER',
      error: { code: 'SERVER_BUSY' },
    });
    expect(probeCalls.get(busyLabel)).toBeUndefined();
    expect(await inboxOf(busy.command_id)).toMatchObject({ status: 'RECEIVED', attempts: 1 });

    const lostLabel = `abandonnee-${freshUuid()}`;
    const lost = a.enqueue(userA, probe(lostLabel));
    await seedInbox(a, lost, { status: 'RECEIVED', receivedMinutesAgo: 60, claimedMinutesAgo: 10 });
    expect((await pipeline.handle(lost, ctx)).status).toBe('APPLIED');
    expect(probeCalls.get(lostLabel)).toBe(1);
    expect(await inboxOf(lost.command_id)).toMatchObject({ status: 'APPLIED', attempts: 2 });
  });

  it('commande bloquée au-delà de sync.retry_hold_minutes (AV-217) : toujours à renvoyer, elle ne retient plus la suite, signalée une fois, signal fermé quand elle se règle', async () => {
    const a = await tablet(userA);
    const b = await tablet(userB);
    const awaited = b.enqueue(userB, setting(key('dependance-bloquee')));
    const stuck = a.enqueue(userA, setting(key('bloquee'), [awaited.command_id]));
    const next = a.enqueue(userA, setting(key('apres-bloquee')));
    // Première réception il y a deux heures (défaut du paramètre : 30 min).
    await seedInbox(a, stuck, {
      status: 'FAILED_RETRYABLE',
      errorCode: 'DEPENDENCY_PENDING',
      receivedMinutesAgo: 120,
    });

    const first = await a.sync(userA);
    expect(
      first.map((r) => [r.command_id, r.status, 'error' in r ? r.error?.code : undefined]),
    ).toEqual([
      [stuck.command_id, 'RETRY_LATER', 'COMMAND_STALLED'],
      [next.command_id, 'APPLIED', undefined],
    ]);
    expect(await inboxOf(stuck.command_id)).toMatchObject({
      status: 'FAILED_RETRYABLE',
      error_code: 'COMMAND_STALLED',
    });
    await a.sync(userA);
    expect(await stalledSignals(stuck.command_id)).toEqual([
      { status: 'OPEN', resolution: null, owner_role: 'ADMIN', applied: 0 },
    ]);

    // La dépendance arrive : la commande bloquée s'applique au renvoi, le signal se ferme.
    await b.sync(userB);
    const settled = await a.syncUntilSettled(userA);
    expect(settled.at(-1)).toMatchObject({ command_id: stuck.command_id, status: 'APPLIED' });
    expect(await stalledSignals(stuck.command_id)).toEqual([
      { status: 'RESOLVED', resolution: 'ACCEPT_CLIENT', owner_role: 'ADMIN', applied: 0 },
    ]);
  });

  it('délai du lot dépassé (§3.1) : la suite n’est ni traitée ni enregistrée, renvoyée dans l’ordre', async () => {
    const quick = new SyncPushService(pipeline, db, clock, { batchDeadlineMs: 100 });
    const a = new OfflineDevice(
      { push: quick, pull: services.pull },
      await db.transaction().execute((trx) => insertTestDevice(trx, userA, { status: 'ACTIVE' })),
      clock,
    );
    const slow = a.enqueue(userA, probe(`lent-${freshUuid()}`, 300));
    const late = a.enqueue(userA, probe(`tardif-${freshUuid()}`));
    const results = await a.sync(userA);
    expect(results.map((r) => [r.status, 'error' in r ? r.error?.code : undefined])).toEqual([
      ['APPLIED', undefined],
      ['RETRY_LATER', 'SERVER_BUSY'],
    ]);
    expect(await inboxOf(slow.command_id)).toMatchObject({ status: 'APPLIED' });
    expect(await inboxOf(late.command_id)).toBeUndefined();
  });

  it('BR-DIS-014 : ce que le lot n’a pas réglé compte dans les restes de l’appareil et de l’auteur', async () => {
    const a = await tablet(userA);
    const ghost = freshUuid();
    a.enqueue(userA, setting(key('reste-premiere')));
    a.enqueue(userA, setting(key('reste-attente'), [ghost]));
    a.enqueue(userA, setting(key('reste-suivante')));
    // Tout tient dans le lot : l'appareil déclare 0 restant.
    await a.sync(userA);
    const rows = await db
      .selectFrom('sync_device_sync_state')
      .select(['dataset', 'pending_reported'])
      .where('device_id', '=', toBin(a.deviceId))
      .execute();
    const pending = Object.fromEntries(rows.map((row) => [row.dataset, row.pending_reported]));
    expect(pending[DEVICE_DATASET]).toBe(2);
    expect(pending[authorDataset(userA)]).toBe(2);
  });

  it('horloge en retard à l’envoi : un fait saisi à l’heure juste, juste avant, n’est jamais jugé futur (correction à sens unique)', async () => {
    const a = await tablet(userA);
    // La tablette a saisi à 12:50 (heure juste), puis son horloge a reculé de deux heures avant l'envoi.
    const exact = a.enqueue(userA, { ...setting(key('recul')), occurredAt: at('12:50') });
    a.setClockOffset(-2 * 3_600_000);
    const [result] = await a.sync(userA);
    expect(result).toMatchObject({
      command_id: exact.command_id,
      status: 'APPLIED',
      warnings: ['CLOCK_SUSPECT'],
    });
  });
});
