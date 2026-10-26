/**
 * Envoi des notifications Web Push en attente (P9-05 ; ADR-072 §5 ; BR-NOT-004 ; D13 §14). La ligne
 * `WEB_PUSH` est créée dans la transaction du consommateur ; l'envoi se fait ici, **après sa validation**
 * (tâche `communication.push.dispatch`, chaque minute).
 *
 * - Au moins une fois : une ligne n'est marquée livrée qu'après qu'un abonnement a accepté le push ; un
 *   envoi accepté puis une transaction perdue donnent un doublon toléré. L'état de livraison est tenu par
 *   notification, pas par abonnement : dès qu'un appareil a reçu le push, la ligne est livrée (le
 *   canal in-app reste complet pour les autres) — un état par appareil demanderait une table dédiée,
 *   à décider avec l'adaptateur réel (AV-415).
 * - Un abonnement qui répond « disparu » (410) est révoqué ; une panne reste une ligne en attente, reprise
 *   au passage suivant, dans la fenêtre technique de reprise.
 * - Une alerte résolue ou écartée avant l'envoi n'est plus poussée (bruit).
 * - Les lignes sont verrouillées `SKIP LOCKED` : deux workers n'envoient pas la même.
 */
import { Logger } from '@nestjs/common';
import type { Clock } from '@gic/domain';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { fromBin } from '../../../../platform/kysely/uuid-columns.js';
import type { WebPushSender } from './web-push.js';

const logger = new Logger('communication.push');

/** Fenêtre technique de reprise d'un envoi en échec (constante de protocole, pas un seuil métier). */
export const PUSH_RETRY_WINDOW_MINUTES = 60;
const DEFAULT_BATCH = 100;

export interface PushDispatchResult {
  readonly examined: number;
  readonly delivered: number;
  readonly revoked: number;
}

export async function dispatchPendingPushes(
  uow: UnitOfWork,
  deps: { readonly clock: Clock; readonly sender: WebPushSender },
  options: { readonly batch?: number } = {},
): Promise<PushDispatchResult> {
  if (!deps.sender.enabled) return { examined: 0, delivered: 0, revoked: 0 };
  const now = deps.clock.now();
  const since = new Date(now.getTime() - PUSH_RETRY_WINDOW_MINUTES * 60_000);
  const pending = await uow
    .selectFrom('communication_notifications as n')
    .select(['n.id', 'n.user_id', 'n.title', 'n.body', 'n.link', 'n.alert_id', 'n.alert_type'])
    .where('n.channel', '=', 'WEB_PUSH')
    .where('n.delivered_at', 'is', null)
    .where('n.created_at', '>=', since)
    .where((eb) =>
      eb.or([
        eb('n.alert_id', 'is', null),
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
    .orderBy('n.created_at', 'asc')
    .limit(options.batch ?? DEFAULT_BATCH)
    .forUpdate()
    .skipLocked()
    .execute();

  let delivered = 0;
  let revoked = 0;
  for (const row of pending) {
    // Seuls les appareils actifs d'un utilisateur actif : un appareil bloqué, perdu ou retiré ne reçoit rien.
    const subscriptions = await uow
      .selectFrom('communication_push_subscriptions as s')
      .innerJoin('identity_devices as d', 'd.id', 's.device_id')
      .innerJoin('identity_users as u', 'u.id', 's.user_id')
      .select(['s.id', 's.endpoint', 's.p256dh', 's.auth'])
      .where('s.user_id', '=', row.user_id)
      .where('s.revoked_at', 'is', null)
      .where('d.status', '=', 'ACTIVE')
      .where('u.status', '=', 'ACTIVE')
      .execute();
    let accepted = false;
    for (const subscription of subscriptions) {
      const result = await deps.sender.send(
        { endpoint: subscription.endpoint, p256dh: subscription.p256dh, auth: subscription.auth },
        {
          title: row.title,
          body: row.body,
          link: row.link,
          alertId: row.alert_id === null ? null : fromBin(row.alert_id),
          alertType: row.alert_type,
          tag: `alert:${row.alert_type ?? 'info'}`,
        },
      );
      if (result.status === 'SENT') {
        accepted = true;
      } else if (result.status === 'GONE') {
        await uow
          .updateTable('communication_push_subscriptions')
          .set({ revoked_at: now })
          .where('id', '=', subscription.id)
          .where('revoked_at', 'is', null)
          .execute();
        revoked += 1;
      } else {
        logger.warn(
          `Push non envoyé (${result.reason}) à l'abonnement ${fromBin(subscription.id)}.`,
        );
      }
    }
    if (accepted) {
      await uow
        .updateTable('communication_notifications')
        .set({ delivered_at: now })
        .where('id', '=', row.id)
        .where('delivered_at', 'is', null)
        .execute();
      delivered += 1;
    }
  }
  return { examined: pending.length, delivered, revoked };
}
