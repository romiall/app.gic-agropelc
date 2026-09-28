/**
 * Lectures du catalogue (D16-CAT §5, §6 ; phase P1 : `/products`, `/units`,
 * `/reason-codes`). API publique de `catalog`, consommée par `pricing` (dépendance
 * autorisée, 03-graphe-dependances.md) et par le contrôleur de lecture du même module.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';

export interface ProductSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly categoryId: string;
  readonly stockFamily: string;
  readonly baseUnitCode: string;
  readonly lotTracking: string;
  readonly isSellable: boolean;
  readonly isPurchasable: boolean;
  readonly isProducible: boolean;
  readonly isConsumable: boolean;
  readonly pricingMode: string;
  readonly species: string | null;
  readonly status: string;
}

export async function listProducts(
  executor: Kysely<DB> | Transaction<DB>,
  filter: { readonly status?: 'ACTIVE' | 'INACTIVE' } = {},
): Promise<readonly ProductSummary[]> {
  const rows = await executor
    .selectFrom('catalog_products')
    .selectAll()
    .$if(filter.status !== undefined, (qb) => qb.where('status', '=', filter.status!))
    .orderBy('code', 'asc')
    .execute();
  return rows.map((row) => ({
    id: fromBin(row.id),
    code: row.code,
    name: row.name,
    categoryId: fromBin(row.category_id),
    stockFamily: row.stock_family,
    baseUnitCode: row.base_unit_code,
    lotTracking: row.lot_tracking,
    isSellable: Boolean(row.is_sellable),
    isPurchasable: Boolean(row.is_purchasable),
    isProducible: Boolean(row.is_producible),
    isConsumable: Boolean(row.is_consumable),
    pricingMode: row.pricing_mode,
    species: row.species,
    status: row.status,
  }));
}

/** Existence + unité de base d'un produit (utilisé par `pricing` pour valider `product_id`
 * et l'unité de tarification sans dupliquer sa logique de lecture, 03-graphe-dependances.md
 * : `pricing -> catalog` autorisé). */
export async function findProductForPricing(
  executor: Kysely<DB> | Transaction<DB>,
  productId: string,
): Promise<
  { readonly id: string; readonly baseUnitCode: string; readonly status: string } | undefined
> {
  const row = await executor
    .selectFrom('catalog_products')
    .select(['id', 'base_unit_code', 'status'])
    .where('id', '=', toBin(productId))
    .executeTakeFirst();
  if (!row) return undefined;
  return { id: fromBin(row.id), baseUnitCode: row.base_unit_code, status: row.status };
}

/** Mode de suivi par lot d'un produit (BR-STK-050, INV-STK-13), pour que `inventory` contrôle
 * chaque mouvement sans lire `catalog_products` lui-même (`inventory -> catalog` autorisé). */
export async function findProductLotTracking(
  executor: Kysely<DB> | Transaction<DB>,
  productId: string,
): Promise<'NONE' | 'OPTIONAL' | 'REQUIRED' | undefined> {
  const row = await executor
    .selectFrom('catalog_products')
    .select('lot_tracking')
    .where('id', '=', toBin(productId))
    .executeTakeFirst();
  return row?.lot_tracking as 'NONE' | 'OPTIONAL' | 'REQUIRED' | undefined;
}

/** Fiche d'un produit par identifiant (`production` : produit d'un lot, espèce, famille). */
export async function findProduct(
  executor: Kysely<DB> | Transaction<DB>,
  productId: string,
): Promise<ProductSummary | undefined> {
  const row = await executor
    .selectFrom('catalog_products')
    .selectAll()
    .where('id', '=', toBin(productId))
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    id: fromBin(row.id),
    code: row.code,
    name: row.name,
    categoryId: fromBin(row.category_id),
    stockFamily: row.stock_family,
    baseUnitCode: row.base_unit_code,
    lotTracking: row.lot_tracking,
    isSellable: Boolean(row.is_sellable),
    isPurchasable: Boolean(row.is_purchasable),
    isProducible: Boolean(row.is_producible),
    isConsumable: Boolean(row.is_consumable),
    pricingMode: row.pricing_mode,
    species: row.species,
    status: row.status,
  };
}

/**
 * Coût standard en vigueur d'un produit à `at` (BR-CAT-011 ; AV-098 : œufs et porcelets
 * produits entrent en stock à ce coût) ; `undefined` si aucun coût standard n'est défini.
 */
export async function findStandardUnitCostXaf(
  executor: Kysely<DB> | Transaction<DB>,
  productId: string,
  at: Date,
): Promise<number | undefined> {
  const row = await executor
    .selectFrom('catalog_product_standard_costs')
    .select('unit_cost_xaf')
    .where('product_id', '=', toBin(productId))
    .where('valid_from', '<=', at)
    .orderBy('valid_from', 'desc')
    .orderBy('id', 'desc')
    .executeTakeFirst();
  return row ? Number(row.unit_cost_xaf) : undefined;
}

export interface UnitSummary {
  readonly code: string;
  readonly name: string;
  readonly isCount: boolean;
  readonly isActive: boolean;
}

export async function listUnits(
  executor: Kysely<DB> | Transaction<DB>,
): Promise<readonly UnitSummary[]> {
  const rows = await executor
    .selectFrom('catalog_units')
    .selectAll()
    .orderBy('code', 'asc')
    .execute();
  return rows.map((row) => ({
    code: row.code,
    name: row.name,
    isCount: Boolean(row.is_count),
    isActive: Boolean(row.is_active),
  }));
}

export interface ReasonCodeSummary {
  readonly id: string;
  readonly category: string;
  readonly code: string;
  readonly label: string;
  readonly lossCategory: string | null;
  readonly requiresComment: boolean;
  readonly isActive: boolean;
}

/** Un code motif par identifiant (ex. `crm` : catégories `PROSPECT_LOST`, `VISIT_OUTCOME`). */
export async function findReasonCode(
  executor: Kysely<DB> | Transaction<DB>,
  id: string,
): Promise<ReasonCodeSummary | undefined> {
  const row = await executor
    .selectFrom('catalog_reason_codes')
    .selectAll()
    .where('id', '=', toBin(id))
    .executeTakeFirst();
  return row
    ? {
        id: fromBin(row.id),
        category: row.category,
        code: row.code,
        label: row.label,
        lossCategory: row.loss_category,
        requiresComment: Boolean(row.requires_comment),
        isActive: Boolean(row.is_active),
      }
    : undefined;
}

export async function listReasonCodes(
  executor: Kysely<DB> | Transaction<DB>,
  filter: { readonly category?: string } = {},
): Promise<readonly ReasonCodeSummary[]> {
  const rows = await executor
    .selectFrom('catalog_reason_codes')
    .selectAll()
    .$if(filter.category !== undefined, (qb) => qb.where('category', '=', filter.category!))
    .orderBy('code', 'asc')
    .execute();
  return rows.map((row) => ({
    id: fromBin(row.id),
    category: row.category,
    code: row.code,
    label: row.label,
    lossCategory: row.loss_category,
    requiresComment: Boolean(row.requires_comment),
    isActive: Boolean(row.is_active),
  }));
}
