/**
 * Écriture des alertes (P9-04 ; ADR-061 §4, §6, §7, §9, §10 ; SM-ALERT ; INV-NOT-01). Fonctions de la
 * couche d'application, appelées dans la transaction du consommateur `communication.alerts` ou d'une
 * commande `communication.alert.*`. La ligne d'alerte est verrouillée (`FOR UPDATE`, rang N10b de
 * l'ADR-038) avant toute lecture qui décide d'une écriture.
 *
 * - **Levée** : une alerte ouverte par (type, sujet) ; une nouvelle occurrence met à jour l'alerte
 *   ouverte (compteur, dernière occurrence, charge utile, gravité relevée), jamais n'en crée une autre.
 *   `critical_since` (départ du délai d'escalade) est l'instant où le serveur lève ou relève l'alerte en
 *   CRITICAL, non la date du fait (NT-3).
 * - **Résolution** : par condition disparue (événement), par passe complète (marqueur) ou à la main.
 * - Les événements `AlertRaised` et `AlertResolved` sont publiés dans la même transaction.
 */
import { sql } from 'kysely';
import {
  alertDefinitionOf,
  alertsResolvedByPass,
  raisedSeverity,
  renderAlertMessage,
  type AlertPassCompletedAction,
  type AlertRaiseAction,
  type AlertResolveAction,
  type AlertSeverity,
  type AlertStatus,
  type AlertType,
  type IdGenerator,
} from '@gic/domain';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { jsonValue } from '../../../../platform/kysely/json-value.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { codeEntityId } from '../../../../platform/sync/code-entity-id.js';
import { recordAlertChanges } from '../sync-changes.js';

/** Nom du type d'entité de la clé de sujet composite (UUID version 5, ADR-061 §5). */
export const ALERT_SUBJECT_ENTITY = 'ALERT_SUBJECT';

export interface AlertRule {
  readonly alertType: AlertType;
  readonly enabled: boolean;
  readonly severity: AlertSeverity;
  readonly recipientRoles: readonly string[];
  readonly resolutionMode: 'AUTO' | 'MANUAL';
  readonly escalationHours: number | null;
  readonly escalationRoles: readonly string[];
}

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** Règle d'un type ; `undefined` si elle n'est pas semée (type ajouté sans migration de données). */
export async function loadAlertRule(
  uow: UnitOfWork,
  alertType: AlertType,
): Promise<AlertRule | undefined> {
  const row = await uow
    .selectFrom('communication_alert_rules')
    .selectAll()
    .where('alert_type', '=', alertType)
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    alertType,
    enabled: Boolean(row.enabled),
    severity: row.severity as AlertSeverity,
    recipientRoles: stringArray(row.recipient_roles),
    // Le mode effectif est celui du catalogue : la colonne n'est qu'affichée, elle n'est pas réglable (AV-464).
    resolutionMode: alertDefinitionOf(alertType).resolution,
    escalationHours: row.escalation_hours,
    escalationRoles: stringArray(row.escalation_roles),
  };
}

/** Identifiant du sujet : l'agrégat tel quel, ou l'UUID v5 déterministe d'un sujet composite. */
export function subjectIdOf(subjectKey: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(subjectKey)
    ? subjectKey
    : codeEntityId(ALERT_SUBJECT_ENTITY, subjectKey);
}

export interface WriteDeps {
  readonly idGenerator: IdGenerator;
}

export interface RaiseOutcome {
  readonly alertId: string;
  readonly created: boolean;
  readonly severity: AlertSeverity;
  /** La gravité vient d'être relevée à `CRITICAL` sur une alerte déjà ouverte. */
  readonly raisedToCritical: boolean;
}

interface OpenAlertRow {
  readonly id: Buffer;
  readonly title: string;
  readonly message: string;
  readonly severity: string;
  readonly occurrences: number;
  readonly critical_since: Date | null;
  readonly last_pass_id: string | null;
  readonly last_detected_at: Date;
}

async function lockOpenByKey(uow: UnitOfWork, dedupKey: string): Promise<OpenAlertRow | undefined> {
  return uow
    .selectFrom('communication_alerts')
    .select([
      'id',
      'title',
      'message',
      'severity',
      'occurrences',
      'critical_since',
      'last_pass_id',
      'last_detected_at',
    ])
    .where('open_dedup_key', '=', dedupKey)
    .forUpdate()
    .executeTakeFirst();
}

function isDuplicateKey(error: unknown): boolean {
  const code = (error as { code?: string; errno?: number } | null)?.code;
  const errno = (error as { errno?: number } | null)?.errno;
  return code === 'ER_DUP_ENTRY' || errno === 1062;
}

async function publishAlertEvent(
  uow: UnitOfWork,
  deps: WriteDeps,
  input: {
    readonly eventType: 'AlertRaised' | 'AlertResolved' | 'AlertAcknowledged' | 'AlertEscalated';
    readonly alertId: Buffer;
    readonly occurredAt: Date;
    readonly commandId?: Buffer | null;
    readonly causationId?: Buffer | null;
    readonly payload: Record<string, unknown>;
  },
): Promise<string> {
  const eventId = deps.idGenerator.newId();
  await uow
    .insertInto('platform_domain_events')
    .values({
      event_id: toBin(eventId),
      event_type: input.eventType,
      producer_module: 'communication',
      aggregate_type: 'ALERT',
      aggregate_id: input.alertId,
      occurred_at: input.occurredAt,
      payload: jsonValue(input.payload),
      command_id: input.commandId ?? null,
      causation_id: input.causationId ?? null,
    })
    .execute();
  return eventId;
}

/**
 * Levée (ou nouvelle occurrence) d'une alerte. La règle désactivée ou absente n'est pas appelée ici : le
 * consommateur ne lève rien (ADR-061 §8).
 *
 * `processedAt` : instant du traitement par le serveur, point de départ du délai d'escalade
 * (`critical_since`, BR-NOT-005). Un fait en retard (saisi hors ligne, consommateur arrêté puis relancé)
 * n'écoule pas d'avance un délai que les destinataires, notifiés maintenant, n'ont pas eu (P9-25, NT-3 ;
 * AV-407, AV-466). `first_detected_at`, `last_detected_at` et les événements gardent la date du fait.
 */
export async function raiseAlert(
  uow: UnitOfWork,
  deps: WriteDeps,
  action: AlertRaiseAction,
  rule: AlertRule,
  causationEventId: string | null,
  processedAt: Date,
): Promise<RaiseOutcome> {
  const definition = alertDefinitionOf(action.alertType);
  // Gravité : celle de l'événement si le type l'admet, sinon celle de la règle (AV-351).
  const incoming: AlertSeverity = action.declaredSeverity ?? rule.severity;
  const rendered = renderAlertMessage(action.alertType, action.payload, { showProtected: false });
  const causation = causationEventId === null ? null : toBin(causationEventId);

  const update = async (row: OpenAlertRow): Promise<RaiseOutcome> => {
    const current = row.severity as AlertSeverity;
    const next = raisedSeverity(current, incoming);
    const raisedToCritical = next === 'CRITICAL' && current !== 'CRITICAL';
    const lastDetected =
      action.occurredAt.getTime() > row.last_detected_at.getTime()
        ? action.occurredAt
        : row.last_detected_at;
    await uow
      .updateTable('communication_alerts')
      .set({
        occurrences: row.occurrences + 1,
        last_detected_at: lastDetected,
        severity: next,
        critical_since: row.critical_since ?? (next === 'CRITICAL' ? processedAt : null),
        title: rendered.title,
        message: rendered.message,
        payload: jsonValue(action.payload),
        // Une occurrence hors passe (transition) n'efface pas l'identité de la dernière passe.
        last_pass_id: action.passId ?? row.last_pass_id,
        ...(action.businessDay !== null
          ? { business_day: sql`CAST(${action.businessDay} AS DATE)` }
          : {}),
        version: sql`version + 1`,
      })
      .where('id', '=', row.id)
      .execute();
    // Jeu hors ligne `comms` : la boîte des destinataires reçoit l'état courant quand il change à leurs yeux
    // (gravité, titre, message), non à chaque occurrence d'une alerte d'état revue à chaque passe.
    if (next !== current || rendered.title !== row.title || rendered.message !== row.message) {
      await recordAlertChanges(uow, fromBin(row.id), 'UPSERT');
    }
    if (raisedToCritical) {
      await publishAlertEvent(uow, deps, {
        eventType: 'AlertRaised',
        alertId: row.id,
        occurredAt: action.occurredAt,
        causationId: causation,
        payload: {
          alert_id: fromBin(row.id),
          alert_type: action.alertType,
          severity: next,
          created: false,
          severity_raised: true,
          subject_type: action.subjectType,
          site_id: action.siteId,
        },
      });
    }
    return { alertId: fromBin(row.id), created: false, severity: next, raisedToCritical };
  };

  const existing = await lockOpenByKey(uow, action.dedupKey);
  if (existing) return update(existing);

  const id = deps.idGenerator.newId();
  const idBin = toBin(id);
  try {
    await uow
      .insertInto('communication_alerts')
      .values({
        id: idBin,
        alert_type: action.alertType,
        nature: definition.nature,
        severity: incoming,
        status: 'OPEN',
        subject_type: action.subjectType,
        subject_id: toBin(subjectIdOf(action.subjectKey)),
        site_id: action.siteId === null ? null : toBin(action.siteId),
        zone_id: action.zoneId === null ? null : toBin(action.zoneId),
        owner_user_id: action.ownerUserIds[0] === undefined ? null : toBin(action.ownerUserIds[0]),
        action_screen: action.actionScreen,
        title: rendered.title,
        message: rendered.message,
        payload: jsonValue(action.payload),
        dedup_key: action.dedupKey,
        first_detected_at: action.occurredAt,
        last_detected_at: action.occurredAt,
        business_day:
          action.businessDay === null ? null : sql<Date>`CAST(${action.businessDay} AS DATE)`,
        last_pass_id: action.passId,
        critical_since: incoming === 'CRITICAL' ? processedAt : null,
      })
      .execute();
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    // Une autre transaction vient de lever la même alerte : on la verrouille et on l'incrémente.
    const raced = await lockOpenByKey(uow, action.dedupKey);
    if (!raced) throw error;
    return update(raced);
  }
  await publishAlertEvent(uow, deps, {
    eventType: 'AlertRaised',
    alertId: idBin,
    occurredAt: action.occurredAt,
    causationId: causation,
    payload: {
      alert_id: id,
      alert_type: action.alertType,
      severity: incoming,
      created: true,
      severity_raised: false,
      subject_type: action.subjectType,
      subject_id: subjectIdOf(action.subjectKey),
      site_id: action.siteId,
      zone_id: action.zoneId,
      owner_user_id: action.ownerUserIds[0] ?? null,
    },
  });
  return {
    alertId: id,
    created: true,
    severity: incoming,
    raisedToCritical: incoming === 'CRITICAL',
  };
}

/** Résolution par condition disparue (événement de résolution) de l'alerte ouverte d'un sujet. */
export async function resolveByCondition(
  uow: UnitOfWork,
  deps: WriteDeps,
  action: AlertResolveAction,
  causationEventId: string | null,
): Promise<{ readonly resolved: boolean; readonly alertId: string | null }> {
  const row = await lockOpenByKey(uow, action.dedupKey);
  if (!row) return { resolved: false, alertId: null };
  await closeAlert(uow, deps, row.id, action.alertType, 'CONDITION_CLEARED', action.occurredAt, {
    causationEventId,
  });
  return { resolved: true, alertId: fromBin(row.id) };
}

/**
 * Résolution à la fin d'une passe **complète** (ADR-061 §3) : les alertes d'état ouvertes du type que la
 * passe n'a pas revues (identité de passe, jamais l'horloge).
 */
export async function resolveByPass(
  uow: UnitOfWork,
  deps: WriteDeps,
  action: AlertPassCompletedAction,
  causationEventId: string | null,
): Promise<number> {
  const open = await uow
    .selectFrom('communication_alerts')
    .select(['id', 'alert_type', 'status', 'last_pass_id'])
    .where('alert_type', '=', action.alertType)
    .where('status', 'in', ['OPEN', 'ACKNOWLEDGED'])
    .forUpdate()
    .execute();
  const ids = new Set(
    alertsResolvedByPass(
      open.map((row) => ({
        id: fromBin(row.id),
        alertType: action.alertType,
        status: row.status as AlertStatus,
        lastPassId: row.last_pass_id,
      })),
      { alertType: action.alertType, passId: action.passId, scope: action.scope },
    ),
  );
  let resolved = 0;
  for (const row of open) {
    if (!ids.has(fromBin(row.id))) continue;
    await closeAlert(uow, deps, row.id, action.alertType, 'PASS', action.occurredAt, {
      causationEventId,
    });
    resolved += 1;
  }
  return resolved;
}

/** Clôt une alerte (système) : `RESOLVED`, nature et date ; publie `AlertResolved`. */
async function closeAlert(
  uow: UnitOfWork,
  deps: WriteDeps,
  alertId: Buffer,
  alertType: AlertType,
  kind: 'CONDITION_CLEARED' | 'PASS',
  at: Date,
  options: { readonly causationEventId: string | null },
): Promise<void> {
  await uow
    .updateTable('communication_alerts')
    .set({
      status: 'RESOLVED',
      resolved_at: at,
      resolution_kind: kind,
      version: sql`version + 1`,
    })
    .where('id', '=', alertId)
    .execute();
  // Jeu hors ligne `comms` : l'alerte sort de la boîte de ses destinataires.
  await recordAlertChanges(uow, fromBin(alertId), 'SCOPE_EXIT');
  await publishAlertEvent(uow, deps, {
    eventType: 'AlertResolved',
    alertId,
    occurredAt: at,
    causationId: options.causationEventId === null ? null : toBin(options.causationEventId),
    payload: {
      alert_id: fromBin(alertId),
      alert_type: alertType,
      resolution_kind: kind,
      resolved_by: null,
    },
  });
}

// --- Commandes (acquittement, résolution, écart) ----------------------------------------------------------

export interface LockedAlert {
  readonly id: string;
  readonly alertType: AlertType;
  readonly status: AlertStatus;
  readonly severity: AlertSeverity;
  readonly siteId: string | null;
  readonly zoneId: string | null;
  readonly ownerUserId: string | null;
  readonly firstDetectedAt: Date;
}

/** Alerte verrouillée pour une commande (rang N10b) ; `undefined` si elle n'existe pas. */
export async function lockAlert(
  uow: UnitOfWork,
  alertId: string,
): Promise<LockedAlert | undefined> {
  const row = await uow
    .selectFrom('communication_alerts')
    .select([
      'id',
      'alert_type',
      'status',
      'severity',
      'site_id',
      'zone_id',
      'owner_user_id',
      'first_detected_at',
    ])
    .where('id', '=', toBin(alertId))
    .forUpdate()
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    id: fromBin(row.id),
    alertType: row.alert_type as AlertType,
    status: row.status as AlertStatus,
    severity: row.severity as AlertSeverity,
    siteId: fromBinOrNull(row.site_id),
    zoneId: fromBinOrNull(row.zone_id),
    ownerUserId: fromBinOrNull(row.owner_user_id),
    firstDetectedAt: row.first_detected_at,
  };
}

export async function markAcknowledged(
  uow: UnitOfWork,
  deps: WriteDeps,
  alert: LockedAlert,
  input: { readonly userId: string; readonly at: Date; readonly commandId: string },
): Promise<void> {
  await uow
    .updateTable('communication_alerts')
    .set({
      status: 'ACKNOWLEDGED',
      acknowledged_by: toBin(input.userId),
      acknowledged_at: input.at,
      version: sql`version + 1`,
    })
    .where('id', '=', toBin(alert.id))
    .execute();
  await recordAlertChanges(uow, alert.id, 'UPSERT');
  await publishAlertEvent(uow, deps, {
    eventType: 'AlertAcknowledged',
    alertId: toBin(alert.id),
    occurredAt: input.at,
    commandId: toBin(input.commandId),
    payload: {
      alert_id: alert.id,
      alert_type: alert.alertType,
      acknowledged_by: input.userId,
    },
  });
}

export async function markClosedManually(
  uow: UnitOfWork,
  deps: WriteDeps,
  alert: LockedAlert,
  input: {
    readonly kind: 'MANUAL' | 'DISMISSED';
    readonly userId: string;
    readonly at: Date;
    readonly comment: string;
    readonly commandId: string;
  },
): Promise<void> {
  await uow
    .updateTable('communication_alerts')
    .set({
      status: input.kind === 'DISMISSED' ? 'DISMISSED' : 'RESOLVED',
      resolved_by: toBin(input.userId),
      resolved_at: input.at,
      resolution_kind: input.kind,
      resolution_comment: input.comment,
      version: sql`version + 1`,
    })
    .where('id', '=', toBin(alert.id))
    .execute();
  await recordAlertChanges(uow, alert.id, 'SCOPE_EXIT');
  await publishAlertEvent(uow, deps, {
    eventType: 'AlertResolved',
    alertId: toBin(alert.id),
    occurredAt: input.at,
    commandId: toBin(input.commandId),
    payload: {
      alert_id: alert.id,
      alert_type: alert.alertType,
      resolution_kind: input.kind,
      resolved_by: input.userId,
    },
  });
}

// --- Escalade (BR-NOT-005 ; ADR-062 §7) ---------------------------------------------------------------------

export interface EscalationAlertRow {
  readonly id: string;
  readonly alertType: AlertType;
  readonly status: AlertStatus;
  readonly severity: AlertSeverity;
  readonly criticalSince: Date | null;
  readonly escalatedAt: Date | null;
  readonly siteId: string | null;
  readonly zoneId: string | null;
  readonly ownerUserId: string | null;
  readonly payload: Record<string, unknown>;
}

/**
 * Alertes critiques ouvertes jamais escaladées dont la règle est active, a un délai d'escalade et dont ce
 * délai est écoulé depuis `critical_since`. L'échéance est rejugée par alerte, sous verrou, avec la
 * fonction du domaine. Triées par identifiant, avec reprise après `after` : l'ordre est celui des
 * verrous de `resolveByPass` (clé primaire à l'intérieur d'un type), ce qui exclut les interblocages
 * croisés (ADR-038), et aucune alerte non escaladable n'en affame une autre.
 */
export async function listEscalationCandidateIds(
  uow: UnitOfWork,
  input: { readonly now: Date; readonly after: string | null; readonly limit: number },
): Promise<readonly string[]> {
  const rows = await uow
    .selectFrom('communication_alerts as a')
    .innerJoin('communication_alert_rules as r', 'r.alert_type', 'a.alert_type')
    .select('a.id')
    .where('a.status', '=', 'OPEN')
    .where('a.severity', '=', 'CRITICAL')
    .where('a.escalated_at', 'is', null)
    .where('r.enabled', '=', 1)
    .where('r.escalation_hours', 'is not', null)
    .where(sql<boolean>`a.critical_since <= TIMESTAMPADD(HOUR, -r.escalation_hours, ${input.now})`)
    .$if(input.after !== null, (qb) => qb.where('a.id', '>', toBin(input.after!)))
    .orderBy('a.id', 'asc')
    .limit(input.limit)
    .execute();
  return rows.map((row) => fromBin(row.id));
}

/** Alerte verrouillée avec ce qu'il faut pour juger et émettre l'escalade (rang N10b). */
export async function lockAlertForEscalation(
  uow: UnitOfWork,
  alertId: string,
): Promise<EscalationAlertRow | undefined> {
  const row = await uow
    .selectFrom('communication_alerts')
    .select([
      'id',
      'alert_type',
      'status',
      'severity',
      'critical_since',
      'escalated_at',
      'site_id',
      'zone_id',
      'owner_user_id',
      'payload',
    ])
    .where('id', '=', toBin(alertId))
    .forUpdate()
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    id: fromBin(row.id),
    alertType: row.alert_type as AlertType,
    status: row.status as AlertStatus,
    severity: row.severity as AlertSeverity,
    criticalSince: row.critical_since,
    escalatedAt: row.escalated_at,
    siteId: fromBinOrNull(row.site_id),
    zoneId: fromBinOrNull(row.zone_id),
    ownerUserId: fromBinOrNull(row.owner_user_id),
    payload: (row.payload ?? {}) as Record<string, unknown>,
  };
}

/**
 * Pose l'escalade (une seule fois : `UPDATE` conditionnel) et publie `AlertEscalated`. Renvoie
 * l'identifiant de l'événement (source des notifications d'escalade), ou `null` si l'alerte n'était plus à
 * escalader (prise en compte, résolue, déjà escaladée).
 */
export async function markEscalated(
  uow: UnitOfWork,
  deps: WriteDeps,
  alert: EscalationAlertRow,
  at: Date,
  recipientCount: number,
): Promise<string | null> {
  const result = await uow
    .updateTable('communication_alerts')
    .set({ escalated_at: at, version: sql`version + 1` })
    .where('id', '=', toBin(alert.id))
    .where('status', '=', 'OPEN')
    .where('escalated_at', 'is', null)
    .execute();
  if (Number(result[0]?.numUpdatedRows ?? 0) === 0) return null;
  await recordAlertChanges(uow, alert.id, 'UPSERT');
  return publishAlertEvent(uow, deps, {
    eventType: 'AlertEscalated',
    alertId: toBin(alert.id),
    occurredAt: at,
    payload: {
      alert_id: alert.id,
      alert_type: alert.alertType,
      severity: alert.severity,
      critical_since: alert.criticalSince?.toISOString() ?? null,
      escalated_at: at.toISOString(),
      site_id: alert.siteId,
      escalation_recipients: recipientCount,
    },
  });
}
