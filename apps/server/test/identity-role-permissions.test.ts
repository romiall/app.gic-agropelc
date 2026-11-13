/**
 * `identity.role_permission.set` (questionnaire de clôture, Q28 du 08/11/2026 ; ADR-072) à travers le **vrai**
 * pipeline de commande : octroi, changement de portée et retrait d'une permission sur un rôle, journal en ajout seul,
 * audit, rejeu, et les gardes contre l'élévation de droits (on ne donne que ce qu'on a, rôle ADMIN figé, droit de
 * modifier les droits jamais modifiable). Seuls des rôles d'essai sont modifiés : un changement d'un rôle système sur
 * la base partagée serait définitif (la graine le respecterait ensuite).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerRolePermissionCommands } from '../src/modules/identity/application/commands/role-permission-commands.js';
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
  insertTestRole,
  insertTestUser,
} from './helpers.js';

const COMMAND = 'identity.role_permission.set';
const OCCURRED_AT = '2026-09-24T09:00:00.000Z';
// Permissions d'essai à plusieurs portées (codes stables d'une exécution à l'autre).
const HELD_ALL = 'test.role_permission.held_all';
const HELD_SITE = 'test.role_permission.held_site';
const NOT_HELD = 'test.role_permission.not_held';
const DEPRECATED = 'test.role_permission.deprecated';

/**
 * Droit d’essai, remis en service à chaque exécution (ou déclaré déprécié quand l’essai le demande). Le semis déprécie toute
 * permission absente du catalogue (db/seeds/run.ts), et chaque passage de la vérification complète commence par le
 * semis : un droit d’essai créé par une exécution précédente serait refusé par la commande (`PERMISSION_DEPRECATED`).
 */
async function testPermission(code: string, deprecated = false): Promise<void> {
  const deprecatedAt = deprecated ? new Date() : null;
  await db
    .insertInto('identity_permissions')
    .values({
      code,
      module: 'test',
      description: 'Permission de test (ADR-072)',
      supported_scopes: '["OWN","SITE","ZONE","ALL"]',
      deprecated_at: deprecatedAt,
    })
    .onDuplicateKeyUpdate({
      supported_scopes: '["OWN","SITE","ZONE","ALL"]',
      deprecated_at: deprecatedAt,
    })
    .execute();
}

describe('identity.role_permission.set (Q28, ADR-072)', () => {
  let pipeline: CommandPipelineService;
  let editor: string;
  let editorDevice: string;

  const run = (
    author: string,
    device: string,
    roleId: string,
    payload: Record<string, unknown>,
    commandId: string = freshUuid(),
  ) =>
    pipeline.handle(
      {
        command_id: commandId,
        device_seq: 1,
        command_version: 1,
        command_type: COMMAND,
        aggregate_type: 'ROLE',
        aggregate_id: roleId,
        author_user_id: author,
        occurred_at: OCCURRED_AT,
        base_version: null,
        depends_on: [],
        client_created_at: OCCURRED_AT,
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload,
      },
      { authenticatedUserId: author, authenticatedDeviceId: device, transport: 'ONLINE_API' },
    );

  const scopeOf = async (roleId: string, permissionCode: string) =>
    (
      await db
        .selectFrom('identity_role_permissions')
        .select('max_scope')
        .where('role_id', '=', toBin(roleId))
        .where('permission_code', '=', permissionCode)
        .executeTakeFirst()
    )?.max_scope ?? null;

  const journalOf = (roleId: string) =>
    db
      .selectFrom('identity_role_permission_changes')
      .select([
        'permission_code',
        'change_type',
        'scope_before',
        'scope_after',
        'reason',
        'changed_by',
      ])
      .where('role_id', '=', toBin(roleId))
      .orderBy('changed_at', 'asc')
      .orderBy('created_at', 'asc')
      .execute();

  const newTargetRole = () => db.transaction().execute((trx) => insertTestRole(trx, editor));

  beforeAll(async () => {
    const clock = new FixedClock(new Date('2026-09-24T13:00:00.000Z'));
    const registry = new CommandHandlerRegistry();
    registerRolePermissionCommands(registry);
    pipeline = new CommandPipelineService(db, registry, clock, new Uuidv7Generator(clock));
    for (const code of [HELD_ALL, HELD_SITE, NOT_HELD]) await testPermission(code);
    await testPermission(DEPRECATED, true);
    editor = await db.transaction().execute((trx) => insertTestUser(trx));
    editorDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, editor, { status: 'ACTIVE' }));
    await db.transaction().execute(async (trx) => {
      const role = await insertTestRole(trx, editor);
      await grantTestPermission(trx, role, 'identity.role.manage', editor);
      await grantTestPermission(trx, role, HELD_ALL, editor, { maxScope: 'ALL' });
      await grantTestPermission(trx, role, HELD_SITE, editor, { maxScope: 'SITE' });
      await assignTestRole(trx, editor, role, editor);
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('octroi, changement de portée puis retrait : l’état suit, le journal garde chaque pas avec son motif', async () => {
    const target = await newTargetRole();
    const grant = await run(editor, editorDevice, target, {
      permissionCode: HELD_ALL,
      maxScope: 'SITE',
      reason: 'Le responsable de site valide les dépenses.',
    });
    expect(grant.status, JSON.stringify(grant)).toBe('APPLIED');
    expect(await scopeOf(target, HELD_ALL)).toBe('SITE');

    const widen = await run(editor, editorDevice, target, {
      permissionCode: HELD_ALL,
      maxScope: 'ALL',
      reason: 'Étendu à toute l’entreprise.',
    });
    expect(widen.status, JSON.stringify(widen)).toBe('APPLIED');
    expect(await scopeOf(target, HELD_ALL)).toBe('ALL');

    const revoke = await run(editor, editorDevice, target, {
      permissionCode: HELD_ALL,
      maxScope: null,
      reason: 'Retiré après la revue des droits.',
    });
    expect(revoke.status, JSON.stringify(revoke)).toBe('APPLIED');
    expect(await scopeOf(target, HELD_ALL)).toBeNull();

    const journal = await journalOf(target);
    expect(
      journal.map((row) => [row.change_type, row.scope_before, row.scope_after, row.reason]),
    ).toEqual([
      ['GRANT', null, 'SITE', 'Le responsable de site valide les dépenses.'],
      ['SCOPE', 'SITE', 'ALL', 'Étendu à toute l’entreprise.'],
      ['REVOKE', 'ALL', null, 'Retiré après la revue des droits.'],
    ]);
    expect(journal.every((row) => fromBin(row.changed_by) === editor)).toBe(true);
  });

  it('on ne donne que ce qu’on a : permission non détenue, ou portée plus large que la sienne, refusée', async () => {
    const target = await newTargetRole();
    const refused = await run(editor, editorDevice, target, {
      permissionCode: NOT_HELD,
      maxScope: 'OWN',
      reason: 'Essai.',
    });
    expect(refused).toMatchObject({ status: 'REJECTED', error: { code: 'NOT_HELD' } });
    expect(
      await run(editor, editorDevice, target, {
        permissionCode: HELD_SITE,
        maxScope: 'ALL',
        reason: 'Essai.',
      }),
    ).toMatchObject({ status: 'REJECTED', error: { code: 'NOT_HELD' } });
    expect(
      await run(editor, editorDevice, target, {
        permissionCode: HELD_SITE,
        maxScope: 'ZONE',
        reason: 'Essai.',
      }),
    ).toMatchObject({ status: 'REJECTED', error: { code: 'NOT_HELD' } });
    const own = await run(editor, editorDevice, target, {
      permissionCode: HELD_SITE,
      maxScope: 'SITE',
      reason: 'Sa propre portée : accepté.',
    });
    expect(own.status, JSON.stringify(own)).toBe('APPLIED');
    // Un refus n'écrit rien.
    expect((await journalOf(target)).map((row) => row.permission_code)).toEqual([HELD_SITE]);
  });

  it('rôle ADMIN figé, droit de modifier les droits jamais modifiable, aucun changement : refusés sans écriture', async () => {
    const adminRole = await db
      .selectFrom('identity_roles')
      .select('id')
      .where('code', '=', 'ADMIN')
      .executeTakeFirstOrThrow();
    expect(
      await run(editor, editorDevice, fromBin(adminRole.id), {
        permissionCode: HELD_ALL,
        maxScope: 'ALL',
        reason: 'Essai.',
      }),
    ).toMatchObject({ status: 'REJECTED', error: { code: 'ROLE_PROTECTED' } });
    const target = await newTargetRole();
    expect(
      await run(editor, editorDevice, target, {
        permissionCode: 'identity.role.manage',
        maxScope: 'ALL',
        reason: 'Essai.',
      }),
    ).toMatchObject({ status: 'REJECTED', error: { code: 'PERMISSION_PROTECTED' } });
    expect(
      await run(editor, editorDevice, target, {
        permissionCode: HELD_ALL,
        maxScope: null,
        reason: 'Rien à retirer.',
      }),
    ).toMatchObject({ status: 'REJECTED', error: { code: 'NO_CHANGE' } });
    expect(await journalOf(target)).toEqual([]);
  });

  it('rejeu de la même commande : un seul changement au journal', async () => {
    const target = await newTargetRole();
    const commandId = freshUuid();
    const payload = { permissionCode: HELD_ALL, maxScope: 'OWN', reason: 'Rejeu.' };
    expect((await run(editor, editorDevice, target, payload, commandId)).status).toBe('APPLIED');
    await run(editor, editorDevice, target, payload, commandId);
    expect(await journalOf(target)).toHaveLength(1);
    expect(await scopeOf(target, HELD_ALL)).toBe('OWN');
  });

  it('permission dépréciée : refusée sans écriture (PERMISSION_DEPRECATED)', async () => {
    const target = await newTargetRole();
    expect(
      await run(editor, editorDevice, target, {
        permissionCode: DEPRECATED,
        maxScope: 'OWN',
        reason: 'Essai.',
      }),
    ).toMatchObject({ status: 'REJECTED', error: { code: 'PERMISSION_DEPRECATED' } });
    expect(await journalOf(target)).toEqual([]);
    expect(await scopeOf(target, DEPRECATED)).toBeNull();
  });

  it('sans identity.role.manage : refusé avant toute écriture', async () => {
    const stranger = await db.transaction().execute((trx) => insertTestUser(trx));
    const strangerDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, stranger, { status: 'ACTIVE' }));
    const target = await newTargetRole();
    const result = await run(stranger, strangerDevice, target, {
      permissionCode: HELD_ALL,
      maxScope: 'OWN',
      reason: 'Essai.',
    });
    expect(result.status).toBe('REJECTED');
    expect(await journalOf(target)).toEqual([]);
  });

  it('le droit changé s’applique aux titulaires du rôle : cache RBAC invalidé par l’événement, tout entier (ADR-072)', async () => {
    const target = await newTargetRole();
    const holder = await db.transaction().execute((trx) => insertTestUser(trx));
    await db.transaction().execute((trx) => assignTestRole(trx, holder, target, editor));
    const now = new Date('2026-09-24T13:00:00.000Z');
    const holds = () => hasPermissionAt(db, toBin(holder), HELD_ALL, now);

    const consumers = new EventConsumerRegistry();
    registerRbacCacheConsumer(consumers);
    const runner = new EventConsumerRunner(db, consumers);
    const drain = async () => {
      let batch;
      do {
        batch = await runner.processOnce('identity.rbac_cache', {
          batchSize: 500,
          settleSeconds: 0,
        });
      } while (batch.processed + batch.failed === 500);
    };

    // La file d'événements est partagée par toute la suite et par ses lancements successifs : le consommateur repart
    // de sa tête (le cache RBAC est propre au processus), comme dans role-assignment-commands.test.ts.
    const head = await db
      .selectFrom('platform_domain_events')
      .select((eb) => eb.fn.max('seq').as('top'))
      .executeTakeFirst();
    const headSeq = Number(head?.top ?? 0);
    await db
      .insertInto('platform_event_consumer_offsets')
      .values({ consumer_name: 'identity.rbac_cache', last_seq: headSeq, last_error: null })
      .onDuplicateKeyUpdate({ last_seq: headSeq, last_error: null })
      .execute();

    // Amorce le cache du titulaire : son rôle n'a pas encore le droit.
    expect(await holds()).toBe(false);
    const grant = await run(editor, editorDevice, target, {
      permissionCode: HELD_ALL,
      maxScope: 'ALL',
      reason: 'Octroi.',
    });
    expect(grant.status).toBe('APPLIED');
    // Toujours périmé : le consommateur n'a pas encore traité l'événement.
    expect(await holds()).toBe(false);
    await drain();
    expect(await holds()).toBe(true);

    const withdrawal = await run(editor, editorDevice, target, {
      permissionCode: HELD_ALL,
      maxScope: null,
      reason: 'Retrait.',
    });
    expect(withdrawal.status).toBe('APPLIED');
    expect(await holds()).toBe(true);
    await drain();
    expect(await holds()).toBe(false);
  });
});
