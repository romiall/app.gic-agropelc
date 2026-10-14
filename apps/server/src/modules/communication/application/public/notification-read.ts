/**
 * Lecture des notifications d'un utilisateur et des règles d'alerte (P9-06 ; ADR-072 §4 ; D13 §4).
 *
 * - **Notifications** : celles de l'utilisateur seulement (`user_id`), canal `IN_APP` par défaut (les
 *   lignes `WEB_PUSH` ne sont que l'envoi du même message) ; plus récentes d'abord, curseur sur
 *   (création, identifiant). Le compteur de non lues est exact (index `(user_id, read_at, created_at)`).
 * - **Règles** : le catalogue complet des 36 types avec leurs réglages ; les gravités, modes de
 *   résolution et escalades admis viennent du domaine, pas de la base.
 */
import type { Kysely, Transaction } from 'kysely';
import {
  alertCarriesProtectedValue,
  alertDefinitionOf,
  renderAlertMessage,
  ALERT_TYPES,
  type AlertSeverity,
  type AlertType,
} from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { evaluateAccess } from '../../../identity/application/public/index.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface NotificationReadItem {
  readonly id: string;
  readonly channel: 'IN_APP' | 'WEB_PUSH';
  readonly title: string;
  readonly body: string;
  readonly link: string | null;
  readonly alertId: string | null;
  readonly noteId: string | null;
  readonly createdAt: Date;
  readonly deliveredAt: Date | null;
  readonly readAt: Date | null;
}

export interface NotificationCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export function encodeNotificationCursor(cursor: NotificationCursor): string {
  return Buffer.from(
    JSON.stringify({ t: cursor.createdAt.toISOString(), id: cursor.id }),
    'utf-8',
  ).toString('base64url');
}

export function decodeNotificationCursor(raw: string): NotificationCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8')) as {
      t?: unknown;
      id?: unknown;
    };
    if (typeof parsed.t !== 'string' || typeof parsed.id !== 'string') return null;
    const at = new Date(parsed.t);
    if (Number.isNaN(at.getTime())) return null;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(parsed.id)) {
      return null;
    }
    return { createdAt: at, id: parsed.id };
  } catch {
    return null;
  }
}

export interface NotificationPage {
  readonly items: readonly NotificationReadItem[];
  readonly unreadCount: number;
  readonly nextCursor: string | null;
}

export async function notificationPage(
  executor: Executor,
  input: {
    readonly userId: string;
    /** Instant de la lecture : le droit de valorisation s'y juge. */
    readonly at: Date;
    readonly unreadOnly?: boolean;
    readonly channel?: 'IN_APP' | 'WEB_PUSH';
    readonly after?: NotificationCursor;
    readonly limit: number;
  },
): Promise<NotificationPage> {
  const user = toBin(input.userId);
  const channel = input.channel ?? 'IN_APP';
  let query = executor
    .selectFrom('communication_notifications')
    .select([
      'id',
      'channel',
      'title',
      'body',
      'link',
      'alert_id',
      'note_id',
      'created_at',
      'delivered_at',
      'read_at',
    ])
    .where('user_id', '=', user)
    .where('channel', '=', channel);
  if (input.unreadOnly === true) query = query.where('read_at', 'is', null);
  if (input.after !== undefined) {
    const at = input.after.createdAt;
    const id = toBin(input.after.id);
    query = query.where((eb) =>
      eb.or([eb('created_at', '<', at), eb.and([eb('created_at', '=', at), eb('id', '<', id)])]),
    );
  }
  const rows = await query
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(input.limit + 1)
    .execute();
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  const bodies = await currentBodies(executor, input.userId, page, input.at);
  const unread = await executor
    .selectFrom('communication_notifications')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('user_id', '=', user)
    .where('channel', '=', 'IN_APP')
    .where('read_at', 'is', null)
    .executeTakeFirst();
  return {
    items: page.map((row) => ({
      id: fromBin(row.id),
      channel: row.channel as 'IN_APP' | 'WEB_PUSH',
      title: row.title,
      body: bodies.get(fromBin(row.id)) ?? row.body,
      link: row.link,
      alertId: fromBinOrNull(row.alert_id),
      noteId: fromBinOrNull(row.note_id),
      createdAt: row.created_at,
      deliveredAt: row.delivered_at,
      readAt: row.read_at,
    })),
    unreadCount: Number(unread?.n ?? 0),
    nextCursor:
      rows.length > input.limit && last !== undefined
        ? encodeNotificationCursor({ createdAt: last.created_at, id: fromBin(last.id) })
        : null,
  };
}

/**
 * Corps courant des notifications `IN_APP` d'alerte dont le message porte une valeur au coût : rendu à
 * nouveau selon le droit du lecteur **à la lecture** (RC-05) — une valeur reçue pendant que le droit
 * `inventory.valuation.read` était détenu ne reste pas lisible après sa perte. Les autres notifications
 * gardent leur texte d'origine.
 */
async function currentBodies(
  executor: Executor,
  userId: string,
  rows: readonly { id: Buffer; channel: string; alert_id: Buffer | null }[],
  at: Date,
): Promise<Map<string, string>> {
  const bodies = new Map<string, string>();
  const candidates = rows.filter((row) => row.channel === 'IN_APP' && row.alert_id !== null);
  if (candidates.length === 0) return bodies;
  const alerts = await executor
    .selectFrom('communication_alerts')
    .select(['id', 'alert_type', 'payload', 'site_id', 'zone_id'])
    .where(
      'id',
      'in',
      candidates.map((row) => row.alert_id!),
    )
    .execute();
  const byId = new Map(alerts.map((alert) => [fromBin(alert.id), alert]));
  const valuation = new Map<string, boolean>();
  for (const row of candidates) {
    const alert = byId.get(fromBin(row.alert_id!));
    if (alert === undefined) continue;
    const type = alert.alert_type as AlertType;
    const payload = (
      typeof alert.payload === 'string' ? JSON.parse(alert.payload) : (alert.payload ?? {})
    ) as Record<string, unknown>;
    if (!alertCarriesProtectedValue(type, payload)) continue;
    const key = `${alert.site_id?.toString('hex') ?? ''}|${alert.zone_id?.toString('hex') ?? ''}`;
    let allowed = valuation.get(key);
    if (allowed === undefined) {
      allowed = (
        await evaluateAccess(executor, {
          userId,
          permissionCode: 'inventory.valuation.read',
          occurredAt: at,
          resource: {
            ...(alert.site_id !== null ? { siteId: fromBin(alert.site_id) } : {}),
            ...(alert.zone_id !== null ? { zoneId: fromBin(alert.zone_id) } : {}),
          },
        })
      ).allowed;
      valuation.set(key, allowed);
    }
    bodies.set(
      fromBin(row.id),
      renderAlertMessage(type, payload, { showProtected: allowed }).message,
    );
  }
  return bodies;
}

export interface AlertRuleReadItem {
  readonly alertType: AlertType;
  readonly nature: 'STATE' | 'EVENT';
  readonly enabled: boolean;
  readonly severity: AlertSeverity;
  readonly severitiesAdmitted: readonly AlertSeverity[];
  readonly recipientRoles: readonly string[];
  readonly resolutionMode: 'AUTO' | 'MANUAL';
  readonly resolutionModesAdmitted: readonly ('AUTO' | 'MANUAL')[];
  readonly escalationHours: number | null;
  readonly escalationApplicable: boolean;
  readonly escalationRoles: readonly string[];
  readonly sourceAvailable: boolean;
  readonly version: number;
  readonly updatedAt: Date;
  readonly updatedBy: string | null;
}

const stringArray = (value: unknown): string[] => {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : [];
};

/** Règles d'alerte, dans l'ordre du catalogue ; un type sans ligne (jamais semé) est omis. */
export async function listAlertRuleItems(executor: Executor): Promise<AlertRuleReadItem[]> {
  const rows = await executor.selectFrom('communication_alert_rules').selectAll().execute();
  const byType = new Map(rows.map((row) => [row.alert_type, row]));
  const items: AlertRuleReadItem[] = [];
  for (const alertType of ALERT_TYPES) {
    const row = byType.get(alertType);
    if (row === undefined) continue;
    const definition = alertDefinitionOf(alertType);
    items.push({
      alertType,
      nature: definition.nature,
      enabled: Boolean(row.enabled),
      severity: row.severity as AlertSeverity,
      severitiesAdmitted: definition.severities,
      recipientRoles: stringArray(row.recipient_roles),
      resolutionMode: row.resolution_mode as 'AUTO' | 'MANUAL',
      resolutionModesAdmitted: definition.nature === 'STATE' ? ['AUTO'] : ['AUTO', 'MANUAL'],
      escalationHours: row.escalation_hours,
      escalationApplicable: definition.severities.includes('CRITICAL'),
      escalationRoles: stringArray(row.escalation_roles),
      sourceAvailable: definition.sourceAvailable,
      version: row.version,
      updatedAt: row.updated_at,
      updatedBy: fromBinOrNull(row.updated_by),
    });
  }
  return items;
}
