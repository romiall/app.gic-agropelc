/**
 * `audit.log.read` (07-security-rbac/03-audit.md §6) : lecture filtrée du journal, la plus
 * récente d'abord. La restriction de portée par rôle (ex. Finance limitée aux entités
 * financières) est une évaluation de portée RBAC, hors périmètre ici (P0-10) — seule
 * l'existence du droit est vérifiée par l'appelant (transport, `audit-api/`), comme le
 * pipeline de commande (P0-06, RC-01 minimal).
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../platform/kysely/uuid-columns.js';

export interface AuditLogFilter {
  readonly entityType?: string;
  readonly entityId?: string;
  readonly actorUserId?: string;
  readonly action?: string;
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
  if (filter.entityId !== undefined) {
    query = query.where('entity_id', '=', toBin(filter.entityId));
  }
  if (filter.actorUserId !== undefined) {
    query = query.where('actor_user_id', '=', toBin(filter.actorUserId));
  }
  if (filter.action !== undefined) {
    query = query.where('action', '=', filter.action);
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
