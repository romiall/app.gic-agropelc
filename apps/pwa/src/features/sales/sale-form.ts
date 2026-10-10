/**
 * Logique pure de la saisie d'une vente ou d'une commande (ECR-VEN-01, ECR-VEN-02) : lecture des
 * quantités saisies, conversion en unité de base, prix catalogue, montants de ligne et totaux, avec
 * les fonctions partagées de `packages/domain` (ADR-021), puis construction de la charge utile de la
 * commande `sales.sale.record` ou `sales.order.place`. Aucune entrée-sortie ici.
 */
import {
  convertToBaseQuantity,
  DomainError,
  pricingQuantity,
  quantityFromDecimal,
  quantityToDecimal,
  saleLineAmounts,
  saleTotals,
  xaf,
} from '@gic/domain';
import { quoteCatalogPrice, type CatalogPrice } from './pricing.js';
import { stockKey } from './stock.js';
import type { SalesReferences } from './references.js';
import type { LocationData, ProductData } from './types.js';

/** Emplacements d'où l'on vend (`sale-commands.ts` : `POS`, `MOBILE`, `BUILDING`, `PEN`). */
export const SALE_LOCATION_TYPES: readonly string[] = ['POS', 'MOBILE', 'BUILDING', 'PEN'];
/** Emplacements de préparation d'une commande (`order-commands.ts`). */
export const FULFILMENT_LOCATION_TYPES: readonly string[] = [
  'STORE',
  'POS',
  'MOBILE',
  'BUILDING',
  'PEN',
];

/** Saisie décimale (virgule ou point) ; `null` si vide, non numérique, ≤ 0 ou plus de 3 décimales. */
export function parseQuantity(text: string): number | null {
  const normalized = text.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,3})?$/.test(normalized)) return null;
  const value = Number(normalized);
  return value > 0 ? value : null;
}

/** Montant en francs entiers ; `null` si vide ou invalide. */
export function parseXaf(text: string): number | null {
  const normalized = text.trim().replace(/\s/g, '');
  if (!/^\d+$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isSafeInteger(value) ? value : null;
}

/** Emplacements de l'utilisateur dont l'appareil détient le stock, stock mobile personnel d'abord. */
export function sellingLocations(
  refs: Pick<SalesReferences, 'locations' | 'stock'>,
  userId: string,
  types: readonly string[] = SALE_LOCATION_TYPES,
): LocationData[] {
  const withStock = new Set([...refs.stock.values()].map((balance) => balance.location_id));
  return refs.locations
    .filter(
      (location) =>
        types.includes(location.location_type) &&
        !location.is_virtual &&
        location.status === 'ACTIVE' &&
        withStock.has(location.id) &&
        !(
          location.custody_mode === 'EXCLUSIVE_USER' &&
          location.custodian_user_id !== null &&
          location.custodian_user_id !== userId
        ),
    )
    .sort((a, b) => {
      const mine = (location: LocationData) => (location.custodian_user_id === userId ? 0 : 1);
      return mine(a) - mine(b) || a.name.localeCompare(b.name, 'fr');
    });
}

export interface SaleUnit {
  readonly unitCode: string;
  readonly factorToBase: string;
}

/** Unités de vente d'un produit : l'unité de base, puis ses conditionnements de vente actifs. */
export function saleUnitsOf(
  product: ProductData,
  refs: Pick<SalesReferences, 'productUnits'>,
): SaleUnit[] {
  const units: SaleUnit[] = [{ unitCode: product.base_unit_code, factorToBase: '1' }];
  for (const unit of refs.productUnits) {
    if (
      unit.product_id === product.id &&
      unit.is_sales_unit &&
      unit.is_active &&
      unit.unit_code !== product.base_unit_code
    ) {
      units.push({ unitCode: unit.unit_code, factorToBase: unit.factor_to_base });
    }
  }
  return units;
}

export interface DraftLine {
  readonly key: string;
  readonly productId: string;
  readonly unitCode: string;
  readonly quantityText: string;
  /** Poids pesé (kg), produit vendu au poids seulement. */
  readonly weightText: string;
  /** Prix saisi par le vendeur (dérogation) ; `null` : prix catalogue. */
  readonly priceText: string | null;
  readonly overrideReasonId: string | null;
}

export type LineIssue =
  | 'QUANTITY_INVALID'
  | 'WEIGHT_REQUIRED'
  | 'PRICE_REQUIRED'
  | 'PRICE_INVALID'
  | 'REASON_REQUIRED'
  | 'UNIT_INVALID';

export interface ComputedLine {
  readonly draft: DraftLine;
  readonly product: ProductData;
  readonly issue: LineIssue | null;
  readonly quantity: number;
  readonly quantityBase: number;
  readonly weightKg: number | null;
  readonly catalog: CatalogPrice | null;
  readonly unitPriceXaf: number | null;
  readonly overridden: boolean;
  readonly grossXaf: number;
  readonly discountXaf: number;
  readonly lineTotalXaf: number;
}

export interface PricingContext {
  readonly at: Date;
  readonly siteId: string | undefined;
  readonly siteZoneId: string | undefined;
  readonly customerCategoryId: string | null | undefined;
  readonly channelCode: string;
}

export function computeLine(
  draft: DraftLine,
  product: ProductData,
  refs: Pick<SalesReferences, 'productUnits' | 'priceRules' | 'zones' | 'campaigns'>,
  context: PricingContext,
): ComputedLine {
  const empty = {
    draft,
    product,
    quantity: 0,
    quantityBase: 0,
    weightKg: null,
    catalog: null,
    unitPriceXaf: null,
    overridden: false,
    grossXaf: 0,
    discountXaf: 0,
    lineTotalXaf: 0,
  };
  const unit = saleUnitsOf(product, refs).find(
    (candidate) => candidate.unitCode === draft.unitCode,
  );
  if (!unit) return { ...empty, issue: 'UNIT_INVALID' };
  const quantity = parseQuantity(draft.quantityText);
  if (quantity === null) return { ...empty, issue: 'QUANTITY_INVALID' };
  const byWeight = product.pricing_mode === 'PER_WEIGHT';
  const weight = byWeight ? parseQuantity(draft.weightText) : null;
  const quantityBaseQ = convertToBaseQuantity(quantityFromDecimal(quantity), unit.factorToBase);
  const quantityBase = quantityToDecimal(quantityBaseQ);
  const partial = { ...empty, quantity, quantityBase };
  if (byWeight && weight === null) return { ...partial, issue: 'WEIGHT_REQUIRED' };
  let pricingQty: number;
  try {
    pricingQty = quantityToDecimal(
      pricingQuantity({
        pricingMode: product.pricing_mode,
        quantityBase: quantityBaseQ,
        weightKg: weight === null ? null : quantityFromDecimal(weight),
      }),
    );
  } catch (error) {
    if (error instanceof DomainError) return { ...partial, issue: 'QUANTITY_INVALID' };
    throw error;
  }
  const catalog = quoteCatalogPrice(
    { productId: product.id, pricingQuantity: pricingQty, ...context },
    refs.priceRules,
    refs.zones,
    refs.campaigns,
  );
  const withPrice = { ...partial, weightKg: weight, catalog };
  let unitPriceXaf: number | null;
  if (draft.priceText === null) {
    if (catalog === null) return { ...withPrice, issue: 'PRICE_REQUIRED' };
    unitPriceXaf = catalog.unitPriceXaf;
  } else {
    unitPriceXaf = parseXaf(draft.priceText);
    if (unitPriceXaf === null) return { ...withPrice, issue: 'PRICE_INVALID' };
  }
  const overridden = catalog === null || unitPriceXaf !== catalog.unitPriceXaf;
  const amounts = saleLineAmounts({
    pricingQuantity: quantityFromDecimal(pricingQty),
    unitPriceXaf: xaf(unitPriceXaf),
    listUnitPriceXaf: catalog === null ? null : xaf(catalog.unitPriceXaf),
  });
  return {
    ...withPrice,
    unitPriceXaf,
    overridden,
    grossXaf: amounts.grossXaf,
    discountXaf: amounts.discountXaf,
    lineTotalXaf: amounts.lineTotalXaf,
    issue: overridden && draft.overrideReasonId === null ? 'REASON_REQUIRED' : null,
  };
}

export function totalOf(lines: readonly ComputedLine[]): number {
  if (lines.length === 0) return 0;
  return saleTotals(
    lines.map((line) => ({
      grossXaf: xaf(line.grossXaf),
      discountXaf: xaf(line.discountXaf),
      lineTotalXaf: xaf(line.lineTotalXaf),
    })),
  ).totalXaf;
}

/** Quantité demandée par produit (unité de base), toutes lignes confondues. */
export function requestedByProduct(lines: readonly ComputedLine[]): Map<string, number> {
  const milli = new Map<string, number>();
  for (const line of lines) {
    milli.set(
      line.product.id,
      (milli.get(line.product.id) ?? 0) + Math.round(line.quantityBase * 1000),
    );
  }
  return new Map([...milli].map(([id, value]) => [id, value / 1000]));
}

export { stockKey };

/** Ligne de la charge utile (`saleLineSchema` côté serveur). */
export function linePayload(line: ComputedLine) {
  return {
    productId: line.product.id,
    quantity: line.quantity,
    unitCode: line.draft.unitCode,
    quantityBase: line.quantityBase,
    ...(line.weightKg !== null ? { weightKg: line.weightKg } : {}),
    listUnitPriceXaf: line.catalog?.unitPriceXaf ?? null,
    ...(line.catalog ? { priceRuleId: line.catalog.ruleId } : {}),
    unitPriceXaf: line.unitPriceXaf ?? 0,
    ...(line.overridden && line.draft.overrideReasonId
      ? { overrideReasonCodeId: line.draft.overrideReasonId }
      : {}),
  };
}

export interface PaymentDraft {
  readonly methodCode: string;
  readonly amountXaf: number;
  readonly reference: string;
}

export function paymentPayload(payment: PaymentDraft) {
  const reference = payment.reference.trim();
  return {
    methodCode: payment.methodCode,
    amountXaf: payment.amountXaf,
    ...(reference ? { reference } : {}),
  };
}
