/**
 * Compteur de validations en attente d'un utilisateur (P9-15 ; ADR-076 §4) : le nombre de demandes qu'il peut
 * décider à l'instant de la lecture, selon la **même évaluation exacte** que sa file (`approvalInboxPage` :
 * `evaluateAccess` demande par demande, jamais un `COUNT` SQL qui rendrait un sur-ensemble).
 *
 * C'est un balayage borné : il lit la file par pages jusqu'au plafond `cap` ; au-delà, le compte vaut `cap` et
 * `capped` est vrai (« plus de N »). Le plafond est un paramètre (`analytics.pending_approvals_count_cap`, 500).
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { approvalInboxPage } from './approval-inbox.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface PendingApprovalsCount {
  readonly count: number;
  /** Vrai quand le plafond est atteint : il y en a au moins `count`, peut-être plus. */
  readonly capped: boolean;
}

const PAGE_SIZE = 100;
/** Pages au plus : borne dure contre une file qui ne finit pas (le plafond arrête avant en pratique). */
const MAX_PAGES = 200;

export async function countPendingApprovalsFor(
  executor: Executor,
  input: {
    readonly userId: string;
    readonly at: Date;
    readonly cap: number;
    readonly includeOwnRequests?: boolean;
  },
): Promise<PendingApprovalsCount> {
  let count = 0;
  let afterId: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await approvalInboxPage(executor, {
      userId: input.userId,
      at: input.at,
      ...(afterId !== undefined ? { afterId } : {}),
      limit: PAGE_SIZE,
      includeOwnRequests: input.includeOwnRequests ?? false,
    });
    count += result.items.length;
    if (count >= input.cap) return { count: input.cap, capped: true };
    if (result.nextCursor === null) return { count, capped: false };
    afterId = result.nextCursor;
  }
  return { count, capped: true };
}
