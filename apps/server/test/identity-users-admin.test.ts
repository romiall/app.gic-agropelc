/**
 * MP-13 — comptes et affectations de rôle gérés depuis l'application (ECR-ADM-04 complet ; AV-325,
 * AV-326 ; ADR-045) : création d'un compte par l'Admin hors du journal des commandes (`POST /users`,
 * mot de passe provisoire jamais journalisé, affectation initiale dans la même transaction, tout ou
 * rien), lecture des rôles (`GET /roles`), affectations actives et actions permises de `GET /users`.
 * Application complète, rôles réels du seed.
 *
 * Les mots de passe ci-dessous sont des valeurs de test, propres à ce fichier.
 */
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Clock } from '@gic/domain';
import type { CommandResult } from '@gic/contracts';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { appLogger } from '../src/platform/observability/logger.js';
import {
  closeTestDb,
  db,
  freshPhone,
  freshUuid,
  assignTestRole,
  grantTestPermission,
  insertTestDevice,
  insertTestRole,
  insertTestSite,
  insertTestTeam,
  insertTestUser,
  insertTestZone,
  signTestAccessToken,
} from './helpers.js';
import { newActor, roleIdOf, tx, type Actor } from './cash-transfer-fixtures.js';

const PROVISIONAL = 'provisoire-mp13';

const RUN_OCTET = randomInt(256);
let ipCounter = 0;
const freshIp = () => `10.81.${RUN_OCTET}.${(++ipCounter % 254) + 1}`;
let deviceSeq = 0;

interface UserEntry {
  readonly id: string;
  readonly status: string;
  readonly roles: readonly string[];
  readonly assignments: readonly {
    readonly id: string;
    readonly roleCode: string;
    readonly roleName: string;
    readonly scopeType: string;
    readonly scopeSiteId: string | null;
    readonly validTo: string | null;
  }[];
  readonly actions: {
    readonly resetPassword: boolean;
    readonly suspend: boolean;
    readonly reactivate: boolean;
    readonly deactivate: boolean;
    readonly manageRoles: boolean;
    readonly revokeRoles: boolean;
  };
  readonly [key: string]: unknown;
}

describe('MP-13 : création de compte et affectations de rôle', { timeout: 180_000 }, () => {
  let app: NestFastifyApplication;
  let clock: Clock;
  let pipeline: CommandPipelineService;
  let root: string;
  let s1: string;
  let zone1: string;
  let admin: Actor;
  let direction: Actor;
  let respFerme: Actor;
  let sellerRole: string;
  let adminRole: string;

  const tokenOf = (actor: Actor) =>
    signTestAccessToken(
      app.get(JWT_KEYS).privateKey,
      { sub: actor.userId, device_id: actor.deviceId, session_id: freshUuid() },
      clock.now(),
    );
  const get = async (actor: Actor, url: string) =>
    app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${await tokenOf(actor)}` },
    });
  const create = async (actor: Actor, payload: unknown) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { authorization: `Bearer ${await tokenOf(actor)}` },
      payload: payload as object,
    });
  const login = (phone: string, password: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: freshIp(),
      payload: { phone, password, device_id: freshUuid() },
    });
  const command = (
    actor: Actor,
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    payload: unknown,
    occurredAt: Date = new Date(),
  ): Promise<CommandResult> => {
    const now = occurredAt.toISOString();
    return pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: commandType,
        aggregate_type: aggregateType,
        aggregate_id: aggregateId,
        author_user_id: actor.userId,
        base_version: null,
        depends_on: [],
        occurred_at: now,
        client_created_at: now,
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload,
      },
      {
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        transport: 'ONLINE_API' as const,
      },
    );
  };
  /** Compte du test lu par l'acteur, toutes pages (le compte a été créé après les autres : en tête). */
  const readUser = async (reader: Actor, id: string): Promise<UserEntry | undefined> => {
    let cursor: string | null = null;
    for (let page = 0; page < 500; page++) {
      const response = await get(
        reader,
        `/api/v1/users?limit=200${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as { users: UserEntry[]; next_cursor: string | null };
      const found = body.users.find((user) => user.id === id);
      if (found) return found;
      cursor = body.next_cursor;
      if (cursor === null) return undefined;
    }
    return undefined;
  };
  const userByPhone = (phone: string) =>
    db
      .selectFrom('identity_users')
      .select([
        'id',
        'status',
        'must_change_password',
        'password_hash',
        'full_name',
        'email',
        'created_by',
      ])
      .where('phone', '=', phone)
      .executeTakeFirst();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerCorrelationId(app, app.get(ID_GENERATOR));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    clock = app.get(CLOCK);
    pipeline = app.get(CommandPipelineService);

    root = await tx((trx) => insertTestUser(trx));
    await tx(async (trx) => {
      zone1 = await insertTestZone(trx, root);
      s1 = await insertTestSite(trx, root, zone1, { siteType: 'POINT_DE_VENTE' });
    });
    admin = await newActor('ADMIN', root);
    direction = await newActor('DIRECTION', root);
    respFerme = await newActor('RESP_FERME', root, { scopeType: 'SITE', scopeSiteId: s1 });
    sellerRole = await roleIdOf('VENDEUR_PDV');
    adminRole = await roleIdOf('ADMIN');
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('crée un compte avec son premier rôle : mot de passe provisoire jamais journalisé, compte et affectation écrits, audit sans secret', async () => {
    const phone = await freshPhone();
    const response = await create(admin, {
      full_name: 'Paul Essomba',
      phone,
      email: 'paul@gic-agropelc.test',
      password: PROVISIONAL,
      role: { role_id: sellerRole, scope_type: 'SITE', scope_site_id: s1 },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.body).not.toContain(PROVISIONAL);
    const body = response.json() as { id: string; role_assignment_id: string; status: string };
    expect(body).toMatchObject({ status: 'ACTIVE', must_change_password: true });

    const row = await userByPhone(phone);
    expect(row).toMatchObject({
      status: 'ACTIVE',
      must_change_password: 1,
      email: 'paul@gic-agropelc.test',
    });
    expect(row!.password_hash).not.toContain(PROVISIONAL);
    const assignment = await db
      .selectFrom('identity_user_role_assignments')
      .select(['role_id', 'scope_type', 'scope_site_id', 'revoked_at', 'valid_to'])
      .where('user_id', '=', row!.id)
      .execute();
    expect(assignment).toHaveLength(1);
    expect(assignment[0]).toMatchObject({ scope_type: 'SITE', revoked_at: null, valid_to: null });

    // Hors du journal des commandes : aucune ligne dans la boîte de réception, aucun événement.
    const audit = await db
      .selectFrom('audit_audit_log')
      .selectAll()
      .where('entity_id', '=', row!.id)
      .execute();
    expect(audit.map((entry) => [entry.action, entry.result])).toEqual([
      ['identity.user.create', 'SUCCESS'],
    ]);
    expect(JSON.stringify(audit)).not.toContain(PROVISIONAL);
    expect(JSON.stringify(audit)).not.toContain(phone);
    // Création attribuée à l'Admin et à son appareil ; le rôle et le périmètre initiaux y figurent.
    expect(fromBin(audit[0]!.actor_user_id!)).toBe(admin.userId);
    expect(fromBin(audit[0]!.device_id!)).toBe(admin.deviceId);
    const after: unknown =
      typeof audit[0]!.after === 'string' ? JSON.parse(audit[0]!.after) : audit[0]!.after;
    expect(after).toEqual({
      status: 'ACTIVE',
      must_change_password: true,
      role_assignment_id: body.role_assignment_id,
      role_id: sellerRole,
      scope_type: 'SITE',
      scope_site_id: s1,
    });
    expect(fromBin(row!.created_by)).toBe(admin.userId);
    const inbox = await db
      .selectFrom('sync_command_inbox')
      .select(['command_type', 'payload'])
      .where('user_id', '=', toBin(admin.userId))
      .execute();
    expect(inbox.filter((entry) => entry.command_type === 'identity.user.create')).toEqual([]);
    expect(JSON.stringify(inbox)).not.toContain(PROVISIONAL);
    const events = await db
      .selectFrom('platform_domain_events')
      .select('event_type')
      .where('aggregate_id', 'in', [row!.id, toBin(body.role_assignment_id)])
      .execute();
    expect(events).toEqual([]);

    // Flux de changements : les appareils tirent le compte (jeu `user`) et son affectation.
    const feed = await db
      .selectFrom('sync_change_feed')
      .select(['dataset', 'entity_type', 'scope_type', 'scope_id', 'change_type'])
      .where('entity_id', 'in', [row!.id, toBin(body.role_assignment_id)])
      .orderBy('seq')
      .execute();
    expect(feed).toEqual([
      {
        dataset: 'user',
        entity_type: 'USER',
        scope_type: 'GLOBAL',
        scope_id: null,
        change_type: 'UPSERT',
      },
      {
        dataset: 'role_assignment',
        entity_type: 'ROLE_ASSIGNMENT',
        scope_type: 'GLOBAL',
        scope_id: null,
        change_type: 'UPSERT',
      },
    ]);

    // Le provisoire ouvre une session avec le changement imposé (AV-251).
    const session = await login(phone, PROVISIONAL);
    expect(session.statusCode, session.body).toBe(200);
    expect((session.json() as { must_change_password: boolean }).must_change_password).toBe(true);

    // La liste montre le compte avec son affectation (identifiant, rôle, site) et ce que l'Admin y peut.
    const listed = await readUser(admin, body.id);
    expect(listed).toMatchObject({
      status: 'ACTIVE',
      roles: ['VENDEUR_PDV'],
      actions: { resetPassword: true, suspend: true, deactivate: true, manageRoles: true },
    });
    expect(listed!.assignments).toEqual([
      expect.objectContaining({
        id: body.role_assignment_id,
        roleCode: 'VENDEUR_PDV',
        scopeType: 'SITE',
        scopeSiteId: s1,
        validTo: null,
      }),
    ]);
    expect(listed!.actions.reactivate).toBe(false);
  });

  it('crée un compte sans rôle : aucune affectation', async () => {
    const phone = await freshPhone();
    const response = await create(admin, {
      full_name: 'Compte sans rôle',
      phone,
      password: PROVISIONAL,
    });
    expect(response.statusCode, response.body).toBe(201);
    const row = await userByPhone(phone);
    const assignments = await db
      .selectFrom('identity_user_role_assignments')
      .select('id')
      .where('user_id', '=', row!.id)
      .execute();
    expect(assignments).toHaveLength(0);
    expect(row!.email).toBeNull();
    const feed = await db
      .selectFrom('sync_change_feed')
      .select('dataset')
      .where('entity_id', '=', row!.id)
      .execute();
    expect(feed).toEqual([{ dataset: 'user' }]);
  });

  it('gardes : droit, droit d’affecter, appareil en attente, données invalides sans écho du mot de passe', async () => {
    const phone = await freshPhone();
    // Sans `identity.user.manage` : refus audité.
    const refused = await create(direction, {
      full_name: 'Refusé',
      phone,
      password: PROVISIONAL,
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    const deniedAudit = await db
      .selectFrom('audit_audit_log')
      .select(['result', 'error_code'])
      .where('actor_user_id', '=', toBin(direction.userId))
      .where('action', '=', 'identity.user.create')
      .execute();
    expect(deniedAudit).toEqual([{ result: 'DENIED', error_code: 'FORBIDDEN' }]);
    expect(await userByPhone(phone)).toBeUndefined();

    // Appareil en attente d'approbation (RC-02).
    const pendingAdmin: Actor = {
      userId: admin.userId,
      deviceId: await tx((trx) => insertTestDevice(trx, admin.userId, { status: 'PENDING' })),
    };
    const fromPending = await create(pendingAdmin, {
      full_name: 'Refusé',
      phone,
      password: PROVISIONAL,
    });
    expect(fromPending.statusCode).toBe(403);
    expect(fromPending.json()).toMatchObject({ error: { code: 'DEVICE_PENDING' } });
    expect(await userByPhone(phone)).toBeUndefined();

    // Données invalides : 400 sans jamais répéter le mot de passe.
    for (const payload of [
      { full_name: '', phone, password: PROVISIONAL },
      { full_name: 'X', phone: '690000000', password: PROVISIONAL },
      { full_name: 'X', phone },
      { full_name: 'X', phone, password: PROVISIONAL, email: 'pas-un-courriel' },
      {
        full_name: 'X',
        phone,
        password: PROVISIONAL,
        role: { role_id: sellerRole, scope_type: 'SITE' },
      },
    ]) {
      const invalid = await create(admin, payload);
      expect(invalid.statusCode, JSON.stringify(payload)).toBe(400);
      expect(invalid.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
      expect(invalid.body).not.toContain(PROVISIONAL);
    }
    const weak = await create(admin, { full_name: 'X', phone, password: 'court' });
    expect(weak.statusCode).toBe(400);
    expect(weak.json()).toMatchObject({ error: { code: 'PASSWORD_INVALID' } });
    expect(await userByPhone(phone)).toBeUndefined();
  });

  it('numéro déjà pris par un compte actif : 409 ; repris après désactivation du premier', async () => {
    const phone = await freshPhone();
    const first = await create(admin, { full_name: 'Premier', phone, password: PROVISIONAL });
    expect(first.statusCode, first.body).toBe(201);
    const duplicate = await create(admin, { full_name: 'Second', phone, password: PROVISIONAL });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: { code: 'PHONE_ALREADY_USED' } });

    const firstId = (first.json() as { id: string }).id;
    const deactivated = await command(admin, 'identity.user.deactivate', 'USER', firstId, {
      reason: 'Départ',
    });
    expect(deactivated.status, JSON.stringify(deactivated)).toBe('APPLIED');
    const again = await create(admin, { full_name: 'Repreneur', phone, password: PROVISIONAL });
    expect(again.statusCode, again.body).toBe(201);
  });

  it('affectation initiale refusée : tout ou rien, aucun compte créé', async () => {
    const attempts: readonly {
      readonly code: string;
      readonly status: number;
      readonly role: object;
    }[] = [
      {
        code: 'SCOPE_TYPE_NOT_ALLOWED',
        status: 400,
        role: { role_id: sellerRole, scope_type: 'GLOBAL' },
      },
      {
        code: 'NOT_FOUND',
        status: 404,
        role: { role_id: freshUuid(), scope_type: 'GLOBAL' },
      },
      {
        code: 'NOT_FOUND',
        status: 404,
        role: { role_id: sellerRole, scope_type: 'SITE', scope_site_id: freshUuid() },
      },
    ];
    for (const attempt of attempts) {
      const phone = await freshPhone();
      const response = await create(admin, {
        full_name: 'Tout ou rien',
        phone,
        password: PROVISIONAL,
        role: attempt.role,
      });
      expect(response.statusCode, response.body).toBe(attempt.status);
      expect(response.json()).toMatchObject({ error: { code: attempt.code } });
      expect(await userByPhone(phone)).toBeUndefined();
    }
  });

  it('GET /roles : rôles actifs avec leurs périmètres permis, réservé à qui affecte', async () => {
    const response = await get(admin, '/api/v1/roles');
    expect(response.statusCode, response.body).toBe(200);
    const { roles } = response.json() as {
      roles: { id: string; code: string; name: string; allowedScopeTypes: string[] }[];
    };
    const byCode = new Map(roles.map((role) => [role.code, role]));
    expect(byCode.get('VENDEUR_PDV')).toMatchObject({
      id: sellerRole,
      allowedScopeTypes: expect.arrayContaining(['SITE']),
    });
    expect(byCode.get('ADMIN')).toMatchObject({
      id: adminRole,
      allowedScopeTypes: expect.arrayContaining(['GLOBAL']),
    });
    expect(roles.every((role) => typeof role.name === 'string' && role.name.length > 0)).toBe(true);
    for (const role of roles) {
      expect(Object.keys(role).sort()).toEqual([
        'allowedScopeTypes',
        'code',
        'description',
        'id',
        'isSystem',
        'name',
      ]);
    }

    expect((await get(direction, '/api/v1/roles')).statusCode).toBe(403);
    expect((await get(respFerme, '/api/v1/roles')).statusCode).toBe(403);
  });

  it('GET /users : actions selon l’état et le lecteur, affectation retirée absente de la liste', async () => {
    const active = await create(admin, {
      full_name: 'Actif MP-13',
      phone: await freshPhone(),
      password: PROVISIONAL,
      role: { role_id: sellerRole, scope_type: 'SITE', scope_site_id: s1 },
    });
    const activeBody = active.json() as { id: string; role_assignment_id: string };
    const suspendedId = await tx((trx) => insertTestUser(trx, { status: 'SUSPENDED' }));
    const deactivatedId = await tx((trx) => insertTestUser(trx, { status: 'DEACTIVATED' }));

    const forAdmin = {
      active: await readUser(admin, activeBody.id),
      suspended: await readUser(admin, suspendedId),
      deactivated: await readUser(admin, deactivatedId),
      self: await readUser(admin, admin.userId),
    };
    expect(forAdmin.active!.actions).toEqual({
      resetPassword: true,
      suspend: true,
      reactivate: false,
      deactivate: true,
      manageRoles: true,
      revokeRoles: true,
    });
    expect(forAdmin.suspended!.actions).toEqual({
      resetPassword: true,
      suspend: false,
      reactivate: true,
      deactivate: true,
      manageRoles: true,
      revokeRoles: true,
    });
    // Désactivé : plus d'octroi, mais ses rôles restants se retirent sans le réactiver.
    expect(forAdmin.deactivated!.actions).toEqual({
      resetPassword: false,
      suspend: false,
      reactivate: true,
      deactivate: false,
      manageRoles: false,
      revokeRoles: true,
    });
    // Soi-même : ni suspension, ni désactivation, ni réinitialisation ; les rôles restent gérables
    // (AV-327).
    expect(forAdmin.self!.actions).toEqual({
      resetPassword: false,
      suspend: false,
      reactivate: false,
      deactivate: false,
      manageRoles: true,
      revokeRoles: true,
    });

    // Un lecteur sans le droit de gérer ne voit aucune de ces actions, ni le détail des affectations
    // (leurs sites peuvent sortir de sa portée) : les codes de rôle seulement.
    const forFerme = await readUser(respFerme, activeBody.id);
    expect(forFerme!.actions).toEqual({
      resetPassword: false,
      suspend: false,
      reactivate: false,
      deactivate: false,
      manageRoles: false,
      revokeRoles: false,
    });
    expect(forFerme!.roles).toEqual(['VENDEUR_PDV']);
    expect(forFerme!.assignments).toEqual([]);

    // Affectation retirée par la commande de révocation : elle quitte la liste, le compte garde son état.
    const revoked = await command(
      admin,
      'identity.role_assignment.revoke',
      'ROLE_ASSIGNMENT',
      activeBody.role_assignment_id,
      { reason: 'Changement de poste' },
    );
    expect(revoked.status, JSON.stringify(revoked)).toBe('APPLIED');
    const after = await readUser(admin, activeBody.id);
    expect(after!.assignments).toEqual([]);
    expect(after!.roles).toEqual([]);
    expect(after!.status).toBe('ACTIVE');
  });

  it('octroi par commande après le refactor de l’écriture partagée : mêmes contrôles qu’avant', async () => {
    const created = await create(admin, {
      full_name: 'Octroi MP-13',
      phone: await freshPhone(),
      password: PROVISIONAL,
    });
    const userId = (created.json() as { id: string }).id;
    const grant = (payload: object, aggregateId = freshUuid()) =>
      command(admin, 'identity.role_assignment.grant', 'ROLE_ASSIGNMENT', aggregateId, payload);

    const granted = await grant({ userId, roleId: adminRole, scopeType: 'GLOBAL' });
    expect(granted.status, JSON.stringify(granted)).toBe('APPLIED');
    const wrongScope = await grant({ userId, roleId: sellerRole, scopeType: 'GLOBAL' });
    expect(wrongScope).toMatchObject({
      status: 'REJECTED',
      error: { code: 'SCOPE_TYPE_NOT_ALLOWED' },
    });
    const unknownRole = await grant({ userId, roleId: freshUuid(), scopeType: 'GLOBAL' });
    expect(unknownRole).toMatchObject({ status: 'REJECTED', error: { code: 'NOT_FOUND' } });
    const unknownUser = await grant({
      userId: freshUuid(),
      roleId: adminRole,
      scopeType: 'GLOBAL',
    });
    expect(unknownUser).toMatchObject({ status: 'REJECTED', error: { code: 'NOT_FOUND' } });
    // Rejeu du même identifiant d'affectation : sans effet (idempotence).
    const assignmentId = freshUuid();
    const first = await grant(
      { userId, roleId: sellerRole, scopeType: 'SITE', scopeSiteId: s1 },
      assignmentId,
    );
    expect(first.status).toBe('APPLIED');
    const replay = await grant(
      { userId, roleId: sellerRole, scopeType: 'SITE', scopeSiteId: s1 },
      assignmentId,
    );
    expect(replay.status).toBe('APPLIED');
    const rows = await db
      .selectFrom('identity_user_role_assignments')
      .select('id')
      .where('user_id', '=', toBin(userId))
      .execute();
    expect(rows).toHaveLength(2);
  });

  it('droit d’affecter : `identity.user.manage` sans `identity.role_assignment.manage` crée sans rôle, jamais avec', async () => {
    const managerOnly = await tx(async (trx) => {
      const roleId = await insertTestRole(trx, root);
      await grantTestPermission(trx, roleId, 'identity.user.manage', root);
      const userId = await insertTestUser(trx);
      const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
      await assignTestRole(trx, userId, roleId, root);
      return { userId, deviceId };
    });
    const phone = await freshPhone();
    const withRole = await create(managerOnly, {
      full_name: 'Avec rôle',
      phone,
      password: PROVISIONAL,
      role: { role_id: adminRole, scope_type: 'GLOBAL' },
    });
    expect(withRole.statusCode, withRole.body).toBe(403);
    expect(withRole.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(await userByPhone(phone)).toBeUndefined();
    const denied = await db
      .selectFrom('audit_audit_log')
      .select(['result', 'error_code'])
      .where('actor_user_id', '=', toBin(managerOnly.userId))
      .where('action', '=', 'identity.user.create')
      .execute();
    expect(denied).toEqual([{ result: 'DENIED', error_code: 'FORBIDDEN' }]);

    const withoutRole = await create(managerOnly, {
      full_name: 'Sans rôle',
      phone,
      password: PROVISIONAL,
    });
    expect(withoutRole.statusCode, withoutRole.body).toBe(201);
  });

  it('numéro : un compte suspendu le garde ; deux créations simultanées du même numéro donnent un 201 et un 409', async () => {
    const suspendedId = await tx((trx) => insertTestUser(trx, { status: 'SUSPENDED' }));
    const suspended = await db
      .selectFrom('identity_users')
      .select('phone')
      .where('id', '=', toBin(suspendedId))
      .executeTakeFirstOrThrow();
    const onSuspended = await create(admin, {
      full_name: 'Sur un suspendu',
      phone: suspended.phone,
      password: PROVISIONAL,
    });
    expect(onSuspended.statusCode, onSuspended.body).toBe(409);
    expect(onSuspended.json()).toMatchObject({ error: { code: 'PHONE_ALREADY_USED' } });

    const phone = await freshPhone();
    const both = await Promise.all([
      create(admin, { full_name: 'Course A', phone, password: PROVISIONAL }),
      create(admin, { full_name: 'Course B', phone, password: PROVISIONAL }),
    ]);
    expect(both.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const rows = await db
      .selectFrom('identity_users')
      .select('id')
      .where('phone', '=', phone)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('réactivation d’un compte désactivé dont le numéro a été repris : action masquée, commande refusée définitivement', async () => {
    const phone = await freshPhone();
    const first = await create(admin, { full_name: 'Ancien', phone, password: PROVISIONAL });
    const firstId = (first.json() as { id: string }).id;
    const deactivated = await command(admin, 'identity.user.deactivate', 'USER', firstId, {
      reason: 'Départ',
    });
    expect(deactivated.status, JSON.stringify(deactivated)).toBe('APPLIED');
    expect((await readUser(admin, firstId))!.actions.reactivate).toBe(true);

    const second = await create(admin, { full_name: 'Repreneur', phone, password: PROVISIONAL });
    expect(second.statusCode, second.body).toBe(201);
    expect((await readUser(admin, firstId))!.actions.reactivate).toBe(false);
    const reactivated = await command(admin, 'identity.user.reactivate', 'USER', firstId, {});
    expect(reactivated).toMatchObject({
      status: 'REJECTED',
      error: { code: 'PHONE_ALREADY_USED' },
    });
    const row = await db
      .selectFrom('identity_users')
      .select('status')
      .where('id', '=', toBin(firstId))
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('DEACTIVATED');
  });

  it('soi-même : suspendre ou désactiver son propre compte est refusé par la commande', async () => {
    // Un second Admin existe : le refus ne vient pas de INV-ADM-01.
    await newActor('ADMIN', root);
    for (const [commandType, payload] of [
      ['identity.user.suspend', { reason: 'Essai' }],
      ['identity.user.deactivate', { reason: 'Essai' }],
    ] as const) {
      const result = await command(admin, commandType, 'USER', admin.userId, payload);
      expect(result, commandType).toMatchObject({
        status: 'REJECTED',
        error: { code: 'OWN_ACCOUNT' },
      });
    }
    // Même compte écrit en majuscules : toujours lui.
    const upper = await command(
      admin,
      'identity.user.suspend',
      'USER',
      admin.userId.toUpperCase(),
      {
        reason: 'Essai',
      },
    );
    expect(upper).toMatchObject({ status: 'REJECTED', error: { code: 'OWN_ACCOUNT' } });
    const row = await db
      .selectFrom('identity_users')
      .select('status')
      .where('id', '=', toBin(admin.userId))
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('ACTIVE');
  });

  it('rôle désactivé : absent de GET /roles, refusé à la création et à l’octroi, affectation existante retirée de la liste', async () => {
    const holder = await tx((trx) => insertTestUser(trx));
    const roleId = await tx(async (trx) => {
      const id = await insertTestRole(trx, root);
      await assignTestRole(trx, holder, id, root);
      return id;
    });
    expect((await readUser(admin, holder))!.assignments).toHaveLength(1);
    await db
      .updateTable('identity_roles')
      .set({ is_active: 0 })
      .where('id', '=', toBin(roleId))
      .execute();

    const roles = (await get(admin, '/api/v1/roles')).json() as { roles: { id: string }[] };
    expect(roles.roles.map((role) => role.id)).not.toContain(roleId);

    const phone = await freshPhone();
    const created = await create(admin, {
      full_name: 'Rôle inactif',
      phone,
      password: PROVISIONAL,
      role: { role_id: roleId, scope_type: 'GLOBAL' },
    });
    expect(created.statusCode, created.body).toBe(400);
    expect(created.json()).toMatchObject({ error: { code: 'ROLE_INACTIVE' } });
    expect(await userByPhone(phone)).toBeUndefined();

    const granted = await command(
      admin,
      'identity.role_assignment.grant',
      'ROLE_ASSIGNMENT',
      freshUuid(),
      {
        userId: holder,
        roleId,
        scopeType: 'GLOBAL',
      },
    );
    expect(granted).toMatchObject({ status: 'REJECTED', error: { code: 'ROLE_INACTIVE' } });

    const listed = await readUser(admin, holder);
    expect(listed!.assignments).toEqual([]);
    expect(listed!.roles).toEqual([]);
  });

  it('affectations hors de leur période (échue, pas encore commencée) : absentes de la liste', async () => {
    const holder = await tx((trx) => insertTestUser(trx));
    const now = Date.now();
    await tx(async (trx) => {
      await assignTestRole(trx, holder, sellerRole, root, {
        scopeType: 'SITE',
        scopeSiteId: s1,
        validFrom: new Date(now - 10 * 86_400_000),
        validTo: new Date(now - 86_400_000),
      });
      await assignTestRole(trx, holder, adminRole, root, {
        validFrom: new Date(now + 86_400_000),
      });
    });
    const listed = await readUser(admin, holder);
    expect(listed!.assignments).toEqual([]);
    expect(listed!.roles).toEqual([]);
  });

  it('octroi par commande : échéance, début au fait, auteur ; zones et équipes contrôlées ; création avec un rôle de zone', async () => {
    const userId = (
      (
        await create(admin, {
          full_name: 'Périmètres MP-13',
          phone: await freshPhone(),
          password: PROVISIONAL,
        })
      ).json() as { id: string }
    ).id;
    const fieldRole = await roleIdOf('COMMERCIAL_TERRAIN');
    const leadRole = await roleIdOf('RESP_COMMERCIAL');
    const team = await tx((trx) => insertTestTeam(trx, admin.userId, root));
    const grant = (payload: object, occurredAt?: Date) => {
      const id = freshUuid();
      return command(
        admin,
        'identity.role_assignment.grant',
        'ROLE_ASSIGNMENT',
        id,
        payload,
        occurredAt,
      ).then((result) => ({ id, result }));
    };

    const occurredAt = new Date(Date.now() - 60_000);
    occurredAt.setUTCMilliseconds(0);
    const validTo = new Date(Date.now() + 30 * 86_400_000);
    validTo.setUTCMilliseconds(0);
    const temporary = await grant(
      {
        userId,
        roleId: sellerRole,
        scopeType: 'SITE',
        scopeSiteId: s1,
        validTo: validTo.toISOString(),
      },
      occurredAt,
    );
    expect(temporary.result.status, JSON.stringify(temporary.result)).toBe('APPLIED');
    const row = await db
      .selectFrom('identity_user_role_assignments')
      .select(['valid_from', 'valid_to', 'created_by'])
      .where('id', '=', toBin(temporary.id))
      .executeTakeFirstOrThrow();
    expect(row.valid_from.toISOString()).toBe(occurredAt.toISOString());
    expect(row.valid_to?.toISOString()).toBe(validTo.toISOString());
    expect(fromBin(row.created_by)).toBe(admin.userId);

    const unknownZone = await grant({
      userId,
      roleId: fieldRole,
      scopeType: 'ZONE',
      scopeZoneId: freshUuid(),
    });
    expect(unknownZone.result).toMatchObject({ status: 'REJECTED', error: { code: 'NOT_FOUND' } });
    const zoneGrant = await grant({
      userId,
      roleId: fieldRole,
      scopeType: 'ZONE',
      scopeZoneId: zone1,
    });
    expect(zoneGrant.result.status, JSON.stringify(zoneGrant.result)).toBe('APPLIED');
    const unknownTeam = await grant({
      userId,
      roleId: leadRole,
      scopeType: 'TEAM',
      scopeTeamId: freshUuid(),
    });
    expect(unknownTeam.result).toMatchObject({ status: 'REJECTED', error: { code: 'NOT_FOUND' } });
    const teamGrant = await grant({
      userId,
      roleId: leadRole,
      scopeType: 'TEAM',
      scopeTeamId: team,
    });
    expect(teamGrant.result.status, JSON.stringify(teamGrant.result)).toBe('APPLIED');
    const scoped = await db
      .selectFrom('identity_user_role_assignments')
      .select(['id', 'scope_zone_id', 'scope_team_id', 'scope_site_id'])
      .where('id', 'in', [toBin(zoneGrant.id), toBin(teamGrant.id)])
      .execute();
    const byId = new Map(scoped.map((entry) => [fromBin(entry.id), entry]));
    expect(fromBin(byId.get(zoneGrant.id)!.scope_zone_id!)).toBe(zone1);
    expect(byId.get(zoneGrant.id)!.scope_team_id).toBeNull();
    expect(fromBin(byId.get(teamGrant.id)!.scope_team_id!)).toBe(team);
    expect(byId.get(teamGrant.id)!.scope_zone_id).toBeNull();

    // `POST /users` avec un rôle de zone : le périmètre est écrit tel quel.
    const phone = await freshPhone();
    const created = await create(admin, {
      full_name: 'Commercial de zone',
      phone,
      password: PROVISIONAL,
      role: { role_id: fieldRole, scope_type: 'ZONE', scope_zone_id: zone1 },
    });
    expect(created.statusCode, created.body).toBe(201);
    const assignment = await db
      .selectFrom('identity_user_role_assignments')
      .select(['scope_type', 'scope_zone_id', 'scope_site_id', 'scope_team_id'])
      .where(
        'id',
        '=',
        toBin((created.json() as { role_assignment_id: string }).role_assignment_id),
      )
      .executeTakeFirstOrThrow();
    expect(assignment.scope_type).toBe('ZONE');
    expect(fromBin(assignment.scope_zone_id!)).toBe(zone1);
    expect(assignment.scope_site_id).toBeNull();
    expect(assignment.scope_team_id).toBeNull();
  });

  it('corps JSON mal formé : 400 générique, sans écho ni journal du mot de passe (non-régression)', async () => {
    const secret = 'Fuite-MP13-provisoire';
    const spies = (['info', 'warn', 'error'] as const).map((level) => vi.spyOn(appLogger, level));
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers: {
          authorization: `Bearer ${await tokenOf(admin)}`,
          'content-type': 'application/json',
        },
        payload: `{"full_name":"X","phone":"+237690000000","password":"${secret}" ,}`,
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
      expect(response.body).not.toContain(secret);
      // Le refus est bien journalisé (par ce journal), sous son code et sans le corps.
      expect(JSON.stringify(spies[1]!.mock.calls)).toContain('VALIDATION_ERROR');
      for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('compte désactivé : plus d’octroi de rôle, retrait toujours possible', async () => {
    const created = await create(admin, {
      full_name: 'Désactivé MP-13',
      phone: await freshPhone(),
      password: PROVISIONAL,
      role: { role_id: sellerRole, scope_type: 'SITE', scope_site_id: s1 },
    });
    const { id, role_assignment_id } = created.json() as { id: string; role_assignment_id: string };
    const deactivated = await command(admin, 'identity.user.deactivate', 'USER', id, {
      reason: 'Départ',
    });
    expect(deactivated.status, JSON.stringify(deactivated)).toBe('APPLIED');
    const granted = await command(
      admin,
      'identity.role_assignment.grant',
      'ROLE_ASSIGNMENT',
      freshUuid(),
      {
        userId: id,
        roleId: adminRole,
        scopeType: 'GLOBAL',
      },
    );
    expect(granted).toMatchObject({ status: 'REJECTED', error: { code: 'USER_DEACTIVATED' } });
    const revoked = await command(
      admin,
      'identity.role_assignment.revoke',
      'ROLE_ASSIGNMENT',
      role_assignment_id,
      {
        reason: 'Départ',
      },
    );
    expect(revoked.status, JSON.stringify(revoked)).toBe('APPLIED');
    expect((await readUser(admin, id))!.assignments).toEqual([]);
  });
});
