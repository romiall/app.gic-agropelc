/**
 * Consommateur `communication.alerts` (P9-04 ; ADR-060 §2, ADR-061 ; D13 §11 ; SM-ALERT) : transforme les
 * événements de déclenchement publiés par les modules propriétaires en alertes dédoublonnées, et résout
 * les alertes d'état quand leur condition disparaît.
 *
 * - **Au moins une fois** : seuls les événements du catalogue des déclencheurs sont marqués
 *   (`platform_event_consumer_marks`, première instruction) ; un événement rejoué ne change plus rien.
 * - **Règle** : une règle absente ou désactivée n'empêche pas l'événement d'être publié, elle empêche
 *   l'alerte (ADR-061 §8). Une résolution, elle, s'applique toujours (condition disparue).
 * - **Marqueur de passe** : n'est traité que complet et par identité de passe (ADR-061 §3).
 * - **`critical_since`** : instant du traitement par le serveur, non la date du fait (NT-3, AV-466).
 * - Aucune lecture des tables d'un autre module : tout ce qu'il faut est dans l'événement.
 */
import { Logger } from '@nestjs/common';
import {
  alertFromEvent,
  isAlertTriggerEvent,
  type AlertAction,
  type AlertEventPayload,
  type Clock,
  type IdGenerator,
} from '@gic/domain';
import type { DomainEvent } from '../../../../platform/events/domain-event.js';
import type { EventConsumerRegistry } from '../../../../platform/events/event-consumer-registry.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';
import {
  loadAlertRule,
  raiseAlert,
  resolveByCondition,
  resolveByPass,
  type AlertRule,
  type RaiseOutcome,
} from '../alerts/alert-store.js';

export const ALERTS_CONSUMER_NAME = 'communication.alerts';

const logger = new Logger('communication.alerts');

/**
 * Suite d'une levée (destinataires, notifications) : `createAlertNotifier` (P9-05). Appelée dans la
 * transaction du consommateur, après l'écriture de l'alerte, donc sous son verrou (rang N10b).
 */
export type AfterRaise = (
  uow: UnitOfWork,
  input: {
    readonly outcome: RaiseOutcome;
    readonly action: Extract<AlertAction, { kind: 'RAISE' }>;
    readonly event: DomainEvent;
    readonly rule: AlertRule;
  },
) => Promise<void>;

export interface AlertsConsumerOptions {
  readonly idGenerator: IdGenerator;
  /**
   * Horloge du serveur : fournit l'instant du traitement, point de départ du délai d'escalade
   * (`critical_since`, NT-3, AV-466). Absente (essais), `critical_since` retombe sur la date de
   * l'événement. Ne pas la fournir dans les essais qui valident des alertes critiques dans la base
   * partagée (pollution de l'escalade, suivi P9 §4) : elles deviendraient échues 4 h plus tard.
   */
  readonly clock?: Clock;
  readonly afterRaise?: AfterRaise;
}

const isRecord = (value: unknown): value is AlertEventPayload =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Marque l'événement traité ; faux s'il l'était déjà (redélivrance). */
async function markProcessed(uow: UnitOfWork, eventId: string): Promise<boolean> {
  const result = await uow
    .insertInto('platform_event_consumer_marks')
    .values({ consumer_name: ALERTS_CONSUMER_NAME, event_id: toBin(eventId) })
    .ignore()
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
}

export async function handleAlertEvent(
  uow: UnitOfWork,
  event: DomainEvent,
  options: AlertsConsumerOptions,
): Promise<void> {
  if (!isAlertTriggerEvent(event.eventType)) return;
  if (!(await markProcessed(uow, event.eventId))) return;

  const { actions, issues } = alertFromEvent({
    eventId: event.eventId,
    eventType: event.eventType,
    aggregateId: event.aggregateId,
    occurredAt: event.occurredAt,
    payload: isRecord(event.payload) ? event.payload : {},
  });
  for (const issue of issues) {
    logger.warn(
      `${issue.code} : ${issue.message} (événement ${event.eventType} #${event.seq}, type ${
        issue.alertType ?? 'n/a'
      })`,
    );
  }
  const deps = { idGenerator: options.idGenerator };
  // Instant du traitement (horloge du serveur) : `critical_since` n'est pas la date du fait.
  const processedAt = options.clock?.now() ?? event.occurredAt;
  for (const action of actions) {
    switch (action.kind) {
      case 'RAISE': {
        const rule = await loadAlertRule(uow, action.alertType);
        if (rule === undefined || !rule.enabled) break;
        const outcome = await raiseAlert(uow, deps, action, rule, event.eventId, processedAt);
        if (options.afterRaise !== undefined) {
          await options.afterRaise(uow, { outcome, action, event, rule });
        }
        break;
      }
      case 'RESOLVE':
        await resolveByCondition(uow, deps, action, event.eventId);
        break;
      case 'PASS_COMPLETED':
        await resolveByPass(uow, deps, action, event.eventId);
        break;
    }
  }
}

export function registerAlertsConsumer(
  registry: EventConsumerRegistry,
  options: AlertsConsumerOptions & { readonly clock: Clock },
): void {
  registry.register(ALERTS_CONSUMER_NAME, (uow, event: DomainEvent) =>
    handleAlertEvent(uow, event, options),
  );
}
