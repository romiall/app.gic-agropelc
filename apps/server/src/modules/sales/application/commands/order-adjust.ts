/**
 * Retrait de quantités d'une commande confirmée (D04 BR-VEN-005, BR-VEN-009 ; ADR-028 §5 et §6 ;
 * AV-128, AV-130) : baisse d'une ligne (`sales.order.update`), annulation d'une commande non livrée
 * (`sales.order.cancel`), clôture du reste d'une commande en partie livrée
 * (`sales.order.close_remaining`), annulation d'une vente sur commande (`sales.sale.cancel`).
 *
 * Retirer une quantité d'une ligne de commande, c'est :
 * - d'abord retirer la part **en attente** (aucun mouvement, aucun chiffre d'affaires) ;
 * - puis annuler, **par contre-écriture** (document `ANV`, cause `ORDER_*`, un par vente touchée), la
 *   part vendue non livrée : marchandise rendue de « à livrer » à l'emplacement de préparation,
 *   chiffre d'affaires diminué à l'heure de l'annulation, argent payé libéré (crédit client ou
 *   remboursement, AV-146) ; la vente la plus récente d'abord, comme le choix des origines de stock
 *   (ADR-029 §6) ;
 * - puis écrire les compteurs de la ligne de commande **en un seul `UPDATE`** (`quantity_base`,
 *   `sold_quantity_base`, `withdrawn_quantity_base`, montant ; les `CHECK` sont immédiats).
 *
 * Ordre de verrous commun à toutes les commandes de `sales` : compte client, **commande** (lignes
 * comprises), puis **ventes** (identifiant croissant), puis encaissements, comptes de trésorerie.
 * Une commande est donc toujours verrouillée avant ses ventes (aucune vente sur commande ne se
 * verrouille avant sa commande, voir `lockOrderOfSale`).
 */
import {
  lineAmountXaf,
  quantityFromDecimal,
  quantityFromMilli,
  quantityMilliUnits,
  salesOrderLineAdjustment,
  salesOrderLineProgress,
  xaf,
  type IdGenerator,
} from '@gic/domain';
import type { DocumentSequenceService } from '../../../../platform/document-sequences/document-sequence.service.js';
import type { CommandHandlerOutcome } from '../../../../platform/sync/command-handler-registry.js';
import type { CommandOrigin } from '../../../../platform/sync/command-origin.js';
import { fromBin, toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import { documentYear, rejected, type SiteRef, type Uow } from './shared.js';
import {
  applyCancellation,
  cancellableMilli,
  lockSale,
  planPartialCancellation,
  settleReleasedPayments,
  type CancellationLine,
  type LockedSale,
  type PaymentTreatment,
} from './sale-cancellation.js';
import { lockOrder, refreshOrderStatus, type OrderLineRow, type OrderRow } from './order-sale.js';

export type OrderRetirementCause = 'ORDER_ADJUSTMENT' | 'ORDER_CANCELLATION' | 'ORDER_CLOSURE';

const milliOf = (value: string | number): number =>
  quantityMilliUnits(quantityFromDecimal(Number(value)));
const decimalOf = (milli: number): string => String(milli / 1000);

/** Quantités retirées d'une ligne de commande, en millièmes d'unité de base. */
export interface LineRetirement {
  readonly line: OrderLineRow;
  /** Part en attente retirée (aucun mouvement). */
  readonly cancelPendingMilli: number;
  /** Part vendue non livrée annulée par contre-écriture. */
  readonly cancelUndeliveredMilli: number;
}

const lineQuantities = (line: OrderLineRow) => ({
  ordered: quantityFromMilli(milliOf(line.quantity_base)),
  sold: quantityFromMilli(milliOf(line.sold_quantity_base)),
  delivered: quantityFromMilli(milliOf(line.delivered_quantity_base)),
});

/** AV-130 : passage d'une ligne à une nouvelle quantité commandée (jamais sous le livré). */
export function retirementToTarget(
  line: OrderLineRow,
  newOrderedMilli: number,
): { readonly retirement: LineRetirement; readonly addMilli: number } {
  const adjustment = salesOrderLineAdjustment(lineQuantities(line), quantityFromMilli(newOrderedMilli));
  return {
    retirement: {
      line,
      cancelPendingMilli: quantityMilliUnits(adjustment.cancelPending),
      cancelUndeliveredMilli: quantityMilliUnits(adjustment.cancelUndelivered),
    },
    addMilli: quantityMilliUnits(adjustment.addPending),
  };
}

/** AV-128 : tout ce qui n'est pas livré (l'attente et le vendu non livré) est retiré. */
export function fullRetirement(line: OrderLineRow): LineRetirement {
  const progress = salesOrderLineProgress(lineQuantities(line));
  return {
    line,
    cancelPendingMilli: quantityMilliUnits(progress.pending),
    cancelUndeliveredMilli: quantityMilliUnits(progress.undelivered),
  };
}

// --- Contre-écriture du vendu non livré --------------------------------------------------------------

export interface CancelUndeliveredInput {
  readonly order: OrderRow;
  readonly retirements: readonly LineRetirement[];
  readonly cause: OrderRetirementCause;
  readonly reasonCodeId: string | null;
  readonly comment: string | null;
  readonly site: SiteRef;
  /** Heure métier de l'effet : saisie ou décision. */
  readonly appliedAt: Date;
  readonly treatment: PaymentTreatment | null;
  readonly actorUserId: string;
  readonly origin: CommandOrigin;
  readonly commandId: string;
  readonly clientCreatedAt: Date;
  readonly backdatedReason: string | null;
  readonly offline: boolean;
}

export interface CancellationDocument {
  readonly id: string;
  readonly docNumber: string;
  readonly saleId: string;
  readonly saleDocNumber: string;
  readonly totalXaf: number;
}

export type CancelUndeliveredResult =
  | { readonly ok: true; readonly documents: readonly CancellationDocument[] }
  | { readonly ok: false; readonly outcome: CommandHandlerOutcome };

/**
 * Annule, par un document `ANV` par vente touchée, la part vendue non livrée de chaque retrait. Les
 * compteurs de la ligne de commande ne sont **pas** écrits ici (`retireOrderLines`).
 */
export async function cancelOrderUndelivered(
  uow: Uow,
  deps: {
    readonly idGenerator: IdGenerator;
    readonly documentSequences: DocumentSequenceService;
  },
  input: CancelUndeliveredInput,
): Promise<CancelUndeliveredResult> {
  const needed = input.retirements.filter((retirement) => retirement.cancelUndeliveredMilli > 0);
  if (needed.length === 0) return { ok: true, documents: [] };

  // Les ventes de la commande qui portent ces lignes : lecture simple, puis verrou (id croissant).
  const rows = await uow
    .selectFrom('sales_sale_lines as sl')
    .innerJoin('sales_sales as s', 's.id', 'sl.sale_id')
    .select('s.id as saleId')
    .distinct()
    .where('s.order_id', '=', input.order.id)
    .where(
      'sl.order_line_id',
      'in',
      needed.map((retirement) => retirement.line.id),
    )
    .execute();
  const saleIds = [...new Set(rows.map((row) => fromBin(row.saleId)))].sort();
  const locked: LockedSale[] = [];
  for (const saleId of saleIds) {
    const sale = await lockSale(uow, saleId);
    if (sale) locked.push(sale);
  }

  // Répartition : la vente la plus récente d'abord, dans la limite de l'annulable de chaque ligne.
  const wantedBySale = new Map<string, Map<string, number>>();
  for (const retirement of needed) {
    const orderLineId = fromBin(retirement.line.id);
    const candidates = locked
      .flatMap((sale) =>
        sale.lines
          .filter((line) => line.order_line_id !== null && fromBin(line.order_line_id) === orderLineId)
          .map((line) => ({ sale, line })),
      )
      .sort(
        (a, b) =>
          b.sale.sale.occurred_at.getTime() - a.sale.sale.occurred_at.getTime() ||
          fromBin(b.sale.sale.id).localeCompare(fromBin(a.sale.sale.id)),
      );
    let remaining = retirement.cancelUndeliveredMilli;
    for (const { sale, line } of candidates) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, cancellableMilli(sale.sale, line));
      if (take <= 0) continue;
      if (sale.sale.status === 'CANCELLATION_REQUESTED') {
        return {
          ok: false,
          outcome: rejected(
            'SALE_CANCELLATION_PENDING',
            `Une demande d’annulation est en cours sur la vente ${sale.sale.doc_number} : la décider d’abord.`,
          ),
        };
      }
      const saleKey = fromBin(sale.sale.id);
      const wanted = wantedBySale.get(saleKey) ?? new Map<string, number>();
      wanted.set(fromBin(line.id), (wanted.get(fromBin(line.id)) ?? 0) + take);
      wantedBySale.set(saleKey, wanted);
      remaining -= take;
    }
    if (remaining > 0) {
      return {
        ok: false,
        outcome: rejected(
          'CANCELLATION_EXCEEDS_UNDELIVERED',
          'La quantité à annuler dépasse ce qui reste vendu et non livré.',
        ),
      };
    }
  }

  // Un document d'annulation par vente touchée, appliqué à l'heure métier de l'opération.
  const documents: CancellationDocument[] = [];
  for (const sale of locked) {
    const wanted = wantedBySale.get(fromBin(sale.sale.id));
    if (!wanted) continue;
    const plan = planPartialCancellation(deps.idGenerator, sale, wanted);
    if (!plan.ok) return plan;
    const cancellationId = deps.idGenerator.newId();
    const applied = await applyCancellation(uow, deps, {
      cancellationId,
      locked: sale,
      lines: plan.lines,
      appliedAt: input.appliedAt,
      treatment: input.treatment,
      actorUserId: input.actorUserId,
      deviceId: input.origin.deviceId,
      commandId: input.commandId,
      offline: input.offline,
      siteId: input.site.id,
    });
    if (!applied.ok) return applied;
    const docNumber = await deps.documentSequences.next(uow, {
      docType: 'ANV',
      siteId: input.site.id,
      codeSite: input.site.code,
      year: documentYear(input.appliedAt),
    });
    await writeCancellationDocument(uow, {
      id: cancellationId,
      docNumber,
      order: input.order,
      sale,
      lines: plan.lines,
      totalXaf: plan.totalXaf,
      cause: input.cause,
      reasonCodeId: input.reasonCodeId,
      comment: input.comment,
      treatment: applied.treatment,
      input,
    });
    documents.push({
      id: cancellationId,
      docNumber,
      saleId: fromBin(sale.sale.id),
      saleDocNumber: sale.sale.doc_number,
      totalXaf: plan.totalXaf,
    });
  }
  return { ok: true, documents };
}

async function writeCancellationDocument(
  uow: Uow,
  doc: {
    readonly id: string;
    readonly docNumber: string;
    readonly order: OrderRow;
    readonly sale: LockedSale;
    readonly lines: readonly CancellationLine[];
    readonly totalXaf: number;
    readonly cause: OrderRetirementCause;
    readonly reasonCodeId: string | null;
    readonly comment: string | null;
    readonly treatment: PaymentTreatment | null;
    readonly input: CancelUndeliveredInput;
  },
): Promise<void> {
  const { input } = doc;
  await uow
    .insertInto('sales_sale_cancellations')
    .values({
      id: toBin(doc.id),
      doc_number: doc.docNumber,
      site_id: toBin(input.site.id),
      sale_id: doc.sale.sale.id,
      order_id: doc.order.id,
      cause: doc.cause,
      status: 'APPLIED',
      reason_code_id: toBinOrNull(doc.reasonCodeId),
      comment: doc.comment,
      requested_by: toBin(input.actorUserId),
      cancelled_total_xaf: doc.totalXaf,
      released_payment_treatment: doc.treatment,
      applied_at: input.appliedAt,
      occurred_at: input.appliedAt,
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
  for (const line of doc.lines) {
    await uow
      .insertInto('sales_sale_cancellation_lines')
      .values({
        id: toBin(line.id),
        cancellation_id: toBin(doc.id),
        sale_line_id: toBin(line.saleLineId),
        quantity_base: String(line.quantityBase),
        amount_xaf: line.amountXaf,
      })
      .execute();
  }
}

// --- Compteurs de la ligne de commande -------------------------------------------------------------

/**
 * Écrit les retraits dans les lignes de commande : **un seul `UPDATE` par ligne** (commandé, vendu
 * net, cumul retiré, montant estimé). `quantity` (unité de saisie) suit au prorata ; une ligne
 * entièrement retirée a un commandé nul.
 */
export async function retireOrderLines(
  uow: Uow,
  retirements: readonly LineRetirement[],
): Promise<void> {
  for (const retirement of retirements) {
    const retired = retirement.cancelPendingMilli + retirement.cancelUndeliveredMilli;
    if (retired <= 0) continue;
    const { line } = retirement;
    const oldBase = milliOf(line.quantity_base);
    const newBase = oldBase - retired;
    const quantity =
      newBase <= 0 || oldBase <= 0
        ? 0
        : Math.round((Number(line.quantity) * newBase * 1000) / oldBase) / 1000;
    await uow
      .updateTable('sales_sales_order_lines')
      .set({
        quantity: String(quantity),
        quantity_base: decimalOf(newBase),
        sold_quantity_base: decimalOf(
          milliOf(line.sold_quantity_base) - retirement.cancelUndeliveredMilli,
        ),
        withdrawn_quantity_base: decimalOf(milliOf(line.withdrawn_quantity_base) + retired),
        line_total_xaf: lineAmountXaf(
          quantityFromMilli(newBase),
          xaf(Number(line.quoted_unit_price_xaf)),
        ),
      })
      .where('id', '=', line.id)
      .execute();
  }
}

// --- Acompte de la commande -------------------------------------------------------------------------

export type AdvanceReleaseResult =
  | {
      readonly ok: true;
      readonly releasedXaf: number;
      /** `null` : aucun acompte à libérer. */
      readonly treatment: PaymentTreatment | null;
    }
  | { readonly ok: false; readonly outcome: CommandHandlerOutcome };

/**
 * Libère l'acompte encore affecté à la commande (annulation ou clôture sans vente, BR-VEN-009,
 * AV-033) : affectations renversées (`ORDER_CANCELLED` ou `ORDER_CLOSED`), puis crédit client ou
 * remboursement (`SALE_REFUND`, pièce source = la commande). Le compteur `advance_paid_xaf` et le
 * sort consigné sur la commande s'écrivent avec le statut, par l'appelant.
 */
export async function releaseOrderAdvance(
  uow: Uow,
  deps: { readonly idGenerator: IdGenerator },
  input: {
    readonly orderId: string;
    readonly cause: 'ORDER_CANCELLED' | 'ORDER_CLOSED';
    readonly treatment: PaymentTreatment | null;
    readonly at: Date;
    readonly actorUserId: string;
    readonly deviceId: string | null;
    readonly commandId: string;
    readonly offline: boolean;
  },
): Promise<AdvanceReleaseResult> {
  const allocations = await uow
    .selectFrom('sales_payment_allocations')
    .selectAll()
    .where('order_id', '=', toBin(input.orderId))
    .where('status', '=', 'ACTIVE')
    .orderBy('allocated_at', 'desc')
    .orderBy('id', 'desc')
    .forUpdate()
    .execute();
  if (allocations.length === 0) return { ok: true, releasedXaf: 0, treatment: null };
  const paymentIds = [...new Set(allocations.map((allocation) => allocation.payment_id))];
  const payments = await uow
    .selectFrom('sales_customer_payments')
    .select(['id', 'customer_id', 'cash_account_id'])
    .where('id', 'in', paymentIds)
    .orderBy('id', 'asc')
    .forUpdate()
    .execute();
  const takenByPayment = new Map<string, number>();
  let releasedXaf = 0;
  for (const allocation of allocations) {
    await uow
      .updateTable('sales_payment_allocations')
      .set({ status: 'REVERSED', reversed_at: input.at, reversal_cause: input.cause })
      .where('id', '=', allocation.id)
      .execute();
    const key = fromBin(allocation.payment_id);
    takenByPayment.set(key, (takenByPayment.get(key) ?? 0) + Number(allocation.amount_xaf));
    releasedXaf += Number(allocation.amount_xaf);
  }
  const settled = await settleReleasedPayments(uow, deps, {
    payments,
    takenByPayment,
    treatment: input.treatment,
    sourceDocId: input.orderId,
    appliedAt: input.at,
    actorUserId: input.actorUserId,
    deviceId: input.deviceId,
    commandId: input.commandId,
    offline: input.offline,
  });
  if (!settled.ok) return settled;
  return { ok: true, releasedXaf, treatment: settled.treatment };
}

// --- Vente sur commande annulée par `sales.sale.cancel` ----------------------------------------------

/**
 * `sales.sale.cancel` et sa décision verrouillent d'abord la commande de la vente (ordre de verrous
 * commun) : lecture simple du lien, puis verrou de la commande.
 */
export async function lockOrderOfSale(uow: Uow, saleId: string): Promise<void> {
  const row = await uow
    .selectFrom('sales_sales')
    .select('order_id')
    .where('id', '=', toBin(saleId))
    .executeTakeFirst();
  if (row?.order_id) await lockOrder(uow, fromBin(row.order_id));
}

/** Applique `withdrawOrderAfterSaleCancellation` aux lignes d'un document d'annulation de vente. */
export async function syncOrderAfterSaleCancellation(
  uow: Uow,
  input: {
    readonly locked: LockedSale;
    readonly lines: readonly CancellationLine[];
    readonly at: Date;
    readonly actorUserId: string;
    readonly reasonCodeId: string | null;
    readonly comment: string | null;
  },
): Promise<void> {
  const { sale, lines: saleLines } = input.locked;
  if (!sale.order_id) return;
  const byId = new Map(saleLines.map((line) => [fromBin(line.id), line]));
  const cancelled = input.lines.flatMap((line) => {
    const saleLine = byId.get(line.saleLineId);
    return saleLine?.order_line_id
      ? [
          {
            orderLineId: fromBin(saleLine.order_line_id),
            quantityMilli: quantityMilliUnits(quantityFromDecimal(line.quantityBase)),
          },
        ]
      : [];
  });
  await withdrawOrderAfterSaleCancellation(uow, {
    saleDocNumber: sale.doc_number,
    orderId: fromBin(sale.order_id),
    cancelled,
    at: input.at,
    actorUserId: input.actorUserId,
    reasonCodeId: input.reasonCodeId,
    comment: input.comment,
  });
}

/**
 * Une vente sur commande annulée (en tout ou en partie) retire ces quantités de la commande
 * (DÉDUIT, AV-149 : « commande recalculée », SM-SALE) : le vendu net baisse et le commandé aussi,
 * la commande ne les revendra pas. Si plus rien ne reste ouvert, elle est annulée (rien livré) ou
 * clôturée (une part livrée) ; sinon son statut est recalculé. La commande est déjà verrouillée.
 */
export async function withdrawOrderAfterSaleCancellation(
  uow: Uow,
  input: {
    readonly saleDocNumber: string;
    readonly orderId: string;
    readonly cancelled: readonly { readonly orderLineId: string; readonly quantityMilli: number }[];
    readonly at: Date;
    readonly actorUserId: string;
    readonly reasonCodeId: string | null;
    readonly comment: string | null;
  },
): Promise<void> {
  const locked = await lockOrder(uow, input.orderId);
  if (!locked) return;
  const byLine = new Map<string, number>();
  for (const entry of input.cancelled) {
    byLine.set(entry.orderLineId, (byLine.get(entry.orderLineId) ?? 0) + entry.quantityMilli);
  }
  const retirements: LineRetirement[] = [];
  for (const line of locked.lines) {
    const quantityMilli = byLine.get(fromBin(line.id));
    if (quantityMilli !== undefined && quantityMilli > 0) {
      retirements.push({ line, cancelPendingMilli: 0, cancelUndeliveredMilli: quantityMilli });
    }
  }
  if (retirements.length === 0) return;
  await retireOrderLines(uow, retirements);
  const refreshed = await refreshOrderStatus(uow, input.orderId, { remainderCancelled: true });
  const total = refreshed.lines.reduce((sum, line) => sum + Number(line.line_total_xaf), 0);
  const reason = input.comment ?? `Annulation de la vente ${input.saleDocNumber}`;
  const closing = refreshed.status === 'CLOSED';
  const cancelling = refreshed.status === 'CANCELLED';
  await uow
    .updateTable('sales_sales_orders')
    .set((eb) => ({
      status: refreshed.status,
      total_estimated_xaf: total,
      updated_by: toBin(input.actorUserId),
      version: eb('version', '+', 1),
      ...(closing
        ? { closed_at: input.at, closed_by: toBin(input.actorUserId), closed_reason: reason }
        : {}),
      ...(cancelling
        ? {
            cancelled_at: input.at,
            cancelled_by: toBin(input.actorUserId),
            cancel_reason_code_id: toBinOrNull(input.reasonCodeId),
            cancel_comment: reason,
          }
        : {}),
    }))
    .where('id', '=', toBin(input.orderId))
    .execute();
}
