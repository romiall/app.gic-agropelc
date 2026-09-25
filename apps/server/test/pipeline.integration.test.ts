/**
 * Démonstration du critère de sortie P0-06 (docs/10-development-plan/
 * 06-passage-au-developpement.md §3) : « une commande de démonstration traverse le
 * pipeline ; rejet sans effet (INV-SYN-05) ». `test.pipeline_demo.record` est une commande
 * de test uniquement (convention `test.*`, comme db/tests), jamais enregistrée en
 * production — elle ne préempte pas `organization.setting.set`, réservée à P0-11.
 *
 * Écritures réelles, non annulées (comme db/tests/seed.test.ts) : sync_command_inbox,
 * audit_audit_log et platform_domain_events sont en ajout seul (aucun DELETE accordé à
 * gic_app) — chaque commande de test utilise un command_id/aggregate_id frais (UUIDv7),
 * jamais en collision entre exécutions.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FixedClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';
import type { CommandEnvelope } from '@gic/contracts';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
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
} from './helpers.js';

const OCCURRED_AT = new Date('2026-09-24T09:00:00.000Z');
const DEMO_PERMISSION = 'test.pipeline_demo.record';
const DEMO_TYPE = 'test.pipeline_demo.record';

interface DemoPayload {
  readonly note: string;
}

function buildRegistry(): CommandHandlerRegistry {
  const registry = new CommandHandlerRegistry();
  registry.register<DemoPayload>({
    commandType: DEMO_TYPE,
    version: 1,
    payloadSchema: z.object({ note: z.string().min(1).max(200) }),
    permissionCode: DEMO_PERMISSION,
    handler: async (uow, envelope: CommandEnvelope<DemoPayload>) => {
      await uow
        .insertInto('organization_system_settings')
        .values({
          id: toBin(freshUuid()),
          key: `test.pipeline_demo.${envelope.command_id}`,
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

function buildEnvelope(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    command_id: freshUuid(),
    device_seq: 1,
    command_type: DEMO_TYPE,
    command_version: 1,
    author_user_id: overrides.author_user_id,
    aggregate_type: 'TEST_SETTING',
    aggregate_id: freshUuid(),
    base_version: null,
    depends_on: [],
    occurred_at: OCCURRED_AT.toISOString(),
    client_created_at: OCCURRED_AT.toISOString(),
    captured_offline: false,
    backdated_reason: null,
    attachment_ids: [],
    payload: { note: 'note de test' },
    ...overrides,
  };
}

describe('CommandPipelineService (§3.2, RC-01, RC-02, INV-SYN-05)', () => {
  let pipeline: CommandPipelineService;
  let clock: Clock;
  let idGenerator: IdGenerator;
  let admin: string;
  let authorizedUser: string;
  let unauthorizedUser: string;
  let activeDevice: string;
  let blockedDevice: string;

  beforeAll(async () => {
    clock = new FixedClock(new Date('2026-09-24T09:05:00.000Z'));
    idGenerator = new Uuidv7Generator(clock);
    pipeline = new CommandPipelineService(db, buildRegistry(), clock, idGenerator);

    admin = await createRealUser();
    authorizedUser = await createRealUser();
    unauthorizedUser = await createRealUser();
    activeDevice = await createRealDevice(admin, 'ACTIVE', new Date());
    blockedDevice = await createRealDevice(admin, 'BLOCKED', new Date('2026-09-01T00:00:00.000Z'));

    await db.transaction().execute(async (trx) => {
      await insertTestPermission(trx, DEMO_PERMISSION);
      const role = await insertTestRole(trx, admin);
      await grantTestPermission(trx, role, DEMO_PERMISSION, admin);
      await assignTestRole(trx, authorizedUser, role, admin);
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('chemin heureux : la commande traverse le pipeline (APPLIED), tout écrit dans la même transaction', async () => {
    const envelope = buildEnvelope({ author_user_id: authorizedUser });
    const result = await pipeline.handle(envelope, {
      authenticatedUserId: authorizedUser,
      authenticatedDeviceId: activeDevice,
      transport: 'ONLINE_API',
    });

    expect(result).toEqual({ command_id: envelope.command_id, status: 'APPLIED' });

    const inboxRow = await db
      .selectFrom('sync_command_inbox')
      .select(['status', 'applied_at'])
      .where('command_id', '=', toBin(envelope.command_id as string))
      .executeTakeFirstOrThrow();
    expect(inboxRow.status).toBe('APPLIED');
    expect(inboxRow.applied_at).not.toBeNull();

    const auditRow = await db
      .selectFrom('audit_audit_log')
      .select(['result', 'action'])
      .where('command_id', '=', toBin(envelope.command_id as string))
      .executeTakeFirstOrThrow();
    expect(auditRow.result).toBe('SUCCESS');
    expect(auditRow.action).toBe(DEMO_TYPE);

    const eventRow = await db
      .selectFrom('platform_domain_events')
      .select(['event_type'])
      .where('command_id', '=', toBin(envelope.command_id as string))
      .executeTakeFirstOrThrow();
    expect(eventRow.event_type).toBe(DEMO_TYPE);

    const settingRow = await db
      .selectFrom('organization_system_settings')
      .select(['value'])
      .where('key', '=', `test.pipeline_demo.${envelope.command_id}`)
      .executeTakeFirstOrThrow();
    expect(settingRow.value).toBe('note de test');
  });

  it('FORBIDDEN : droit absent → rejet sans effet métier (INV-SYN-05), mais audité (transaction séparée)', async () => {
    const envelope = buildEnvelope({ author_user_id: unauthorizedUser });
    const result = await pipeline.handle(envelope, {
      authenticatedUserId: unauthorizedUser,
      authenticatedDeviceId: activeDevice,
      transport: 'ONLINE_API',
    });

    expect(result.status).toBe('REJECTED');
    expect(result.error?.code).toBe('FORBIDDEN');

    const inboxRow = await db
      .selectFrom('sync_command_inbox')
      .select(['status'])
      .where('command_id', '=', toBin(envelope.command_id as string))
      .executeTakeFirstOrThrow();
    expect(inboxRow.status).toBe('REJECTED');

    // INV-SYN-05 : aucun effet métier — le gestionnaire n'a jamais tourné.
    const settingRow = await db
      .selectFrom('organization_system_settings')
      .select(['id'])
      .where('key', '=', `test.pipeline_demo.${envelope.command_id}`)
      .executeTakeFirst();
    expect(settingRow).toBeUndefined();

    // Aucun événement ni entrée SUCCESS d'audit pour cette commande.
    const eventRow = await db
      .selectFrom('platform_domain_events')
      .select(['event_id'])
      .where('command_id', '=', toBin(envelope.command_id as string))
      .executeTakeFirst();
    expect(eventRow).toBeUndefined();

    // Le refus lui-même reste audité (access.denied, transaction séparée).
    const deniedRow = await db
      .selectFrom('audit_audit_log')
      .select(['result', 'action'])
      .where('command_id', '=', toBin(envelope.command_id as string))
      .executeTakeFirstOrThrow();
    expect(deniedRow.result).toBe('DENIED');
    expect(deniedRow.action).toBe('access.denied');
  });

  it('COMMAND_ID_REUSED (rejeu) : même command_id + même payload_hash → résultat déjà enregistré, gestionnaire non ré-exécuté', async () => {
    const envelope = buildEnvelope({ author_user_id: authorizedUser });
    const ctx = {
      authenticatedUserId: authorizedUser,
      authenticatedDeviceId: activeDevice,
      transport: 'ONLINE_API' as const,
    };

    const first = await pipeline.handle(envelope, ctx);
    const second = await pipeline.handle(envelope, ctx);
    expect(first).toEqual(second);

    const rows = await db
      .selectFrom('organization_system_settings')
      .select(['id'])
      .where('key', '=', `test.pipeline_demo.${envelope.command_id}`)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('COMMAND_ID_REUSED (conflit) : même command_id, contenu différent → REJECTED sans toucher la commande originale', async () => {
    const envelope = buildEnvelope({ author_user_id: authorizedUser });
    const ctx = {
      authenticatedUserId: authorizedUser,
      authenticatedDeviceId: activeDevice,
      transport: 'ONLINE_API' as const,
    };
    await pipeline.handle(envelope, ctx);

    const conflicting = { ...envelope, payload: { note: 'contenu différent' } };
    const result = await pipeline.handle(conflicting, ctx);
    expect(result).toEqual({
      command_id: envelope.command_id,
      status: 'REJECTED',
      error: { code: 'COMMAND_ID_REUSED', message_fr: expect.any(String) },
    });

    const settingRow = await db
      .selectFrom('organization_system_settings')
      .select(['value'])
      .where('key', '=', `test.pipeline_demo.${envelope.command_id}`)
      .executeTakeFirstOrThrow();
    expect(settingRow.value).toBe('note de test');
  });

  it('DEVICE_REVOKED : appareil bloqué avant occurred_at → CONFLICT sans effet métier', async () => {
    const envelope = buildEnvelope({ author_user_id: authorizedUser });
    const result = await pipeline.handle(envelope, {
      authenticatedUserId: authorizedUser,
      authenticatedDeviceId: blockedDevice,
      transport: 'ONLINE_API',
    });
    expect(result.status).toBe('CONFLICT');
    expect(result.error?.code).toBe('DEVICE_REVOKED');

    const settingRow = await db
      .selectFrom('organization_system_settings')
      .select(['id'])
      .where('key', '=', `test.pipeline_demo.${envelope.command_id}`)
      .executeTakeFirst();
    expect(settingRow).toBeUndefined();
  });

  it("l'auteur déclaré doit correspondre à la session authentifiée (FORBIDDEN)", async () => {
    const envelope = buildEnvelope({ author_user_id: authorizedUser });
    const result = await pipeline.handle(envelope, {
      authenticatedUserId: unauthorizedUser, // authentifié comme un AUTRE utilisateur
      authenticatedDeviceId: activeDevice,
      transport: 'ONLINE_API',
    });
    expect(result.status).toBe('REJECTED');
    expect(result.error?.code).toBe('FORBIDDEN');
  });
});

// Écritures réelles (non annulées, voir l'en-tête du fichier) : les mêmes helpers que les
// tests sous withTestUow (helpers.ts), mais portés par une vraie transaction commitée —
// `db.transaction().execute` fournit un `Transaction<DB>`, exactement le type `UnitOfWork`
// qu'ils attendent.
async function createRealUser(): Promise<string> {
  return db.transaction().execute((trx) => insertTestUser(trx));
}

async function createRealDevice(
  enrolledBy: string,
  status: 'ACTIVE' | 'BLOCKED',
  statusChangedAt: Date,
): Promise<string> {
  return db
    .transaction()
    .execute((trx) => insertTestDevice(trx, enrolledBy, { status, statusChangedAt }));
}
