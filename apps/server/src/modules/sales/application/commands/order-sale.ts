/**
 * Confirmation d'une commande : la **vente du disponible** (ADR-028 §4 ; AV-127, AV-126, AV-129).
 *
 * Confirmer une commande crée une vente de type `ORDER` pour la quantité que le stock de
 * l'emplacement de préparation couvre ; la marchandise passe dans l'emplacement « à livrer » du site
 * (`V_TO_DELIVER`, mouvement `SALE`, coût figé) et le reste de chaque ligne demeure **en attente** :
 * il sera vendu par une confirmation ultérieure (`confirm_remaining`, hausse de la commande), au
 * prix convenu à la commande (AV-087). La commande n'est jamais refusée pour manque de stock
 * (BR-VEN-004) et la confirmation ne rend jamais un solde négatif, même saisie hors ligne : c'est
 * une intention confirmée par le serveur (AV-126), non un fait accompli.
 *
 * La vente reprend, ligne par ligne, le prix convenu (`ORDER_QUOTE`, sa règle, sa dérogation et sa
 * validation), l'échéance part de l'heure de la vente (AV-129), l'acompte de la commande passe à la
 * vente (affectation renversée `ORDER_CONFIRMED`, puis réaffectée à la vente), et le prospect est
 * converti à la première vente confirmée (BR-CRM-010).
 */
import {
  confirmableQuantity,
  creditCheck,
  dueDateOf,
  lineAmountXaf,
  quantityFromDecimal,
  quantityFromMilli,
  quantityMilliUnits,
  quantityToDecimal,
  salesOrderLineProgress,
  salesOrderStatusFromLines,
  unitCostXaf,
  xaf,
  type IdGenerator,
} from '@gic/domain';
import { sql, type Selectable } from 'kysely';
import type {
  SalesPaymentAllocations,
  SalesSalesOrderLines,
  SalesSalesOrders,
} from '../../../../platform/kysely/schema.generated.js';
import type { DocumentSequenceService } from '../../../../platform/document-sequences/document-sequence.service.js';
import type { CommandHandlerOutcome } from '../../../../platform/sync/command-handler-registry.js';
import type { CommandOrigin } from '../../../../platform/sync/command-origin.js';
import { jsonValue } from '../../../../platform/kysely/json-value.js';
import { fromBin, toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import { findProduct } from '../../../catalog/application/public/index.js';
import {
  convertOnConfirmedSale,
  type CustomerSummary,
} from '../../../crm/application/public/index.js';
import { findWorkSessionAt } from '../../../fieldwork/application/public/index.js';
import {
  listLotBalances,
  lockSellableQuantity,
  type StockLocationRef,
} from '../../../inventory/application/public/index.js';
import { ensureToDeliverLocation } from '../../../organization/application/public/index.js';
import { customerOutstandingXaf } from '../public/receivables.js';
import { moveSoldStock, REARING_LOCATION_TYPES } from './sale-stock.js';
import { documentYear, numberSetting, rejected, type SiteRef, type Uow } from './shared.js';

export type OrderRow = Selectable<SalesSalesOrders>;
export type OrderLineRow = Selectable<SalesSalesOrderLines>;
type AllocationRow = Selectable<SalesPaymentAllocations>;

const milli = (value: string | number): number =>
  quantityMilliUnits(quantityFromDecimal(Number(value)));

/** Commande et lignes verrouillées pour la durée de la transaction (ordre constant). */

/**
 * Quantité vendue dans l'unité de saisie de la ligne de commande (dictionnaire 05-sales : `quantity`
 * est dans `unit_code`) : 12 pièces d'une ligne en cartons de 6 donnent 2 cartons. Une vente partielle
 * qui ne tombe pas sur un nombre exact (au millième) de cette unité est exprimée en unité de base.
 */
function enteredQuantity(
  line: {
    readonly quantity: string | number;
    readonly quantity_base: string | number;
    readonly unit_code: string;
  },
  soldBaseMilli: number,
  baseUnitCode: string,
): { readonly quantity: string; readonly unitCode: string } {
  const lineMilli = quantityMilliUnits(quantityFromDecimal(Number(line.quantity)));
  const lineBaseMilli = quantityMilliUnits(quantityFromDecimal(Number(line.quantity_base)));
  if (lineMilli > 0 && lineBaseMilli > 0) {
    const numerator = soldBaseMilli * lineMilli;
    if (numerator % lineBaseMilli === 0) {
      return { quantity: String(numerator / lineBaseMilli / 1000), unitCode: line.unit_code };
    }
  }
  return { quantity: String(soldBaseMilli / 1000), unitCode: baseUnitCode };
}

export async function lockOrder(
  uow: Uow,
  orderId: string,
): Promise<{ readonly order: OrderRow; readonly lines: readonly OrderLineRow[] } | undefined> {
  const order = await uow
    .selectFrom('sales_sales_orders')
    .selectAll()
    .where('id', '=', toBin(orderId))
    .forUpdate()
    .executeTakeFirst();
  if (!order) return undefined;
  const lines = await uow
    .selectFrom('sales_sales_order_lines')
    .selectAll()
    .where('order_id', '=', order.id)
    .orderBy('line_no', 'asc')
    .forUpdate()
    .execute();
  return { order, lines };
}

/**
 * Quantité vendable aujourd'hui d'un produit à l'emplacement de préparation : disponible positif
 * (sans les réservations), ou, depuis un emplacement d'élevage, seuls les lots « en vente ».
 */
export async function availableForSale(
  uow: Uow,
  location: StockLocationRef,
  productId: string,
): Promise<number> {
  if (REARING_LOCATION_TYPES.includes(location.locationType)) {
    const lots = await listLotBalances(uow, { locationId: location.id, productId });
    return lots
      .filter((lot) => lot.sellableFromRearing)
      .reduce((sum, lot) => sum + lot.qtyOnHand, 0);
  }
  // Même sélection que la sortie stricte, en lecture verrouillante (revue P4-06).
  return lockSellableQuantity(uow, {
    locationId: location.id,
    custodyMode: location.custodyMode,
    productId,
  });
}

export interface OrderConfirmationInput {
  readonly deps: {
    readonly idGenerator: IdGenerator;
    readonly documentSequences: DocumentSequenceService;
  };
  readonly order: OrderRow;
  readonly orderLines: readonly OrderLineRow[];
  readonly site: SiteRef;
  readonly location: StockLocationRef;
  /** Compte conservé du client (crédit, titulaire) ; la vente garde l'identifiant d'origine. */
  readonly customer: CustomerSummary;
  readonly actorUserId: string;
  /** Heure métier de la vente : saisie de la commande (`place`) ou de la confirmation. */
  readonly at: Date;
  readonly offline: boolean;
  readonly origin: CommandOrigin;
  readonly commandId: string;
  readonly clientCreatedAt: Date;
  readonly backdatedReason: string | null;
  /**
   * Restreint la vente à ces lignes de commande (vente complémentaire d'une modification, AV-130) ;
   * absent : toutes les lignes ayant une quantité en attente (confirmation, reste confirmé plus tard).
   */
  readonly onlyOrderLineIds?: ReadonlySet<string>;
}

export type OrderConfirmationResult =
  | {
      readonly ok: true;
      /** `null` : rien n'était vendable (aucun stock, ou plus rien en attente). */
      readonly sale: {
        readonly id: string;
        readonly docNumber: string;
        readonly totalXaf: number;
      } | null;
      readonly soldByOrderLine: ReadonlyMap<string, number>;
    }
  | { readonly ok: false; readonly outcome: CommandHandlerOutcome };

/** Vend, pour la commande, le disponible des quantités en attente (voir l'en-tête du fichier). */
export async function confirmOrderPending(
  uow: Uow,
  input: OrderConfirmationInput,
): Promise<OrderConfirmationResult> {
  const { deps, order, site, location, customer } = input;
  // --- Quantité vendable par ligne : min(en attente, disponible), le disponible se consomme au fil des lignes
  const consumed = new Map<string, number>();
  const plan: {
    line: OrderLineRow;
    quantityMilli: number;
    isService: boolean;
    productName: string;
    baseUnitCode: string;
  }[] = [];
  for (const line of input.orderLines) {
    if (input.onlyOrderLineIds && !input.onlyOrderLineIds.has(fromBin(line.id))) continue;
    const progress = salesOrderLineProgress({
      ordered: quantityFromMilli(milli(line.quantity_base)),
      sold: quantityFromMilli(milli(line.sold_quantity_base)),
      delivered: quantityFromMilli(milli(line.delivered_quantity_base)),
    });
    if (quantityMilliUnits(progress.pending) <= 0) continue;
    const productId = fromBin(line.product_id);
    const product = await findProduct(uow, productId);
    if (!product) return { ok: false, outcome: rejected('PRODUCT_UNKNOWN', 'Produit inconnu.') };
    const isService = product.stockFamily === 'SERVICE';
    let available = Number.POSITIVE_INFINITY;
    if (!isService) {
      const total = await availableForSale(uow, location, productId);
      available = total - (consumed.get(productId) ?? 0);
    }
    const confirmable = isService
      ? progress.pending
      : confirmableQuantity(
          progress.pending,
          quantityFromDecimal(Math.max(0, roundMilli(available))),
        );
    const quantityMilli = quantityMilliUnits(confirmable);
    if (quantityMilli <= 0) continue;
    consumed.set(productId, (consumed.get(productId) ?? 0) + quantityMilli / 1000);
    plan.push({
      line,
      quantityMilli,
      isService,
      productName: product.name,
      baseUnitCode: product.baseUnitCode,
    });
  }
  if (plan.length === 0) return { ok: true, sale: null, soldByOrderLine: new Map() };

  // --- Montants : prix convenu à la commande, aucune remise supplémentaire (AV-087, AV-147) ------------------
  const amounts = plan.map((entry) =>
    lineAmountXaf(
      quantityFromMilli(entry.quantityMilli),
      xaf(Number(entry.line.quoted_unit_price_xaf)),
    ),
  );
  const totalXaf = amounts.reduce((sum, amount) => sum + amount, 0);

  // --- Acompte de la commande affecté à cette vente, puis crédit sur le reste (BR-VEN-025) ---------------------
  const advances = await uow
    .selectFrom('sales_payment_allocations')
    .selectAll()
    .where('order_id', '=', order.id)
    .where('status', '=', 'ACTIVE')
    .orderBy('allocated_at', 'asc')
    .orderBy('id', 'asc')
    .forUpdate()
    .execute();
  const advanceAvailable = advances.reduce((sum, row) => sum + Number(row.amount_xaf), 0);
  const fromAdvance = Math.min(advanceAvailable, totalXaf);
  const newCredit = totalXaf - fromAdvance;
  if (newCredit > 0) {
    const check = creditCheck({
      creditAllowed: customer.creditAllowed,
      creditLimitXaf: customer.creditLimitXaf === null ? null : xaf(customer.creditLimitXaf),
      outstandingXaf: xaf(await customerOutstandingXaf(uow, customer.id)),
      newCreditXaf: xaf(newCredit),
    });
    if (check.outcome === 'NOT_ALLOWED') {
      return {
        ok: false,
        outcome: rejected('CREDIT_NOT_ALLOWED', 'Ce client n’est pas autorisé à acheter à crédit.'),
      };
    }
    if (check.outcome === 'EXCEEDS_LIMIT') {
      return {
        ok: false,
        outcome: rejected('CREDIT_LIMIT_EXCEEDED', 'Plafond de crédit du client dépassé.'),
      };
    }
  }

  // --- Stock : un mouvement `SALE` vers « à livrer » par ligne et par lot (jamais de solde négatif) ----------------
  const saleId = deps.idGenerator.newId();
  const toDeliver = await ensureToDeliverLocation(uow, deps, {
    siteId: site.id,
    createdBy: input.actorUserId,
  });
  const lineIds = plan.map(() => deps.idGenerator.newId());
  const costs = new Map<number, { readonly costXaf: number; readonly unitCostXaf: number }>();
  const stockOrder = plan
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        fromBin(a.entry.line.product_id).localeCompare(fromBin(b.entry.line.product_id)) ||
        a.entry.line.line_no - b.entry.line.line_no,
    );
  for (const { entry, index } of stockOrder) {
    if (entry.isService) continue;
    const result = await moveSoldStock(uow, deps, {
      saleId,
      lineId: lineIds[index]!,
      productId: fromBin(entry.line.product_id),
      quantityBase: entry.quantityMilli / 1000,
      fromLocationId: location.id,
      toLocationId: toDeliver.locationId,
      locationType: location.locationType,
      occurredAt: input.at,
      createdBy: input.actorUserId,
      createdDeviceId: input.origin.deviceId,
      commandId: input.commandId,
      offline: input.offline,
      strict: true,
    });
    if (!result.ok) return { ok: false, outcome: result.outcome };
    const costXaf = result.moves.reduce((sum, move) => sum + move.valueXaf, 0);
    costs.set(index, {
      costXaf,
      unitCostXaf: unitCostXaf(costXaf, quantityFromMilli(entry.quantityMilli)),
    });
  }

  // --- Vente, lignes, échéance (AV-129) ------------------------------------------------------------------------
  const docNumber = await deps.documentSequences.next(uow, {
    docType: 'VTE',
    siteId: site.id,
    codeSite: site.code,
    year: documentYear(input.at),
  });
  const termsDays =
    customer.paymentTermsDays ??
    (await numberSetting(uow, 'sales.default_payment_terms_days', input.at, 30));
  const session = await findWorkSessionAt(uow, input.actorUserId, input.at);
  await uow
    .insertInto('sales_sales')
    .values({
      id: toBin(saleId),
      doc_number: docNumber,
      site_id: toBin(site.id),
      sale_type: 'ORDER',
      order_id: order.id,
      customer_id: order.customer_id,
      customer_category_id_snapshot: toBinOrNull(customer.categoryId),
      channel_code: order.channel_code,
      from_location_id: toBin(location.id),
      to_deliver_location_id: toBin(toDeliver.locationId),
      zone_id: toBin(customer.zoneId),
      seller_user_id: toBin(input.actorUserId),
      commercial_user_id: order.commercial_user_id,
      work_session_id: toBinOrNull(session?.id ?? null),
      subtotal_xaf: totalXaf,
      discount_total_xaf: 0,
      tax_total_xaf: 0,
      total_xaf: totalXaf,
      due_date: sql<Date>`${dueDateOf(input.at, termsDays)}`,
      flags: jsonValue([]),
      occurred_at: input.at,
      client_created_at: input.clientCreatedAt,
      received_at_server: input.origin.receivedAt,
      command_id: toBin(input.commandId),
      created_device_id: toBinOrNull(input.origin.deviceId),
      captured_offline: input.offline ? 1 : 0,
      clock_suspect: input.origin.clockSuspect ? 1 : 0,
      backdated_reason: input.backdatedReason,
      created_by: toBin(input.actorUserId),
    })
    .execute();
  for (const [index, entry] of plan.entries()) {
    const line = entry.line;
    const cost = costs.get(index);
    const entered = enteredQuantity(line, entry.quantityMilli, entry.baseUnitCode);
    await uow
      .insertInto('sales_sale_lines')
      .values({
        id: toBin(lineIds[index]!),
        sale_id: toBin(saleId),
        line_no: index + 1,
        order_line_id: line.id,
        product_id: line.product_id,
        product_name_snapshot: line.product_name_snapshot,
        quantity: entered.quantity,
        unit_code: entered.unitCode,
        quantity_base: String(entry.quantityMilli / 1000),
        // Prix convenu par unité de base : la quantité de tarification est le vendu en unité de base.
        pricing_quantity: String(entry.quantityMilli / 1000),
        pricing_unit_code: entry.baseUnitCode,
        list_unit_price_xaf: line.list_unit_price_xaf,
        unit_price_xaf: Number(line.quoted_unit_price_xaf),
        price_rule_id: line.price_rule_id,
        price_rule_version: line.price_rule_version,
        price_source: 'ORDER_QUOTE',
        override_reason_code_id: line.override_reason_code_id,
        override_approval_request_id: line.override_approval_request_id,
        discount_xaf: 0,
        line_total_xaf: amounts[index]!,
        unit_cost_xaf: cost?.unitCostXaf ?? null,
        cost_xaf: cost?.costXaf ?? null,
      })
      .execute();
  }

  // --- Acompte : l'affectation de la commande passe à la vente (ORDER_CONFIRMED) ----------------------------------
  let paid = 0;
  if (fromAdvance > 0)
    paid = await moveAdvanceToSale(uow, deps, {
      advances,
      saleId,
      amountXaf: fromAdvance,
      at: input.at,
      actorUserId: input.actorUserId,
      commandId: input.commandId,
    });
  if (paid > 0) {
    await uow
      .updateTable('sales_sales')
      .set({ amount_paid_xaf: paid })
      .where('id', '=', toBin(saleId))
      .execute();
  }

  // --- Compteurs « vendu » des lignes de commande, un seul UPDATE par ligne ---------------------------------------
  const soldByOrderLine = new Map<string, number>();
  for (const entry of plan) {
    await uow
      .updateTable('sales_sales_order_lines')
      .set({
        sold_quantity_base: String(
          quantityToDecimal(
            quantityFromMilli(milli(entry.line.sold_quantity_base) + entry.quantityMilli),
          ),
        ),
      })
      .where('id', '=', entry.line.id)
      .execute();
    soldByOrderLine.set(fromBin(entry.line.id), entry.quantityMilli);
  }

  // --- Prospect converti à la première vente confirmée (BR-CRM-010) ---------------------------------------------------
  await convertOnConfirmedSale(uow, {
    customerId: fromBin(order.customer_id),
    saleId,
    saleOccurredAt: input.at,
    actorUserId: input.actorUserId,
    historyId: deps.idGenerator.newId(),
  });
  return { ok: true, sale: { id: saleId, docNumber, totalXaf }, soldByOrderLine };
}

function roundMilli(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Passe `amountXaf` d'acompte de la commande à la vente : l'affectation visant la commande est
 * renversée (`ORDER_CONFIRMED`), la part reportée sur la vente est affectée à celle-ci, le reste de
 * l'affectation éventuellement entamée est réaffecté à la commande ; `advance_paid_xaf` suit.
 * Renvoie le montant affecté à la vente.
 */
async function moveAdvanceToSale(
  uow: Uow,
  deps: { readonly idGenerator: IdGenerator },
  input: {
    readonly advances: readonly AllocationRow[];
    readonly saleId: string;
    readonly amountXaf: number;
    readonly at: Date;
    readonly actorUserId: string;
    readonly commandId: string;
  },
): Promise<number> {
  let remaining = input.amountXaf;
  let moved = 0;
  const orderId = input.advances[0]?.order_id;
  for (const advance of input.advances) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Number(advance.amount_xaf));
    await uow
      .updateTable('sales_payment_allocations')
      .set({ status: 'REVERSED', reversed_at: input.at, reversal_cause: 'ORDER_CONFIRMED' })
      .where('id', '=', advance.id)
      .execute();
    await uow
      .insertInto('sales_payment_allocations')
      .values({
        id: toBin(deps.idGenerator.newId()),
        payment_id: advance.payment_id,
        sale_id: toBin(input.saleId),
        amount_xaf: take,
        allocated_at: input.at,
        command_id: toBin(input.commandId),
        created_by: toBin(input.actorUserId),
      })
      .execute();
    if (take < Number(advance.amount_xaf)) {
      await uow
        .insertInto('sales_payment_allocations')
        .values({
          id: toBin(deps.idGenerator.newId()),
          payment_id: advance.payment_id,
          order_id: advance.order_id,
          amount_xaf: Number(advance.amount_xaf) - take,
          allocated_at: advance.allocated_at,
          command_id: toBin(input.commandId),
          created_by: toBin(input.actorUserId),
        })
        .execute();
    }
    remaining -= take;
    moved += take;
  }
  if (orderId && moved > 0) {
    await uow
      .updateTable('sales_sales_orders')
      .set((eb) => ({ advance_paid_xaf: eb('advance_paid_xaf', '-', moved) }))
      .where('id', '=', orderId)
      .execute();
  }
  return moved;
}

/**
 * Recalcule le statut de la commande depuis ses lignes (`salesOrderStatusFromLines`, SM-ORDER) et
 * monte sa version (concurrence optimiste, BR-VEN-005). `remainderCancelled` : le reste a été annulé
 * (AV-128), la commande est alors terminée (`CLOSED`, ou `CANCELLED` si rien n'a été livré).
 */
export async function refreshOrderStatus(
  uow: Uow,
  orderId: string,
  options: { readonly remainderCancelled?: boolean } = {},
): Promise<{ readonly status: string; readonly lines: readonly OrderLineRow[] }> {
  // Lecture verrouillante (la commande l'est déjà) : l'état le plus récent des lignes, pas
  // l'instantané de la transaction pris avant le verrou (annulation de vente concurrente).
  const lines = await uow
    .selectFrom('sales_sales_order_lines')
    .selectAll()
    .where('order_id', '=', toBin(orderId))
    .orderBy('line_no', 'asc')
    .forUpdate()
    .execute();
  const status = salesOrderStatusFromLines(
    lines.map((line) => ({
      ordered: quantityFromMilli(milli(line.quantity_base)),
      sold: quantityFromMilli(milli(line.sold_quantity_base)),
      delivered: quantityFromMilli(milli(line.delivered_quantity_base)),
    })),
    options.remainderCancelled === true ? { remainderCancelled: true } : {},
  );
  return { status, lines };
}
