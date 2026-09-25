/**
 * Lecture des politiques de contrôle actives (BR-ADM-016 : « en vigueur à `occurred_at` »).
 * Plusieurs politiques peuvent être actives simultanément pour un même `operation_type`
 * (différenciées par `condition` — catégorie, seuils, site/zone, D01 dictionnaire) :
 * l'appelant choisit celle qui s'applique à son opération précise, ce module ne le fait pas
 * (`condition` n'est jamais interrogée comme donnée métier ici).
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin } from '../../../../platform/kysely/uuid-columns.js';
import type { OperationType } from '../commands/operation-types.js';

export interface ActiveControlPolicy {
  readonly id: string;
  readonly code: string;
  readonly version: number;
  readonly operationType: string;
  readonly condition: unknown;
  readonly requiresPhoto: boolean;
  readonly requiresComment: boolean;
  readonly requiresApproval: boolean;
  readonly approverPermission: string | null;
  readonly approverScope: string | null;
}

export async function currentPolicies(
  executor: Kysely<DB> | Transaction<DB>,
  operationType: OperationType,
  at: Date,
): Promise<readonly ActiveControlPolicy[]> {
  const rows = await executor
    .selectFrom('approvals_control_policies')
    .selectAll()
    .where('operation_type', '=', operationType)
    .where('status', '=', 'ACTIVE')
    .where('valid_from', '<=', at)
    .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', at)]))
    .execute();
  return rows.map((row) => ({
    id: fromBin(row.id),
    code: row.code,
    version: row.version,
    operationType: row.operation_type,
    condition: row.condition,
    requiresPhoto: Boolean(row.requires_photo),
    requiresComment: Boolean(row.requires_comment),
    requiresApproval: Boolean(row.requires_approval),
    approverPermission: row.approver_permission,
    approverScope: row.approver_scope,
  }));
}
