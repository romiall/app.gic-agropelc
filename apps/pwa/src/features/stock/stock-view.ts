/**
 * Stock d'un emplacement vu par l'appareil (ECR-STK-01) : par produit, en unité de base, la quantité
 * physique, l'alloué aux quotas des appareils, le disponible pour cet appareil (règles d'ADR-033 :
 * garde exclusive = physique ; emplacement partagé = physique moins les quotas des autres appareils),
 * les opérations de l'appareil pas encore confirmées, et l'état du seuil (BR-STK-051,
 * `evaluateStockThreshold`). Il n'y a plus de réservé de commande (ADR-028 §4). Logique pure.
 */
import { evaluateStockThreshold, type StockThresholdState } from '@gic/domain';
import type { SalesReferences } from '../sales/references.js';
import { localAvailable, stockKey } from '../sales/stock.js';
import type {
  LocationData,
  ProductData,
  StockBalanceData,
  StockLotData,
  StockTransferData,
} from '../sales/types.js';

export interface StockRow {
  readonly product: ProductData;
  readonly onHand: number;
  readonly allocated: number;
  /** Disponible pour cet appareil, opérations en attente déduites (peut être négatif). */
  readonly available: number;
  readonly pending: number;
  readonly threshold: {
    readonly state: StockThresholdState;
    readonly minQty: number;
    readonly suggestedQty: number;
  } | null;
  readonly lots: readonly StockLotData[];
}

/** Emplacements dont l'appareil détient le stock (jeu `stock`), par nom. */
export function stockLocations(refs: Pick<SalesReferences, 'locations' | 'stock'>): LocationData[] {
  const held = new Set([...refs.stock.values()].map((balance) => balance.location_id));
  return refs.locations
    .filter((location) => held.has(location.id) && !location.is_virtual)
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

const num = (value: string | undefined): number => (value === undefined ? 0 : Number(value));

/**
 * Quantités en route vers l'emplacement (transferts expédiés, pas encore reçus), par produit : elles
 * réduisent le réapprovisionnement suggéré (BR-STK-051 : cible − disponible − transit entrant).
 */
export function inTransitTo(
  transfers: ReadonlyMap<string, StockTransferData>,
  locationId: string,
): Map<string, number> {
  const milli = new Map<string, number>();
  for (const transfer of transfers.values()) {
    if (transfer.status !== 'DISPATCHED' || transfer.to_location_id !== locationId) continue;
    for (const line of transfer.lines) {
      const remaining =
        num(line.dispatched_qty_base ?? undefined) - num(line.received_qty_base ?? undefined);
      if (remaining <= 0) continue;
      milli.set(line.product_id, (milli.get(line.product_id) ?? 0) + Math.round(remaining * 1000));
    }
  }
  return new Map([...milli].map(([id, value]) => [id, value / 1000]));
}

export function stockRows(
  refs: Pick<SalesReferences, 'stock' | 'pending' | 'products' | 'thresholds' | 'transfers'>,
  location: LocationData,
): StockRow[] {
  const products = new Map(refs.products.map((product) => [product.id, product]));
  const transit = inTransitTo(refs.transfers, location.id);
  const rows: StockRow[] = [];
  for (const balance of refs.stock.values()) {
    if (balance.location_id !== location.id) continue;
    const product = products.get(balance.product_id);
    if (!product) continue;
    rows.push(rowOf(refs, location, product, balance, transit.get(product.id) ?? 0));
  }
  return rows.sort((a, b) => a.product.name.localeCompare(b.product.name, 'fr'));
}

function rowOf(
  refs: Pick<SalesReferences, 'pending' | 'thresholds'>,
  location: LocationData,
  product: ProductData,
  balance: StockBalanceData,
  inTransitIn: number,
): StockRow {
  const pending = refs.pending.get(stockKey(location.id, product.id)) ?? 0;
  const available = localAvailable(balance, location.custody_mode, pending);
  const threshold = refs.thresholds.find(
    (candidate) => candidate.location_id === location.id && candidate.product_id === product.id,
  );
  return {
    product,
    onHand: num(balance.qty_on_hand),
    allocated: num(balance.qty_allocated),
    available,
    pending,
    threshold: threshold
      ? (() => {
          const minQty = num(threshold.min_qty_base);
          const evaluation = evaluateStockThreshold({
            available,
            minQty,
            targetQty: num(threshold.target_qty_base),
            inTransitIn,
          });
          return { state: evaluation.state, minQty, suggestedQty: evaluation.suggestedQty };
        })()
      : null,
    lots: (balance.lots ?? []).filter((lot) => num(lot.qty_on_hand) !== 0),
  };
}

export const needsAttention = (row: StockRow): boolean =>
  row.threshold !== null && row.threshold.state !== 'OK';
