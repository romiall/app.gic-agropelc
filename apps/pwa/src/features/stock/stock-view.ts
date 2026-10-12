/**
 * Stock d'un emplacement vu par l'appareil (ECR-STK-01) : par produit, en unité de base, la quantité
 * physique, le disponible pour cet appareil (règles d'ADR-033), les opérations de l'appareil pas
 * encore confirmées, et l'état du seuil (BR-STK-051, `evaluateStockThreshold`), évalué comme le
 * serveur sur le solde physique (ADR-033 §10), diminué des seules opérations de l'appareil en
 * attente. Le solde porte `qty_allocated`, que le serveur ne tient pas encore (toujours 0) ; le reste
 * du quota propre de l'appareil n'est pas servi (jeu `allocations`, S-05) : aucune colonne « Quotas »
 * n'est affichée tant que ces valeurs ne sont pas fiables. Il n'y a plus de réservé de commande
 * (ADR-028 §4). Logique pure.
 */
import type { OutboxCommand } from '../../storage/db.js';
import { stillInFlight } from '../sales/pending.js';
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

/**
 * Emplacements où recevoir sans document : ceux dont l'appareil détient le stock, et les emplacements
 * physiques actifs dont l'utilisateur a la garde (un premier arrivage sur un emplacement vide).
 */
export function receivingLocations(
  refs: Pick<SalesReferences, 'locations' | 'stock'>,
  userId: string,
): LocationData[] {
  const held = new Set(stockLocations(refs).map((location) => location.id));
  return refs.locations
    .filter(
      (location) =>
        !location.is_virtual &&
        (held.has(location.id) ||
          (location.status === 'ACTIVE' && location.custodian_user_id === userId)),
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

/**
 * Sites du périmètre de l'appareil, tirés des jeux que le serveur borne (le jeu `location` est global,
 * S-32) : emplacements dont l'appareil détient le stock ou dont l'utilisateur a la garde, documents
 * d'achat, lots de production et d'incubation.
 */
export function scopeSiteIds(
  refs: Pick<
    SalesReferences,
    | 'locations'
    | 'stock'
    | 'purchaseRequests'
    | 'purchaseOrders'
    | 'productionLots'
    | 'incubationBatches'
  >,
  userId: string,
): Set<string> {
  const sites = new Set<string>();
  const add = (siteId: string | null | undefined) => {
    if (siteId) sites.add(siteId);
  };
  for (const location of stockLocations(refs)) add(location.site_id);
  for (const location of refs.locations) {
    if (location.custodian_user_id === userId) add(location.site_id);
  }
  for (const request of refs.purchaseRequests) add(request.site_id);
  for (const order of refs.purchaseOrders) add(order.site_id);
  for (const lot of refs.productionLots) add(lot.site_id);
  for (const batch of refs.incubationBatches) add(batch.site_id);
  return sites;
}

/** Emplacements dont l'appareil détient le stock (jeu `stock`), par nom. */
export function stockLocations(refs: Pick<SalesReferences, 'locations' | 'stock'>): LocationData[] {
  const held = new Set([...refs.stock.values()].map((balance) => balance.location_id));
  return refs.locations
    .filter((location) => held.has(location.id) && !location.is_virtual)
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

const num = (value: string | undefined): number => (value === undefined ? 0 : Number(value));

/** Transferts dont la réception est saisie sur l'appareil et pas encore confirmée par le serveur. */
export function receivingTransferIds(outbox: readonly OutboxCommand[]): Set<string> {
  return new Set(
    outbox
      .filter(
        (command) =>
          command.command_type === 'inventory.transfer.receive' &&
          stillInFlight(command, undefined),
      )
      .map((command) => (command.payload as { transferId?: string }).transferId)
      .filter((id): id is string => typeof id === 'string'),
  );
}

/**
 * Quantités en route vers l'emplacement (transferts expédiés, pas encore reçus), par produit : elles
 * réduisent le réapprovisionnement suggéré (BR-STK-051 : cible − disponible − transit entrant). Un
 * transfert dont la réception est déjà saisie sur l'appareil n'est plus en transit : la quantité
 * reçue compte déjà dans les opérations en attente.
 */
export function inTransitTo(
  transfers: ReadonlyMap<string, StockTransferData>,
  locationId: string,
  receiving: ReadonlySet<string> = new Set(),
): Map<string, number> {
  const milli = new Map<string, number>();
  for (const transfer of transfers.values()) {
    if (transfer.status !== 'DISPATCHED' || transfer.to_location_id !== locationId) continue;
    if (receiving.has(transfer.id)) continue;
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
  refs: Pick<
    SalesReferences,
    'stock' | 'pending' | 'products' | 'thresholds' | 'transfers' | 'outbox'
  >,
  location: LocationData,
): StockRow[] {
  const products = new Map(refs.products.map((product) => [product.id, product]));
  const transit = inTransitTo(refs.transfers, location.id, receivingTransferIds(refs.outbox));
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
  const onHand = num(balance.qty_on_hand);
  // Seuil lu sur le solde physique, comme le serveur (ADR-033 §10), net des opérations en attente.
  const physical = Math.round((onHand - pending) * 1000) / 1000;
  return {
    product,
    onHand,
    available,
    pending,
    threshold: threshold
      ? (() => {
          const minQty = num(threshold.min_qty_base);
          const evaluation = evaluateStockThreshold({
            available: physical,
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
