/**
 * ADR-071 (AV-533, AV-550 à AV-552 ; décision du porteur du 08/11/2026, questionnaire de clôture Q24, réponse A) — le jeu
 * `role_assignment` ne va qu'à l'utilisateur de l'affectation. Par le vrai pipeline de commandes, le vrai tirage du flux
 * (`SyncPullService`) et la vraie projection, sur des affectations posées par `identity.role_assignment.grant` et `.revoke` :
 * - une affectation accordée est publiée par une ligne `USER` dont la portée est son titulaire ; l'appareil du titulaire (et son
 *   second appareil) la reçoit, l'appareil d'un autre compte, celui de l'administrateur qui l'a accordée et la tablette partagée
 *   connectée par un autre utilisateur ne reçoivent rien ;
 * - la ligne `GLOBAL` du repli du pipeline (insérée à chaque commande) et les anciennes lignes `GLOBAL` d'avant la migration ne
 *   sont servies à personne, pas même au titulaire ; une ligne `USER` mal émise (portée d'un autre compte) non plus ;
 * - une révocation republie l'affectation à son titulaire seul, avec `revoked_at` ;
 * - un appareil déjà alimenté d'avant : le retrait de la migration (`SCOPE_EXIT` en portée `GLOBAL`) atteint tous les appareils,
 *   le rattrapage (`UPSERT` en portée `USER`) le seul titulaire — et rien d'autre ne change dans ce que l'appareil reçoit.
 * Chaque assertion porte sur les identifiants du fichier (base partagée) ; le curseur de départ est le dernier numéro du flux
 * avant le fichier. La migration elle-même est éprouvée par `db/tests/role-assignment-feed-migration.test.ts`, l'application du
 * retrait par la PWA par `apps/pwa/src/sync/role-assignment-transition.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Change, CommandResult } from '@gic/contracts';
import { AppModule } from '../src/app.module.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { recordChanges } from '../src/platform/sync/change-feed.js';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import {
  closeTestDb,
  db,
  freshUuid,
  insertTestDevice,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';
import { newActor, roleIdOf, tx, type Actor } from './cash-transfer-fixtures.js';

const DATASET = 'role_assignment';
const ENTITY_TYPE = 'ROLE_ASSIGNMENT';
const DAY = '2026-11-08';
let deviceSeq = 0;

describe('ADR-071 : jeu role_assignment servi à l’utilisateur de l’affectation seul', () => {
  let app: NestFastifyApplication;
  let pipeline: CommandPipelineService;
  let pullService: SyncPullService;
  let cursor0 = 0;
  let root: string;
  let siteA: string;
  let admin: Actor;
  let alice: Actor;
  let aliceTablet: Actor;
  let bob: Actor;
  let carol: Actor;
  let sellerRole: string;
  let accountantRole: string;

  const send = (
    actor: Actor,
    command: {
      readonly type: string;
      readonly aggregateId: string;
      readonly occurredAt: string;
      readonly payload: unknown;
    },
  ): Promise<CommandResult> =>
    pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: command.type,
        aggregate_type: ENTITY_TYPE,
        aggregate_id: command.aggregateId,
        author_user_id: actor.userId,
        base_version: null,
        depends_on: [],
        occurred_at: command.occurredAt,
        client_created_at: command.occurredAt,
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload: command.payload,
      },
      {
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        transport: 'ONLINE_API',
      },
    );
  const ok = async (...args: Parameters<typeof send>) => {
    const result = await send(...args);
    expect(result.status, JSON.stringify(result)).toMatch(/^APPLIED/);
    return result;
  };

  const grant = async (
    to: Actor,
    roleId: string,
    scope:
      | { readonly scopeType: 'SITE'; readonly scopeSiteId: string }
      | { readonly scopeType: 'GLOBAL' },
    hhmm: string,
  ): Promise<string> => {
    const assignmentId = freshUuid();
    await ok(admin, {
      type: 'identity.role_assignment.grant',
      aggregateId: assignmentId,
      occurredAt: `${DAY}T${hhmm}:00.000Z`,
      payload: { userId: to.userId, roleId, ...scope },
    });
    return assignmentId;
  };

  /**
   * Tire le jeu depuis `from` pour l'utilisateur et l'appareil de `actor`, en une page assez grande pour tout le périmètre
   * (les lignes GLOBAL héritées de la base partagée n'en font qu'une centaine) : le curseur retenu derrière un trou récent de
   * la numérotation (AV-198) ne coupe ainsi aucune lecture, seul son contenu compte ici.
   */
  async function pull(actor: Actor, from = cursor0): Promise<readonly Change[]> {
    const page = await pullService.pull(
      { dataset: DATASET, cursor: from, limit: 5_000 },
      { authenticatedUserId: actor.userId, authenticatedDeviceId: actor.deviceId, now: new Date() },
    );
    expect(page.changes.length).toBeLessThan(5_000);
    return page.changes;
  }
  const aboutEntity = (changes: readonly Change[], entityId: string) =>
    changes.filter((change) => change.entity_id === entityId);
  const feedLines = (entityId: string) =>
    db
      .selectFrom('sync_change_feed')
      .select(['dataset', 'entity_type', 'change_type', 'scope_type', 'scope_id', 'row_version'])
      .where('entity_type', '=', ENTITY_TYPE)
      .where('entity_id', '=', toBin(entityId))
      .where('seq', '>', cursor0)
      .orderBy('seq')
      .execute();
  const maxSeq = async () =>
    Number(
      (
        await db
          .selectFrom('sync_change_feed')
          .select((eb) => eb.fn.max('seq').as('seq'))
          .executeTakeFirst()
      )?.seq ?? 0,
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    pipeline = app.get(CommandPipelineService);
    pullService = new SyncPullService(db);
    cursor0 = await maxSeq();

    root = await tx((trx) => insertTestUser(trx));
    siteA = await tx(async (trx) => insertTestSite(trx, root, await insertTestZone(trx, root)));
    admin = await newActor('ADMIN', root);
    // Comptes sans rôle : leurs affectations sont accordées par les commandes réelles ci-dessous.
    const bare = async (): Promise<Actor> =>
      tx(async (trx) => {
        const userId = await insertTestUser(trx);
        return { userId, deviceId: await insertTestDevice(trx, userId, { status: 'ACTIVE' }) };
      });
    alice = await bare();
    bob = await bare();
    carol = await bare();
    // Second appareil d'Alice (tablette) : même utilisateur, autre appareil.
    aliceTablet = {
      userId: alice.userId,
      deviceId: await tx((trx) => insertTestDevice(trx, alice.userId, { status: 'ACTIVE' })),
    };
    sellerRole = await roleIdOf('VENDEUR_PDV');
    accountantRole = await roleIdOf('FINANCE');
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  describe('octroi et révocation par les commandes', () => {
    let aliceSeller: string;
    let aliceFinance: string;
    let bobSeller: string;

    it('octroi : ligne USER du titulaire ; son appareil et son second appareil la reçoivent, personne d’autre', async () => {
      aliceSeller = await grant(
        alice,
        sellerRole,
        { scopeType: 'SITE', scopeSiteId: siteA },
        '09:00',
      );
      aliceFinance = await grant(alice, accountantRole, { scopeType: 'GLOBAL' }, '09:01');
      bobSeller = await grant(bob, sellerRole, { scopeType: 'SITE', scopeSiteId: siteA }, '09:02');

      // Dans le flux : la ligne USER du titulaire, et la ligne GLOBAL du repli du pipeline (insérée à chaque commande, servie à personne).
      const lines = await feedLines(aliceSeller);
      expect(lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            dataset: DATASET,
            change_type: 'UPSERT',
            scope_type: 'USER',
            scope_id: toBin(alice.userId),
            row_version: 1,
          }),
          expect.objectContaining({ dataset: DATASET, scope_type: 'GLOBAL', scope_id: null }),
        ]),
      );

      const own = aboutEntity(await pull(alice), aliceSeller);
      expect(own).toHaveLength(1);
      expect(own[0]).toMatchObject({
        change_type: 'UPSERT',
        scope_type: 'USER',
        scope_id: alice.userId,
        data: {
          id: aliceSeller,
          user_id: alice.userId,
          role_id: sellerRole,
          scope_type: 'SITE',
          scope_site_id: siteA,
          revoked_at: null,
        },
      });
      // Pas de code de rôle (S-41 (a), AV-552) : l'appareil le lit dans `me` / `GET /auth/me`.
      expect(own[0]!.data).not.toHaveProperty('role_code');
      expect(aboutEntity(await pull(alice), aliceFinance)).toHaveLength(1);

      // Le second appareil du même utilisateur la reçoit aussi.
      expect(aboutEntity(await pull(aliceTablet), aliceSeller)).toHaveLength(1);

      // Ni Bob, ni Carol, ni l'administrateur qui l'a accordée (ADMIN, affecté globalement) : rien, pas même la ligne GLOBAL du repli.
      for (const other of [bob, carol, admin]) {
        const seen = await pull(other);
        expect(aboutEntity(seen, aliceSeller)).toEqual([]);
        expect(aboutEntity(seen, aliceFinance)).toEqual([]);
      }
      // Bob ne reçoit que la sienne.
      const bobs = await pull(bob);
      expect(aboutEntity(bobs, bobSeller)).toHaveLength(1);
      expect(
        bobs
          .filter((change) => change.change_type === 'UPSERT' && change.data !== undefined)
          .map((change) => (change.data as { user_id: string }).user_id),
      ).toEqual([bob.userId]);
    });

    it('un appareil neuf (curseur 0) ne reçoit que les affectations de son utilisateur', async () => {
      // Les affectations de tout le monde dans la base partagée : seul le titulaire est servi, aucune autre affectation de la base.
      const fresh = await pull(alice, 0);
      expect(fresh.length).toBeGreaterThan(0);
      for (const change of fresh) {
        if (change.change_type === 'UPSERT') {
          expect(change.scope_type).toBe('USER');
          expect(change.scope_id).toBe(alice.userId);
          expect((change.data as { user_id: string }).user_id).toBe(alice.userId);
        }
      }
      const ids = fresh
        .filter((change) => change.change_type === 'UPSERT')
        .map((change) => change.entity_id);
      expect(ids).toEqual(expect.arrayContaining([aliceSeller, aliceFinance]));
      expect(ids).not.toContain(bobSeller);
    });

    it('révocation : l’affectation est republiée à son titulaire seul, avec revoked_at ; les autres ne reçoivent rien', async () => {
      const before = await maxSeq();
      await ok(admin, {
        type: 'identity.role_assignment.revoke',
        aggregateId: aliceSeller,
        occurredAt: `${DAY}T10:00:00.000Z`,
        payload: { reason: 'ADR-071 : essai de révocation' },
      });

      const lines = (await feedLines(aliceSeller)).filter((line) => line.row_version === 2);
      expect(lines).toEqual([
        expect.objectContaining({
          dataset: DATASET,
          change_type: 'UPSERT',
          scope_type: 'USER',
          scope_id: toBin(alice.userId),
          row_version: 2,
        }),
      ]);

      const revoked = aboutEntity(await pull(alice, before), aliceSeller);
      expect(revoked).toHaveLength(1);
      expect(revoked[0]).toMatchObject({
        scope_type: 'USER',
        row_version: 2,
        data: { id: aliceSeller, user_id: alice.userId },
      });
      expect((revoked[0]!.data as { revoked_at: string | null }).revoked_at).not.toBeNull();
      // Depuis un curseur d'avant, le second appareil la reçoit aussi ; Bob, Carol et l'administrateur : rien.
      expect(aboutEntity(await pull(aliceTablet, before), aliceSeller)).toHaveLength(1);
      for (const other of [bob, carol, admin]) {
        expect(aboutEntity(await pull(other, before), aliceSeller)).toEqual([]);
      }
    });

    it('tablette partagée : le même appareil rend à chaque utilisateur connecté ses seules affectations', async () => {
      // La PWA efface les jeux téléchargés au changement d'utilisateur (`ensureDataOwner`, ADR-037) : chacun repart de 0.
      const shared = (user: Actor): Actor => ({
        userId: user.userId,
        deviceId: aliceTablet.deviceId,
      });
      const asAlice = await pull(shared(alice), 0);
      const asBob = await pull(shared(bob), 0);
      const idsOf = (changes: readonly Change[]) =>
        new Set(
          changes.filter((change) => change.data !== undefined).map((change) => change.entity_id),
        );
      expect(idsOf(asAlice).has(aliceSeller)).toBe(true);
      expect(idsOf(asAlice).has(bobSeller)).toBe(false);
      expect(idsOf(asBob).has(bobSeller)).toBe(true);
      expect(idsOf(asBob).has(aliceSeller)).toBe(false);
      expect(idsOf(asBob).has(aliceFinance)).toBe(false);
    });
  });

  describe('lignes GLOBAL et lignes mal émises', () => {
    it('une ancienne ligne GLOBAL (avant la migration) n’est servie à personne, pas même au titulaire', async () => {
      const assignmentId = await grant(
        carol,
        sellerRole,
        { scopeType: 'SITE', scopeSiteId: siteA },
        '11:00',
      );
      const before = await maxSeq();
      // Ce que publiait l'ancien code : une ligne GLOBAL pour l'affectation (repli du pipeline, création de compte, scripts).
      await recordChanges(db, [
        {
          dataset: DATASET,
          entityType: ENTITY_TYPE,
          entityId: assignmentId,
          scopeType: 'GLOBAL',
          scopeId: null,
        },
      ]);
      for (const device of [carol, alice, bob, admin]) {
        expect(aboutEntity(await pull(device, before), assignmentId)).toEqual([]);
      }
      // La ligne USER de l'octroi, elle, est toujours servie au titulaire.
      expect(aboutEntity(await pull(carol), assignmentId)).toHaveLength(1);
    });

    it('une ligne USER dont la portée n’est pas le titulaire ne sert personne', async () => {
      const assignmentId = await grant(carol, accountantRole, { scopeType: 'GLOBAL' }, '11:10');
      const before = await maxSeq();
      // Ligne mal émise : portée = Bob pour l'affectation de Carol.
      await recordChanges(db, [
        {
          dataset: DATASET,
          entityType: ENTITY_TYPE,
          entityId: assignmentId,
          scopeType: 'USER',
          scopeId: bob.userId,
        },
      ]);
      expect(aboutEntity(await pull(bob, before), assignmentId)).toEqual([]);
      // Ni Bob (la projection refuse), ni personne ne reçoit les données de Carol par cette ligne ; Carol reçoit la sienne.
      expect(aboutEntity(await pull(carol), assignmentId)).toHaveLength(1);
    });
  });

  describe('appareil déjà alimenté : retrait et rattrapage de la migration', () => {
    it('le retrait (SCOPE_EXIT GLOBAL) atteint tous les appareils, le rattrapage (UPSERT USER) le seul titulaire', async () => {
      const assignmentId = freshUuid();
      // Une affectation d'avant, accordée sans publier de ligne USER (ancien code) : table seule + ligne GLOBAL.
      await tx(async (trx) => {
        await trx
          .insertInto('identity_user_role_assignments')
          .values({
            id: toBin(assignmentId),
            user_id: toBin(bob.userId),
            role_id: toBin(sellerRole),
            scope_type: 'SITE',
            scope_site_id: toBin(siteA),
            valid_from: new Date('2026-01-01T00:00:00.000Z'),
            created_by: toBin(root),
          })
          .execute();
        await recordChanges(trx, [
          {
            dataset: DATASET,
            entityType: ENTITY_TYPE,
            entityId: assignmentId,
            scopeType: 'GLOBAL',
            scopeId: null,
          },
        ]);
      });
      const before = await maxSeq();
      // Avant la migration : l'ancienne ligne GLOBAL est ignorée de la projection, Bob ne reçoit rien (il lui faut le rattrapage).
      expect(aboutEntity(await pull(bob, 0), assignmentId)).toEqual([]);

      // Ce que la migration 20261207090000 ajoute pour cette affectation (éprouvé sur le SQL réel par db/tests).
      await recordChanges(db, [
        {
          dataset: DATASET,
          entityType: ENTITY_TYPE,
          entityId: assignmentId,
          scopeType: 'GLOBAL',
          scopeId: null,
          changeType: 'SCOPE_EXIT',
        },
        {
          dataset: DATASET,
          entityType: ENTITY_TYPE,
          entityId: assignmentId,
          scopeType: 'USER',
          scopeId: bob.userId,
        },
      ]);

      // Le retrait GLOBAL est dans le flux de tous les appareils (un appareil déjà alimenté le reçoit à son premier tirage) ;
      // il ne porte aucune donnée (rien à projeter, §5.3).
      for (const device of [alice, bob, carol, admin]) {
        const seen = aboutEntity(await pull(device, before), assignmentId);
        expect(seen.filter((change) => change.change_type === 'SCOPE_EXIT')).toEqual([
          expect.objectContaining({ scope_type: 'GLOBAL', scope_id: null }),
        ]);
        expect(seen.find((change) => change.change_type === 'SCOPE_EXIT')).not.toHaveProperty(
          'data',
        );
      }
      // La republication ne va qu'à Bob, qui retrouve ainsi son affectation avec ses données.
      const bobSees = aboutEntity(await pull(bob, before), assignmentId);
      expect(bobSees.map((change) => [change.change_type, change.scope_type])).toEqual([
        ['SCOPE_EXIT', 'GLOBAL'],
        ['UPSERT', 'USER'],
      ]);
      expect(bobSees[1]).toMatchObject({
        data: { id: assignmentId, user_id: bob.userId, scope_type: 'SITE' },
      });
      for (const device of [alice, carol, admin]) {
        expect(
          aboutEntity(await pull(device, before), assignmentId).filter(
            (change) => change.change_type === 'UPSERT',
          ),
        ).toEqual([]);
      }

      // Un appareil neuf de Bob (curseur 0) : seulement la republication USER avec données ; la ligne GLOBAL d'avant ne sert rien.
      const fresh = aboutEntity(await pull(bob, 0), assignmentId);
      expect(
        fresh.filter((change) => change.data !== undefined).map((change) => change.scope_type),
      ).toEqual(['USER']);
    });
  });

  it('les lignes d’autres jeux du flux ne changent pas (utilisateur, appareil) : seul role_assignment est restreint', async () => {
    // Le compte (nom et statut) reste servi à tous les appareils : ADR-045, hors du périmètre de ce lot.
    const accountId = await tx((trx) => insertTestUser(trx));
    const before = await maxSeq();
    await recordChanges(db, [
      {
        dataset: 'user',
        entityType: 'USER',
        entityId: accountId,
        scopeType: 'GLOBAL',
        scopeId: null,
      },
    ]);
    const page = await pullService.pull(
      { dataset: 'user', cursor: before, limit: 500 },
      { authenticatedUserId: bob.userId, authenticatedDeviceId: bob.deviceId, now: new Date() },
    );
    expect(
      page.changes.some((change) => change.entity_id === accountId && change.data !== undefined),
    ).toBe(true);
  });
});
