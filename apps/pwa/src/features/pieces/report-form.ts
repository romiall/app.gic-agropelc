/**
 * Saisie d'un report de pièce papier (PP-B ; REQ-303, AV-308, AV-312, AV-078, AV-501 à AV-504) : état du
 * formulaire et résolution en pièce `ResolvedSlip` (`report-commands.ts`) à partir des référentiels de
 * l'appareil. Logique PURE : mêmes aides que les écrans qui écrivent ces commandes en direct
 * (`sale-form`, `payment`, `open-orders`, `loss`, `transfer`, `receipt`, `transfers`), pour que le report
 * d'une pièce produise la charge utile que l'écran d'origine aurait produite.
 *
 * Une pièce papier est un fait accompli : aucun contrôle de stock ni de plafond ici (le serveur applique
 * la commande « saisie hors ligne » et signale ce qui est anormal, BR-SYN-007). Ne sont bloquants que les
 * défauts qui feraient refuser la commande pour sa validité : référence inconnue, montant incohérent,
 * donnée obligatoire absente.
 */
import { normalizeSlipRef, evaluateBackdating } from './registre-carnets.js';
import {
  MAX_SLIP_REF_LENGTH,
  type ReportableSlipType,
  type ResolvedSlip,
  type SlipReceiptLine,
} from './report-commands.js';
import { ownAccounts, sourceAccounts, targetsFor, transferPairs } from '../cash/transfers.js';
import {
  paymentIssues,
  paymentPayload,
  EMPTY_PAYMENT,
  type PaymentFieldsValue,
} from '../sales/payment.js';
import { openOrders, type OrderView } from '../sales/open-orders.js';
import { deduceChannel, openWorkSession, saleZoneId } from '../sales/pricing.js';
import type { SalesReferences } from '../sales/references.js';
import {
  computeLine,
  linePayload,
  parseQuantity,
  parseXaf,
  saleUnitsOf,
  totalOf,
  FULFILMENT_LOCATION_TYPES,
  MAX_ADDRESS_LENGTH,
  MAX_COMMENT_LENGTH,
  MAX_RECIPIENT_LENGTH,
  SALE_LOCATION_TYPES,
  type DraftLine,
  type PricingContext,
} from '../sales/sale-form.js';
import type { CustomerData, LocationData } from '../sales/types.js';
import { checkLoss, lossReasons, type LossCategory } from '../stock/loss.js';
import { checkTransferLine, destinations } from '../stock/transfer.js';
import { receivableOrders } from '../procurement/receipt.js';

// --- État du formulaire ---------------------------------------------------------------------------

export interface SlipForm {
  readonly slipType: ReportableSlipType;
  readonly paperRef: string;
  /** Heure écrite sur la pièce, `AAAA-MM-JJTHH:mm` (heure locale de l'appareil). */
  readonly occurredAt: string;
  readonly backdatedReason: string;
  /** BV : emplacement de vente ; CC : de préparation ; BR : de réception ; BT : de départ ; FP : de la perte. */
  readonly locationId: string;
  /** BT : emplacement d'arrivée. */
  readonly toLocationId: string;
  /** BD : site de la dépense ; RE : site de l'encaissement (facultatif). */
  readonly siteId: string;
  /** BV : client facultatif (vente de passage) ; CC et RE : client obligatoire. */
  readonly customerId: string | null;
  /** BV, CC, BR sans bon de commande, BT, FP (une ligne) : produit, unité, quantité, prix ou coût. */
  readonly lines: readonly DraftLine[];
  /** BV, CC : motif de la dérogation de prix, quand le prix inscrit n'est pas le prix catalogue. */
  readonly overrideReasonId: string;
  /** BV : règlement ; RE : encaissement. */
  readonly payment: PaymentFieldsValue;
  readonly requestedDeliveryDate: string;
  readonly deliveryAddress: string;
  /** BL : commande livrée ; BR : bon de commande reçu (`''` : réception sans bon de commande). */
  readonly orderId: string;
  /** BL : quantité remise par ligne de commande ; BR : quantité reçue par ligne du bon (unité de base). */
  readonly quantities: Readonly<Record<string, string>>;
  /** BL : personne qui a reçu la marchandise. */
  readonly recipient: string;
  /** BL, BT : observations ; BR : observations de la réception ; RF : commentaire. */
  readonly notes: string;
  /** BD : catégorie de dépense. */
  readonly categoryId: string;
  /** BD, RF : montant (XAF). */
  readonly amountText: string;
  readonly description: string;
  readonly payeeName: string;
  /** BD : compte payeur ; RF : compte source. */
  readonly accountId: string;
  readonly toAccountId: string;
  /** RF, BT : porteur ou transporteur. */
  readonly carrierName: string;
  readonly supplierId: string;
  /** BR : numéro du bon de livraison du fournisseur. */
  readonly deliveryNoteRef: string;
  readonly lossCategory: LossCategory | '';
  readonly lossReasonId: string;
}

/** Heure locale d'un instant, au format de `<input type="datetime-local">`. */
export function toLocalInput(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function emptySlipForm(now: Date, slipType: ReportableSlipType = 'BV'): SlipForm {
  return {
    slipType,
    paperRef: '',
    occurredAt: toLocalInput(now),
    backdatedReason: '',
    locationId: '',
    toLocationId: '',
    siteId: '',
    customerId: null,
    lines: [],
    overrideReasonId: '',
    payment: EMPTY_PAYMENT,
    requestedDeliveryDate: '',
    deliveryAddress: '',
    orderId: '',
    quantities: {},
    recipient: '',
    notes: '',
    categoryId: '',
    amountText: '',
    description: '',
    payeeName: '',
    accountId: '',
    toAccountId: '',
    carrierName: '',
    supplierId: '',
    deliveryNoteRef: '',
    lossCategory: '',
    lossReasonId: '',
  };
}

// --- Défauts de saisie ----------------------------------------------------------------------------

export type SlipIssue =
  | 'REF_REQUIRED'
  | 'REF_TOO_LONG'
  | 'DATE_INVALID'
  | 'DATE_FUTURE'
  | 'BACKDATE_REASON_REQUIRED'
  | 'LOCATION_REQUIRED'
  | 'DESTINATION_REQUIRED'
  | 'SITE_REQUIRED'
  | 'CUSTOMER_REQUIRED'
  | 'CUSTOMER_UNKNOWN'
  | 'LINES_REQUIRED'
  | 'LINE_INVALID'
  | 'PRICE_REASON_REQUIRED'
  | 'PAYMENT_INVALID'
  | 'PAYMENT_EXCEEDS_TOTAL'
  | 'DELIVERY_DATE_INVALID'
  | 'ORDER_REQUIRED'
  | 'QUANTITY_INVALID'
  | 'QUANTITY_REQUIRED'
  | 'CATEGORY_REQUIRED'
  | 'AMOUNT_INVALID'
  | 'DESCRIPTION_REQUIRED'
  | 'ACCOUNT_REQUIRED'
  | 'SUPPLIER_REQUIRED'
  | 'COST_REQUIRED'
  | 'LOSS_CATEGORY_REQUIRED'
  | 'COMMENT_REQUIRED';

export const SLIP_ISSUE_MESSAGES: Readonly<Record<SlipIssue, string>> = {
  REF_REQUIRED: 'Saisissez le numéro de la pièce.',
  REF_TOO_LONG: `Le numéro de la pièce ne peut dépasser ${MAX_SLIP_REF_LENGTH} caractères.`,
  DATE_INVALID: 'La date de la pièce est invalide.',
  DATE_FUTURE: 'La date de la pièce ne peut pas être dans le futur.',
  BACKDATE_REASON_REQUIRED: 'Un motif est requis car la pièce date de plus de 24 h (AV-078).',
  LOCATION_REQUIRED: 'Choisissez l’emplacement.',
  DESTINATION_REQUIRED: 'Choisissez la destination (différente de la source).',
  SITE_REQUIRED: 'Choisissez le site.',
  CUSTOMER_REQUIRED: 'Choisissez un client.',
  CUSTOMER_UNKNOWN: 'Ce client n’est plus connu de l’appareil.',
  LINES_REQUIRED: 'Ajoutez au moins une ligne.',
  LINE_INVALID: 'Une ligne est incomplète : produit, unité, quantité ou prix à corriger.',
  PRICE_REASON_REQUIRED:
    'Le prix inscrit diffère du prix catalogue : choisissez le motif de la dérogation.',
  PAYMENT_INVALID: 'Le règlement est incomplet : moyen, montant, référence ou compte à corriger.',
  PAYMENT_EXCEEDS_TOTAL: 'Le règlement dépasse le total de la pièce.',
  DELIVERY_DATE_INVALID: 'La date de livraison souhaitée est invalide.',
  ORDER_REQUIRED: 'Choisissez la commande livrée.',
  QUANTITY_INVALID: 'Une quantité est invalide ou dépasse ce qui reste à traiter.',
  QUANTITY_REQUIRED: 'Saisissez au moins une quantité.',
  CATEGORY_REQUIRED: 'Choisissez la catégorie.',
  AMOUNT_INVALID: 'Le montant est invalide.',
  DESCRIPTION_REQUIRED: 'Décrivez l’objet de la pièce.',
  ACCOUNT_REQUIRED: 'Choisissez le compte.',
  SUPPLIER_REQUIRED: 'Choisissez le fournisseur.',
  COST_REQUIRED: 'Saisissez le prix d’achat de chaque ligne (réception sans bon de commande).',
  LOSS_CATEGORY_REQUIRED: 'Choisissez la catégorie de perte.',
  COMMENT_REQUIRED: 'Un commentaire est requis pour cette catégorie ou ce motif.',
};

// --- Contexte et choix proposés -------------------------------------------------------------------

export interface SlipContext {
  readonly refs: SalesReferences;
  readonly userId: string;
  /** Rôles de l'utilisateur ; `null` : inconnus de l'appareil (le canal est alors laissé au serveur). */
  readonly roles: readonly string[] | null;
  readonly now: Date;
}

const DEFAULT_METHOD = 'ESPECES';
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Emplacements physiques actifs d'un type admis, hors stock mobile d'un autre détenteur, par nom. */
export function slipLocations(
  refs: Pick<SalesReferences, 'locations'>,
  userId: string,
  types?: readonly string[],
): LocationData[] {
  return refs.locations
    .filter(
      (location) =>
        (types === undefined || types.includes(location.location_type)) &&
        !location.is_virtual &&
        location.status === 'ACTIVE' &&
        !(
          location.custody_mode === 'EXCLUSIVE_USER' &&
          location.custodian_user_id !== null &&
          location.custodian_user_id !== userId
        ),
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

/** Emplacements que propose chaque type de pièce pour `form.locationId`. */
export function locationChoices(
  type: ReportableSlipType,
  refs: Pick<SalesReferences, 'locations'>,
  userId: string,
): LocationData[] {
  switch (type) {
    case 'BV':
      return slipLocations(refs, userId, SALE_LOCATION_TYPES);
    case 'CC':
      return slipLocations(refs, userId, FULFILMENT_LOCATION_TYPES);
    default:
      return slipLocations(refs, userId);
  }
}

/** Commandes qu'une livraison papier peut viser : celles qui ont encore des lignes à livrer. */
export function deliverableOrders(refs: SalesReferences): OrderView[] {
  return openOrders(refs).filter((order) => order.lines.some(isDeliverable));
}

const isDeliverable = (line: OrderView['lines'][number]): boolean =>
  line.id !== null && line.toDeliverBase > 0;

const isBlankLine = (line: DraftLine): boolean =>
  line.productId === '' &&
  line.quantityText.trim() === '' &&
  line.weightText.trim() === '' &&
  (line.priceText ?? '').trim() === '';

/** Saisie décimale ≥ 0 d'une quantité remise ou reçue (vide : zéro) ; `null` si invalide. */
function parseCount(text: string): number | null {
  const normalized = text.trim().replace(/\s/g, '').replace(',', '.');
  if (normalized === '') return 0;
  if (!/^\d+(\.\d{1,3})?$/.test(normalized)) return null;
  return Number(normalized);
}

// --- Résolution -----------------------------------------------------------------------------------

export interface SlipMeta {
  /** Numéro de la pièce papier normalisé. */
  readonly paperRef: string;
  /** Heure de la pièce, ISO 8601 UTC. */
  readonly occurredAt: string;
  readonly backdatedReason: string | null;
  /** Commandes de l'outbox dont l'envoi doit précéder celui-ci. */
  readonly dependsOn: readonly string[];
}

export type SlipResolution =
  | { readonly ok: true; readonly slip: ResolvedSlip; readonly meta: SlipMeta }
  | { readonly ok: false; readonly issues: readonly SlipIssue[] };

const refuse = (issues: SlipIssue[]): SlipResolution => ({ ok: false, issues });

/** Défauts communs : numéro de la pièce, date et motif d'antidatage (AV-078, AV-312). */
function commonIssues(form: SlipForm, now: Date): { issues: SlipIssue[]; meta: SlipMeta | null } {
  const issues: SlipIssue[] = [];
  const paperRef = normalizeSlipRef(form.paperRef);
  if (!paperRef) issues.push('REF_REQUIRED');
  else if (paperRef.length > MAX_SLIP_REF_LENGTH) issues.push('REF_TOO_LONG');
  const when = new Date(form.occurredAt);
  let occurredAt = '';
  let reason: string | null = null;
  if (Number.isNaN(when.getTime())) {
    issues.push('DATE_INVALID');
  } else {
    occurredAt = when.toISOString();
    const evaluation = evaluateBackdating(occurredAt, now);
    if (evaluation.isFuture) issues.push('DATE_FUTURE');
    const typed = form.backdatedReason.trim();
    if (evaluation.requiresReason && !typed) issues.push('BACKDATE_REASON_REQUIRED');
    reason = typed ? typed : null;
  }
  return {
    issues,
    meta:
      issues.length === 0 ? { paperRef, occurredAt, backdatedReason: reason, dependsOn: [] } : null,
  };
}

/** Lignes de vente ou de commande calculées comme l'écran d'origine, au prix inscrit sur la pièce. */
function computeSaleLines(
  form: SlipForm,
  context: SlipContext,
  pricing: PricingContext,
  options: { readonly perUnitOnly: boolean },
) {
  const { refs } = context;
  const products = new Map(refs.products.map((product) => [product.id, product]));
  const reason = form.overrideReasonId || null;
  const computed = form.lines.flatMap((draft) => {
    const product = products.get(draft.productId);
    if (!product) return [];
    return [computeLine({ ...draft, overrideReasonId: reason }, product, refs, pricing)];
  });
  const issues: SlipIssue[] = [];
  if (form.lines.length === 0) issues.push('LINES_REQUIRED');
  if (computed.length !== form.lines.length) issues.push('LINE_INVALID');
  if (options.perUnitOnly && computed.some((line) => line.product.pricing_mode === 'PER_WEIGHT')) {
    issues.push('LINE_INVALID');
  }
  if (computed.some((line) => line.issue === 'REASON_REQUIRED'))
    issues.push('PRICE_REASON_REQUIRED');
  if (computed.some((line) => line.issue !== null && line.issue !== 'REASON_REQUIRED')) {
    issues.push('LINE_INVALID');
  }
  const total = totalOf(computed);
  if (total === null) issues.push('LINE_INVALID');
  return { computed, total, issues };
}

/** Moyen choisi, ou le moyen par défaut (espèces), ou le premier moyen connu de l'appareil. */
export function slipPaymentMethod(refs: SalesReferences, value: PaymentFieldsValue) {
  const methods = refs.paymentMethods;
  return (
    methods.find((candidate) => candidate.code === value.methodCode) ??
    methods.find((candidate) => candidate.code === DEFAULT_METHOD) ??
    methods[0]
  );
}

function customerOf(form: SlipForm, refs: SalesReferences) {
  return form.customerId ? refs.customers.find((entry) => entry.id === form.customerId) : undefined;
}

/**
 * Résout le formulaire en pièce prête à devenir une commande, ou liste ce qui manque. Un défaut commun
 * (numéro, date) et les défauts propres au type sont rendus ensemble.
 */
export function resolveSlip(entered: SlipForm, context: SlipContext): SlipResolution {
  // Une ligne laissée vide n'est pas une ligne : seules les lignes entamées comptent.
  const form: SlipForm = { ...entered, lines: entered.lines.filter((line) => !isBlankLine(line)) };
  const common = commonIssues(form, context.now);
  const issues = [...common.issues];
  const resolved = resolveBody(form, context);
  if (!resolved.ok) issues.push(...resolved.issues);
  if (issues.length > 0 || !resolved.ok || common.meta === null) return refuse(issues);
  return {
    ok: true,
    slip: resolved.slip,
    meta: { ...common.meta, dependsOn: resolved.dependsOn },
  };
}

type Body =
  | { readonly ok: true; readonly slip: ResolvedSlip; readonly dependsOn: readonly string[] }
  | { readonly ok: false; readonly issues: SlipIssue[] };

const fail = (...issues: SlipIssue[]): Body => ({ ok: false, issues });
const done = (slip: ResolvedSlip, dependsOn: readonly string[] = []): Body => ({
  ok: true,
  slip,
  dependsOn,
});
const optional = (text: string): string | undefined => {
  const trimmed = text.trim();
  return trimmed ? trimmed : undefined;
};
const pendingOf = (customer: { readonly pending_command_id?: string } | undefined): string[] =>
  customer?.pending_command_id ? [customer.pending_command_id] : [];

function resolveBody(form: SlipForm, context: SlipContext): Body {
  switch (form.slipType) {
    case 'BV':
      return resolveSale(form, context);
    case 'CC':
      return resolveOrder(form, context);
    case 'RE':
      return resolvePaymentSlip(form, context);
    case 'BL':
      return resolveDelivery(form, context);
    case 'BD':
      return resolveExpense(form, context);
    case 'RF':
      return resolveCashTransfer(form, context);
    case 'BR':
      return resolveReceipt(form, context);
    case 'BT':
      return resolveTransfer(form, context);
    case 'FP':
      return resolveLoss(form, context);
  }
}

type SaleBase =
  | {
      readonly ok: true;
      readonly location: LocationData;
      readonly customer: CustomerData | undefined;
      readonly pricing: PricingContext;
    }
  | { readonly ok: false; readonly issues: SlipIssue[] };

/**
 * Emplacement, client et contexte de tarification d'une vente (BV) ou d'une commande (CC), comme les
 * écrans d'origine, mais à la date de la pièce : le prix catalogue est celui que l'appareil connaît ce
 * jour-là.
 */
function saleBase(form: SlipForm, context: SlipContext, type: 'BV' | 'CC'): SaleBase {
  const { refs, userId } = context;
  const when = new Date(form.occurredAt);
  const customer = customerOf(form, refs);
  if (type === 'CC' && form.customerId === null)
    return { ok: false, issues: ['CUSTOMER_REQUIRED'] };
  if (form.customerId !== null && !customer) return { ok: false, issues: ['CUSTOMER_UNKNOWN'] };
  const location = locationChoices(type, refs, userId).find(
    (entry) => entry.id === form.locationId,
  );
  if (!location) return { ok: false, issues: ['LOCATION_REQUIRED'] };
  const site = location.site_id ? refs.sites.get(location.site_id) : undefined;
  const session = openWorkSession(refs.workSessions, userId, when);
  const pricing: PricingContext =
    type === 'BV'
      ? {
          at: when,
          siteId: site?.id,
          zoneId: saleZoneId({
            locationType: location.location_type,
            siteZoneId: site?.zone_id,
            customerZoneId: customer?.zone_id,
            sessionZoneId: session?.declared_zone_id,
          }),
          customerCategoryId: customer?.category_id,
          channelCode: deduceChannel({
            locationType: location.location_type,
            roles: context.roles,
            hasOpenSession: session !== undefined,
          }),
        }
      : {
          at: when,
          siteId: site?.id,
          // Une commande est tarifée dans la zone de son client (`order-commands.ts`).
          zoneId: customer?.zone_id ?? site?.zone_id,
          customerCategoryId: customer?.category_id,
          channelCode: deduceChannel({
            locationType: null,
            roles: context.roles,
            hasOpenSession: session !== undefined,
          }),
        };
  return { ok: true, location, customer, pricing };
}

/** Une pièce sans aucune ligne le dit en même temps que le reste, sans attendre l'emplacement. */
const missingLines = (form: SlipForm): SlipIssue[] =>
  form.lines.length === 0 ? ['LINES_REQUIRED'] : [];

/** Total des lignes saisies (BV, CC) au prix inscrit sur la pièce ; `null` si on ne peut pas le dire. */
export function previewTotal(form: SlipForm, context: SlipContext): number | null {
  if (form.slipType !== 'BV' && form.slipType !== 'CC') return null;
  if (Number.isNaN(new Date(form.occurredAt).getTime())) return null;
  const base = saleBase(form, context, form.slipType);
  if (!base.ok) return null;
  return computeSaleLines(form, context, base.pricing, { perUnitOnly: form.slipType === 'CC' })
    .total;
}

function resolveSale(form: SlipForm, context: SlipContext): Body {
  const { refs } = context;
  const base = saleBase(form, context, 'BV');
  if (!base.ok) return fail(...base.issues, ...missingLines(form));
  const { location, customer, pricing } = base;
  const lines = computeSaleLines(form, context, pricing, { perUnitOnly: false });
  const issues = [...lines.issues];
  const total = lines.total ?? 0;
  const method = slipPaymentMethod(refs, form.payment);
  const amount = form.payment.amountText === null ? total : parseXaf(form.payment.amountText);
  if (amount === null) issues.push('PAYMENT_INVALID');
  else if (amount > total) issues.push('PAYMENT_EXCEEDS_TOTAL');
  else {
    // Vente de passage : payée en totalité (AV-027). Sinon, le reste est du crédit du client.
    if (!customer && amount < total) issues.push('CUSTOMER_REQUIRED');
    if (
      amount > 0 &&
      paymentIssues(
        {
          method,
          amountXaf: amount,
          reference: form.payment.reference,
          accountId: form.payment.accountId,
        },
        refs.cashAccounts,
      ).length > 0
    ) {
      issues.push('PAYMENT_INVALID');
    }
  }
  if (issues.length > 0 || amount === null) return fail(...new Set(issues));
  return done(
    {
      type: 'BV',
      fromLocationId: location.id,
      customerId: customer?.id,
      channelCode: pricing.channelCode,
      lines: lines.computed.map(linePayload),
      payment:
        amount > 0 && method
          ? paymentPayload(
              {
                method,
                amountXaf: amount,
                reference: form.payment.reference,
                accountId: form.payment.accountId,
              },
              refs.cashAccounts,
            )
          : undefined,
      totalXaf: total,
    },
    pendingOf(customer),
  );
}

function resolveOrder(form: SlipForm, context: SlipContext): Body {
  const base = saleBase(form, context, 'CC');
  if (!base.ok) return fail(...base.issues, ...missingLines(form));
  const { location, customer, pricing } = base;
  if (!customer) return fail('CUSTOMER_REQUIRED');
  const lines = computeSaleLines(form, context, pricing, { perUnitOnly: true });
  const issues = [...lines.issues];
  const date = form.requestedDeliveryDate.trim();
  if (date !== '' && !DATE_ONLY.test(date)) issues.push('DELIVERY_DATE_INVALID');
  if (issues.length > 0) return fail(...new Set(issues));
  return done(
    {
      type: 'CC',
      customerId: customer.id,
      fulfilmentLocationId: location.id,
      channelCode: pricing.channelCode,
      requestedDeliveryDate: date === '' ? undefined : date,
      deliveryAddress: optional(form.deliveryAddress)?.slice(0, MAX_ADDRESS_LENGTH),
      lines: lines.computed.map(linePayload),
      totalXaf: lines.total ?? 0,
    },
    pendingOf(customer),
  );
}

function resolvePaymentSlip(form: SlipForm, context: SlipContext): Body {
  const { refs } = context;
  if (form.customerId === null) return fail('CUSTOMER_REQUIRED');
  const customer = customerOf(form, refs);
  if (!customer) return fail('CUSTOMER_UNKNOWN');
  const method = slipPaymentMethod(refs, form.payment);
  const amount = form.payment.amountText === null ? null : parseXaf(form.payment.amountText);
  if (amount === null || amount <= 0) return fail('AMOUNT_INVALID');
  if (
    paymentIssues(
      {
        method,
        amountXaf: amount,
        reference: form.payment.reference,
        accountId: form.payment.accountId,
      },
      refs.cashAccounts,
    ).length > 0 ||
    !method
  ) {
    return fail('PAYMENT_INVALID');
  }
  const site = form.siteId ? refs.sites.get(form.siteId) : undefined;
  return done(
    {
      type: 'RE',
      customerId: customer.id,
      siteId: site?.id,
      payment: paymentPayload(
        {
          method,
          amountXaf: amount,
          reference: form.payment.reference,
          accountId: form.payment.accountId,
        },
        refs.cashAccounts,
      ),
    },
    pendingOf(customer),
  );
}

function resolveDelivery(form: SlipForm, context: SlipContext): Body {
  const order = deliverableOrders(context.refs).find((entry) => entry.id === form.orderId);
  if (!order) return fail('ORDER_REQUIRED');
  const lines: { orderLineId: string; quantityBase: number }[] = [];
  let invalid = false;
  for (const line of order.lines) {
    if (line.id === null || !isDeliverable(line)) continue;
    // Préremplissage de l'écran de livraison : tout ce qui reste à livrer.
    const value = parseCount(form.quantities[line.id] ?? String(line.toDeliverBase));
    if (value === null || value > line.toDeliverBase) invalid = true;
    else if (value > 0) lines.push({ orderLineId: line.id, quantityBase: value });
  }
  if (invalid) return fail('QUANTITY_INVALID');
  if (lines.length === 0) return fail('QUANTITY_REQUIRED');
  return done(
    {
      type: 'BL',
      orderId: order.id,
      recipientName: optional(form.recipient)?.slice(0, MAX_RECIPIENT_LENGTH),
      // Le texte reçoit la mention de la pièce (`withPaperRef`) : de la place pour elle sous 2 000.
      notes: optional(form.notes)?.slice(0, MAX_COMMENT_LENGTH - 100),
      lines,
    },
    // Commande encore dans l'outbox : la livraison attend son application.
    order.commandId ? [order.commandId] : [],
  );
}

function resolveExpense(form: SlipForm, context: SlipContext): Body {
  const { refs, userId } = context;
  const issues: SlipIssue[] = [];
  const category = refs.expenseCategories.find(
    (entry) => entry.id === form.categoryId && entry.is_active && !entry.is_system,
  );
  if (!category) issues.push('CATEGORY_REQUIRED');
  const site = refs.sites.get(form.siteId);
  if (!site) issues.push('SITE_REQUIRED');
  const account = ownAccounts(refs.cashAccounts, userId).find(
    (entry) => entry.id === form.accountId,
  );
  if (!account) issues.push('ACCOUNT_REQUIRED');
  const amount = parseXaf(form.amountText);
  if (amount === null || amount <= 0) issues.push('AMOUNT_INVALID');
  const description = form.description.trim();
  if (!description) issues.push('DESCRIPTION_REQUIRED');
  if (issues.length > 0 || !category || !site || !account || amount === null)
    return fail(...issues);
  return done({
    type: 'BD',
    categoryId: category.id,
    siteId: site.id,
    amountXaf: amount,
    description: description.slice(0, 1000),
    payeeName: optional(form.payeeName)?.slice(0, 120),
    paidFromAccountId: account.id,
  });
}

function resolveCashTransfer(form: SlipForm, context: SlipContext): Body {
  const { refs, userId } = context;
  const pairs = transferPairs(refs.settings, context.now);
  const source = sourceAccounts(refs.cashAccounts, refs.cashTransferTargets, pairs, userId).find(
    (entry) => entry.id === form.accountId,
  );
  if (!source) return fail('ACCOUNT_REQUIRED');
  const target = targetsFor(source, refs.cashTransferTargets, pairs).find(
    (entry) => entry.id === form.toAccountId,
  );
  const issues: SlipIssue[] = [];
  if (!target) issues.push('DESTINATION_REQUIRED');
  const amount = parseXaf(form.amountText);
  if (amount === null || amount <= 0) issues.push('AMOUNT_INVALID');
  if (issues.length > 0 || !target || amount === null) return fail(...issues);
  return done({
    type: 'RF',
    fromAccountId: source.id,
    toAccountId: target.id,
    amountXaf: amount,
    carrierName: optional(form.carrierName)?.slice(0, 120),
    comment: optional(form.notes)?.slice(0, 500),
  });
}

function resolveReceipt(form: SlipForm, context: SlipContext): Body {
  const { refs, userId } = context;
  const location = slipLocations(refs, userId).find(
    (entry) => entry.id === form.locationId && entry.site_id !== null,
  );
  if (!location) return fail('LOCATION_REQUIRED');
  const lines: SlipReceiptLine[] = [];
  const issues: SlipIssue[] = [];
  const order = form.orderId
    ? receivableOrders(refs.purchaseOrders).find((entry) => entry.id === form.orderId)
    : undefined;
  if (form.orderId && !order) return fail('ORDER_REQUIRED');
  if (order) {
    // Réception sur bon de commande : quantités reçues par ligne du bon, en unité de base.
    for (const line of order.lines) {
      const value = parseCount(form.quantities[line.id] ?? '');
      if (value === null) issues.push('QUANTITY_INVALID');
      else if (value > 0) {
        lines.push({
          poLineId: line.id,
          productId: line.product_id,
          unitCode: line.unit_code,
          qtyDeliveredBase: value,
        });
      }
    }
    if (issues.length === 0 && lines.length === 0) issues.push('QUANTITY_REQUIRED');
  } else {
    // Réception sans bon de commande (mise en revue par le serveur) : fournisseur et prix déclarés.
    if (!refs.suppliers.has(form.supplierId)) issues.push('SUPPLIER_REQUIRED');
    if (form.lines.length === 0) issues.push('LINES_REQUIRED');
    for (const draft of form.lines) {
      const product = refs.products.find((entry) => entry.id === draft.productId);
      const quantity = parseQuantity(draft.quantityText);
      const cost = draft.priceText === null ? null : parseXaf(draft.priceText);
      // Le serveur refuse un produit non achetable (`PRODUCT_NOT_PURCHASABLE`, BR-APP-001).
      if (!product || product.is_purchasable !== true || quantity === null) {
        issues.push('LINE_INVALID');
      } else if (cost === null) issues.push('COST_REQUIRED');
      else {
        lines.push({
          productId: product.id,
          unitCode: product.base_unit_code,
          qtyDeliveredBase: quantity,
          unitCostXaf: cost,
        });
      }
    }
  }
  if (issues.length > 0) return fail(...new Set(issues));
  const supplierId = order ? order.supplier_id : form.supplierId;
  return done({
    type: 'BR',
    purchaseOrderId: order?.id,
    supplierId,
    locationId: location.id,
    supplierDeliveryNoteRef: optional(form.deliveryNoteRef)?.slice(0, 60),
    observations: optional(form.notes)?.slice(0, 3900),
    lines,
  });
}

function resolveTransfer(form: SlipForm, context: SlipContext): Body {
  const { refs, userId } = context;
  const source = slipLocations(refs, userId).find((entry) => entry.id === form.locationId);
  if (!source) return fail('LOCATION_REQUIRED');
  const target = destinations(refs.locations, source.id).find(
    (entry) => entry.id === form.toLocationId,
  );
  const issues: SlipIssue[] = [];
  if (!target) issues.push('DESTINATION_REQUIRED');
  if (form.lines.length === 0) issues.push('LINES_REQUIRED');
  const lines = form.lines.map((draft) => {
    const product = refs.products.find((entry) => entry.id === draft.productId);
    const unit = product
      ? saleUnitsOf(product, refs).find((entry) => entry.unitCode === draft.unitCode)
      : undefined;
    return checkTransferLine(
      {
        key: draft.key,
        productId: draft.productId,
        unitCode: draft.unitCode,
        quantityText: draft.quantityText,
      },
      unit,
    );
  });
  if (lines.some((line) => line.issue !== null || line.quantityBase === null)) {
    issues.push('LINE_INVALID');
  }
  if (issues.length > 0 || !target) return fail(...new Set(issues));
  return done({
    type: 'BT',
    fromLocationId: source.id,
    toLocationId: target.id,
    carrierName: optional(form.carrierName)?.slice(0, 200),
    notes: optional(form.notes)?.slice(0, 1900),
    lines: lines.map((line) => ({
      productId: line.draft.productId,
      unitCode: line.draft.unitCode,
      quantityBase: line.quantityBase as number,
    })),
  });
}

function resolveLoss(form: SlipForm, context: SlipContext): Body {
  const { refs, userId } = context;
  const location = slipLocations(refs, userId).find((entry) => entry.id === form.locationId);
  if (!location) return fail('LOCATION_REQUIRED');
  const draft = form.lines[0];
  if (!draft) return fail('LINES_REQUIRED');
  if (!form.lossCategory) return fail('LOSS_CATEGORY_REQUIRED');
  const product = refs.products.find((entry) => entry.id === draft.productId);
  const unit = product
    ? saleUnitsOf(product, refs).find((entry) => entry.unitCode === draft.unitCode)
    : undefined;
  const reasons = lossReasons(refs.reasonCodes, form.lossCategory);
  const reasonId = reasons.some((entry) => entry.id === form.lossReasonId) ? form.lossReasonId : '';
  const check = checkLoss(
    {
      productId: draft.productId,
      unitCode: draft.unitCode,
      quantityText: draft.quantityText,
      category: form.lossCategory,
      reasonCodeId: reasonId,
      lotId: '',
      comment: form.notes,
    },
    unit,
    reasons,
  );
  if (check.issues.length > 0 || check.quantity === null || check.quantityBase === null) {
    const issues = new Set<SlipIssue>();
    for (const issue of check.issues) {
      issues.add(
        issue === 'COMMENT_REQUIRED'
          ? 'COMMENT_REQUIRED'
          : issue === 'CATEGORY_REQUIRED'
            ? 'LOSS_CATEGORY_REQUIRED'
            : 'LINE_INVALID',
      );
    }
    return fail(...(issues.size > 0 ? issues : ['LINE_INVALID' as const]));
  }
  return done({
    type: 'FP',
    locationId: location.id,
    productId: draft.productId,
    unitCode: draft.unitCode,
    quantity: check.quantity,
    quantityBase: check.quantityBase,
    category: form.lossCategory,
    reasonCodeId: reasonId || undefined,
    comment: optional(form.notes)?.slice(0, 1900),
  });
}
