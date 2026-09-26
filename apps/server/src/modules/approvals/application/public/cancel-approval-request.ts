/**
 * `approvals.cancelApprovalRequest` : contrepartie de {@link requestApproval} pour le retrait
 * d'une demande **par son propriétaire, avant décision** (ex. SM-LOSS `inventory.loss.withdraw`,
 * « Déclarant, avant décision » → CANCELLED). Le module appelant a déjà vérifié que le
 * document (perte, écart…) est toujours dans l'état qui précède toute décision — un état
 * atteignable uniquement tant que la demande elle-même est `PENDING` (invariant maintenu par
 * construction : seul le gestionnaire de décision d'`approvals` fait sortir une demande de
 * `PENDING`, et il transitionne alors aussi le document). Idempotent : sans effet si la
 * demande n'est plus `PENDING` (décision déjà prise entre-temps).
 */
import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { recordRequesterChange } from '../approval-changes.js';

export interface CancelApprovalRequestInput {
  readonly requestId: string;
  readonly cancelledBy: string;
}

export async function cancelApprovalRequest(
  executor: Kysely<DB> | Transaction<DB>,
  input: CancelApprovalRequestInput,
): Promise<void> {
  const row = await executor
    .selectFrom('approvals_approval_requests')
    .select(['requested_by', 'status'])
    .where('id', '=', toBin(input.requestId))
    .executeTakeFirst();
  if (!row || row.status !== 'PENDING') return;
  await executor
    .updateTable('approvals_approval_requests')
    .set({
      status: 'CANCELLED',
      updated_by: toBin(input.cancelledBy),
      version: sql`version + 1`,
    })
    .where('id', '=', toBin(input.requestId))
    .where('status', '=', 'PENDING')
    .execute();
  await recordRequesterChange(executor, input.requestId, fromBin(row.requested_by));
}
