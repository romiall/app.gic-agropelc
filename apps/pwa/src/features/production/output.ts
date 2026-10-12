/**
 * ECR-PRD-07 « SORTIE VERS COMMERCIALISATION » (responsable de ferme ; D07, BR-PRD-010) : logique pure.
 *
 * - Sortie physique = expédition directe (`inventory.transfer.dispatch`) des têtes d'un lot actif ou en
 *   vente, depuis un bâtiment ou une case, vers un emplacement commercial (magasin, PDV, emplacement
 *   mobile) ; la ligne porte le lot de stock du lot de production (`lotId`) et l'unité de base.
 * - Possible dès `ACTIVE` (BR-PRD-010) ; la vente directe depuis l'élevage exige `SELLING`, que seul le
 *   responsable de production déclare (`production.lot.set_status`, en ligne, refusé sans effectif).
 */
import type { OutboxCommand } from '../../storage/db.js';
import { stillInFlight } from '../sales/pending.js';
import type { LocationData, ProductionLotData } from '../sales/types.js';

const COMMERCIAL_TYPES: ReadonlySet<string> = new Set(['STORE', 'POS', 'MOBILE']);
export const MAX_CARRIER_NAME = 200;
export const MAX_OUTPUT_NOTES = 2000;

/** Emplacements commerciaux actifs connus de l'appareil, par nom. */
export function commercialDestinations(locations: readonly LocationData[]): LocationData[] {
  return locations
    .filter(
      (location) =>
        !location.is_virtual &&
        location.status === 'ACTIVE' &&
        COMMERCIAL_TYPES.has(location.location_type),
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

interface DispatchPayload {
  readonly fromLocationId?: string;
  readonly lines?: readonly { readonly lotId?: string; readonly quantityBase?: number }[];
}

/**
 * Têtes d'un lot de stock expédiées depuis l'appareil (expéditions directes) et pas encore dans le
 * jeu `stock`, par emplacement de départ.
 */
export function pendingLotDispatches(
  outbox: readonly OutboxCommand[],
  stockPulledAt: string | undefined,
  stockLotId: string,
): Map<string, number> {
  const milli = new Map<string, number>();
  for (const command of outbox) {
    if (command.command_type !== 'inventory.transfer.dispatch') continue;
    if (!stillInFlight(command, stockPulledAt)) continue;
    const payload = command.payload as DispatchPayload;
    if (!payload.fromLocationId) continue;
    for (const line of payload.lines ?? []) {
      if (line.lotId !== stockLotId || !line.quantityBase) continue;
      milli.set(
        payload.fromLocationId,
        (milli.get(payload.fromLocationId) ?? 0) + Math.round(line.quantityBase * 1000),
      );
    }
  }
  return new Map([...milli].map(([id, value]) => [id, value / 1000]));
}

interface EntryPayloadLike {
  readonly sourceKind?: string;
  readonly sourceProductionLotId?: string;
  readonly sourceLocationId?: string;
  readonly quantity?: number;
}

/**
 * Têtes d'un lot de production passées dans un autre lot depuis l'appareil (transfert, sevrage,
 * ECR-PRD-04) et pas encore dans le jeu `stock`, par emplacement de départ.
 */
export function pendingLotTransfersOut(
  outbox: readonly OutboxCommand[],
  stockPulledAt: string | undefined,
  productionLotId: string,
): Map<string, number> {
  const milli = new Map<string, number>();
  for (const command of outbox) {
    if (command.command_type !== 'production.lot.record_entry') continue;
    if (!stillInFlight(command, stockPulledAt)) continue;
    const payload = command.payload as EntryPayloadLike;
    if (
      (payload.sourceKind !== 'TRANSFER' && payload.sourceKind !== 'WEANING') ||
      payload.sourceProductionLotId !== productionLotId ||
      !payload.sourceLocationId ||
      !payload.quantity
    ) {
      continue;
    }
    milli.set(
      payload.sourceLocationId,
      (milli.get(payload.sourceLocationId) ?? 0) + Math.round(payload.quantity * 1000),
    );
  }
  return new Map([...milli].map(([id, value]) => [id, value / 1000]));
}

const optionalText = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

/** Charge utile de l'expédition directe des têtes d'un lot. */
export function outputPayload(input: {
  readonly lot: Pick<ProductionLotData, 'product_id' | 'stock_lot_id'>;
  readonly unitCode: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly quantity: number;
  readonly carrierName: string;
  readonly notes: string;
}) {
  const carrierName = optionalText(input.carrierName);
  const notes = optionalText(input.notes);
  return {
    fromLocationId: input.fromLocationId,
    toLocationId: input.toLocationId,
    lines: [
      {
        productId: input.lot.product_id,
        unitCode: input.unitCode,
        quantityBase: input.quantity,
        lotId: input.lot.stock_lot_id,
      },
    ],
    ...(carrierName ? { carrierName } : {}),
    ...(notes ? { notes } : {}),
  };
}
