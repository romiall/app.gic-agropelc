/**
 * Règlement des créances d'un client (ECR-VEN-06) : créances connues et aperçu de l'affectation
 * automatique d'un encaissement, comme le serveur la fera (BR-FIN-004 : échéance la plus ancienne
 * d'abord ; le reste devient un crédit du client). Logique pure.
 *
 * Sources : en ligne, `GET /api/v1/receivables?customer_id=` (toutes les créances du client) ; hors
 * ligne, les ventes du jeu `sales_recent` (7 derniers jours seulement) : l'aperçu est alors partiel,
 * l'encours du client (`outstanding_xaf`) restant la référence.
 */
import { allocatePayment, xaf } from '@gic/domain';
import type { OutboxCommand } from '../../storage/db.js';
import type { SaleData } from './types.js';

export interface Due {
  readonly saleId: string;
  readonly docNumber: string;
  /** Échéance `AAAA-MM-JJ` ; `null` si inconnue (vente au comptant restée impayée). */
  readonly dueDate: string | null;
  readonly occurredAt: string;
  readonly balanceXaf: number;
}

/** Ligne de `GET /api/v1/receivables` dont l'écran dépend. */
export interface ReceivableLine {
  readonly saleId: string;
  readonly docNumber: string;
  readonly customerId: string | null;
  readonly occurredAt: string;
  readonly dueDate: string;
  readonly balanceDueXaf: number;
}

export function duesFromReceivables(lines: readonly ReceivableLine[], customerId: string): Due[] {
  return sortDues(
    lines
      .filter((line) => line.customerId === customerId && line.balanceDueXaf > 0)
      .map((line) => ({
        saleId: line.saleId,
        docNumber: line.docNumber,
        dueDate: line.dueDate,
        occurredAt: line.occurredAt,
        balanceXaf: line.balanceDueXaf,
      })),
  );
}

export function duesFromRecentSales(sales: readonly SaleData[], customerId: string): Due[] {
  return sortDues(
    sales
      .filter(
        (sale) =>
          sale.customer_id === customerId &&
          sale.status !== 'CANCELLED' &&
          sale.balance_due_xaf > 0,
      )
      .map((sale) => ({
        saleId: sale.id,
        docNumber: sale.doc_number,
        dueDate: sale.due_date,
        occurredAt: sale.occurred_at,
        balanceXaf: sale.balance_due_xaf,
      })),
  );
}

/** Échéance la plus ancienne d'abord, puis vente la plus ancienne (BR-FIN-004). */
export function sortDues(dues: readonly Due[]): Due[] {
  return [...dues].sort(
    (a, b) =>
      (a.dueDate ?? '').localeCompare(b.dueDate ?? '') || a.occurredAt.localeCompare(b.occurredAt),
  );
}

export interface AllocationPreview {
  readonly lines: readonly { readonly due: Due; readonly amountXaf: number }[];
  /** Part non affectée : crédit du client. */
  readonly creditXaf: number;
}

export function previewAllocation(amountXaf: number, dues: readonly Due[]): AllocationPreview {
  if (amountXaf <= 0) return { lines: [], creditXaf: 0 };
  const result = allocatePayment(
    xaf(amountXaf),
    dues.map((due) => ({ targetId: due.saleId, balanceXaf: xaf(due.balanceXaf) })),
  );
  const byId = new Map(dues.map((due) => [due.saleId, due]));
  return {
    lines: result.allocations.flatMap((allocation) => {
      const due = byId.get(allocation.targetId);
      return due ? [{ due, amountXaf: allocation.amountXaf }] : [];
    }),
    creditXaf: result.unallocatedXaf,
  };
}

/** Encaissements du client saisis sur l'appareil et pas encore acceptés par le serveur. */
export function pendingPaymentsOf(
  outbox: readonly OutboxCommand[],
  customerId: string,
): { readonly commandId: string; readonly amountXaf: number; readonly occurredAt: string }[] {
  return outbox
    .filter(
      (command) =>
        command.command_type === 'sales.payment.record' &&
        ['LOCAL_ONLY', 'PENDING_SYNC', 'SYNCING'].includes(command.status) &&
        (command.payload as { customerId?: string }).customerId === customerId,
    )
    .map((command) => ({
      commandId: command.command_id,
      amountXaf: (command.payload as { amountXaf?: number }).amountXaf ?? 0,
      occurredAt: command.occurred_at,
    }));
}
