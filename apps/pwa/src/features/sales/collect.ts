/**
 * Règlement des créances d'un client (ECR-VEN-06) : créances connues et aperçu de l'affectation
 * automatique d'un encaissement, comme le serveur la fera (BR-FIN-004 : échéance la plus ancienne
 * d'abord ; le reste devient un crédit du client). Encaissement ciblé (MP-09 : « Encaisser le reste
 * dû » depuis le reçu) : affecté à la seule vente désignée (`allocations[]`), le surplus restant en
 * crédit du client, comme le serveur le fait d'une affectation explicite. Logique pure.
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

export function duesFromRecentSales(
  sales: readonly SaleData[],
  customerId: string,
  /** Comptes absorbés : leurs ventes sont dues par le compte conservé (BR-CRM-007). */
  alias: ReadonlyMap<string, string> = new Map(),
): Due[] {
  return sortDues(
    sales
      .filter(
        (sale) =>
          sale.customer_id !== null &&
          (alias.get(sale.customer_id) ?? sale.customer_id) === customerId &&
          // Une vente en demande d'annulation n'est pas une cible payable (`ALLOCATION_TARGET_INVALID`).
          sale.status === 'CONFIRMED' &&
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

/**
 * Échéance la plus ancienne d'abord, une créance sans échéance en dernier, puis vente la plus
 * ancienne, puis identifiant (même ordre que l'affectation automatique du serveur, BR-FIN-004).
 */
export function sortDues(dues: readonly Due[]): Due[] {
  const byDue = (a: Due, b: Due): number => {
    if (a.dueDate === b.dueDate) return 0;
    if (a.dueDate === null) return 1;
    if (b.dueDate === null) return -1;
    return a.dueDate.localeCompare(b.dueDate);
  };
  return [...dues].sort(
    (a, b) =>
      byDue(a, b) || a.occurredAt.localeCompare(b.occurredAt) || a.saleId.localeCompare(b.saleId),
  );
}

/** Affectation explicite d'un encaissement à une vente (`allocations[]` de `sales.payment.record`). */
export interface SaleTarget {
  readonly saleId: string;
  readonly amountXaf: number;
}

/** Encaissement déjà saisi : montant et, s'il a été ciblé, ses affectations aux ventes. */
export interface PendingAmount {
  readonly amountXaf: number;
  /** `null` : affectation automatique par le serveur. */
  readonly targets: readonly SaleTarget[] | null;
}

/**
 * Créances restant dues une fois affectés, dans l'ordre de la file, les encaissements du client déjà
 * saisis sur l'appareil et pas encore envoyés : l'aperçu du nouvel encaissement part de là. Un
 * encaissement ciblé ne règle que ses ventes (le surplus est un crédit du client).
 */
export function afterPendingPayments(
  dues: readonly Due[],
  pendingPayments: readonly PendingAmount[],
): Due[] {
  let remaining = [...dues];
  for (const pending of pendingPayments) {
    if (pending.amountXaf <= 0) continue;
    const paid = new Map<string, number>();
    if (pending.targets) {
      for (const target of pending.targets) {
        const due = remaining.find((candidate) => candidate.saleId === target.saleId);
        if (due) paid.set(due.saleId, Math.min(target.amountXaf, due.balanceXaf));
      }
    } else {
      const { allocations } = allocatePayment(
        xaf(pending.amountXaf),
        remaining.map((due) => ({ targetId: due.saleId, balanceXaf: xaf(due.balanceXaf) })),
      );
      for (const allocation of allocations) paid.set(allocation.targetId, allocation.amountXaf);
    }
    remaining = remaining
      .map((due) => ({ ...due, balanceXaf: due.balanceXaf - (paid.get(due.saleId) ?? 0) }))
      .filter((due) => due.balanceXaf > 0);
  }
  return remaining;
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

/**
 * Encaissement ciblé sur une vente : toute la vente si le montant suffit, sinon le montant ; le
 * surplus reste en crédit du client. `null` si la vente n'est plus parmi les créances connues (déjà
 * réglée, annulée) : l'écran revient alors à l'affectation automatique.
 */
export function previewTargetedAllocation(
  amountXaf: number,
  dues: readonly Due[],
  saleId: string,
): AllocationPreview | null {
  const due = dues.find((candidate) => candidate.saleId === saleId);
  if (!due) return null;
  if (amountXaf <= 0) return { lines: [], creditXaf: 0 };
  const allocated = Math.min(amountXaf, due.balanceXaf);
  return { lines: [{ due, amountXaf: allocated }], creditXaf: amountXaf - allocated };
}

/** Affectations explicites d'un aperçu (charge utile `allocations`). */
export function allocationsOf(preview: AllocationPreview): SaleTarget[] {
  return preview.lines
    .filter((line) => line.amountXaf > 0)
    .map((line) => ({ saleId: line.due.saleId, amountXaf: line.amountXaf }));
}

/** Encaissements du client saisis sur l'appareil et pas encore acceptés par le serveur. */
export function pendingPaymentsOf(
  outbox: readonly OutboxCommand[],
  customerId: string,
  alias: ReadonlyMap<string, string> = new Map(),
): ({ readonly commandId: string; readonly occurredAt: string } & PendingAmount)[] {
  return outbox
    .filter((command) => {
      if (command.command_type !== 'sales.payment.record') return false;
      if (!['LOCAL_ONLY', 'PENDING_SYNC', 'SYNCING'].includes(command.status)) return false;
      const payer = (command.payload as { customerId?: string }).customerId;
      return payer !== undefined && (alias.get(payer) ?? payer) === customerId;
    })
    .map((command) => {
      const payload = command.payload as {
        amountXaf?: number;
        allocations?: readonly { saleId?: string; orderId?: string; amountXaf?: number }[];
      };
      return {
        commandId: command.command_id,
        amountXaf: payload.amountXaf ?? 0,
        occurredAt: command.occurred_at,
        // Une affectation à une commande n'est pas une créance : elle ne règle aucune vente.
        targets: payload.allocations
          ? payload.allocations.flatMap((target) =>
              target.saleId ? [{ saleId: target.saleId, amountXaf: target.amountXaf ?? 0 }] : [],
            )
          : null,
      };
    });
}
