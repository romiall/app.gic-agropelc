/**
 * Commandes d'alerte (P9-04 ; SM-ALERT ; UC-NOT-02 et 04 ; ADR-061 §9, ADR-062 §8 ; AV-354, AV-368) :
 * `communication.alert.acknowledge` (hors ligne possible), `.resolve`, `.dismiss`, et
 * `communication.alert_rule.set` (en ligne).
 *
 * - **Accès** : le destinataire de l'alerte (sa boîte) ou le titulaire de `comm.alert.manage` dont la portée
 *   couvre l'alerte (site, zone, propriétaire) ; hors des deux, `NOT_FOUND` (existence opaque, RC-07).
 * - **Fait accompli** : une prise en compte d'une alerte déjà prise en compte, résolue ou écartée est
 *   appliquée sans effet, jamais rejetée (BR-SYN-007).
 * - **Règles de transition** : `applyAlertCommand` (domaine), partagé avec l'appareil.
 * - La ligne d'alerte est verrouillée en premier (rang N10b, ADR-038).
 */
import {
  ALERT_CATALOG,
  alertDefinitionOf,
  applyAlertCommand,
  type AlertCommand,
  type AlertType,
  type IdGenerator,
} from '@gic/domain';
import {
  alertAcknowledgePayloadSchema,
  alertDismissPayloadSchema,
  alertResolvePayloadSchema,
  alertRuleSetPayloadSchema,
  type AlertAcknowledgePayload,
  type AlertDismissPayload,
  type AlertResolvePayload,
  type AlertRuleSetPayload,
} from '@gic/contracts';
import { sql } from 'kysely';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { jsonValue } from '../../../../platform/kysely/json-value.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';
import { evaluateAccess } from '../../../identity/application/public/index.js';
import {
  lockAlert,
  markAcknowledged,
  markClosedManually,
  type LockedAlert,
  type WriteDeps,
} from '../alerts/alert-store.js';

const MANAGE_PERMISSION = 'comm.alert.manage';
const RULE_PERMISSION = 'comm.alert_rule.manage';

const rejected = (errorCode: string, messageFr: string): CommandHandlerOutcome => ({
  status: 'REJECTED',
  errorCode,
  messageFr,
});

const notFound = rejected('NOT_FOUND', 'Alerte introuvable.');

/** Destinataire de l'alerte, ou portée de `comm.alert.manage` qui la couvre (ADR-062 §3). */
async function canActOn(
  uow: UnitOfWork,
  alert: LockedAlert,
  userId: string,
  at: Date,
): Promise<boolean> {
  const recipient = await uow
    .selectFrom('communication_alert_recipients')
    .select('user_id')
    .where('alert_id', '=', toBin(alert.id))
    .where('user_id', '=', toBin(userId))
    .executeTakeFirst();
  if (recipient) return true;
  const access = await evaluateAccess(uow, {
    userId,
    permissionCode: MANAGE_PERMISSION,
    occurredAt: at,
    resource: {
      ...(alert.siteId !== null ? { siteId: alert.siteId } : {}),
      ...(alert.zoneId !== null ? { zoneId: alert.zoneId } : {}),
      ...(alert.ownerUserId !== null ? { ownerUserId: alert.ownerUserId } : {}),
    },
  });
  return access.allowed;
}

function alertTransition<P>(
  deps: WriteDeps,
  command: Exclude<AlertCommand, 'AUTO_RESOLVE'>,
  textOf: (payload: P) => string | undefined,
): CommandHandler<P> {
  return async (uow, envelope) => {
    const alert = await lockAlert(uow, envelope.aggregate_id);
    if (!alert) return notFound;
    const at = new Date(envelope.occurred_at);
    if (!(await canActOn(uow, alert, envelope.author_user_id, at))) return notFound;

    const text = textOf(envelope.payload);
    const transition = applyAlertCommand({
      status: alert.status,
      command,
      definition: alertDefinitionOf(alert.alertType),
      text,
    });
    if (!transition.ok) return rejected(transition.code, transition.message);
    if (!transition.changed) {
      // Fait accompli (BR-SYN-007) : sans effet, résultat explicite.
      return {
        status: 'APPLIED',
        serverRefs: { changed: 'false', reason: transition.reason, status: transition.status },
      };
    }
    // Une prise en compte jugée à son instant de fait, sans antériorité à la première détection.
    const effectiveAt = at.getTime() < alert.firstDetectedAt.getTime() ? alert.firstDetectedAt : at;
    if (command === 'ACKNOWLEDGE') {
      await markAcknowledged(uow, deps, alert, {
        userId: envelope.author_user_id,
        at: effectiveAt,
        commandId: envelope.command_id,
      });
    } else {
      await markClosedManually(uow, deps, alert, {
        kind: command === 'DISMISS' ? 'DISMISSED' : 'MANUAL',
        userId: envelope.author_user_id,
        at: effectiveAt,
        comment: text ?? '',
        commandId: envelope.command_id,
      });
    }
    return {
      status: 'APPLIED',
      serverRefs: { changed: 'true', status: transition.status },
      audit: { before: { status: alert.status }, after: { status: transition.status, text } },
    };
  };
}

// --- Règles d'alerte ---------------------------------------------------------------------------------------

const setRule: CommandHandler<AlertRuleSetPayload> = async (uow, envelope) => {
  if (envelope.captured_offline) {
    return rejected('ONLINE_REQUIRED', "Les règles d'alerte se gèrent en ligne.");
  }
  const payload = envelope.payload;
  const definition = ALERT_CATALOG[payload.alertType as AlertType];
  const row = await uow
    .selectFrom('communication_alert_rules')
    .selectAll()
    .where('alert_type', '=', payload.alertType)
    .forUpdate()
    .executeTakeFirst();
  if (!row) return rejected('NOT_FOUND', "Règle d'alerte introuvable.");

  if (payload.severity !== undefined && !definition.severities.includes(payload.severity)) {
    return rejected(
      'ALERT_SEVERITY_NOT_ADMITTED',
      `${payload.alertType} n'admet pas la gravité ${payload.severity}.`,
    );
  }
  const resolution = payload.resolutionMode ?? (row.resolution_mode as 'AUTO' | 'MANUAL');
  // Une alerte d'état se résout seule (BR-NOT-003) : sa résolution ne devient pas manuelle.
  if (definition.nature === 'STATE' && resolution === 'MANUAL') {
    return rejected(
      'ALERT_RESOLUTION_NOT_ADMITTED',
      `${payload.alertType} est une alerte d'état : sa résolution est automatique.`,
    );
  }
  if (payload.escalationHours !== undefined && payload.escalationHours !== null) {
    if (!definition.severities.includes('CRITICAL')) {
      return rejected(
        'ALERT_ESCALATION_NOT_APPLICABLE',
        `${payload.alertType} n'est jamais critique : pas d'escalade.`,
      );
    }
  }

  const changes: Record<string, unknown> = {};
  if (payload.enabled !== undefined) changes['enabled'] = payload.enabled ? 1 : 0;
  if (payload.severity !== undefined) changes['severity'] = payload.severity;
  if (payload.resolutionMode !== undefined) changes['resolution_mode'] = payload.resolutionMode;
  if (payload.escalationHours !== undefined) changes['escalation_hours'] = payload.escalationHours;
  if (payload.recipientRoles !== undefined) {
    changes['recipient_roles'] = jsonValue(payload.recipientRoles);
  }
  if (payload.escalationRoles !== undefined) {
    changes['escalation_roles'] = jsonValue(payload.escalationRoles);
  }
  await uow
    .updateTable('communication_alert_rules')
    .set({
      ...changes,
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('alert_type', '=', payload.alertType)
    .execute();
  return {
    status: 'APPLIED',
    serverRefs: { alertType: payload.alertType },
    audit: {
      before: {
        enabled: Boolean(row.enabled),
        severity: row.severity,
        resolutionMode: row.resolution_mode,
        escalationHours: row.escalation_hours,
        recipientRoles: row.recipient_roles,
        escalationRoles: row.escalation_roles,
      },
      after: payload,
    },
  };
};

export function registerAlertCommands(
  registry: CommandHandlerRegistry,
  idGenerator: IdGenerator,
): void {
  const deps: WriteDeps = { idGenerator };
  registry.register<AlertAcknowledgePayload>({
    commandType: 'communication.alert.acknowledge',
    version: 1,
    payloadSchema: alertAcknowledgePayloadSchema,
    permissionCode: MANAGE_PERMISSION,
    handler: alertTransition<AlertAcknowledgePayload>(deps, 'ACKNOWLEDGE', (p) => p.comment),
  });
  registry.register<AlertResolvePayload>({
    commandType: 'communication.alert.resolve',
    version: 1,
    payloadSchema: alertResolvePayloadSchema,
    permissionCode: MANAGE_PERMISSION,
    handler: alertTransition<AlertResolvePayload>(deps, 'RESOLVE', (p) => p.comment),
  });
  registry.register<AlertDismissPayload>({
    commandType: 'communication.alert.dismiss',
    version: 1,
    payloadSchema: alertDismissPayloadSchema,
    permissionCode: MANAGE_PERMISSION,
    handler: alertTransition<AlertDismissPayload>(deps, 'DISMISS', (p) => p.reason),
  });
  registry.register<AlertRuleSetPayload>({
    commandType: 'communication.alert_rule.set',
    version: 1,
    payloadSchema: alertRuleSetPayloadSchema,
    permissionCode: RULE_PERMISSION,
    handler: setRule,
  });
}
