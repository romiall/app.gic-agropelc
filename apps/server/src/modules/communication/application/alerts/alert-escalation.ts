/**
 * Escalade des alertes critiques non prises en compte (P9-05 ; BR-NOT-005, SM-ALERT ; ADR-062 §7 ;
 * AV-367). Tâche `communication.alerts.escalate` : une alerte `CRITICAL` encore `OPEN` dont
 * `critical_since + escalation_hours` est passé reçoit, **une seule fois**, un niveau de destinataires
 * supérieur (rôles `escalation_roles` de la règle, origine `ESCALATION`), des notifications d'escalade
 * jamais regroupées et l'événement `AlertEscalated`.
 *
 * - L'échéance se mesure depuis `critical_since` (l'instant où le serveur lève ou relève l'alerte en
 *   `CRITICAL`, non la date du fait : AV-466, NT-3), pas depuis la première détection.
 * - Une prise en compte appliquée avant l'escalade l'arrête ; jugée à l'état serveur au moment de son
 *   application, une prise en compte hors ligne arrivée après n'a aucun effet sur elle (AV-367).
 * - **L'escalade n'est consommée qu'une fois ses destinataires connus** : sans titulaire actif du niveau
 *   supérieur dans le périmètre, rien n'est posé et l'alerte reste candidate au passage suivant (un
 *   titulaire affecté plus tard est alerté). Une erreur imprévue sur une alerte annule ses écritures
 *   (point de sauvegarde) sans bloquer les autres.
 * - La ligne est verrouillée (rang N10b) et l'`UPDATE` est conditionnel : deux passes concurrentes
 *   n'escaladent pas deux fois. Les alertes sont traitées par identifiant croissant, l'ordre de verrous
 *   de `resolveByPass` : pas d'interblocage croisé.
 * - Une règle sans `escalation_hours`, ou désactivée, n'escalade pas (elle n'est pas candidate).
 * - **Reprise** : dans la passe, les candidates sont lues par lots d'identifiant croissant ; entre les
 *   passes, `nextCursor` (dernier identifiant examiné quand la passe s'est arrêtée au plafond de lots,
 *   `null` quand la liste est épuisée) est gardé en mémoire par la tâche et la passe suivante reprend après
 *   lui, pour atteindre au-delà du plafond des candidates qui ne peuvent pas être escaladées (NT-7).
 *   Une alerte d'identifiant inférieur au curseur devenue échue attend le retour au début du cycle.
 * - **Sans destinataire de niveau supérieur** : les alertes concernées sont comptées par type et signalées
 *   par un seul avertissement par passe (NT-7), non un par alerte.
 */
import { Logger } from '@nestjs/common';
import { sql } from 'kysely';
import { isEscalationDue, type AlertType } from '@gic/domain';
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
  /**
   * Dernier identifiant examiné quand la passe s'est arrêtée au plafond de lots ; `null` quand la liste
   * des candidates a été lue jusqu'au bout. À repasser en `after` à la passe suivante (NT-7).
   */
  readonly nextCursor: string | null;
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
  missing: Map<AlertType, number>,
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
    // Comptée par type, signalée une seule fois en fin de passe (NT-7).
    missing.set(alert.alertType, (missing.get(alert.alertType) ?? 0) + 1);
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
  options: {
    readonly batchSize?: number;
    readonly maxBatches?: number;
    /** Curseur de la passe précédente (`nextCursor`) : la lecture reprend après cet identifiant. */
    readonly after?: string | null;
  } = {},
): Promise<EscalationRunResult> {
  const now = deps.clock.now();
  const batchSize = options.batchSize ?? BATCH;
  const maxBatches = options.maxBatches ?? MAX_BATCHES;
  let examined = 0;
  let escalated = 0;
  let withoutAudience = 0;
  let after: string | null = options.after ?? null;
  let exhausted = false;
  const missing = new Map<AlertType, number>();

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const ids = await listEscalationCandidateIds(uow, { now, after, limit: batchSize });
    if (ids.length === 0) {
      // Fin de liste atteinte dès le premier lot d'une passe reprise : repartir du début dans la même
      // passe, pour qu'aucun tour ne soit perdu.
      if (batch === 0 && after !== null) {
        after = null;
        continue;
      }
      exhausted = true;
      break;
    }
    after = ids[ids.length - 1]!;
    examined += ids.length;

    for (const id of ids) {
      // Un point de sauvegarde par alerte : une erreur imprévue annule ses écritures (dont la pose de
      // `escalated_at`) sans perdre celles des autres.
      const savepoint = sql.id(`escalate_${id.replace(/-/g, '')}`);
      await sql`SAVEPOINT ${savepoint}`.execute(uow);
      try {
        const outcome = await escalateOne(uow, deps, id, now, missing);
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
    if (ids.length < batchSize) {
      exhausted = true;
      break;
    }
  }
  if (withoutAudience > 0) {
    const detail = [...missing].map(([type, count]) => `${type} ×${count}`).join(', ');
    logger.warn(
      `${withoutAudience} alerte(s) critique(s) échue(s) sans destinataire de niveau supérieur (${detail}) : reprises aux passages suivants ; vérifier les rôles d'escalade des règles.`,
    );
  }
  return { examined, escalated, withoutAudience, nextCursor: exhausted ? null : after };
}
