/**
 * Sous-totaux par vendeur d'une session de caisse (P5-14 ; AV-155, AV-187 ; ADR-032 « Conséquences ») :
 * composition **dans la couche de transport**, parce que `finance` (registre et sessions) n'importe pas
 * `sales` (vendeur d'un encaissement). Chaque module garde ses lectures ; ce fichier ne fait que les
 * assembler, comme `production-api/` pour le chiffre d'affaires des lots. La route
 * `GET /cash-sessions/{id}` qui l'exposera, avec ses droits, est P5-17.
 */
import type { Kysely, Transaction } from 'kysely';
import { sellerCashSubtotals, type SellerCashSubtotal } from '@gic/domain';
import type { DB } from '../platform/kysely/database.js';
import {
  cashSessionWindowFlows,
  findCashSessionSummary,
  type CashSessionWindowFlows,
} from '../modules/finance/application/public/index.js';
import { paymentReceivers } from '../modules/sales/application/public/index.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface CashSessionSellerSubtotals {
  readonly sessionId: string;
  readonly status: 'OPEN' | 'PENDING_VALIDATION' | 'VALIDATED';
  readonly window: { readonly from: Date; readonly to: Date | null };
  readonly openingCountedXaf: number;
  readonly sellers: readonly SellerCashSubtotal[];
  /** Encaissements dont le vendeur est introuvable (garde défensive). */
  readonly unattributedReceivedXaf: number;
  /** Flux non attribués à un vendeur : remboursements, remises, dépenses (AV-187). */
  readonly otherMovements: CashSessionWindowFlows['others'];
  readonly netFlowsXaf: number;
  /** Attendu courant de la fenêtre (fonds d'ouverture + flux), recalculé sur le registre. */
  readonly expectedNowXaf: number;
}

export async function cashSessionSellerSubtotals(
  executor: Executor,
  sessionId: string,
): Promise<CashSessionSellerSubtotals | undefined> {
  const session = await findCashSessionSummary(executor, sessionId);
  if (!session) return undefined;
  const flows = await cashSessionWindowFlows(executor, session);
  const receivers = await paymentReceivers(
    executor,
    flows.payments.map((payment) => payment.paymentId),
  );
  const subtotals = sellerCashSubtotals(flows.payments, (id) => receivers.get(id) ?? null);
  return {
    sessionId: session.id,
    status: session.status,
    window: { from: session.openedAt, to: session.closedAt },
    openingCountedXaf: session.openingCountedXaf,
    sellers: subtotals.sellers,
    unattributedReceivedXaf: subtotals.unattributedReceivedXaf,
    otherMovements: flows.others,
    netFlowsXaf: flows.netFlowsXaf,
    expectedNowXaf: session.openingCountedXaf + flows.netFlowsXaf,
  };
}
