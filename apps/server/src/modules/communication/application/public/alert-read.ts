/**
 * Lecture des alertes (P9-06 ; ADR-072 §3 ; BR-NOT-001, BR-NOT-008 ; UC-NOT-03 ; RC-04, RC-05) : la liste,
 * le détail et le résumé d'un utilisateur sont **sa boîte** (alertes dont il est destinataire) **plus** sa
 * supervision (alertes de l'étendue de `comm.alert.read`).
 *
 * - **Étendue exacte** : `listConfinementAt` n'est qu'un pré-filtre sur-ensemble (`null` pour `ALL` et
 *   pour `SITE` ou `ZONE` sous une affectation non-site) ; chaque ligne retenue par le pré-filtre est
 *   jugée par `evaluateAccess` avec le site, la zone et le propriétaire de l'alerte. Une alerte sans site
 *   sous une portée `SITE` n'est donc pas visible. Le résumé suit la même évaluation (jamais un `COUNT`
 *   sur le pré-filtre), sauf en portée `ALL` où tout est visible.
 * - **Pagination** : par curseur sur (dernière détection, identifiant) ; une page peut être plus courte
 *   que `limit` (plafond de balayage) : suivre `nextCursor` jusqu'à `null`.
 * - **Rendu pour le lecteur** : titre et message sont rendus pour lui ; une valeur au coût n'y figure que
 *   s'il détient `inventory.valuation.read` sur le site de l'alerte (RC-05, AV-440). La charge utile
 *   exposée ne porte que les champs du message qui ne sont pas protégés.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  alertCarriesProtectedValue,
  alertDefinitionOf,
  renderAlertMessage,
  type AlertNature,
  type AlertSeverity,
  type AlertStatus,
  type AlertType,
} from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import {
  evaluateAccess,
  listConfinementAt,
  type ListConfinement,
  type ResourceLocator,
} from '../../../identity/application/public/index.js';

type Executor = Kysely<DB> | Transaction<DB>;

export const ALERT_READ_PERMISSION = 'comm.alert.read';
const VALUATION_READ = 'inventory.valuation.read';
/** Taille d'une lecture de candidates. */
const PAGE = 200;
/** Lectures successives au plus pour remplir une page filtrée par la portée. */
const MAX_SCANS = 10;
/** Lignes au plus balayées par le résumé hors portée `ALL` (ADR-078). */
const SUMMARY_SCAN_CAP = 2000;

export type AlertVisibility = 'RECIPIENT' | 'SUPERVISION';

export interface AlertReadItem {
  readonly id: string;
  readonly alertType: AlertType;
  readonly nature: AlertNature;
  readonly severity: AlertSeverity;
  readonly status: AlertStatus;
  readonly title: string;
  readonly message: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly siteId: string | null;
  readonly zoneId: string | null;
  readonly ownerUserId: string | null;
  readonly actionScreen: string | null;
  readonly occurrences: number;
  readonly firstDetectedAt: Date;
  readonly lastDetectedAt: Date;
  readonly criticalSince: Date | null;
  readonly escalatedAt: Date | null;
  readonly acknowledgedAt: Date | null;
  readonly acknowledgedBy: string | null;
  readonly resolvedAt: Date | null;
  readonly resolvedBy: string | null;
  readonly resolutionComment: string | null;
  readonly visibility: readonly AlertVisibility[];
  readonly payload: Record<string, unknown>;
}

export interface AlertCursor {
  readonly lastDetectedAt: Date;
  readonly id: string;
}

/** Curseur opaque : (dernière détection, identifiant) en base64url. */
export function encodeAlertCursor(cursor: AlertCursor): string {
  return Buffer.from(
    JSON.stringify({ t: cursor.lastDetectedAt.toISOString(), id: cursor.id }),
    'utf-8',
  ).toString('base64url');
}

/** `null` si le curseur n'est pas un curseur de cette lecture. */
export function decodeAlertCursor(raw: string): AlertCursor | null {
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
    return { lastDetectedAt: at, id: parsed.id };
  } catch {
    return null;
  }
}

interface ReadScope {
  /** Portée `ALL` : toute alerte est dans l'étendue, aucune évaluation ligne à ligne. */
  readonly all: boolean;
  /** Pré-filtre sûr (sur-ensemble) ; `null` : aucun pré-filtre possible. */
  readonly confinement: ListConfinement | null;
}

async function readScope(executor: Executor, userId: string, at: Date): Promise<ReadScope> {
  const all = (
    await evaluateAccess(executor, {
      userId,
      permissionCode: ALERT_READ_PERMISSION,
      occurredAt: at,
      resource: {},
    })
  ).allowed;
  if (all) return { all: true, confinement: null };
  return {
    all: false,
    confinement: await listConfinementAt(executor, userId, ALERT_READ_PERMISSION, at),
  };
}

interface AlertRow {
  readonly id: Buffer;
  readonly alert_type: string;
  readonly nature: string;
  readonly severity: string;
  readonly status: string;
  readonly subject_type: string;
  readonly subject_id: Buffer;
  readonly site_id: Buffer | null;
  readonly zone_id: Buffer | null;
  readonly owner_user_id: Buffer | null;
  readonly action_screen: string | null;
  readonly payload: unknown;
  readonly occurrences: number;
  readonly first_detected_at: Date;
  readonly last_detected_at: Date;
  readonly critical_since: Date | null;
  readonly escalated_at: Date | null;
  readonly acknowledged_at: Date | null;
  readonly acknowledged_by: Buffer | null;
  readonly resolved_at: Date | null;
  readonly resolved_by: Buffer | null;
  readonly resolution_comment: string | null;
  readonly recipient_user_id: Buffer | null;
}

function locatorOf(row: AlertRow): ResourceLocator {
  return {
    ...(row.site_id !== null ? { siteId: fromBin(row.site_id) } : {}),
    ...(row.zone_id !== null ? { zoneId: fromBin(row.zone_id) } : {}),
    ...(row.owner_user_id !== null ? { ownerUserId: fromBin(row.owner_user_id) } : {}),
  };
}

async function inSupervisionScope(
  executor: Executor,
  scope: ReadScope,
  userId: string,
  at: Date,
  row: AlertRow,
): Promise<boolean> {
  if (scope.all) return true;
  return (
    await evaluateAccess(executor, {
      userId,
      permissionCode: ALERT_READ_PERMISSION,
      occurredAt: at,
      resource: locatorOf(row),
    })
  ).allowed;
}

/** Charge utile publique : les champs du message qui ne sont pas protégés (RC-05). */
function publicPayload(type: AlertType, payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of alertDefinitionOf(type).messageFields) {
    if (field.protected === true) continue;
    if (payload[field.key] !== undefined) result[field.key] = payload[field.key];
  }
  return result;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'string'
    ? (JSON.parse(value) as Record<string, unknown>)
    : ((value ?? {}) as Record<string, unknown>);

async function toItem(
  executor: Executor,
  row: AlertRow,
  context: {
    readonly userId: string;
    readonly at: Date;
    readonly visibility: readonly AlertVisibility[];
    readonly valuation: Map<string, boolean>;
  },
): Promise<AlertReadItem> {
  const type = row.alert_type as AlertType;
  const definition = alertDefinitionOf(type);
  const payload = asRecord(row.payload);
  let showProtected = false;
  if (alertCarriesProtectedValue(type, payload)) {
    const key = `${row.site_id?.toString('hex') ?? ''}|${row.zone_id?.toString('hex') ?? ''}`;
    let allowed = context.valuation.get(key);
    if (allowed === undefined) {
      allowed = (
        await evaluateAccess(executor, {
          userId: context.userId,
          permissionCode: VALUATION_READ,
          occurredAt: context.at,
          resource: {
            ...(row.site_id !== null ? { siteId: fromBin(row.site_id) } : {}),
            ...(row.zone_id !== null ? { zoneId: fromBin(row.zone_id) } : {}),
          },
        })
      ).allowed;
      context.valuation.set(key, allowed);
    }
    showProtected = allowed;
  }
  const rendered = renderAlertMessage(type, payload, { showProtected });
  return {
    id: fromBin(row.id),
    alertType: type,
    nature: definition.nature,
    severity: row.severity as AlertSeverity,
    status: row.status as AlertStatus,
    title: rendered.title,
    message: rendered.message,
    subjectType: row.subject_type,
    subjectId: fromBin(row.subject_id),
    siteId: fromBinOrNull(row.site_id),
    zoneId: fromBinOrNull(row.zone_id),
    ownerUserId: fromBinOrNull(row.owner_user_id),
    actionScreen: row.action_screen,
    occurrences: row.occurrences,
    firstDetectedAt: row.first_detected_at,
    lastDetectedAt: row.last_detected_at,
    criticalSince: row.critical_since,
    escalatedAt: row.escalated_at,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: fromBinOrNull(row.acknowledged_by),
    resolvedAt: row.resolved_at,
    resolvedBy: fromBinOrNull(row.resolved_by),
    resolutionComment: row.resolution_comment,
    visibility: context.visibility,
    payload: publicPayload(type, payload),
  };
}

export interface AlertFilter {
  /** Absent : alertes ouvertes (`OPEN` et `ACKNOWLEDGED`). */
  readonly statuses?: readonly AlertStatus[];
  readonly severities?: readonly AlertSeverity[];
  readonly alertTypes?: readonly AlertType[];
  readonly siteId?: string;
  /** Seulement la boîte du lecteur. */
  readonly boxOnly?: boolean;
}

const OPEN_STATUSES: readonly AlertStatus[] = ['OPEN', 'ACKNOWLEDGED'];

function candidateQuery(
  executor: Executor,
  scope: ReadScope,
  input: {
    readonly userId: string;
    readonly filter: AlertFilter;
    readonly after: AlertCursor | null;
  },
  limit: number,
) {
  const user = toBin(input.userId);
  const filter = input.filter;
  let query = executor
    .selectFrom('communication_alerts as a')
    .leftJoin('communication_alert_recipients as r', (join) =>
      join.onRef('r.alert_id', '=', 'a.id').on('r.user_id', '=', user),
    )
    .select([
      'a.id',
      'a.alert_type',
      'a.nature',
      'a.severity',
      'a.status',
      'a.subject_type',
      'a.subject_id',
      'a.site_id',
      'a.zone_id',
      'a.owner_user_id',
      'a.action_screen',
      'a.payload',
      'a.occurrences',
      'a.first_detected_at',
      'a.last_detected_at',
      'a.critical_since',
      'a.escalated_at',
      'a.acknowledged_at',
      'a.acknowledged_by',
      'a.resolved_at',
      'a.resolved_by',
      'a.resolution_comment',
      'r.user_id as recipient_user_id',
    ])
    .where('a.status', 'in', [...(filter.statuses ?? OPEN_STATUSES)]);
  if (filter.severities !== undefined) {
    query = query.where('a.severity', 'in', [...filter.severities]);
  }
  if (filter.alertTypes !== undefined) {
    query = query.where('a.alert_type', 'in', [...filter.alertTypes]);
  }
  if (filter.siteId !== undefined) query = query.where('a.site_id', '=', toBin(filter.siteId));

  // Pré-filtre sûr : la boîte, ou la supervision (sites, propriétaires) si la portée en admet un.
  if (filter.boxOnly === true) {
    query = query.where('r.user_id', 'is not', null).where('a.status', 'in', [...OPEN_STATUSES]);
  } else if (!scope.all && scope.confinement !== null) {
    const sites = scope.confinement.siteIds;
    const owners = scope.confinement.ownerUserIds;
    query = query.where((eb) =>
      eb.or([
        eb.and([eb('r.user_id', 'is not', null), eb('a.status', 'in', [...OPEN_STATUSES])]),
        ...(sites.length > 0 ? [eb('a.site_id', 'in', sites.map(toBin))] : []),
        ...(owners.length > 0 ? [eb('a.owner_user_id', 'in', owners.map(toBin))] : []),
      ]),
    );
  }
  if (input.after !== null) {
    const at = input.after.lastDetectedAt;
    const id = toBin(input.after.id);
    query = query.where((eb) =>
      eb.or([
        eb('a.last_detected_at', '<', at),
        eb.and([eb('a.last_detected_at', '=', at), eb('a.id', '<', id)]),
      ]),
    );
  }
  return query.orderBy('a.last_detected_at', 'desc').orderBy('a.id', 'desc').limit(limit);
}

async function visibilityOf(
  executor: Executor,
  scope: ReadScope,
  userId: string,
  at: Date,
  row: AlertRow,
): Promise<readonly AlertVisibility[]> {
  const visibility: AlertVisibility[] = [];
  // La boîte vaut droit de lecture pour la durée d'ouverture de l'alerte seulement (ADR-072 §9, §10) :
  // une alerte close ne se lit plus que par la supervision.
  if (row.recipient_user_id !== null && OPEN_STATUSES.includes(row.status as AlertStatus)) {
    visibility.push('RECIPIENT');
  }
  if (await inSupervisionScope(executor, scope, userId, at, row)) visibility.push('SUPERVISION');
  return visibility;
}

export interface AlertPage {
  readonly items: readonly AlertReadItem[];
  readonly nextCursor: string | null;
}

export async function alertPage(
  executor: Executor,
  input: {
    readonly userId: string;
    readonly at: Date;
    readonly filter?: AlertFilter;
    readonly after?: AlertCursor;
    readonly limit: number;
  },
): Promise<AlertPage> {
  const scope = await readScope(executor, input.userId, input.at);
  const valuation = new Map<string, boolean>();
  const items: AlertReadItem[] = [];
  let cursor: AlertCursor | null = input.after ?? null;
  let exhausted = false;

  scan: for (let index = 0; index < MAX_SCANS; index += 1) {
    const rows = (await candidateQuery(
      executor,
      scope,
      { userId: input.userId, filter: input.filter ?? {}, after: cursor },
      PAGE,
    ).execute()) as AlertRow[];
    if (rows.length === 0) {
      exhausted = true;
      break;
    }
    for (const [index, row] of rows.entries()) {
      cursor = { lastDetectedAt: row.last_detected_at, id: fromBin(row.id) };
      const visibility = await visibilityOf(executor, scope, input.userId, input.at, row);
      if (visibility.length === 0) continue;
      items.push(
        await toItem(executor, row, {
          userId: input.userId,
          at: input.at,
          visibility,
          valuation,
        }),
      );
      if (items.length >= input.limit) {
        // La page est pleine : plus rien après elle seulement si c'était la dernière ligne du jeu.
        exhausted = index === rows.length - 1 && rows.length < PAGE;
        break scan;
      }
    }
    if (rows.length < PAGE) {
      exhausted = true;
      break;
    }
  }
  return {
    items,
    nextCursor: exhausted || cursor === null ? null : encodeAlertCursor(cursor),
  };
}

/** Une alerte vue par ce lecteur ; `null` : inconnue ou hors de sa boîte et de sa portée (404 opaque). */
export async function alertDetail(
  executor: Executor,
  input: { readonly userId: string; readonly at: Date; readonly id: string },
): Promise<AlertReadItem | null> {
  const row = (await executor
    .selectFrom('communication_alerts as a')
    .leftJoin('communication_alert_recipients as r', (join) =>
      join.onRef('r.alert_id', '=', 'a.id').on('r.user_id', '=', toBin(input.userId)),
    )
    .select([
      'a.id',
      'a.alert_type',
      'a.nature',
      'a.severity',
      'a.status',
      'a.subject_type',
      'a.subject_id',
      'a.site_id',
      'a.zone_id',
      'a.owner_user_id',
      'a.action_screen',
      'a.payload',
      'a.occurrences',
      'a.first_detected_at',
      'a.last_detected_at',
      'a.critical_since',
      'a.escalated_at',
      'a.acknowledged_at',
      'a.acknowledged_by',
      'a.resolved_at',
      'a.resolved_by',
      'a.resolution_comment',
      'r.user_id as recipient_user_id',
    ])
    .where('a.id', '=', toBin(input.id))
    .executeTakeFirst()) as AlertRow | undefined;
  if (!row) return null;
  const scope = await readScope(executor, input.userId, input.at);
  const visibility = await visibilityOf(executor, scope, input.userId, input.at, row);
  if (visibility.length === 0) return null;
  return toItem(executor, row, {
    userId: input.userId,
    at: input.at,
    visibility,
    valuation: new Map(),
  });
}

export interface AlertSummaryResult {
  readonly open: number;
  readonly acknowledged: number;
  readonly bySeverity: {
    readonly INFO: number;
    readonly WARNING: number;
    readonly CRITICAL: number;
  };
  readonly truncated: boolean;
}

/**
 * Alertes ouvertes de l'étendue du lecteur (boîte et supervision) : exactes en portée `ALL` (comptage
 * en base), balayées et jugées une à une sinon, jusqu'au plafond (`truncated`).
 */
export async function alertSummary(
  executor: Executor,
  input: { readonly userId: string; readonly at: Date },
): Promise<AlertSummaryResult> {
  const scope = await readScope(executor, input.userId, input.at);
  const bySeverity = { INFO: 0, WARNING: 0, CRITICAL: 0 };
  let open = 0;
  let acknowledged = 0;
  const count = (severity: string, status: string, n: number) => {
    if (severity in bySeverity) bySeverity[severity as keyof typeof bySeverity] += n;
    if (status === 'ACKNOWLEDGED') acknowledged += n;
    else open += n;
  };

  if (scope.all) {
    const rows = await executor
      .selectFrom('communication_alerts')
      .select(['severity', 'status', sql<number>`COUNT(*)`.as('n')])
      .where('status', 'in', [...OPEN_STATUSES])
      .groupBy(['severity', 'status'])
      .execute();
    for (const row of rows) count(row.severity, row.status, Number(row.n));
    return { open, acknowledged, bySeverity, truncated: false };
  }

  let scanned = 0;
  let cursor: AlertCursor | null = null;
  let truncated = false;
  for (;;) {
    const rows = (await candidateQuery(
      executor,
      scope,
      { userId: input.userId, filter: {}, after: cursor },
      PAGE,
    ).execute()) as AlertRow[];
    if (rows.length === 0) break;
    for (const row of rows) {
      cursor = { lastDetectedAt: row.last_detected_at, id: fromBin(row.id) };
      scanned += 1;
      if (
        row.recipient_user_id !== null ||
        (await inSupervisionScope(executor, scope, input.userId, input.at, row))
      ) {
        count(row.severity, row.status, 1);
      }
    }
    if (rows.length < PAGE) break;
    if (scanned >= SUMMARY_SCAN_CAP) {
      // Plafond atteint : tronqué seulement s'il reste au moins une ligne à balayer.
      const peek = (await candidateQuery(
        executor,
        scope,
        { userId: input.userId, filter: {}, after: cursor },
        1,
      ).execute()) as AlertRow[];
      truncated = peek.length > 0;
      break;
    }
  }
  return { open, acknowledged, bySeverity, truncated };
}
