/**
 * ECR-STK-02 « TRANSFÉRER (expédier) » (BR-STK-020 et suivants, SM-TRANSFER) : logique pure.
 *
 * - Demande reçue (`REQUESTED`, emplacement source tenu par l'appareil) : expédiée avec ses lignes
 *   (`transferLineId`), quantités préremplies à la demande, modifiables ; une ligne à zéro n'est pas
 *   expédiée.
 * - Expédition directe : source tenue par l'appareil, destination physique quelconque (dont
 *   l'emplacement mobile d'un commercial), lignes saisies dans l'unité choisie, converties en unité
 *   de base.
 * - Refus d'une demande reçue (`inventory.transfer.decline`, SM-TRANSFER `REQUESTED → DECLINED`), en
 *   ligne seulement (SM-TRANSFER : « Refus et décisions sur écart sont en ligne »), motif exigé (le
 *   serveur le remplace dans la note de la demande, S-40) ; impossible tant qu'une expédition de la
 *   demande est en attente, et inversement.
 * - Mouvement interne (`inventory.transfer.move_internal`, UC-STK-04, BR-STK-022 « même site, même
 *   responsable » : transfert `INTERNAL`, aussitôt `COMPLETED`) : entre emplacements physiques actifs
 *   du même site dont l'utilisateur ou l'appareil a la garde (partagés, exclusifs à lui ou à cet
 *   appareil), jamais un stock mobile (l'affectation à un commercial est un transfert en deux temps,
 *   BR-STK-023) ; le lot se désigne quand la source en compte plusieurs (sinon le serveur prendrait
 *   le plus ancien, BR-STK-050). La sortie de la source et l'entrée sur la destination comptent
 *   aussitôt dans le disponible local.
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
import { lotStockKey, stockKey } from '../sales/stock.js';
import { stockLocations } from './stock-view.js';

export const MAX_TRANSFER_NOTES = 2000;
export const MAX_DECLINE_COMMENT = 2000;
export const MAX_CARRIER_NAME = 200;

export interface TransferLineDraft {
  readonly key: string;
  readonly productId: string;
  readonly unitCode: string;
  readonly quantityText: string;
  /** Lot de stock désigné (mouvement interne d'une source à plusieurs lots). */
  readonly lotId?: string;
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

/** Transferts visés par une commande de ce type saisie sur l'appareil et pas encore retéléchargée. */
function transferIdsInFlight(outbox: SalesReferences['outbox'], commandType: string): Set<string> {
  return new Set(
    outbox
      .filter(
        (command) => command.command_type === commandType && stillInFlight(command, undefined),
      )
      .map((command) => (command.payload as { transferId?: string }).transferId)
      .filter((id): id is string => typeof id === 'string'),
  );
}

/** Transferts dont une expédition est saisie sur l'appareil et pas encore confirmée. */
export function dispatchingTransferIds(outbox: SalesReferences['outbox']): Set<string> {
  return transferIdsInFlight(outbox, 'inventory.transfer.dispatch');
}

/** Demandes dont un refus est saisi sur l'appareil et pas encore confirmé. */
export function decliningTransferIds(outbox: SalesReferences['outbox']): Set<string> {
  return transferIdsInFlight(outbox, 'inventory.transfer.decline');
}

/** Demandes de transfert à expédier depuis un emplacement de l'appareil, la plus ancienne d'abord. */
export function requestsToDispatch(
  refs: Pick<SalesReferences, 'transfers' | 'locations' | 'stock' | 'outbox'>,
): {
  readonly transfer: StockTransferData;
  readonly dispatching: boolean;
  readonly declining: boolean;
}[] {
  const held = new Set(stockLocations(refs).map((location) => location.id));
  const dispatching = dispatchingTransferIds(refs.outbox);
  const declining = decliningTransferIds(refs.outbox);
  return [...refs.transfers.values()]
    .filter(
      (transfer) =>
        transfer.transfer_kind === 'STANDARD' &&
        transfer.status === 'REQUESTED' &&
        held.has(transfer.from_location_id),
    )
    .map((transfer) => ({
      transfer,
      dispatching: dispatching.has(transfer.id),
      declining: declining.has(transfer.id),
    }))
    .sort((a, b) => a.transfer.occurred_at.localeCompare(b.transfer.occurred_at));
}

/** Charge utile du refus d'une demande (`inventory.transfer.decline`), motif exigé. */
export function declinePayload(transfer: Pick<StockTransferData, 'id'>, comment: string) {
  return { transferId: transfer.id, comment: comment.trim() };
}

/**
 * Emplacement dont l'utilisateur ou l'appareil a la garde, hors stock mobile : partagé, exclusif à
 * l'utilisateur, ou désigné pour cet appareil (BR-STK-022, « même responsable »).
 */
export function movableByHolder(
  location: Pick<
    LocationData,
    'location_type' | 'custody_mode' | 'custodian_user_id' | 'designated_device_id'
  >,
  userId: string,
  deviceId: string | undefined,
): boolean {
  if (location.location_type === 'MOBILE') return false;
  switch (location.custody_mode) {
    case 'EXCLUSIVE_USER':
      return location.custodian_user_id === userId;
    case 'EXCLUSIVE_DEVICE':
      return deviceId !== undefined && location.designated_device_id === deviceId;
    default:
      return true;
  }
}

/**
 * Destinations d'un mouvement interne : emplacements physiques actifs du site de la source, autres
 * qu'elle (INTERNAL_MOVE : même site, D06 §7.7), sous la garde de l'utilisateur ou de l'appareil, par
 * nom.
 */
export function internalDestinations(
  locations: readonly LocationData[],
  source: Pick<LocationData, 'id' | 'site_id'>,
  userId: string,
  deviceId: string | undefined,
): LocationData[] {
  if (!source.site_id) return [];
  return destinations(locations, source.id).filter(
    (location) =>
      location.site_id === source.site_id && movableByHolder(location, userId, deviceId),
  );
}

/** Charge utile d'un mouvement interne (`inventory.transfer.move_internal`). */
export function internalMovePayload(input: {
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly lines: readonly TransferLineCheck[];
  readonly notes: string;
}) {
  const notes = optionalText(input.notes);
  return {
    fromLocationId: input.fromLocationId,
    toLocationId: input.toLocationId,
    lines: input.lines.map((line) => ({
      productId: line.draft.productId,
      unitCode: line.draft.unitCode,
      quantityBase: line.quantityBase as number,
      ...(line.draft.lotId ? { lotId: line.draft.lotId } : {}),
    })),
    ...(notes ? { notes } : {}),
  };
}

/** Lots identifiés en stock d'un produit sur un emplacement, nets de l'attente qui les désigne. */
export function lotsAt(
  refs: Pick<SalesReferences, 'stock' | 'pendingLots'>,
  locationId: string,
  productId: string,
): { readonly lotId: string; readonly lotCode: string; readonly quantity: number }[] {
  return (refs.stock.get(stockKey(locationId, productId))?.lots ?? [])
    .filter((lot) => lot.lot_id !== null)
    .map((lot) => ({
      lotId: lot.lot_id as string,
      lotCode: lot.lot_code ?? '',
      quantity:
        Math.round(
          (Number(lot.qty_on_hand) -
            (refs.pendingLots.get(lotStockKey(locationId, productId, lot.lot_id as string)) ?? 0)) *
            1000,
        ) / 1000,
    }))
    .filter((lot) => lot.quantity > 0);
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

/**
 * Charge utile de l'expédition d'une demande : les lignes à expédier (quantité > 0) et le transporteur.
 * Pas de note : le serveur ne l'enregistre pas pour une demande (S-21).
 */
export function requestDispatchPayload(
  transfer: StockTransferData,
  quantities: ReadonlyMap<string, number>,
  carrierName: string,
) {
  const carrier = optionalText(carrierName);
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
