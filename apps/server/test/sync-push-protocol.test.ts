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
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  let services: { push: SyncPushService; pull: SyncPullService };
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    const registry = new CommandHandlerRegistry();
    registerSettingCommands(registry);
    const pipeline = new CommandPipelineService(db, registry, clock, new Uuidv7Generator(clock));
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
      .select(['status', 'error_code', 'applied_at'])
      .where('command_id', '=', toBin(commandId))
      .executeTakeFirst();

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
});
