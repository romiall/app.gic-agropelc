/**
 * Lots de stock fournisseur (`inventory.stock_lots`, origine `SUPPLIER_LOT` ; CM §28 « lot
 * fournisseur ») : API publique d'`inventory` pour `procurement`, qui réceptionne (P6-05). Un même
 * lot fournisseur (fournisseur, produit, référence) livré plusieurs fois reste un seul lot de stock
 * — la traçabilité suit le lot du fournisseur. Code lisible `F:{référence}` (dictionnaire),
 * complété d'un suffixe si ce code est déjà pris par un autre lot (code unique).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { IdGenerator } from '@gic/domain';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';

export interface SupplierLotInput {
  readonly productId: string;
  readonly supplierId: string;
  /** Référence du lot chez le fournisseur ; à défaut, `fallbackCode` (lot interne à la réception). */
  readonly supplierLotRef: string | null;
  readonly fallbackCode: string;
  /** `AAAA-MM-JJ`. */
  readonly expiryDate: string | null;
  /** Ligne de réception à l'origine du lot (référence sans clé étrangère). */
  readonly originId: string;
  readonly fifoRankAt: Date;
  readonly createdBy: string;
}

export async function ensureSupplierLot(
  uow: UnitOfWork,
  deps: { readonly idGenerator: IdGenerator },
  input: SupplierLotInput,
): Promise<string> {
  if (input.supplierLotRef !== null) {
    const existing = await uow
      .selectFrom('inventory_stock_lots')
      .select('id')
      .where('origin_type', '=', 'SUPPLIER_LOT')
      .where('supplier_id', '=', toBin(input.supplierId))
      .where('product_id', '=', toBin(input.productId))
      .where('supplier_lot_ref', '=', input.supplierLotRef)
      .executeTakeFirst();
    if (existing) return fromBin(existing.id);
  }
  const id = deps.idGenerator.newId();
  const base = input.supplierLotRef !== null ? `F:${input.supplierLotRef}` : input.fallbackCode;
  const taken = await uow
    .selectFrom('inventory_stock_lots')
    .select('id')
    .where('lot_code', '=', base.slice(0, 40))
    .executeTakeFirst();
  const lotCode = (taken ? `${base.slice(0, 31)}:${id.replace(/-/g, '').slice(-8)}` : base).slice(
    0,
    40,
  );
  await uow
    .insertInto('inventory_stock_lots')
    .values({
      id: toBin(id),
      lot_code: lotCode,
      product_id: toBin(input.productId),
      origin_type: 'SUPPLIER_LOT',
      origin_id: toBin(input.originId),
      supplier_id: toBin(input.supplierId),
      supplier_lot_ref: input.supplierLotRef,
      // `AAAA-MM-JJ` converti par MySQL, sans dépendre du fuseau du processus.
      expiry_date: input.expiryDate === null ? null : sql<Date>`${input.expiryDate}`,
      fifo_rank_at: input.fifoRankAt,
      created_by: toBin(input.createdBy),
    })
    .execute();
  return id;
}

/** Origines de lot de stock créées par la production (ADR-027, AV-100). */
export type ProducedStockLotOrigin =
  'PRODUCTION_LOT' | 'INCUBATION_BATCH' | 'COLLECTION' | 'TRANSFORMATION';

export interface StockLotInput {
  /** Identifiant fourni par l'appelant (idempotence), sinon généré. */
  readonly lotId?: string;
  readonly originType: ProducedStockLotOrigin;
  /** Document d'origine (lot de production, lot d'incubation, collecte, abattage). */
  readonly originId: string;
  readonly lotCode: string;
  /** Produit du lot (un lot par produit, AV-099) ; nul seulement pour un lot multi-produits. */
  readonly productId: string | null;
  readonly fifoRankAt: Date;
  /** `AAAA-MM-JJ`. */
  readonly expiryDate: string | null;
  readonly createdBy: string;
}

/**
 * Lot de stock d'un document de production (ADR-027) : lot de traçabilité d'un lot de
 * production ou d'incubation, lot propre d'une collecte ou d'un abattage (AV-100). Le code est
 * celui du document (unique) ; il n'est pas modifiable ensuite (déclencheur).
 */
export async function createStockLot(
  uow: UnitOfWork,
  deps: { readonly idGenerator: IdGenerator },
  input: StockLotInput,
): Promise<string> {
  const id = input.lotId ?? deps.idGenerator.newId();
  await uow
    .insertInto('inventory_stock_lots')
    .values({
      id: toBin(id),
      lot_code: input.lotCode.slice(0, 40),
      product_id: input.productId === null ? null : toBin(input.productId),
      origin_type: input.originType,
      origin_id: toBin(input.originId),
      expiry_date: input.expiryDate === null ? null : sql<Date>`${input.expiryDate}`,
      fifo_rank_at: input.fifoRankAt,
      created_by: toBin(input.createdBy),
    })
    .execute();
  return id;
}

/** Clôture ou réouverture d'un lot de stock (seule colonne modifiable, INV-PRD-02). */
export async function setStockLotStatus(
  uow: UnitOfWork,
  lotId: string,
  status: 'OPEN' | 'CLOSED',
): Promise<void> {
  await uow
    .updateTable('inventory_stock_lots')
    .set({ status })
    .where('id', '=', toBin(lotId))
    .execute();
}

export interface StockLotSummary {
  readonly id: string;
  readonly originType: string;
  readonly originId: string | null;
  readonly productId: string | null;
  readonly status: string;
}

/** Lot de stock par identifiant (origine : `production` refuse un lot d'animaux comme simple stock). */
export async function findStockLot(
  executor: Kysely<DB> | Transaction<DB>,
  lotId: string,
): Promise<StockLotSummary | undefined> {
  const row = await executor
    .selectFrom('inventory_stock_lots')
    .select(['id', 'origin_type', 'origin_id', 'product_id', 'status'])
    .where('id', '=', toBin(lotId))
    .executeTakeFirst();
  return row
    ? {
        id: fromBin(row.id),
        originType: row.origin_type,
        originId: fromBinOrNull(row.origin_id),
        productId: fromBinOrNull(row.product_id),
        status: row.status,
      }
    : undefined;
}

/** Solde d'un produit d'un lot à un emplacement (mise en place par achat bornée au solde réel). */
export async function stockLotBalance(
  executor: Kysely<DB> | Transaction<DB>,
  key: { readonly locationId: string; readonly productId: string; readonly lotId: string },
): Promise<number> {
  const row = await executor
    .selectFrom('inventory_stock_balances')
    .select('qty_on_hand')
    .where('location_id', '=', toBin(key.locationId))
    .where('product_id', '=', toBin(key.productId))
    .where('lot_key', '=', toBin(key.lotId))
    .executeTakeFirst();
  return row ? Number(row.qty_on_hand) : 0;
}
