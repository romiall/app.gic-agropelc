/**
 * P9-11 (2/3) : lecture des notes de direction (ADR-073 §3, §5, §6 ; AV-476, AV-479) au niveau des fonctions
 * publiques de `communication` — centre de notes, gestion, fiche, suivi des accusés — avec le vrai résolveur
 * d'audience et la base partagée. L'horloge est maîtrisée : l'expiration, le tri et le curseur se jugent à
 * l'instant près ; plusieurs notes publiées au même instant exercent le départage par identifiant.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerNoteCommands } from '../src/modules/communication/application/commands/note-commands.js';
import {
  decodeNoteCursor,
  noteAcknowledgementFollowUp,
  noteDetail,
  notePage,
} from '../src/modules/communication/application/public/index.js';
import { encodeNoteCursor } from '../src/modules/communication/application/public/note-read.js';
import { IdentityNoteAudienceResolver } from '../src/communication-api/identity-note-audience-resolver.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestRole,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

// Instants relatifs à l'heure réelle du fichier : les notes de ce fichier sont les plus récentes de la base
// partagée (le centre de notes n'examine que les 500 dernières notes publiées), quel que soit le nombre
// d'exécutions précédentes : leurs instants de publication restent à quelques millisecondes de l'heure réelle
// (`tick`), jamais devant ceux des exécutions suivantes. Seuls les instants de lecture, d'expiration et
// d'accusé s'écartent en minutes (`at`).
const NOW_MS = Date.now();
const NOW = new Date(NOW_MS).toISOString();
const at = (minutes: number): Date => new Date(NOW_MS + minutes * 60_000);
const tick = (milliseconds: number): string => new Date(NOW_MS + milliseconds).toISOString();

interface Actor {
  readonly id: string;
  readonly deviceId: string;
}

let deviceSeq = 0;
const resolver = new IdentityNoteAudienceResolver();

describe('notes de direction : lectures (P9-11 (2/3))', () => {
  const clock = new FixedClock(new Date(NOW));
  let pipeline: CommandPipelineService;
  let siteX: string;
  let siteY: string;
  let zoneX: string;
  let publisher: Actor; // `comm.note.publish`
  let otherPublisher: Actor;
  let staffX: Actor; // site X
  let staffY: Actor; // site Y
  let manager: Actor; // zone de X et de Y
  let nobody: Actor; // site d'une autre zone

  async function newActor(
    trx: Parameters<typeof insertTestDevice>[0],
    options: { status?: 'ACTIVE' | 'SUSPENDED' } = {},
  ): Promise<Actor> {
    const id = await insertTestUser(trx, options);
    return { id, deviceId: await insertTestDevice(trx, id, { status: 'ACTIVE' }) };
  }

  /** Un lecteur et un site propres au test : seules ses notes le touchent. */
  const newSiteReader = (options: { status?: 'ACTIVE' | 'SUSPENDED' } = {}) =>
    db.transaction().execute(async (trx) => {
      const admin = await insertTestUser(trx);
      const site = await insertTestSite(trx, admin, await insertTestZone(trx, admin));
      const role = await insertTestRole(trx, admin, { allowedScopeTypes: ['SITE'] });
      await grantTestPermission(trx, role, 'comm.note.read', admin);
      const actor = await newActor(trx, options);
      await assignTestRole(trx, actor.id, role, admin, { scopeType: 'SITE', scopeSiteId: site });
      return { actor, site };
    });

  /**
   * Une seconde entière tirée au hasard dans le passé lointain : aucune autre note de la base partagée n'y
   * tombe, quelles que soient les exécutions voisines.
   */
  const pastBand = (): number =>
    Math.floor(
      (NOW_MS -
        (60 + Math.floor(Math.random() * 400)) * 86_400_000 -
        Math.floor(Math.random() * 86_400_000)) /
        1000,
    ) * 1000;

  beforeAll(async () => {
    const idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    registerNoteCommands(registry, { idGenerator, clock, audience: resolver });
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    await db.transaction().execute(async (trx) => {
      const admin = await insertTestUser(trx);
      zoneX = await insertTestZone(trx, admin);
      const zoneElsewhere = await insertTestZone(trx, admin);
      siteX = await insertTestSite(trx, admin, zoneX);
      siteY = await insertTestSite(trx, admin, zoneX);
      const siteElsewhere = await insertTestSite(trx, admin, zoneElsewhere);
      const publisherRole = await insertTestRole(trx, admin);
      await grantTestPermission(trx, publisherRole, 'comm.note.publish', admin);
      await grantTestPermission(trx, publisherRole, 'comm.note.read', admin);
      const readerRole = await insertTestRole(trx, admin, {
        allowedScopeTypes: ['GLOBAL', 'SITE', 'ZONE'],
      });
      await grantTestPermission(trx, readerRole, 'comm.note.read', admin);
      publisher = await newActor(trx);
      await assignTestRole(trx, publisher.id, publisherRole, admin);
      otherPublisher = await newActor(trx);
      await assignTestRole(trx, otherPublisher.id, publisherRole, admin);
      staffX = await newActor(trx);
      await assignTestRole(trx, staffX.id, readerRole, admin, {
        scopeType: 'SITE',
        scopeSiteId: siteX,
      });
      staffY = await newActor(trx);
      await assignTestRole(trx, staffY.id, readerRole, admin, {
        scopeType: 'SITE',
        scopeSiteId: siteY,
      });
      manager = await newActor(trx);
      await assignTestRole(trx, manager.id, readerRole, admin, {
        scopeType: 'ZONE',
        scopeZoneId: zoneX,
      });
      nobody = await newActor(trx);
      await assignTestRole(trx, nobody.id, readerRole, admin, {
        scopeType: 'SITE',
        scopeSiteId: siteElsewhere,
      });
    });
  });

  afterAll(closeTestDb);

  async function run(
    actor: Actor,
    commandType: string,
    noteId: string,
    payload: unknown,
    when = NOW,
  ) {
    clock.setTo(new Date(when));
    const result = await pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: commandType,
        aggregate_type: 'INTERNAL_NOTE',
        aggregate_id: noteId,
        author_user_id: actor.id,
        base_version: null,
        depends_on: [],
        occurred_at: when,
        client_created_at: when,
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload,
      },
      {
        authenticatedUserId: actor.id,
        authenticatedDeviceId: actor.deviceId,
        transport: 'SYNC_PUSH',
      },
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    return result;
  }

  type Audience = { type: 'SITE' | 'ZONE' | 'USER'; ref: string }[];
  const body = (title: string, audience: Audience, extra: Record<string, unknown> = {}) => ({
    title,
    body: `Corps de ${title}`,
    category: 'INFORMATION',
    requiresAck: false,
    audience,
    ...extra,
  });
  async function publish(
    title: string,
    audience: Audience,
    extra: Record<string, unknown> = {},
    options: { author?: Actor; when?: string } = {},
  ): Promise<string> {
    const noteId = freshUuid();
    await run(
      options.author ?? publisher,
      'communication.note.publish',
      noteId,
      body(title, audience, extra),
      options.when ?? NOW,
    );
    return noteId;
  }

  type PageInput = Parameters<typeof notePage>[2];
  const inbox = (actor: Actor, when: Date, extra: Partial<PageInput> = {}) =>
    notePage(db, resolver, { userId: actor.id, at: when, scope: 'INBOX', limit: 50, ...extra });
  const manage = (actor: Actor, extra: Partial<PageInput> = {}) =>
    notePage(db, resolver, {
      userId: actor.id,
      at: at(1),
      scope: 'MANAGE',
      limit: 200,
      ...extra,
    });
  const idsOf = (page: { items: readonly { id: string }[] }): string[] =>
    page.items.map((item) => item.id);

  describe('centre de notes', () => {
    it('les notes publiées qui touchent le lecteur, et elles seulement', async () => {
      const forX = await publish('Pour X', [{ type: 'SITE', ref: siteX }]);
      const forY = await publish('Pour Y', [{ type: 'SITE', ref: siteY }]);
      const forZone = await publish('Pour la zone', [{ type: 'ZONE', ref: zoneX }]);
      expect(idsOf(await inbox(staffX, at(1))).sort()).toEqual([forX, forZone].sort());
      expect(idsOf(await inbox(staffY, at(1))).sort()).toEqual([forY, forZone].sort());
      expect(idsOf(await inbox(manager, at(1))).sort()).toEqual([forX, forY, forZone].sort());
      expect(idsOf(await inbox(nobody, at(1)))).toEqual([]);
    });

    it('une note brouillon ou archivée n’y figure pas', async () => {
      const draft = freshUuid();
      await run(
        publisher,
        'communication.note.save_draft',
        draft,
        body('Brouillon', [{ type: 'SITE', ref: siteX }]),
      );
      const archived = await publish('À retirer', [{ type: 'SITE', ref: siteX }]);
      await run(publisher, 'communication.note.archive', archived, { reason: 'Erreur' });
      const seen = idsOf(await inbox(staffX, at(1)));
      expect(seen).not.toContain(draft);
      expect(seen).not.toContain(archived);
    });

    it('expiration : une note expirée à l’instant de la lecture n’y figure plus, une milliseconde plus tôt si', async () => {
      const expiresAt = at(5);
      const noteId = await publish('Éphémère', [{ type: 'SITE', ref: siteX }], {
        expiresAt: expiresAt.toISOString(),
      });
      const justBefore = new Date(expiresAt.getTime() - 1);
      expect(idsOf(await inbox(staffX, justBefore))).toContain(noteId);
      expect(idsOf(await inbox(staffX, expiresAt))).not.toContain(noteId);
      expect(idsOf(await inbox(staffX, at(6)))).not.toContain(noteId);
      // Sans expiration : toujours là, même quatre cents jours plus tard.
      const lasting = await publish('Durable', [{ type: 'SITE', ref: siteX }]);
      expect(idsOf(await inbox(staffX, new Date(NOW_MS + 400 * 86_400_000)))).toContain(lasting);
    });

    it('état du lecteur et accusés attendus : exacts, le filtre ne garde que les notes à accuser', async () => {
      const needsAck = await publish('À accuser', [{ type: 'SITE', ref: siteY }], {
        requiresAck: true,
      });
      const simple = await publish('Simple', [{ type: 'SITE', ref: siteY }]);
      const before = await inbox(staffY, at(1));
      const pendingBefore = before.pendingAcknowledgements;
      expect(pendingBefore).toBeGreaterThanOrEqual(1);
      expect(before.items.find((item) => item.id === needsAck)).toMatchObject({
        requiresAck: true,
        readAt: null,
        acknowledgedAt: null,
        audience: null,
      });
      const onlyPending = await inbox(staffY, at(1), { pendingOnly: true });
      expect(idsOf(onlyPending)).toContain(needsAck);
      expect(idsOf(onlyPending)).not.toContain(simple);
      expect(
        onlyPending.items.every((item) => item.requiresAck && item.acknowledgedAt === null),
      ).toBe(true);

      await run(
        staffY,
        'communication.note.acknowledge',
        needsAck,
        { kind: 'ACKNOWLEDGE' },
        at(2).toISOString(),
      );
      await run(
        staffY,
        'communication.note.acknowledge',
        simple,
        { kind: 'READ' },
        at(2).toISOString(),
      );
      const after = await inbox(staffY, at(3));
      expect(after.pendingAcknowledgements).toBe(pendingBefore - 1);
      expect(after.items.find((item) => item.id === needsAck)).toMatchObject({
        readAt: at(2),
        acknowledgedAt: at(2),
      });
      expect(after.items.find((item) => item.id === simple)).toMatchObject({
        readAt: at(2),
        acknowledgedAt: null,
      });
      // Lire une note simple ne la compte jamais parmi les accusés attendus.
      expect(idsOf(await inbox(staffY, at(3), { pendingOnly: true }))).not.toContain(simple);
    });

    it('tri et curseur : plus récentes d’abord, départagées par identifiant, sans doublon ni oubli', async () => {
      // Un lecteur et un site propres : trois notes publiées au même instant, deux autres plus tard.
      const reader = await db.transaction().execute(async (trx) => {
        const admin = await insertTestUser(trx);
        const site = await insertTestSite(trx, admin, await insertTestZone(trx, admin));
        const role = await insertTestRole(trx, admin, { allowedScopeTypes: ['SITE'] });
        await grantTestPermission(trx, role, 'comm.note.read', admin);
        const actor = await newActor(trx);
        await assignTestRole(trx, actor.id, role, admin, { scopeType: 'SITE', scopeSiteId: site });
        return { actor, site };
      });
      const audience: Audience = [{ type: 'SITE', ref: reader.site }];
      const sameInstant = [
        await publish('Même instant 1', audience, {}, { when: tick(10) }),
        await publish('Même instant 2', audience, {}, { when: tick(10) }),
        await publish('Même instant 3', audience, {}, { when: tick(10) }),
      ];
      const later = await publish('Plus tard', audience, {}, { when: tick(11) });
      const latest = await publish('Le plus tard', audience, {}, { when: tick(12) });
      const expected = [latest, later, ...[...sameInstant].sort().reverse()];

      const all = await inbox(reader.actor, at(13));
      expect(idsOf(all)).toEqual(expected);
      expect(all.nextCursor).toBeNull();

      for (const limit of [1, 2, 3, 4]) {
        const collected: string[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 10; page += 1) {
          const after = cursor === null ? undefined : decodeNoteCursor(cursor);
          const part = await inbox(reader.actor, at(13), {
            limit,
            ...(after === undefined || after === null ? {} : { after }),
          });
          collected.push(...idsOf(part));
          cursor = part.nextCursor;
          if (cursor === null) break;
        }
        expect(collected, `limite ${limit}`).toEqual(expected);
      }
      // Une page pleine sans note de plus ne promet pas de page suivante.
      expect((await inbox(reader.actor, at(13), { limit: expected.length })).nextCursor).toBeNull();
      expect(
        (await inbox(reader.actor, at(13), { limit: expected.length - 1 })).nextCursor,
      ).not.toBeNull();
    });
  });

  describe('gestion', () => {
    it('toutes les notes avec leur audience ; les brouillons du lecteur seulement ; filtre de statut', async () => {
      const published = await publish('Gérée', [{ type: 'SITE', ref: siteX }]);
      const ownDraft = freshUuid();
      await run(
        publisher,
        'communication.note.save_draft',
        ownDraft,
        body('Mon brouillon', [{ type: 'SITE', ref: siteY }]),
      );
      const foreignDraft = freshUuid();
      await run(
        otherPublisher,
        'communication.note.save_draft',
        foreignDraft,
        body('Son brouillon', [{ type: 'SITE', ref: siteY }]),
      );
      const archived = await publish('Retirée', [{ type: 'SITE', ref: siteX }]);
      await run(publisher, 'communication.note.archive', archived, { reason: 'Erreur' });

      const page = await manage(publisher);
      const ids = idsOf(page);
      expect(ids).toEqual(expect.arrayContaining([published, ownDraft, archived]));
      expect(ids).not.toContain(foreignDraft);
      expect(page.items.find((item) => item.id === published)!.audience).toEqual([
        { type: 'SITE', ref: siteX },
      ]);
      expect(page.items.find((item) => item.id === ownDraft)).toMatchObject({
        status: 'DRAFT',
        publishedAt: null,
      });

      const onlyArchived = await manage(publisher, { statuses: ['ARCHIVED'] });
      expect(onlyArchived.items.every((item) => item.status === 'ARCHIVED')).toBe(true);
      expect(idsOf(onlyArchived)).toContain(archived);
      expect(idsOf(onlyArchived)).not.toContain(published);
      const draftsAndArchived = await manage(publisher, { statuses: ['DRAFT', 'ARCHIVED'] });
      expect(idsOf(draftsAndArchived)).toEqual(expect.arrayContaining([ownDraft, archived]));
      expect(idsOf(draftsAndArchived)).not.toContain(published);
    });

    it('pagination de la gestion : curseur, instants égaux départagés par identifiant, aucun doublon ni oubli', async () => {
      // Une bande de quelques millisecondes tirée au hasard dans le passé : aucune autre note de la base
      // partagée n'y tombe, quelles que soient les exécutions voisines. Deux notes y partagent le même instant.
      const base =
        NOW_MS -
        (60 + Math.floor(Math.random() * 400)) * 86_400_000 -
        Math.floor(Math.random() * 86_400_000);
      const inBand = (offset: number) => ({ when: new Date(base + offset).toISOString() });
      const audience: Audience = [{ type: 'SITE', ref: siteX }];
      const oldest = await publish('Pagination 0', audience, {}, inBand(0));
      const tiedA = await publish('Pagination 1', audience, {}, inBand(1));
      const tiedB = await publish('Pagination 2', audience, {}, inBand(1));
      const newest = await publish('Pagination 3', audience, {}, inBand(2));
      const expected = [newest, ...[tiedA, tiedB].sort().reverse(), oldest];
      // On part juste au-dessus de la bande : la base partagée peut contenir des notes plus récentes ou plus anciennes.
      const start = { at: new Date(base + 3), id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' };

      for (const limit of [1, 2, 3]) {
        const collected: string[] = [];
        let after: ReturnType<typeof decodeNoteCursor> = start;
        for (let page = 0; page < 10 && after !== null; page += 1) {
          const part = await manage(publisher, { limit, after });
          collected.push(...idsOf(part));
          if (collected.length >= expected.length) break;
          expect(part.nextCursor, `limite ${limit}`).not.toBeNull();
          after = decodeNoteCursor(part.nextCursor!);
        }
        expect(collected.slice(0, expected.length), `limite ${limit}`).toEqual(expected);
      }
      // Une page de quatre notes les contient toutes, dans le même ordre.
      expect(idsOf(await manage(publisher, { limit: 4, after: start }))).toEqual(expected);
    });

    it('pagination de la gestion : des brouillons créés dans la même milliseconde ne sont ni sautés ni doublés', async () => {
      // La base écrit la création d'un brouillon à la microseconde, le curseur n'est précis qu'à la milliseconde.
      const band = pastBand();
      const stamp = (fraction: string) =>
        `${new Date(band).toISOString().slice(0, 19).replace('T', ' ')}.${fraction}`;
      const draftAt = async (fraction: string): Promise<string> => {
        const id = freshUuid();
        await sql`INSERT INTO communication_internal_notes
            (id, title, body, category, status, created_at, created_by, updated_by)
          VALUES (${toBin(id)}, 'Brouillon à la microseconde', 'Corps', 'INFORMATION', 'DRAFT',
            ${stamp(fraction)}, ${toBin(publisher.id)}, ${toBin(publisher.id)})`.execute(db);
        return id;
      };
      const earlier = await draftAt('100000');
      const sameMs = [await draftAt('123456'), await draftAt('123200'), await draftAt('123900')];
      const expected = [...[...sameMs].sort().reverse(), earlier];
      const start = { at: new Date(band + 1000), id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' };

      for (const limit of [1, 2, 3]) {
        const collected: string[] = [];
        let after: ReturnType<typeof decodeNoteCursor> = start;
        for (let page = 0; page < 10 && after !== null; page += 1) {
          const part = await manage(publisher, { limit, after });
          collected.push(...idsOf(part));
          if (collected.length >= expected.length) break;
          expect(part.nextCursor, `limite ${limit}`).not.toBeNull();
          after = decodeNoteCursor(part.nextCursor!);
        }
        expect(collected.slice(0, expected.length), `limite ${limit}`).toEqual(expected);
      }
    });
  });

  describe('fiche', () => {
    it('lecteur : une note publiée qui le touche, même expirée ; jamais brouillon, archivée ni note d’un autre site', async () => {
      const visible = await publish('Visible', [{ type: 'SITE', ref: siteX }], {
        expiresAt: at(2).toISOString(),
      });
      const read = (actor: Actor, id: string, when: Date) =>
        noteDetail(db, resolver, { userId: actor.id, at: when, id, canManage: false });
      expect(await read(staffX, visible, at(1))).toMatchObject({ id: visible, audience: null });
      // Expirée depuis : la fiche reste lisible (le centre de notes ne la liste plus).
      expect(await read(staffX, visible, at(50))).toMatchObject({ id: visible });
      expect(await read(staffY, visible, at(1))).toBeNull();
      expect(await read(nobody, visible, at(1))).toBeNull();

      const draft = freshUuid();
      await run(
        publisher,
        'communication.note.save_draft',
        draft,
        body('Brouillon', [{ type: 'SITE', ref: siteX }]),
      );
      expect(await read(staffX, draft, at(1))).toBeNull();
      const archived = await publish('Retirée', [{ type: 'SITE', ref: siteX }]);
      await run(publisher, 'communication.note.archive', archived, { reason: 'Erreur' });
      expect(await read(staffX, archived, at(1))).toBeNull();
      expect(await read(staffX, freshUuid(), at(1))).toBeNull();
    });

    it('gestion : toute note avec son audience, son brouillon, jamais le brouillon d’un autre', async () => {
      const published = await publish('Publiée', [{ type: 'SITE', ref: siteX }]);
      const draft = freshUuid();
      await run(
        publisher,
        'communication.note.save_draft',
        draft,
        body('Brouillon', [{ type: 'ZONE', ref: zoneX }]),
      );
      const read = (actor: Actor, id: string) =>
        noteDetail(db, resolver, { userId: actor.id, at: at(1), id, canManage: true });
      expect(await read(otherPublisher, published)).toMatchObject({
        audience: [{ type: 'SITE', ref: siteX }],
      });
      expect(await read(publisher, draft)).toMatchObject({ status: 'DRAFT' });
      expect(await read(otherPublisher, draft)).toBeNull();
    });
  });

  describe('suivi des accusés', () => {
    it('audience résolue maintenant (l’auteur excepté), lus, accusés, manquants selon l’accusé requis', async () => {
      const needsAck = await publish(
        'À accuser',
        [
          { type: 'SITE', ref: siteX },
          { type: 'USER', ref: publisher.id },
        ],
        { requiresAck: true },
      );
      // Touchés : le site X, la zone qui le couvre, et l'auteur (désigné, exclu du suivi).
      const initial = await noteAcknowledgementFollowUp(db, resolver, {
        userId: publisher.id,
        at: at(1),
        id: needsAck,
      });
      expect(initial).toMatchObject({
        noteId: needsAck,
        requiresAck: true,
        audienceSize: 2,
        read: 0,
        acknowledged: 0,
      });
      expect([...initial!.missingUserIds].sort()).toEqual([staffX.id, manager.id].sort());

      // Lire sans accuser : la note exige un accusé, la personne reste manquante.
      await run(
        manager,
        'communication.note.acknowledge',
        needsAck,
        { kind: 'READ' },
        at(2).toISOString(),
      );
      const readOnly = await noteAcknowledgementFollowUp(db, resolver, {
        userId: publisher.id,
        at: at(3),
        id: needsAck,
      });
      expect(readOnly).toMatchObject({ read: 1, acknowledged: 0 });
      expect(readOnly!.missingUserIds).toContain(manager.id);

      await run(
        manager,
        'communication.note.acknowledge',
        needsAck,
        { kind: 'ACKNOWLEDGE' },
        at(4).toISOString(),
      );
      const done = await noteAcknowledgementFollowUp(db, resolver, {
        userId: publisher.id,
        at: at(5),
        id: needsAck,
      });
      expect(done).toMatchObject({ audienceSize: 2, read: 1, acknowledged: 1 });
      expect(done!.missingUserIds).toEqual([staffX.id]);

      // Note simple : manquant = sans lecture.
      const simple = await publish('Simple', [{ type: 'SITE', ref: siteY }]);
      await run(
        staffY,
        'communication.note.acknowledge',
        simple,
        { kind: 'READ' },
        at(2).toISOString(),
      );
      const simpleFollowUp = await noteAcknowledgementFollowUp(db, resolver, {
        userId: publisher.id,
        at: at(3),
        id: simple,
      });
      expect(simpleFollowUp).toMatchObject({
        requiresAck: false,
        audienceSize: 2,
        read: 1,
        acknowledged: 0,
      });
      expect(simpleFollowUp!.missingUserIds).toEqual([manager.id]);
    });

    it('note inconnue ou brouillon d’un autre : introuvable', async () => {
      expect(
        await noteAcknowledgementFollowUp(db, resolver, {
          userId: publisher.id,
          at: at(1),
          id: freshUuid(),
        }),
      ).toBeNull();
      const draft = freshUuid();
      await run(
        publisher,
        'communication.note.save_draft',
        draft,
        body('Brouillon', [{ type: 'SITE', ref: siteX }]),
      );
      expect(
        await noteAcknowledgementFollowUp(db, resolver, {
          userId: otherPublisher.id,
          at: at(1),
          id: draft,
        }),
      ).toBeNull();
      // Le brouillon de l'auteur n'a pas encore d'audience : aucun suivi.
      expect(
        await noteAcknowledgementFollowUp(db, resolver, {
          userId: publisher.id,
          at: at(1),
          id: draft,
        }),
      ).toEqual({
        noteId: draft,
        requiresAck: false,
        audienceSize: 0,
        read: 0,
        acknowledged: 0,
        missingUserIds: [],
      });
    });
  });

  describe('plafond de balayage du centre de notes', () => {
    it('une note à accuser reste dans le centre au-delà du plafond ; le reste est tronqué et signalé', async (context) => {
      const reader = await newSiteReader();
      const band = pastBand();
      const own: Audience = [{ type: 'SITE', ref: reader.site }];
      const pending = await publish(
        'À accuser, ancienne',
        own,
        { requiresAck: true },
        { when: new Date(band).toISOString() },
      );
      const simpleOld = await publish(
        'Simple, ancienne',
        own,
        {},
        { when: new Date(band + 1).toISOString() },
      );
      // Une note à accuser qui vise un autre site n'est pas attendue de ce lecteur.
      const foreign = await publish(
        'À accuser, ailleurs',
        [{ type: 'SITE', ref: siteX }],
        { requiresAck: true },
        { when: new Date(band + 2).toISOString() },
      );
      await publish('Récente', own, {}, { when: tick(50) });

      // Notes à accuser du système, tous lecteurs confondus : le plafond de ces notes les couvre toutes.
      const unacknowledged = await db
        .selectFrom('communication_internal_notes')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('status', '=', 'PUBLISHED')
        .where('requires_ack', '=', 1)
        .executeTakeFirstOrThrow();
      // Balayer des milliers de notes d'une base d'essai très ancienne n'apprendrait rien de plus.
      if (Number(unacknowledged.n) > 5000) context.skip();
      const scan = { recent: 1, pending: Number(unacknowledged.n) + 100 };

      // Plafond de une note récente : seule la plus récente du système est balayée, la note à accuser s'y ajoute.
      const capped = await inbox(reader.actor, at(1), { scan });
      expect(capped.truncated).toBe(true);
      expect(idsOf(capped)).toContain(pending);
      expect(idsOf(capped)).not.toContain(simpleOld);
      expect(idsOf(capped)).not.toContain(foreign);
      expect(capped.pendingAcknowledgements).toBe(1);
      // La gestion signale de même le plafond atteint du compteur.
      expect((await manage(publisher, { scan: { recent: 1 } })).truncated).toBe(true);
      const onlyPending = await inbox(reader.actor, at(1), { scan, pendingOnly: true });
      expect(idsOf(onlyPending)).toEqual([pending]);

      // Lue sans être accusée, elle reste attendue.
      await run(
        reader.actor,
        'communication.note.acknowledge',
        pending,
        { kind: 'READ' },
        at(1.5).toISOString(),
      );
      const read = await inbox(reader.actor, at(1.6), { scan });
      expect(idsOf(read)).toContain(pending);
      expect(read.items.find((item) => item.id === pending)).toMatchObject({
        readAt: at(1.5),
        acknowledgedAt: null,
      });
      expect(read.pendingAcknowledgements).toBe(1);

      // Accusée, elle sort du centre ; le plafond reste atteint.
      await run(
        reader.actor,
        'communication.note.acknowledge',
        pending,
        { kind: 'ACKNOWLEDGE' },
        at(2).toISOString(),
      );
      const after = await inbox(reader.actor, at(3), { scan });
      expect(idsOf(after)).not.toContain(pending);
      expect(after.pendingAcknowledgements).toBe(0);
      expect(after.truncated).toBe(true);
    });

    it('un plafond qui couvre toutes les notes publiées ne tronque rien', async (context) => {
      const total = await db
        .selectFrom('communication_internal_notes')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('status', '=', 'PUBLISHED')
        .executeTakeFirstOrThrow();
      // Balayer des dizaines de milliers de notes d'une base d'essai très ancienne n'apprend rien de plus.
      if (Number(total.n) > 3000) context.skip();
      const reader = await newSiteReader();
      const note = await publish('Seule', [{ type: 'SITE', ref: reader.site }], {
        requiresAck: true,
      });
      const cap = Number(total.n) + 100;
      const page = await inbox(reader.actor, at(1), { scan: { recent: cap, pending: cap } });
      expect(page.truncated).toBe(false);
      expect(idsOf(page)).toEqual([note]);
      expect(page.pendingAcknowledgements).toBe(1);

      // Le seul plafond des notes à accuser suffit à signaler la troncature (une note attendue au moins).
      const pendingCapped = await inbox(reader.actor, at(1), { scan: { recent: cap, pending: 0 } });
      expect(pendingCapped.truncated).toBe(true);
    });
  });

  describe('utilisateur suspendu', () => {
    it('affecté au site mais suspendu, il ne voit rien : ni centre de notes, ni fiche', async () => {
      const suspendedReader = await newSiteReader({ status: 'SUSPENDED' });
      const activeReader = await newSiteReader();
      const own = (site: string): Audience => [{ type: 'SITE', ref: site }];
      const note = await publish('Pour le suspendu', own(suspendedReader.site));
      const control = await publish('Pour l’actif', own(activeReader.site));

      expect(idsOf(await inbox(suspendedReader.actor, at(1)))).toEqual([]);
      const detail = (actor: Actor, id: string) =>
        noteDetail(db, resolver, { userId: actor.id, at: at(1), id, canManage: false });
      expect(await detail(suspendedReader.actor, note)).toBeNull();
      // Le même montage avec un utilisateur actif voit sa note.
      expect(idsOf(await inbox(activeReader.actor, at(1)))).toEqual([control]);
      expect(await detail(activeReader.actor, control)).toMatchObject({ id: control });
    });
  });

  describe('identifiant en majuscules', () => {
    it('la fiche et le suivi lisent la même audience qu’avec l’identifiant en minuscules', async () => {
      const noteId = await publish('Casse', [{ type: 'SITE', ref: siteX }], { requiresAck: true });
      const upper = noteId.toUpperCase();
      expect(upper).not.toBe(noteId);
      const detail = (actor: Actor, canManage: boolean) =>
        noteDetail(db, resolver, { userId: actor.id, at: at(1), id: upper, canManage });

      // Un lecteur visé la lit (l'audience a bien été retrouvée) ; un lecteur d'un autre site, non.
      await run(
        staffX,
        'communication.note.acknowledge',
        noteId,
        { kind: 'READ' },
        at(2).toISOString(),
      );
      expect(await detail(staffX, false)).toMatchObject({
        id: noteId,
        audience: null,
        readAt: at(2),
      });
      expect(await detail(staffY, false)).toBeNull();
      // La gestion reçoit l'audience réelle, pas une audience vide.
      expect((await detail(publisher, true))!.audience).toEqual([{ type: 'SITE', ref: siteX }]);

      const followUp = (id: string) =>
        noteAcknowledgementFollowUp(db, resolver, { userId: publisher.id, at: at(1), id });
      const lower = await followUp(noteId);
      expect(lower).toMatchObject({ noteId, audienceSize: 2 });
      expect(await followUp(upper)).toEqual(lower);
    });
  });

  describe('curseur', () => {
    it('aller-retour ; une valeur altérée ou inattendue n’est pas un curseur', () => {
      const cursor = { at: at(3), id: freshUuid() };
      expect(decodeNoteCursor(encodeNoteCursor(cursor))).toEqual(cursor);
      for (const raw of [
        'pas-un-curseur',
        Buffer.from('{}').toString('base64url'),
        Buffer.from(JSON.stringify({ t: 'hier', id: freshUuid() })).toString('base64url'),
        Buffer.from(JSON.stringify({ t: NOW, id: 'pas-un-uuid' })).toString('base64url'),
        Buffer.from(JSON.stringify({ t: 12, id: freshUuid() })).toString('base64url'),
      ]) {
        expect(decodeNoteCursor(raw)).toBeNull();
      }
    });
  });
});
