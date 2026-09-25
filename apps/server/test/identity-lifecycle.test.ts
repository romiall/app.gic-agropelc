/**
 * Démonstration des critères de sortie P0-09 (AT-034, AT-035) et des transitions SM-USER /
 * SM-DEVICE, à travers le **vrai** pipeline de commande (P0-06) : `identity.user.*` et
 * `identity.device.*` ne sont pas des points d'API séparés, ce sont des command_type comme
 * les autres, résolus par le même `CommandHandlerRegistry` (05-architecture/02-modules.md
 * §17). Une commande d'un utilisateur désactivé / d'un appareil perdu n'est jamais rejetée
 * rétroactivement (BR-SYN-007) : seules celles dont `occurred_at` suit la transition sont
 * mises en quarantaine (BR-ADM-002, BR-ADM-006, INV-ADM-03).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FixedClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerDeviceCommands } from '../src/modules/identity/application/commands/device-commands.js';
import { registerUserCommands } from '../src/modules/identity/application/commands/user-commands.js';
import { hasOtherActiveAdmin } from '../src/modules/identity/application/commands/admin-guard.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestPermission,
  insertTestRole,
  insertTestUser,
  withTestUow,
} from './helpers.js';

const DEMO_TYPE = 'test.lifecycle_demo.record';
const DEMO_PERMISSION = 'test.lifecycle_demo.record';

function buildRegistry(): CommandHandlerRegistry {
  const registry = new CommandHandlerRegistry();
  registerDeviceCommands(registry);
  registerUserCommands(registry);
  registry.register<{ note: string }>({
    commandType: DEMO_TYPE,
    version: 1,
    payloadSchema: z.object({ note: z.string().min(1).max(200) }),
    permissionCode: DEMO_PERMISSION,
    handler: async (uow, envelope) => {
      await uow
        .insertInto('organization_system_settings')
        .values({
          id: toBin(freshUuid()),
          key: `test.lifecycle_demo.${envelope.command_id}`,
          value: JSON.stringify(envelope.payload.note),
          scope_type: 'GLOBAL',
          created_by: toBin(envelope.author_user_id),
        })
        .execute();
      return { status: 'APPLIED' as const };
    },
  });
  return registry;
}

interface EnvelopeOverrides {
  readonly command_type: string;
  readonly command_version?: number;
  readonly author_user_id: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly occurred_at: string;
  readonly payload: unknown;
}

function buildEnvelope(overrides: EnvelopeOverrides): Record<string, unknown> {
  return {
    command_id: freshUuid(),
    device_seq: 1,
    command_version: 1,
    base_version: null,
    depends_on: [],
    client_created_at: overrides.occurred_at,
    captured_offline: false,
    backdated_reason: null,
    attachment_ids: [],
    ...overrides,
  };
}

async function createRealUser(): Promise<string> {
  return db.transaction().execute((trx) => insertTestUser(trx));
}

async function createRealDevice(enrolledBy: string): Promise<string> {
  return db.transaction().execute((trx) => insertTestDevice(trx, enrolledBy, { status: 'ACTIVE' }));
}

describe('Cycle de vie identity (SM-USER, SM-DEVICE) — AT-034, AT-035', () => {
  let pipeline: CommandPipelineService;
  let clock: Clock;
  let idGenerator: IdGenerator;
  let admin: string;
  let adminDevice: string;

  beforeAll(async () => {
    clock = new FixedClock(new Date('2026-09-24T09:05:00.000Z'));
    idGenerator = new Uuidv7Generator(clock);
    pipeline = new CommandPipelineService(db, buildRegistry(), clock, idGenerator);

    admin = await createRealUser();
    adminDevice = await createRealDevice(admin);

    await db.transaction().execute(async (trx) => {
      await insertTestPermission(trx, DEMO_PERMISSION);
      await insertTestPermission(trx, 'identity.user.manage');
      await insertTestPermission(trx, 'identity.device.approve');
      await insertTestPermission(trx, 'identity.device.block');
      const role = await insertTestRole(trx, admin);
      await grantTestPermission(trx, role, DEMO_PERMISSION, admin);
      await grantTestPermission(trx, role, 'identity.user.manage', admin);
      await grantTestPermission(trx, role, 'identity.device.approve', admin);
      await grantTestPermission(trx, role, 'identity.device.block', admin);
      await assignTestRole(trx, admin, role, admin);

      // Le seed P0-05 alimente le catalogue RBAC (rôles/permissions), pas des affectations
      // réelles : aucun utilisateur ne tient déjà le rôle ADMIN dans la base de test. Sans un
      // second porteur réel de ce rôle, suspendre/désactiver n'importe quel autre utilisateur
      // heurterait systématiquement INV-ADM-01 (hasOtherActiveAdmin ne trouverait personne).
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

  async function grantDemoPermission(userId: string): Promise<void> {
    await db.transaction().execute(async (trx) => {
      const role = await insertTestRole(trx, admin);
      await grantTestPermission(trx, role, DEMO_PERMISSION, admin);
      await assignTestRole(trx, userId, role, admin);
    });
  }

  describe('SM-DEVICE', () => {
    it('approve : PENDING → ACTIVE, approved_by renseigné', async () => {
      const deviceId = await db
        .transaction()
        .execute((trx) => insertTestDevice(trx, admin, { status: 'PENDING' }));
      const result = await pipeline.handle(
        buildEnvelope({
          command_type: 'identity.device.approve',
          author_user_id: admin,
          aggregate_type: 'DEVICE',
          aggregate_id: deviceId,
          occurred_at: '2026-09-24T09:00:00.000Z',
          payload: {},
        }),
        { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
      );
      expect(result.status).toBe('APPLIED');
      const row = await db
        .selectFrom('identity_devices')
        .select(['status', 'approved_by'])
        .where('id', '=', toBin(deviceId))
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('ACTIVE');
      expect(row.approved_by).not.toBeNull();
    });

    it('approve rejoué (déjà ACTIVE) : APPLIED sans effet (idempotent, BR-SYN-007)', async () => {
      const deviceId = await createRealDevice(admin);
      const envelope = buildEnvelope({
        command_type: 'identity.device.approve',
        author_user_id: admin,
        aggregate_type: 'DEVICE',
        aggregate_id: deviceId,
        occurred_at: '2026-09-24T09:00:00.000Z',
        payload: {},
      });
      const result = await pipeline.handle(envelope, {
        authenticatedUserId: admin,
        authenticatedDeviceId: adminDevice,
        transport: 'ONLINE_API',
      });
      expect(result.status).toBe('APPLIED');
    });

    it('approve depuis RETIRED : INVALID_TRANSITION', async () => {
      const deviceId = await db
        .transaction()
        .execute((trx) => insertTestDevice(trx, admin, { status: 'RETIRED' }));
      const result = await pipeline.handle(
        buildEnvelope({
          command_type: 'identity.device.approve',
          author_user_id: admin,
          aggregate_type: 'DEVICE',
          aggregate_id: deviceId,
          occurred_at: '2026-09-24T09:00:00.000Z',
          payload: {},
        }),
        { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
      );
      // Une transition SM-DEVICE interdite est un rejet (pas un conflit de synchronisation
      // au sens sync-core — CommandHandlerOutcome.CONFLICT porterait un conflictId, ce que
      // cette transition administrative invalide n'a pas lieu d'ouvrir).
      expect(result.status).toBe('REJECTED');
      expect(result.error?.code).toBe('INVALID_TRANSITION');
    });

    it('block puis unblock : ACTIVE → BLOCKED → ACTIVE, sessions révoquées au blocage', async () => {
      const deviceId = await createRealDevice(admin);
      await db
        .insertInto('identity_auth_sessions')
        .values({
          id: toBin(freshUuid()),
          user_id: toBin(admin),
          device_id: toBin(deviceId),
          refresh_token_hash: freshUuid().replace(/-/g, '').padEnd(64, '0'),
          token_family_id: toBin(freshUuid()),
          expires_at: new Date('2026-10-24T09:00:00.000Z'),
          offline_grant_until: new Date('2026-10-01T09:00:00.000Z'),
        })
        .execute();

      const blockResult = await pipeline.handle(
        buildEnvelope({
          command_type: 'identity.device.block',
          author_user_id: admin,
          aggregate_type: 'DEVICE',
          aggregate_id: deviceId,
          occurred_at: '2026-09-24T09:00:00.000Z',
          payload: { reason: 'Test de blocage' },
        }),
        { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
      );
      expect(blockResult.status).toBe('APPLIED');

      const session = await db
        .selectFrom('identity_auth_sessions')
        .select(['revoked_at', 'revoked_reason'])
        .where('device_id', '=', toBin(deviceId))
        .executeTakeFirstOrThrow();
      expect(session.revoked_at).not.toBeNull();
      expect(session.revoked_reason).toBe('DEVICE_BLOCKED');

      const unblockResult = await pipeline.handle(
        buildEnvelope({
          command_type: 'identity.device.unblock',
          author_user_id: admin,
          aggregate_type: 'DEVICE',
          aggregate_id: deviceId,
          occurred_at: '2026-09-24T09:10:00.000Z',
          payload: {},
        }),
        { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
      );
      expect(unblockResult.status).toBe('APPLIED');
      const row = await db
        .selectFrom('identity_devices')
        .select('status')
        .where('id', '=', toBin(deviceId))
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('ACTIVE');
    });

    it('retire depuis BLOCKED : RETIRED, jamais réattribué (pas de retour en arrière)', async () => {
      const deviceId = await db
        .transaction()
        .execute((trx) => insertTestDevice(trx, admin, { status: 'BLOCKED' }));
      const result = await pipeline.handle(
        buildEnvelope({
          command_type: 'identity.device.retire',
          author_user_id: admin,
          aggregate_type: 'DEVICE',
          aggregate_id: deviceId,
          occurred_at: '2026-09-24T09:00:00.000Z',
          payload: {},
        }),
        { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
      );
      expect(result.status).toBe('APPLIED');
      const row = await db
        .selectFrom('identity_devices')
        .select('status')
        .where('id', '=', toBin(deviceId))
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('RETIRED');
    });
  });

  describe('SM-USER', () => {
    it('suspend puis reactivate : ACTIVE → SUSPENDED → ACTIVE, sessions révoquées à la suspension', async () => {
      const targetUser = await createRealUser();
      await db
        .insertInto('identity_auth_sessions')
        .values({
          id: toBin(freshUuid()),
          user_id: toBin(targetUser),
          device_id: toBin(adminDevice),
          refresh_token_hash: freshUuid().replace(/-/g, '').padEnd(64, '0'),
          token_family_id: toBin(freshUuid()),
          expires_at: new Date('2026-10-24T09:00:00.000Z'),
          offline_grant_until: new Date('2026-10-01T09:00:00.000Z'),
        })
        .execute();

      const suspendResult = await pipeline.handle(
        buildEnvelope({
          command_type: 'identity.user.suspend',
          author_user_id: admin,
          aggregate_type: 'USER',
          aggregate_id: targetUser,
          occurred_at: '2026-09-24T09:00:00.000Z',
          payload: { reason: 'Test de suspension' },
        }),
        { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
      );
      expect(suspendResult.status).toBe('APPLIED');

      const session = await db
        .selectFrom('identity_auth_sessions')
        .select(['revoked_at', 'revoked_reason'])
        .where('user_id', '=', toBin(targetUser))
        .executeTakeFirstOrThrow();
      expect(session.revoked_at).not.toBeNull();
      expect(session.revoked_reason).toBe('ADMIN');

      const reactivateResult = await pipeline.handle(
        buildEnvelope({
          command_type: 'identity.user.reactivate',
          author_user_id: admin,
          aggregate_type: 'USER',
          aggregate_id: targetUser,
          occurred_at: '2026-09-24T09:10:00.000Z',
          payload: {},
        }),
        { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
      );
      expect(reactivateResult.status).toBe('APPLIED');
      const row = await db
        .selectFrom('identity_users')
        .select('status')
        .where('id', '=', toBin(targetUser))
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('ACTIVE');
    });

    it('hasOtherActiveAdmin (INV-ADM-01) : faux une fois tous les autres octrois ADMIN exclus/révoqués', async () => {
      // Le rôle ADMIN réel (seed P0-05) a déjà des titulaires partagés par toute la suite :
      // impossible de fabriquer un vrai « dernier admin » via le pipeline sans perturber
      // d'autres tests. `withTestUow` (transaction toujours annulée) permet de révoquer ces
      // octrois *dans cette transaction seulement* (jamais commité, invisible ailleurs) pour
      // tester la garde elle-même, comme record-audit.test.ts isole ses propres scénarios.
      await withTestUow(async (trx) => {
        const adminRole = await trx
          .selectFrom('identity_roles')
          .select('id')
          .where('code', '=', 'ADMIN')
          .executeTakeFirstOrThrow();
        const now = new Date('2026-09-24T09:00:00.000Z');

        await trx
          .updateTable('identity_user_role_assignments')
          .set({ revoked_at: now })
          .where('role_id', '=', adminRole.id)
          .where('revoked_at', 'is', null)
          .execute();

        const soleAdmin = await insertTestUser(trx);
        await assignTestRole(trx, soleAdmin, fromBin(adminRole.id), soleAdmin);
        expect(await hasOtherActiveAdmin(trx, soleAdmin, now)).toBe(false);

        const otherAdmin = await insertTestUser(trx);
        await assignTestRole(trx, otherAdmin, fromBin(adminRole.id), soleAdmin);
        expect(await hasOtherActiveAdmin(trx, soleAdmin, now)).toBe(true);
      });
    });
  });

  describe('AT-034 : utilisateur désactivé, commandes hors ligne avant et après', () => {
    it('avant la désactivation : appliquée ; après : quarantaine (USER_DEACTIVATED)', async () => {
      const targetUser = await createRealUser();
      const targetDevice = await createRealDevice(admin);
      await grantDemoPermission(targetUser);

      const deactivateResult = await pipeline.handle(
        buildEnvelope({
          command_type: 'identity.user.deactivate',
          author_user_id: admin,
          aggregate_type: 'USER',
          aggregate_id: targetUser,
          occurred_at: '2026-09-24T09:00:00.000Z',
          payload: { reason: 'AT-034' },
        }),
        { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
      );
      expect(deactivateResult.status).toBe('APPLIED');

      const before = await pipeline.handle(
        buildEnvelope({
          command_type: DEMO_TYPE,
          author_user_id: targetUser,
          aggregate_type: 'TEST_SETTING',
          aggregate_id: freshUuid(),
          occurred_at: '2026-09-20T09:00:00.000Z', // antérieur à la désactivation
          payload: { note: 'avant' },
        }),
        {
          authenticatedUserId: targetUser,
          authenticatedDeviceId: targetDevice,
          transport: 'ONLINE_API',
        },
      );
      expect(before.status).toBe('APPLIED');

      const after = await pipeline.handle(
        buildEnvelope({
          command_type: DEMO_TYPE,
          author_user_id: targetUser,
          aggregate_type: 'TEST_SETTING',
          aggregate_id: freshUuid(),
          occurred_at: '2026-09-24T10:00:00.000Z', // postérieur à la désactivation
          payload: { note: 'après' },
        }),
        {
          authenticatedUserId: targetUser,
          authenticatedDeviceId: targetDevice,
          transport: 'ONLINE_API',
        },
      );
      expect(after.status).toBe('CONFLICT');
      expect(after.error?.code).toBe('USER_DEACTIVATED');
    });
  });

  describe('AT-035 : appareil déclaré perdu, commandes postérieures en quarantaine', () => {
    it('avant la perte : appliquée ; après : quarantaine (DEVICE_REVOKED)', async () => {
      const targetUser = await createRealUser();
      const targetDevice = await createRealDevice(admin);
      await grantDemoPermission(targetUser);

      const lostResult = await pipeline.handle(
        buildEnvelope({
          command_type: 'identity.device.declare_lost',
          author_user_id: admin,
          aggregate_type: 'DEVICE',
          aggregate_id: targetDevice,
          occurred_at: '2026-09-24T09:00:00.000Z',
          payload: {},
        }),
        { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
      );
      expect(lostResult.status).toBe('APPLIED');

      const before = await pipeline.handle(
        buildEnvelope({
          command_type: DEMO_TYPE,
          author_user_id: targetUser,
          aggregate_type: 'TEST_SETTING',
          aggregate_id: freshUuid(),
          occurred_at: '2026-09-20T09:00:00.000Z', // antérieur à la déclaration de perte
          payload: { note: 'avant' },
        }),
        {
          authenticatedUserId: targetUser,
          authenticatedDeviceId: targetDevice,
          transport: 'ONLINE_API',
        },
      );
      expect(before.status).toBe('APPLIED');

      const after = await pipeline.handle(
        buildEnvelope({
          command_type: DEMO_TYPE,
          author_user_id: targetUser,
          aggregate_type: 'TEST_SETTING',
          aggregate_id: freshUuid(),
          occurred_at: '2026-09-24T10:00:00.000Z', // postérieur à la déclaration de perte
          payload: { note: 'après' },
        }),
        {
          authenticatedUserId: targetUser,
          authenticatedDeviceId: targetDevice,
          transport: 'ONLINE_API',
        },
      );
      expect(after.status).toBe('CONFLICT');
      expect(after.error?.code).toBe('DEVICE_REVOKED');
    });
  });
});
