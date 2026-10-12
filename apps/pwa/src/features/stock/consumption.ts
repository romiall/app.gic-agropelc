/**
 * ECR-STK-08 « Consommation d'intrants hors lot » (UC-STK-10, BR-STK-036) : logique pure de
 * `inventory.consumption.record`. L'intrant sort de l'emplacement et son coût est imputé au site de
 * l'emplacement (`costObjectType` `SITE`) ; la consommation d'un lot de production se saisit dans la
 * saisie du jour de la production. Nature du coût choisie à la saisie (pas de correspondance produit →
 * nature côté serveur). Lot facultatif (FIFO du serveur sinon).
 */
import type { TransferLineCheck } from './transfer.js';

/** Natures de coût proposées pour un intrant hors lot (les autres concernent les lots ou la finance). */
export const CONSUMPTION_COST_TYPES = ['ALIMENT', 'VETERINAIRE', 'AUTRE_INTRANT'] as const;
export type ConsumptionCostType = (typeof CONSUMPTION_COST_TYPES)[number];

export function consumptionPayload(input: {
  readonly locationId: string;
  readonly siteId: string;
  readonly line: TransferLineCheck & { readonly quantity: number; readonly quantityBase: number };
  readonly lotId: string;
  readonly costType: ConsumptionCostType;
}) {
  return {
    locationId: input.locationId,
    productId: input.line.draft.productId,
    ...(input.lotId ? { lotId: input.lotId } : {}),
    quantityBase: input.line.quantityBase,
    unitCode: input.line.draft.unitCode,
    quantity: input.line.quantity,
    costObjectType: 'SITE' as const,
    costObjectId: input.siteId,
    costType: input.costType,
  };
}
