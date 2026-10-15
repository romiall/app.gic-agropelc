/**
 * Validations qui attendent la décision d'un utilisateur, pour l'accueil par rôle (ADR-030) : la
 * file de validation (`approvalInboxPage`, MP-07), même lecture que l'écran. Même portée que la
 * décision (BR-ADM-018, RC-04) ; nul ne valide sa propre demande, sauf la Direction avec le marqueur
 * explicite (AV-010, INV-ADM-02) : ses propres demandes comptent donc pour elle, comme dans la file
 * (MP-11, revue adverse). Un montant au coût et le résumé qui le porte sont masqués sans
 * `inventory.valuation.read` (RC-05). Lecture seule : la décision passe par
 * `approvals.request.approve` / `.reject`.
 *
 * Décompte (MP-11) : exact jusqu'à `PENDING_APPROVALS_CAP` demandes ; au-delà, `truncated` (l'accueil
 * annonce « plus de 100 »). Chaque demande lue coûte une évaluation des droits : l'accueil, relu
 * régulièrement, n'en lit jamais plus que le plafond (une page de 50 avant MP-11).
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { approvalInboxPage, canSelfApproveAt } from './approval-inbox.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface PendingApproval {
  readonly id: string;
  readonly operationType: string;
  readonly subjectSummary: string;
  readonly amountXaf: number | null;
  readonly requestedAt: Date;
}

export interface PendingApprovals {
  /** Demandes lues, la plus ancienne d'abord (au plus le plafond). */
  readonly items: readonly PendingApproval[];
  /** Nombre de demandes en attente, borné par le plafond. */
  readonly total: number;
  /** Plus de demandes que le plafond. */
  readonly truncated: boolean;
}

export const PENDING_APPROVALS_CAP = 100;
/** Appels de la file au plus (chacun parcourt au plus 2 000 demandes, `approvalInboxPage`). */
const MAX_PAGES = 5;

export async function pendingApprovalsFor(
  executor: Executor,
  userId: string,
  at: Date,
  options: { readonly cap?: number } = {},
): Promise<PendingApprovals> {
  const cap = options.cap ?? PENDING_APPROVALS_CAP;
  const includeOwnRequests = await canSelfApproveAt(executor, userId, at);
  const items: PendingApproval[] = [];
  let afterId: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    // Une demande de plus que le plafond : savoir s'il est dépassé.
    const result = await approvalInboxPage(executor, {
      userId,
      at,
      limit: cap + 1 - items.length,
      includeOwnRequests,
      ...(afterId !== undefined ? { afterId } : {}),
    });
    for (const item of result.items) {
      items.push({
        id: item.id,
        operationType: item.operationType,
        subjectSummary: item.subjectSummary,
        amountXaf: item.amountXaf,
        requestedAt: item.requestedAt,
      });
    }
    if (items.length > cap) return { items: items.slice(0, cap), total: cap, truncated: true };
    if (result.nextCursor === null) return { items, total: items.length, truncated: false };
    afterId = result.nextCursor;
  }
  // File parcourue au maximum sans conclure (plus de 10 000 demandes en attente) : bornée.
  return { items, total: items.length, truncated: true };
}
