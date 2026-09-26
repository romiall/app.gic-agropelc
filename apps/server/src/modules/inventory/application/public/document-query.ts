/**
 * Lectures des documents de stock (P2-05 ; 08-api-events/01-architecture-api.md §4.6 :
 * `/transfers`, `/losses`, `/consumptions`, `/inventory-counts`, `/thresholds`, `/costs`).
 * Même contrat que `stock-query.ts` : aucune décision d'autorisation ici (portée et montants
 * décidés par le transport `inventory-api/`), montants toujours renvoyés.
 *
 * Pagination des listes : par curseur (01-architecture-api.md §2), du plus récent au plus
 * ancien sur `id` — un UUIDv7 dont l'horodatage est celui de la création du document
 * (`aggregate_id` contrôlé par le pipeline, ADR-002) ; le curseur est l'`id` du dernier
 * élément renvoyé.
 */
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { evaluateStockThreshold, type StockThresholdState } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { availableQty, formatDateColumn } from './stock-query.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface PageRequest {
  readonly beforeId?: string;
  readonly limit: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

function pageOf<Row extends { readonly id: Buffer }, T>(
  rows: readonly Row[],
  limit: number,
  map: (row: Row) => T,
): Page<T> {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return { items: page.map(map), nextCursor: hasMore && last ? fromBin(last.id) : null };
}

function numOrNull(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

// ---------------------------------------------------------------------------------------
// Transferts (SM-TRANSFER)
// ---------------------------------------------------------------------------------------

export interface TransferSummary {
  readonly id: string;
  readonly docNumber: string;
  readonly transferKind: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly siteId: string;
  readonly status: string;
  readonly requestedBy: string | null;
  readonly requestedAt: Date | null;
  readonly dispatchedBy: string | null;
  readonly dispatchedAt: Date | null;
  readonly carrierUserId: string | null;
  readonly carrierName: string | null;
  readonly receivedBy: string | null;
  readonly receivedAt: Date | null;
  readonly approvalRequestId: string | null;
  readonly notes: string | null;
  readonly occurredAt: Date;
  readonly capturedOffline: boolean;
  readonly version: number;
}

export interface TransferLine {
  readonly id: string;
  readonly productId: string;
  readonly lotId: string | null;
  readonly unitCode: string;
  readonly requestedQtyBase: number | null;
  readonly dispatchedQtyBase: number | null;
  readonly receivedQtyBase: number | null;
  readonly discrepancyQtyBase: number | null;
  readonly discrepancyReasonCodeId: string | null;
  readonly returnedQtyBase: number;
}

export interface TransferDetail extends TransferSummary {
  readonly lines: readonly TransferLine[];
}

function transferSummaryOf(row: Selectable<DB['inventory_stock_transfers']>): TransferSummary {
  return {
    id: fromBin(row.id),
    docNumber: row.doc_number,
    transferKind: row.transfer_kind,
    fromLocationId: fromBin(row.from_location_id),
    toLocationId: fromBin(row.to_location_id),
    siteId: fromBin(row.site_id),
    status: row.status,
    requestedBy: fromBinOrNull(row.requested_by),
    requestedAt: row.requested_at,
    dispatchedBy: fromBinOrNull(row.dispatched_by),
    dispatchedAt: row.dispatched_at,
    carrierUserId: fromBinOrNull(row.carrier_user_id),
    carrierName: row.carrier_name,
    receivedBy: fromBinOrNull(row.received_by),
    receivedAt: row.received_at,
    approvalRequestId: fromBinOrNull(row.approval_request_id),
    notes: row.notes,
    occurredAt: row.occurred_at,
    capturedOffline: Boolean(row.captured_offline),
    version: Number(row.version),
  };
}

/** `GET /transfers?location_id=&direction=&status=` : transferts dont l'emplacement est la
 * source (`OUT`), la destination (`IN`) ou l'un des deux (défaut). */
export async function listTransfers(
  executor: Executor,
  params: PageRequest & {
    readonly locationId: string;
    readonly direction?: 'IN' | 'OUT';
    readonly status?: string;
  },
): Promise<Page<TransferSummary>> {
  const location = toBin(params.locationId);
  const rows = await executor
    .selectFrom('inventory_stock_transfers')
    .selectAll()
    .where((eb) =>
      params.direction === 'IN'
        ? eb('to_location_id', '=', location)
        : params.direction === 'OUT'
          ? eb('from_location_id', '=', location)
          : eb.or([eb('to_location_id', '=', location), eb('from_location_id', '=', location)]),
    )
    .$if(params.status !== undefined, (qb) => qb.where('status', '=', params.status!))
    .$if(params.beforeId !== undefined, (qb) => qb.where('id', '<', toBin(params.beforeId!)))
    .orderBy('id', 'desc')
    .limit(params.limit + 1)
    .execute();
  return pageOf(rows, params.limit, transferSummaryOf);
}

export async function getTransfer(
  executor: Executor,
  transferId: string,
): Promise<TransferDetail | undefined> {
  const row = await executor
    .selectFrom('inventory_stock_transfers')
    .selectAll()
    .where('id', '=', toBin(transferId))
    .executeTakeFirst();
  if (!row) return undefined;
  const lines = await executor
    .selectFrom('inventory_stock_transfer_lines')
    .selectAll()
    .where('transfer_id', '=', row.id)
    .orderBy('id', 'asc')
    .execute();
  return {
    ...transferSummaryOf(row),
    lines: lines.map((line) => ({
      id: fromBin(line.id),
      productId: fromBin(line.product_id),
      lotId: fromBinOrNull(line.lot_id),
      unitCode: line.unit_code,
      requestedQtyBase: numOrNull(line.requested_qty_base),
      dispatchedQtyBase: numOrNull(line.dispatched_qty_base),
      receivedQtyBase: numOrNull(line.received_qty_base),
      discrepancyQtyBase: numOrNull(line.discrepancy_qty_base),
      discrepancyReasonCodeId: fromBinOrNull(line.discrepancy_reason_code_id),
      returnedQtyBase: Number(line.returned_qty_base),
    })),
  };
}

// ---------------------------------------------------------------------------------------
// Pertes (SM-LOSS)
// ---------------------------------------------------------------------------------------

export interface LossDeclarationSummary {
  readonly id: string;
  readonly docNumber: string;
  readonly locationId: string;
  readonly siteId: string;
  readonly productId: string;
  readonly lotId: string | null;
  readonly productionLotId: string | null;
  readonly quantity: number;
  readonly unitCode: string;
  readonly quantityBase: number;
  readonly category: string;
  readonly reasonCodeId: string | null;
  readonly comment: string | null;
  readonly status: string;
  readonly requiresApproval: boolean;
  readonly requiresPhoto: boolean;
  readonly approvalRequestId: string | null;
  readonly declaredBy: string;
  readonly responsibilityUserId: string | null;
  readonly occurredAt: Date;
  readonly businessDate: string | null;
  /** Mesure financière (RC-05). */
  readonly unitCostXaf: number;
  /** Mesure financière (RC-05). */
  readonly valueXaf: number;
  readonly cancelledAt: Date | null;
  readonly capturedOffline: boolean;
}

/** `GET /losses?location_id=&status=` ; `declaredBy` restreint aux déclarations d'un auteur
 * (portée `OWN` de `inventory.loss.read`, AV-094). */
export async function listLossDeclarations(
  executor: Executor,
  params: PageRequest & {
    readonly locationId: string;
    readonly status?: string;
    readonly declaredBy?: string;
  },
): Promise<Page<LossDeclarationSummary>> {
  const rows = await executor
    .selectFrom('inventory_loss_declarations')
    .selectAll()
    .where('location_id', '=', toBin(params.locationId))
    .$if(params.status !== undefined, (qb) => qb.where('status', '=', params.status!))
    .$if(params.declaredBy !== undefined, (qb) =>
      qb.where('declared_by', '=', toBin(params.declaredBy!)),
    )
    .$if(params.beforeId !== undefined, (qb) => qb.where('id', '<', toBin(params.beforeId!)))
    .orderBy('id', 'desc')
    .limit(params.limit + 1)
    .execute();
  return pageOf(rows, params.limit, (row) => ({
    id: fromBin(row.id),
    docNumber: row.doc_number,
    locationId: fromBin(row.location_id),
    siteId: fromBin(row.site_id),
    productId: fromBin(row.product_id),
    lotId: fromBinOrNull(row.lot_id),
    productionLotId: fromBinOrNull(row.production_lot_id),
    quantity: Number(row.quantity),
    unitCode: row.unit_code,
    quantityBase: Number(row.quantity_base),
    category: row.category,
    reasonCodeId: fromBinOrNull(row.reason_code_id),
    comment: row.comment,
    status: row.status,
    requiresApproval: Boolean(row.requires_approval),
    requiresPhoto: Boolean(row.requires_photo),
    approvalRequestId: fromBinOrNull(row.approval_request_id),
    declaredBy: fromBin(row.declared_by),
    responsibilityUserId: fromBinOrNull(row.responsibility_user_id),
    occurredAt: row.occurred_at,
    businessDate: formatDateColumn(row.business_date),
    unitCostXaf: row.unit_cost_xaf,
    valueXaf: row.value_xaf,
    cancelledAt: row.cancelled_at,
    capturedOffline: Boolean(row.captured_offline),
  }));
}

// ---------------------------------------------------------------------------------------
// Consommations (BR-STK-036)
// ---------------------------------------------------------------------------------------

export interface ConsumptionSummary {
  readonly id: string;
  readonly locationId: string;
  readonly productId: string;
  readonly lotId: string | null;
  readonly quantity: number;
  readonly unitCode: string;
  readonly quantityBase: number;
  readonly costObjectType: string;
  readonly costObjectId: string;
  readonly status: string;
  readonly recordedBy: string;
  readonly occurredAt: Date;
  /** Mesure financière (RC-05). */
  readonly valueXaf: number;
  readonly cancelledAt: Date | null;
  readonly cancelledBy: string | null;
  readonly capturedOffline: boolean;
}

/** `GET /consumptions?location_id=&status=&cost_object_type=&cost_object_id=`. */
export async function listConsumptions(
  executor: Executor,
  params: PageRequest & {
    readonly locationId: string;
    readonly status?: string;
    readonly costObjectType?: string;
    readonly costObjectId?: string;
  },
): Promise<Page<ConsumptionSummary>> {
  const rows = await executor
    .selectFrom('inventory_consumptions')
    .selectAll()
    .where('location_id', '=', toBin(params.locationId))
    .$if(params.status !== undefined, (qb) => qb.where('status', '=', params.status!))
    .$if(params.costObjectType !== undefined, (qb) =>
      qb.where('cost_object_type', '=', params.costObjectType!),
    )
    .$if(params.costObjectId !== undefined, (qb) =>
      qb.where('cost_object_id', '=', toBin(params.costObjectId!)),
    )
    .$if(params.beforeId !== undefined, (qb) => qb.where('id', '<', toBin(params.beforeId!)))
    .orderBy('id', 'desc')
    .limit(params.limit + 1)
    .execute();
  return pageOf(rows, params.limit, (row) => ({
    id: fromBin(row.id),
    locationId: fromBin(row.location_id),
    productId: fromBin(row.product_id),
    lotId: fromBinOrNull(row.lot_id),
    quantity: Number(row.quantity),
    unitCode: row.unit_code,
    quantityBase: Number(row.quantity_base),
    costObjectType: row.cost_object_type,
    costObjectId: fromBin(row.cost_object_id),
    status: row.status,
    recordedBy: fromBin(row.recorded_by),
    occurredAt: row.occurred_at,
    valueXaf: row.value_xaf,
    cancelledAt: row.cancelled_at,
    cancelledBy: fromBinOrNull(row.cancelled_by),
    capturedOffline: Boolean(row.captured_offline),
  }));
}

// ---------------------------------------------------------------------------------------
// Inventaires (SM-INVENTORY-COUNT)
// ---------------------------------------------------------------------------------------

export interface InventoryCountSummary {
  readonly id: string;
  readonly docNumber: string;
  readonly locationId: string;
  readonly siteId: string;
  readonly countType: string;
  readonly status: string;
  readonly openedBy: string | null;
  readonly occurredAt: Date;
  readonly submittedBy: string | null;
  readonly submittedAt: Date | null;
  readonly postedAt: Date | null;
  /** Mesure financière (RC-05). */
  readonly varianceValueXaf: number | null;
  /** Mesure financière (RC-05). */
  readonly absVarianceValueXaf: number | null;
  readonly approvalRequestId: string | null;
  readonly capturedOffline: boolean;
  readonly version: number;
}

export interface InventoryCountLine {
  readonly id: string;
  readonly productId: string;
  readonly lotId: string | null;
  readonly countedQtyBase: number;
  readonly countedAt: Date;
  readonly theoreticalQtyBase: number | null;
  readonly varianceQtyBase: number | null;
  readonly varianceReasonCodeId: string | null;
  /** Mesure financière (RC-05). */
  readonly unitCostXaf: number | null;
  /** Mesure financière (RC-05). */
  readonly declaredUnitCostXaf: number | null;
  readonly comment: string | null;
}

export interface InventoryCountDetail extends InventoryCountSummary {
  readonly lines: readonly InventoryCountLine[];
}

function countSummaryOf(row: Selectable<DB['inventory_inventory_counts']>): InventoryCountSummary {
  return {
    id: fromBin(row.id),
    docNumber: row.doc_number,
    locationId: fromBin(row.location_id),
    siteId: fromBin(row.site_id),
    countType: row.count_type,
    status: row.status,
    openedBy: fromBinOrNull(row.opened_by),
    occurredAt: row.occurred_at,
    submittedBy: fromBinOrNull(row.submitted_by),
    submittedAt: row.submitted_at,
    postedAt: row.posted_at,
    varianceValueXaf: row.variance_value_xaf,
    absVarianceValueXaf: row.abs_variance_value_xaf,
    approvalRequestId: fromBinOrNull(row.approval_request_id),
    capturedOffline: Boolean(row.captured_offline),
    version: Number(row.version),
  };
}

/** `GET /inventory-counts?location_id=&status=`. */
export async function listInventoryCounts(
  executor: Executor,
  params: PageRequest & { readonly locationId: string; readonly status?: string },
): Promise<Page<InventoryCountSummary>> {
  const rows = await executor
    .selectFrom('inventory_inventory_counts')
    .selectAll()
    .where('location_id', '=', toBin(params.locationId))
    .$if(params.status !== undefined, (qb) => qb.where('status', '=', params.status!))
    .$if(params.beforeId !== undefined, (qb) => qb.where('id', '<', toBin(params.beforeId!)))
    .orderBy('id', 'desc')
    .limit(params.limit + 1)
    .execute();
  return pageOf(rows, params.limit, countSummaryOf);
}

/** `GET /inventory-counts/{id}` : en-tête et lignes (théorique et écart renseignés à la
 * soumission, `count-commands.ts`). */
export async function getInventoryCount(
  executor: Executor,
  countId: string,
): Promise<InventoryCountDetail | undefined> {
  const row = await executor
    .selectFrom('inventory_inventory_counts')
    .selectAll()
    .where('id', '=', toBin(countId))
    .executeTakeFirst();
  if (!row) return undefined;
  const lines = await executor
    .selectFrom('inventory_inventory_count_lines')
    .selectAll()
    .where('count_id', '=', row.id)
    .orderBy('id', 'asc')
    .execute();
  return {
    ...countSummaryOf(row),
    lines: lines.map((line) => ({
      id: fromBin(line.id),
      productId: fromBin(line.product_id),
      lotId: fromBinOrNull(line.lot_id),
      countedQtyBase: Number(line.counted_qty_base),
      countedAt: line.counted_at,
      theoreticalQtyBase: numOrNull(line.theoretical_qty_base),
      varianceQtyBase: numOrNull(line.variance_qty_base),
      varianceReasonCodeId: fromBinOrNull(line.variance_reason_code_id),
      unitCostXaf: line.unit_cost_xaf,
      declaredUnitCostXaf: line.declared_unit_cost_xaf,
      comment: line.comment,
    })),
  };
}

// ---------------------------------------------------------------------------------------
// Seuils (BR-STK-051, AV-040)
// ---------------------------------------------------------------------------------------

export interface StockThresholdStatus {
  readonly id: string;
  readonly productId: string;
  readonly minQtyBase: number;
  readonly targetQtyBase: number;
  readonly qtyAvailable: number;
  /** Σ des quantités expédiées vers l'emplacement, transferts encore `DISPATCHED`. */
  readonly qtyInTransitIn: number;
  readonly state: StockThresholdState;
  readonly suggestedQty: number;
  readonly version: number;
  readonly updatedAt: Date;
}

/**
 * `GET /thresholds?location_id=` : seuils actifs de l'emplacement, évalués sur le disponible
 * courant (BR-STK-051, `evaluateStockThreshold` partagé appareil/serveur). C'est la vue
 * « alertes de stock simples » de P2 (REQ-057) : l'émission d'alertes `STOCK_LOW`/`STOCK_OUT`
 * dans `communication.alerts` dépend du module `communication`, pas encore construit.
 */
export async function listStockThresholds(
  executor: Executor,
  params: {
    readonly locationId: string;
    readonly custodyMode: string | null;
    readonly productId?: string;
  },
): Promise<readonly StockThresholdStatus[]> {
  const location = toBin(params.locationId);
  const thresholds = await executor
    .selectFrom('inventory_stock_thresholds')
    .selectAll()
    .where('location_id', '=', location)
    .where('is_active', '=', 1)
    .$if(params.productId !== undefined, (qb) =>
      qb.where('product_id', '=', toBin(params.productId!)),
    )
    .orderBy('product_id', 'asc')
    .execute();
  if (thresholds.length === 0) return [];
  const productIds = thresholds.map((t) => t.product_id);

  const balances = await executor
    .selectFrom('inventory_stock_balances')
    .select([
      'product_id',
      sql<string>`SUM(qty_on_hand)`.as('qty_on_hand'),
      sql<string>`SUM(qty_reserved)`.as('qty_reserved'),
      sql<string>`SUM(qty_allocated)`.as('qty_allocated'),
    ])
    .where('location_id', '=', location)
    .where('product_id', 'in', productIds)
    .groupBy('product_id')
    .execute();
  const balanceByProduct = new Map(balances.map((b) => [fromBin(b.product_id), b]));

  const transit = await executor
    .selectFrom('inventory_stock_transfer_lines as tl')
    .innerJoin('inventory_stock_transfers as t', 't.id', 'tl.transfer_id')
    .select(['tl.product_id as product_id', sql<string>`SUM(tl.dispatched_qty_base)`.as('qty')])
    .where('t.to_location_id', '=', location)
    .where('t.status', '=', 'DISPATCHED')
    .where('tl.product_id', 'in', productIds)
    .groupBy('tl.product_id')
    .execute();
  const transitByProduct = new Map(transit.map((t) => [fromBin(t.product_id), Number(t.qty)]));

  return thresholds.map((threshold) => {
    const productId = fromBin(threshold.product_id);
    const balance = balanceByProduct.get(productId);
    const qtyAvailable = availableQty(
      params.custodyMode,
      Number(balance?.qty_on_hand ?? 0),
      Number(balance?.qty_reserved ?? 0),
      Number(balance?.qty_allocated ?? 0),
    );
    const qtyInTransitIn = transitByProduct.get(productId) ?? 0;
    const minQtyBase = Number(threshold.min_qty_base);
    const targetQtyBase = Number(threshold.target_qty_base);
    const evaluation = evaluateStockThreshold({
      available: qtyAvailable,
      minQty: minQtyBase,
      targetQty: targetQtyBase,
      inTransitIn: qtyInTransitIn,
    });
    return {
      id: fromBin(threshold.id),
      productId,
      minQtyBase,
      targetQtyBase,
      qtyAvailable,
      qtyInTransitIn,
      state: evaluation.state,
      suggestedQty: evaluation.suggestedQty,
      version: Number(threshold.version),
      updatedAt: threshold.updated_at,
    };
  });
}

// ---------------------------------------------------------------------------------------
// Écritures de coût (registre de coûts, socle P2)
// ---------------------------------------------------------------------------------------

export interface CostEntry {
  readonly id: string;
  readonly costObjectType: string;
  readonly costObjectId: string;
  readonly costType: string;
  readonly direction: string;
  readonly amountXaf: number;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly reversesEntryId: string | null;
  readonly occurredAt: Date;
  readonly comment: string | null;
  readonly createdBy: string;
}

/** `GET /costs?cost_object_type=&cost_object_id=` (mesure financière de bout en bout, RC-05). */
export async function listCostEntries(
  executor: Executor,
  params: PageRequest & { readonly costObjectType: string; readonly costObjectId: string },
): Promise<Page<CostEntry>> {
  const rows = await executor
    .selectFrom('inventory_cost_entries')
    .selectAll()
    .where('cost_object_type', '=', params.costObjectType)
    .where('cost_object_id', '=', toBin(params.costObjectId))
    .$if(params.beforeId !== undefined, (qb) => qb.where('id', '<', toBin(params.beforeId!)))
    .orderBy('id', 'desc')
    .limit(params.limit + 1)
    .execute();
  return pageOf(rows, params.limit, (row) => ({
    id: fromBin(row.id),
    costObjectType: row.cost_object_type,
    costObjectId: fromBin(row.cost_object_id),
    costType: row.cost_type,
    direction: row.direction,
    amountXaf: row.amount_xaf,
    sourceType: row.source_type,
    sourceId: fromBin(row.source_id),
    reversesEntryId: fromBinOrNull(row.reverses_entry_id),
    occurredAt: row.occurred_at,
    comment: row.comment,
    createdBy: fromBin(row.created_by),
  }));
}
