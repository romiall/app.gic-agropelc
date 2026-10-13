/**
 * Validations qui attendent la décision d'un utilisateur, pour l'accueil par rôle (ADR-030) : la
 * première page de la file de validation (`approvalInboxPage`, MP-07), sans les demandes de
 * l'utilisateur lui-même. Même portée que la décision (BR-ADM-018, RC-04) ; nul ne valide sa propre
 * demande (AV-010) ; un montant au coût et le résumé qui le porte sont masqués sans
 * `inventory.valuation.read` (RC-05). Lecture seule : la décision passe par
 * `approvals.request.approve` / `.reject`.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { approvalInboxPage } from './approval-inbox.js';

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
  const page = await approvalInboxPage(executor, {
    userId,
    at,
    limit,
    includeOwnRequests: false,
  });
  return page.items.map((item) => ({
    id: item.id,
    operationType: item.operationType,
    subjectSummary: item.subjectSummary,
    amountXaf: item.amountXaf,
    requestedAt: item.requestedAt,
  }));
}
