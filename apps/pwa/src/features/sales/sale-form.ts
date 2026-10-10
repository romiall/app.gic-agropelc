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
/** Longueurs maximales des champs libres (schémas zod du serveur, `order-commands.ts`,
 * `delivery-commands.ts`, `cancel-commands.ts`) : la saisie est bornée plutôt que refusée à l'envoi. */
export const MAX_COMMENT_LENGTH = 2000;
export const MAX_ADDRESS_LENGTH = 1000;
export const MAX_RECIPIENT_LENGTH = 200;

/** Borne de `numeric(14,3)` côté serveur (`sale-payload.ts`). */
export const MAX_QUANTITY = 99_999_999_999.999;

export function parseQuantity(text: string): number | null {
  const normalized = text.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,3})?$/.test(normalized)) return null;
  const value = Number(normalized);
  return value > 0 && value <= MAX_QUANTITY ? value : null;
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

/**
 * Emplacements de préparation proposés pour une commande : tout emplacement physique actif d'un type
 * admis (`order-commands.ts`), hors stock mobile d'un autre détenteur ; ceux du site du client, puis
 * ceux dont l'appareil détient le stock, d'abord. La commande n'est jamais refusée faute de stock
 * (ADR-028 §4) : un emplacement sans stock connu de l'appareil reste proposé.
 */
export function fulfilmentLocations(
  refs: Pick<SalesReferences, 'locations' | 'stock'>,
  userId: string,
  customerSiteId: string | null | undefined,
): LocationData[] {
  const withStock = new Set([...refs.stock.values()].map((balance) => balance.location_id));
  const rank = (location: LocationData) =>
    (customerSiteId && location.site_id === customerSiteId ? 0 : 2) +
    (withStock.has(location.id) ? 0 : 1);
  return refs.locations
    .filter(
      (location) =>
        FULFILMENT_LOCATION_TYPES.includes(location.location_type) &&
        !location.is_virtual &&
        location.status === 'ACTIVE' &&
        !(
          location.custody_mode === 'EXCLUSIVE_USER' &&
          location.custodian_user_id !== null &&
          location.custodian_user_id !== userId
        ),
    )
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'fr'));
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
  /** Zone de tarification (BR-VEN-022, `saleZoneId`). */
  readonly zoneId: string | undefined;
  readonly customerCategoryId: string | null | undefined;
  /** `undefined` : canal laissé au serveur (rôles inconnus de l'appareil). */
  readonly channelCode: string | undefined;
}

export function computeLine(
  draft: DraftLine,
  product: ProductData,
  refs: Pick<SalesReferences, 'productUnits' | 'priceRules' | 'zones' | 'campaigns'>,
  context: PricingContext,
): ComputedLine {
  const empty: Omit<ComputedLine, 'issue'> = {
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
  // Toute valeur hors des bornes du domaine (quantité démesurée, montant non entier sûr…) devient un
  // défaut de saisie de la ligne, jamais une exception dans le rendu.
  try {
    return computeValidLine(draft, product, refs, context, { empty, unit, quantity, weight });
  } catch (error) {
    if (error instanceof DomainError) {
      return { ...empty, issue: draft.priceText === null ? 'QUANTITY_INVALID' : 'PRICE_INVALID' };
    }
    throw error;
  }
}

function computeValidLine(
  draft: DraftLine,
  product: ProductData,
  refs: Pick<SalesReferences, 'productUnits' | 'priceRules' | 'zones' | 'campaigns'>,
  context: PricingContext,
  input: {
    readonly empty: Omit<ComputedLine, 'issue'>;
    readonly unit: SaleUnit;
    readonly quantity: number;
    readonly weight: number | null;
  },
): ComputedLine {
  const { empty, unit, quantity, weight } = input;
  const quantityBaseQ = convertToBaseQuantity(quantityFromDecimal(quantity), unit.factorToBase);
  const quantityBase = quantityToDecimal(quantityBaseQ);
  const partial = { ...empty, quantity, quantityBase };
  if (product.pricing_mode === 'PER_WEIGHT' && weight === null) {
    return { ...partial, issue: 'WEIGHT_REQUIRED' };
  }
  if (quantityBase > MAX_QUANTITY) return { ...partial, issue: 'QUANTITY_INVALID' };
  const pricingQty = quantityToDecimal(
    pricingQuantity({
      pricingMode: product.pricing_mode,
      quantityBase: quantityBaseQ,
      weightKg: weight === null ? null : quantityFromDecimal(weight),
    }),
  );
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

/** Total des lignes ; `null` s'il sort des montants représentables (saisie démesurée). */
export function totalOf(lines: readonly ComputedLine[]): number | null {
  if (lines.length === 0) return 0;
  try {
    return saleTotals(
      lines.map((line) => ({
        grossXaf: xaf(line.grossXaf),
        discountXaf: xaf(line.discountXaf),
        lineTotalXaf: xaf(line.lineTotalXaf),
      })),
    ).totalXaf;
  } catch (error) {
    if (error instanceof DomainError) return null;
    throw error;
  }
}

/**
 * Quantité demandée par produit (unité de base), toutes lignes confondues, hors services : une ligne
 * de service (frais de livraison) n'a aucun effet de stock (BR-VEN-031).
 */
export function requestedByProduct(lines: readonly ComputedLine[]): Map<string, number> {
  const milli = new Map<string, number>();
  for (const line of lines) {
    if (line.product.stock_family === 'SERVICE') continue;
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

const STALE_PRICES_MS = 24 * 60 * 60 * 1000;

/** Catalogue de prix plus vieux que 24 h (01-architecture-offline.md §8). */
export function pricesMayBeStale(lastSyncAt: string | null, now: Date): boolean {
  return lastSyncAt === null || now.getTime() - new Date(lastSyncAt).getTime() > STALE_PRICES_MS;
}
