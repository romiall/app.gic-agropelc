/**
 * Logique pure d'ECR-NOT-01 « Centre d'alertes et de notifications » (RP-4 ; ADR-061, ADR-062 ;
 * UC-NOT-01 à 04). Lecture en ligne (`GET /api/v1/alerts`, `/alerts/summary`, `/notifications`,
 * `/alert-rules`) avec repli hors ligne sur les projections `comms` (`ALERT`, `NOTIFICATION`), et
 * construction des commandes (`communication.alert.acknowledge`, `.resolve`, `.dismiss`,
 * `communication.notification.read`, `communication.alert_rule.set`).
 */
import {
  COMMUNICATION_COMMAND_TYPES,
  type AlertAcknowledgePayload,
  type AlertDismissPayload,
  type AlertItem,
  type AlertResolvePayload,
  type AlertRuleItem,
  type AlertRuleSetPayload,
  type AlertSummary,
  type NotificationItem,
  type NotificationReadPayload,
} from '@gic/contracts';
import { ROUTES, SCREENS } from '../../app/screens.js';

export const ALERT_SUMMARY_PATH = '/api/v1/alerts/summary';
export const ALERT_RULES_PATH = '/api/v1/alert-rules';

export const ALERT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export const ALERT_SEVERITIES = ['CRITICAL', 'WARNING', 'INFO'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ROLE_CODES = [
  'DIRECTION',
  'SUPERVISION',
  'ADMIN',
  'FINANCE',
  'RESP_COMMERCIAL',
  'COMMERCIAL_TERRAIN',
  'COMMERCIAL_SEDENTAIRE',
  'VENDEUR_PDV',
  'RESP_PRODUCTION',
  'RESP_FERME',
  'MAGASINIER',
  'RESP_ACHATS',
] as const;

export interface AlertsListFilter {
  readonly status: '' | AlertStatus;
  readonly severity: '' | AlertSeverity;
}

export function alertsListPath(filter: AlertsListFilter): string {
  const params = new URLSearchParams();
  if (filter.status) params.set('status', filter.status);
  if (filter.severity) params.set('severity', filter.severity);
  const qs = params.toString();
  return qs ? `/api/v1/alerts?${qs}` : '/api/v1/alerts';
}

export function notificationsListPath(filter: { readonly unreadOnly: boolean }): string {
  return filter.unreadOnly ? '/api/v1/notifications?unread=true' : '/api/v1/notifications';
}

/** Forme servie par le lecteur `ALERT` de `apps/server/src/sync/communication-projections.ts`. */
export interface ProjectedAlertRow {
  readonly id?: string;
  readonly alert_type?: AlertItem['alertType'];
  readonly nature?: AlertItem['nature'];
  readonly severity?: AlertItem['severity'];
  readonly status?: AlertItem['status'];
  readonly title?: string;
  readonly message?: string;
  readonly subject_type?: string;
  readonly subject_id?: string;
  readonly site_id?: string | null;
  readonly zone_id?: string | null;
  readonly action_screen?: string | null;
  readonly occurrences?: number;
  readonly first_detected_at?: string;
  readonly last_detected_at?: string;
  readonly critical_since?: string | null;
  readonly escalated_at?: string | null;
  readonly acknowledged_at?: string | null;
  readonly acknowledged_by?: string | null;
  readonly payload?: Record<string, unknown>;
}

/** Convertit une projection hors ligne `comms:ALERT` en `AlertItem` affichable. */
export function fromProjectedAlert(raw: unknown): AlertItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as ProjectedAlertRow;
  if (!row.id || !row.alert_type || !row.nature || !row.severity || !row.status || !row.title) {
    return null;
  }
  const nowIso = new Date(0).toISOString();
  return {
    id: row.id,
    alertType: row.alert_type,
    nature: row.nature,
    severity: row.severity,
    status: row.status,
    title: row.title,
    message: row.message ?? '',
    subjectType: row.subject_type ?? 'UNKNOWN',
    subjectId: row.subject_id ?? row.id,
    siteId: row.site_id ?? null,
    zoneId: row.zone_id ?? null,
    ownerUserId: null,
    actionScreen: row.action_screen ?? null,
    occurrences: row.occurrences ?? 1,
    firstDetectedAt: row.first_detected_at ?? nowIso,
    lastDetectedAt: row.last_detected_at ?? row.first_detected_at ?? nowIso,
    criticalSince: row.critical_since ?? null,
    escalatedAt: row.escalated_at ?? null,
    acknowledgedAt: row.acknowledged_at ?? null,
    acknowledgedBy: row.acknowledged_by ?? null,
    resolvedAt: null,
    resolvedBy: null,
    resolutionComment: null,
    visibility: ['RECIPIENT'],
    payload: row.payload ?? {},
  };
}

/** Filtre et trie les alertes projetées hors ligne comme le serveur (gravité, puis dernière détection). */
export function filterProjectedAlerts(
  rows: readonly unknown[],
  filter: AlertsListFilter,
): AlertItem[] {
  const rank: Readonly<Record<AlertItem['severity'], number>> = {
    CRITICAL: 0,
    WARNING: 1,
    INFO: 2,
  };
  return rows
    .map(fromProjectedAlert)
    .filter((item): item is AlertItem => item !== null)
    .filter((item) => {
      if (filter.severity && item.severity !== filter.severity) return false;
      if (filter.status && item.status !== filter.status) return false;
      return true;
    })
    .sort(
      (a, b) =>
        rank[a.severity] - rank[b.severity] ||
        b.lastDetectedAt.localeCompare(a.lastDetectedAt) ||
        a.id.localeCompare(b.id),
    );
}

/** Résumé calculé localement sur les alertes projetées hors ligne. */
export function summarizeAlerts(items: readonly AlertItem[], computedAt = ''): AlertSummary {
  let open = 0;
  let acknowledged = 0;
  let info = 0;
  let warning = 0;
  let critical = 0;
  for (const item of items) {
    if (item.status !== 'OPEN' && item.status !== 'ACKNOWLEDGED') continue;
    if (item.status === 'OPEN') open += 1;
    else acknowledged += 1;
    if (item.severity === 'CRITICAL') critical += 1;
    else if (item.severity === 'WARNING') warning += 1;
    else info += 1;
  }
  return {
    open,
    acknowledged,
    bySeverity: { INFO: info, WARNING: warning, CRITICAL: critical },
    truncated: false,
    computedAt,
  };
}

/** Forme servie par le lecteur `NOTIFICATION` de `apps/server/src/sync/communication-projections.ts`. */
export interface ProjectedNotificationRow {
  readonly id?: string;
  readonly kind?: NotificationItem['kind'];
  readonly title?: string;
  readonly body?: string;
  readonly link?: string | null;
  readonly alert_id?: string | null;
  readonly note_id?: string | null;
  readonly source_type?: string | null;
  readonly source_id?: string | null;
  readonly created_at?: string;
  readonly delivered_at?: string | null;
  readonly read_at?: string | null;
}

export function fromProjectedNotifications(
  rows: readonly unknown[],
  unreadOnly = false,
): { items: NotificationItem[]; unreadCount: number } {
  const nowIso = new Date(0).toISOString();
  const all = rows
    .filter((raw): raw is ProjectedNotificationRow => Boolean(raw && typeof raw === 'object'))
    .filter(
      (row): row is ProjectedNotificationRow & { readonly id: string; readonly title: string } =>
        Boolean(row.id && row.title),
    )
    .map((row) => ({
      id: row.id,
      channel: 'IN_APP' as const,
      kind: row.kind ?? 'ALERT',
      title: row.title,
      body: row.body ?? '',
      link: row.link ?? null,
      alertId: row.alert_id ?? null,
      noteId: row.note_id ?? null,
      sourceType: row.source_type ?? null,
      sourceId: row.source_id ?? null,
      createdAt: row.created_at ?? nowIso,
      deliveredAt: row.delivered_at ?? null,
      readAt: row.read_at ?? null,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  const unreadCount = all.filter((n) => !n.readAt).length;
  const items = unreadOnly ? all.filter((n) => !n.readAt) : all;
  return { items, unreadCount };
}

/** Route PWA correspondant à l'`actionScreen` d'une alerte (`ECR-…`), ou `null` si inconnu. */
export function routeOfActionScreen(actionScreen: string | null): string | null {
  if (!actionScreen) return null;
  const screen = SCREENS.find((entry) => entry.id === actionScreen);
  return screen ? screen.path : null;
}

/** Route cible d'une notification (`link` explicite, note, alerte ou écran source). */
export function routeOfNotification(item: NotificationItem): string | null {
  if (item.link) return item.link;
  if (item.noteId) return `${ROUTES.notes}?note=${encodeURIComponent(item.noteId)}`;
  if (item.sourceType === 'APPROVAL_REQUEST') return ROUTES.approvals;
  if (item.sourceType === 'STOCK_TRANSFER') return ROUTES.receive;
  if (item.kind === 'EXPORT') return ROUTES.analyticsExplorer;
  return null;
}

/** L'alerte peut-elle être résolue ou écartée manuellement (alerte d'événement `EVENT`, AV-354) ? */
export function canManuallyCloseAlert(alert: Pick<AlertItem, 'nature' | 'status'>): boolean {
  return alert.nature === 'EVENT' && (alert.status === 'OPEN' || alert.status === 'ACKNOWLEDGED');
}

export function buildAlertAckPayload(comment?: string) {
  const trimmed = comment?.trim() ?? '';
  const payload: AlertAcknowledgePayload = trimmed ? { comment: trimmed } : {};
  return {
    ok: true as const,
    commandType: COMMUNICATION_COMMAND_TYPES.alertAcknowledge,
    payload,
  };
}

export function buildAlertResolvePayload(comment: string) {
  const trimmed = comment.trim();
  if (trimmed.length === 0 || trimmed.length > 500) {
    return { ok: false as const, error: 'comment_required' as const };
  }
  const payload: AlertResolvePayload = { comment: trimmed };
  return {
    ok: true as const,
    commandType: COMMUNICATION_COMMAND_TYPES.alertResolve,
    payload,
  };
}

export function buildAlertDismissPayload(reason: string) {
  const trimmed = reason.trim();
  if (trimmed.length === 0 || trimmed.length > 500) {
    return { ok: false as const, error: 'reason_required' as const };
  }
  const payload: AlertDismissPayload = { reason: trimmed };
  return {
    ok: true as const,
    commandType: COMMUNICATION_COMMAND_TYPES.alertDismiss,
    payload,
  };
}

export function buildNotificationReadPayload(
  target: { readonly notificationIds: readonly string[] } | { readonly all: true },
) {
  const payload: NotificationReadPayload =
    'all' in target ? { all: true } : { notificationIds: [...target.notificationIds] };
  return {
    ok: true as const,
    commandType: COMMUNICATION_COMMAND_TYPES.notificationRead,
    payload,
  };
}

export function buildAlertRuleSetPayload(input: {
  readonly alertType: AlertRuleItem['alertType'];
  readonly enabled?: boolean;
  readonly severity?: AlertSeverity;
  readonly escalationHours?: number | null;
}) {
  const payload: AlertRuleSetPayload = {
    alertType: input.alertType,
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.severity !== undefined ? { severity: input.severity } : {}),
    ...(input.escalationHours !== undefined ? { escalationHours: input.escalationHours } : {}),
  };
  return {
    ok: true as const,
    commandType: COMMUNICATION_COMMAND_TYPES.alertRuleSet,
    payload,
  };
}
