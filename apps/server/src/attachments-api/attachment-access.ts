/**
 * Lecture d'une pièce jointe (MP-10, AV-286 ; 02-securite §9 : accès délivré après contrôle de portée
 * sur le document propriétaire) : son auteur ; qui peut décider une validation en attente sur ce
 * document (le valideur voit la pièce de ce qu'il décide) ; ou qui lit le document dans sa portée —
 * réception : `procurement.order.read` sur son site ; perte : `inventory.loss.read` sur son site ou
 * sa zone, ou sa propre déclaration (AV-094). Autre propriétaire : son auteur seulement.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../platform/kysely/database.js';
import { evaluateAccess } from '../modules/identity/application/public/index.js';
import { canDecidePendingApprovalOf } from '../modules/approvals/application/public/index.js';
import { lossDeclarationLocator } from '../modules/inventory/application/public/index.js';
import { getGoodsReceipt } from '../modules/procurement/application/public/index.js';

const RECEIPT_READ = 'procurement.order.read';
const RECEIPT_RECORD = 'procurement.receipt.record';
const LOSS_READ = 'inventory.loss.read';

export async function canViewAttachment(
  executor: Kysely<DB> | Transaction<DB>,
  attachment: { readonly createdBy: string; readonly ownerType: string; readonly ownerId: string },
  userId: string,
  at: Date,
): Promise<boolean> {
  if (attachment.createdBy === userId) return true;
  const { ownerType, ownerId } = attachment;
  if (
    await canDecidePendingApprovalOf(executor, {
      userId,
      subjectType: ownerType,
      subjectId: ownerId,
      at,
    })
  ) {
    return true;
  }
  if (ownerType === 'GOODS_RECEIPT') {
    const receipt = await getGoodsReceipt(executor, ownerId);
    if (!receipt) return false;
    return (
      await evaluateAccess(executor, {
        userId,
        permissionCode: RECEIPT_READ,
        occurredAt: at,
        resource: { siteId: receipt.siteId },
      })
    ).allowed;
  }
  if (ownerType === 'STOCK_LOSS') {
    const loss = await lossDeclarationLocator(executor, ownerId);
    if (!loss) return false;
    // Une seule évaluation : portée pleine sur le site ou la zone, ou portée propre sur sa déclaration.
    return (
      await evaluateAccess(executor, {
        userId,
        permissionCode: LOSS_READ,
        occurredAt: at,
        resource: {
          siteId: loss.siteId,
          ...(loss.zoneId ? { zoneId: loss.zoneId } : {}),
          ownerUserId: loss.declaredBy,
        },
      })
    ).allowed;
  }
  return false;
}

/**
 * La photo jointe peut-elle régulariser la « photo manquante » de la réception (AV-285) ? Son auteur
 * doit être le réceptionnaire, ou pouvoir enregistrer des réceptions sur le site de celle-ci : un
 * tiers ne clôt pas le signal du Resp. achats en joignant un fichier quelconque (revue de MP-10).
 */
export async function canRegularizeReceiptPhoto(
  executor: Kysely<DB> | Transaction<DB>,
  receiptId: string,
  userId: string,
  at: Date,
): Promise<boolean> {
  const receipt = await getGoodsReceipt(executor, receiptId);
  if (!receipt) return false;
  if (receipt.receivedBy === userId) return true;
  return (
    await evaluateAccess(executor, {
      userId,
      permissionCode: RECEIPT_RECORD,
      occurredAt: at,
      resource: { siteId: receipt.siteId },
    })
  ).allowed;
}
