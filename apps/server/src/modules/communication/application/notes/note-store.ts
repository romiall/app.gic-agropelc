/**
 * Écriture des notes de direction (P9-11 ; ADR-073 ; BR-NOT-006) : verrou de la ligne, brouillon, audience,
 * publication et archivage. Les règles d'immuabilité sont aussi dans la base (déclencheurs de
 * `20261201090100_create_communication.sql`) : ces fonctions ne font que les respecter, dans l'ordre qu'elles
 * imposent (l'audience ne s'écrit que sous un brouillon, la publication est le dernier acte).
 */
import { sql, type Kysely } from 'kysely';
import { noteAudienceEntryOfRow, noteAudienceRow, type NoteAudienceEntry } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import {
  fromBin,
  fromBinOrNull,
  toBin,
  toBinOrNull,
} from '../../../../platform/kysely/uuid-columns.js';

export type NoteStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

export interface NoteContent {
  readonly title: string;
  readonly body: string;
  readonly category: string;
  readonly relatedEntityType: string | null;
  readonly relatedEntityId: string | null;
  readonly requiresAck: boolean;
  readonly expiresAt: Date | null;
}

export interface LockedNote extends NoteContent {
  readonly id: string;
  readonly status: NoteStatus;
  readonly publishedAt: Date | null;
  readonly archivedAt: Date | null;
  readonly createdBy: string;
  readonly version: number;
}

function toLockedNote(row: {
  readonly id: Buffer;
  readonly title: string;
  readonly body: string;
  readonly category: string;
  readonly related_entity_type: string | null;
  readonly related_entity_id: Buffer | null;
  readonly requires_ack: number;
  readonly status: string;
  readonly published_at: Date | null;
  readonly expires_at: Date | null;
  readonly archived_at: Date | null;
  readonly created_by: Buffer;
  readonly version: number;
}): LockedNote {
  return {
    id: fromBin(row.id),
    title: row.title,
    body: row.body,
    category: row.category,
    relatedEntityType: row.related_entity_type,
    relatedEntityId: fromBinOrNull(row.related_entity_id),
    requiresAck: Boolean(row.requires_ack),
    status: row.status as NoteStatus,
    publishedAt: row.published_at,
    expiresAt: row.expires_at,
    archivedAt: row.archived_at,
    createdBy: fromBin(row.created_by),
    version: row.version,
  };
}

const NOTE_COLUMNS = [
  'id',
  'title',
  'body',
  'category',
  'related_entity_type',
  'related_entity_id',
  'requires_ack',
  'status',
  'published_at',
  'expires_at',
  'archived_at',
  'created_by',
  'version',
] as const;

/** La note, verrouillée pour la durée de la transaction (rang N10b, ADR-038 : avant toute ligne qui en dépend). */
export async function lockNote(uow: UnitOfWork, noteId: string): Promise<LockedNote | undefined> {
  const row = await uow
    .selectFrom('communication_internal_notes')
    .select(NOTE_COLUMNS)
    .where('id', '=', toBin(noteId))
    .forUpdate()
    .executeTakeFirst();
  return row === undefined ? undefined : toLockedNote(row);
}

/** La note sans verrou (lecture seule : une note publiée ne change plus que de statut). */
export async function readNote(uow: Kysely<DB>, noteId: string): Promise<LockedNote | undefined> {
  const row = await uow
    .selectFrom('communication_internal_notes')
    .select(NOTE_COLUMNS)
    .where('id', '=', toBin(noteId))
    .executeTakeFirst();
  return row === undefined ? undefined : toLockedNote(row);
}

/** Lignes d'audience d'une note, dans l'ordre stable des lignes normalisées. */
export async function noteAudienceOf(
  uow: Kysely<DB>,
  noteId: string,
): Promise<readonly NoteAudienceEntry[]> {
  const rows = await uow
    .selectFrom('communication_note_audiences')
    .select(['audience_type', 'audience_ref'])
    .where('note_id', '=', toBin(noteId))
    .execute();
  return rows.map((row) => noteAudienceEntryOfRow(row.audience_type, row.audience_ref));
}

/** Remplace l'audience d'un brouillon (la base refuse toute écriture dès la publication). */
export async function replaceDraftAudience(
  uow: UnitOfWork,
  noteId: string,
  entries: readonly NoteAudienceEntry[],
): Promise<void> {
  await uow
    .deleteFrom('communication_note_audiences')
    .where('note_id', '=', toBin(noteId))
    .execute();
  const rows = entries.map(noteAudienceRow);
  if (rows.length === 0) return;
  await uow
    .insertInto('communication_note_audiences')
    .values(
      rows.map((row) => ({
        note_id: toBin(noteId),
        audience_type: row.audienceType,
        audience_ref: row.audienceRef,
      })),
    )
    .execute();
}

function contentColumns(content: NoteContent) {
  return {
    title: content.title,
    body: content.body,
    category: content.category,
    related_entity_type: content.relatedEntityType,
    related_entity_id: toBinOrNull(content.relatedEntityId),
    requires_ack: content.requiresAck ? 1 : 0,
    expires_at: content.expiresAt,
  };
}

/** Crée le brouillon (toujours `DRAFT` : l'audience ne s'écrit que sous un brouillon). */
export async function insertDraft(
  uow: UnitOfWork,
  input: {
    readonly id: string;
    readonly authorId: string;
    readonly commandId: string;
    readonly content: NoteContent;
  },
): Promise<void> {
  await uow
    .insertInto('communication_internal_notes')
    .values({
      id: toBin(input.id),
      ...contentColumns(input.content),
      status: 'DRAFT',
      command_id: toBin(input.commandId),
      created_by: toBin(input.authorId),
      updated_by: toBin(input.authorId),
    })
    .execute();
}

/** Remplace le contenu d'un brouillon. */
export async function updateDraft(
  uow: UnitOfWork,
  input: { readonly id: string; readonly authorId: string; readonly content: NoteContent },
): Promise<void> {
  await uow
    .updateTable('communication_internal_notes')
    .set({
      ...contentColumns(input.content),
      updated_by: toBin(input.authorId),
      version: sql`version + 1`,
    })
    .where('id', '=', toBin(input.id))
    .where('status', '=', 'DRAFT')
    .execute();
}

/** Publie le brouillon : le dernier acte, après le contenu et l'audience. */
export async function markPublished(
  uow: UnitOfWork,
  input: { readonly id: string; readonly authorId: string; readonly publishedAt: Date },
): Promise<void> {
  await uow
    .updateTable('communication_internal_notes')
    .set({
      status: 'PUBLISHED',
      published_at: input.publishedAt,
      updated_by: toBin(input.authorId),
      version: sql`version + 1`,
    })
    .where('id', '=', toBin(input.id))
    .where('status', '=', 'DRAFT')
    .execute();
}

/** Archive un brouillon abandonné ou retire une note publiée (aucune suppression physique). */
export async function markArchived(
  uow: UnitOfWork,
  input: {
    readonly id: string;
    readonly authorId: string;
    readonly archivedAt: Date;
    readonly reason: string;
  },
): Promise<void> {
  await uow
    .updateTable('communication_internal_notes')
    .set({
      status: 'ARCHIVED',
      archived_at: input.archivedAt,
      archive_reason: input.reason,
      updated_by: toBin(input.authorId),
      version: sql`version + 1`,
    })
    .where('id', '=', toBin(input.id))
    .where('status', 'in', ['DRAFT', 'PUBLISHED'])
    .execute();
}
