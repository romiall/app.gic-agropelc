/**
 * Permissions d'approbation du catalogue (`identity.permissions.is_approval`, RP-1) : les choix possibles
 * de l'approbateur d'une politique de contrôle (`approvals.policy.set`, ECR-ADM-07). Les permissions
 * retirées du catalogue (`deprecated_at`) ne sont pas proposées.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';

export interface ApprovalPermission {
  readonly code: string;
  readonly description: string;
}

export async function listApprovalPermissions(
  executor: Kysely<DB> | Transaction<DB>,
): Promise<readonly ApprovalPermission[]> {
  const rows = await executor
    .selectFrom('identity_permissions')
    .select(['code', 'description'])
    .where('is_approval', '=', 1)
    .where('deprecated_at', 'is', null)
    .orderBy('code', 'asc')
    .execute();
  return rows.map((row) => ({ code: row.code, description: row.description }));
}
