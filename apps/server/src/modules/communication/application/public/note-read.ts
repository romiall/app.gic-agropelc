/**
 * Lecture des notes de direction (P9-11 (2/3) ; ADR-063 §3, §5, §6 ; D13 UC-NOT-05 et 06 ; AV-429) :
 * le centre de notes d'un lecteur, la fiche d'une note, le suivi des accusés pour la Direction.
 *
 * - **Centre de notes (`INBOX`)** : les notes **publiées et non expirées** dont l'audience touche le lecteur à
 *   l'instant de la lecture (la règle du domaine, évaluée à la lecture : une affectation postérieure à la
 *   publication voit la note, ADR-063 §3), plus récentes d'abord. Chaque note porte l'état du lecteur (lue,
 *   accusée) ; une note archivée ou expirée n'y figure plus. Sont examinées par lecture : les
 *   {@link NOTE_INBOX_SCAN_MAX} notes publiées les plus récentes **et** les {@link NOTE_INBOX_SCAN_MAX} plus
 *   récentes des notes à accusé requis que le lecteur n'a pas accusées, **toutes audiences confondues** (le
 *   filtre d'audience vient après) : une note à accuser ne disparaît pas parce que d'autres notes l'ont
 *   dépassée (ADR-063 §5). Le compteur des accusés attendus et la liste sont exacts sur ce qui est examiné ;
 *   `truncated` dit qu'un des deux ensembles a dépassé son plafond (AV-429).
 * - **Gestion (`MANAGE`, `comm.note.publish`)** : toutes les notes — brouillons **du lecteur seulement**, notes
 *   publiées et archivées, quelle que soit leur audience — avec leur audience.
 * - **Fiche** : un lecteur voit une note publiée (même expirée) qui le touche ; jamais un brouillon ni une note
 *   archivée. La gestion voit tout, sauf le brouillon d'un autre. Hors de ces cas : `null` (404 opaque).
 * - **Suivi des accusés** : l'audience résolue **maintenant** (l'auteur excepté) réunie aux utilisateurs qui ont
 *   une ligne de lecture ; « manquants » = les utilisateurs de l'audience sans accusé (note à accusé requis) ou
 *   sans lecture (note simple). Les noms sont ajoutés par la couche de transport (`identity`).
 */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { noteAudienceEntryOfRow, type NoteAudienceEntry } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import type { NoteAudienceResolver } from '../notes/note-audience-resolver.js';

type Executor = Kysely<DB>;

export const NOTE_READ_PERMISSION = 'comm.note.read';
export const NOTE_PUBLISH_PERMISSION = 'comm.note.publish';

/** Notes publiées examinées au plus par une lecture du centre de notes. */
export const NOTE_INBOX_SCAN_MAX = 500;

export type NoteViewScope = 'INBOX' | 'MANAGE';
export type NoteReadStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

export interface NoteReadItem {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly category: string;
  readonly relatedEntityType: string | null;
  readonly relatedEntityId: string | null;
  readonly requiresAck: boolean;
  readonly status: NoteReadStatus;
  readonly publishedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly authorUserId: string;
  /** Audience : lisible de la gestion seulement (`null` pour un lecteur). */
  readonly audience: readonly NoteAudienceEntry[] | null;
  readonly readAt: Date | null;
  readonly acknowledgedAt: Date | null;
}

export interface NoteCursor {
  readonly at: Date;
  readonly id: string;
}

export function encodeNoteCursor(cursor: NoteCursor): string {
  return Buffer.from(
    JSON.stringify({ t: cursor.at.toISOString(), id: cursor.id }),
    'utf-8',
  ).toString('base64url');
}

export function decodeNoteCursor(raw: string): NoteCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8')) as {
      t?: unknown;
      id?: unknown;
    };
    if (typeof parsed.t !== 'string' || typeof parsed.id !== 'string') return null;
    const at = new Date(parsed.t);
    if (Number.isNaN(at.getTime())) return null;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(parsed.id)) {
      return null;
    }
    return { at, id: parsed.id };
  } catch {
    return null;
  }
}

export interface NotePage {
  readonly items: readonly NoteReadItem[];
  /** Notes à accusé requis que le lecteur n'a pas encore accusées (centre de notes, quel que soit le filtre). */
  readonly pendingAcknowledgements: number;
  /** Le balayage du centre de notes a atteint son plafond : des notes plus anciennes n'ont pas été examinées. */
  readonly truncated: boolean;
  readonly nextCursor: string | null;
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
  'created_at',
  'created_by',
] as const;

interface NoteRow {
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
  readonly created_at: Date;
  readonly created_by: Buffer;
}

/**
 * Instant de tri de la gestion : la publication, à défaut la création (brouillon), **tronqué à la
 * milliseconde** comme le curseur (une `Date` JavaScript) : la création d'un brouillon est écrite à la
 * microseconde par la base, et un curseur plus grossier que le tri sauterait des lignes (revue de P9-11).
 */
const SORT_AT = sql<Date>`TIMESTAMPADD(MICROSECOND, -(MICROSECOND(COALESCE(published_at, created_at)) % 1000), COALESCE(published_at, created_at))`;

async function audiencesOf(
  executor: Executor,
  noteIds: readonly Buffer[],
): Promise<Map<string, NoteAudienceEntry[]>> {
  const byNote = new Map<string, NoteAudienceEntry[]>();
  if (noteIds.length === 0) return byNote;
  const rows = await executor
    .selectFrom('communication_note_audiences')
    .select(['note_id', 'audience_type', 'audience_ref'])
    .where('note_id', 'in', noteIds)
    .execute();
  for (const row of rows) {
    const id = fromBin(row.note_id);
    byNote.set(id, [
      ...(byNote.get(id) ?? []),
      noteAudienceEntryOfRow(row.audience_type, row.audience_ref),
    ]);
  }
  return byNote;
}

async function acknowledgementsOf(
  executor: Executor,
  userId: string,
  noteIds: readonly Buffer[],
): Promise<Map<string, { readAt: Date; acknowledgedAt: Date | null }>> {
  const byNote = new Map<string, { readAt: Date; acknowledgedAt: Date | null }>();
  if (noteIds.length === 0) return byNote;
  const rows = await executor
    .selectFrom('communication_note_acknowledgements')
    .select(['note_id', 'read_at', 'acknowledged_at'])
    .where('user_id', '=', toBin(userId))
    .where('note_id', 'in', noteIds)
    .execute();
  for (const row of rows) {
    byNote.set(fromBin(row.note_id), { readAt: row.read_at, acknowledgedAt: row.acknowledged_at });
  }
  return byNote;
}

function toItem(
  row: NoteRow,
  audience: readonly NoteAudienceEntry[] | null,
  state: { readAt: Date; acknowledgedAt: Date | null } | undefined,
): NoteReadItem {
  return {
    id: fromBin(row.id),
    title: row.title,
    body: row.body,
    category: row.category,
    relatedEntityType: row.related_entity_type,
    relatedEntityId: fromBinOrNull(row.related_entity_id),
    requiresAck: Boolean(row.requires_ack),
    status: row.status as NoteReadStatus,
    publishedAt: row.published_at,
    expiresAt: row.expires_at,
    authorUserId: fromBin(row.created_by),
    audience,
    readAt: state?.readAt ?? null,
    acknowledgedAt: state?.acknowledgedAt ?? null,
  };
}

interface InboxScan {
  readonly items: NoteReadItem[];
  readonly truncated: boolean;
}

/** Notes publiées, non expirées, qui touchent le lecteur, de la plus récente à la plus ancienne. */
async function inboxItems(
  executor: Executor,
  resolver: NoteAudienceResolver,
  input: {
    readonly userId: string;
    readonly at: Date;
    readonly recentMax: number;
    readonly pendingMax: number;
  },
): Promise<InboxScan> {
  const open = executor
    .selectFrom('communication_internal_notes')
    .select(NOTE_COLUMNS)
    .where('status', '=', 'PUBLISHED')
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', input.at)]));
  const recent = await open
    .orderBy('published_at', 'desc')
    .orderBy('id', 'desc')
    .limit(input.recentMax + 1)
    .execute();
  // Les notes à accuser non accusées par le lecteur sont toujours examinées, même plus anciennes que les plus
  // récentes : sinon une accumulation de notes la ferait sortir du centre alors que l'accusé manque.
  const unacknowledged = await open
    .where('requires_ack', '=', 1)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('communication_note_acknowledgements as a')
            .select('a.note_id')
            .whereRef('a.note_id', '=', 'communication_internal_notes.id')
            .where('a.user_id', '=', toBin(input.userId))
            .where('a.acknowledged_at', 'is not', null),
        ),
      ),
    )
    .orderBy('published_at', 'desc')
    .orderBy('id', 'desc')
    .limit(input.pendingMax + 1)
    .execute();
  const truncated = recent.length > input.recentMax || unacknowledged.length > input.pendingMax;
  const rows = [...recent.slice(0, input.recentMax)];
  const scanned = new Set(rows.map((row) => fromBin(row.id)));
  for (const row of unacknowledged.slice(0, input.pendingMax)) {
    if (!scanned.has(fromBin(row.id))) rows.push(row);
  }
  rows.sort(
    (a, b) =>
      b.published_at!.getTime() - a.published_at!.getTime() ||
      (fromBin(b.id) > fromBin(a.id) ? 1 : -1),
  );
  const audiences = await audiencesOf(
    executor,
    rows.map((row) => row.id),
  );
  const visible = await resolver.visibleNoteIds(
    executor,
    input.userId,
    rows.map((row) => ({ id: fromBin(row.id), audience: audiences.get(fromBin(row.id)) ?? [] })),
    input.at,
  );
  const kept = rows.filter((row) => visible.has(fromBin(row.id)));
  const states = await acknowledgementsOf(
    executor,
    input.userId,
    kept.map((row) => row.id),
  );
  return { items: kept.map((row) => toItem(row, null, states.get(fromBin(row.id)))), truncated };
}

const isPending = (item: NoteReadItem): boolean => item.requiresAck && item.acknowledgedAt === null;

/** Page du centre de notes (`INBOX`) ou de la gestion (`MANAGE`). */
export async function notePage(
  executor: Executor,
  resolver: NoteAudienceResolver,
  input: {
    readonly userId: string;
    /** Instant de la lecture : l'audience et l'expiration s'y jugent. */
    readonly at: Date;
    readonly scope: NoteViewScope;
    /** Gestion seulement : statuts retenus (tous par défaut). */
    readonly statuses?: readonly NoteReadStatus[];
    /** Centre de notes seulement : les notes à accusé requis non accusées. */
    readonly pendingOnly?: boolean;
    readonly after?: NoteCursor;
    readonly limit: number;
    /** Plafonds de balayage du centre de notes (valeurs techniques ; {@link NOTE_INBOX_SCAN_MAX} par défaut). */
    readonly scan?: { readonly recent?: number; readonly pending?: number };
  },
): Promise<NotePage> {
  const scan = await inboxItems(executor, resolver, {
    userId: input.userId,
    at: input.at,
    recentMax: input.scan?.recent ?? NOTE_INBOX_SCAN_MAX,
    pendingMax: input.scan?.pending ?? NOTE_INBOX_SCAN_MAX,
  });
  const inbox = scan.items;
  const pendingAcknowledgements = inbox.filter(isPending).length;
  const { truncated } = scan;

  if (input.scope === 'INBOX') {
    const after = input.after;
    const candidates = inbox
      .filter((item) => !input.pendingOnly || isPending(item))
      .filter((item) => {
        if (after === undefined) return true;
        const at = item.publishedAt!.getTime();
        return at < after.at.getTime() || (at === after.at.getTime() && item.id < after.id);
      });
    const items = candidates.slice(0, input.limit);
    const last = items[items.length - 1];
    const nextCursor =
      candidates.length > input.limit && last !== undefined
        ? encodeNoteCursor({ at: last.publishedAt!, id: last.id })
        : null;
    return { items, pendingAcknowledgements, truncated, nextCursor };
  }

  // Gestion : brouillons du lecteur seulement ; notes publiées et archivées de tous.
  let query = executor
    .selectFrom('communication_internal_notes')
    .select(NOTE_COLUMNS)
    .select(SORT_AT.as('sort_at'))
    .where((eb) =>
      eb.or([eb('status', '<>', 'DRAFT'), eb('created_by', '=', toBin(input.userId))]),
    );
  if (input.statuses !== undefined && input.statuses.length > 0) {
    query = query.where('status', 'in', [...input.statuses]);
  }
  if (input.after !== undefined) {
    query = query.where(
      sql<boolean>`(${SORT_AT}, id) < (${input.after.at}, ${toBin(input.after.id)})`,
    );
  }
  const rows = await query
    .orderBy(SORT_AT, 'desc')
    .orderBy('id', 'desc')
    .limit(input.limit + 1)
    .execute();
  const page = rows.slice(0, input.limit);
  const ids = page.map((row) => row.id);
  const audiences = await audiencesOf(executor, ids);
  const states = await acknowledgementsOf(executor, input.userId, ids);
  const items = page.map((row) =>
    toItem(row, audiences.get(fromBin(row.id)) ?? [], states.get(fromBin(row.id))),
  );
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > input.limit && last !== undefined
      ? encodeNoteCursor({ at: last.sort_at, id: fromBin(last.id) })
      : null;
  return { items, pendingAcknowledgements, truncated, nextCursor };
}

/** Fiche d'une note ; `null` si elle n'existe pas ou n'est pas visible du lecteur (404 opaque). */
export async function noteDetail(
  executor: Executor,
  resolver: NoteAudienceResolver,
  input: {
    readonly userId: string;
    readonly at: Date;
    readonly id: string;
    /** Le lecteur détient `comm.note.publish`. */
    readonly canManage: boolean;
  },
): Promise<NoteReadItem | null> {
  const row = await executor
    .selectFrom('communication_internal_notes')
    .select(NOTE_COLUMNS)
    .where('id', '=', toBin(input.id))
    .executeTakeFirst();
  if (row === undefined) return null;
  // Clé en minuscules, quelle que soit la casse de l'identifiant demandé (`toBin` accepte les deux).
  const noteId = fromBin(row.id);
  const audience = (await audiencesOf(executor, [row.id])).get(noteId) ?? [];
  if (row.status === 'DRAFT') {
    if (!input.canManage || fromBin(row.created_by) !== input.userId) return null;
  } else if (!input.canManage) {
    if (row.status !== 'PUBLISHED') return null;
    if (!(await resolver.includesUserAt(executor, input.userId, audience, input.at))) return null;
  }
  const state = (await acknowledgementsOf(executor, input.userId, [row.id])).get(noteId);
  return toItem(row, input.canManage ? audience : null, state);
}

export interface NoteAcknowledgementFollowUp {
  readonly noteId: string;
  readonly requiresAck: boolean;
  readonly audienceSize: number;
  readonly read: number;
  readonly acknowledged: number;
  /** Utilisateurs de l'audience sans accusé (note à accusé requis) ou sans lecture (note simple), triés. */
  readonly missingUserIds: readonly string[];
}

/** Suivi des accusés d'une note pour la gestion ; `null` si la note est inconnue ou est le brouillon d'un autre. */
export async function noteAcknowledgementFollowUp(
  executor: Executor,
  resolver: NoteAudienceResolver,
  input: { readonly userId: string; readonly at: Date; readonly id: string },
): Promise<NoteAcknowledgementFollowUp | null> {
  const row = await executor
    .selectFrom('communication_internal_notes')
    .select(['id', 'requires_ack', 'status', 'created_by'])
    .where('id', '=', toBin(input.id))
    .executeTakeFirst();
  if (row === undefined) return null;
  const noteId = fromBin(row.id);
  const author = fromBin(row.created_by);
  if (row.status === 'DRAFT' && author !== input.userId) return null;

  const requiresAck = Boolean(row.requires_ack);
  // Un brouillon n'a pas d'audience : il n'a été notifié à personne.
  if (row.status === 'DRAFT') {
    return {
      noteId,
      requiresAck,
      audienceSize: 0,
      read: 0,
      acknowledged: 0,
      missingUserIds: [],
    };
  }

  const entries = (await audiencesOf(executor, [row.id])).get(noteId) ?? [];
  // L'auteur sait ce qu'il a publié : il n'est pas attendu, sauf s'il a lui-même lu ou accusé la note.
  const audience = (await resolver.usersInAudienceAt(executor, entries, input.at)).filter(
    (userId) => userId !== author,
  );
  const acks = await executor
    .selectFrom('communication_note_acknowledgements')
    .select(['user_id', 'acknowledged_at'])
    .where('note_id', '=', row.id)
    .execute();
  const acknowledgedBy = new Set(
    acks.filter((ack) => ack.acknowledged_at !== null).map((ack) => fromBin(ack.user_id)),
  );
  const readBy = new Set(acks.map((ack) => fromBin(ack.user_id)));
  const done = requiresAck ? acknowledgedBy : readBy;
  return {
    noteId,
    requiresAck,
    audienceSize: new Set([...audience, ...readBy]).size,
    read: readBy.size,
    acknowledged: acknowledgedBy.size,
    missingUserIds: audience.filter((userId) => !done.has(userId)).sort(),
  };
}
