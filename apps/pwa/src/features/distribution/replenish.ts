/**
 * Demande de réapprovisionnement d'un point de vente (ECR-DIS-03 ; UC-DIS-06 ; WF-05 ; BR-DIS-011,
 * BR-STK-051). Logique pure : PDV vus par l'appareil (jeu `org`), source et destination de la demande,
 * suggestion par produit (cible − disponible − transit entrant, sur le solde physique, ADR-033 §10),
 * demandes déjà en attente vers le PDV (jeu `transfers` et saisies de l'appareil), charge utile de
 * `inventory.transfer.request`. La suggestion ne crée jamais de demande (BR-DIS-011).
 */
import { evaluateStockThreshold, type StockThresholdState } from '@gic/domain';
import { isWaiting, stillInFlight } from '../sales/pending.js';
import type { SalesReferences } from '../sales/references.js';
import { stockKey } from '../sales/stock.js';
import type { LocationData, ProductData } from '../sales/types.js';
import { inTransitTo, receivingTransferIds } from '../stock/stock-view.js';
import type { TransferLineCheck } from '../stock/transfer.js';

/**
 * AV-306 (défaut) : PDV sans source de réapprovisionnement configurée
 * (`replenishment_source_location_id` nul). `CHOOSE` : le vendeur choisit un magasin (emplacement
 * `STORE` actif) ; `BLOCK` : la demande attend la configuration du PDV.
 */
export const REPLENISH_WITHOUT_SOURCE: 'CHOOSE' | 'BLOCK' = 'CHOOSE';

/**
 * AV-307 (défaut) : produit déjà demandé vers le PDV et pas encore expédié (autre téléphone, autre
 * vendeur). `ANNOUNCE` : rappelé sous le produit, la suggestion en est diminuée, la demande reste
 * possible (complément) ; `BLOCK` : la ligne est refusée.
 */
export const DUPLICATE_REQUEST: 'ANNOUNCE' | 'BLOCK' = 'ANNOUNCE';

/** Point de vente vu par l'appareil : emplacement de vente et source configurée. */
export interface PointOfSaleView {
  readonly siteId: string;
  readonly salesLocation: LocationData;
  /** Source configurée du PDV, si elle est connue de l'appareil. */
  readonly source: LocationData | null;
}

/** PDV du périmètre (jeu `org`) dont l'emplacement de vente est connu, par nom. */
export function pointsOfSaleOf(
  refs: Pick<SalesReferences, 'pointsOfSale' | 'locations'>,
): PointOfSaleView[] {
  const locations = new Map(refs.locations.map((location) => [location.id, location]));
  const views: PointOfSaleView[] = [];
  for (const pos of refs.pointsOfSale.values()) {
    const salesLocation = locations.get(pos.sales_location_id);
    if (!salesLocation) continue;
    const source = pos.replenishment_source_location_id
      ? (locations.get(pos.replenishment_source_location_id) ?? null)
      : null;
    views.push({ siteId: pos.site_id, salesLocation, source });
  }
  return views.sort((a, b) => a.salesLocation.name.localeCompare(b.salesLocation.name, 'fr'));
}

/** Magasins proposés quand le PDV n'a pas de source configurée (AV-306) : `STORE` actifs, par nom. */
export function candidateSources(
  locations: readonly LocationData[],
  destinationId: string,
): LocationData[] {
  return locations
    .filter(
      (location) =>
        location.id !== destinationId &&
        location.location_type === 'STORE' &&
        !location.is_virtual &&
        (location.status === undefined || location.status === 'ACTIVE'),
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

export interface ReplenishSuggestion {
  readonly product: ProductData;
  readonly state: StockThresholdState;
  /** Solde physique de l'emplacement, net des sorties en attente de l'appareil. */
  readonly available: number;
  readonly inTransit: number;
  /** Quantité suggérée (unité de base), déjà diminuée des demandes en attente vers le PDV. */
  readonly suggestedQty: number;
}

const num = (value: string | null | undefined): number =>
  value === null || value === undefined ? 0 : Number(value);
const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * Suggestion par produit doté d'un seuil actif sur l'emplacement de vente (BR-STK-051, évaluée comme le
 * serveur sur le solde physique, ADR-033 §10) : cible − disponible − transit entrant, diminuée des
 * quantités déjà demandées et pas encore expédiées (`requested`), pour ne pas redemander ce qui est en
 * cours. Seuls les produits à réapprovisionner (quantité > 0) sont rendus, les plus urgents d'abord.
 */
export function replenishSuggestions(
  refs: Pick<
    SalesReferences,
    'thresholds' | 'stock' | 'pending' | 'products' | 'transfers' | 'outbox'
  >,
  salesLocationId: string,
  requested: ReadonlyMap<string, number>,
): ReplenishSuggestion[] {
  const products = new Map(refs.products.map((product) => [product.id, product]));
  const transit = inTransitTo(refs.transfers, salesLocationId, receivingTransferIds(refs.outbox));
  const rank: Record<StockThresholdState, number> = { STOCK_OUT: 0, STOCK_LOW: 1, OK: 2 };
  const suggestions: ReplenishSuggestion[] = [];
  for (const threshold of refs.thresholds) {
    if (threshold.location_id !== salesLocationId || !threshold.is_active) continue;
    const product = products.get(threshold.product_id);
    if (!product) continue;
    const key = stockKey(salesLocationId, product.id);
    const onHand = num(refs.stock.get(key)?.qty_on_hand);
    const available = round3(onHand - (refs.pending.get(key) ?? 0));
    const inTransit = transit.get(product.id) ?? 0;
    const evaluation = evaluateStockThreshold({
      available,
      minQty: num(threshold.min_qty_base),
      targetQty: num(threshold.target_qty_base),
      inTransitIn: inTransit,
    });
    const suggestedQty = round3(evaluation.suggestedQty - (requested.get(product.id) ?? 0));
    if (suggestedQty <= 0) continue;
    suggestions.push({ product, state: evaluation.state, available, inTransit, suggestedQty });
  }
  return suggestions.sort(
    (a, b) => rank[a.state] - rank[b.state] || a.product.name.localeCompare(b.product.name, 'fr'),
  );
}

/** Demande de réapprovisionnement vers le PDV, pas encore expédiée. */
export interface PendingRequest {
  readonly id: string;
  readonly docNumber: string | null;
  readonly fromLocationId: string;
  readonly lines: readonly { readonly productId: string; readonly quantityBase: number }[];
  readonly requestedBy: string | null;
  /** Saisie sur l'appareil et pas encore connue du jeu `transfers`. */
  readonly onDevice: boolean;
  /** Demande saisie sur l'appareil encore sans réponse (dépendance d'une annulation). */
  readonly commandId: string | null;
  /** Annulation saisie sur l'appareil, pas encore relue. */
  readonly cancelling: boolean;
}

interface RequestPayloadLike {
  readonly fromLocationId?: string;
  readonly toLocationId?: string;
  readonly lines?: readonly { readonly productId?: string; readonly quantityBase?: number }[];
}

/**
 * Demandes vers l'emplacement de vente encore à expédier : celles du jeu `transfers` (`REQUESTED`), et
 * celles saisies sur l'appareil, jusqu'au tirage qui les inclut (ADR-037 §3). Une demande refusée par
 * le serveur ou annulée n'y figure pas ; une annulation en attente la marque.
 */
export function pendingRequests(
  refs: Pick<SalesReferences, 'transfers' | 'outbox' | 'transfersPulledAt'>,
  salesLocationId: string,
): PendingRequest[] {
  const cancelling = new Set(
    refs.outbox
      .filter(
        (command) =>
          command.command_type === 'inventory.transfer.cancel' &&
          stillInFlight(command, refs.transfersPulledAt),
      )
      .map((command) => command.aggregate_id),
  );
  const requests: PendingRequest[] = [];
  for (const transfer of refs.transfers.values()) {
    if (transfer.to_location_id !== salesLocationId || transfer.status !== 'REQUESTED') continue;
    requests.push({
      id: transfer.id,
      docNumber: transfer.doc_number,
      fromLocationId: transfer.from_location_id,
      lines: transfer.lines.map((line) => ({
        productId: line.product_id,
        quantityBase: num(line.requested_qty_base),
      })),
      requestedBy: transfer.requested_by ?? null,
      onDevice: false,
      commandId: null,
      cancelling: cancelling.has(transfer.id),
    });
  }
  for (const command of refs.outbox) {
    if (command.command_type !== 'inventory.transfer.request') continue;
    if (refs.transfers.has(command.aggregate_id)) continue;
    if (!stillInFlight(command, refs.transfersPulledAt)) continue;
    const payload = command.payload as RequestPayloadLike;
    if (payload.toLocationId !== salesLocationId || !payload.fromLocationId) continue;
    requests.push({
      id: command.aggregate_id,
      docNumber: command.server_refs?.docNumber ?? null,
      fromLocationId: payload.fromLocationId,
      lines: (payload.lines ?? [])
        .filter((line) => line.productId && line.quantityBase)
        .map((line) => ({
          productId: line.productId as string,
          quantityBase: line.quantityBase as number,
        })),
      requestedBy: command.author_user_id,
      onDevice: true,
      commandId: isWaiting(command) ? command.command_id : null,
      cancelling: cancelling.has(command.aggregate_id),
    });
  }
  return requests;
}

/** Quantités déjà demandées par produit (demandes en attente non annulées), en unité de base. */
export function requestedByProduct(requests: readonly PendingRequest[]): Map<string, number> {
  const milli = new Map<string, number>();
  for (const request of requests) {
    if (request.cancelling) continue;
    for (const line of request.lines) {
      milli.set(
        line.productId,
        (milli.get(line.productId) ?? 0) + Math.round(line.quantityBase * 1000),
      );
    }
  }
  return new Map([...milli].map(([id, value]) => [id, value / 1000]));
}

/** Charge utile de `inventory.transfer.request` (`transfer-commands.ts`) : lignes sans lot. */
export function replenishPayload(input: {
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly lines: readonly TransferLineCheck[];
  readonly notes: string;
}) {
  const notes = input.notes.trim();
  return {
    fromLocationId: input.fromLocationId,
    toLocationId: input.toLocationId,
    lines: input.lines.map((line) => ({
      productId: line.draft.productId,
      unitCode: line.draft.unitCode,
      quantityBase: line.quantityBase as number,
    })),
    ...(notes ? { notes } : {}),
  };
}

/** Annulation possible : demande connue du serveur, de l'utilisateur, sans annulation en cours. */
export function cancellable(request: PendingRequest, userId: string): boolean {
  return !request.onDevice && !request.cancelling && request.requestedBy === userId;
}
