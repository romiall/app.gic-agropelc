/**
 * Encours d'un client vu par l'appareil, pour l'avertissement de crédit (BR-VEN-025, `creditCheck`) :
 * l'encours téléchargé (`outstanding_xaf`, jeu `customers`) corrigé des opérations de l'appareil pas
 * encore retrouvées dans ce jeu (ADR-051 §3) — ventes avec un reste dû et commandes passées (total
 * estimé moins acompte) l'augmentent, encaissements le diminuent. Logique pure, indicative : le
 * serveur reste juge du crédit.
 */
import { lineAmountXaf, quantityFromDecimal, xaf } from '@gic/domain';
import type { OutboxCommand } from '../../storage/db.js';
import { stillInFlight } from './pending.js';

interface LineLike {
  readonly quantityBase?: number;
  readonly weightKg?: number;
  readonly unitPriceXaf?: number;
  readonly discountXaf?: number;
}

function linesTotal(lines: readonly LineLike[] | undefined): number {
  let total = 0;
  for (const line of lines ?? []) {
    const quantity = line.weightKg ?? line.quantityBase ?? 0;
    const price = line.unitPriceXaf ?? 0;
    if (quantity <= 0 || price < 0) continue;
    total += lineAmountXaf(quantityFromDecimal(quantity), xaf(price)) - (line.discountXaf ?? 0);
  }
  return total;
}

const paid = (payments: readonly { readonly amountXaf?: number }[] | undefined): number =>
  (payments ?? []).reduce((sum, payment) => sum + (payment.amountXaf ?? 0), 0);

export function localOutstanding(
  customer: { readonly id: string; readonly outstanding_xaf: number },
  outbox: readonly OutboxCommand[],
  customersPulledAt: string | undefined,
  /** Comptes absorbés : leurs opérations comptent pour le compte conservé (encours servi agrégé). */
  alias: ReadonlyMap<string, string> = new Map(),
): number {
  let outstanding = customer.outstanding_xaf;
  for (const command of outbox) {
    if (!stillInFlight(command, customersPulledAt)) continue;
    const payload = command.payload as {
      readonly customerId?: string;
      readonly lines?: readonly LineLike[];
      readonly payments?: readonly { readonly amountXaf?: number }[];
      readonly advancePayments?: readonly { readonly amountXaf?: number }[];
      readonly amountXaf?: number;
    };
    if (
      !payload.customerId ||
      (alias.get(payload.customerId) ?? payload.customerId) !== customer.id
    ) {
      continue;
    }
    try {
      if (command.command_type === 'sales.sale.record') {
        outstanding += Math.max(0, linesTotal(payload.lines) - paid(payload.payments));
      } else if (command.command_type === 'sales.order.place') {
        outstanding += Math.max(0, linesTotal(payload.lines) - paid(payload.advancePayments));
      } else if (command.command_type === 'sales.payment.record') {
        outstanding -= payload.amountXaf ?? 0;
      }
    } catch {
      // Charge utile hors des bornes du domaine : ignorée pour un avertissement indicatif.
    }
  }
  return Math.max(0, outstanding);
}
