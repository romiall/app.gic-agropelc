/**
 * Déclaration d'une perte (ECR-STK-04 ; `inventory.loss.declare`, BR-STK-030 et suivants). Logique
 * pure : catégories proposées sur l'appareil, contrôles faits avant l'envoi, charge utile.
 *
 * - La mortalité d'un lot biologique se déclare par la saisie du jour de production (lot exigé) :
 *   elle n'est pas proposée ici.
 * - Commentaire obligatoire pour une perte inexpliquée ou un vol suspecté (`COMMENT_REQUIRED`), et
 *   pour un motif qui l'exige (`requires_comment`, que le serveur ne contrôle pas).
 * - Lot : facultatif ; sans lot, le serveur choisit le plus ancien (FIFO, BR-STK-050).
 * - Au-delà du disponible connu (ou du lot choisi), la perte est bloquée en ligne, comme le serveur
 *   la refuserait (`INSUFFICIENT_STOCK`, BR-STK-017) ; hors ligne, c'est un fait accompli, signalé
 *   et enregistré (BR-STK-018).
 * - Quantité dans la borne `numeric(14,3)` (`MAX_QUANTITY`).
 */
import {
  convertToBaseQuantity,
  DomainError,
  quantityFromDecimal,
  quantityToDecimal,
} from '@gic/domain';
import { MAX_QUANTITY, parseQuantity, type SaleUnit } from '../sales/sale-form.js';
import type { ReasonCodeData } from '../sales/types.js';

export const DEVICE_LOSS_CATEGORIES = [
  'CASSE',
  'DETERIORATION',
  'IMPROPRE',
  'DESTRUCTION',
  'INEXPLIQUEE',
  'VOL_SUSPECTE',
] as const;

export type LossCategory = (typeof DEVICE_LOSS_CATEGORIES)[number];

const COMMENT_CATEGORIES: ReadonlySet<string> = new Set(['INEXPLIQUEE', 'VOL_SUSPECTE']);
export const MAX_LOSS_COMMENT_LENGTH = 2000;

export interface LossDraft {
  readonly productId: string;
  readonly unitCode: string;
  readonly quantityText: string;
  readonly category: LossCategory | '';
  readonly reasonCodeId: string;
  readonly lotId: string;
  readonly comment: string;
}

export type LossIssue =
  'PRODUCT_REQUIRED' | 'QUANTITY_INVALID' | 'CATEGORY_REQUIRED' | 'COMMENT_REQUIRED';

/** Motifs de perte de la catégorie choisie (`loss_category`), ou sans catégorie précisée. */
export function lossReasons(
  reasons: readonly ReasonCodeData[],
  category: LossCategory | '',
): ReasonCodeData[] {
  return reasons.filter(
    (reason) =>
      reason.category === 'LOSS' &&
      (reason.loss_category === null || reason.loss_category === category),
  );
}

export interface LossCheck {
  readonly issues: readonly LossIssue[];
  readonly quantity: number | null;
  readonly quantityBase: number | null;
}

export function checkLoss(
  draft: LossDraft,
  unit: SaleUnit | undefined,
  reasons: readonly ReasonCodeData[],
): LossCheck {
  const issues: LossIssue[] = [];
  if (!draft.productId) issues.push('PRODUCT_REQUIRED');
  const quantity = parseQuantity(draft.quantityText);
  let quantityBase: number | null = null;
  if (quantity === null || !unit) {
    issues.push('QUANTITY_INVALID');
  } else {
    try {
      quantityBase = quantityToDecimal(
        convertToBaseQuantity(quantityFromDecimal(quantity), unit.factorToBase),
      );
      if (quantityBase > MAX_QUANTITY) {
        quantityBase = null;
        issues.push('QUANTITY_INVALID');
      }
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      issues.push('QUANTITY_INVALID');
    }
  }
  if (!draft.category) issues.push('CATEGORY_REQUIRED');
  const reason = reasons.find((candidate) => candidate.id === draft.reasonCodeId);
  const needsComment = COMMENT_CATEGORIES.has(draft.category) || reason?.requires_comment === true;
  if (needsComment && !draft.comment.trim()) issues.push('COMMENT_REQUIRED');
  return { issues, quantity, quantityBase };
}

export function lossPayload(
  draft: LossDraft & { readonly category: LossCategory },
  locationId: string,
  check: LossCheck & { readonly quantity: number; readonly quantityBase: number },
) {
  const comment = draft.comment.trim();
  return {
    locationId,
    productId: draft.productId,
    ...(draft.lotId ? { lotId: draft.lotId } : {}),
    quantityBase: check.quantityBase,
    unitCode: draft.unitCode,
    quantity: check.quantity,
    category: draft.category,
    ...(draft.reasonCodeId ? { reasonCodeId: draft.reasonCodeId } : {}),
    ...(comment ? { comment } : {}),
  };
}
