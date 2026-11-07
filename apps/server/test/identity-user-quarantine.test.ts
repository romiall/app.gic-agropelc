/**
 * Quarantaine d'un utilisateur suspendu puis réactivé (AV-229, BR-ADM-002, AT-034) à travers le vrai pipeline : un fait
 * daté pendant une période hors service **close** du compte (suspension puis réactivation, suspension puis désactivation,
 * désactivation puis réactivation) est mis en quarantaine (`CONFLICT USER_DEACTIVATED`) quel que soit le statut courant ;
 * un fait daté avant, ou après la fin de la période, est appliqué (BR-SYN-007).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerCountCommands } from '../src/modules/inventory/application/commands/count-commands.js';
import { registerUserCommands } from '../src/modules/identity/application/commands/user-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestLocation,
  insertTestPermission,
  insertTestRole,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const DAY = '2026-10-02';
const at = (hhmm: string, seconds = '00'): string => `${DAY}T${hhmm}:${seconds}.000Z`;
/** Horloge du serveur : après tous les faits du fichier. */
const NOW = new Date(at('18:00'));

describe('quarantaine d’un utilisateur réactivé (AV-229, BR-ADM-002, AT-034)', () => {
  let clock: Clock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let admin: string;
  let adminDevice: string;
  let siteId: string;

  beforeAll(async () => {
    clock = new FixedClock(NOW);
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    registerUserCommands(registry);
    registerCountCommands(
      registry,
      new ApprovalDecisionHandlerRegistry(),
      idGenerator,
      new DocumentSequenceService(),
    );
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    admin = await db.transaction().execute((trx) => insertTestUser(trx));
    adminDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, admin, { status: 'ACTIVE' }));
    await db.transaction().execute(async (trx) => {
      await insertTestPermission(trx, 'identity.user.manage');
      const zoneId = await insertTestZone(trx, admin);
      siteId = await insertTestSite(trx, admin, zoneId);
      const role = await insertTestRole(trx, admin);
      await grantTestPermission(trx, role, 'identity.user.manage', admin);
      await assignTestRole(trx, admin, role, admin);
      // INV-ADM-01 : suspendre ou désactiver un compte exige un autre ADMIN actif.
      const adminRole = await trx
        .selectFrom('identity_roles')
        .select('id')
        .where('code', '=', 'ADMIN')
        .executeTakeFirstOrThrow();
      await assignTestRole(trx, admin, fromBin(adminRole.id), admin);
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  /** Un utilisateur qui saisit des inventaires, avec son appareil. */
  async function newWorker(): Promise<{ readonly userId: string; readonly deviceId: string }> {
    const userId = await db.transaction().execute((trx) => insertTestUser(trx));
    const deviceId = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, userId, { status: 'ACTIVE' }));
    await db.transaction().execute(async (trx) => {
      const role = await insertTestRole(trx, admin);
      await grantTestPermission(trx, role, 'inventory.count.perform', admin);
      await assignTestRole(trx, userId, role, admin);
    });
    return { userId, deviceId };
  }

  async function transition(
    userId: string,
    type: 'suspend' | 'reactivate' | 'deactivate',
    occurredAt: string,
  ) {
    const result = await pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: 1,
        command_type: `identity.user.${type}`,
        command_version: 1,
        author_user_id: admin,
        aggregate_type: 'USER',
        aggregate_id: userId,
        base_version: null,
        depends_on: [],
        occurred_at: occurredAt,
        client_created_at: occurredAt,
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload: type === 'reactivate' ? {} : { reason: 'Essai' },
      },
      {
        authenticatedUserId: admin,
        authenticatedDeviceId: adminDevice,
        transport: 'ONLINE_API',
      },
    );
    expect(result.status, `${type} à ${occurredAt}`).toBe('APPLIED');
  }

  /** Un fait de l'utilisateur (ouverture d'un inventaire), daté de `occurredAt`, poussé maintenant. */
  async function fact(worker: { userId: string; deviceId: string }, occurredAt: string) {
    const locationId = await db
      .transaction()
      .execute((trx) => insertTestLocation(trx, admin, siteId, { locationType: 'STORE' }));
    const commandId = freshUuid();
    const result = await pipeline.handle(
      {
        command_id: commandId,
        device_seq: 1,
        command_type: 'inventory.count.open',
        command_version: 1,
        author_user_id: worker.userId,
        aggregate_type: 'INVENTORY_COUNT',
        aggregate_id: freshUuid(),
        base_version: null,
        depends_on: [],
        occurred_at: occurredAt,
        client_created_at: occurredAt,
        captured_offline: true,
        backdated_reason: null,
        attachment_ids: [],
        payload: { locationId, countType: 'FULL' },
      },
      {
        authenticatedUserId: worker.userId,
        authenticatedDeviceId: worker.deviceId,
        transport: 'ONLINE_API',
      },
    );
    return { result, commandId };
  }

  const codeOf = (result: Awaited<ReturnType<typeof fact>>['result']): string =>
    result.status === 'APPLIED' ? 'APPLIED' : `${result.status}:${result.error?.code}`;

  async function periodsOf(userId: string) {
    return db
      .selectFrom('identity_user_status_periods')
      .select(['status', 'valid_from', 'valid_to', 'reason'])
      .where('user_id', '=', toBin(userId))
      .orderBy('valid_from', 'asc')
      .execute();
  }

  it('suspendu puis réactivé : le fait daté pendant la suspension reste en quarantaine', async () => {
    const worker = await newWorker();
    await transition(worker.userId, 'suspend', at('10:00'));
    await transition(worker.userId, 'reactivate', at('11:00'));

    // Le compte est de nouveau actif : sans l'historique des périodes, tous ces faits passeraient.
    expect(codeOf((await fact(worker, at('09:30'))).result)).toBe('APPLIED'); // avant la suspension
    expect(codeOf((await fact(worker, at('11:30'))).result)).toBe('APPLIED'); // après la réactivation
    const during = await fact(worker, at('10:30'));
    expect(codeOf(during.result)).toBe('CONFLICT:USER_DEACTIVATED');
    const inbox = await db
      .selectFrom('sync_command_inbox')
      .select(['status', 'error_code'])
      .where('command_id', '=', toBin(during.commandId))
      .executeTakeFirstOrThrow();
    expect(inbox).toMatchObject({ status: 'CONFLICT', error_code: 'USER_DEACTIVATED' });

    const periods = await periodsOf(worker.userId);
    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({ status: 'SUSPENDED', reason: 'Essai' });
    expect(periods[0]!.valid_from.toISOString()).toBe(at('10:00'));
    expect(periods[0]!.valid_to.toISOString()).toBe(at('11:00'));
  });

  it('bornes de la période : l’ouverture est comprise, la fermeture ne l’est pas', async () => {
    const worker = await newWorker();
    await transition(worker.userId, 'suspend', at('10:00'));
    await transition(worker.userId, 'reactivate', at('11:00'));

    expect(codeOf((await fact(worker, at('09:59', '59'))).result)).toBe('APPLIED');
    expect(codeOf((await fact(worker, at('10:00'))).result)).toBe('CONFLICT:USER_DEACTIVATED');
    expect(codeOf((await fact(worker, at('10:59', '59'))).result)).toBe(
      'CONFLICT:USER_DEACTIVATED',
    );
    expect(codeOf((await fact(worker, at('11:00'))).result)).toBe('APPLIED');
  });

  it('suspendu puis désactivé : les faits datés entre les deux restent en quarantaine, comme ceux d’après', async () => {
    const worker = await newWorker();
    await transition(worker.userId, 'suspend', at('10:00'));
    await transition(worker.userId, 'deactivate', at('12:00'));

    expect(codeOf((await fact(worker, at('09:00'))).result)).toBe('APPLIED'); // BR-SYN-007 : avant tout
    expect(codeOf((await fact(worker, at('11:00'))).result)).toBe('CONFLICT:USER_DEACTIVATED');
    expect(codeOf((await fact(worker, at('12:30'))).result)).toBe('CONFLICT:USER_DEACTIVATED');
    const periods = await periodsOf(worker.userId);
    expect(periods.map((period) => period.status)).toEqual(['SUSPENDED']);
  });

  it('désactivé puis réactivé : le fait daté pendant la désactivation reste en quarantaine', async () => {
    const worker = await newWorker();
    await transition(worker.userId, 'deactivate', at('10:00'));
    await transition(worker.userId, 'reactivate', at('13:00'));

    expect(codeOf((await fact(worker, at('09:00'))).result)).toBe('APPLIED');
    expect(codeOf((await fact(worker, at('11:00'))).result)).toBe('CONFLICT:USER_DEACTIVATED');
    expect(codeOf((await fact(worker, at('14:00'))).result)).toBe('APPLIED');
    expect((await periodsOf(worker.userId)).map((period) => period.status)).toEqual([
      'DEACTIVATED',
    ]);
  });

  it('plusieurs suspensions : chacune garde sa période', async () => {
    const worker = await newWorker();
    await transition(worker.userId, 'suspend', at('08:00'));
    await transition(worker.userId, 'reactivate', at('09:00'));
    await transition(worker.userId, 'suspend', at('13:00'));
    await transition(worker.userId, 'reactivate', at('14:00'));

    expect(codeOf((await fact(worker, at('08:30'))).result)).toBe('CONFLICT:USER_DEACTIVATED');
    expect(codeOf((await fact(worker, at('10:00'))).result)).toBe('APPLIED'); // entre les deux
    expect(codeOf((await fact(worker, at('13:30'))).result)).toBe('CONFLICT:USER_DEACTIVATED');
    expect(await periodsOf(worker.userId)).toHaveLength(2);
  });

  it('une suspension sans durée (réactivée à la même date) n’écrit aucune période', async () => {
    const worker = await newWorker();
    await transition(worker.userId, 'suspend', at('10:00'));
    await transition(worker.userId, 'reactivate', at('10:00'));
    expect(await periodsOf(worker.userId)).toHaveLength(0);
    expect(codeOf((await fact(worker, at('10:00'))).result)).toBe('APPLIED');
  });

  it('un utilisateur jamais suspendu n’a aucune période et ses faits passent', async () => {
    const worker = await newWorker();
    expect(await periodsOf(worker.userId)).toHaveLength(0);
    expect(codeOf((await fact(worker, at('10:30'))).result)).toBe('APPLIED');
  });
});
