/**
 * P9-11 (1/3) : commandes des notes de direction (ADR-073 ; D13 UC-NOT-05 et 06 ; BR-NOT-006, BR-NOT-007 ;
 * AT-048 ; AV-476 à AV-478) — `communication.note.save_draft`, `.publish`, `.archive` et `.acknowledge`, par le
 * vrai pipeline de commande, le vrai résolveur d'audience et la base partagée (utilisateurs, rôles, zones,
 * sites et notes neufs : les audiences ne nomment que des objets propres au test, jamais `ALL`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerNoteCommands } from '../src/modules/communication/application/commands/note-commands.js';
import { IdentityNoteAudienceResolver } from '../src/communication-api/identity-note-audience-resolver.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
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

const NOW = '2026-10-21T09:00:00.000Z';
const HOUR_MS = 3_600_000;
const at = (offsetHours: number): string =>
  new Date(new Date(NOW).getTime() + offsetHours * HOUR_MS).toISOString();

interface Actor {
  readonly id: string;
  readonly deviceId: string;
}

let deviceSeq = 0;
const seqByCommand = new Map<string, number>();

describe('notes de direction : commandes (P9-11)', () => {
  let idGenerator: IdGenerator;
  let clock: FixedClock;
  let pipeline: CommandPipelineService;

  // Géographie : zoneParent ⊃ zoneChild ; siteChild ∈ zoneChild, siteParent ∈ zoneParent ; siteOther dans une autre zone.
  let zoneParent: string;
  let zoneChild: string;
  let siteChild: string;
  let siteParent: string;
  let siteOther: string;
  let holderRoleCode: string;

  let director: Actor; // publie (comm.note.publish)
  let secondPublisher: Actor; // publie aussi : n'est pas l'auteur des brouillons du premier
  let siteStaff: Actor; // affecté au site siteChild
  let zoneManager: Actor; // affecté à la zone zoneChild
  let parentZoneManager: Actor; // affecté à la zone zoneParent
  let siteParentStaff: Actor; // affecté au site siteParent
  let otherSiteStaff: Actor; // affecté au site siteOther
  let roleHolder: Actor; // détient le rôle ciblé par les audiences de rôle
  let suspended: Actor; // utilisateur suspendu affecté à siteChild
  let revokedStaff: Actor; // affectation à siteChild révoquée avant la publication
  let expiredStaff: Actor; // affectation à siteChild échue avant la publication

  async function newActor(
    trx: Parameters<typeof insertTestDevice>[0],
    admin: string,
    options: { status?: 'ACTIVE' | 'SUSPENDED' } = {},
  ): Promise<Actor> {
    const id = await insertTestUser(trx, options);
    return { id, deviceId: await insertTestDevice(trx, id, { status: 'ACTIVE' }) };
  }

  beforeAll(async () => {
    clock = new FixedClock(new Date(NOW));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    registerNoteCommands(registry, {
      idGenerator,
      clock,
      audience: new IdentityNoteAudienceResolver(),
    });
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    await db.transaction().execute(async (trx) => {
      const admin = await insertTestUser(trx);
      zoneParent = await insertTestZone(trx, admin);
      zoneChild = await insertTestZone(trx, admin, { parentId: zoneParent });
      const zoneOther = await insertTestZone(trx, admin);
      siteChild = await insertTestSite(trx, admin, zoneChild);
      siteParent = await insertTestSite(trx, admin, zoneParent);
      siteOther = await insertTestSite(trx, admin, zoneOther);

      const publisherRole = await insertTestRole(trx, admin);
      await grantTestPermission(trx, publisherRole, 'comm.note.publish', admin);
      await grantTestPermission(trx, publisherRole, 'comm.note.read', admin);
      const readerRole = await insertTestRole(trx, admin, {
        allowedScopeTypes: ['GLOBAL', 'SITE', 'ZONE'],
      });
      await grantTestPermission(trx, readerRole, 'comm.note.read', admin);
      const holderRole = await insertTestRole(trx, admin);
      await grantTestPermission(trx, holderRole, 'comm.note.read', admin);
      const code = await trx
        .selectFrom('identity_roles')
        .select('code')
        .where('id', '=', toBin(holderRole))
        .executeTakeFirstOrThrow();
      holderRoleCode = code.code;

      director = await newActor(trx, admin);
      await assignTestRole(trx, director.id, publisherRole, admin);
      secondPublisher = await newActor(trx, admin);
      await assignTestRole(trx, secondPublisher.id, publisherRole, admin);

      siteStaff = await newActor(trx, admin);
      await assignTestRole(trx, siteStaff.id, readerRole, admin, {
        scopeType: 'SITE',
        scopeSiteId: siteChild,
      });
      zoneManager = await newActor(trx, admin);
      await assignTestRole(trx, zoneManager.id, readerRole, admin, {
        scopeType: 'ZONE',
        scopeZoneId: zoneChild,
      });
      parentZoneManager = await newActor(trx, admin);
      await assignTestRole(trx, parentZoneManager.id, readerRole, admin, {
        scopeType: 'ZONE',
        scopeZoneId: zoneParent,
      });
      siteParentStaff = await newActor(trx, admin);
      await assignTestRole(trx, siteParentStaff.id, readerRole, admin, {
        scopeType: 'SITE',
        scopeSiteId: siteParent,
      });
      otherSiteStaff = await newActor(trx, admin);
      await assignTestRole(trx, otherSiteStaff.id, readerRole, admin, {
        scopeType: 'SITE',
        scopeSiteId: siteOther,
      });
      roleHolder = await newActor(trx, admin);
      await assignTestRole(trx, roleHolder.id, holderRole, admin);
      suspended = await newActor(trx, admin, { status: 'SUSPENDED' });
      await assignTestRole(trx, suspended.id, readerRole, admin, {
        scopeType: 'SITE',
        scopeSiteId: siteChild,
      });
      revokedStaff = await newActor(trx, admin);
      await assignTestRole(trx, revokedStaff.id, readerRole, admin, {
        scopeType: 'SITE',
        scopeSiteId: siteChild,
        revokedAt: new Date(at(-1)),
      });
      expiredStaff = await newActor(trx, admin);
      await assignTestRole(trx, expiredStaff.id, readerRole, admin, {
        scopeType: 'SITE',
        scopeSiteId: siteChild,
        validTo: new Date(at(-2)),
      });
    });
  });

  afterAll(closeTestDb);

  async function run(
    actor: Actor,
    commandType: string,
    noteId: string,
    payload: unknown,
    options: {
      readonly occurredAt?: string;
      readonly offline?: boolean;
      readonly commandId?: string;
      /** Instant où le serveur traite la commande (horloge du pipeline et des gestionnaires). */
      readonly processedAt?: string;
    } = {},
  ) {
    const commandId = options.commandId ?? freshUuid();
    const seq = seqByCommand.get(commandId) ?? ++deviceSeq;
    seqByCommand.set(commandId, seq);
    const occurredAt = options.occurredAt ?? NOW;
    // Une commande saisie hors ligne arrive plus tard (douze heures) ; en ligne, elle est traitée à son instant.
    clock.setTo(new Date(options.processedAt ?? (options.offline === true ? at(12) : occurredAt)));
    return pipeline.handle(
      {
        command_id: commandId,
        device_seq: seq,
        command_version: 1,
        command_type: commandType,
        aggregate_type: 'INTERNAL_NOTE',
        aggregate_id: noteId,
        author_user_id: actor.id,
        base_version: null,
        depends_on: [],
        occurred_at: occurredAt,
        client_created_at: occurredAt,
        captured_offline: options.offline ?? false,
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
  }

  type Audience = { type: 'ALL' } | { type: 'ROLE' | 'SITE' | 'ZONE' | 'USER'; ref: string };
  const noteBody = (
    audience: Audience[],
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    title: 'Nouveau prix de l’œuf',
    body: 'À partir de demain, le plateau passe à 2 500 XAF.',
    category: 'PRIX',
    requiresAck: false,
    audience,
    ...extra,
  });

  const save = (actor: Actor, noteId: string, payload: Record<string, unknown>, o = {}) =>
    run(actor, 'communication.note.save_draft', noteId, payload, o);
  const publish = (actor: Actor, noteId: string, payload: Record<string, unknown>, o = {}) =>
    run(actor, 'communication.note.publish', noteId, payload, o);
  const archive = (actor: Actor, noteId: string, reason = 'Retirée', o = {}) =>
    run(actor, 'communication.note.archive', noteId, { reason }, o);
  const acknowledge = (actor: Actor, noteId: string, kind?: 'READ' | 'ACKNOWLEDGE', o = {}) =>
    run(actor, 'communication.note.acknowledge', noteId, kind === undefined ? {} : { kind }, o);

  const noteRow = (noteId: string) =>
    db
      .selectFrom('communication_internal_notes')
      .selectAll()
      .where('id', '=', toBin(noteId))
      .executeTakeFirst();
  const audienceRows = async (noteId: string) =>
    (
      await db
        .selectFrom('communication_note_audiences')
        .select(['audience_type', 'audience_ref'])
        .where('note_id', '=', toBin(noteId))
        .execute()
    )
      .map((row) => `${row.audience_type}:${row.audience_ref}`)
      .sort();
  const notificationsOf = (noteId: string) =>
    db
      .selectFrom('communication_notifications')
      .selectAll()
      .where('note_id', '=', toBin(noteId))
      .execute();
  const eventsOf = async (eventType: string, noteId: string) =>
    db
      .selectFrom('platform_domain_events')
      .select(['event_id', 'payload', 'occurred_at'])
      .where('event_type', '=', eventType)
      .where('aggregate_id', '=', toBin(noteId))
      .orderBy('seq')
      .execute();
  const ackRow = (noteId: string, userId: string) =>
    db
      .selectFrom('communication_note_acknowledgements')
      .selectAll()
      .where('note_id', '=', toBin(noteId))
      .where('user_id', '=', toBin(userId))
      .executeTakeFirst();
  const recipientsOf = async (noteId: string): Promise<string[]> =>
    (await notificationsOf(noteId)).map((row) => fromBin(row.user_id)).sort();

  // ---- Brouillon -------------------------------------------------------------------------------------------

  describe('communication.note.save_draft', () => {
    it('crée un brouillon et son audience : ni publication, ni notification, ni événement de publication', async () => {
      const noteId = freshUuid();
      const result = await save(
        director,
        noteId,
        noteBody([
          { type: 'SITE', ref: siteChild },
          { type: 'ROLE', ref: holderRoleCode },
        ]),
      );
      expect(result.status).toBe('APPLIED');
      expect(result.server_refs).toMatchObject({ noteId, status: 'DRAFT' });
      const note = await noteRow(noteId);
      expect(note).toMatchObject({
        status: 'DRAFT',
        title: 'Nouveau prix de l’œuf',
        category: 'PRIX',
        requires_ack: 0,
        version: 1,
      });
      expect(note!.published_at).toBeNull();
      expect(fromBin(note!.created_by)).toBe(director.id);
      expect(await audienceRows(noteId)).toEqual([`ROLE:${holderRoleCode}`, `SITE:${siteChild}`]);
      expect(await notificationsOf(noteId)).toEqual([]);
      expect(await eventsOf('InternalNotePublished', noteId)).toEqual([]);
    });

    it('l’auteur le remplace : contenu et audience, version suivante ; l’audience en double n’est écrite qu’une fois', async () => {
      const noteId = freshUuid();
      await save(director, noteId, noteBody([{ type: 'SITE', ref: siteChild }]));
      const result = await save(
        director,
        noteId,
        noteBody(
          [
            { type: 'ZONE', ref: zoneChild },
            { type: 'ZONE', ref: zoneChild.toUpperCase() },
            { type: 'USER', ref: roleHolder.id },
          ],
          { title: 'Prix corrigé', category: 'INFORMATION', requiresAck: true },
        ),
      );
      expect(result.status).toBe('APPLIED');
      const note = await noteRow(noteId);
      expect(note).toMatchObject({
        title: 'Prix corrigé',
        category: 'INFORMATION',
        requires_ack: 1,
        version: 2,
        status: 'DRAFT',
      });
      expect(await audienceRows(noteId)).toEqual([`USER:${roleHolder.id}`, `ZONE:${zoneChild}`]);
    });

    it('le brouillon d’un autre est introuvable ; une note publiée ne se modifie plus', async () => {
      const draftId = freshUuid();
      await save(director, draftId, noteBody([{ type: 'SITE', ref: siteChild }]));
      const foreign = await save(
        secondPublisher,
        draftId,
        noteBody([{ type: 'SITE', ref: siteChild }]),
      );
      expect(foreign).toMatchObject({ status: 'REJECTED', error: { code: 'NOT_FOUND' } });
      expect((await noteRow(draftId))!.version).toBe(1);

      const publishedId = freshUuid();
      await publish(director, publishedId, noteBody([{ type: 'SITE', ref: siteChild }]));
      const late = await save(director, publishedId, noteBody([{ type: 'SITE', ref: siteChild }]));
      expect(late).toMatchObject({ status: 'REJECTED', error: { code: 'NOTE_NOT_DRAFT' } });
    });

    it('en ligne seulement ; droit de publier exigé ; références d’audience connues', async () => {
      const offline = await save(
        director,
        freshUuid(),
        noteBody([{ type: 'SITE', ref: siteChild }]),
        { offline: true },
      );
      expect(offline).toMatchObject({ status: 'REJECTED', error: { code: 'ONLINE_REQUIRED' } });

      const forbidden = await save(
        siteStaff,
        freshUuid(),
        noteBody([{ type: 'SITE', ref: siteChild }]),
      );
      expect(forbidden).toMatchObject({ status: 'REJECTED', error: { code: 'FORBIDDEN' } });

      const unknown = await save(
        director,
        freshUuid(),
        noteBody([
          { type: 'SITE', ref: freshUuid() },
          { type: 'ROLE', ref: 'ROLE_QUI_N_EXISTE_PAS' },
          { type: 'ZONE', ref: zoneChild },
        ]),
      );
      expect(unknown).toMatchObject({
        status: 'REJECTED',
        error: { code: 'NOTE_AUDIENCE_UNKNOWN' },
      });
    });

    it('un rôle désactivé n’est pas une audience : référence inconnue', async () => {
      const inactiveCode = await db.transaction().execute(async (trx) => {
        const admin = await insertTestUser(trx);
        const role = await insertTestRole(trx, admin);
        await trx
          .updateTable('identity_roles')
          .set({ is_active: 0 })
          .where('id', '=', toBin(role))
          .execute();
        const row = await trx
          .selectFrom('identity_roles')
          .select('code')
          .where('id', '=', toBin(role))
          .executeTakeFirstOrThrow();
        return row.code;
      });
      const result = await save(
        director,
        freshUuid(),
        noteBody([{ type: 'ROLE', ref: inactiveCode }]),
      );
      expect(result).toMatchObject({
        status: 'REJECTED',
        error: { code: 'NOTE_AUDIENCE_UNKNOWN' },
      });
    });

    it('une note référencée doit exister ; une note ne se référence pas elle-même', async () => {
      const noteId = freshUuid();
      // Un brouillon existant ne peut pas se désigner lui-même (la note à créer n'existe pas encore : introuvable).
      await save(director, noteId, noteBody([{ type: 'SITE', ref: siteChild }]));
      const self = await save(
        director,
        noteId,
        noteBody([{ type: 'SITE', ref: siteChild }], {
          relatedEntityType: 'INTERNAL_NOTE',
          relatedEntityId: noteId,
        }),
      );
      expect(self).toMatchObject({ status: 'REJECTED', error: { code: 'NOTE_RELATED_INVALID' } });
      expect((self as { error?: { message_fr?: string } }).error?.message_fr).toContain(
        'elle-même',
      );
      const missing = await save(
        director,
        freshUuid(),
        noteBody([{ type: 'SITE', ref: siteChild }], {
          relatedEntityType: 'INTERNAL_NOTE',
          relatedEntityId: freshUuid(),
        }),
      );
      expect(missing).toMatchObject({
        status: 'REJECTED',
        error: { code: 'NOTE_RELATED_INVALID' },
      });
    });
  });

  describe('note référencée : opacité du brouillon d’un autre', () => {
    it('le brouillon d’un autre n’est pas référençable : la même réponse qu’une note inconnue ; le sien, si', async () => {
      const draftId = freshUuid();
      await save(director, draftId, noteBody([{ type: 'SITE', ref: siteChild }]));
      const related = { relatedEntityType: 'INTERNAL_NOTE', relatedEntityId: draftId };
      const audience: Audience[] = [{ type: 'SITE', ref: siteChild }];

      const unknown = await save(secondPublisher, freshUuid(), {
        ...noteBody(audience),
        relatedEntityType: 'INTERNAL_NOTE',
        relatedEntityId: freshUuid(),
      });
      for (const attempt of [
        await save(secondPublisher, freshUuid(), { ...noteBody(audience), ...related }),
        await publish(secondPublisher, freshUuid(), { ...noteBody(audience), ...related }),
      ]) {
        expect(attempt).toEqual(expect.objectContaining({ status: 'REJECTED' }));
        expect(attempt).toMatchObject({ error: { code: 'NOTE_RELATED_INVALID' } });
        expect((attempt as { error?: { message_fr?: string } }).error?.message_fr).toBe(
          (unknown as { error?: { message_fr?: string } }).error?.message_fr,
        );
      }
      // L'auteur du brouillon peut le référencer (note corrective préparée à l'avance).
      const own = await save(director, freshUuid(), { ...noteBody(audience), ...related });
      expect(own.status).toBe('APPLIED');
    });
  });

  // ---- Publication -----------------------------------------------------------------------------------------

  describe('communication.note.publish', () => {
    it('publie : note figée à l’instant du serveur, une notification par utilisateur touché hors l’auteur, un événement', async () => {
      const noteId = freshUuid();
      const result = await publish(
        director,
        noteId,
        noteBody(
          [
            { type: 'SITE', ref: siteChild },
            { type: 'ROLE', ref: holderRoleCode },
            { type: 'USER', ref: director.id },
          ],
          { requiresAck: true, expiresAt: at(48) },
        ),
      );
      expect(result.status).toBe('APPLIED');
      expect(result.server_refs).toMatchObject({
        noteId,
        status: 'PUBLISHED',
        publishedAt: NOW,
        recipients: '4',
      });
      const note = await noteRow(noteId);
      expect(note).toMatchObject({ status: 'PUBLISHED', requires_ack: 1, version: 2 });
      expect(note!.published_at!.toISOString()).toBe(NOW);
      expect(note!.expires_at!.toISOString()).toBe(at(48));

      // Site (affectation de site), sa zone et la zone mère (une zone couvre ses sites), et le rôle ciblé ;
      // ni l'auteur (désigné pourtant), ni le suspendu, ni l'affectation révoquée ou échue, ni les sites voisins.
      expect(await recipientsOf(noteId)).not.toContain(revokedStaff.id);
      expect(await recipientsOf(noteId)).not.toContain(expiredStaff.id);
      const expected = [siteStaff.id, zoneManager.id, parentZoneManager.id, roleHolder.id].sort();
      expect(await recipientsOf(noteId)).toEqual(expected);
      const notifications = await notificationsOf(noteId);
      for (const row of notifications) {
        expect(row).toMatchObject({
          channel: 'IN_APP',
          kind: 'NOTE',
          title: 'Nouveau prix de l’œuf',
          body: 'Note de la Direction · Prix · accusé de réception demandé',
          source_type: 'NOTE',
          link: null,
        });
        expect(row.delivered_at!.toISOString()).toBe(NOW);
        expect(row.read_at).toBeNull();
        expect(fromBin(row.source_id!)).toBe(noteId);
      }

      const [event, ...others] = await eventsOf('InternalNotePublished', noteId);
      expect(others).toEqual([]);
      expect(event!.payload).toMatchObject({
        note_id: noteId,
        category: 'PRIX',
        requires_ack: true,
        recipients_count: 4,
        published_by: director.id,
      });
      for (const row of notifications) {
        expect(fromBin(row.source_event_id!)).toBe(fromBin(event!.event_id));
      }
    });

    it('audience de zone : les affectations de la zone, de ses ancêtres et de ses sites ; pas les sites de la zone mère', async () => {
      const noteId = freshUuid();
      await publish(director, noteId, noteBody([{ type: 'ZONE', ref: zoneChild }]));
      expect(await recipientsOf(noteId)).toEqual(
        [siteStaff.id, zoneManager.id, parentZoneManager.id].sort(),
      );
      const parentNote = freshUuid();
      await publish(director, parentNote, noteBody([{ type: 'ZONE', ref: zoneParent }]));
      expect(await recipientsOf(parentNote)).toEqual(
        [siteStaff.id, zoneManager.id, parentZoneManager.id, siteParentStaff.id].sort(),
      );
      const siteNote = freshUuid();
      await publish(director, siteNote, noteBody([{ type: 'SITE', ref: siteParent }]));
      expect(await recipientsOf(siteNote)).toEqual(
        [parentZoneManager.id, siteParentStaff.id].sort(),
      );
    });

    it('publie un brouillon : le contenu de la commande remplace le sien, l’audience aussi', async () => {
      const noteId = freshUuid();
      await save(director, noteId, noteBody([{ type: 'SITE', ref: siteOther }]));
      const result = await publish(
        director,
        noteId,
        noteBody([{ type: 'SITE', ref: siteChild }], { title: 'Version publiée' }),
      );
      expect(result.status).toBe('APPLIED');
      expect(await noteRow(noteId)).toMatchObject({
        title: 'Version publiée',
        status: 'PUBLISHED',
      });
      expect(await audienceRows(noteId)).toEqual([`SITE:${siteChild}`]);
      expect(await recipientsOf(noteId)).not.toContain(otherSiteStaff.id);
      expect(await recipientsOf(noteId)).toContain(siteStaff.id);
    });

    it('deux publications simultanées de la même note : une seule aboutit, une seule série de notifications', async () => {
      const noteId = freshUuid();
      const payload = noteBody([{ type: 'SITE', ref: siteChild }]);
      const results = await Promise.all([
        publish(director, noteId, payload),
        publish(director, noteId, payload),
      ]);
      expect(results.filter((result) => result.status === 'APPLIED')).toHaveLength(1);
      const refused = results.find((result) => result.status === 'REJECTED');
      expect(refused).toBeDefined();
      expect(['NOTE_EXISTS', 'NOTE_ALREADY_PUBLISHED']).toContain(
        (refused as { error: { code: string } }).error.code,
      );
      expect((await noteRow(noteId))!.status).toBe('PUBLISHED');
      expect(await eventsOf('InternalNotePublished', noteId)).toHaveLength(1);
      const recipients = await recipientsOf(noteId);
      expect(new Set(recipients).size).toBe(recipients.length);
      expect(recipients.length).toBeGreaterThan(0);
    });

    it('rejeu de la même commande : une seule note, des notifications non doublées', async () => {
      const noteId = freshUuid();
      const commandId = freshUuid();
      const payload = noteBody([{ type: 'SITE', ref: siteChild }]);
      const first = await publish(director, noteId, payload, { commandId });
      const again = await publish(director, noteId, payload, { commandId });
      expect(first.status).toBe('APPLIED');
      expect(again.status).toBe('APPLIED');
      expect((await notificationsOf(noteId)).length).toBe(3);
      expect(await eventsOf('InternalNotePublished', noteId)).toHaveLength(1);
    });

    it('expiration : strictement postérieure à la publication du serveur', async () => {
      const equal = await publish(
        director,
        freshUuid(),
        noteBody([{ type: 'SITE', ref: siteChild }], { expiresAt: NOW }),
      );
      expect(equal).toMatchObject({ status: 'REJECTED', error: { code: 'NOTE_EXPIRY_INVALID' } });
      const past = await publish(
        director,
        freshUuid(),
        noteBody([{ type: 'SITE', ref: siteChild }], { expiresAt: at(-1) }),
      );
      expect(past).toMatchObject({ status: 'REJECTED', error: { code: 'NOTE_EXPIRY_INVALID' } });
      const later = new Date(new Date(NOW).getTime() + 1).toISOString();
      const ok = await publish(
        director,
        freshUuid(),
        noteBody([{ type: 'SITE', ref: siteChild }], { expiresAt: later }),
      );
      expect(ok.status).toBe('APPLIED');
    });

    it('jamais deux fois : une note publiée ou archivée ne se republie pas ; une note corrective la référence', async () => {
      const noteId = freshUuid();
      await publish(director, noteId, noteBody([{ type: 'SITE', ref: siteChild }]));
      const again = await publish(director, noteId, noteBody([{ type: 'SITE', ref: siteChild }]));
      expect(again).toMatchObject({
        status: 'REJECTED',
        error: { code: 'NOTE_ALREADY_PUBLISHED' },
      });

      const corrective = freshUuid();
      const result = await publish(
        director,
        corrective,
        noteBody([{ type: 'SITE', ref: siteChild }], {
          title: 'Correctif',
          relatedEntityType: 'INTERNAL_NOTE',
          relatedEntityId: noteId,
        }),
      );
      expect(result.status).toBe('APPLIED');
      expect(await noteRow(corrective)).toMatchObject({ related_entity_type: 'INTERNAL_NOTE' });

      await archive(director, noteId);
      const archived = await publish(
        director,
        noteId,
        noteBody([{ type: 'SITE', ref: siteChild }]),
      );
      expect(archived).toMatchObject({ status: 'REJECTED', error: { code: 'NOTE_ARCHIVED' } });
    });

    it('publier un brouillon d’un autre : introuvable ; droit de publier exigé ; en ligne seulement', async () => {
      const draftId = freshUuid();
      await save(director, draftId, noteBody([{ type: 'SITE', ref: siteChild }]));
      const foreign = await publish(
        secondPublisher,
        draftId,
        noteBody([{ type: 'SITE', ref: siteChild }]),
      );
      expect(foreign).toMatchObject({ status: 'REJECTED', error: { code: 'NOT_FOUND' } });
      expect((await noteRow(draftId))!.status).toBe('DRAFT');
      const forbidden = await publish(
        zoneManager,
        freshUuid(),
        noteBody([{ type: 'SITE', ref: siteChild }]),
      );
      expect(forbidden).toMatchObject({ status: 'REJECTED', error: { code: 'FORBIDDEN' } });
      const offline = await publish(
        director,
        freshUuid(),
        noteBody([{ type: 'SITE', ref: siteChild }]),
        {
          offline: true,
        },
      );
      expect(offline).toMatchObject({ status: 'REJECTED', error: { code: 'ONLINE_REQUIRED' } });
    });

    it('une note publiée est immuable jusque dans la base : contenu et audience', async () => {
      const noteId = freshUuid();
      await publish(director, noteId, noteBody([{ type: 'SITE', ref: siteChild }]));
      await expect(
        db
          .updateTable('communication_internal_notes')
          .set({ title: 'Falsifiée' })
          .where('id', '=', toBin(noteId))
          .execute(),
      ).rejects.toThrow(/immuable/);
      await expect(
        db
          .insertInto('communication_note_audiences')
          .values({ note_id: toBin(noteId), audience_type: 'SITE', audience_ref: freshUuid() })
          .execute(),
      ).rejects.toThrow(/figée/);
    });
  });

  // ---- Archivage -------------------------------------------------------------------------------------------

  describe('communication.note.archive', () => {
    it('retire une note publiée : archivée à l’instant du serveur, événement ; sans effet la seconde fois', async () => {
      const noteId = freshUuid();
      await publish(director, noteId, noteBody([{ type: 'SITE', ref: siteChild }]));
      const result = await archive(secondPublisher, noteId, 'Prix erroné');
      expect(result.status).toBe('APPLIED');
      expect(result.server_refs).toMatchObject({ status: 'ARCHIVED', changed: 'true' });
      const note = await noteRow(noteId);
      expect(note).toMatchObject({ status: 'ARCHIVED', archive_reason: 'Prix erroné' });
      expect(note!.archived_at!.toISOString()).toBe(NOW);
      const [event] = await eventsOf('InternalNoteArchived', noteId);
      expect(event!.payload).toMatchObject({
        previous_status: 'PUBLISHED',
        archived_by: secondPublisher.id,
      });

      const again = await archive(director, noteId, 'Encore');
      expect(again.status).toBe('APPLIED');
      expect(again.server_refs).toMatchObject({ changed: 'false' });
      expect(await eventsOf('InternalNoteArchived', noteId)).toHaveLength(1);
      expect((await noteRow(noteId))!.archive_reason).toBe('Prix erroné');
    });

    it('l’archivage n’est jamais antérieur à la publication, même si l’horloge du serveur retarde', async () => {
      const noteId = freshUuid();
      await publish(director, noteId, noteBody([{ type: 'SITE', ref: siteChild }]));
      const result = await archive(secondPublisher, noteId, 'Horloge en retard', {
        occurredAt: at(-1),
        processedAt: at(-1),
      });
      expect(result.status).toBe('APPLIED');
      expect((await noteRow(noteId))!.archived_at!.toISOString()).toBe(NOW);
      const [event] = await eventsOf('InternalNoteArchived', noteId);
      expect(event!.occurred_at.toISOString()).toBe(NOW);
    });

    it('abandonne un brouillon (le sien seulement) ; une note inconnue est introuvable ; en ligne seulement', async () => {
      const draftId = freshUuid();
      await save(director, draftId, noteBody([{ type: 'SITE', ref: siteChild }]));
      const foreign = await archive(secondPublisher, draftId);
      expect(foreign).toMatchObject({ status: 'REJECTED', error: { code: 'NOT_FOUND' } });
      const own = await archive(director, draftId, 'Abandonné');
      expect(own.status).toBe('APPLIED');
      expect((await noteRow(draftId))!.status).toBe('ARCHIVED');

      const unknown = await archive(director, freshUuid());
      expect(unknown).toMatchObject({ status: 'REJECTED', error: { code: 'NOT_FOUND' } });
      const offline = await archive(director, draftId, 'Hors ligne', { offline: true });
      expect(offline).toMatchObject({ status: 'REJECTED', error: { code: 'ONLINE_REQUIRED' } });
    });
  });

  // ---- Lecture et accusé -----------------------------------------------------------------------------------

  describe('communication.note.acknowledge', () => {
    async function publishedNote(audience: Audience[], extra: Record<string, unknown> = {}) {
      const noteId = freshUuid();
      const result = await publish(director, noteId, noteBody(audience, extra));
      expect(result.status).toBe('APPLIED');
      return noteId;
    }

    it('accuse réception à la date du fait ; la notification est marquée lue ; un événement', async () => {
      const noteId = await publishedNote([{ type: 'SITE', ref: siteChild }], { requiresAck: true });
      const result = await acknowledge(siteStaff, noteId, 'ACKNOWLEDGE', {
        occurredAt: at(2),
        offline: true,
      });
      expect(result.status).toBe('APPLIED');
      expect(result.server_refs).toMatchObject({ recorded: 'true', changed: 'true' });
      const row = await ackRow(noteId, siteStaff.id);
      expect(row!.read_at.toISOString()).toBe(at(2));
      expect(row!.acknowledged_at!.toISOString()).toBe(at(2));
      expect(fromBin(row!.command_id!)).toBeTruthy();

      const mine = (await notificationsOf(noteId)).find((n) => fromBin(n.user_id) === siteStaff.id);
      expect(mine!.read_at!.toISOString()).toBe(at(2));
      const others = (await notificationsOf(noteId)).filter(
        (n) => fromBin(n.user_id) !== siteStaff.id,
      );
      for (const other of others) expect(other.read_at).toBeNull();

      const [event, ...rest] = await eventsOf('InternalNoteAcknowledged', noteId);
      expect(rest).toEqual([]);
      expect(event!.payload).toMatchObject({
        note_id: noteId,
        user_id: siteStaff.id,
        kind: 'ACKNOWLEDGE',
        requires_ack: true,
      });
    });

    it('idempotent : un second accusé, du même utilisateur, ne change rien et ne publie rien', async () => {
      const noteId = await publishedNote([{ type: 'SITE', ref: siteChild }]);
      await acknowledge(siteStaff, noteId, 'ACKNOWLEDGE', { occurredAt: at(1) });
      const again = await acknowledge(siteStaff, noteId, 'ACKNOWLEDGE', { occurredAt: at(5) });
      expect(again.status).toBe('APPLIED');
      expect(again.server_refs).toMatchObject({ recorded: 'true', changed: 'false' });
      expect((await ackRow(noteId, siteStaff.id))!.acknowledged_at!.toISOString()).toBe(at(1));
      expect(await eventsOf('InternalNoteAcknowledged', noteId)).toHaveLength(1);
      // Le type par défaut de la commande est l'accusé.
      const byDefault = await acknowledge(zoneManager, noteId, undefined, { occurredAt: at(3) });
      expect(byDefault.status).toBe('APPLIED');
      expect((await ackRow(noteId, zoneManager.id))!.acknowledged_at!.toISOString()).toBe(at(3));
    });

    it('lire seulement crée la ligne de lecture ; l’accusé qui suit la complète sans changer la lecture', async () => {
      const noteId = await publishedNote([{ type: 'SITE', ref: siteChild }]);
      await acknowledge(siteStaff, noteId, 'READ', { occurredAt: at(1) });
      const read = await ackRow(noteId, siteStaff.id);
      expect(read!.read_at.toISOString()).toBe(at(1));
      expect(read!.acknowledged_at).toBeNull();
      const readAgain = await acknowledge(siteStaff, noteId, 'READ', { occurredAt: at(2) });
      expect(readAgain.server_refs).toMatchObject({ changed: 'false' });

      await acknowledge(siteStaff, noteId, 'ACKNOWLEDGE', { occurredAt: at(4) });
      const done = await ackRow(noteId, siteStaff.id);
      expect(done!.read_at.toISOString()).toBe(at(1));
      expect(done!.acknowledged_at!.toISOString()).toBe(at(4));
      expect(
        (await eventsOf('InternalNoteAcknowledged', noteId)).map(
          (e) => (e.payload as { kind: string }).kind,
        ),
      ).toEqual(['READ', 'ACKNOWLEDGE']);
    });

    it('un accusé antérieur à la lecture enregistrée n’est pas antérieur à elle', async () => {
      const noteId = await publishedNote([{ type: 'SITE', ref: siteChild }]);
      await acknowledge(siteStaff, noteId, 'READ', { occurredAt: at(3) });
      await acknowledge(siteStaff, noteId, 'ACKNOWLEDGE', { occurredAt: at(1) });
      const row = await ackRow(noteId, siteStaff.id);
      expect(row!.acknowledged_at!.toISOString()).toBe(at(3));
    });

    it('un fait daté d’avant la publication (horloge d’appareil en retard) est enregistré à la publication', async () => {
      const noteId = await publishedNote([{ type: 'SITE', ref: siteChild }]);
      const result = await acknowledge(siteStaff, noteId, 'ACKNOWLEDGE', {
        occurredAt: at(-5),
        offline: true,
      });
      expect(result.status).toBe('APPLIED');
      expect((await ackRow(noteId, siteStaff.id))!.read_at.toISOString()).toBe(NOW);
    });

    it('hors audience : appliqué sans effet, rien d’enregistré ; l’utilisateur suspendu est mis en conflit par le pipeline', async () => {
      const noteId = await publishedNote([{ type: 'SITE', ref: siteChild }]);
      const outside = await acknowledge(otherSiteStaff, noteId);
      expect(outside.status).toBe('APPLIED');
      expect(outside.server_refs).toMatchObject({ recorded: 'false', reason: 'NOT_IN_AUDIENCE' });
      expect(await ackRow(noteId, otherSiteStaff.id)).toBeUndefined();
      expect(await eventsOf('InternalNoteAcknowledged', noteId)).toEqual([]);

      // Affecté au site mais suspendu : le pipeline retient la commande avant le gestionnaire (conflit à
      // arbitrer, BR-SYN-007), rien n'est enregistré. La règle d'audience ne le retient pas non plus : voir les
      // destinataires de la publication et la visibilité du centre de notes (lectures).
      const suspendedAck = await acknowledge(suspended, noteId);
      expect(suspendedAck.status).toBe('CONFLICT');
      expect(await ackRow(noteId, suspended.id)).toBeUndefined();
      expect(await eventsOf('InternalNoteAcknowledged', noteId)).toEqual([]);
    });

    it('l’audience est jugée à la date du fait : une affectation postérieure ne rend pas un accusé antérieur', async () => {
      const noteId = await publishedNote([{ type: 'SITE', ref: siteChild }]);
      // Détient le droit de lire depuis toujours (rôle global) mais n'est affecté au site qu'à partir de at(4).
      const lateStaff = await db.transaction().execute(async (trx) => {
        const admin = await insertTestUser(trx);
        const actor = await newActor(trx, admin);
        const readerRole = await insertTestRole(trx, admin);
        await grantTestPermission(trx, readerRole, 'comm.note.read', admin);
        await assignTestRole(trx, actor.id, readerRole, admin);
        const siteRole = await insertTestRole(trx, admin, { allowedScopeTypes: ['SITE'] });
        await assignTestRole(trx, actor.id, siteRole, admin, {
          scopeType: 'SITE',
          scopeSiteId: siteChild,
          validFrom: new Date(at(4)),
        });
        return actor;
      });
      const before = await acknowledge(lateStaff, noteId, 'ACKNOWLEDGE', { occurredAt: at(2) });
      expect(before.server_refs).toMatchObject({ recorded: 'false' });
      expect(await ackRow(noteId, lateStaff.id)).toBeUndefined();
      const after = await acknowledge(lateStaff, noteId, 'ACKNOWLEDGE', { occurredAt: at(5) });
      expect(after.server_refs).toMatchObject({ recorded: 'true', changed: 'true' });
      // Visible en ligne, jamais reçue par la publication (limite assumée, AV-419).
      expect(await recipientsOf(noteId)).not.toContain(lateStaff.id);
    });

    it('une note archivée depuis la lecture hors ligne est tout de même accusée à sa date, sans rejet', async () => {
      const noteId = await publishedNote([{ type: 'SITE', ref: siteChild }], { requiresAck: true });
      await archive(director, noteId, 'Retirée');
      const result = await acknowledge(siteStaff, noteId, 'ACKNOWLEDGE', {
        occurredAt: at(1),
        offline: true,
      });
      expect(result.status).toBe('APPLIED');
      expect(result.server_refs).toMatchObject({ recorded: 'true' });
      expect((await ackRow(noteId, siteStaff.id))!.acknowledged_at!.toISOString()).toBe(at(1));
    });

    it('une note expirée depuis est accusée de même', async () => {
      const noteId = await publishedNote([{ type: 'SITE', ref: siteChild }], { expiresAt: at(2) });
      const result = await acknowledge(siteStaff, noteId, 'ACKNOWLEDGE', { occurredAt: at(3) });
      expect(result.server_refs).toMatchObject({ recorded: 'true' });
    });

    it('un brouillon, une note inconnue : introuvables ; le droit de lire est exigé', async () => {
      const draftId = freshUuid();
      await save(director, draftId, noteBody([{ type: 'SITE', ref: siteChild }]));
      const draft = await acknowledge(siteStaff, draftId);
      expect(draft).toMatchObject({ status: 'REJECTED', error: { code: 'NOT_FOUND' } });
      const unknown = await acknowledge(siteStaff, freshUuid());
      expect(unknown).toMatchObject({ status: 'REJECTED', error: { code: 'NOT_FOUND' } });

      const stranger = await db.transaction().execute(async (trx) => {
        const admin = await insertTestUser(trx);
        return newActor(trx, admin);
      });
      const noteId = await publishedNote([{ type: 'SITE', ref: siteChild }]);
      const forbidden = await acknowledge(stranger, noteId);
      expect(forbidden).toMatchObject({ status: 'REJECTED', error: { code: 'FORBIDDEN' } });
    });
  });
});
