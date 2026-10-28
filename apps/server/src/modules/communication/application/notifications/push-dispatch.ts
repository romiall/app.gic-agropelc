/**
 * Envoi des notifications Web Push en attente (P9-05 ; ADR-062 §5 ; BR-NOT-004 ; D13 §14). La ligne
 * `WEB_PUSH` est créée dans la transaction du consommateur ; l'envoi se fait ici, **après sa validation**
 * (tâche `communication.push.dispatch`, chaque minute).
 *
 * - Au moins une fois : une ligne n'est marquée livrée qu'après qu'un abonnement a accepté le push ; un
 *   envoi accepté puis une transaction perdue donnent un doublon toléré. L'état de livraison est tenu par
 *   notification, pas par abonnement : dès qu'un appareil a reçu le push, la ligne est livrée (le
 *   canal in-app reste complet pour les autres) — un état par appareil demanderait une table dédiée,
 *   à décider avec l'adaptateur réel (AV-365).
 * - Un abonnement qui répond « disparu » (410) est révoqué ; une panne reste une ligne en attente, reprise
 *   au passage suivant, dans la fenêtre technique de reprise.
 * - Une alerte résolue ou écartée avant l'envoi n'est plus poussée (bruit).
 * - Une ligne dont le destinataire n'a aucun abonnement vivant (révoqué, appareil hors service, compte
 *   suspendu) n'est pas lue : elle n'occupe pas de place du lot (ADR-062, révision P9-05 §5 ; NT-5).
 * - **Verrous (NT-4)** : les candidates sont lues sans verrou (mêmes filtres, ordre et limite), puis chaque
 *   ligne est verrouillée une à une par clé primaire (`SKIP LOCKED`) juste avant son envoi : deux workers
 *   n'envoient pas la même, et l'entrée-sortie réseau ne retient ni verrou d'intervalle ni ligne étrangère.
 * - **Adaptateur non fiable (NT-4)** : chaque envoi est enveloppé. Une exception devient un résultat
 *   `FAILED` (un `statusCode` 404 ou 410 sur l'erreur vaut `GONE`) ; un silence au-delà du délai est
 *   annulé par signal puis devient `FAILED`. La passe s'arrête après un nombre borné de points de
 *   terminaison muets et à l'épuisement de son budget de temps : elle tient la voie courte du worker, qui
 *   sert aussi les consommateurs d'alertes (NFR-15). Les envois et révocations déjà faits ne sont pas
 *   annulés avec le lot, l'exception ne remontant plus au `JobRunner`.
 */
import { Logger } from '@nestjs/common';
import type { Clock } from '@gic/domain';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { fromBin } from '../../../../platform/kysely/uuid-columns.js';
import type { PushMessage, PushSendResult, PushTarget, WebPushSender } from './web-push.js';

const logger = new Logger('communication.push');

/** Fenêtre technique de reprise d'un envoi en échec (constante de protocole, pas un seuil métier). */
export const PUSH_RETRY_WINDOW_MINUTES = 60;
/**
 * Constantes techniques de protection de la voie courte du worker (pas des seuils métier) : délai d'un
 * envoi, nombre de points de terminaison muets tolérés par passe et budget de temps d'une passe, choisis
 * pour que le pire cas reste sous les 10 s de NFR-15 ; à confirmer à la mesure avec l'adaptateur réel
 * (AV-365).
 */
export const PUSH_SEND_TIMEOUT_MS = 3_000;
export const PUSH_MAX_TIMEOUTS_PER_PASS = 2;
export const PUSH_PASS_BUDGET_MS = 5_000;
const DEFAULT_BATCH = 100;

export interface PushDispatchResult {
  readonly examined: number;
  readonly delivered: number;
  readonly revoked: number;
}

export interface PushDispatchDeps {
  readonly clock: Clock;
  readonly sender: WebPushSender;
  /** Délai d'un envoi (essais) ; défaut `PUSH_SEND_TIMEOUT_MS`. */
  readonly sendTimeoutMs?: number;
  /** Points de terminaison muets tolérés avant l'arrêt de la passe (essais) ; défaut `PUSH_MAX_TIMEOUTS_PER_PASS`. */
  readonly maxTimeoutsPerPass?: number;
  /** Budget de temps réel d'une passe (essais) ; défaut `PUSH_PASS_BUDGET_MS`. */
  readonly passBudgetMs?: number;
}

/**
 * Un envoi qui ne lève jamais et ne dépasse jamais `timeoutMs` : l'exception de l'adaptateur et son silence
 * deviennent un résultat. Aucun message d'erreur ni point de terminaison n'est repris dans le motif (il
 * part au journal).
 */
async function sendGuarded(
  sender: WebPushSender,
  target: PushTarget,
  message: PushMessage,
  timeoutMs: number,
): Promise<{ readonly result: PushSendResult; readonly timedOut: boolean }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<'TIMEOUT'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('TIMEOUT');
    }, timeoutMs);
  });
  try {
    // `Promise.race` attache un gestionnaire aux deux promesses : un rejet tardif de `send` n'est pas
    // une promesse rejetée sans gestionnaire.
    const outcome = await Promise.race([
      sender.send(target, message, { signal: controller.signal }),
      expired,
    ]);
    if (outcome === 'TIMEOUT') {
      return { result: { status: 'FAILED', reason: 'TIMEOUT' }, timedOut: true };
    }
    return { result: outcome, timedOut: false };
  } catch (error) {
    // Le contrat du port veut que l'adaptateur rende `GONE` lui-même ; une bibliothèque qui rejette avec
    // un `statusCode` 404 ou 410 est reconnue ici pour ne pas laisser vivre un abonnement mort.
    const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
    if (statusCode === 404 || statusCode === 410) {
      return { result: { status: 'GONE' }, timedOut: false };
    }
    return {
      result: {
        status: 'FAILED',
        reason: `SENDER_ERROR:${error instanceof Error ? error.name : 'unknown'}`,
      },
      timedOut: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function dispatchPendingPushes(
  uow: UnitOfWork,
  deps: PushDispatchDeps,
  options: { readonly batch?: number } = {},
): Promise<PushDispatchResult> {
  if (!deps.sender.enabled) return { examined: 0, delivered: 0, revoked: 0 };
  const now = deps.clock.now();
  const since = new Date(now.getTime() - PUSH_RETRY_WINDOW_MINUTES * 60_000);
  const timeoutMs = deps.sendTimeoutMs ?? PUSH_SEND_TIMEOUT_MS;
  const maxTimeouts = deps.maxTimeoutsPerPass ?? PUSH_MAX_TIMEOUTS_PER_PASS;
  const budgetMs = deps.passBudgetMs ?? PUSH_PASS_BUDGET_MS;
  // Lecture sans verrou des candidates ; chaque ligne est verrouillée par clé primaire avant son envoi.
  const candidates = await uow
    .selectFrom('communication_notifications as n')
    .select(['n.id'])
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
    // NT-5 : sans abonnement vivant, la ligne ne peut pas partir et ne doit pas occuper de place du lot.
    // Garder alignés : notification-store.ts `usersWithActiveSubscription` et la recherche par ligne
    // ci-dessous (même triple jointure, mêmes filtres).
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('communication_push_subscriptions as s')
          .innerJoin('identity_devices as d', 'd.id', 's.device_id')
          .innerJoin('identity_users as u', 'u.id', 's.user_id')
          .select('s.id')
          .whereRef('s.user_id', '=', 'n.user_id')
          .where('s.revoked_at', 'is', null)
          .where('d.status', '=', 'ACTIVE')
          .where('u.status', '=', 'ACTIVE'),
      ),
    )
    .orderBy('n.created_at', 'asc')
    .limit(options.batch ?? DEFAULT_BATCH)
    .execute();

  const startedAt = Date.now();
  const expiredEndpoints = new Set<string>();
  let sends = 0;
  let interrupted = false;
  let delivered = 0;
  let revoked = 0;
  for (const candidate of candidates) {
    if (interrupted) break;
    // Verrou par clé primaire : la ligne est ignorée si un autre worker la tient ou si elle est livrée.
    const row = await uow
      .selectFrom('communication_notifications')
      .select(['user_id', 'title', 'body', 'link', 'alert_id', 'alert_type', 'delivered_at'])
      .where('id', '=', candidate.id)
      .forUpdate()
      .skipLocked()
      .executeTakeFirst();
    if (row === undefined || row.delivered_at !== null) continue;
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
      // Un point de terminaison muet n'est pas retenté dans la passe (un délai par passe, pas par ligne).
      if (expiredEndpoints.has(subscription.endpoint)) continue;
      // Au moins un envoi par passe (progression garantie) ; ensuite le budget de temps réel borne la passe
      // (`deps.clock` est figée en essai, d'où `Date.now()`).
      if (
        expiredEndpoints.size >= maxTimeouts ||
        (sends > 0 && Date.now() - startedAt >= budgetMs)
      ) {
        interrupted = true;
        break;
      }
      sends += 1;
      const { result, timedOut } = await sendGuarded(
        deps.sender,
        { endpoint: subscription.endpoint, p256dh: subscription.p256dh, auth: subscription.auth },
        {
          title: row.title,
          body: row.body,
          link: row.link,
          alertId: row.alert_id === null ? null : fromBin(row.alert_id),
          alertType: row.alert_type,
          tag: `alert:${row.alert_type ?? 'info'}`,
        },
        timeoutMs,
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
        if (timedOut) expiredEndpoints.add(subscription.endpoint);
      }
    }
    // Un abonnement déjà accepté compte, même si la passe est interrompue ensuite.
    if (accepted) {
      await uow
        .updateTable('communication_notifications')
        .set({ delivered_at: now })
        .where('id', '=', candidate.id)
        .where('delivered_at', 'is', null)
        .execute();
      delivered += 1;
    }
  }
  if (interrupted) {
    logger.warn(
      'Service de push sans réponse ou lent : passe interrompue, les lignes restantes sont reprises à la passe suivante.',
    );
  }
  return { examined: candidates.length, delivered, revoked };
}
