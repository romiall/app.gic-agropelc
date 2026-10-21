/**
 * P9-11 (2/3) — lectures HTTP des notes de direction, de bout en bout : NestJS + Fastify, `app.inject()`, notes
 * écrites par le vrai pipeline (commandes `communication.note.*`), rôles réels du seed.
 *
 * Démontre (ADR-073 §3, §5, §6 ; BR-NOT-006 ; RC-07, RC-09 ; AV-476, AV-479) : le centre de notes d'un lecteur
 * (publiées, non expirées, qui le touchent ; jamais brouillon, archivée, expirée ni note d'un autre site) ; les
 * affectations de zone voient les notes des sites qu'elles couvrent ; l'accusé retire la note des accusés
 * attendus ; la fiche (404 opaque audité hors audience) ; la gestion (brouillons du lecteur seulement, audience
 * visible) et le suivi des accusés réservés à `comm.note.publish` ; paramètres invalides ; pagination. Les
 * audiences ne nomment que des sites et zones propres au fichier (base partagée, jamais `ALL` ni un rôle réel).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Clock } from '@gic/domain';
import {
  noteAcknowledgementsResponseSchema,
  noteItemSchema,
  noteListResponseSchema,
  type NoteItem,
} from '@gic/contracts';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { newActor, tx, type Actor } from './cash-transfer-fixtures.js';
import {
  closeTestDb,
  db,
  freshUuid,
  insertTestSite,
  insertTestUser,
  insertTestZone,
  signTestAccessToken,
} from './helpers.js';

const HOUR_MS = 3_600_000;
let deviceSeq = 0;

describe('P9-11 (2/3) : lectures HTTP des notes de direction', { timeout: 300_000 }, () => {
  let app: NestFastifyApplication;
  let clock: Clock;
  let pipeline: CommandPipelineService;
  const tokens = new Map<string, string>();

  let director: Actor;
  let director2: Actor;
  let sellerA: Actor;
  let sellerB: Actor;
  let zoneStaff: Actor;
  let stranger: Actor;
  let siteA: string;
  let siteB: string;
  let siteC: string;
  let zone: string;

  const notes = {
    a: '', // site A, accusé requis, expire dans deux jours
    b: '', // site B
    zone: '', // toute la zone, sans accusé
    archived: '', // site A, retirée
    expired: '', // site A, publiée il y a deux jours, expirée depuis hier
    draft: '', // brouillon de `director`
    otherDraft: '', // brouillon de `director2`
  };

  const get = (actor: Actor, url: string) =>
    app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${tokens.get(actor.userId)!}` },
    });

  async function command(actor: Actor, commandType: string, noteId: string, payload: unknown) {
    const occurredAt = clock.now().toISOString();
    return pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: commandType,
        aggregate_type: 'INTERNAL_NOTE',
        aggregate_id: noteId,
        author_user_id: actor.userId,
        base_version: null,
        depends_on: [],
        occurred_at: occurredAt,
        client_created_at: occurredAt,
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload,
      },
      {
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        transport: 'SYNC_PUSH',
      },
    );
  }

  const content = (
    title: string,
    audience: unknown[],
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    title,
    body: `Corps de « ${title} ».`,
    category: 'INSTRUCTION',
    requiresAck: false,
    audience,
    ...extra,
  });

  async function publishNote(actor: Actor, title: string, audience: unknown[], extra = {}) {
    const noteId = freshUuid();
    const result = await command(
      actor,
      'communication.note.publish',
      noteId,
      content(title, audience, extra),
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    return noteId;
  }

  /** Code d'erreur d'une réponse (enveloppe `error.code` ou code à plat selon le filtre d'exceptions). */
  const codeOf = (response: { json: () => { error?: { code?: string }; code?: string } }) =>
    response.json().error?.code ?? response.json().code;

  /** Toute la gestion (base partagée : on suit les pages jusqu'au bout, 200 notes par page). */
  const manageAll = async (actor: Actor, query = ''): Promise<Map<string, NoteItem>> => {
    const found = new Map<string, NoteItem>();
    let cursor: string | null = null;
    for (let page = 0; page < 500; page += 1) {
      const suffix = cursor === null ? '' : `&cursor=${cursor}`;
      const response = await get(actor, `/api/v1/notes?scope=manage&limit=200${query}${suffix}`);
      expect(response.statusCode, response.body).toBe(200);
      const body = noteListResponseSchema.parse(response.json());
      for (const item of body.items) found.set(item.id, item);
      cursor = body.nextCursor;
      if (cursor === null) break;
    }
    return found;
  };

  const inboxIds = async (actor: Actor, query = ''): Promise<string[]> => {
    const response = await get(actor, `/api/v1/notes${query}`);
    expect(response.statusCode, response.body).toBe(200);
    const body = noteListResponseSchema.parse(response.json());
    return body.items.map((item) => item.id);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerCorrelationId(app, app.get(ID_GENERATOR));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    clock = app.get(CLOCK);
    pipeline = app.get(CommandPipelineService);
    const jwtKeys = app.get(JWT_KEYS);

    const root = await tx((trx) => insertTestUser(trx));
    zone = await tx((trx) => insertTestZone(trx, root));
    const otherZone = await tx((trx) => insertTestZone(trx, root));
    await tx(async (trx) => {
      siteA = await insertTestSite(trx, root, zone);
      siteB = await insertTestSite(trx, root, zone);
      siteC = await insertTestSite(trx, root, otherZone);
    });
    director = await newActor('DIRECTION', root);
    director2 = await newActor('DIRECTION', root);
    sellerA = await newActor('VENDEUR_PDV', root, { scopeType: 'SITE', scopeSiteId: siteA });
    sellerB = await newActor('VENDEUR_PDV', root, { scopeType: 'SITE', scopeSiteId: siteB });
    zoneStaff = await newActor('COMMERCIAL_TERRAIN', root, {
      scopeType: 'ZONE',
      scopeZoneId: zone,
    });
    stranger = await newActor('VENDEUR_PDV', root, { scopeType: 'SITE', scopeSiteId: siteC });
    for (const actor of [director, director2, sellerA, sellerB, zoneStaff, stranger]) {
      tokens.set(
        actor.userId,
        await signTestAccessToken(
          jwtKeys.privateKey,
          { sub: actor.userId, device_id: actor.deviceId, session_id: freshUuid() },
          clock.now(),
        ),
      );
    }

    const inTwoDays = new Date(clock.now().getTime() + 48 * HOUR_MS).toISOString();
    notes.a = await publishNote(director, 'Prix du site A', [{ type: 'SITE', ref: siteA }], {
      requiresAck: true,
      expiresAt: inTwoDays,
    });
    notes.b = await publishNote(director, 'Prix du site B', [{ type: 'SITE', ref: siteB }]);
    notes.zone = await publishNote(director, 'Consigne de zone', [{ type: 'ZONE', ref: zone }]);
    notes.archived = await publishNote(director, 'Note retirée', [{ type: 'SITE', ref: siteA }]);
    expect(
      (await command(director, 'communication.note.archive', notes.archived, { reason: 'Erreur' }))
        .status,
    ).toBe('APPLIED');

    // Une note expirée depuis hier : écrite directement (la commande refuse une expiration passée).
    notes.expired = freshUuid();
    const published = new Date(clock.now().getTime() - 48 * HOUR_MS);
    await db
      .insertInto('communication_internal_notes')
      .values({
        id: toBin(notes.expired),
        title: 'Note expirée',
        body: 'Ancienne consigne.',
        category: 'INFORMATION',
        status: 'DRAFT',
        created_by: toBin(director.userId),
      })
      .execute();
    await db
      .insertInto('communication_note_audiences')
      .values({ note_id: toBin(notes.expired), audience_type: 'SITE', audience_ref: siteA })
      .execute();
    await db
      .updateTable('communication_internal_notes')
      .set({
        status: 'PUBLISHED',
        published_at: published,
        expires_at: new Date(published.getTime() + 24 * HOUR_MS),
      })
      .where('id', '=', toBin(notes.expired))
      .execute();

    notes.draft = freshUuid();
    expect(
      (
        await command(
          director,
          'communication.note.save_draft',
          notes.draft,
          content('Brouillon de la Direction', [{ type: 'SITE', ref: siteB }]),
        )
      ).status,
    ).toBe('APPLIED');
    notes.otherDraft = freshUuid();
    expect(
      (
        await command(
          director2,
          'communication.note.save_draft',
          notes.otherDraft,
          content('Brouillon d’une autre', [{ type: 'SITE', ref: siteB }]),
        )
      ).status,
    ).toBe('APPLIED');
  });

  afterAll(async () => {
    await app.close();
    await closeTestDb();
  });

  describe('GET /notes (centre de notes)', () => {
    it('chaque lecteur voit les notes publiées, non expirées, qui le touchent — et seulement elles', async () => {
      expect((await inboxIds(sellerA)).sort()).toEqual([notes.a, notes.zone].sort());
      expect((await inboxIds(sellerB)).sort()).toEqual([notes.b, notes.zone].sort());
      // Une affectation de zone couvre les sites de la zone.
      expect((await inboxIds(zoneStaff)).sort()).toEqual([notes.a, notes.b, notes.zone].sort());
      expect(await inboxIds(stranger)).toEqual([]);
    });

    it('jamais un brouillon, une note archivée ni une note expirée, même pour la Direction dans son centre de notes', async () => {
      const seen = new Set([
        ...(await inboxIds(sellerA)),
        ...(await inboxIds(sellerB)),
        ...(await inboxIds(zoneStaff)),
        ...(await inboxIds(director)),
      ]);
      for (const hidden of [notes.archived, notes.expired, notes.draft, notes.otherDraft]) {
        expect(seen.has(hidden)).toBe(false);
      }
    });

    it('chaque note porte l’état du lecteur ; le compteur des accusés attendus est exact ; le filtre ne garde que les notes à accuser', async () => {
      const response = await get(sellerA, '/api/v1/notes');
      const body = noteListResponseSchema.parse(response.json());
      expect(body.pendingAcknowledgements).toBe(1);
      const a = body.items.find((item) => item.id === notes.a)!;
      expect(a).toMatchObject({
        title: 'Prix du site A',
        requiresAck: true,
        status: 'PUBLISHED',
        readAt: null,
        acknowledgedAt: null,
        authorUserId: director.userId,
      });
      // Un lecteur ne voit pas l'audience.
      expect(a.audience).toBeUndefined();
      expect(await inboxIds(sellerA, '?pending_ack=true')).toEqual([notes.a]);
      expect((await inboxIds(sellerA, '?pending_ack=false')).sort()).toEqual(
        [notes.a, notes.zone].sort(),
      );
    });

    it('l’accusé retire la note des accusés attendus et renseigne l’état du lecteur', async () => {
      const ack = await command(sellerA, 'communication.note.acknowledge', notes.a, {
        kind: 'ACKNOWLEDGE',
      });
      expect(ack.status, JSON.stringify(ack)).toBe('APPLIED');
      const body = noteListResponseSchema.parse((await get(sellerA, '/api/v1/notes')).json());
      expect(body.pendingAcknowledgements).toBe(0);
      const a = body.items.find((item) => item.id === notes.a)!;
      expect(a.acknowledgedAt).not.toBeNull();
      expect(a.readAt).not.toBeNull();
      expect(await inboxIds(sellerA, '?pending_ack=true')).toEqual([]);
      // Un autre lecteur de la même note n'est pas touché.
      expect(
        noteListResponseSchema.parse((await get(zoneStaff, '/api/v1/notes')).json())
          .pendingAcknowledgements,
      ).toBe(1);
    });

    it('pagination : le curseur reprend où la page précédente s’arrête, sans doublon ni oubli', async () => {
      const first = noteListResponseSchema.parse(
        (await get(zoneStaff, '/api/v1/notes?limit=2')).json(),
      );
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const second = noteListResponseSchema.parse(
        (await get(zoneStaff, `/api/v1/notes?limit=2&cursor=${first.nextCursor}`)).json(),
      );
      expect(second.items).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      expect([...first.items, ...second.items].map((item) => item.id).sort()).toEqual(
        [notes.a, notes.b, notes.zone].sort(),
      );
      // Plus récentes d'abord.
      expect(first.items.map((item) => item.id)).toEqual([notes.zone, notes.b]);
    });

    it('paramètres invalides : statut hors gestion, accusé en gestion, curseur, limite, portée → 400', async () => {
      for (const url of [
        '/api/v1/notes?status=PUBLISHED',
        '/api/v1/notes?scope=manage&pending_ack=true',
        '/api/v1/notes?cursor=pas-un-curseur',
        '/api/v1/notes?limit=0',
        '/api/v1/notes?limit=201',
        '/api/v1/notes?scope=tout',
        '/api/v1/notes?pending_ack=peut-etre',
      ]) {
        const response = await get(director, url);
        expect(response.statusCode, url).toBe(400);
        expect(codeOf(response), url).toBe('VALIDATION_ERROR');
      }
    });

    it('sans jeton : 401', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/v1/notes' });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /notes/{id} (fiche)', () => {
    it('un lecteur touché lit la note, sans audience ; une note qui ne le touche pas est un 404 audité', async () => {
      const response = await get(sellerA, `/api/v1/notes/${notes.a}`);
      expect(response.statusCode, response.body).toBe(200);
      const item = noteItemSchema.parse(response.json());
      expect(item).toMatchObject({ id: notes.a, title: 'Prix du site A', status: 'PUBLISHED' });
      expect(item.audience).toBeUndefined();

      const foreign = await get(sellerA, `/api/v1/notes/${notes.b}`);
      expect(foreign.statusCode).toBe(404);
      const denied = await db
        .selectFrom('audit_audit_log')
        .select(['action', 'error_code'])
        .where('actor_user_id', '=', toBin(sellerA.userId))
        .where('entity_id', '=', toBin(notes.b))
        .where('action', '=', 'access.denied')
        .execute();
      expect(denied.length).toBeGreaterThanOrEqual(1);
      expect(denied[0]!.error_code).toBe('NOT_FOUND');
    });

    it('une note expirée reste lisible de qui elle touche ; archivée ou en brouillon : introuvable pour un lecteur', async () => {
      expect((await get(sellerA, `/api/v1/notes/${notes.expired}`)).statusCode).toBe(200);
      expect((await get(sellerA, `/api/v1/notes/${notes.archived}`)).statusCode).toBe(404);
      expect((await get(sellerB, `/api/v1/notes/${notes.draft}`)).statusCode).toBe(404);
      expect((await get(sellerA, `/api/v1/notes/${freshUuid()}`)).statusCode).toBe(404);
      expect((await get(sellerA, '/api/v1/notes/pas-un-uuid')).statusCode).toBe(400);
    });

    it('la gestion lit toute note avec son audience, et son brouillon, jamais celui d’un autre', async () => {
      const archived = noteItemSchema.parse(
        (await get(director2, `/api/v1/notes/${notes.archived}`)).json(),
      );
      expect(archived).toMatchObject({ status: 'ARCHIVED' });
      expect(archived.audience).toEqual([{ type: 'SITE', ref: siteA }]);
      expect((await get(director, `/api/v1/notes/${notes.draft}`)).statusCode).toBe(200);
      expect((await get(director, `/api/v1/notes/${notes.otherDraft}`)).statusCode).toBe(404);
      expect((await get(director2, `/api/v1/notes/${notes.otherDraft}`)).statusCode).toBe(200);
    });
  });

  describe('GET /notes?scope=manage et /notes/{id}/acknowledgements (Direction)', () => {
    it('la gestion liste les notes de tous avec audience, les brouillons du lecteur seulement', async () => {
      const byId = await manageAll(director);
      for (const id of [notes.a, notes.b, notes.zone, notes.archived, notes.expired, notes.draft]) {
        expect(byId.has(id), id).toBe(true);
      }
      expect(byId.has(notes.otherDraft)).toBe(false);
      expect(byId.get(notes.a)!.audience).toEqual([{ type: 'SITE', ref: siteA }]);
      expect(byId.get(notes.draft)).toMatchObject({ status: 'DRAFT', publishedAt: null });
      expect(byId.get(notes.archived)).toMatchObject({ status: 'ARCHIVED' });
    });

    it('le filtre de statut de la gestion', async () => {
      const found = await manageAll(director, '&status=ARCHIVED,DRAFT');
      expect([...found.values()].every((item) => ['ARCHIVED', 'DRAFT'].includes(item.status))).toBe(
        true,
      );
      expect(found.has(notes.archived)).toBe(true);
      expect(found.has(notes.draft)).toBe(true);
      expect(found.has(notes.otherDraft)).toBe(false);
      expect(found.has(notes.a)).toBe(false);
      expect((await get(director, '/api/v1/notes?scope=manage&status=PERDUE')).statusCode).toBe(
        400,
      );
    });

    it('un lecteur sans droit de publier : 403 audité sur la gestion et sur le suivi des accusés', async () => {
      const manage = await get(sellerA, '/api/v1/notes?scope=manage');
      expect(manage.statusCode).toBe(403);
      expect(codeOf(manage)).toBe('FORBIDDEN');
      const followUp = await get(sellerA, `/api/v1/notes/${notes.a}/acknowledgements`);
      expect(followUp.statusCode).toBe(403);
    });

    it('suivi des accusés : audience résolue maintenant (l’auteur excepté), lus, accusés, manquants nommés', async () => {
      const response = await get(director, `/api/v1/notes/${notes.a}/acknowledgements`);
      expect(response.statusCode, response.body).toBe(200);
      const body = noteAcknowledgementsResponseSchema.parse(response.json());
      // Note du site A à accusé requis : le vendeur du site A (a accusé) et l'affectation de zone qui le couvre.
      expect(body).toMatchObject({ noteId: notes.a, audienceSize: 2, read: 1, acknowledged: 1 });
      expect(body.missing).toEqual([{ userId: zoneStaff.userId, fullName: 'Test' }]);

      // Note simple : les manquants sont ceux qui ne l'ont pas lue.
      const simple = noteAcknowledgementsResponseSchema.parse(
        (await get(director, `/api/v1/notes/${notes.zone}/acknowledgements`)).json(),
      );
      expect(simple).toMatchObject({ audienceSize: 3, read: 0, acknowledged: 0 });
      expect(simple.missing.map((m) => m.userId).sort()).toEqual(
        [sellerA.userId, sellerB.userId, zoneStaff.userId].sort(),
      );
      const read = await command(sellerB, 'communication.note.acknowledge', notes.zone, {
        kind: 'READ',
      });
      expect(read.status).toBe('APPLIED');
      const after = noteAcknowledgementsResponseSchema.parse(
        (await get(director, `/api/v1/notes/${notes.zone}/acknowledgements`)).json(),
      );
      expect(after).toMatchObject({ read: 1, acknowledged: 0 });
      expect(after.missing.map((m) => m.userId)).not.toContain(sellerB.userId);
    });

    it('suivi des accusés : note inconnue ou brouillon d’un autre → 404', async () => {
      expect(
        (await get(director, `/api/v1/notes/${freshUuid()}/acknowledgements`)).statusCode,
      ).toBe(404);
      expect(
        (await get(director, `/api/v1/notes/${notes.otherDraft}/acknowledgements`)).statusCode,
      ).toBe(404);
      expect(
        (await get(director, `/api/v1/notes/${notes.draft}/acknowledgements`)).statusCode,
      ).toBe(200);
    });
  });
});
