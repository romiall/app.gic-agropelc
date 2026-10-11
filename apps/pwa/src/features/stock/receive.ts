/**
 * Réception d'un transfert (ECR-STK-03) : transferts expédiés vers l'appareil et saisie des quantités
 * reçues. Logique pure.
 */
import { stillInFlight } from '../sales/pending.js';
import type { SalesReferences } from '../sales/references.js';
import type { StockTransferData } from '../sales/types.js';
import { stockLocations } from './stock-view.js';

/** Transferts expédiés vers l'appareil, avec l'éventuelle réception déjà saisie sur l'appareil. */
export function incomingTransfers(
  refs: Pick<SalesReferences, 'transfers' | 'locations' | 'stock' | 'outbox'>,
): { readonly transfer: StockTransferData; readonly receiving: boolean }[] {
  const held = new Set(stockLocations(refs).map((location) => location.id));
  const receiving = new Set(
    refs.outbox
      .filter(
        (command) =>
          command.command_type === 'inventory.transfer.receive' &&
          stillInFlight(command, undefined),
      )
      .map((command) => (command.payload as { transferId?: string }).transferId),
  );
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

/** Quantité saisie ≥ 0, 3 décimales au plus ; `null` si invalide. */
export function parseReceived(text: string): number | null {
  const normalized = text.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,3})?$/.test(normalized)) return null;
  return Number(normalized);
}
