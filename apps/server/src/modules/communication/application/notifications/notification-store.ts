/**
 * Écriture des notifications (P9-05 ; ADR-072 §4 à §6 ; BR-NOT-004). Une ligne par destinataire et par
 * canal ; idempotente par (utilisateur, canal, événement source) : un événement rejoué ne double rien.
 */
import type { IdGenerator } from '@gic/domain';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';

export type NotificationKind = 'ALERT' | 'NOTE' | 'DIRECT' | 'EXPORT';
/** `ALERT` : levée ou occurrence ; `ALERT_ESCALATION` : escalade (jamais regroupée, ADR-072 §6). */
export type NotificationSourceType = 'ALERT' | 'ALERT_ESCALATION' | (string & {});

export interface NewNotification {
  readonly userId: string;
  readonly channel: 'IN_APP' | 'WEB_PUSH';
  readonly kind: NotificationKind;
  readonly alertId?: string | null;
  readonly alertType?: string | null;
  readonly noteId?: string | null;
  readonly sourceType: NotificationSourceType | null;
  readonly sourceId: string | null;
  readonly sourceEventId: string | null;
  readonly title: string;
  readonly body: string;
  readonly link: string | null;
  readonly createdAt: Date;
  /** Posé à la création pour `IN_APP` (disponible aussitôt) ; absent pour `WEB_PUSH` (envoi différé). */
  readonly deliveredAt?: Date | null;
}

/** Insère une notification ; faux si l'événement source l'avait déjà produite pour ce couple. */
export async function insertNotification(
  uow: UnitOfWork,
  idGenerator: IdGenerator,
  row: NewNotification,
): Promise<boolean> {
  const result = await uow
    .insertInto('communication_notifications')
    .values({
      id: toBin(idGenerator.newId()),
      user_id: toBin(row.userId),
      channel: row.channel,
      kind: row.kind,
      alert_id: row.alertId == null ? null : toBin(row.alertId),
      alert_type: row.alertType ?? null,
      note_id: row.noteId == null ? null : toBin(row.noteId),
      source_type: row.sourceType,
      source_id: row.sourceId === null ? null : toBin(row.sourceId),
      source_event_id: row.sourceEventId === null ? null : toBin(row.sourceEventId),
      title: row.title,
      body: row.body,
      link: row.link,
      created_at: row.createdAt,
      delivered_at: row.deliveredAt ?? null,
    })
    .ignore()
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
}

/**
 * Instant du dernier push d'**alerte** (hors escalade) destiné à l'utilisateur pour ce type : la base du
 * créneau de regroupement (D13 §14). Une ligne qui ne partira jamais (livraison jamais faite et alerte
 * déjà close) n'ouvre pas de créneau : elle ne supprimerait que le push immédiat de l'alerte suivante.
 */
export async function lastAlertPushAt(
  uow: UnitOfWork,
  userId: string,
  alertType: string,
): Promise<Date | null> {
  const row = await uow
    .selectFrom('communication_notifications as n')
    .select((eb) => eb.fn.max('n.created_at').as('last'))
    .where('n.user_id', '=', toBin(userId))
    .where('n.alert_type', '=', alertType)
    .where('n.channel', '=', 'WEB_PUSH')
    .where('n.source_type', '=', 'ALERT')
    .where((eb) =>
      eb.or([
        eb('n.delivered_at', 'is not', null),
        eb(
          'n.alert_id',
          'in',
          eb
            .selectFrom('communication_alerts as a')
            .select('a.id')
            .where('a.status', 'in', ['OPEN', 'ACKNOWLEDGED']),
        ),
      ]),
    )
    .executeTakeFirst();
  return row?.last ?? null;
}

/**
 * Alertes du même type tues depuis le dernier push : alertes **critiques** (les seules à avoir un push)
 * dont une notification in-app est postérieure au push et qui n'ont pas de push pour cet utilisateur,
 * comptées une fois chacune. L'alerte qui ouvre le créneau (`excludeAlertId`) n'est pas comptée : sa
 * notification in-app est déjà écrite.
 */
export async function countSuppressedAlertPushes(
  uow: UnitOfWork,
  userId: string,
  alertType: string,
  since: Date,
  excludeAlertId: string,
): Promise<number> {
  const row = await uow
    .selectFrom('communication_notifications as n')
    .innerJoin('communication_alerts as al', 'al.id', 'n.alert_id')
    .select((eb) => eb.fn.count<number>('n.alert_id').distinct().as('count'))
    .where('al.severity', '=', 'CRITICAL')
    .where('n.user_id', '=', toBin(userId))
    .where('n.alert_type', '=', alertType)
    .where('n.channel', '=', 'IN_APP')
    .where('n.source_type', '=', 'ALERT')
    .where('n.created_at', '>', since)
    .where('n.alert_id', '<>', toBin(excludeAlertId))
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('communication_notifications as p')
            .select('p.id')
            .whereRef('p.user_id', '=', 'n.user_id')
            .whereRef('p.alert_id', '=', 'n.alert_id')
            .where('p.channel', '=', 'WEB_PUSH'),
        ),
      ),
    )
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

/** Parmi ces utilisateurs, ceux qui ont au moins un abonnement Web Push non révoqué sur un appareil actif. */
export async function usersWithActiveSubscription(
  uow: UnitOfWork,
  userIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (userIds.length === 0) return new Set();
  // Un appareil bloqué, perdu ou retiré, ou un utilisateur suspendu ou désactivé, n'est plus une cible :
  // le service de push continuerait de lui acheminer titre et corps sans authentification.
  const rows = await uow
    .selectFrom('communication_push_subscriptions as s')
    .innerJoin('identity_devices as d', 'd.id', 's.device_id')
    .innerJoin('identity_users as u', 'u.id', 's.user_id')
    .select('s.user_id')
    .where('s.user_id', 'in', userIds.map(toBin))
    .where('s.revoked_at', 'is', null)
    .where('d.status', '=', 'ACTIVE')
    .where('u.status', '=', 'ACTIVE')
    .groupBy('s.user_id')
    .execute();
  return new Set(rows.map((row) => fromBin(row.user_id)));
}
