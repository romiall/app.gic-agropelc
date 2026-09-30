/**
 * Règles partagées des ventes (D04-VEN, D09-FIN ; SM-ORDER, SM-SALE, SM-CUSTOMER-PAYMENT ;
 * ADR-013, ADR-025, ADR-028) : quantité de tarification (poids), montant d'une ligne, remise et
 * plafond par rôle, crédit, vente anonyme, statut de paiement, affectation d'un encaissement,
 * délai d'annulation, échéance et ancienneté d'une créance, montant d'une annulation partielle,
 * quantités d'une ligne de commande, statut dérivé d'une commande et ajustement d'une commande
 * confirmée. Pur, sans entrée-sortie, identique sur l'appareil (vente hors ligne) et le serveur
 * (ADR-021). Quantités en millièmes entiers (`Quantity`), montants en XAF entiers (ADR-013) ;
 * seuils fournis par l'appelant depuis les paramètres système (CLAUDE.md règle 8).
 */
import { DomainError, assertSafeInteger } from './errors.js';
import { addXaf, xaf, type Xaf } from './money.js';
import {
  ZERO_QUANTITY,
  isPositiveQuantity,
  quantityFromMilli,
  quantityMilliUnits,
  type Quantity,
} from './quantity.js';
import { lineAmountXaf } from './rounding.js';
import { addBusinessDays, businessDayOf, businessDayStartUtc } from './business-day.js';

export type PricingMode = 'PER_UNIT' | 'PER_WEIGHT';

/**
 * BR-VEN-013, BR-CAT-009, AV-031 : quantité sur laquelle porte le prix. À l'unité, la quantité en
 * unité de base (le poids éventuel n'est qu'une information) ; au poids, le poids pesé en kg,
 * obligatoire (`WEIGHT_REQUIRED`). Quantité de base strictement positive (`SALE_LINE_INVALID`).
 */
export function pricingQuantity(input: {
  readonly pricingMode: PricingMode;
  readonly quantityBase: Quantity;
  readonly weightKg?: Quantity | null;
}): Quantity {
  if (!isPositiveQuantity(input.quantityBase)) {
    throw new DomainError('Quantité strictement positive attendue.', 'SALE_LINE_INVALID');
  }
  if (input.pricingMode === 'PER_UNIT') return input.quantityBase;
  if (
    input.weightKg === undefined ||
    input.weightKg === null ||
    !isPositiveQuantity(input.weightKg)
  ) {
    throw new DomainError(
      'Produit vendu au poids : poids pesé (kg) strictement positif attendu.',
      'WEIGHT_REQUIRED',
    );
  }
  return input.weightKg;
}

/** Pourcentage à deux décimales au plus, en points de base (1 % = 100). */
function percentToBasisPoints(percent: number, code: string): number {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new DomainError(`Pourcentage entre 0 et 100 attendu (reçu ${percent}).`, code);
  }
  const bp = Math.round(percent * 100);
  if (Math.abs(bp - percent * 100) > 1e-6) {
    throw new DomainError(`Pourcentage à deux décimales au plus (reçu ${percent}).`, code);
  }
  return bp;
}

/**
 * Remise exprimée en pourcentage d'un montant de ligne, convertie en XAF entiers : arrondi au
 * franc, demi supérieur (DÉDUIT d'AV-060, la remise en pourcentage n'étant pas définie).
 */
export function discountFromPercentXaf(grossXaf: Xaf, percent: number): Xaf {
  const bp = percentToBasisPoints(percent, 'DISCOUNT_INVALID');
  const numerator = grossXaf * bp;
  assertSafeInteger(numerator, 'discountFromPercentXaf (produit intermédiaire)');
  return xaf(Math.floor((numerator + 5000) / 10000));
}

export interface SaleLineAmounts {
  /** Quantité de tarification × prix appliqué, arrondi au franc (BR-VEN-014). */
  readonly grossXaf: Xaf;
  readonly discountXaf: Xaf;
  /** Montant de la ligne = brut − remise (INV-VEN-03). */
  readonly lineTotalXaf: Xaf;
  /** Même quantité au prix catalogue ; `null` sans prix catalogue (aucune règle trouvée). */
  readonly listAmountXaf: Xaf | null;
}

/**
 * BR-VEN-014, INV-VEN-03, AV-060 : montant de ligne = arrondi(quantité de tarification × prix
 * appliqué) − remise ; la remise ne dépasse pas le brut (`DISCOUNT_INVALID`).
 */
export function saleLineAmounts(input: {
  readonly pricingQuantity: Quantity;
  readonly unitPriceXaf: Xaf;
  readonly discountXaf?: Xaf;
  readonly listUnitPriceXaf?: Xaf | null;
}): SaleLineAmounts {
  if (!isPositiveQuantity(input.pricingQuantity)) {
    throw new DomainError(
      'Quantité de tarification strictement positive attendue.',
      'SALE_LINE_INVALID',
    );
  }
  const grossXaf = lineAmountXaf(input.pricingQuantity, xaf(input.unitPriceXaf));
  const discountXaf = xaf(input.discountXaf ?? 0);
  if (discountXaf > grossXaf) {
    throw new DomainError('La remise ne peut dépasser le montant de la ligne.', 'DISCOUNT_INVALID');
  }
  const list = input.listUnitPriceXaf;
  return {
    grossXaf,
    discountXaf,
    lineTotalXaf: xaf(grossXaf - discountXaf),
    listAmountXaf:
      list === undefined || list === null ? null : lineAmountXaf(input.pricingQuantity, xaf(list)),
  };
}

export interface SaleTotals {
  readonly subtotalXaf: Xaf;
  readonly discountTotalXaf: Xaf;
  /** Prix TTC, aucune ventilation fiscale (AV-041) : toujours 0. */
  readonly taxTotalXaf: Xaf;
  readonly totalXaf: Xaf;
}

/** Totaux d'une vente ou d'une commande : Σ des lignes arrondies (total = sous-total − remises). */
export function saleTotals(
  lines: readonly Pick<SaleLineAmounts, 'grossXaf' | 'discountXaf' | 'lineTotalXaf'>[],
): SaleTotals {
  if (lines.length === 0) {
    throw new DomainError('Une vente comporte au moins une ligne.', 'SALE_EMPTY');
  }
  return {
    subtotalXaf: addXaf(...lines.map((line) => line.grossXaf)),
    discountTotalXaf: addXaf(...lines.map((line) => line.discountXaf)),
    taxTotalXaf: xaf(0),
    totalXaf: addXaf(...lines.map((line) => line.lineTotalXaf)),
  };
}

/**
 * Plafond de remise d'un utilisateur à plusieurs rôles (AV-026, RC-06) : le plus élevé des
 * plafonds des rôles qui accordent `sales.price.override` (DÉDUIT) ; `null` si aucun ne l'accorde.
 * Un rôle qui accorde la permission sans plafond compte pour 0 %.
 */
export function maxDiscountPctOf(limits: readonly (number | null | undefined)[]): number | null {
  if (limits.length === 0) return null;
  return limits.reduce<number>((max, limit) => {
    const value = limit ?? 0;
    percentToBasisPoints(value, 'DISCOUNT_LIMIT_INVALID');
    return Math.max(max, value);
  }, 0);
}

export type PriceOverrideOutcome =
  /** Prix appliqué = prix catalogue : aucune dérogation. */
  | 'NONE'
  /** Dérogation dans le plafond du rôle, avec motif. */
  | 'WITHIN_LIMIT'
  /** Remise au-delà du plafond : ligne enregistrée, validation `PRICE_OVERRIDE` (BR-VEN-015). */
  | 'EXCEEDS_LIMIT'
  /** Aucun prix catalogue pour mesurer la remise (BR-PRX-009) : validation `PRICE_OVERRIDE`. */
  | 'NO_REFERENCE_PRICE'
  /** Dérogation sans `sales.price.override` (AV-026). */
  | 'NOT_PERMITTED';

/**
 * BR-VEN-015, AV-026 : une ligne dont le montant diffère du montant au prix catalogue est une
 * dérogation, qui exige `sales.price.override` (`maxDiscountPct` non nul). La remise se mesure
 * sur le montant au prix catalogue, en points de base arrondis au supérieur (5,001 % dépasse
 * 5 %) ; un prix supérieur au catalogue est une dérogation sans remise (DÉDUIT).
 */
export function priceOverrideCheck(input: {
  readonly listAmountXaf: Xaf | null;
  readonly lineTotalXaf: Xaf;
  readonly maxDiscountPct: number | null;
}): { readonly outcome: PriceOverrideOutcome; readonly discountBp: number | null } {
  const list = input.listAmountXaf;
  if (list !== null && input.lineTotalXaf === list) return { outcome: 'NONE', discountBp: 0 };
  if (input.maxDiscountPct === null) {
    return {
      outcome: 'NOT_PERMITTED',
      discountBp: list === null ? null : discountBasisPoints(list, input.lineTotalXaf),
    };
  }
  const limitBp = percentToBasisPoints(input.maxDiscountPct, 'DISCOUNT_LIMIT_INVALID');
  if (list === null) return { outcome: 'NO_REFERENCE_PRICE', discountBp: null };
  const discountBp = discountBasisPoints(list, input.lineTotalXaf);
  return { outcome: discountBp <= limitBp ? 'WITHIN_LIMIT' : 'EXCEEDS_LIMIT', discountBp };
}

function discountBasisPoints(listXaf: Xaf, lineTotalXaf: Xaf): number {
  if (lineTotalXaf >= listXaf || listXaf === 0) return 0;
  const numerator = (listXaf - lineTotalXaf) * 10000;
  assertSafeInteger(numerator, 'discountBasisPoints (produit intermédiaire)');
  return Math.ceil(numerator / listXaf);
}

export type CreditOutcome = 'NO_CREDIT' | 'WITHIN_LIMIT' | 'NOT_ALLOWED' | 'EXCEEDS_LIMIT';

/**
 * BR-VEN-025, AV-028 : une vente dont une part reste due exige un client autorisé au crédit et
 * un encours après vente ≤ plafond. Sans plafond défini, tout crédit dépasse (DÉDUIT, prudent).
 * L'appelant refuse en ligne et ouvre une validation hors ligne (`CREDIT_LIMIT_EXCEEDED`).
 */
export function creditCheck(input: {
  readonly creditAllowed: boolean;
  readonly creditLimitXaf: Xaf | null;
  /** Encours actuel du client (créances non soldées, hors cette vente). */
  readonly outstandingXaf: Xaf;
  /** Part de cette vente laissée à crédit. */
  readonly newCreditXaf: Xaf;
}): { readonly outcome: CreditOutcome; readonly exceedsByXaf: Xaf } {
  const newCredit = xaf(input.newCreditXaf);
  if (newCredit === 0) return { outcome: 'NO_CREDIT', exceedsByXaf: xaf(0) };
  if (!input.creditAllowed) return { outcome: 'NOT_ALLOWED', exceedsByXaf: newCredit };
  const after = addXaf(xaf(input.outstandingXaf), newCredit);
  const limit = input.creditLimitXaf === null ? 0 : xaf(input.creditLimitXaf);
  if (input.creditLimitXaf !== null && after <= limit) {
    return { outcome: 'WITHIN_LIMIT', exceedsByXaf: xaf(0) };
  }
  return { outcome: 'EXCEEDS_LIMIT', exceedsByXaf: xaf(after - limit) };
}

/**
 * BR-VEN-024, INV-VEN-07, AV-027 : une vente sans client est intégralement payée
 * (`ANONYMOUS_REQUIRES_FULL_PAYMENT`) ; BR-VEN-001 : une commande exige un client
 * (`ORDER_CUSTOMER_REQUIRED`).
 */
export function checkSaleCustomer(input: {
  readonly hasCustomer: boolean;
  readonly isOrder: boolean;
  readonly totalXaf: Xaf;
  readonly paidXaf: Xaf;
}): void {
  if (input.hasCustomer) return;
  if (input.isOrder) {
    throw new DomainError('Une commande exige un client identifié.', 'ORDER_CUSTOMER_REQUIRED');
  }
  if (input.paidXaf < input.totalXaf) {
    throw new DomainError(
      'Une vente sans client doit être intégralement payée.',
      'ANONYMOUS_REQUIRES_FULL_PAYMENT',
    );
  }
}

export type PaymentStatus = 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';

export interface SaleBalances {
  /** Total de la vente diminué de ses annulations (ADR-028). */
  readonly netTotalXaf: Xaf;
  readonly balanceDueXaf: Xaf;
  readonly paymentStatus: PaymentStatus;
}

/**
 * BR-VEN-026, INV-VEN-06, C-05 : statut de paiement dérivé des affectations actives, jamais
 * saisi. Net = total − annulé ; payé ≤ net (`PAYMENT_OVER_ALLOCATED`). Un net nul est `PAID`.
 */
export function saleBalances(input: {
  readonly totalXaf: Xaf;
  readonly cancelledXaf?: Xaf;
  readonly paidXaf: Xaf;
}): SaleBalances {
  const cancelled = xaf(input.cancelledXaf ?? 0);
  if (cancelled > input.totalXaf) {
    throw new DomainError(
      'Le montant annulé dépasse le total de la vente.',
      'CANCELLATION_INVALID',
    );
  }
  const netTotalXaf = xaf(input.totalXaf - cancelled);
  const paid = xaf(input.paidXaf);
  if (paid > netTotalXaf) {
    throw new DomainError(
      'Les affectations dépassent le montant net de la vente.',
      'PAYMENT_OVER_ALLOCATED',
    );
  }
  const balanceDueXaf = xaf(netTotalXaf - paid);
  const paymentStatus: PaymentStatus =
    balanceDueXaf === 0 ? 'PAID' : paid === 0 ? 'UNPAID' : 'PARTIALLY_PAID';
  return { netTotalXaf, balanceDueXaf, paymentStatus };
}

/**
 * Part des encaissements affectés qui dépasse le nouveau net d'une vente après annulation : elle
 * est libérée (crédit client ou remboursement, BR-VEN-027).
 */
export function excessPaymentXaf(netTotalXaf: Xaf, paidXaf: Xaf): Xaf {
  return xaf(Math.max(0, paidXaf - netTotalXaf));
}

export interface PaymentAllocation {
  readonly targetId: string;
  readonly amountXaf: Xaf;
}

/**
 * BR-FIN-003, BR-FIN-004, INV-FIN-04 : affecte un encaissement aux soldes dus, dans l'ordre
 * donné (l'appelant trie de l'échéance la plus ancienne à la plus récente, sauf choix explicite) ;
 * le reste non affecté est un crédit client.
 */
export function allocatePayment(
  amountXaf: Xaf,
  dues: readonly { readonly targetId: string; readonly balanceXaf: Xaf }[],
): { readonly allocations: readonly PaymentAllocation[]; readonly unallocatedXaf: Xaf } {
  let remaining = xaf(amountXaf);
  if (remaining === 0) {
    throw new DomainError('Montant encaissé strictement positif attendu.', 'PAYMENT_INVALID');
  }
  const allocations: PaymentAllocation[] = [];
  for (const due of dues) {
    if (remaining === 0) break;
    const balance = xaf(due.balanceXaf);
    if (balance === 0) continue;
    const amount = Math.min(remaining, balance);
    allocations.push({ targetId: due.targetId, amountXaf: xaf(amount) });
    remaining = xaf(remaining - amount);
  }
  return { allocations, unallocatedXaf: remaining };
}

/**
 * INV-FIN-03, AV-056 : forme normalisée d'une référence de paiement (espaces retirés, majuscules),
 * pour que « mp 2309.123 » et « MP2309.123 » soient reconnues comme la même transaction.
 */
export function normalizePaymentReference(reference: string | null | undefined): string | null {
  if (reference === null || reference === undefined) return null;
  const normalized = reference.replace(/\s+/g, '').toUpperCase();
  return normalized === '' ? null : normalized;
}

/**
 * Matrice des conflits (doublon sans référence) : même client, même montant, écart inférieur ou
 * égal à la fenêtre paramétrée (`sales.duplicate_payment_window_minutes`).
 */
export function isProbableDuplicatePayment(input: {
  readonly a: {
    readonly customerId: string | null;
    readonly amountXaf: Xaf;
    readonly occurredAt: Date;
  };
  readonly b: {
    readonly customerId: string | null;
    readonly amountXaf: Xaf;
    readonly occurredAt: Date;
  };
  readonly windowMinutes: number;
}): boolean {
  if (!Number.isFinite(input.windowMinutes) || input.windowMinutes < 0) {
    throw new DomainError('Fenêtre de doublon invalide.', 'THRESHOLD_INVALID');
  }
  if (input.a.customerId === null || input.a.customerId !== input.b.customerId) return false;
  if (input.a.amountXaf !== input.b.amountXaf) return false;
  const gap = Math.abs(input.a.occurredAt.getTime() - input.b.occurredAt.getTime());
  return gap <= input.windowMinutes * 60_000;
}

/**
 * BR-VEN-028, AV-030 : annulation directe par le vendeur si elle intervient au plus `windowMinutes`
 * après l'heure métier de la vente (paramètre `sales.direct_cancel_minutes`) ; la condition de
 * caisse ouverte est vérifiée par l'appelant à partir de P5.
 */
export function withinCancellationWindow(input: {
  readonly saleOccurredAt: Date;
  readonly cancelAt: Date;
  readonly windowMinutes: number;
}): boolean {
  if (!Number.isFinite(input.windowMinutes) || input.windowMinutes < 0) {
    throw new DomainError("Délai d'annulation invalide.", 'THRESHOLD_INVALID');
  }
  return input.cancelAt.getTime() - input.saleOccurredAt.getTime() <= input.windowMinutes * 60_000;
}

/** BR-VEN-023, AV-028, AV-129 : échéance = jour métier de la vente + délai de paiement (jours). */
export function dueDateOf(saleOccurredAt: Date, paymentTermsDays: number): string {
  if (!Number.isInteger(paymentTermsDays) || paymentTermsDays < 0) {
    throw new DomainError('Délai de paiement entier ≥ 0 attendu.', 'PAYMENT_TERMS_INVALID');
  }
  return addBusinessDays(businessDayOf(saleOccurredAt), paymentTermsDays);
}

export type AgingBucket = '0-30' | '31-60' | '61-90' | '>90';

/**
 * BR-FIN-007 ; dictionnaire `sales.v_receivables` : jours de retard (0 tant que l'échéance n'est
 * pas dépassée) et tranche d'ancienneté ; en retard si le jour est postérieur à l'échéance.
 */
export function receivableAging(
  dueDate: string,
  today: string,
): { readonly daysOverdue: number; readonly overdue: boolean; readonly bucket: AgingBucket } {
  const days = Math.round(
    (businessDayStartUtc(today).getTime() - businessDayStartUtc(dueDate).getTime()) / 86_400_000,
  );
  const daysOverdue = Math.max(0, days);
  const bucket: AgingBucket =
    daysOverdue <= 30 ? '0-30' : daysOverdue <= 60 ? '31-60' : daysOverdue <= 90 ? '61-90' : '>90';
  return { daysOverdue, overdue: daysOverdue > 0, bucket };
}

/**
 * ADR-028 §5 : montant à annuler sur une ligne de vente pour une quantité donnée, au prorata de
 * la quantité en unité de base, arrondi au franc (demi supérieur) ; la dernière annulation de la
 * ligne emporte le reste exact, pour que l'annulation totale égale le montant de la ligne.
 * La quantité annulée ne dépasse pas le reste annulable (`CANCELLATION_INVALID`).
 */
export function lineCancellationAmountXaf(input: {
  readonly lineTotalXaf: Xaf;
  readonly quantity: Quantity;
  readonly alreadyCancelledQuantity: Quantity;
  readonly alreadyCancelledXaf: Xaf;
  readonly cancelQuantity: Quantity;
}): Xaf {
  const total = quantityMilliUnits(input.quantity);
  const done = quantityMilliUnits(input.alreadyCancelledQuantity);
  const cancel = quantityMilliUnits(input.cancelQuantity);
  if (total <= 0 || done < 0 || cancel <= 0 || done + cancel > total) {
    throw new DomainError(
      'Quantité à annuler strictement positive, dans la limite du reste de la ligne.',
      'CANCELLATION_INVALID',
    );
  }
  const alreadyXaf = xaf(input.alreadyCancelledXaf);
  if (alreadyXaf > input.lineTotalXaf) {
    throw new DomainError('Montant déjà annulé supérieur à la ligne.', 'CANCELLATION_INVALID');
  }
  if (done + cancel === total) return xaf(input.lineTotalXaf - alreadyXaf);
  const numerator = input.lineTotalXaf * cancel;
  assertSafeInteger(numerator, 'lineCancellationAmountXaf (produit intermédiaire)');
  const amount = Math.floor((2 * numerator + total) / (2 * total));
  return xaf(Math.min(amount, input.lineTotalXaf - alreadyXaf));
}

export interface SalesOrderLineQuantities {
  /** Quantité commandée en vigueur (après ajustements, AV-130). */
  readonly ordered: Quantity;
  /** Quantité vendue nette (confirmée, moins les annulations), ADR-028 §4-5. */
  readonly sold: Quantity;
  /** Quantité livrée (bons de livraison), ADR-028 §7. */
  readonly delivered: Quantity;
}

/**
 * ADR-028, INV-VEN-04 : en attente = commandé − vendu ; à livrer = vendu − livré ;
 * 0 ≤ livré ≤ vendu ≤ commandé (`ORDER_LINE_INCONSISTENT`).
 */
export function salesOrderLineProgress(line: SalesOrderLineQuantities): {
  readonly pending: Quantity;
  readonly undelivered: Quantity;
} {
  const ordered = quantityMilliUnits(line.ordered);
  const sold = quantityMilliUnits(line.sold);
  const delivered = quantityMilliUnits(line.delivered);
  if (delivered < 0 || delivered > sold || sold > ordered) {
    throw new DomainError(
      'Ligne de commande incohérente : 0 ≤ livré ≤ vendu ≤ commandé attendu.',
      'ORDER_LINE_INCONSISTENT',
    );
  }
  return {
    pending: quantityFromMilli(ordered - sold),
    undelivered: quantityFromMilli(sold - delivered),
  };
}

/** AV-127 : quantité confirmable (vendue) = min(en attente, disponible ≥ 0). */
export function confirmableQuantity(pending: Quantity, available: Quantity): Quantity {
  const value = Math.min(quantityMilliUnits(pending), Math.max(0, quantityMilliUnits(available)));
  return quantityFromMilli(Math.max(0, value));
}

export interface SalesOrderLineAdjustment {
  /** Part en attente retirée (aucun mouvement). */
  readonly cancelPending: Quantity;
  /** Part vendue non livrée annulée par contre-écriture (ADR-028 §5). */
  readonly cancelUndelivered: Quantity;
  /** Hausse, à confirmer comme une vente complémentaire (vente du disponible, AV-127). */
  readonly addPending: Quantity;
}

/**
 * AV-130, ADR-028 §6 : passage d'une ligne à une nouvelle quantité commandée. Une baisse retire
 * d'abord la part en attente, puis annule la part vendue non livrée ; la nouvelle quantité ne
 * descend pas sous le livré (`ORDER_QUANTITY_BELOW_DELIVERED`). Une hausse s'ajoute en attente.
 */
export function salesOrderLineAdjustment(
  line: SalesOrderLineQuantities,
  newOrdered: Quantity,
): SalesOrderLineAdjustment {
  const { pending } = salesOrderLineProgress(line);
  const ordered = quantityMilliUnits(line.ordered);
  const target = quantityMilliUnits(newOrdered);
  if (target < quantityMilliUnits(line.delivered)) {
    throw new DomainError(
      'La quantité commandée ne peut descendre sous la quantité déjà livrée.',
      'ORDER_QUANTITY_BELOW_DELIVERED',
    );
  }
  if (target >= ordered) {
    return {
      cancelPending: ZERO_QUANTITY,
      cancelUndelivered: ZERO_QUANTITY,
      addPending: quantityFromMilli(target - ordered),
    };
  }
  const reduction = ordered - target;
  const fromPending = Math.min(reduction, quantityMilliUnits(pending));
  return {
    cancelPending: quantityFromMilli(fromPending),
    cancelUndelivered: quantityFromMilli(reduction - fromPending),
    addPending: ZERO_QUANTITY,
  };
}

export type SalesOrderStatus =
  'DRAFT' | 'CONFIRMED' | 'PARTIALLY_FULFILLED' | 'FULFILLED' | 'CLOSED' | 'CANCELLED';

/**
 * SM-ORDER réécrite par ADR-028 : statut dérivé des lignes. Tant que quelque chose reste en
 * attente ou à livrer : `PARTIALLY_FULFILLED` si une livraison a eu lieu, sinon `CONFIRMED`.
 * Plus rien à vendre ni à livrer : `CANCELLED` si rien n'a été livré, `CLOSED` si le reste a été
 * annulé (AV-128), sinon `FULFILLED`.
 */
export function salesOrderStatusFromLines(
  lines: readonly SalesOrderLineQuantities[],
  options: { readonly draft?: boolean; readonly remainderCancelled?: boolean } = {},
): SalesOrderStatus {
  if (options.draft) return 'DRAFT';
  let open = false;
  let delivered = 0;
  for (const line of lines) {
    const progress = salesOrderLineProgress(line);
    if (isPositiveQuantity(progress.pending) || isPositiveQuantity(progress.undelivered)) {
      open = true;
    }
    delivered += quantityMilliUnits(line.delivered);
  }
  if (open) return delivered > 0 ? 'PARTIALLY_FULFILLED' : 'CONFIRMED';
  if (delivered === 0) return 'CANCELLED';
  return options.remainderCancelled ? 'CLOSED' : 'FULFILLED';
}
