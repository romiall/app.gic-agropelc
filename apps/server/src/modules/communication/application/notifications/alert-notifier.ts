/**
 * Destinataires et notifications d'une alerte levée (P9-05 ; ADR-072 §1, §4, §6, §9 ; BR-NOT-001, 004,
 * 008 ; AV-413, AV-416, AV-440). Branché sur le consommateur `communication.alerts` (`afterRaise`), dans
 * sa transaction, **sous le verrou de la ligne d'alerte** (rang N10b, ADR-038).
 *
 * - À la **création** : les destinataires sont calculés et inscrits ; tous sont notifiés.
 * - Au **relèvement en `CRITICAL`** d'une alerte ouverte : les destinataires manquants sont ajoutés, tous
 *   ceux qui sont encore actifs sont notifiés (le message change de gravité).
 * - Les destinataires sont jugés à l'instant du **traitement**, non à celui de l'événement : une alerte
 *   ouverte s'adresse à ceux qui peuvent agir maintenant (BR-NOT-001), et l'événement est consommé en
 *   quelques secondes (ADR-072 §1, révision P9-05).
 * - À une **occurrence ordinaire** : seuls les destinataires nouvellement ajoutés sont notifiés ; on
 *   n'en retire jamais, et une occurrence répétée ne répète pas la notification.
 * - Le texte est **rendu pour chaque destinataire** : une valeur au coût n'y figure que s'il détient
 *   `inventory.valuation.read` sur le site de l'alerte (AV-440).
 */
import {
  DEFAULT_PUSH_GROUP_MINUTES,
  alertCarriesProtectedValue,
  escalationTitle,
  groupedPushBody,
  notificationChannelsFor,
  pushGroupDecision,
  recipientsToAdd,
  renderAlertMessage,
  type AlertEventPayload,
  type AlertSeverity,
  type AlertType,
  type Clock,
  type IdGenerator,
  type RecipientCandidate,
} from '@gic/domain';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { evaluateAccess } from '../../../identity/application/public/index.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';
import type { AfterRaise } from '../events/alerts-consumer.js';
import { recordAlertChanges } from '../sync-changes.js';
import type { AlertRecipientResolver } from '../recipients/recipient-resolver.js';
import { resolveAlertRecipients } from '../recipients/resolve-recipients.js';
import {
  countSuppressedAlertPushes,
  insertNotification,
  lastAlertPushAt,
  usersWithActiveSubscription,
} from './notification-store.js';
import type { WebPushSender } from './web-push.js';

const VALUATION_PERMISSION = 'inventory.valuation.read';
export const PUSH_GROUP_MINUTES_KEY = 'communication.push_group_minutes';

export interface AlertNotifierDeps {
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly resolver: AlertRecipientResolver;
  readonly push: Pick<WebPushSender, 'enabled'>;
}

/** Destinataires déjà inscrits à l'alerte. */
export async function recipientIdsOf(uow: UnitOfWork, alertId: string): Promise<readonly string[]> {
  const rows = await uow
    .selectFrom('communication_alert_recipients')
    .select('user_id')
    .where('alert_id', '=', toBin(alertId))
    .execute();
  return rows.map((row) => fromBin(row.user_id));
}

/** Inscrit des destinataires (ajout seul ; un utilisateur déjà inscrit est ignoré). */
export async function addRecipients(
  uow: UnitOfWork,
  alertId: string,
  recipients: readonly RecipientCandidate[],
  at: Date,
): Promise<void> {
  for (const recipient of recipients) {
    await uow
      .insertInto('communication_alert_recipients')
      .values({
        alert_id: toBin(alertId),
        user_id: toBin(recipient.userId),
        origin: recipient.origin,
        role_code: recipient.roleCode,
        added_at: at,
      })
      .ignore()
      .execute();
  }
  // Jeu hors ligne `comms` : l'alerte entre dans la boîte des destinataires ajoutés.
  await recordAlertChanges(
    uow,
    alertId,
    'UPSERT',
    recipients.map((recipient) => recipient.userId),
  );
}

async function pushGroupMinutes(uow: UnitOfWork, at: Date): Promise<number> {
  const value = await currentSettingValue(uow, {
    key: PUSH_GROUP_MINUTES_KEY,
    scopeType: 'GLOBAL',
    scopeId: null,
    at,
  });
  const minutes = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_PUSH_GROUP_MINUTES;
}

export interface AlertNotificationInput {
  readonly alertId: string;
  readonly alertType: AlertType;
  readonly severity: AlertSeverity;
  readonly payload: AlertEventPayload;
  readonly siteId: string | null;
  readonly zoneId: string | null;
  readonly userIds: readonly string[];
  /** Événement à l'origine : levée, relèvement ou escalade (clé d'idempotence). */
  readonly sourceEventId: string;
  readonly escalated: boolean;
  readonly now: Date;
}

export interface AlertNotificationResult {
  readonly inApp: number;
  readonly push: number;
  readonly pushSuppressed: number;
}

/**
 * Écrit les notifications d'une alerte pour ces utilisateurs : `IN_APP` pour `WARNING` et `CRITICAL`,
 * `WEB_PUSH` pour `CRITICAL` seulement, regroupé par (utilisateur, type) sur le créneau de D13 §14 — sauf
 * l'escalade, qui est un autre message et n'est jamais regroupée.
 */
export async function notifyAlertUsers(
  uow: UnitOfWork,
  deps: AlertNotifierDeps,
  input: AlertNotificationInput,
): Promise<AlertNotificationResult> {
  const channels = notificationChannelsFor(input.severity);
  if (channels.length === 0 || input.userIds.length === 0) {
    return { inApp: 0, push: 0, pushSuppressed: 0 };
  }
  const wantsPush = channels.includes('WEB_PUSH') && deps.push.enabled;
  const subscribed = wantsPush
    ? await usersWithActiveSubscription(uow, input.userIds)
    : new Set<string>();
  const groupMinutes = wantsPush && !input.escalated ? await pushGroupMinutes(uow, input.now) : 0;
  const carriesProtected = alertCarriesProtectedValue(input.alertType, input.payload);
  const sourceType = input.escalated ? 'ALERT_ESCALATION' : 'ALERT';

  let inApp = 0;
  let push = 0;
  let pushSuppressed = 0;
  for (const userId of input.userIds) {
    let showProtected = false;
    if (carriesProtected) {
      const access = await evaluateAccess(uow, {
        userId,
        permissionCode: VALUATION_PERMISSION,
        occurredAt: input.now,
        resource: {
          ...(input.siteId !== null ? { siteId: input.siteId } : {}),
          ...(input.zoneId !== null ? { zoneId: input.zoneId } : {}),
        },
      });
      showProtected = access.allowed;
    }
    const rendered = renderAlertMessage(input.alertType, input.payload, { showProtected });
    const title = input.escalated ? escalationTitle(rendered.title) : rendered.title;
    const common = {
      userId,
      kind: 'ALERT' as const,
      alertId: input.alertId,
      alertType: input.alertType,
      sourceType,
      sourceId: input.alertId,
      sourceEventId: input.sourceEventId,
      title,
      link: null,
      createdAt: input.now,
    };

    if (channels.includes('IN_APP')) {
      const inserted = await insertNotification(uow, deps.idGenerator, {
        ...common,
        channel: 'IN_APP',
        body: rendered.message,
        deliveredAt: input.now,
      });
      if (inserted) inApp += 1;
    }

    if (wantsPush && subscribed.has(userId)) {
      let body = rendered.message;
      if (!input.escalated) {
        const last = await lastAlertPushAt(uow, userId, input.alertType);
        const decision = pushGroupDecision({
          lastPushAt: last,
          now: input.now,
          groupMinutes,
        });
        if (!decision.send) {
          pushSuppressed += 1;
          continue;
        }
        if (last !== null) {
          body = groupedPushBody(
            body,
            await countSuppressedAlertPushes(uow, userId, input.alertType, last, input.alertId),
          );
        }
      }
      const inserted = await insertNotification(uow, deps.idGenerator, {
        ...common,
        channel: 'WEB_PUSH',
        body,
      });
      if (inserted) push += 1;
    }
  }
  return { inApp, push, pushSuppressed };
}

/**
 * Hook `afterRaise` du consommateur d'alertes : destinataires, puis notifications (voir l'en-tête).
 */
export function createAlertNotifier(deps: AlertNotifierDeps): AfterRaise {
  return async (uow, { outcome, action, event, rule }) => {
    const now = deps.clock.now();
    const plan = await resolveAlertRecipients(uow, deps.resolver, { action, rule, at: now });
    const existing = await recipientIdsOf(uow, outcome.alertId);
    const added = recipientsToAdd(plan.recipients, new Set(existing));
    await addRecipients(uow, outcome.alertId, added, now);

    const notifyAll = outcome.created || outcome.raisedToCritical;
    // Les lignes de la table restent (ajout seul) mais un destinataire devenu inactif n'est pas notifié.
    const userIds = notifyAll
      ? [
          ...new Set([
            ...(await deps.resolver.activeUsersAmong(uow, existing, now)),
            ...added.map((recipient) => recipient.userId),
          ]),
        ]
      : added.map((recipient) => recipient.userId);
    await notifyAlertUsers(uow, deps, {
      alertId: outcome.alertId,
      alertType: action.alertType,
      severity: outcome.severity,
      payload: action.payload,
      siteId: action.siteId,
      zoneId: action.zoneId,
      userIds,
      sourceEventId: event.eventId,
      escalated: false,
      now,
    });
  };
}
