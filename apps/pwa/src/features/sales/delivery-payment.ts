/**
 * Paiement avant livraison, vu par l'appareil (AV-511, BR-VEN-034 ; décision du porteur du 04/11/2026) :
 * une commande se reçoit sans argent, elle se livre payée. Logique pure : le paramètre
 * `sales.delivery_requires_full_payment` et le reste dû, connu de l'appareil, des ventes d'une commande.
 *
 * Le serveur juge seul : en ligne il refuse la livraison d'une vente non payée en entier
 * (`ORDER_NOT_PAID`) ; hors ligne il l'applique et la signale à la Finance (`DELIVERY_UNPAID`). L'appareil
 * n'avertit que d'après ce qu'il sait — les ventes du jeu `sales_recent` (sept derniers jours) et les
 * encaissements de l'outbox — et ne bloque jamais : une vente qu'il ne connaît pas, ou un paiement reçu
 * ailleurs, ne doivent pas l'empêcher d'enregistrer une remise déjà faite.
 */
import type { OutboxCommand } from '../../storage/db.js';
import { afterPendingPayments, pendingPaymentsOf, sortDues, type Due } from './collect.js';
import { settingValue } from './stock.js';
import type { SaleData, SettingData } from './types.js';

/** Paramètre qui exige la vente payée en entier avant de livrer une commande (AV-511, vrai par défaut). */
export const DELIVERY_REQUIRES_FULL_PAYMENT_SETTING = 'sales.delivery_requires_full_payment';

/**
 * Le paiement complet est-il exigé pour livrer depuis le site `siteId` ? Réglage du site, à défaut global ;
 * **à défaut vrai** : seule une valeur explicitement fausse lève l'exigence, comme au serveur.
 */
export function deliveryPaymentRequired(
  settings: readonly SettingData[],
  siteId: string | null | undefined,
  now: Date,
): boolean {
  return settingValue(settings, DELIVERY_REQUIRES_FULL_PAYMENT_SETTING, siteId, now) !== false;
}

/**
 * Reste dû des ventes d'une commande, tel que l'appareil le connaît : solde des ventes confirmées de la
 * commande (jeu `sales_recent`), diminué des encaissements du client saisis sur l'appareil et pas encore
 * retéléchargés. Une vente en demande d'annulation n'est pas une cible payable. Vide : rien d'impayé de
 * connu (ce qui n'est pas une garantie, voir l'en-tête).
 */
export function unpaidOfOrder(input: {
  readonly sales: readonly SaleData[];
  readonly outbox: readonly OutboxCommand[];
  readonly orderId: string;
  readonly customerId: string;
  /** Comptes absorbés : leurs encaissements sont ceux du compte conservé (BR-CRM-007). */
  readonly alias: ReadonlyMap<string, string>;
}): Due[] {
  const dues = input.sales
    .filter(
      (sale) =>
        sale.order_id === input.orderId && sale.status === 'CONFIRMED' && sale.balance_due_xaf > 0,
    )
    .map((sale): Due => ({
      saleId: sale.id,
      docNumber: sale.doc_number,
      dueDate: sale.due_date,
      occurredAt: sale.occurred_at,
      balanceXaf: sale.balance_due_xaf,
    }));
  if (dues.length === 0) return [];
  const customerId = input.alias.get(input.customerId) ?? input.customerId;
  return afterPendingPayments(
    sortDues(dues),
    pendingPaymentsOf(input.outbox, customerId, input.alias),
  );
}
