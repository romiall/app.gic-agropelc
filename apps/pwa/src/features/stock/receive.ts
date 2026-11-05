/**
 * Réception d'un transfert (ECR-STK-03) : transferts expédiés vers l'appareil et saisie des quantités
 * reçues. Logique pure.
 */
import { MAX_QUANTITY } from '../sales/sale-form.js';
import type { SalesReferences } from '../sales/references.js';
import type { StockTransferData } from '../sales/types.js';
import { receivingTransferIds, stockLocations } from './stock-view.js';

/** Transferts expédiés vers l'appareil, avec l'éventuelle réception déjà saisie sur l'appareil. */
export function incomingTransfers(
  refs: Pick<SalesReferences, 'transfers' | 'locations' | 'stock' | 'outbox'>,
): { readonly transfer: StockTransferData; readonly receiving: boolean }[] {
  const held = new Set(stockLocations(refs).map((location) => location.id));
  const receiving = receivingTransferIds(refs.outbox);
  return [...refs.transfers.values()]
    .filter(
      (transfer) =>
        transfer.transfer_kind === 'STANDARD' &&
        transfer.status === 'DISPATCHED' &&
        // Destination tenue par l'appareil, ou transfert dont l'appareil n'est pas la source.
        (held.has(transfer.to_location_id) || !held.has(transfer.from_location_id)),
    )
    .map((transfer) => ({ transfer, receiving: receiving.has(transfer.id) }))
    .sort((a, b) => (b.transfer.dispatched_at ?? '').localeCompare(a.transfer.dispatched_at ?? ''));
}

/** Quantité saisie ≥ 0, 3 décimales au plus, dans la borne `numeric(14,3)` ; `null` si invalide. */
export function parseReceived(text: string): number | null {
  const normalized = text.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,3})?$/.test(normalized)) return null;
  const value = Number(normalized);
  return value <= MAX_QUANTITY ? value : null;
}

/** Nombre maximal de lignes d'une réception sans document (`BLIND_RECEIPT_MAX_LINES`). */
export const BLIND_RECEIPT_MAX_LINES = 200;

/**
 * Transfert expédié connu de l'appareil sur la même paire source → destination : il se reçoit avec
 * son document, jamais sans (06-offline-sync, BR-STK-024).
 */
export function knownDispatch(
  transfers: ReadonlyMap<string, StockTransferData>,
  fromLocationId: string,
  toLocationId: string,
): StockTransferData | undefined {
  return [...transfers.values()].find(
    (transfer) =>
      transfer.transfer_kind === 'STANDARD' &&
      transfer.status === 'DISPATCHED' &&
      transfer.from_location_id === fromLocationId &&
      transfer.to_location_id === toLocationId,
  );
}

/** Produits saisis plus d'une fois (un produit ne figure qu'une fois dans une réception sans document). */
export function duplicateProducts(productIds: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of productIds) {
    if (!id) continue;
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return duplicates;
}

/** Charge utile stricte de la réception sans document (aucune clé en plus, BR-STK-024). */
export function blindReceiptPayload(input: {
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly lines: readonly {
    readonly productId: string;
    readonly unitCode: string;
    readonly receivedQtyBase: number;
  }[];
  readonly notes: string;
}) {
  const notes = input.notes.trim();
  return {
    fromLocationId: input.fromLocationId,
    toLocationId: input.toLocationId,
    lines: input.lines.map((line) => ({
      productId: line.productId,
      unitCode: line.unitCode,
      receivedQtyBase: line.receivedQtyBase,
    })),
    ...(notes ? { notes } : {}),
  };
}

// --- Réceptions sans document en attente (AV-520) ---------------------------------------------------

/** Longueur maximale du motif d'annulation d'une réception sans document (comme le serveur). */
export const MAX_CANCEL_BLIND_REASON = 500;

/**
 * Réceptions sans document non rapprochées d'un emplacement de l'appareil, la plus récente d'abord : à rapprocher
 * d'un transfert expédié de la même paire, ou à annuler si elles ont été saisies par erreur.
 */
export function pendingBlindReceipts(
  transfers: ReadonlyMap<string, StockTransferData>,
  destinationId: string,
): StockTransferData[] {
  return [...transfers.values()]
    .filter(
      (transfer) =>
        transfer.transfer_kind === 'BLIND_RECEIPT' &&
        transfer.status === 'UNMATCHED' &&
        transfer.to_location_id === destinationId,
    )
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
}

/**
 * Transferts expédiés de la même paire (source, destination) qu'une réception sans document : ceux qu'on peut lui
 * rapprocher à la main, les plus anciens d'abord. Le serveur contrôle encore que les produits reçus figurent dans le
 * transfert choisi (AV-177).
 */
export function matchCandidates(
  transfers: ReadonlyMap<string, StockTransferData>,
  receipt: Pick<StockTransferData, 'from_location_id' | 'to_location_id'>,
): StockTransferData[] {
  return [...transfers.values()]
    .filter(
      (transfer) =>
        transfer.transfer_kind === 'STANDARD' &&
        transfer.status === 'DISPATCHED' &&
        transfer.from_location_id === receipt.from_location_id &&
        transfer.to_location_id === receipt.to_location_id,
    )
    .sort((a, b) => (a.dispatched_at ?? '').localeCompare(b.dispatched_at ?? ''));
}

/** Charge utile de `inventory.transfer.match_blind` (l'agrégat est la réception sans document). */
export const matchBlindPayload = (transferId: string) => ({ transferId });

/** Charge utile de `inventory.transfer.cancel_blind` : le motif est exigé, nettoyé des blancs en tête et en queue. */
export const cancelBlindPayload = (reason: string) => ({ reason: reason.trim() });
