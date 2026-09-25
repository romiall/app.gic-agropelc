/**
 * `identity.role_assignment.grant`/`.revoke` (P0-10) à travers le **vrai** pipeline de
 * commande (même gabarit que `identity-lifecycle.test.ts`, P0-09) — écritures réelles, non
 * annulées (command_id/aggregate_id frais à chaque test, jamais en collision entre
 * exécutions), sauf le test dédié à `hasOtherActiveAdminAssignment` (INV-ADM-01), qui suit
 * le même choix que `identity-lifecycle.test.ts` §hasOtherActiveAdmin : `withTestUow`, pour
 * ne jamais risquer de révoquer une affectation ADMIN réelle et partagée.
 *
 * Démontre aussi le critère de sortie « cache invalidé par événement » (P0-10) : le cache
 * RBAC mémoire (`rbac-cache.ts`) sert délibérément une réponse **périmée** tant que le
 * consommateur `identity.rbac_cache` n'a pas traité l'événement écrit par le pipeline —
 * observable directement (avant/après un appel manuel à `EventConsumerRunner.processOnce`,
 * le même mécanisme qu'utiliserait `rbac-cache-poller.ts` en production).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerRoleAssignmentCommands } from '../src/modules/identity/application/commands/role-assignment-commands.js';
import { hasOtherActiveAdminAssignment } from '../src/modules/identity/application/commands/admin-guard.js';
import { registerRbacCacheConsumer } from '../src/modules/identity/application/rbac/rbac-cache-consumer.js';
import { hasPermissionAt } from '../src/modules/identity/application/public/index.js';
import { EventConsumerRunner } from '../src/platform/events/event-consumer-runner.js';
import { EventConsumerRegistry } from '../src/platform/events/event-consumer-registry.js';
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
  insertTestSite,
  insertTestUser,
  insertTestZone,
  withTestUow,
} from './helpers.js';

const GRANT_TYPE = 'identity.role_assignment.grant';
const REVOKE_TYPE = 'identity.role_assignment.revoke';
const MANAGE_PERMISSION = 'identity.role_assignment.manage';
const RBAC_CACHE_DEMO_PERMISSION = 'test.rbac_cache_demo.read';
const OCCURRED_AT = '2026-09-24T09:00:00.000Z';

function buildRegistry(): CommandHandlerRegistry {
  const registry = new CommandHandlerRegistry();
  registerRoleAssignmentCommands(registry);
  return registry;
}

interface EnvelopeOverrides {
  readonly command_type: string;
  readonly author_user_id: string;
  readonly aggregate_id: string;
  readonly occurred_at: string;
  readonly payload: unknown;
}

function buildEnvelope(overrides: EnvelopeOverrides): Record<string, unknown> {
  return {
    command_id: freshUuid(),
    device_seq: 1,
    command_version: 1,
    aggregate_type: 'ROLE_ASSIGNMENT',
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

describe('identity.role_assignment.{grant,revoke} (P0-10)', () => {
  let pipeline: CommandPipelineService;
  let clock: Clock;
  let idGenerator: IdGenerator;
  let admin: string;
  let adminDevice: string;
  let targetRoleId: string;

  beforeAll(async () => {
    // Postérieure à tous les `occurred_at` littéraux utilisés ci-dessous (jusqu'à 12:00) :
    // le pipeline rejette OCCURRED_AT_FUTURE au-delà de 5 min après `clock.now()` (§3d).
    clock = new FixedClock(new Date('2026-09-24T13:00:00.000Z'));
    idGenerator = new Uuidv7Generator(clock);
    pipeline = new CommandPipelineService(db, buildRegistry(), clock, idGenerator);

    admin = await createRealUser();
    adminDevice = await createRealDevice(admin);
    targetRoleId = await db
      .transaction()
      .execute((trx) => insertTestRole(trx, admin, { allowedScopeTypes: ['GLOBAL', 'SITE'] }));

    await db.transaction().execute(async (trx) => {
      const authorRole = await insertTestRole(trx, admin);
      await grantTestPermission(trx, authorRole, MANAGE_PERMISSION, admin);
      await assignTestRole(trx, admin, authorRole, admin);

      // Permission de test propre au scénario d'invalidation du cache ci-dessous : accordée
      // à `targetRoleId` une fois pour toutes, pour que l'octroi de ce rôle à un utilisateur
      // (via le pipeline) soit exactement ce qui la rend effective pour lui.
      await insertTestPermission(trx, RBAC_CACHE_DEMO_PERMISSION);
      await grantTestPermission(trx, targetRoleId, RBAC_CACHE_DEMO_PERMISSION, admin);
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('octroi : crée l’affectation (GLOBAL)', async () => {
    const target = await createRealUser();
    const assignmentId = freshUuid();
    const result = await pipeline.handle(
      buildEnvelope({
        command_type: GRANT_TYPE,
        author_user_id: admin,
        aggregate_id: assignmentId,
        occurred_at: OCCURRED_AT,
        payload: { userId: target, roleId: targetRoleId, scopeType: 'GLOBAL' },
      }),
      { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
    );
    expect(result.status).toBe('APPLIED');

    const row = await db
      .selectFrom('identity_user_role_assignments')
      .select(['scope_type', 'revoked_at'])
      .where('id', '=', toBin(assignmentId))
      .executeTakeFirstOrThrow();
    expect(row.scope_type).toBe('GLOBAL');
    expect(row.revoked_at).toBeNull();
  });

  it('octroi rejoué (même command_id) : APPLIED sans doublon (BR-SYN-007)', async () => {
    const target = await createRealUser();
    const assignmentId = freshUuid();
    const envelope = buildEnvelope({
      command_type: GRANT_TYPE,
      author_user_id: admin,
      aggregate_id: assignmentId,
      occurred_at: OCCURRED_AT,
      payload: { userId: target, roleId: targetRoleId, scopeType: 'GLOBAL' },
    });
    const ctx = {
      authenticatedUserId: admin,
      authenticatedDeviceId: adminDevice,
      transport: 'ONLINE_API' as const,
    };
    const first = await pipeline.handle(envelope, ctx);
    const second = await pipeline.handle(envelope, ctx);
    expect(first).toEqual(second);

    const rows = await db
      .selectFrom('identity_user_role_assignments')
      .select('id')
      .where('id', '=', toBin(assignmentId))
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('octroi : SITE valide, colonnes de portée renseignées', async () => {
    const target = await createRealUser();
    const zoneId = await db.transaction().execute((trx) => insertTestZone(trx, admin));
    const siteId = await db.transaction().execute((trx) => insertTestSite(trx, admin, zoneId));
    const assignmentId = freshUuid();
    const result = await pipeline.handle(
      buildEnvelope({
        command_type: GRANT_TYPE,
        author_user_id: admin,
        aggregate_id: assignmentId,
        occurred_at: OCCURRED_AT,
        payload: { userId: target, roleId: targetRoleId, scopeType: 'SITE', scopeSiteId: siteId },
      }),
      { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
    );
    expect(result.status).toBe('APPLIED');
    const row = await db
      .selectFrom('identity_user_role_assignments')
      .select(['scope_type', 'scope_site_id'])
      .where('id', '=', toBin(assignmentId))
      .executeTakeFirstOrThrow();
    expect(row.scope_type).toBe('SITE');
    expect(row.scope_site_id).not.toBeNull();
  });

  it('octroi : scopeType non autorisé par le rôle → REJECTED SCOPE_TYPE_NOT_ALLOWED', async () => {
    const target = await createRealUser();
    const globalOnlyRole = await db.transaction().execute((trx) => insertTestRole(trx, admin));
    const zoneId = await db.transaction().execute((trx) => insertTestZone(trx, admin));
    const siteId = await db.transaction().execute((trx) => insertTestSite(trx, admin, zoneId));
    const result = await pipeline.handle(
      buildEnvelope({
        command_type: GRANT_TYPE,
        author_user_id: admin,
        aggregate_id: freshUuid(),
        occurred_at: OCCURRED_AT,
        payload: { userId: target, roleId: globalOnlyRole, scopeType: 'SITE', scopeSiteId: siteId },
      }),
      { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
    );
    expect(result.status).toBe('REJECTED');
    expect(result).toMatchObject({ error: { code: 'SCOPE_TYPE_NOT_ALLOWED' } });
  });

  it('octroi : rôle introuvable → REJECTED NOT_FOUND', async () => {
    const target = await createRealUser();
    const result = await pipeline.handle(
      buildEnvelope({
        command_type: GRANT_TYPE,
        author_user_id: admin,
        aggregate_id: freshUuid(),
        occurred_at: OCCURRED_AT,
        payload: { userId: target, roleId: freshUuid(), scopeType: 'GLOBAL' },
      }),
      { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
    );
    expect(result.status).toBe('REJECTED');
    expect(result).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('révocation : ferme l’affectation, révocateur et motif renseignés', async () => {
    const target = await createRealUser();
    const assignmentId = freshUuid();
    await pipeline.handle(
      buildEnvelope({
        command_type: GRANT_TYPE,
        author_user_id: admin,
        aggregate_id: assignmentId,
        occurred_at: OCCURRED_AT,
        payload: { userId: target, roleId: targetRoleId, scopeType: 'GLOBAL' },
      }),
      { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
    );

    const result = await pipeline.handle(
      buildEnvelope({
        command_type: REVOKE_TYPE,
        author_user_id: admin,
        aggregate_id: assignmentId,
        occurred_at: '2026-09-24T10:00:00.000Z',
        payload: { reason: 'Fin de mission de test.' },
      }),
      { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
    );
    expect(result.status).toBe('APPLIED');

    const row = await db
      .selectFrom('identity_user_role_assignments')
      .select(['revoked_at', 'revoked_by', 'revoke_reason'])
      .where('id', '=', toBin(assignmentId))
      .executeTakeFirstOrThrow();
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoked_by).not.toBeNull();
    expect(row.revoke_reason).toBe('Fin de mission de test.');
  });

  it('révocation rejouée (déjà révoquée) : APPLIED sans effet (BR-SYN-007)', async () => {
    const target = await createRealUser();
    const assignmentId = freshUuid();
    await pipeline.handle(
      buildEnvelope({
        command_type: GRANT_TYPE,
        author_user_id: admin,
        aggregate_id: assignmentId,
        occurred_at: OCCURRED_AT,
        payload: { userId: target, roleId: targetRoleId, scopeType: 'GLOBAL' },
      }),
      { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
    );
    const revokeEnvelope = buildEnvelope({
      command_type: REVOKE_TYPE,
      author_user_id: admin,
      aggregate_id: assignmentId,
      occurred_at: '2026-09-24T10:00:00.000Z',
      payload: { reason: 'Première révocation.' },
    });
    const ctx = {
      authenticatedUserId: admin,
      authenticatedDeviceId: adminDevice,
      transport: 'ONLINE_API' as const,
    };
    await pipeline.handle(revokeEnvelope, ctx);

    const replay = await pipeline.handle(
      buildEnvelope({
        command_type: REVOKE_TYPE,
        author_user_id: admin,
        aggregate_id: assignmentId,
        occurred_at: '2026-09-24T11:00:00.000Z',
        payload: { reason: 'Seconde tentative, ignorée.' },
      }),
      ctx,
    );
    expect(replay.status).toBe('APPLIED');
    const row = await db
      .selectFrom('identity_user_role_assignments')
      .select('revoke_reason')
      .where('id', '=', toBin(assignmentId))
      .executeTakeFirstOrThrow();
    expect(row.revoke_reason).toBe('Première révocation.'); // pas écrasé par le rejeu
  });

  it('révocation : affectation introuvable → REJECTED NOT_FOUND', async () => {
    const result = await pipeline.handle(
      buildEnvelope({
        command_type: REVOKE_TYPE,
        author_user_id: admin,
        aggregate_id: freshUuid(),
        occurred_at: OCCURRED_AT,
        payload: { reason: 'Introuvable.' },
      }),
      { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
    );
    expect(result.status).toBe('REJECTED');
    expect(result).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('cache RBAC invalidé par événement : un octroi n’est utilisable qu’après traitement de l’événement', async () => {
    const target = await createRealUser();

    const localRegistry = new EventConsumerRegistry();
    registerRbacCacheConsumer(localRegistry);
    const runner = new EventConsumerRunner(db, localRegistry);

    // Amorce le cache de `target` avant tout octroi : `targetRoleId` porte déjà
    // RBAC_CACHE_DEMO_PERMISSION (beforeAll) — seule l'affectation manque encore.
    expect(await hasPermissionAt(db, toBin(target), RBAC_CACHE_DEMO_PERMISSION, clock.now())).toBe(
      false,
    );

    const assignmentId = freshUuid();
    await pipeline.handle(
      buildEnvelope({
        command_type: GRANT_TYPE,
        author_user_id: admin,
        aggregate_id: assignmentId,
        occurred_at: OCCURRED_AT,
        payload: { userId: target, roleId: targetRoleId, scopeType: 'GLOBAL' },
      }),
      { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
    );

    // Toujours périmé : le consommateur n'a pas encore tourné, le cache mémoire de `target`
    // (chargé une première fois juste au-dessus, sans droit) n'a pas été invalidé.
    expect(await hasPermissionAt(db, toBin(target), RBAC_CACHE_DEMO_PERMISSION, clock.now())).toBe(
      false,
    );

    // `platform_domain_events` est une table partagée par toute la suite (tous fichiers de
    // test confondus, `seq` global) : un seul lot de 50 (par défaut) ne rattraperait pas
    // forcément l'événement qui nous intéresse si d'autres fichiers, exécutés en parallèle,
    // en ont déjà écrit davantage — on vide donc la file jusqu'à un lot incomplet (tête du
    // flux atteinte), comme le ferait `rbac-cache-poller.ts` au fil de plusieurs tours.
    let batch;
    do {
      batch = await runner.processOnce('identity.rbac_cache', { batchSize: 500 });
    } while (batch.processed + batch.failed === 500);

    // Invalidé : la nouvelle lecture recharge depuis la base et voit l'octroi.
    expect(await hasPermissionAt(db, toBin(target), RBAC_CACHE_DEMO_PERMISSION, clock.now())).toBe(
      true,
    );
  });

  it('hasOtherActiveAdminAssignment (INV-ADM-01) : faux une fois toutes les autres affectations ADMIN exclues/révoquées', async () => {
    await withTestUow(async (trx) => {
      const now = new Date('2026-09-24T12:00:00.000Z');
      const adminRole = await trx
        .selectFrom('identity_roles')
        .select('id')
        .where('code', '=', 'ADMIN')
        .executeTakeFirstOrThrow();

      // Révoque toutes les affectations ADMIN réelles préexistantes (partagées entre
      // fichiers de test) — annulé par le ROLLBACK de withTestUow, jamais persisté.
      await trx
        .updateTable('identity_user_role_assignments')
        .set({ revoked_at: now, revoke_reason: 'Exclu pour le test (annulé).' })
        .where('role_id', '=', adminRole.id)
        .where('revoked_at', 'is', null)
        .execute();

      const adminRoleId = fromBin(adminRole.id);
      const soleAdmin = await insertTestUser(trx);
      const soleAssignmentId = await assignTestRole(trx, soleAdmin, adminRoleId, soleAdmin);

      expect(await hasOtherActiveAdminAssignment(trx, soleAssignmentId, now)).toBe(false);

      const secondAdmin = await insertTestUser(trx);
      await assignTestRole(trx, secondAdmin, adminRoleId, secondAdmin);
      expect(await hasOtherActiveAdminAssignment(trx, soleAssignmentId, now)).toBe(true);
    });
  });
});
