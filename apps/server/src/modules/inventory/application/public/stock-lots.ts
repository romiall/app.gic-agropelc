/**
 * Lots de stock fournisseur (`inventory.stock_lots`, origine `SUPPLIER_LOT` ; CM §28 « lot
 * fournisseur ») : API publique d'`inventory` pour `procurement`, qui réceptionne (P6-05). Un même
 * lot fournisseur (fournisseur, produit, référence) livré plusieurs fois reste un seul lot de stock
 * — la traçabilité suit le lot du fournisseur. Code lisible `F:{référence}` (dictionnaire),
 * complété d'un suffixe si ce code est déjà pris par un autre lot (code unique).
 */
import { sql } from 'kysely';
import type { IdGenerator } from '@gic/domain';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';

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
