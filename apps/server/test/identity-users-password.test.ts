/**
 * MP-08 — comptes et mots de passe (AV-251, AV-252, AV-280, AV-281 ; ADR-045 ; INV-AUD-02) :
 * lecture `GET /users` (portée, actions, jamais d'empreinte ni d'utilisateur système), réinitialisation
 * par l'Admin hors du journal des commandes (sessions révoquées, changement imposé, audit sans secret,
 * gardes), changement du mot de passe (règles partagées, mot de passe actuel faux compté), mot de passe
 * provisoire d'un compte créé par commande masqué partout où la charge est conservée, projection `USER`
 * réduite au nom et au statut. Application complète, rôles réels du seed.
 *
 * Les mots de passe ci-dessous sont des valeurs de test, propres à ce fichier.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { signAccessToken } from '../src/modules/identity/application/public/jwt.js';
import { hashPassword } from '../src/modules/identity/application/auth/password.js';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { resolveEntityProjection } from '../src/sync/entity-projections.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshPhone,
  freshUuid,
  insertTestSite,
  insertTestUser,
  insertTestZone,
  type TestAssignmentOptions,
} from './helpers.js';
import { newActor, roleIdOf, tx, type Actor } from './cash-transfer-fixtures.js';

const TEST_PASSWORD = 'mot-de-passe-de-test';
const PROVISIONAL = 'provisoire-mp08';

let ipCounter = 0;
const freshIp = () => `10.80.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;
let deviceSeq = 0;

interface UserEntry {
  readonly id: string;
  readonly fullName: string;
  readonly status: string;
  readonly roles: readonly string[];
  readonly actions: { readonly resetPassword: boolean };
  readonly [key: string]: unknown;
}

describe('MP-08 : comptes et mots de passe', { timeout: 180_000 }, () => {
  let app: NestFastifyApplication;
  let clock: Clock;
  let pipeline: CommandPipelineService;
  let root: string;
  let s1: string;
  let admin: Actor;
  let direction: Actor;
  let respFerme: Actor;
  let vendeur: Actor;
  let targetS1: { id: string; phone: string };
  let userS2: { id: string; phone: string };
  let deactivated: string;

  const tokenOf = (actor: Actor) =>
    signAccessToken(
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
  const reset = async (actor: Actor, userId: string, newPassword: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/users/${userId}/reset-password`,
      headers: { authorization: `Bearer ${await tokenOf(actor)}` },
      payload: { new_password: newPassword },
    });
  const login = (phone: string, password: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: freshIp(),
      payload: { phone, password, device_id: freshUuid() },
    });
  const changePassword = (accessToken: string, current: string, next: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { current_password: current, new_password: next },
    });
  /** Comptes du test visibles par l'acteur (toutes les pages). */
  const visibleOf = async (actor: Actor, ours: readonly string[]) => {
    const wanted = new Set(ours);
    const seen = new Map<string, UserEntry>();
    let cursor: string | null = null;
    for (let page = 0; page < 500; page++) {
      const response = await get(
        actor,
        `/api/v1/users?limit=200${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as { users: UserEntry[]; next_cursor: string | null };
      for (const user of body.users) if (wanted.has(user.id)) seen.set(user.id, user);
      cursor = body.next_cursor;
      if (cursor === null || seen.size === wanted.size) break;
    }
    return seen;
  };
  /** Compte capable de se connecter, avec un rôle réel du seed. */
  const loginable = async (roleCode: string, scope: TestAssignmentOptions) => {
    const roleId = await roleIdOf(roleCode);
    const passwordHash = await hashPassword(TEST_PASSWORD);
    return tx(async (trx) => {
      const id = freshUuid();
      const phone = await freshPhone({ executor: trx });
      await trx
        .insertInto('identity_users')
        .values({
          id: toBin(id),
          full_name: `Compte MP-08 ${id.slice(-4)}`,
          phone,
          password_hash: passwordHash,
          must_change_password: 0,
          status: 'ACTIVE',
          created_by: toBin(root),
        })
        .execute();
      await assignTestRole(trx, id, roleId, root, scope);
      return { id, phone };
    });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerCorrelationId(app, app.get(ID_GENERATOR));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    clock = app.get(CLOCK);
    pipeline = app.get(CommandPipelineService);

    root = await tx((trx) => insertTestUser(trx));
    let s2: string;
    await tx(async (trx) => {
      const zone = await insertTestZone(trx, root);
      s1 = await insertTestSite(trx, root, zone, { siteType: 'POINT_DE_VENTE' });
      s2 = await insertTestSite(trx, root, zone, { siteType: 'POINT_DE_VENTE' });
    });
    admin = await newActor('ADMIN', root);
    direction = await newActor('DIRECTION', root);
    respFerme = await newActor('RESP_FERME', root, { scopeType: 'SITE', scopeSiteId: s1 });
    vendeur = await newActor('VENDEUR_PDV', root, { scopeType: 'SITE', scopeSiteId: s1 });
    targetS1 = await loginable('VENDEUR_PDV', { scopeType: 'SITE', scopeSiteId: s1 });
    userS2 = await loginable('VENDEUR_PDV', { scopeType: 'SITE', scopeSiteId: s2! });
    deactivated = await tx((trx) => insertTestUser(trx, { status: 'DEACTIVATED' }));
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  it('GET /users : portée du lecteur, rôles, action de réinitialisation ; jamais d’empreinte ni de compte système', async () => {
    const ours = [targetS1.id, userS2.id, deactivated, admin.userId];
    const forAdmin = await visibleOf(admin, ours);
    expect([...forAdmin.keys()].sort()).toEqual([...ours].sort());
    const entry = forAdmin.get(targetS1.id)!;
    expect(entry).toMatchObject({
      phone: targetS1.phone,
      status: 'ACTIVE',
      mustChangePassword: false,
      roles: ['VENDEUR_PDV'],
      actions: { resetPassword: true },
    });
    expect(Object.keys(entry)).not.toContain('passwordHash');
    expect(JSON.stringify([...forAdmin.values()])).not.toContain('password_hash');
    // Ni soi-même ni un compte désactivé ne se réinitialisent depuis la liste.
    expect(forAdmin.get(admin.userId)!.actions.resetPassword).toBe(false);
    expect(forAdmin.get(deactivated)!.actions.resetPassword).toBe(false);

    // Resp. ferme du site S1 : les comptes de S1, pas ceux de S2 ; lit sans réinitialiser.
    const forFerme = await visibleOf(respFerme, ours);
    expect([...forFerme.keys()]).toEqual([targetS1.id]);
    expect(forFerme.get(targetS1.id)!.actions.resetPassword).toBe(false);
    // Sans `identity.user.read` : 403 ; filtre inconnu : 400 ; compte système jamais listé.
    expect((await get(vendeur, '/api/v1/users')).statusCode).toBe(403);
    expect((await get(admin, '/api/v1/users?status=INCONNU')).statusCode).toBe(400);
    // L'utilisateur système (empreinte vide) ne se connecte jamais : 401, pas une erreur du serveur.
    expect((await login('+237600000000', TEST_PASSWORD)).statusCode).toBe(401);
    const system = await get(admin, '/api/v1/users?q=%2B237600000000');
    expect((system.json() as { users: unknown[] }).users).toEqual([]);
  });

  it('réinitialisation par l’Admin : sessions révoquées, changement imposé, audit sans mot de passe (AV-252)', async () => {
    const before = await login(targetS1.phone, TEST_PASSWORD);
    expect(before.statusCode).toBe(200);
    const { refresh_token: oldRefresh } = before.json() as { refresh_token: string };

    const done = await reset(admin, targetS1.id, PROVISIONAL);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.body).not.toContain(PROVISIONAL);

    const row = await db
      .selectFrom('identity_users')
      .select(['must_change_password'])
      .where('id', '=', toBin(targetS1.id))
      .executeTakeFirstOrThrow();
    expect(row.must_change_password).toBe(1);
    const sessions = await db
      .selectFrom('identity_auth_sessions')
      .select(['revoked_at', 'revoked_reason'])
      .where('user_id', '=', toBin(targetS1.id))
      .execute();
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => s.revoked_at !== null && s.revoked_reason === 'ADMIN')).toBe(true);
    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refresh_token: oldRefresh },
    });
    expect(refreshed.statusCode).toBe(401);

    const audit = await db
      .selectFrom('audit_audit_log')
      .select(['action', 'result', 'after'])
      .where('entity_id', '=', toBin(targetS1.id))
      .where('action', '=', 'identity.user.reset_password')
      .execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.result).toBe('SUCCESS');
    expect(JSON.stringify(audit[0])).not.toContain(PROVISIONAL);

    // Ancien mot de passe refusé ; le provisoire ouvre une session avec le changement imposé.
    expect((await login(targetS1.phone, TEST_PASSWORD)).statusCode).toBe(401);
    const provisional = await login(targetS1.phone, PROVISIONAL);
    expect(provisional.statusCode).toBe(200);
    const { access_token: accessToken, must_change_password: mustChange } = provisional.json() as {
      access_token: string;
      must_change_password: boolean;
    };
    expect(mustChange).toBe(true);

    // AV-280 : garder le provisoire est refusé ; un nouveau mot de passe lève l'obligation.
    const same = await changePassword(accessToken, PROVISIONAL, PROVISIONAL);
    expect(same.statusCode).toBe(400);
    expect(same.json()).toMatchObject({ error: { code: 'PASSWORD_INVALID' } });
    const short = await changePassword(accessToken, PROVISIONAL, 'court');
    expect(short.json()).toMatchObject({ error: { code: 'PASSWORD_INVALID' } });
    const changed = await changePassword(accessToken, PROVISIONAL, 'nouveau-mot-de-passe-mp08');
    expect(changed.statusCode, changed.body).toBe(200);
    const after = await login(targetS1.phone, 'nouveau-mot-de-passe-mp08');
    expect((after.json() as { must_change_password: boolean }).must_change_password).toBe(false);
  });

  it('gardes de la réinitialisation (AV-281) : droit, soi-même, compte système ou inconnu, désactivé, longueur', async () => {
    const denied = await reset(direction, userS2.id, PROVISIONAL);
    expect(denied.statusCode).toBe(403);
    const deniedAudit = await db
      .selectFrom('audit_audit_log')
      .select('result')
      .where('actor_user_id', '=', toBin(direction.userId))
      .where('action', '=', 'identity.user.reset_password')
      .execute();
    expect(deniedAudit.map((a) => a.result)).toEqual(['DENIED']);

    expect((await reset(admin, admin.userId, PROVISIONAL)).json()).toMatchObject({
      error: { code: 'RESET_OWN_PASSWORD' },
    });
    const system = await db
      .selectFrom('identity_users')
      .select('id')
      .where('is_system', '=', 1)
      .executeTakeFirstOrThrow();
    expect((await reset(admin, fromBin(system.id), PROVISIONAL)).statusCode).toBe(404);
    expect((await reset(admin, freshUuid(), PROVISIONAL)).statusCode).toBe(404);
    expect((await reset(admin, deactivated, PROVISIONAL)).json()).toMatchObject({
      error: { code: 'USER_DEACTIVATED' },
    });
    const tooShort = await reset(admin, userS2.id, 'court');
    expect(tooShort.json()).toMatchObject({
      error: { code: 'PASSWORD_INVALID', details: { problem: 'TOO_SHORT' } },
    });
    // Rien n'a changé pour le compte de S2.
    expect((await login(userS2.phone, TEST_PASSWORD)).statusCode).toBe(200);
  });

  it('changement : un mot de passe actuel faux compte comme un échec de connexion, puis verrouille', async () => {
    const user = await loginable('VENDEUR_PDV', { scopeType: 'SITE', scopeSiteId: s1 });
    const { access_token: accessToken } = (await login(user.phone, TEST_PASSWORD)).json() as {
      access_token: string;
    };
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(
        (await changePassword(accessToken, 'faux-mot-de-passe', 'autre-mot-de-passe')).statusCode,
      ).toBe(401);
    }
    expect(
      (await changePassword(accessToken, TEST_PASSWORD, 'autre-mot-de-passe')).statusCode,
    ).toBe(429);
    expect((await login(user.phone, TEST_PASSWORD)).statusCode).toBe(429);
  });

  it('création d’un compte par commande : mot de passe provisoire masqué dans l’inbox, l’événement et l’audit (INV-AUD-02)', async () => {
    const userId = freshUuid();
    const phone = await freshPhone();
    const commandId = freshUuid();
    const now = new Date().toISOString();
    const envelope = {
      command_id: commandId,
      device_seq: ++deviceSeq,
      command_version: 1,
      command_type: 'identity.user.create',
      aggregate_type: 'USER',
      aggregate_id: userId,
      author_user_id: admin.userId,
      base_version: null,
      depends_on: [],
      occurred_at: now,
      client_created_at: now,
      captured_offline: false,
      backdated_reason: null,
      attachment_ids: [],
      payload: { fullName: 'Compte créé MP-08', phone, initialPassword: PROVISIONAL },
    };
    const context = {
      authenticatedUserId: admin.userId,
      authenticatedDeviceId: admin.deviceId,
      transport: 'ONLINE_API' as const,
    };
    const result: CommandResult = await pipeline.handle(envelope, context);
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const inbox = await db
      .selectFrom('sync_command_inbox')
      .select('payload')
      .where('command_id', '=', toBin(commandId))
      .executeTakeFirstOrThrow();
    const events = await db
      .selectFrom('platform_domain_events')
      .select('payload')
      .where('command_id', '=', toBin(commandId))
      .execute();
    const audit = await db
      .selectFrom('audit_audit_log')
      .selectAll()
      .where('entity_id', '=', toBin(userId))
      .execute();
    for (const stored of [inbox, ...events, ...audit]) {
      expect(JSON.stringify(stored)).not.toContain(PROVISIONAL);
    }
    expect(JSON.stringify(inbox.payload)).toContain('[REDACTED]');
    // Le gestionnaire a reçu le vrai mot de passe : il ouvre une session (changement imposé).
    const created = await login(phone, PROVISIONAL);
    expect(created.statusCode).toBe(200);
    expect((created.json() as { must_change_password: boolean }).must_change_password).toBe(true);
    // Rejouer la même commande : résultat enregistré, sans `COMMAND_ID_REUSED` (empreinte sur la
    // charge masquée, la même pour le même envoi).
    const replay = await pipeline.handle(envelope, context);
    expect(replay.status).toBe('APPLIED');
  });

  it('projection USER servie aux appareils : le nom et le statut seulement', async () => {
    const project = resolveEntityProjection('USER')!;
    const data = await project(db, targetS1.id, { scopeType: 'GLOBAL', scopeId: null } as never);
    expect(data).toEqual({ id: targetS1.id, full_name: expect.any(String), status: 'ACTIVE' });
  });
});
