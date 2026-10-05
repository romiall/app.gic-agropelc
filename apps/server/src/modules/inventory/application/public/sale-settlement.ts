/**
 * Règlement de la marchandise vendue (ADR-029 ; BR-STK-055 à 057) : annulation, totale ou
 * partielle, d'une vente (`returnSoldGoods`), livraison d'une vente sur commande
 * (`deliverSoldGoods`) et lecture du net d'une ligne de vente (`soldGoodsPosition`).
 *
 * Le module `sales` ne connaît ni lots ni mouvements : il désigne une ligne de vente (vente et
 * ligne, qui sont la source `SALE` des mouvements de la vente) et une quantité en unité de base.
 * Ce module choisit les mouvements `SALE` d'origine — une vente répartie sur plusieurs lots par le
 * FIFO en a un par lot — et enregistre un mouvement rattaché (`originMoveId`) par origine servie :
 *
 * - **livraison** (`DELIVERY`, `V_TO_DELIVER` → `V_CUSTOMER`) : origines dans l'ordre FIFO (lot le
 *   plus ancien d'abord) ; seule une vente sur commande se livre ;
 * - **retour** (`CUSTOMER_RETURN`, depuis `V_CUSTOMER` ou `V_TO_DELIVER` vers le départ de
 *   l'origine) : ordre inverse (lot le plus récent d'abord), ce qui laisse le net d'une vente plus
 *   petite ; un lot peut être visé (perte ciblée, AV-131).
 * Une origine sans lot (repli hors ligne, BR-STK-018) compte comme la plus récente ; le départage
 * est `occurred_at`, `recorded_at`, puis identifiant — jamais l'ordre des UUID. Chaque origine
 * absorbe au plus son reste ; la somme des restes doit couvrir la demande, sinon rien n'est écrit
 * (`SETTLEMENT_EXCEEDS_REMAINING`).
 *
 * Concurrence : aucune lecture verrouillante du registre (le compte applicatif n'a pas `UPDATE`
 * dessus, INV-GLO-05). L'appelant verrouille d'abord la ligne de vente (`sales_sale_lines`, qu'il
 * possède), ce qui sérialise annulations et livraisons d'une même ligne ; le déclencheur du
 * registre est le filet (INV-STK-17).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { virtualLocationId } from '../commands/shared.js';
import {
  InventoryMoveError,
  recordStockMove,
  type MoveType,
  type RecordMoveDeps,
  type SourceDocType,
} from './record-move.js';

type Executor = Kysely<DB> | Transaction<DB>;

/** Une ligne de vente : la vente et la ligne portées par ses mouvements `SALE` (`source_*`). */
export interface SoldGoodsLine {
  readonly saleId: string;
  readonly saleLineId: string;
}

export interface SettleSoldGoodsInput extends SoldGoodsLine {
  /** Quantité à contre-passer ou à livrer, en unité de base (> 0). */
  readonly quantityBase: number;
  /** Document de règlement : annulation de vente (retour) ou bon de livraison (livraison). */
  readonly sourceDocId: string;
  readonly sourceLineId?: string;
  /** Retour seulement : se limite aux origines de ce lot (perte ciblée, AV-131). */
  readonly lotId?: string;
  readonly occurredAt: Date;
  readonly createdBy: string;
  readonly createdDeviceId?: string;
  readonly commandId?: string;
  readonly capturedOffline?: boolean;
}

export interface SettledMove {
  readonly moveId: string;
  readonly originMoveId: string;
  readonly lotId: string | null;
  readonly quantity: number;
  readonly unitCostXaf: number;
  readonly valueXaf: number;
}

interface Origin {
  readonly id: string;
  readonly productId: string;
  readonly lotId: string | null;
  readonly quantityMilli: number;
  readonly valueXaf: number;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly toLocationType: string;
  readonly occurredAt: number;
  readonly recordedAt: number;
  /** Rang FIFO du lot ; `null` sans lot. */
  readonly lotRank: number | null;
  readonly deliveredMilli: number;
  readonly returnedMilli: number;
  readonly deliveredValueXaf: number;
  readonly returnedValueXaf: number;
}

const toMilli = (value: string | number): number => Math.round(Number(value) * 1000);

async function loadOrigins(executor: Executor, line: SoldGoodsLine): Promise<readonly Origin[]> {
  const rows = await executor
    .selectFrom('inventory_stock_moves as m')
    .innerJoin('organization_locations as tl', 'tl.id', 'm.to_location_id')
    .leftJoin('inventory_stock_lots as l', 'l.id', 'm.lot_id')
    .select([
      'm.id as id',
      'm.product_id as product_id',
      'm.lot_id as lot_id',
      'm.quantity as quantity',
      'm.value_xaf as value_xaf',
      'm.from_location_id as from_location_id',
      'm.to_location_id as to_location_id',
      'tl.location_type as to_location_type',
      'm.occurred_at as occurred_at',
      'm.recorded_at as recorded_at',
      'l.fifo_rank_at as fifo_rank_at',
    ])
    .where('m.source_doc_type', '=', 'SALE')
    .where('m.source_doc_id', '=', toBin(line.saleId))
    .where('m.source_line_id', '=', toBin(line.saleLineId))
    .where('m.move_type', '=', 'SALE')
    .where('m.is_reversal', '=', 0)
    .execute();
  if (rows.length === 0) return [];

  const settled = await executor
    .selectFrom('inventory_stock_moves')
    .select([
      'origin_move_id',
      sql<string>`COALESCE(SUM(CASE WHEN move_type = 'DELIVERY' THEN quantity ELSE 0 END), 0)`.as(
        'delivered',
      ),
      sql<string>`COALESCE(SUM(CASE WHEN move_type = 'CUSTOMER_RETURN' THEN quantity ELSE 0 END), 0)`.as(
        'returned',
      ),
      sql<string>`COALESCE(SUM(CASE WHEN move_type = 'DELIVERY' THEN value_xaf ELSE 0 END), 0)`.as(
        'delivered_value',
      ),
      sql<string>`COALESCE(SUM(CASE WHEN move_type = 'CUSTOMER_RETURN' THEN value_xaf ELSE 0 END), 0)`.as(
        'returned_value',
      ),
    ])
    .where(
      'origin_move_id',
      'in',
      rows.map((row) => row.id),
    )
    .groupBy('origin_move_id')
    .execute();
  const byOrigin = new Map(settled.map((row) => [fromBin(row.origin_move_id!), row]));

  return rows.map((row) => {
    const id = fromBin(row.id);
    const done = byOrigin.get(id);
    return {
      id,
      productId: fromBin(row.product_id),
      lotId: fromBinOrNull(row.lot_id),
      quantityMilli: toMilli(row.quantity),
      valueXaf: Number(row.value_xaf),
      fromLocationId: fromBin(row.from_location_id),
      toLocationId: fromBin(row.to_location_id),
      toLocationType: row.to_location_type,
      occurredAt: row.occurred_at.getTime(),
      recordedAt: row.recorded_at.getTime(),
      lotRank: row.fifo_rank_at === null ? null : row.fifo_rank_at.getTime(),
      deliveredMilli: toMilli(done?.delivered ?? 0),
      returnedMilli: toMilli(done?.returned ?? 0),
      deliveredValueXaf: Number(done?.delivered_value ?? 0),
      returnedValueXaf: Number(done?.returned_value ?? 0),
    };
  });
}

const remainingMilli = (origin: Origin): number =>
  origin.quantityMilli - origin.deliveredMilli - origin.returnedMilli;

/** Ordre de livraison (FIFO) : lot le plus ancien d'abord, origine sans lot en dernier (BR-STK-057). */
function deliveryOrder(a: Origin, b: Origin): number {
  if ((a.lotRank === null) !== (b.lotRank === null)) return a.lotRank === null ? 1 : -1;
  if (a.lotRank !== null && b.lotRank !== null && a.lotRank !== b.lotRank) {
    return a.lotRank - b.lotRank;
  }
  if (a.occurredAt !== b.occurredAt) return a.occurredAt - b.occurredAt;
  if (a.recordedAt !== b.recordedAt) return a.recordedAt - b.recordedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

async function settleSoldGoods(
  uow: Transaction<DB>,
  deps: RecordMoveDeps,
  kind: 'RETURN' | 'DELIVERY',
  input: SettleSoldGoodsInput,
): Promise<readonly SettledMove[]> {
  const requested = toMilli(input.quantityBase);
  if (!(requested > 0)) {
    throw new InventoryMoveError('La quantité doit être positive.', 'QUANTITY_INVALID');
  }
  let candidates = (await loadOrigins(uow, input)).filter((origin) => remainingMilli(origin) > 0);
  if (kind === 'DELIVERY') {
    // Seule une vente sur commande, dont la marchandise est « à livrer », se livre.
    candidates = candidates.filter((origin) => origin.toLocationType === 'V_TO_DELIVER');
  } else if (input.lotId !== undefined) {
    candidates = candidates.filter((origin) => origin.lotId === input.lotId);
  }
  const ordered = [...candidates].sort(deliveryOrder);
  if (kind === 'RETURN') ordered.reverse();

  const available = ordered.reduce((sum, origin) => sum + remainingMilli(origin), 0);
  if (available < requested) {
    throw new InventoryMoveError(
      kind === 'RETURN'
        ? 'La quantité à annuler dépasse ce qui reste de la vente (INV-STK-17).'
        : 'La quantité à livrer dépasse ce qui reste à livrer de la vente (INV-STK-17).',
      'SETTLEMENT_EXCEEDS_REMAINING',
    );
  }

  const customerLocationId =
    kind === 'DELIVERY' ? await virtualLocationId(uow, 'V_CUSTOMER') : null;
  const moveType: MoveType = kind === 'RETURN' ? 'CUSTOMER_RETURN' : 'DELIVERY';
  const sourceDocType: SourceDocType = kind === 'RETURN' ? 'SALE_CANCELLATION' : 'DELIVERY';

  const settled: SettledMove[] = [];
  let toPlace = requested;
  for (const origin of ordered) {
    if (toPlace === 0) break;
    const take = Math.min(remainingMilli(origin), toPlace);
    const [move] = await recordStockMove(uow, deps, {
      productId: origin.productId,
      ...(origin.lotId !== null ? { lotId: origin.lotId } : {}),
      quantityBase: take / 1000,
      fromLocationId: origin.toLocationId,
      toLocationId: kind === 'RETURN' ? origin.fromLocationId : customerLocationId!,
      moveType,
      occurredAt: input.occurredAt,
      sourceDocType,
      sourceDocId: input.sourceDocId,
      ...(input.sourceLineId !== undefined ? { sourceLineId: input.sourceLineId } : {}),
      createdBy: input.createdBy,
      ...(input.createdDeviceId !== undefined ? { createdDeviceId: input.createdDeviceId } : {}),
      ...(input.commandId !== undefined ? { commandId: input.commandId } : {}),
      capturedOffline: input.capturedOffline ?? false,
      allowNegative: false,
      originMoveId: origin.id,
    });
    settled.push({
      moveId: move!.moveId,
      originMoveId: origin.id,
      lotId: origin.lotId,
      quantity: move!.quantity,
      unitCostXaf: move!.unitCostXaf,
      valueXaf: move!.valueXaf,
    });
    toPlace -= take;
  }
  return settled;
}

/**
 * Contre-passe `quantityBase` de la ligne de vente (annulation totale ou partielle, ADR-028 §5) :
 * un `CUSTOMER_RETURN` par mouvement `SALE` d'origine servi, lot le plus récent d'abord. La vente
 * n'est jamais inversée. Rejet définitif (`SETTLEMENT_EXCEEDS_REMAINING`) au-delà du reste.
 */
export function returnSoldGoods(
  uow: Transaction<DB>,
  deps: RecordMoveDeps,
  input: SettleSoldGoodsInput,
): Promise<readonly SettledMove[]> {
  return settleSoldGoods(uow, deps, 'RETURN', input);
}

/**
 * Livre `quantityBase` de la ligne d'une vente sur commande (ADR-028 §7) : un `DELIVERY` de
 * `V_TO_DELIVER` vers `V_CUSTOMER` par mouvement `SALE` d'origine servi, lot le plus ancien
 * d'abord, à la valeur figée de la vente (aucune nouvelle valorisation, aucune seconde sortie
 * d'un lot biologique).
 */
export function deliverSoldGoods(
  uow: Transaction<DB>,
  deps: RecordMoveDeps,
  input: SettleSoldGoodsInput,
): Promise<readonly SettledMove[]> {
  return settleSoldGoods(uow, deps, 'DELIVERY', input);
}

export interface SoldGoodsOriginPosition {
  readonly moveId: string;
  readonly lotId: string | null;
  readonly quantity: number;
  readonly remainingQuantity: number;
}

export interface SoldGoodsPosition {
  /** Σ quantités des mouvements `SALE` de la ligne. */
  readonly soldQuantity: number;
  readonly deliveredQuantity: number;
  readonly returnedQuantity: number;
  /** Vendu net des retours (INV-STK-16). */
  readonly netQuantity: number;
  /** Reste à livrer ou à annuler : vendu − livré − retourné. */
  readonly remainingQuantity: number;
  readonly soldValueXaf: number;
  readonly deliveredValueXaf: number;
  readonly returnedValueXaf: number;
  /** Valeur nette (coût des ventes de la ligne) : vendu − retourné. */
  readonly netValueXaf: number;
  readonly origins: readonly SoldGoodsOriginPosition[];
}

/**
 * Net d'une ligne de vente (INV-STK-16, INV-VEN-08, marge des lots P4-09) : **point d'accès
 * unique** — une requête « `SALE` moins `is_reversal` » ne voit pas les retours, qui ne sont pas
 * des inverses (ADR-029).
 */
export async function soldGoodsPosition(
  executor: Executor,
  line: SoldGoodsLine,
): Promise<SoldGoodsPosition> {
  const origins = await loadOrigins(executor, line);
  const sum = (pick: (origin: Origin) => number): number =>
    origins.reduce((total, origin) => total + pick(origin), 0);
  const sold = sum((o) => o.quantityMilli);
  const delivered = sum((o) => o.deliveredMilli);
  const returned = sum((o) => o.returnedMilli);
  const soldValue = sum((o) => o.valueXaf);
  const returnedValue = sum((o) => o.returnedValueXaf);
  return {
    soldQuantity: sold / 1000,
    deliveredQuantity: delivered / 1000,
    returnedQuantity: returned / 1000,
    netQuantity: (sold - returned) / 1000,
    remainingQuantity: (sold - delivered - returned) / 1000,
    soldValueXaf: soldValue,
    deliveredValueXaf: sum((o) => o.deliveredValueXaf),
    returnedValueXaf: returnedValue,
    netValueXaf: soldValue - returnedValue,
    origins: [...origins].sort(deliveryOrder).map((origin) => ({
      moveId: origin.id,
      lotId: origin.lotId,
      quantity: origin.quantityMilli / 1000,
      remainingQuantity: remainingMilli(origin) / 1000,
    })),
  };
}
