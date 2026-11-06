/**
 * Seuils d'alerte de stock (ECR-STK-09, AV-526) : logique pure. Un seuil lie un emplacement et un produit :
 * en dessous du minimum, le produit est signalé (alerte de stock) et le réapprovisionnement suggéré ramène le
 * disponible à la cible (BR-STK-051). Chaque réglage crée une nouvelle version, l'ancienne est désactivée par le
 * serveur (`inventory.threshold.set`) : rien ne s'efface.
 */
import type { SalesReferences } from '../sales/references.js';
import type { ProductData, StockThresholdData } from '../sales/types.js';

/** Borne haute d'un seuil, bien en deçà de `numeric(14,3)` : une faute de frappe est refusée sur l'appareil. */
export const MAX_THRESHOLD = 1_000_000_000;

/** Quantité positive ou nulle, virgule ou point, trois décimales au plus ; `null` sinon. */
export function parseThreshold(text: string): number | null {
  const normalized = text.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,3})?$/.test(normalized)) return null;
  const value = Number(normalized);
  return value <= MAX_THRESHOLD ? value : null;
}

export type ThresholdIssue = 'MIN_INVALID' | 'TARGET_INVALID' | 'TARGET_BELOW_MIN';

export interface ThresholdCheck {
  readonly values: { readonly min: number; readonly target: number } | null;
  readonly issues: readonly ThresholdIssue[];
}

/** Contrôles du serveur (`inventory.threshold.set`) : deux quantités, la cible au moins égale au minimum. */
export function checkThreshold(minText: string, targetText: string): ThresholdCheck {
  const min = parseThreshold(minText);
  const target = parseThreshold(targetText);
  const issues: ThresholdIssue[] = [];
  if (min === null) issues.push('MIN_INVALID');
  if (target === null) issues.push('TARGET_INVALID');
  if (min !== null && target !== null && target < min) issues.push('TARGET_BELOW_MIN');
  return {
    values: issues.length === 0 && min !== null && target !== null ? { min, target } : null,
    issues,
  };
}

export function thresholdPayload(input: {
  readonly locationId: string;
  readonly productId: string;
  readonly min: number;
  readonly target: number;
}) {
  return {
    locationId: input.locationId,
    productId: input.productId,
    minQtyBase: input.min,
    targetQtyBase: input.target,
  };
}

export interface ThresholdRow {
  readonly product: ProductData;
  /** Solde physique de l'emplacement, `null` si le produit n'y a plus de solde connu. */
  readonly onHand: number | null;
  readonly threshold: StockThresholdData | null;
}

/**
 * Produits d'un emplacement : ceux qui y ont un solde et ceux qui y ont un seuil actif, par nom. Un produit
 * sans seuil se règle comme les autres (« Fixer »).
 */
export function thresholdRows(
  refs: Pick<SalesReferences, 'stock' | 'products' | 'thresholds'>,
  locationId: string,
): ThresholdRow[] {
  const products = new Map(refs.products.map((product) => [product.id, product]));
  const rows = new Map<string, ThresholdRow>();
  for (const balance of refs.stock.values()) {
    if (balance.location_id !== locationId) continue;
    const product = products.get(balance.product_id);
    if (!product) continue;
    rows.set(product.id, { product, onHand: Number(balance.qty_on_hand), threshold: null });
  }
  for (const threshold of refs.thresholds) {
    if (threshold.location_id !== locationId || !threshold.is_active) continue;
    const product = products.get(threshold.product_id);
    if (!product) continue;
    const row = rows.get(product.id);
    rows.set(product.id, {
      product,
      onHand: row ? row.onHand : null,
      threshold,
    });
  }
  return [...rows.values()].sort((a, b) => a.product.name.localeCompare(b.product.name, 'fr'));
}
