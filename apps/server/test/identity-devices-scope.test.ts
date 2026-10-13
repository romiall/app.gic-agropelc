/**
 * MP-06 — appareils : portée des commandes `identity.device.*` et de la lecture `GET /devices` (AV-247,
 * AV-258 à AV-261, décisions du porteur du 13/10/2026), code court à la connexion, commande d'installation
 * (AV-254). Application complète, rôles réels du seed.
 *
 * Monde : zone Z (sites S1, S2), zone Z2 (site S3). Décideurs : Admin, Resp. ferme de S1, Resp. commercial
 * d'une équipe, Finance (sans lecture). Appareils connectés par : un vendeur de S1, un commercial terrain
 * de l'équipe, un utilisateur affecté à la zone Z, un vendeur de S3, la Finance (appareil rattaché à S1),
 * le Resp. ferme lui-même.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { FixedClock, Uuidv7Generator, type Clock } from '@gic/domain';
import type { CommandResult } from '@gic/contracts';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import { signAccessToken } from '../src/modules/identity/application/public/jwt.js';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { approveDeviceByShortCode } from '../src/modules/identity/application/bootstrap-device-approval.js';
import { pendingDeviceApprovalsFor } from '../src/modules/identity/application/public/index.js';
import {
  closeTestDb,
  db,
  freshUuid,
  insertTestDevice,
  insertTestSite,
  insertTestTeam,
  insertTestTeamMembership,
  insertTestUser,
  insertTestZone,
} from './helpers.js';
import { newActor, tx, type Actor } from './cash-transfer-fixtures.js';

let deviceSeq = 0;

describe(
  'MP-06 : appareils — portée, auto-approbation, lecture, installation',
  { timeout: 120_000 },
  () => {
    let app: NestFastifyApplication;
    let clock: Clock;
    let pipeline: CommandPipelineService;
    let root: string;
    let s1: string;
    let s3: string;
    let admin: Actor;
    let respFerme: Actor;
    let respCom: Actor;
    let finance: Actor;
    let magasinier: Actor;
    const devices: Record<string, string> = {};

    const send = (
      actor: Actor,
      commandType: string,
      deviceId: string,
      payload: unknown = {},
    ): Promise<CommandResult> =>
      pipeline.handle(
        {
          command_id: freshUuid(),
          device_seq: ++deviceSeq,
          command_version: 1,
          command_type: commandType,
          aggregate_type: 'DEVICE',
          aggregate_id: deviceId,
          author_user_id: actor.userId,
          base_version: null,
          depends_on: [],
          occurred_at: new Date().toISOString(),
          client_created_at: new Date().toISOString(),
          captured_offline: false,
          backdated_reason: null,
          attachment_ids: [],
          payload,
        },
        {
          authenticatedUserId: actor.userId,
          authenticatedDeviceId: actor.deviceId,
          transport: 'ONLINE_API',
        },
      );
    const codeOf = (result: CommandResult) =>
      result.status === 'REJECTED' ? result.error?.code : result.status;
    const statusOf = async (deviceId: string) =>
      (
        await db
          .selectFrom('identity_devices')
          .select('status')
          .where('id', '=', toBin(deviceId))
          .executeTakeFirstOrThrow()
      ).status;
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
    /** Tous les appareils visibles (pages suivies jusqu'au bout), restreints à ceux du test. */
    const visibleOf = async (actor: Actor) => {
      const ours = new Set(Object.values(devices));
      const seen = new Map<string, { actions: Record<string, boolean> }>();
      let cursor: string | null = null;
      for (let page = 0; page < 200; page++) {
        const response = await get(
          actor,
          `/api/v1/devices?limit=200${cursor ? `&cursor=${cursor}` : ''}`,
        );
        expect(response.statusCode, response.body).toBe(200);
        const body = response.json() as {
          devices: { id: string; actions: Record<string, boolean> }[];
          next_cursor: string | null;
        };
        for (const device of body.devices) if (ours.has(device.id)) seen.set(device.id, device);
        cursor = body.next_cursor;
        if (cursor === null) break;
      }
      return seen;
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
      let z: string;
      let z2: string;
      await tx(async (trx) => {
        z = await insertTestZone(trx, root);
        z2 = await insertTestZone(trx, root);
        s1 = await insertTestSite(trx, root, z, { siteType: 'POINT_DE_VENTE' });
        await insertTestSite(trx, root, z, { siteType: 'MAGASIN' });
        s3 = await insertTestSite(trx, root, z2, { siteType: 'POINT_DE_VENTE' });
      });
      admin = await newActor('ADMIN', root);
      respFerme = await newActor('RESP_FERME', root, { scopeType: 'SITE', scopeSiteId: s1 });
      finance = await newActor('FINANCE', root);
      magasinier = await newActor('MAGASINIER', root, { scopeType: 'SITE', scopeSiteId: s1 });
      // Rôles de terrain : affectation de zone seulement (allowed_scope_types) ; zone Z2, hors de S1.
      const terrain = await newActor('COMMERCIAL_TERRAIN', root, {
        scopeType: 'ZONE',
        scopeZoneId: z2!,
      });
      respCom = await newActor('RESP_COMMERCIAL', root, { scopeType: 'ZONE', scopeZoneId: z2! });
      await tx(async (trx) => {
        const team = await insertTestTeam(trx, respCom.userId, root);
        await insertTestTeamMembership(trx, team, terrain.userId, root);
      });
      const vendeurS1 = await newActor('VENDEUR_PDV', root, { scopeType: 'SITE', scopeSiteId: s1 });
      const vendeurS3 = await newActor('VENDEUR_PDV', root, { scopeType: 'SITE', scopeSiteId: s3 });
      const zoneUser = await newActor('RESP_COMMERCIAL', root, {
        scopeType: 'ZONE',
        scopeZoneId: z!,
      });

      await tx(async (trx) => {
        const pending = (enroller: string) =>
          insertTestDevice(trx, enroller, { status: 'PENDING' });
        devices.vendeurS1 = await pending(vendeurS1.userId);
        devices.terrainTeam = await pending(terrain.userId);
        devices.zone = await pending(zoneUser.userId);
        devices.vendeurS3 = await pending(vendeurS3.userId);
        devices.respFermeSelf = await pending(respFerme.userId);
        devices.adminSelf = await pending(admin.userId);
        devices.financeAtS1 = await insertTestDevice(trx, finance.userId, { status: 'ACTIVE' });
        await trx
          .updateTable('identity_devices')
          .set({ designated_site_id: toBin(s1) })
          .where('id', '=', toBin(devices.financeAtS1))
          .execute();
      });
    }, 120_000);

    afterAll(async () => {
      await app.close();
      await closeTestDb();
    });

    it('lecture : chaque décideur voit les appareils de sa portée, avec les actions permises (AV-247, AV-258, AV-260)', async () => {
      const ferme = await visibleOf(respFerme);
      // Site de l'utilisateur, zone de l'utilisateur qui couvre S1, site de rattachement, son propre appareil.
      expect([...ferme.keys()].sort()).toEqual(
        [devices.vendeurS1, devices.zone, devices.financeAtS1, devices.respFermeSelf].sort(),
      );
      expect(ferme.get(devices.vendeurS1)!.actions).toEqual({
        approve: true,
        block: true,
        unblock: true,
        designate: true,
      });
      // AV-258 : son propre appareil, il peut le bloquer mais pas l'approuver.
      expect(ferme.get(devices.respFermeSelf)!.actions).toEqual({
        approve: false,
        block: true,
        unblock: false,
        designate: true,
      });

      const com = await visibleOf(respCom);
      expect([...com.keys()]).toEqual([devices.terrainTeam]);

      // L'Admin voit tout ; le magasinier lit sans décider.
      const all = await visibleOf(admin);
      expect(all.size).toBe(Object.keys(devices).length);
      expect(all.get(devices.adminSelf)!.actions).toEqual({
        approve: true,
        block: true,
        unblock: true,
        designate: true,
      });
      const mag = await visibleOf(magasinier);
      expect(mag.get(devices.vendeurS1)!.actions).toEqual({
        approve: false,
        block: false,
        unblock: false,
        designate: false,
      });
      expect(mag.has(devices.vendeurS3)).toBe(false);
    });

    it('accueil : appareils en attente comptés dans la portée du responsable, sans les siens (AV-247, AV-258)', async () => {
      const pendingOf = (actor: Actor) =>
        pendingDeviceApprovalsFor(db, { userId: actor.userId, at: clock.now() });
      // Resp. ferme : vendeur de S1 et utilisateur de la zone ; pas son propre appareil, pas l'appareil actif.
      expect(await pendingOf(respFerme)).toEqual({ count: 2, capped: false });
      expect(await pendingOf(respCom)).toEqual({ count: 1, capped: false });
      // Lecture seule ou aucun droit : rien à approuver.
      expect(await pendingOf(magasinier)).toEqual({ count: 0, capped: false });
      expect(await pendingOf(finance)).toEqual({ count: 0, capped: false });

      const home = await get(respFerme, '/api/v1/home');
      expect(home.statusCode, home.body).toBe(200);
      const signals = (home.json() as { signals: { code: string; title: string; count: number }[] })
        .signals;
      expect(signals.find((entry) => entry.code === 'DEVICES_PENDING')).toMatchObject({
        title: '2 appareils attendent votre approbation',
        count: 2,
      });
      const magHome = await get(magasinier, '/api/v1/home');
      expect(
        (magHome.json() as { signals: { code: string }[] }).signals.map((entry) => entry.code),
      ).not.toContain('DEVICES_PENDING');
    });

    it('lecture : fiche hors portée 404 auditée, sans droit 403, filtres par état et par code court', async () => {
      const outside = await get(respFerme, `/api/v1/devices/${devices.vendeurS3}`);
      expect(outside.statusCode).toBe(404);
      const audit = await db
        .selectFrom('audit_audit_log')
        .select('error_code')
        .where('actor_user_id', '=', toBin(respFerme.userId))
        .where('action', '=', 'access.denied')
        .where('entity_id', '=', toBin(devices.vendeurS3))
        .execute();
      expect(audit.map((row) => row.error_code)).toContain('NOT_FOUND');
      expect((await get(finance, '/api/v1/devices')).statusCode).toBe(403);

      const inside = await get(respFerme, `/api/v1/devices/${devices.vendeurS1}`);
      expect(inside.statusCode, inside.body).toBe(200);
      const { device } = inside.json() as {
        device: { shortCode: string; status: string; enrolledByName: string | null };
      };
      expect(device).toMatchObject({ status: 'PENDING' });
      expect(device.enrolledByName).toEqual(expect.any(String));
      const byCode = await get(
        admin,
        `/api/v1/devices?status=PENDING&q=${device.shortCode.toLowerCase()}`,
      );
      expect((byCode.json() as { devices: { id: string }[] }).devices.map((d) => d.id)).toEqual([
        devices.vendeurS1,
      ]);
      expect((await get(admin, '/api/v1/devices?status=INCONNU')).statusCode).toBe(400);
    });

    it('commandes : portée vérifiée, auto-approbation refusée sauf l’Admin, site cible dans la portée (AV-247, AV-258, AV-259)', async () => {
      // Hors portée : un vendeur d'un autre site, un appareil de l'équipe d'un autre.
      expect(codeOf(await send(respFerme, 'identity.device.approve', devices.vendeurS3))).toBe(
        'FORBIDDEN_SCOPE',
      );
      expect(codeOf(await send(respCom, 'identity.device.approve', devices.vendeurS3))).toBe(
        'FORBIDDEN_SCOPE',
      );
      expect(await statusOf(devices.vendeurS3)).toBe('PENDING');
      // Dans la portée : site, zone, équipe, site de rattachement.
      expect(codeOf(await send(respFerme, 'identity.device.approve', devices.vendeurS1))).toBe(
        'APPLIED',
      );
      expect(codeOf(await send(respFerme, 'identity.device.approve', devices.zone))).toBe(
        'APPLIED',
      );
      expect(codeOf(await send(respCom, 'identity.device.approve', devices.terrainTeam))).toBe(
        'APPLIED',
      );
      expect(
        codeOf(
          await send(respFerme, 'identity.device.block', devices.financeAtS1, {
            reason: 'Test MP-06',
          }),
        ),
      ).toBe('APPLIED');
      expect(await statusOf(devices.financeAtS1)).toBe('BLOCKED');

      // AV-258 : son propre appareil, refusé ; l'Admin l'approuve, et approuve le sien.
      expect(codeOf(await send(respFerme, 'identity.device.approve', devices.respFermeSelf))).toBe(
        'SELF_APPROVAL_FORBIDDEN',
      );
      expect(codeOf(await send(admin, 'identity.device.approve', devices.respFermeSelf))).toBe(
        'APPLIED',
      );
      expect(codeOf(await send(admin, 'identity.device.approve', devices.adminSelf))).toBe(
        'APPLIED',
      );
      // Débloquer son propre appareil : même règle qu'approuver.
      expect(
        codeOf(
          await send(respFerme, 'identity.device.block', devices.respFermeSelf, { reason: 'Test' }),
        ),
      ).toBe('APPLIED');
      expect(codeOf(await send(respFerme, 'identity.device.unblock', devices.respFermeSelf))).toBe(
        'SELF_APPROVAL_FORBIDDEN',
      );

      // AV-259 : rattacher à un site hors de sa portée, refusé ; à son site, appliqué.
      const designate = (siteId: string) =>
        send(respFerme, 'identity.device.designate', devices.vendeurS1, {
          isShared: true,
          designatedSiteId: siteId,
        });
      expect(codeOf(await designate(s3))).toBe('FORBIDDEN_SCOPE');
      expect(codeOf(await designate(s1))).toBe('APPLIED');
      // Le magasinier lit sans décider : refusé par le droit.
      expect(
        codeOf(await send(magasinier, 'identity.device.block', devices.vendeurS1, { reason: 'x' })),
      ).toBe('FORBIDDEN');
    });

    it('commande d’installation (AV-254) : gardes, approbation par le système, audit', async () => {
      const fixed = {
        clock: new FixedClock(new Date()),
        idGenerator: new Uuidv7Generator(new FixedClock(new Date())),
      };
      const run = (shortCode: string) =>
        tx((trx) => approveDeviceByShortCode(trx, fixed, { shortCode }));
      expect(await run('abc')).toMatchObject({ kind: 'REFUSED', reason: 'INVALID_CODE' });
      // Code bien formé mais inconnu (on cherche un code libre).
      let unknown = 'ZZZZ';
      for (const candidate of ['ZZZZ', 'ZZZY', 'ZZZX', 'ZZZW']) {
        const used = await db
          .selectFrom('identity_devices')
          .select('id')
          .where('short_code', '=', candidate)
          .executeTakeFirst();
        if (!used) {
          unknown = candidate;
          break;
        }
      }
      expect(await run(unknown)).toMatchObject({ kind: 'REFUSED', reason: 'UNKNOWN_DEVICE' });

      const otherAdmin = await newActor('ADMIN', root);
      const pendingAdminDevice = await tx((trx) =>
        insertTestDevice(trx, otherAdmin.userId, { status: 'PENDING' }),
      );
      const notAdminDevice = await tx((trx) =>
        insertTestDevice(trx, respFerme.userId, { status: 'PENDING' }),
      );
      const codeOfDevice = async (id: string) =>
        (
          await db
            .selectFrom('identity_devices')
            .select('short_code')
            .where('id', '=', toBin(id))
            .executeTakeFirstOrThrow()
        ).short_code;
      expect(await run(await codeOfDevice(notAdminDevice))).toMatchObject({
        kind: 'REFUSED',
        reason: 'NOT_ADMIN',
      });
      expect(await statusOf(notAdminDevice)).toBe('PENDING');

      const code = await codeOfDevice(pendingAdminDevice);
      expect(await run(` ${code.toLowerCase()} `)).toMatchObject({
        kind: 'APPROVED',
        device: { id: pendingAdminDevice, enrolledByUserId: otherAdmin.userId },
      });
      const approved = await db
        .selectFrom('identity_devices as d')
        .innerJoin('identity_users as u', 'u.id', 'd.approved_by')
        .select(['d.status', 'u.is_system'])
        .where('d.id', '=', toBin(pendingAdminDevice))
        .executeTakeFirstOrThrow();
      expect(approved).toEqual({ status: 'ACTIVE', is_system: 1 });
      const audit = await db
        .selectFrom('audit_audit_log')
        .select(['action', 'reason', 'result'])
        .where('entity_id', '=', toBin(pendingAdminDevice))
        .execute();
      expect(audit).toContainEqual({
        action: 'identity.device.approve',
        reason: 'db:approve-device (AV-254)',
        result: 'SUCCESS',
      });
      // Rejouer : déjà approuvé ; un appareil bloqué n'est pas en attente.
      expect(await run(code)).toMatchObject({ kind: 'ALREADY_ACTIVE' });
      expect(await run(await codeOfDevice(devices.financeAtS1))).toMatchObject({
        kind: 'REFUSED',
        reason: 'NOT_PENDING',
      });
    });
  },
);
