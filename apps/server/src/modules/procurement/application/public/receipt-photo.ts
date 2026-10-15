/**
 * Régularisation de la « photo manquante » d'une réception d'achat (MP-10 ; AV-246, AV-285 ; ADR-046) :
 * la photo du bon de livraison (`DELIVERY_NOTE` rattachée à `GOODS_RECEIPT`), reçue et vérifiée
 * (`AVAILABLE`), clôt le conflit informatif `RECEIPT_PHOTO_MISSING` de la réception — résolution
 * `COMPENSATE`, la pièce en référence. Appelée à la fin de l'envoi des octets (`attachments-api/`), dans
 * sa transaction. La clôture manuelle par le Resp. achats (`sync.conflict.dismiss`, motif obligatoire)
 * reste possible (AV-285 (a)).
 */
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { resolveOpenConflicts } from '../../../../platform/sync/conflicts.js';

export const RECEIPT_PHOTO_MISSING_CONFLICT = 'RECEIPT_PHOTO_MISSING';

export async function regularizeReceiptPhoto(
  uow: UnitOfWork,
  input: {
    readonly receiptId: string;
    readonly attachmentId: string;
    readonly resolvedBy: string;
    readonly at: Date;
  },
): Promise<number> {
  return resolveOpenConflicts(uow, {
    conflictType: RECEIPT_PHOTO_MISSING_CONFLICT,
    entityType: 'GOODS_RECEIPT',
    entityIds: [input.receiptId],
    resolution: 'COMPENSATE',
    resolvedBy: input.resolvedBy,
    resolvedAt: input.at,
    comment: 'Photo du bon de livraison reçue : régularisation automatique.',
    refs: [input.attachmentId],
  });
}
