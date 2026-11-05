/**
 * Paiement avant livraison, vu par l'appareil (AV-511, AV-512, BR-VEN-034 ; décisions du porteur des 04 et
 * 05/11/2026) : une commande se reçoit sans argent, elle se livre payée — ou à crédit pour un client autorisé,
 * dans son plafond. Logique pure : les paramètres `sales.delivery_requires_full_payment` et
 * `sales.delivery_on_credit_allowed`, le reste dû, connu de l'appareil, des ventes d'une commande, et ce que
 * l'appareil sait du crédit du client.
 *
 * Le serveur juge seul : en ligne il refuse la livraison d'une vente non payée en entier à un client sans crédit
 * (`ORDER_NOT_PAID`) ou au-delà du plafond d'un client autorisé (`CREDIT_LIMIT_EXCEEDED`) ; hors ligne il
 * l'applique et la signale à la Finance (`DELIVERY_UNPAID`). L'appareil n'avertit que d'après ce qu'il sait —
 * les ventes du jeu `sales_recent` (sept derniers jours), les encaissements de l'outbox, le crédit du jeu
 * `customers` — et ne bloque jamais : une vente qu'il ne connaît pas, ou un paiement reçu ailleurs, ne doivent
 * pas l'empêcher d'enregistrer une remise déjà faite.
 */
import { creditCheck, xaf } from '@gic/domain';
import type { OutboxCommand } from '../../storage/db.js';
import { afterPendingPayments, pendingPaymentsOf, sortDues, type Due } from './collect.js';
import { settingValue } from './stock.js';
import type { SaleData, SettingData } from './types.js';

/** Paramètre qui exige la vente payée en entier avant de livrer une commande (AV-511, vrai par défaut). */
export const DELIVERY_REQUIRES_FULL_PAYMENT_SETTING = 'sales.delivery_requires_full_payment';

/** Paramètre qui permet de livrer à crédit un client autorisé au crédit, dans son plafond (AV-512, vrai par défaut). */
export const DELIVERY_ON_CREDIT_ALLOWED_SETTING = 'sales.delivery_on_credit_allowed';

/**
 * Livrer à crédit un client autorisé est-il permis depuis le site `siteId` ? Réglage du site, à défaut global ;
 * **à défaut vrai** : seule une valeur explicitement fausse l'interdit, comme au serveur.
 */
export function deliveryOnCreditAllowed(
  settings: readonly SettingData[],
  siteId: string | null | undefined,
  now: Date,
): boolean {
  return settingValue(settings, DELIVERY_ON_CREDIT_ALLOWED_SETTING, siteId, now) !== false;
}

/** Ce que l'écran de livraison dit du paiement (voir `deliveryPaymentView`). */
export type DeliveryPaymentView =
  | { readonly kind: 'NONE' }
  /** Le client paie d'abord : le serveur refusera en ligne. `noCredit` : parce qu'il n'a pas droit au crédit. */
  | { readonly kind: 'PAY_FIRST'; readonly amountXaf: number; readonly noCredit: boolean }
  /** Livraison à crédit, dans le plafond du client. */
  | {
      readonly kind: 'ON_CREDIT';
      readonly amountXaf: number;
      readonly limitXaf: number | null;
    }
  /** Client autorisé, mais son plafond (ou son absence) pourrait refuser la livraison. */
  | {
      readonly kind: 'CREDIT_OVER';
      readonly amountXaf: number;
      readonly limitXaf: number | null;
      readonly outstandingXaf: number;
    };

/**
 * Ce que l'appareil sait du paiement de la livraison. Pour un client autorisé au crédit, la livraison est un
 * crédit accordé ; l'encours de crédit du serveur (le seul remis non payé) ne dépasse jamais le reste à
 * encaisser que l'appareil connaît (`outstandingXaf`, corrigé des opérations en attente) : si celui-ci tient
 * dans le plafond, la livraison passe à coup sûr ; sinon elle **peut** être refusée (estimation prudente).
 */
export function deliveryPaymentView(input: {
  readonly required: boolean;
  readonly onCreditAllowed: boolean;
  /** Reste dû des ventes de la commande, tel que l'appareil le connaît (`unpaidOfOrder`). */
  readonly unpaidXaf: number;
  readonly customer:
    { readonly credit_allowed: boolean; readonly credit_limit_xaf: number | null } | undefined;
  /** Reste à encaisser du client connu de l'appareil, corrigé des opérations en attente (`localOutstanding`). */
  readonly outstandingXaf: number;
}): DeliveryPaymentView {
  if (!input.required || input.unpaidXaf <= 0) return { kind: 'NONE' };
  const customer = input.customer;
  if (!input.onCreditAllowed || customer === undefined || !customer.credit_allowed) {
    return { kind: 'PAY_FIRST', amountXaf: input.unpaidXaf, noCredit: input.onCreditAllowed };
  }
  const limitXaf = customer.credit_limit_xaf;
  const check = creditCheck({
    creditAllowed: true,
    creditLimitXaf: limitXaf === null ? null : xaf(limitXaf),
    outstandingXaf: xaf(0),
    newCreditXaf: xaf(input.outstandingXaf),
  });
  return check.outcome === 'EXCEEDS_LIMIT'
    ? {
        kind: 'CREDIT_OVER',
        amountXaf: input.unpaidXaf,
        limitXaf,
        outstandingXaf: input.outstandingXaf,
      }
    : { kind: 'ON_CREDIT', amountXaf: input.unpaidXaf, limitXaf };
}

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
