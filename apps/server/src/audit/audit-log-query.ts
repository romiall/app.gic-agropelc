/**
 * `audit.log.read` (07-security-rbac/03-audit.md §6) : lecture filtrée du journal, la plus
 * récente d'abord. La restriction de portée par rôle (la Finance est limitée aux entités
 * financières, RP-1, AV-493) se décide dans la couche de transport (`audit-api/audit-scope.ts`) et
 * arrive ici comme une liste de types d'entité (`entityTypes`) : ce module reste sans dépendance
 * vers `identity` (graphe des dépendances, note 1).
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../platform/kysely/uuid-columns.js';

export interface AuditLogFilter {
  readonly entityType?: string;
  /** Restriction de portée (RP-1, AV-493) : seules les entités de ces types, en plus de `entityType`. */
  readonly entityTypes?: readonly string[];
  readonly entityId?: string;
  readonly actorUserId?: string;
  readonly action?: string;
  /** Enregistrement serveur (`recorded_at`) à partir de cet instant, inclus. */
  readonly recordedFrom?: Date;
  /** Enregistrement serveur strictement avant cet instant. */
  readonly recordedBefore?: Date;
  /** Pagination par curseur : n'inclut que les entrées strictement antérieures à ce seq. */
  readonly beforeSeq?: number;
  readonly limit?: number;
}

export interface AuditLogEntry {
  readonly seq: number;
  readonly id: string;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly actorUserId: string;
  readonly actorRoles: readonly string[];
  readonly deviceId: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly reason: string | null;
  readonly result: string;
  readonly commandId: string | null;
}

export const AUDIT_LOG_DEFAULT_LIMIT = 50;
export const AUDIT_LOG_MAX_LIMIT = 200;

export async function listAuditLog(
  db: Kysely<DB> | Transaction<DB>,
  filter: AuditLogFilter = {},
): Promise<readonly AuditLogEntry[]> {
  const limit = Math.min(filter.limit ?? AUDIT_LOG_DEFAULT_LIMIT, AUDIT_LOG_MAX_LIMIT);

  let query = db.selectFrom('audit_audit_log').selectAll().orderBy('seq', 'desc').limit(limit);
  if (filter.entityType !== undefined) {
    query = query.where('entity_type', '=', filter.entityType);
  }
  if (filter.entityTypes !== undefined) {
    // Liste vide : aucune entité autorisée, donc aucune ligne (jamais `IN ()`).
    if (filter.entityTypes.length === 0) return [];
    query = query.where('entity_type', 'in', [...filter.entityTypes]);
  }
  if (filter.entityId !== undefined) {
    query = query.where('entity_id', '=', toBin(filter.entityId));
  }
  if (filter.actorUserId !== undefined) {
    query = query.where('actor_user_id', '=', toBin(filter.actorUserId));
  }
  if (filter.action !== undefined) {
    query = query.where('action', '=', filter.action);
  }
  if (filter.recordedFrom !== undefined) {
    query = query.where('recorded_at', '>=', filter.recordedFrom);
  }
  if (filter.recordedBefore !== undefined) {
    query = query.where('recorded_at', '<', filter.recordedBefore);
  }
  if (filter.beforeSeq !== undefined) {
    query = query.where('seq', '<', filter.beforeSeq);
  }

  const rows = await query.execute();
  return rows.map((row) => ({
    seq: Number(row.seq),
    id: fromBin(row.id),
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    actorUserId: fromBin(row.actor_user_id),
    actorRoles: row.actor_roles as readonly string[],
    deviceId: fromBinOrNull(row.device_id),
    action: row.action,
    entityType: row.entity_type,
    entityId: fromBinOrNull(row.entity_id),
    before: row.before,
    after: row.after,
    reason: row.reason,
    result: row.result,
    commandId: fromBinOrNull(row.command_id),
  }));
}

/**
 * Types d'entité présents dans le journal, triés (filtre de l'écran, RP-1) ; `restrictTo` borne le résultat
 * (Finance, AV-493). Un parcours d'index sur `(entity_type, entity_id)` : sans lecture des lignes.
 */
export async function listAuditEntityTypes(
  db: Kysely<DB> | Transaction<DB>,
  restrictTo?: readonly string[],
): Promise<readonly string[]> {
  if (restrictTo !== undefined && restrictTo.length === 0) return [];
  const rows = await db
    .selectFrom('audit_audit_log')
    .select('entity_type')
    .distinct()
    .$if(restrictTo !== undefined, (qb) => qb.where('entity_type', 'in', [...restrictTo!]))
    .orderBy('entity_type', 'asc')
    .execute();
  return rows.map((row) => row.entity_type);
}
