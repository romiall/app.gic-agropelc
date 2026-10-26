/**
 * Lignes du flux de changements du jeu `comms` (P9-12 ; ADR-060 §6, ADR-063 §4 ; AV-433 à AV-436 ;
 * 06-offline-sync/01-architecture-offline.md §3.1) : alertes de la boîte de l'utilisateur, notifications
 * non lues, notes et leur état de lecture. **Une ligne par destinataire** en portée `USER` (jamais `GLOBAL`,
 * `SITE` ni `ZONE` : un rôle n'est pas une portée du flux, et une alerte ou une note ne doit atteindre que ses
 * destinataires), écrite dans la transaction de l'écriture qu'elle décrit (§5.1 : « dans la même transaction »).
 *
 * - `UPSERT` : l'appareil reçoit l'état courant, lu par `sync/communication-projections.ts` au moment du
 *   téléchargement (le flux ne stocke pas de copie, et le texte est rendu pour le destinataire, RC-05).
 * - `SCOPE_EXIT` : l'élément sort du jeu de l'appareil (alerte close, notification lue, note retirée).
 *
 * Les types d'entité sont `ALERT`, `NOTIFICATION` et `NOTE` ; leurs lecteurs refusent toute ligne qui n'est
 * pas en portée `USER` d'un destinataire (le repli générique `GLOBAL` du pipeline ne sert jamais de donnée).
 */
import type { Kysely } from 'kysely';
import type { DB } from '../../../platform/kysely/database.js';
import type { UnitOfWork } from '../../../platform/unit-of-work.js';
import { recordChanges, type ChangeFeedEntry } from '../../../platform/sync/change-feed.js';
import { fromBin, toBin } from '../../../platform/kysely/uuid-columns.js';

type Executor = UnitOfWork | Kysely<DB>;
export type CommsChange = 'UPSERT' | 'SCOPE_EXIT';

const COMMS = 'comms';

const entry = (
  entityType: 'ALERT' | 'NOTIFICATION' | 'NOTE',
  entityId: string,
  userId: string,
  change: CommsChange,
): ChangeFeedEntry => ({
  dataset: COMMS,
  entityType,
  entityId,
  scopeType: 'USER',
  scopeId: userId,
  changeType: change,
});

/** Destinataires inscrits d'une alerte (sa boîte). */
async function alertRecipientIds(executor: Executor, alertId: string): Promise<string[]> {
  const rows = await executor
    .selectFrom('communication_alert_recipients')
    .select('user_id')
    .where('alert_id', '=', toBin(alertId))
    .execute();
  return rows.map((row) => fromBin(row.user_id));
}

/**
 * Une ligne par destinataire de l'alerte (ses destinataires inscrits à défaut de la liste donnée : les
 * destinataires qui viennent d'être ajoutés).
 */
export async function recordAlertChanges(
  executor: Executor,
  alertId: string,
  change: CommsChange,
  userIds?: readonly string[],
): Promise<void> {
  const recipients = userIds ?? (await alertRecipientIds(executor, alertId));
  await recordChanges(
    executor,
    [...new Set(recipients)].map((userId) => entry('ALERT', alertId, userId, change)),
  );
}

/** Une ligne par notification `IN_APP` (la seule que l'appareil reçoit : le push n'en est que l'envoi). */
export async function recordNotificationChanges(
  executor: Executor,
  notifications: readonly { readonly id: string; readonly userId: string }[],
  change: CommsChange,
): Promise<void> {
  await recordChanges(
    executor,
    notifications.map((notification) =>
      entry('NOTIFICATION', notification.id, notification.userId, change),
    ),
  );
}

/** Une ligne par utilisateur donné pour la note (publication, état de lecture, retrait). */
export async function recordNoteChanges(
  executor: Executor,
  noteId: string,
  userIds: readonly string[],
  change: CommsChange,
): Promise<void> {
  await recordChanges(
    executor,
    [...new Set(userIds)].map((userId) => entry('NOTE', noteId, userId, change)),
  );
}

/**
 * Utilisateurs dont l'appareil détient la note : ceux qu'a touchés la publication (une notification `IN_APP`
 * de la note) et ceux qui l'ont lue ou accusée depuis (affectés après la publication) — à qui le retrait
 * doit atteindre.
 */
export async function noteHolderIds(executor: Executor, noteId: string): Promise<string[]> {
  const notified = await executor
    .selectFrom('communication_notifications')
    .select('user_id')
    .where('note_id', '=', toBin(noteId))
    .where('channel', '=', 'IN_APP')
    .execute();
  const acknowledged = await executor
    .selectFrom('communication_note_acknowledgements')
    .select('user_id')
    .where('note_id', '=', toBin(noteId))
    .execute();
  return [...new Set([...notified, ...acknowledged].map((row) => fromBin(row.user_id)))];
}
