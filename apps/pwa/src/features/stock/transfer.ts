/**
 * ECR-STK-02 « TRANSFÉRER (expédier) » (BR-STK-020 et suivants, SM-TRANSFER) : logique pure.
 *
 * - Demande reçue (`REQUESTED`, emplacement source tenu par l'appareil) : expédiée avec ses lignes
 *   (`transferLineId`), quantités préremplies à la demande, modifiables ; une ligne à zéro n'est pas
 *   expédiée.
 * - Expédition directe : source tenue par l'appareil, destination physique quelconque (dont
 *   l'emplacement mobile d'un commercial), lignes saisies dans l'unité choisie, converties en unité
 *   de base.
 * - Lot : le serveur prend le plus ancien (FIFO, BR-STK-050) ; l'appareil n'en impose pas.
 * - Au-delà du disponible : bloqué en ligne (le serveur refuserait, `INSUFFICIENT_STOCK`), fait
 *   accompli signalé hors ligne (BR-STK-018). La marchandise expédiée quitte aussitôt le disponible
 *   local (`pendingConsumption`).
 */
import {
  convertToBaseQuantity,
  DomainError,
  quantityFromDecimal,
  quantityToDecimal,
} from '@gic/domain';
import { stillInFlight } from '../sales/pending.js';
import type { SalesReferences } from '../sales/references.js';
import { MAX_QUANTITY, parseQuantity, saleUnitsOf, type SaleUnit } from '../sales/sale-form.js';
import type { LocationData, ProductData, StockTransferData } from '../sales/types.js';
import { stockLocations } from './stock-view.js';

export const MAX_TRANSFER_NOTES = 2000;
export const MAX_CARRIER_NAME = 200;

export interface TransferLineDraft {
  readonly key: string;
  readonly productId: string;
  readonly unitCode: string;
  readonly quantityText: string;
}

export type TransferLineIssue = 'PRODUCT_REQUIRED' | 'QUANTITY_INVALID';

export interface TransferLineCheck {
  readonly draft: TransferLineDraft;
  readonly quantity: number | null;
  readonly quantityBase: number | null;
  readonly issue: TransferLineIssue | null;
}

/** Quantité de la ligne convertie en unité de base, dans la borne `numeric(14,3)`. */
export function checkTransferLine(
  draft: TransferLineDraft,
  unit: SaleUnit | undefined,
): TransferLineCheck {
  if (!draft.productId)
    return { draft, quantity: null, quantityBase: null, issue: 'PRODUCT_REQUIRED' };
  const quantity = parseQuantity(draft.quantityText);
  if (quantity === null || !unit) {
    return { draft, quantity: null, quantityBase: null, issue: 'QUANTITY_INVALID' };
  }
  try {
    const quantityBase = quantityToDecimal(
      convertToBaseQuantity(quantityFromDecimal(quantity), unit.factorToBase),
    );
    if (quantityBase <= 0 || quantityBase > MAX_QUANTITY) {
      return { draft, quantity, quantityBase: null, issue: 'QUANTITY_INVALID' };
    }
    return { draft, quantity, quantityBase, issue: null };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return { draft, quantity, quantityBase: null, issue: 'QUANTITY_INVALID' };
  }
}

/** Quantité totale par produit (unité de base, milli-unités arrondies). */
export function totalsByProduct(
  lines: readonly { readonly productId: string; readonly quantityBase: number | null }[],
): Map<string, number> {
  const milli = new Map<string, number>();
  for (const line of lines) {
    if (!line.productId || line.quantityBase === null) continue;
    milli.set(
      line.productId,
      (milli.get(line.productId) ?? 0) + Math.round(line.quantityBase * 1000),
    );
  }
  return new Map([...milli].map(([id, value]) => [id, value / 1000]));
}

/** Produits dont la quantité expédiée dépasse le disponible de la source. */
export function overAvailable(
  totals: ReadonlyMap<string, number>,
  availableOf: (productId: string) => number,
): string[] {
  return [...totals]
    .filter(([productId, quantity]) => quantity > availableOf(productId))
    .map(([productId]) => productId);
}

/** Transferts dont une expédition est saisie sur l'appareil et pas encore confirmée. */
export function dispatchingTransferIds(outbox: SalesReferences['outbox']): Set<string> {
  return new Set(
    outbox
      .filter(
        (command) =>
          command.command_type === 'inventory.transfer.dispatch' &&
          stillInFlight(command, undefined),
      )
      .map((command) => (command.payload as { transferId?: string }).transferId)
      .filter((id): id is string => typeof id === 'string'),
  );
}

/** Demandes de transfert à expédier depuis un emplacement de l'appareil, la plus ancienne d'abord. */
export function requestsToDispatch(
  refs: Pick<SalesReferences, 'transfers' | 'locations' | 'stock' | 'outbox'>,
): { readonly transfer: StockTransferData; readonly dispatching: boolean }[] {
  const held = new Set(stockLocations(refs).map((location) => location.id));
  const dispatching = dispatchingTransferIds(refs.outbox);
  return [...refs.transfers.values()]
    .filter(
      (transfer) =>
        transfer.transfer_kind === 'STANDARD' &&
        transfer.status === 'REQUESTED' &&
        held.has(transfer.from_location_id),
    )
    .map((transfer) => ({ transfer, dispatching: dispatching.has(transfer.id) }))
    .sort((a, b) => a.transfer.occurred_at.localeCompare(b.transfer.occurred_at));
}

/** Destinations possibles : emplacements physiques actifs autres que la source, par nom. */
export function destinations(locations: readonly LocationData[], sourceId: string): LocationData[] {
  return locations
    .filter(
      (location) =>
        location.id !== sourceId &&
        !location.is_virtual &&
        (location.status === undefined || location.status === 'ACTIVE'),
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

const optionalText = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

/** Charge utile d'une expédition directe (`inventory.transfer.dispatch` sans `transferId`). */
export function directDispatchPayload(input: {
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly lines: readonly TransferLineCheck[];
  readonly carrierName: string;
  readonly notes: string;
}) {
  const carrierName = optionalText(input.carrierName);
  const notes = optionalText(input.notes);
  return {
    fromLocationId: input.fromLocationId,
    toLocationId: input.toLocationId,
    lines: input.lines.map((line) => ({
      productId: line.draft.productId,
      unitCode: line.draft.unitCode,
      quantityBase: line.quantityBase as number,
    })),
    ...(carrierName ? { carrierName } : {}),
    ...(notes ? { notes } : {}),
  };
}

/** Quantité expédiée saisie pour une ligne de demande (unité de base) ; `null` si invalide. */
export function parseDispatched(text: string): number | null {
  const normalized = text.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,3})?$/.test(normalized)) return null;
  const value = Number(normalized);
  return value <= MAX_QUANTITY ? value : null;
}

/** Charge utile de l'expédition d'une demande : les lignes à expédier (quantité > 0). */
export function requestDispatchPayload(
  transfer: StockTransferData,
  quantities: ReadonlyMap<string, number>,
  carrierName: string,
  notes: string,
) {
  const carrier = optionalText(carrierName);
  const text = optionalText(notes);
  return {
    transferId: transfer.id,
    lines: transfer.lines
      .filter((line) => (quantities.get(line.id) ?? 0) > 0)
      .map((line) => ({
        transferLineId: line.id,
        productId: line.product_id,
        unitCode: line.unit_code,
        quantityBase: quantities.get(line.id) as number,
      })),
    ...(carrier ? { carrierName: carrier } : {}),
    ...(text ? { notes: text } : {}),
  };
}

export interface LineRow {
  readonly check: TransferLineCheck;
  readonly units: readonly SaleUnit[];
  readonly product: ProductData | undefined;
}

/** Lignes contrôlées : unité par défaut = unité de base du produit. */
export function computeLines(
  lines: readonly TransferLineDraft[],
  products: readonly ProductData[],
  refs: Pick<SalesReferences, 'productUnits'>,
): LineRow[] {
  return lines.map((line) => {
    const product = products.find((candidate) => candidate.id === line.productId);
    const units = product ? saleUnitsOf(product, refs) : [];
    const unitCode = line.unitCode || product?.base_unit_code || '';
    return {
      check: checkTransferLine(
        { ...line, unitCode },
        units.find((unit) => unit.unitCode === unitCode),
      ),
      units,
      product,
    };
  });
}
