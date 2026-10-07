/**
 * Validations qui attendent la décision d'un utilisateur (accueil par rôle, ADR-030 ; ECR-ADM-08).
 * Une demande `PENDING` attend la personne qui détient, à l'instant de la lecture, la permission
 * d'approbation de la politique figée sur la demande ; nul ne valide sa propre demande (AV-010).
 * Lecture seule : la décision passe par `approvals.request.approve` / `.reject`.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { hasPermissionAt } from '../../../identity/application/public/index.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface PendingApproval {
  readonly id: string;
  readonly operationType: string;
  readonly subjectSummary: string;
  readonly amountXaf: number | null;
  readonly requestedAt: Date;
}

export async function pendingApprovalsFor(
  executor: Executor,
  userId: string,
  at: Date,
  limit = 50,
): Promise<readonly PendingApproval[]> {
  const rows = await executor
    .selectFrom('approvals_approval_requests as r')
    .leftJoin('approvals_control_policies as p', 'p.id', 'r.policy_id')
    .select([
      'r.id as id',
      'r.operation_type as operation_type',
      'r.subject_summary as subject_summary',
      'r.amount_xaf as amount_xaf',
      'r.requested_at as requested_at',
      'p.approver_permission as approver_permission',
    ])
    .where('r.status', '=', 'PENDING')
    .where('r.requested_by', '<>', toBin(userId))
    .orderBy('r.requested_at', 'asc')
    .limit(500)
    .execute();
  const permissions = new Map<string, boolean>();
  const mine: PendingApproval[] = [];
  for (const row of rows) {
    const permission = row.approver_permission;
    if (permission === null) continue;
    if (!permissions.has(permission)) {
      permissions.set(permission, await hasPermissionAt(executor, toBin(userId), permission, at));
    }
    if (!permissions.get(permission)) continue;
    mine.push({
      id: fromBin(row.id),
      operationType: row.operation_type,
      subjectSummary: row.subject_summary,
      amountXaf: row.amount_xaf === null ? null : Number(row.amount_xaf),
      requestedAt: row.requested_at,
    });
  }
  return mine.slice(0, limit);
}
