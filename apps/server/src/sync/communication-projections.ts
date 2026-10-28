/**
 * Lecteurs de projection du jeu hors ligne `comms` (P9-12 ; ADR-060 §6, ADR-063 §4 ; AV-433 à AV-436 ;
 * 06-offline-sync/01-architecture-offline.md §3.1) : la boîte d'alertes, les notifications non lues et les
 * notes de l'utilisateur, avec son état de lecture. Fichier propre à P9, inscrit dans `ENTITY_PROJECTIONS`
 * (`entity-projections.ts`) par une seule ligne ; les demandes de validation de l'utilisateur (`comms`
 * aussi) sont servies par le lecteur `APPROVAL_REQUEST` de ce fichier-là.
 *
 * - **Portée `USER` seulement, et celle de l'utilisateur qui télécharge** : les lignes sont émises par
 *   `communication` (une par destinataire, `modules/communication/application/sync-changes.ts`) ; une ligne
 *   `GLOBAL` (le repli générique du pipeline) ou d'un autre utilisateur ne sert jamais rien.
 * - **Le texte est rendu pour son destinataire** (RC-05, AV-390) : une valeur au coût n'est dans le message
 *   d'une alerte ou d'une notification que si l'utilisateur détient `inventory.valuation.read` sur le site de
 *   l'alerte ; les lectures HTTP de `communication` font le rendu, ce fichier ne le recopie pas.
 * - **Un élément qui n'est plus servable** (alerte close, notification lue, note retirée ou expirée) n'est
 *   pas servi : sa sortie de l'appareil est une ligne `SCOPE_EXIT` du flux, écrite à l'événement.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../platform/kysely/uuid-columns.js';
import {
  alertDetail,
  noteDetail,
  notificationBodies,
} from '../modules/communication/application/public/index.js';
import { hasPermissionAt } from '../modules/identity/application/public/index.js';
import { IdentityNoteAudienceResolver } from '../communication-api/identity-note-audience-resolver.js';

/** L'adaptateur d'audience des notes est sans état : une instance suffit au lecteur `NOTE`. */
const noteAudience = new IdentityNoteAudienceResolver();

/**
 * Signature de `EntityProjectionReader` (`entity-projections.ts`), recopiée ici : ce fichier est importé par
 * `entity-projections.ts`, qui ne peut pas être importé en retour (règle `no-circular`).
 */
interface ProjectionContext {
  readonly scopeType: string;
  readonly scopeId: string | null;
}
type ProjectionReader = (
  executor: Kysely<DB> | Transaction<DB>,
  entityId: string,
  context: ProjectionContext,
) => Promise<Record<string, unknown> | undefined>;

/** L'utilisateur de la ligne, à condition qu'elle soit en portée `USER`. */
function userOf(context: ProjectionContext): string | undefined {
  return context.scopeType === 'USER' && context.scopeId !== null ? context.scopeId : undefined;
}

export const COMMUNICATION_PROJECTIONS: Readonly<Record<string, ProjectionReader>> = {
  /**
   * Une alerte ouverte de la boîte de l'utilisateur (dictionnaire `communication.alerts` : « Offline DL »).
   * Seule la boîte (les destinataires inscrits) voyage ; la supervision par la portée reste en ligne
   * (AV-433). Sans la charge utile brute : seuls les champs non protégés (`payload` public).
   */
  ALERT: async (executor, entityId, context) => {
    const userId = userOf(context);
    if (userId === undefined) return undefined;
    const alert = await alertDetail(executor, { userId, at: new Date(), id: entityId });
    // `RECIPIENT` n'est porté que par une alerte ouverte (OPEN, ACKNOWLEDGED).
    if (alert === null || !alert.visibility.includes('RECIPIENT')) return undefined;
    return {
      id: alert.id,
      alert_type: alert.alertType,
      nature: alert.nature,
      severity: alert.severity,
      status: alert.status,
      title: alert.title,
      message: alert.message,
      subject_type: alert.subjectType,
      subject_id: alert.subjectId,
      site_id: alert.siteId,
      zone_id: alert.zoneId,
      action_screen: alert.actionScreen,
      occurrences: alert.occurrences,
      first_detected_at: alert.firstDetectedAt,
      last_detected_at: alert.lastDetectedAt,
      critical_since: alert.criticalSince,
      escalated_at: alert.escalatedAt,
      acknowledged_at: alert.acknowledgedAt,
      acknowledged_by: alert.acknowledgedBy,
      payload: alert.payload,
    };
  },

  /** Une notification `IN_APP` non lue de l'utilisateur (dictionnaire `communication.notifications`). */
  NOTIFICATION: async (executor, entityId, context) => {
    const userId = userOf(context);
    if (userId === undefined) return undefined;
    const row = await executor
      .selectFrom('communication_notifications')
      .select([
        'id',
        'channel',
        'kind',
        'title',
        'body',
        'link',
        'alert_id',
        'note_id',
        'source_type',
        'source_id',
        'created_at',
        'delivered_at',
        'read_at',
      ])
      .where('id', '=', toBin(entityId))
      .where('user_id', '=', toBin(userId))
      .where('channel', '=', 'IN_APP')
      .executeTakeFirst();
    if (row === undefined || row.read_at !== null) return undefined;
    const bodies = await notificationBodies(executor, userId, [row], new Date());
    return {
      id: fromBin(row.id),
      kind: row.kind,
      title: row.title,
      body: bodies.get(fromBin(row.id)) ?? row.body,
      link: row.link,
      alert_id: fromBinOrNull(row.alert_id),
      note_id: fromBinOrNull(row.note_id),
      source_type: row.source_type,
      source_id: fromBinOrNull(row.source_id),
      created_at: row.created_at,
      delivered_at: row.delivered_at,
    };
  },

  /**
   * Une note publiée, non expirée, de l'utilisateur, avec **son** état de lecture (dictionnaire
   * `communication.note_acknowledgements` : l'accusé voyage dans la note, `read_at` et `acknowledged_at`).
   * L'audience n'est pas jointe : l'appareil n'a pas à la connaître. Servie seulement à qui la note a été
   * notifiée ou qui l'a lue (aucune fuite par une ligne émise à tort), **et** qui, à l'instant de la lecture,
   * détient `comm.note.read` et fait encore partie de l'audience (P9-25, NT-2 : la règle de `GET /notes/{id}`,
   * `noteDetail`) ; sinon rien n'est servi.
   */
  NOTE: async (executor, entityId, context) => {
    const userId = userOf(context);
    if (userId === undefined) return undefined;
    const noteId = toBin(entityId);
    const note = await executor
      .selectFrom('communication_internal_notes')
      .select([
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
        'created_by',
      ])
      .where('id', '=', noteId)
      .executeTakeFirst();
    if (note === undefined || note.status !== 'PUBLISHED') return undefined;
    if (note.expires_at !== null && note.expires_at <= new Date()) return undefined;
    const state = await executor
      .selectFrom('communication_note_acknowledgements')
      .select(['read_at', 'acknowledged_at'])
      .where('note_id', '=', noteId)
      .where('user_id', '=', toBin(userId))
      .executeTakeFirst();
    if (state === undefined) {
      const notified = await executor
        .selectFrom('communication_notifications')
        .select('id')
        .where('user_id', '=', toBin(userId))
        .where('note_id', '=', noteId)
        .where('channel', '=', 'IN_APP')
        .limit(1)
        .executeTakeFirst();
      if (notified === undefined) return undefined;
    }
    const now = new Date();
    if (!(await hasPermissionAt(executor, toBin(userId), 'comm.note.read', now))) return undefined;
    const visible = await noteDetail(executor, noteAudience, {
      userId,
      at: now,
      id: entityId,
      canManage: false,
    });
    if (visible === null) return undefined;
    return {
      id: fromBin(note.id),
      title: note.title,
      body: note.body,
      category: note.category,
      related_entity_type: note.related_entity_type,
      related_entity_id: fromBinOrNull(note.related_entity_id),
      requires_ack: Boolean(note.requires_ack),
      published_at: note.published_at,
      expires_at: note.expires_at,
      author_user_id: fromBin(note.created_by),
      read_at: state?.read_at ?? null,
      acknowledged_at: state?.acknowledged_at ?? null,
    };
  },
};
