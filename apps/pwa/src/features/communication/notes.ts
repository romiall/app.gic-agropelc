/**
 * Logique pure de l'écran des notes de direction (`ECR-NOT-02`) et de publication / suivi (`ECR-NOT-03`).
 */

import {
  COMMUNICATION_COMMAND_TYPES,
  NOTE_AUDIENCE_TYPES,
  NOTE_CATEGORIES,
  NOTE_STATUSES,
  noteAcknowledgePayloadSchema,
  noteArchivePayloadSchema,
  noteDraftSavePayloadSchema,
  notePublishPayloadSchema,
  type NoteAudienceEntry,
  type NoteCategory,
  type NoteItem,
} from '@gic/contracts';

export { NOTE_AUDIENCE_TYPES, NOTE_CATEGORIES, NOTE_STATUSES };

export type NoteStatus = (typeof NOTE_STATUSES)[number];
export type NoteAudienceType = (typeof NOTE_AUDIENCE_TYPES)[number];

export interface NotesInboxFilter {
  readonly pendingAckOnly: boolean;
}

export interface NotesManageFilter {
  readonly status: '' | NoteStatus;
}

export const notesInboxPath = (filter: NotesInboxFilter): string => {
  const params = new URLSearchParams({ scope: 'inbox', limit: '50' });
  if (filter.pendingAckOnly) params.set('pending_ack', 'true');
  return `/api/v1/notes?${params.toString()}`;
};

export const notesManagePath = (filter: NotesManageFilter): string => {
  const params = new URLSearchParams({ scope: 'manage', limit: '50' });
  if (filter.status) params.set('status', filter.status);
  return `/api/v1/notes?${params.toString()}`;
};

export const noteAckFollowUpPath = (noteId: string): string =>
  `/api/v1/notes/${encodeURIComponent(noteId)}/acknowledgements`;

/** Conversion d'une note projetée hors ligne (`comms:NOTE`) vers `NoteItem`. */
export const fromProjectedNote = (raw: unknown): NoteItem | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.title !== 'string' || typeof r.body !== 'string') {
    return null;
  }
  const category = (NOTE_CATEGORIES as readonly string[]).includes(String(r.category))
    ? (r.category as NoteCategory)
    : 'INFORMATION';
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    category,
    relatedEntityType: typeof r.related_entity_type === 'string' ? r.related_entity_type : null,
    relatedEntityId: typeof r.related_entity_id === 'string' ? r.related_entity_id : null,
    requiresAck: Boolean(r.requires_ack),
    status: 'PUBLISHED',
    publishedAt: typeof r.published_at === 'string' ? r.published_at : null,
    expiresAt: typeof r.expires_at === 'string' ? r.expires_at : null,
    authorUserId: typeof r.author_user_id === 'string' ? r.author_user_id : '',
    readAt: typeof r.read_at === 'string' ? r.read_at : null,
    acknowledgedAt: typeof r.acknowledged_at === 'string' ? r.acknowledged_at : null,
  };
};

export const filterProjectedNotes = (
  records: ReadonlyArray<unknown>,
  filter: NotesInboxFilter,
): { items: NoteItem[]; pendingAcknowledgements: number } => {
  const all = records
    .map((r) => fromProjectedNote(r))
    .filter((item): item is NoteItem => item !== null)
    .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
  const pendingAcknowledgements = all.filter((n) => n.requiresAck && !n.acknowledgedAt).length;
  const items = filter.pendingAckOnly ? all.filter((n) => n.requiresAck && !n.acknowledgedAt) : all;
  return { items, pendingAcknowledgements };
};

export const buildNoteAckPayload = (kind: 'READ' | 'ACKNOWLEDGE') => {
  const parsed = noteAcknowledgePayloadSchema.safeParse({ kind });
  if (!parsed.success) return { ok: false as const, error: 'invalid' as const };
  return {
    ok: true as const,
    commandType: COMMUNICATION_COMMAND_TYPES.noteAcknowledge,
    payload: parsed.data,
  };
};

export interface NoteFormDraft {
  readonly title: string;
  readonly body: string;
  readonly category: NoteCategory;
  readonly requiresAck: boolean;
  readonly expiresAtDate: string;
  readonly audience: readonly NoteAudienceEntry[];
}

export const buildNoteSaveOrPublishPayload = (draft: NoteFormDraft, mode: 'DRAFT' | 'PUBLISH') => {
  const title = draft.title.trim();
  const body = draft.body.trim();
  if (!title || !body || draft.audience.length === 0) {
    return { ok: false as const, error: 'required' as const };
  }
  const expiresAt = draft.expiresAtDate.trim()
    ? `${draft.expiresAtDate.trim()}T23:59:59.000Z`
    : undefined;
  const raw = {
    title,
    body,
    category: draft.category,
    requiresAck: draft.requiresAck,
    ...(expiresAt ? { expiresAt } : {}),
    audience: [...draft.audience],
  };
  const schema = mode === 'PUBLISH' ? notePublishPayloadSchema : noteDraftSavePayloadSchema;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false as const, error: 'invalid' as const };
  }
  return {
    ok: true as const,
    commandType:
      mode === 'PUBLISH'
        ? COMMUNICATION_COMMAND_TYPES.notePublish
        : COMMUNICATION_COMMAND_TYPES.noteSaveDraft,
    payload: parsed.data,
  };
};

export const buildNoteArchivePayload = (reason: string) => {
  const parsed = noteArchivePayloadSchema.safeParse({ reason: reason.trim() });
  if (!parsed.success) return { ok: false as const, error: 'reason_required' as const };
  return {
    ok: true as const,
    commandType: COMMUNICATION_COMMAND_TYPES.noteArchive,
    payload: parsed.data,
  };
};
