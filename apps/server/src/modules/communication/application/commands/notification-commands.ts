/**
 * Commandes de notification et d'abonnement Web Push (P9-05 ; D13 §4, UC-NOT-04 et 07 ; ADR-072 §4, §5) :
 * `communication.notification.read` (hors ligne possible), `communication.push.subscribe` et
 * `communication.push.unsubscribe`.
 *
 * - **Lecture** : ne touche que les notifications de l'auteur (celles des autres sont ignorées sans le
 *   dire : aucune fuite d'existence) ; déjà lue = sans effet ; l'instant de lecture est celui du fait,
 *   jamais antérieur à la création.
 * - **Abonnement** : lié à l'appareil authentifié de la commande ; un point de terminaison déjà connu
 *   (autre utilisateur ou autre appareil) est repris par la session courante : l'ancienne ligne, qui ne
 *   peut plus évoluer, est supprimée puis recréée.
 * - Tous ces actes sont à la portée de tout titulaire de `comm.alert.read` (tous les rôles).
 */
import type { IdGenerator } from '@gic/domain';
import {
  notificationReadPayloadSchema,
  pushSubscribePayloadSchema,
  pushUnsubscribePayloadSchema,
  type NotificationReadPayload,
  type PushSubscribePayload,
  type PushUnsubscribePayload,
} from '@gic/contracts';
import { sql } from 'kysely';
import type {
  CommandHandler,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { loadCommandOrigin } from '../../../../platform/sync/command-origin.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { recordNotificationChanges } from '../sync-changes.js';

const READ_PERMISSION = 'comm.alert.read';

const readNotifications: CommandHandler<NotificationReadPayload> = async (uow, envelope) => {
  const at = new Date(envelope.occurred_at);
  const payload = envelope.payload;
  const author = envelope.author_user_id;
  const base = uow
    .selectFrom('communication_notifications')
    .select(['id', 'channel'])
    .where('user_id', '=', toBin(author))
    .where('read_at', 'is', null);
  // « Toutes » : celles que l'utilisateur avait sous les yeux à l'instant de son geste, jamais celles
  // créées ensuite (une commande hors ligne arrive plus tard).
  const query =
    payload.notificationIds !== undefined
      ? base.where('id', 'in', payload.notificationIds.map(toBin))
      : base.where('created_at', '<=', at);
  const targets = await query.forUpdate().execute();
  if (targets.length > 0) {
    await uow
      .updateTable('communication_notifications')
      .set({ read_at: sql<Date>`GREATEST(created_at, ${at})` })
      .where(
        'id',
        'in',
        targets.map((target) => target.id),
      )
      .where('read_at', 'is', null)
      .execute();
    // Jeu hors ligne `comms` : les notifications lues sortent des non lues de l'appareil.
    await recordNotificationChanges(
      uow,
      targets
        .filter((target) => target.channel === 'IN_APP')
        .map((target) => ({ id: fromBin(target.id), userId: author })),
      'SCOPE_EXIT',
    );
  }
  return {
    status: 'APPLIED',
    serverRefs: { marked: String(targets.length) },
  };
};

function subscribe(idGenerator: IdGenerator): CommandHandler<PushSubscribePayload> {
  return async (uow, envelope) => {
    const author = envelope.author_user_id;
    const origin = await loadCommandOrigin(uow, envelope.command_id);
    if (origin.deviceId === null) {
      return {
        status: 'REJECTED',
        errorCode: 'DEVICE_REQUIRED',
        messageFr: "L'abonnement aux notifications exige un appareil identifié.",
      };
    }
    const { endpoint, keys } = envelope.payload;
    const existing = await uow
      .selectFrom('communication_push_subscriptions')
      .select(['id', 'user_id', 'device_id', 'p256dh', 'auth', 'revoked_at'])
      .where('endpoint', '=', endpoint)
      .forUpdate()
      .executeTakeFirst();
    if (existing) {
      const unchanged =
        existing.revoked_at === null &&
        fromBin(existing.user_id) === author &&
        fromBin(existing.device_id) === origin.deviceId &&
        existing.p256dh === keys.p256dh &&
        existing.auth === keys.auth;
      if (unchanged) {
        return { status: 'APPLIED', serverRefs: { changed: 'false' } };
      }
      // Le point de terminaison appartient désormais à cette session : l'ancienne ligne est remplacée.
      await uow
        .deleteFrom('communication_push_subscriptions')
        .where('id', '=', existing.id)
        .execute();
    }
    const idTaken = await uow
      .selectFrom('communication_push_subscriptions')
      .select('id')
      .where('id', '=', toBin(envelope.aggregate_id))
      .executeTakeFirst();
    try {
      await uow
        .insertInto('communication_push_subscriptions')
        .values({
          id: toBin(idTaken ? idGenerator.newId() : envelope.aggregate_id),
          user_id: toBin(author),
          device_id: toBin(origin.deviceId),
          endpoint,
          p256dh: keys.p256dh,
          auth: keys.auth,
        })
        .execute();
    } catch (error) {
      // Une autre session vient d'abonner le même point de terminaison : c'est elle qui le détient.
      const code = (error as { code?: string; errno?: number } | null)?.code;
      const errno = (error as { errno?: number } | null)?.errno;
      if (code !== 'ER_DUP_ENTRY' && errno !== 1062) throw error;
      return { status: 'APPLIED', serverRefs: { changed: 'false' } };
    }
    return { status: 'APPLIED', serverRefs: { changed: 'true' } };
  };
}

const unsubscribe: CommandHandler<PushUnsubscribePayload> = async (uow, envelope) => {
  const at = new Date(envelope.occurred_at);
  const result = await uow
    .updateTable('communication_push_subscriptions')
    .set({ revoked_at: at })
    .where('user_id', '=', toBin(envelope.author_user_id))
    .where('endpoint', '=', envelope.payload.endpoint)
    .where('revoked_at', 'is', null)
    .execute();
  return {
    status: 'APPLIED',
    serverRefs: { revoked: String(Number(result[0]?.numUpdatedRows ?? 0)) },
  };
};

export function registerNotificationCommands(
  registry: CommandHandlerRegistry,
  idGenerator: IdGenerator,
): void {
  registry.register<NotificationReadPayload>({
    commandType: 'communication.notification.read',
    version: 1,
    payloadSchema: notificationReadPayloadSchema,
    permissionCode: READ_PERMISSION,
    handler: readNotifications,
  });
  registry.register<PushSubscribePayload>({
    commandType: 'communication.push.subscribe',
    version: 1,
    payloadSchema: pushSubscribePayloadSchema,
    permissionCode: READ_PERMISSION,
    handler: subscribe(idGenerator),
    // Pas de verrou d'intervalle sur une clé absente (ADR-038 §3) : l'unicité du point de terminaison
    // arbitre deux abonnements concurrents.
    isolationLevel: 'read committed',
  });
  registry.register<PushUnsubscribePayload>({
    commandType: 'communication.push.unsubscribe',
    version: 1,
    payloadSchema: pushUnsubscribePayloadSchema,
    permissionCode: READ_PERMISSION,
    handler: unsubscribe,
  });
}
