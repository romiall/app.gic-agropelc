/**
 * Commandes des notes de direction (P9-11 ; ADR-063 ; D13 UC-NOT-05 et 06, BR-NOT-006, BR-NOT-007 ; AV-369,
 * AV-426 à AV-428) : `communication.note.save_draft`, `.publish` et `.archive` (Direction, `comm.note.publish`,
 * **en ligne**) et `communication.note.acknowledge` (tout titulaire de `comm.note.read`, hors ligne possible,
 * AT-048).
 *
 * - **Brouillon** : visible de son seul auteur, modifiable tant qu'il n'est pas publié ; un autre utilisateur
 *   obtient `NOT_FOUND` (existence opaque, RC-07). Un brouillon abandonné s'archive (aucune suppression
 *   physique, INV-GLO-03).
 * - **Publication** : crée la note et la publie, ou publie le brouillon désigné par l'`aggregate_id` avec le
 *   contenu de la commande. Titre et corps non vides et audience non vide (schéma), expiration postérieure à
 *   l'instant de publication **du serveur**, références d'audience connues ; puis la note est figée (les
 *   déclencheurs de la base l'imposent aussi). L'audience est **résolue à la publication** : une notification
 *   `IN_APP` par utilisateur touché (l'auteur excepté), idempotente par l'événement `InternalNotePublished` ;
 *   les affectations postérieures voient la note en ligne sans la recevoir (limite assumée, AV-369).
 * - **Accusé** : idempotent par (note, utilisateur) ; `READ` crée la ligne de lecture, `ACKNOWLEDGE` la complète
 *   une fois. Jugé à la date du **fait** (jamais avant la publication) : une note archivée ou expirée depuis la
 *   lecture hors ligne est accusée à sa date, sans rejet (BR-SYN-007). Un utilisateur que l'audience ne touchait
 *   pas à cette date n'est pas enregistré : la commande est appliquée sans effet. Lire ou accuser une note
 *   marque lues ses notifications.
 * - **Aucun effet métier** (BR-NOT-007) : seules les tables `communication_*` et les événements de la note sont
 *   écrits.
 * - La ligne de la note est verrouillée en premier (rang N10b, ADR-038) ; ces commandes s'exécutent en lecture
 *   validée : aucune clé absente n'est verrouillée par intervalle, la clé primaire arbitre deux créations.
 */
import {
  normalizeNoteAudience,
  type Clock,
  type IdGenerator,
  type NoteAudienceEntry,
} from '@gic/domain';
import {
  noteAcknowledgePayloadSchema,
  noteArchivePayloadSchema,
  noteDraftSavePayloadSchema,
  notePublishPayloadSchema,
  type NoteAcknowledgePayload,
  type NoteArchivePayload,
  type NoteDraftSavePayload,
  type NotePublishPayload,
} from '@gic/contracts';
import type { z } from 'zod';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';
import {
  insertNotifications,
  markNoteNotificationsRead,
} from '../notifications/notification-store.js';
import { noteHolderIds, recordNoteChanges } from '../sync-changes.js';
import type { NoteAudienceResolver } from '../notes/note-audience-resolver.js';
import { publishNoteEvent } from '../notes/note-events.js';
import {
  insertDraft,
  lockNote,
  markArchived,
  markPublished,
  noteAudienceOf,
  readNote,
  replaceDraftAudience,
  updateDraft,
  type LockedNote,
  type NoteContent,
} from '../notes/note-store.js';

const PUBLISH_PERMISSION = 'comm.note.publish';
const READ_PERMISSION = 'comm.note.read';

export interface NoteCommandDeps {
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly audience: NoteAudienceResolver;
}

const rejected = (errorCode: string, messageFr: string): CommandHandlerOutcome => ({
  status: 'REJECTED',
  errorCode,
  messageFr,
});

const NOT_FOUND = rejected('NOT_FOUND', 'Note introuvable.');
const ONLINE_REQUIRED = rejected(
  'ONLINE_REQUIRED',
  'Les notes de direction se rédigent, se publient et se retirent en ligne.',
);

/** Libellés français des catégories, pour le corps des notifications. */
export const NOTE_CATEGORY_LABELS: Readonly<Record<string, string>> = {
  PRIX: 'Prix',
  INSTRUCTION: 'Instruction',
  PROCEDURE: 'Procédure',
  INFORMATION: 'Information',
};

type NoteFields = NoteDraftSavePayload | NotePublishPayload;

function contentOf(payload: NoteFields): NoteContent {
  return {
    title: payload.title,
    body: payload.body,
    category: payload.category,
    relatedEntityType: payload.relatedEntityType ?? null,
    relatedEntityId: payload.relatedEntityId ?? null,
    requiresAck: payload.requiresAck,
    expiresAt: payload.expiresAt === undefined ? null : new Date(payload.expiresAt),
  };
}

const describeEntries = (entries: readonly NoteAudienceEntry[]): string =>
  entries
    .slice(0, 5)
    .map((entry) => (entry.type === 'ALL' ? 'tous' : `${entry.type} ${entry.ref}`))
    .join(', ') + (entries.length > 5 ? `, … (${entries.length})` : '');

/**
 * Contrôles communs au brouillon et à la publication : références d'audience connues, note référencée
 * existante (une note corrective désigne l'ancienne, `related_entity_type = 'INTERNAL_NOTE'`).
 */
async function checkContent(
  uow: UnitOfWork,
  deps: NoteCommandDeps,
  noteId: string,
  authorId: string,
  content: NoteContent,
  entries: readonly NoteAudienceEntry[],
): Promise<CommandHandlerOutcome | null> {
  const unknown = await deps.audience.unknownReferences(uow, entries);
  if (unknown.length > 0) {
    return rejected('NOTE_AUDIENCE_UNKNOWN', `Audience inconnue : ${describeEntries(unknown)}.`);
  }
  if (content.relatedEntityType === 'INTERNAL_NOTE' && content.relatedEntityId !== null) {
    if (content.relatedEntityId === noteId) {
      return rejected('NOTE_RELATED_INVALID', 'Une note ne peut pas se référencer elle-même.');
    }
    // Le brouillon d'un autre est introuvable (revue de P9-11) : sa référence ne révèle pas son existence.
    const related = await readNote(uow, content.relatedEntityId);
    if (related === undefined || (related.status === 'DRAFT' && related.createdBy !== authorId)) {
      return rejected('NOTE_RELATED_INVALID', 'La note référencée est introuvable.');
    }
  }
  return null;
}

/** Brouillon d'un autre : introuvable ; note déjà publiée ou archivée : refus explicite. */
function refuseNonDraft(
  note: LockedNote,
  authorId: string,
  forPublication: boolean,
): CommandHandlerOutcome | null {
  if (note.status === 'DRAFT') {
    return note.createdBy === authorId ? null : NOT_FOUND;
  }
  if (note.status === 'ARCHIVED') {
    return rejected('NOTE_ARCHIVED', 'Cette note est archivée : publier une note corrective.');
  }
  return forPublication
    ? rejected(
        'NOTE_ALREADY_PUBLISHED',
        'Cette note est déjà publiée : publier une note corrective.',
      )
    : rejected(
        'NOTE_NOT_DRAFT',
        'Cette note est publiée : elle ne se modifie plus (note corrective).',
      );
}

function isDuplicateKey(error: unknown): boolean {
  const { code, errno } = (error ?? {}) as { code?: string; errno?: number };
  return code === 'ER_DUP_ENTRY' || errno === 1062;
}

/** Écrit le brouillon (création ou remplacement) et son audience ; refus éventuel de l'état de la note. */
async function writeDraft(
  uow: UnitOfWork,
  input: {
    readonly noteId: string;
    readonly authorId: string;
    readonly commandId: string;
    readonly content: NoteContent;
    readonly entries: readonly NoteAudienceEntry[];
    readonly forPublication: boolean;
  },
): Promise<{ readonly refused: CommandHandlerOutcome } | { readonly before: LockedNote | null }> {
  const existing = await lockNote(uow, input.noteId);
  if (existing === undefined) {
    try {
      await insertDraft(uow, {
        id: input.noteId,
        authorId: input.authorId,
        commandId: input.commandId,
        content: input.content,
      });
    } catch (error) {
      // Deux créations simultanées de la même note : la clé primaire en a laissé passer une seule.
      if (!isDuplicateKey(error)) throw error;
      return {
        refused: rejected('NOTE_EXISTS', 'Cette note vient d’être créée par une autre commande.'),
      };
    }
  } else {
    const refused = refuseNonDraft(existing, input.authorId, input.forPublication);
    if (refused !== null) return { refused };
    await updateDraft(uow, {
      id: input.noteId,
      authorId: input.authorId,
      content: input.content,
    });
  }
  await replaceDraftAudience(uow, input.noteId, input.entries);
  return { before: existing ?? null };
}

const snapshot = (note: LockedNote | null) =>
  note === null ? null : { status: note.status, version: note.version, title: note.title };

// --- Brouillon ---------------------------------------------------------------------------------------------

function saveDraft(deps: NoteCommandDeps): CommandHandler<NoteDraftSavePayload> {
  return async (uow, envelope) => {
    if (envelope.captured_offline) return ONLINE_REQUIRED;
    const noteId = envelope.aggregate_id;
    const content = contentOf(envelope.payload);
    const entries = normalizeNoteAudience(envelope.payload.audience);
    const invalid = await checkContent(
      uow,
      deps,
      noteId,
      envelope.author_user_id,
      content,
      entries,
    );
    if (invalid !== null) return invalid;

    const written = await writeDraft(uow, {
      noteId,
      authorId: envelope.author_user_id,
      commandId: envelope.command_id,
      content,
      entries,
      forPublication: false,
    });
    if ('refused' in written) return written.refused;
    return {
      status: 'APPLIED',
      serverRefs: { noteId, status: 'DRAFT' },
      audit: {
        before: snapshot(written.before),
        after: {
          status: 'DRAFT',
          title: content.title,
          category: content.category,
          audience: entries,
        },
      },
    };
  };
}

// --- Publication -------------------------------------------------------------------------------------------

function noteNotificationBody(content: NoteContent): string {
  const label = NOTE_CATEGORY_LABELS[content.category] ?? content.category;
  return `Note de la Direction · ${label}${content.requiresAck ? ' · accusé de réception demandé' : ''}`;
}

function publish(deps: NoteCommandDeps): CommandHandler<NotePublishPayload> {
  return async (uow, envelope) => {
    if (envelope.captured_offline) return ONLINE_REQUIRED;
    const noteId = envelope.aggregate_id;
    const author = envelope.author_user_id;
    // L'instant de publication est celui du serveur : l'expiration se juge par rapport à lui.
    const publishedAt = deps.clock.now();
    const content = contentOf(envelope.payload);
    if (content.expiresAt !== null && content.expiresAt.getTime() <= publishedAt.getTime()) {
      return rejected(
        'NOTE_EXPIRY_INVALID',
        "L'expiration doit être postérieure à la publication.",
      );
    }
    const entries = normalizeNoteAudience(envelope.payload.audience);
    const invalid = await checkContent(uow, deps, noteId, author, content, entries);
    if (invalid !== null) return invalid;

    const written = await writeDraft(uow, {
      noteId,
      authorId: author,
      commandId: envelope.command_id,
      content,
      entries,
      forPublication: true,
    });
    if ('refused' in written) return written.refused;
    await markPublished(uow, { id: noteId, authorId: author, publishedAt });

    // Audience résolue à la publication : une notification par utilisateur touché, hors l'auteur.
    const recipients = (await deps.audience.usersInAudienceAt(uow, entries, publishedAt)).filter(
      (userId) => userId !== author,
    );
    const eventId = await publishNoteEvent(uow, deps, {
      eventType: 'InternalNotePublished',
      noteId,
      occurredAt: publishedAt,
      commandId: envelope.command_id,
      payload: {
        note_id: noteId,
        title: content.title,
        category: content.category,
        requires_ack: content.requiresAck,
        published_at: publishedAt.toISOString(),
        expires_at: content.expiresAt === null ? null : content.expiresAt.toISOString(),
        audience: entries,
        recipients_count: recipients.length,
        published_by: author,
      },
    });
    const body = noteNotificationBody(content);
    // Par lots : une audience large (tout le personnel) ne se traduit pas en autant d'écritures séparées dans la
    // transaction qui tient le verrou de la note (revue de P9-11).
    await insertNotifications(
      uow,
      deps.idGenerator,
      recipients.map((userId) => ({
        userId,
        channel: 'IN_APP' as const,
        kind: 'NOTE' as const,
        noteId,
        sourceType: 'NOTE',
        sourceId: noteId,
        sourceEventId: eventId,
        title: content.title,
        body,
        link: null,
        createdAt: publishedAt,
        deliveredAt: publishedAt,
      })),
    );
    // Jeu hors ligne `comms` : la note rejoint l'appareil de chaque destinataire (ADR-063 §4).
    await recordNoteChanges(uow, noteId, recipients, 'UPSERT');
    return {
      status: 'APPLIED',
      serverRefs: {
        noteId,
        status: 'PUBLISHED',
        publishedAt: publishedAt.toISOString(),
        recipients: String(recipients.length),
      },
      audit: {
        before: snapshot(written.before),
        after: {
          status: 'PUBLISHED',
          title: content.title,
          category: content.category,
          requiresAck: content.requiresAck,
          expiresAt: content.expiresAt?.toISOString() ?? null,
          audience: entries,
          recipients: recipients.length,
        },
      },
    };
  };
}

// --- Archivage ---------------------------------------------------------------------------------------------

function archive(deps: NoteCommandDeps): CommandHandler<NoteArchivePayload> {
  return async (uow, envelope) => {
    if (envelope.captured_offline) return ONLINE_REQUIRED;
    const noteId = envelope.aggregate_id;
    const author = envelope.author_user_id;
    const note = await lockNote(uow, noteId);
    if (note === undefined) return NOT_FOUND;
    if (note.status === 'DRAFT' && note.createdBy !== author) return NOT_FOUND;
    if (note.status === 'ARCHIVED') {
      // Fait accompli : une note déjà retirée l'est (BR-SYN-007), sans effet.
      return { status: 'APPLIED', serverRefs: { noteId, status: 'ARCHIVED', changed: 'false' } };
    }
    const now = deps.clock.now();
    const archivedAt =
      note.publishedAt !== null && now.getTime() < note.publishedAt.getTime()
        ? note.publishedAt
        : now;
    await markArchived(uow, {
      id: noteId,
      authorId: author,
      archivedAt,
      reason: envelope.payload.reason,
    });
    // Jeu hors ligne `comms` : la note sort de l'appareil de ceux qui la détiennent.
    await recordNoteChanges(uow, noteId, await noteHolderIds(uow, noteId), 'SCOPE_EXIT');
    // NT-6 : une note retirée n'attend plus personne ; ses notifications non lues sont marquées lues (même
    // sens que pour l'accusé : « n'attend plus l'utilisateur ») et sortent de l'appareil. Un brouillon
    // abandonné n'a jamais été notifié.
    const notificationsClosed =
      note.status === 'PUBLISHED'
        ? await markNoteNotificationsRead(uow, { noteId, at: archivedAt })
        : 0;
    await publishNoteEvent(uow, deps, {
      eventType: 'InternalNoteArchived',
      noteId,
      occurredAt: archivedAt,
      commandId: envelope.command_id,
      payload: {
        note_id: noteId,
        previous_status: note.status,
        archived_at: archivedAt.toISOString(),
        archived_by: author,
      },
    });
    return {
      status: 'APPLIED',
      serverRefs: {
        noteId,
        status: 'ARCHIVED',
        changed: 'true',
        notificationsClosed: String(notificationsClosed),
      },
      audit: {
        before: { status: note.status, version: note.version },
        after: { status: 'ARCHIVED', reason: envelope.payload.reason },
      },
    };
  };
}

// --- Lecture et accusé -------------------------------------------------------------------------------------

function acknowledge(deps: NoteCommandDeps): CommandHandler<NoteAcknowledgePayload> {
  const selectAck = (uow: UnitOfWork, noteId: string, userId: string) =>
    uow
      .selectFrom('communication_note_acknowledgements')
      .select(['read_at', 'acknowledged_at'])
      .where('note_id', '=', toBin(noteId))
      .where('user_id', '=', toBin(userId))
      .forUpdate()
      .executeTakeFirst();

  return async (uow, envelope) => {
    const noteId = envelope.aggregate_id;
    const author = envelope.author_user_id;
    const note = await readNote(uow, noteId);
    // Un brouillon n'a pas de date de publication : il reste introuvable pour tout lecteur.
    if (note === undefined || note.publishedAt === null) return NOT_FOUND;
    // Jugé à la date du fait, jamais avant la publication (horloge d'appareil en retard).
    const occurredAt = new Date(envelope.occurred_at);
    const factAt =
      occurredAt.getTime() < note.publishedAt.getTime() ? note.publishedAt : occurredAt;
    const entries = await noteAudienceOf(uow, noteId);
    if (!(await deps.audience.includesUserAt(uow, author, entries, factAt))) {
      // L'audience ne touchait pas cet utilisateur à cette date : rien n'est enregistré, rien n'est rejeté.
      return {
        status: 'APPLIED',
        serverRefs: { noteId, recorded: 'false', reason: 'NOT_IN_AUDIENCE' },
      };
    }

    const kind = envelope.payload.kind;
    let readAt: Date = factAt;
    let acknowledgedAt: Date | null = null;
    let changed = false;
    let row = await selectAck(uow, noteId, author);
    if (row === undefined) {
      try {
        await uow
          .insertInto('communication_note_acknowledgements')
          .values({
            note_id: toBin(noteId),
            user_id: toBin(author),
            read_at: factAt,
            acknowledged_at: kind === 'ACKNOWLEDGE' ? factAt : null,
            command_id: toBin(envelope.command_id),
          })
          .execute();
        changed = true;
        acknowledgedAt = kind === 'ACKNOWLEDGE' ? factAt : null;
      } catch (error) {
        // Une autre commande du même utilisateur vient d'écrire la ligne : on la reprend.
        if (!isDuplicateKey(error)) throw error;
        row = await selectAck(uow, noteId, author);
      }
    }
    if (row !== undefined) {
      readAt = row.read_at;
      acknowledgedAt = row.acknowledged_at;
      if (kind === 'ACKNOWLEDGE' && row.acknowledged_at === null) {
        // Un accusé jamais antérieur à la lecture déjà enregistrée.
        const at = factAt.getTime() < row.read_at.getTime() ? row.read_at : factAt;
        await uow
          .updateTable('communication_note_acknowledgements')
          .set({ acknowledged_at: at, command_id: toBin(envelope.command_id) })
          .where('note_id', '=', toBin(noteId))
          .where('user_id', '=', toBin(author))
          .where('acknowledged_at', 'is', null)
          .execute();
        acknowledgedAt = at;
        changed = true;
      }
    }

    if (changed) {
      // La note lue (ou accusée) n'attend plus l'utilisateur dans son centre de notifications.
      // Jeu hors ligne `comms` : ses notifications de la note sortent des non lues (SCOPE_EXIT, publié par le
      // geste partagé avec le retrait, NT-6), et la note revient avec l'état de lecture que le serveur vient
      // d'enregistrer.
      await markNoteNotificationsRead(uow, { noteId, userId: author, at: factAt });
      await recordNoteChanges(uow, noteId, [author], 'UPSERT');
      await publishNoteEvent(uow, deps, {
        eventType: 'InternalNoteAcknowledged',
        noteId,
        occurredAt: factAt,
        commandId: envelope.command_id,
        payload: {
          note_id: noteId,
          user_id: author,
          kind,
          read_at: readAt.toISOString(),
          acknowledged_at: acknowledgedAt === null ? null : acknowledgedAt.toISOString(),
          requires_ack: note.requiresAck,
        },
      });
    }
    return {
      status: 'APPLIED',
      serverRefs: { noteId, recorded: 'true', changed: String(changed) },
      audit: {
        after: {
          kind,
          readAt: readAt.toISOString(),
          acknowledgedAt: acknowledgedAt === null ? null : acknowledgedAt.toISOString(),
        },
      },
    };
  };
}

export function registerNoteCommands(
  registry: CommandHandlerRegistry,
  deps: NoteCommandDeps,
): void {
  registry.register<NoteDraftSavePayload>({
    commandType: 'communication.note.save_draft',
    version: 1,
    payloadSchema: noteDraftSavePayloadSchema,
    permissionCode: PUBLISH_PERMISSION,
    handler: saveDraft(deps),
    isolationLevel: 'read committed',
  });
  registry.register<NotePublishPayload>({
    commandType: 'communication.note.publish',
    version: 1,
    payloadSchema: notePublishPayloadSchema,
    permissionCode: PUBLISH_PERMISSION,
    handler: publish(deps),
    isolationLevel: 'read committed',
  });
  registry.register<NoteArchivePayload>({
    commandType: 'communication.note.archive',
    version: 1,
    payloadSchema: noteArchivePayloadSchema,
    permissionCode: PUBLISH_PERMISSION,
    handler: archive(deps),
    isolationLevel: 'read committed',
  });
  registry.register<NoteAcknowledgePayload>({
    commandType: 'communication.note.acknowledge',
    version: 1,
    // `kind` a une valeur par défaut : le type en sortie du schéma est celui que reçoit le gestionnaire.
    payloadSchema: noteAcknowledgePayloadSchema as unknown as z.ZodType<NoteAcknowledgePayload>,
    permissionCode: READ_PERMISSION,
    handler: acknowledge(deps),
    isolationLevel: 'read committed',
  });
}
