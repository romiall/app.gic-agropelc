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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Clock } from '@gic/domain';
import type { CommandResult } from '@gic/contracts';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import {
  closeTestDb,
  db,
  freshPhone,
  freshUuid,
  insertTestDevice,
  insertTestSite,
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
  };
  readonly [key: string]: unknown;
}

describe('MP-13 : création de compte et affectations de rôle', { timeout: 180_000 }, () => {
  let app: NestFastifyApplication;
  let clock: Clock;
  let pipeline: CommandPipelineService;
  let root: string;
  let s1: string;
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
  ): Promise<CommandResult> => {
    const now = new Date().toISOString();
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
      .select(['id', 'status', 'must_change_password', 'password_hash', 'full_name', 'email'])
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
      const zone = await insertTestZone(trx, root);
      s1 = await insertTestSite(trx, root, zone, { siteType: 'POINT_DE_VENTE' });
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
    const inbox = await db
      .selectFrom('sync_command_inbox')
      .select('command_id')
      .where('user_id', '=', toBin(admin.userId))
      .where('command_type', '=', 'identity.user.create')
      .execute();
    expect(inbox).toHaveLength(0);

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
    expect(JSON.stringify(roles)).not.toContain('permission');

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
    });
    expect(forAdmin.suspended!.actions).toEqual({
      resetPassword: true,
      suspend: false,
      reactivate: true,
      deactivate: true,
      manageRoles: true,
    });
    expect(forAdmin.deactivated!.actions).toEqual({
      resetPassword: false,
      suspend: false,
      reactivate: true,
      deactivate: false,
      manageRoles: false,
    });
    // Soi-même : ni suspension, ni désactivation, ni réinitialisation ; les rôles restent gérables.
    expect(forAdmin.self!.actions).toMatchObject({
      resetPassword: false,
      suspend: false,
      deactivate: false,
    });

    // Un lecteur sans le droit de gérer ne voit aucune de ces actions.
    const forFerme = await readUser(respFerme, activeBody.id);
    expect(forFerme!.actions).toEqual({
      resetPassword: false,
      suspend: false,
      reactivate: false,
      deactivate: false,
      manageRoles: false,
    });

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
});
