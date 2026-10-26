/**
 * Escalade des alertes critiques non prises en compte (P9-05 ; BR-NOT-005, SM-ALERT ; ADR-072 §7 ;
 * AV-417). Tâche `communication.alerts.escalate` : une alerte `CRITICAL` encore `OPEN` dont
 * `critical_since + escalation_hours` est passé reçoit, **une seule fois**, un niveau de destinataires
 * supérieur (rôles `escalation_roles` de la règle, origine `ESCALATION`), des notifications d'escalade
 * jamais regroupées et l'événement `AlertEscalated`.
 *
 * - L'échéance se mesure depuis `critical_since` (la levée ou le relèvement en `CRITICAL`), pas depuis
 *   la première détection.
 * - Une prise en compte appliquée avant l'escalade l'arrête ; jugée à l'état serveur au moment de son
 *   application, une prise en compte hors ligne arrivée après n'a aucun effet sur elle (AV-417).
 * - **L'escalade n'est consommée qu'une fois ses destinataires connus** : sans titulaire actif du niveau
 *   supérieur dans le périmètre, rien n'est posé et l'alerte reste candidate au passage suivant (un
 *   titulaire affecté plus tard est alerté). Une erreur imprévue sur une alerte annule ses écritures
 *   (point de sauvegarde) sans bloquer les autres.
 * - La ligne est verrouillée (rang N10b) et l'`UPDATE` est conditionnel : deux passes concurrentes
 *   n'escaladent pas deux fois. Les alertes sont traitées par identifiant croissant, l'ordre de verrous
 *   de `resolveByPass` : pas d'interblocage croisé.
 * - Une règle sans `escalation_hours`, ou désactivée, n'escalade pas (elle n'est pas candidate).
 */
import { Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { isEscalationDue } from '@gic/domain';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import {
  listEscalationCandidateIds,
  loadAlertRule,
  lockAlertForEscalation,
  markEscalated,
} from './alert-store.js';
import {
  addRecipients,
  notifyAlertUsers,
  recipientIdsOf,
  type AlertNotifierDeps,
} from '../notifications/alert-notifier.js';
import { resolveEscalationRecipients } from '../recipients/resolve-recipients.js';

const logger = new Logger('communication.escalation');

const BATCH = 200;
/** Plafond de lots par passage : borne la durée d'une passe, le reste est repris au passage suivant. */
const MAX_BATCHES = 10;

export interface EscalationRunResult {
  readonly examined: number;
  readonly escalated: number;
  /** Alertes échues sans aucun destinataire de niveau supérieur : reprises au passage suivant. */
  readonly withoutAudience: number;
}

/** Interblocage et attente de verrou : la transaction est perdue, on la laisse remonter (reprise). */
function isTransactionLost(error: unknown): boolean {
  const errno = (error as { errno?: number } | null)?.errno;
  return errno === 1213 || errno === 1205;
}

type AlertOutcome = 'ESCALATED' | 'SKIPPED' | 'WITHOUT_AUDIENCE';

async function escalateOne(
  uow: UnitOfWork,
  deps: AlertNotifierDeps,
  id: string,
  now: Date,
): Promise<AlertOutcome> {
  const alert = await lockAlertForEscalation(uow, id);
  const rule = alert ? await loadAlertRule(uow, alert.alertType) : undefined;
  if (!alert || !rule || !rule.enabled || rule.escalationHours === null) return 'SKIPPED';
  const due = isEscalationDue(
    {
      status: alert.status,
      severity: alert.severity,
      criticalSince: alert.criticalSince,
      escalatedAt: alert.escalatedAt,
    },
    rule.escalationHours,
    now,
  );
  if (!due) return 'SKIPPED';

  const recipients = await resolveEscalationRecipients(uow, deps.resolver, {
    rule,
    perimeter: {
      siteId: alert.siteId,
      zoneId: alert.zoneId,
      ownerUserIds: alert.ownerUserId === null ? [] : [alert.ownerUserId],
    },
    at: now,
  });
  if (recipients.length === 0) {
    logger.warn(
      `Alerte ${id} (${alert.alertType}) échue sans destinataire de niveau supérieur : reprise au prochain passage.`,
    );
    return 'WITHOUT_AUDIENCE';
  }
  const eventId = await markEscalated(uow, deps, alert, now, recipients.length);
  if (eventId === null) return 'SKIPPED';

  const existing = new Set(await recipientIdsOf(uow, alert.id));
  await addRecipients(
    uow,
    alert.id,
    recipients.filter((recipient) => !existing.has(recipient.userId)),
    now,
  );
  await notifyAlertUsers(uow, deps, {
    alertId: alert.id,
    alertType: alert.alertType,
    severity: 'CRITICAL',
    payload: alert.payload,
    siteId: alert.siteId,
    zoneId: alert.zoneId,
    userIds: recipients.map((recipient) => recipient.userId),
    sourceEventId: eventId,
    escalated: true,
    now,
  });
  return 'ESCALATED';
}

export async function escalateDueAlerts(
  uow: UnitOfWork,
  deps: AlertNotifierDeps,
  options: { readonly batchSize?: number } = {},
): Promise<EscalationRunResult> {
  const now = deps.clock.now();
  const batchSize = options.batchSize ?? BATCH;
  let examined = 0;
  let escalated = 0;
  let withoutAudience = 0;
  let after: string | null = null;

  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const ids = await listEscalationCandidateIds(uow, { now, after, limit: batchSize });
    if (ids.length === 0) break;
    after = ids[ids.length - 1]!;
    examined += ids.length;

    for (const id of ids) {
      // Un point de sauvegarde par alerte : une erreur imprévue annule ses écritures (dont la pose de
      // `escalated_at`) sans perdre celles des autres.
      const savepoint = sql.id(`escalate_${id.replace(/-/g, '')}`);
      await sql`SAVEPOINT ${savepoint}`.execute(uow);
      try {
        const outcome = await escalateOne(uow, deps, id, now);
        if (outcome === 'ESCALATED') escalated += 1;
        if (outcome === 'WITHOUT_AUDIENCE') withoutAudience += 1;
        await sql`RELEASE SAVEPOINT ${savepoint}`.execute(uow);
      } catch (error) {
        if (isTransactionLost(error)) throw error;
        await sql`ROLLBACK TO SAVEPOINT ${savepoint}`.execute(uow);
        await sql`RELEASE SAVEPOINT ${savepoint}`.execute(uow);
        logger.error(
          `Escalade de l'alerte ${id} impossible : ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (ids.length < batchSize) break;
  }
  return { examined, escalated, withoutAudience };
}
