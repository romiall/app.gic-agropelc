/**
 * Annulation d'une vente, totale ou partielle (D04 BR-VEN-027, BR-VEN-028 ; ADR-028 §5 ; ADR-029 ;
 * SM-SALE) : une vente reste immuable ; une annulation est un **document** (`ANV`) dont les lignes
 * disent quelle quantité et quel montant de chaque ligne de vente sont annulés. Son effet :
 *
 * - **stock** : la marchandise revient à l'emplacement de départ par des mouvements `CUSTOMER_RETURN`
 *   rattachés à la vente d'origine (`inventory.returnSoldGoods`, ADR-029) — jamais l'inverse d'une
 *   vente ; une ligne de service n'a aucun mouvement ;
 * - **chiffre d'affaires** : `cancelled_xaf` de la vente et des lignes, à l'heure métier de
 *   l'application (`applied_at`), en un seul `UPDATE` par ligne et par vente (CHECK immédiats) ;
 * - **argent** : la part payée qui dépasse le nouveau net est **libérée** : les affectations sont
 *   renversées, la plus récente d'abord (le registre d'affectation est immuable : la part conservée
 *   d'une affectation partiellement libérée est recréée), puis la part libérée devient du **crédit
 *   client** (`unallocated_xaf`) ou un **remboursement** (`refunded_xaf`, mouvement de trésorerie
 *   `REFUND`) ; un encaissement sans client ne peut que se rembourser (AV-146) ;
 * - **prospect** : la conversion est signalée comme annulée quand la première vente du client est
 *   entièrement annulée (`crm.markConversionReverted`).
 *
 * Une annulation d'une vente sur commande est limitée au non-livré (ADR-029 §10).
 */
import {
  excessPaymentXaf,
  lineCancellationAmountXaf,
  quantityFromDecimal,
  quantityMilliUnits,
  quantityToDecimal,
  xaf,
  type IdGenerator,
} from '@gic/domain';
import type { Selectable } from 'kysely';
import type {
  SalesPaymentAllocations,
  SalesSaleLines,
  SalesSales,
} from '../../../../platform/kysely/schema.generated.js';
import { recordConflict } from '../../../../platform/sync/conflicts.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { findProduct } from '../../../catalog/application/public/index.js';
import { getCustomer, markConversionReverted } from '../../../crm/application/public/index.js';
import { recordCashMovement } from '../../../finance/application/public/index.js';
import { findStockLot, returnSoldGoods } from '../../../inventory/application/public/index.js';
import { rejected, type Uow } from './shared.js';
import type { CommandHandlerOutcome } from '../../../../platform/sync/command-handler-registry.js';

export type PaymentTreatment = 'REFUND' | 'CUSTOMER_CREDIT';
export const PAYMENT_TREATMENTS: readonly PaymentTreatment[] = ['REFUND', 'CUSTOMER_CREDIT'];

type SaleRow = Selectable<SalesSales>;
type LineRow = Selectable<SalesSaleLines>;

export interface LockedSale {
  readonly sale: SaleRow;
  readonly lines: readonly LineRow[];
}

/** Vente et lignes verrouillées pour la durée de la transaction (ordre constant : vente, lignes). */
export async function lockSale(uow: Uow, saleId: string): Promise<LockedSale | undefined> {
  const sale = await uow
    .selectFrom('sales_sales')
    .selectAll()
    .where('id', '=', toBin(saleId))
    .forUpdate()
    .executeTakeFirst();
  if (!sale) return undefined;
  const lines = await uow
    .selectFrom('sales_sale_lines')
    .selectAll()
    .where('sale_id', '=', sale.id)
    .orderBy('line_no', 'asc')
    .forUpdate()
    .execute();
  return { sale, lines };
}

export interface CancellationLine {
  /** Ligne du document d'annulation. */
  readonly id: string;
  readonly saleLineId: string;
  readonly quantityBase: number;
  readonly amountXaf: number;
}

export type CancellationPlan =
  | { readonly ok: true; readonly lines: readonly CancellationLine[]; readonly totalXaf: number }
  | { readonly ok: false; readonly outcome: CommandHandlerOutcome };

/** Quantité annulable d'une ligne : tout le non-annulé, et le non-livré d'une vente sur commande. */
function cancellableMilli(sale: SaleRow, line: LineRow): number {
  const delivered = sale.sale_type === 'ORDER' ? Number(line.delivered_quantity_base) : 0;
  return (
    quantityMilliUnits(quantityFromDecimal(Number(line.quantity_base))) -
    quantityMilliUnits(quantityFromDecimal(Number(line.cancelled_quantity_base))) -
    quantityMilliUnits(quantityFromDecimal(delivered))
  );
}

/**
 * Annulation de **tout** ce qui reste annulable d'une vente : une ligne d'annulation par ligne de
 * vente concernée, au prorata (la dernière annulation d'une ligne emporte le reste exact).
 */
export function planFullCancellation(
  idGenerator: IdGenerator,
  locked: LockedSale,
): CancellationPlan {
  const lines: CancellationLine[] = [];
  let totalXaf = 0;
  for (const line of locked.lines) {
    const remaining = cancellableMilli(locked.sale, line);
    if (remaining <= 0) continue;
    const amountXaf = lineCancellationAmountXaf({
      lineTotalXaf: xaf(Number(line.line_total_xaf)),
      quantity: quantityFromDecimal(Number(line.quantity_base)),
      alreadyCancelledQuantity: quantityFromDecimal(Number(line.cancelled_quantity_base)),
      alreadyCancelledXaf: xaf(Number(line.cancelled_xaf)),
      cancelQuantity: quantityFromDecimal(remaining / 1000),
    });
    lines.push({
      id: idGenerator.newId(),
      saleLineId: fromBin(line.id),
      quantityBase: remaining / 1000,
      amountXaf,
    });
    totalXaf += amountXaf;
  }
  if (lines.length === 0) {
    return {
      ok: false,
      outcome: rejected('NOTHING_TO_CANCEL', 'Plus rien à annuler sur cette vente.'),
    };
  }
  return { ok: true, lines, totalXaf };
}

export interface ApplyCancellationInput {
  readonly cancellationId: string;
  readonly locked: LockedSale;
  readonly lines: readonly CancellationLine[];
  /** Heure métier de l'effet sur le chiffre d'affaires et le stock. */
  readonly appliedAt: Date;
  /** Sort de la part payée libérée ; requis si une part est libérée. */
  readonly treatment: PaymentTreatment | null;
  readonly actorUserId: string;
  readonly deviceId: string | null;
  readonly commandId: string | null;
  readonly offline: boolean;
  readonly siteId: string;
}

export type ApplyCancellationResult =
  | {
      readonly ok: true;
      readonly cancelledTotalXaf: number;
      readonly releasedXaf: number;
      readonly fullyCancelled: boolean;
      /** Sort réellement appliqué à la part libérée (`null` : rien de libéré). */
      readonly treatment: PaymentTreatment | null;
    }
  | { readonly ok: false; readonly outcome: CommandHandlerOutcome };

const milliOf = (value: string | number): number =>
  quantityMilliUnits(quantityFromDecimal(Number(value)));

/**
 * Applique les lignes d'annulation déjà validées : stock, compteurs, libération des paiements,
 * conversion. Le document d'annulation (en-tête et lignes) est écrit par l'appelant, qui le fait
 * passer à `APPLIED` avec `applied_at` et le sort retenu.
 */
export async function applyCancellation(
  uow: Uow,
  deps: { readonly idGenerator: IdGenerator },
  input: ApplyCancellationInput,
): Promise<ApplyCancellationResult> {
  const { sale, lines: saleLines } = input.locked;
  const byLine = new Map(saleLines.map((line) => [fromBin(line.id), line]));

  // --- Capacité et montants recontrôlés sur l'état verrouillé (une demande peut dater) ----------
  let cancelledTotalXaf = 0;
  const canceledMilli = new Map<string, number>();
  for (const planned of input.lines) {
    const line = byLine.get(planned.saleLineId);
    if (!line)
      return { ok: false, outcome: rejected('SALE_LINE_UNKNOWN', 'Ligne de vente inconnue.') };
    const quantityMilli = quantityMilliUnits(quantityFromDecimal(planned.quantityBase));
    if (quantityMilli <= 0 || quantityMilli > cancellableMilli(sale, line)) {
      return {
        ok: false,
        outcome: rejected(
          'CANCELLATION_EXCEEDS_UNDELIVERED',
          'La quantité à annuler dépasse ce qui reste annulable (non annulé, non livré).',
        ),
      };
    }
    const expected = lineCancellationAmountXaf({
      lineTotalXaf: xaf(Number(line.line_total_xaf)),
      quantity: quantityFromDecimal(Number(line.quantity_base)),
      alreadyCancelledQuantity: quantityFromDecimal(Number(line.cancelled_quantity_base)),
      alreadyCancelledXaf: xaf(Number(line.cancelled_xaf)),
      cancelQuantity: quantityFromDecimal(planned.quantityBase),
    });
    if (expected !== planned.amountXaf) {
      return {
        ok: false,
        outcome: rejected(
          'CANCELLATION_STALE',
          'La vente a changé depuis la demande d’annulation : la refaire.',
        ),
      };
    }
    canceledMilli.set(planned.saleLineId, quantityMilli);
    cancelledTotalXaf += planned.amountXaf;
  }

  // --- Stock : retours rattachés à la vente d'origine ------------------------------------------------
  for (const planned of input.lines) {
    const line = byLine.get(planned.saleLineId)!;
    const product = await findProduct(uow, fromBin(line.product_id));
    if (!product || product.stockFamily === 'SERVICE') continue;
    const settled = await returnSoldGoods(uow, deps, {
      saleId: fromBin(sale.id),
      saleLineId: planned.saleLineId,
      quantityBase: planned.quantityBase,
      sourceDocId: input.cancellationId,
      sourceLineId: planned.id,
      occurredAt: input.appliedAt,
      createdBy: input.actorUserId,
      ...(input.deviceId !== null ? { createdDeviceId: input.deviceId } : {}),
      ...(input.commandId !== null ? { commandId: input.commandId } : {}),
      capturedOffline: input.offline,
    });
    // AV-138 : la marchandise revient dans un lot déjà clos ; appliqué, avec un conflit informatif.
    for (const lotId of new Set(settled.flatMap((move) => (move.lotId ? [move.lotId] : [])))) {
      const lot = await findStockLot(uow, lotId);
      if (lot?.status === 'CLOSED') {
        await recordConflict(uow, {
          id: deps.idGenerator.newId(),
          commandId: input.commandId,
          conflictType: 'LOT_CLOSED',
          entityType: 'SALE',
          entityId: fromBin(sale.id),
          siteId: input.siteId,
          ownerRole: 'RESP_PRODUCTION',
          applied: true,
          details: { cancellationId: input.cancellationId, lotId, saleLineId: planned.saleLineId },
        });
      }
    }
  }

  // --- Compteurs des lignes, un seul UPDATE par ligne ----------------------------------------------------
  for (const planned of input.lines) {
    const line = byLine.get(planned.saleLineId)!;
    await uow
      .updateTable('sales_sale_lines')
      .set({
        cancelled_quantity_base: String(
          quantityToDecimal(
            quantityFromDecimal(
              (milliOf(line.cancelled_quantity_base) + canceledMilli.get(planned.saleLineId)!) /
                1000,
            ),
          ),
        ),
        cancelled_xaf: Number(line.cancelled_xaf) + planned.amountXaf,
      })
      .where('id', '=', line.id)
      .execute();
  }

  // --- Vente : annulé, payé libéré et statut, en un seul UPDATE ---------------------------------------------
  const newCancelled = Number(sale.cancelled_xaf) + cancelledTotalXaf;
  const net = Number(sale.total_xaf) - newCancelled;
  const released = excessPaymentXaf(xaf(net), xaf(Number(sale.amount_paid_xaf)));
  const fullyCancelled = saleLines.every(
    (line) =>
      milliOf(line.cancelled_quantity_base) + (canceledMilli.get(fromBin(line.id)) ?? 0) ===
      milliOf(line.quantity_base),
  );
  await uow
    .updateTable('sales_sales')
    .set({
      cancelled_xaf: newCancelled,
      amount_paid_xaf: Number(sale.amount_paid_xaf) - released,
      status: fullyCancelled ? 'CANCELLED' : 'CONFIRMED',
    })
    .where('id', '=', sale.id)
    .execute();

  // --- Argent libéré : affectations renversées, crédit client ou remboursement -------------------------------
  let appliedTreatment: PaymentTreatment | null = null;
  if (released > 0) {
    const freed = await releasePayments(uow, deps, {
      saleId: fromBin(sale.id),
      amountXaf: released,
      treatment: input.treatment,
      cancellationId: input.cancellationId,
      appliedAt: input.appliedAt,
      actorUserId: input.actorUserId,
      deviceId: input.deviceId,
      commandId: input.commandId,
      offline: input.offline,
    });
    if (!freed.ok) return freed;
    appliedTreatment = freed.treatment;
  }

  // --- Prospect : la conversion est signalée annulée si c'est sa première vente, entièrement annulée ------------
  if (fullyCancelled && sale.customer_id) {
    let customer = await getCustomer(uow, fromBin(sale.customer_id));
    if (customer?.stage === 'MERGED' && customer.mergedIntoId) {
      customer = await getCustomer(uow, customer.mergedIntoId);
    }
    if (customer?.firstSaleId === fromBin(sale.id)) {
      await markConversionReverted(uow, customer.id, input.appliedAt);
    }
  }

  return {
    ok: true,
    cancelledTotalXaf,
    releasedXaf: released,
    fullyCancelled,
    treatment: appliedTreatment,
  };
}

type AllocationRow = Selectable<SalesPaymentAllocations>;

/**
 * Libère `amountXaf` des affectations actives de la vente, la plus récente d'abord. Le registre
 * d'affectation est immuable (sauf `ACTIVE` → `REVERSED`) : une affectation partiellement libérée
 * est renversée en entier et sa part conservée est réaffectée par une nouvelle ligne (INV-FIN-04).
 */
async function releasePayments(
  uow: Uow,
  deps: { readonly idGenerator: IdGenerator },
  input: {
    readonly saleId: string;
    readonly amountXaf: number;
    readonly treatment: PaymentTreatment | null;
    readonly cancellationId: string;
    readonly appliedAt: Date;
    readonly actorUserId: string;
    readonly deviceId: string | null;
    readonly commandId: string | null;
    readonly offline: boolean;
  },
): Promise<
  | { readonly ok: true; readonly treatment: PaymentTreatment }
  | { readonly ok: false; readonly outcome: CommandHandlerOutcome }
> {
  const allocations: readonly AllocationRow[] = await uow
    .selectFrom('sales_payment_allocations')
    .selectAll()
    .where('sale_id', '=', toBin(input.saleId))
    .where('status', '=', 'ACTIVE')
    .orderBy('allocated_at', 'desc')
    .orderBy('id', 'desc')
    .forUpdate()
    .execute();
  const paymentIds = [...new Set(allocations.map((allocation) => allocation.payment_id))];
  const payments = paymentIds.length
    ? await uow
        .selectFrom('sales_customer_payments')
        .select(['id', 'customer_id', 'cash_account_id', 'status'])
        .where('id', 'in', paymentIds)
        .orderBy('id', 'asc')
        .forUpdate()
        .execute()
    : [];

  let remaining = input.amountXaf;
  const takenByPayment = new Map<string, number>();
  for (const allocation of allocations) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Number(allocation.amount_xaf));
    await uow
      .updateTable('sales_payment_allocations')
      .set({
        status: 'REVERSED',
        reversed_at: input.appliedAt,
        reversal_cause: 'SALE_CANCELLED',
      })
      .where('id', '=', allocation.id)
      .execute();
    if (take < Number(allocation.amount_xaf)) {
      await uow
        .insertInto('sales_payment_allocations')
        .values({
          id: toBin(deps.idGenerator.newId()),
          payment_id: allocation.payment_id,
          sale_id: allocation.sale_id,
          amount_xaf: Number(allocation.amount_xaf) - take,
          allocated_at: allocation.allocated_at,
          ...(input.commandId !== null ? { command_id: toBin(input.commandId) } : {}),
          created_by: toBin(input.actorUserId),
        })
        .execute();
    }
    const key = fromBin(allocation.payment_id);
    takenByPayment.set(key, (takenByPayment.get(key) ?? 0) + take);
    remaining -= take;
  }

  // Un encaissement sans client ne peut pas devenir du crédit : il se rembourse (AV-146). Le choix
  // n'est exigé que s'il existe au moins un encaissement identifié parmi ceux dont une part est libérée.
  const identified = payments.some(
    (payment) => payment.customer_id !== null && (takenByPayment.get(fromBin(payment.id)) ?? 0) > 0,
  );
  if (identified && input.treatment === null) {
    return {
      ok: false,
      outcome: rejected(
        'PAYMENT_TREATMENT_REQUIRED',
        'Indiquer le sort de la part payée libérée : remboursement ou crédit client.',
      ),
    };
  }
  // Encaissements dans l'ordre de leur identifiant : comptes de trésorerie verrouillés dans un ordre constant.
  for (const payment of payments) {
    const id = fromBin(payment.id);
    const taken = takenByPayment.get(id) ?? 0;
    if (taken === 0) continue;
    const treatment: PaymentTreatment = payment.customer_id === null ? 'REFUND' : input.treatment!;
    if (treatment === 'REFUND') {
      await recordCashMovement(uow, deps, {
        cashAccountId: fromBin(payment.cash_account_id),
        direction: 'OUT',
        amountXaf: taken,
        movementType: 'REFUND',
        sourceDocType: 'SALE_REFUND',
        sourceDocId: input.cancellationId,
        occurredAt: input.appliedAt,
        createdBy: input.actorUserId,
        ...(input.deviceId !== null ? { createdDeviceId: input.deviceId } : {}),
        ...(input.commandId !== null ? { commandId: input.commandId } : {}),
        capturedOffline: input.offline,
        allowNegative: input.offline,
      });
      await uow
        .updateTable('sales_customer_payments')
        .set((eb) => ({ refunded_xaf: eb('refunded_xaf', '+', taken) }))
        .where('id', '=', payment.id)
        .execute();
    } else {
      await uow
        .updateTable('sales_customer_payments')
        .set((eb) => ({ unallocated_xaf: eb('unallocated_xaf', '+', taken) }))
        .where('id', '=', payment.id)
        .execute();
    }
  }
  return { ok: true, treatment: identified ? input.treatment! : 'REFUND' };
}
