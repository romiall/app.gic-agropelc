/**
 * Pièces jointes (UC-ADM-16 ; ADR-012, ADR-046 ; D01 §8) : bornes partagées par l'appareil et le
 * serveur — types acceptés, taille maximale, natures, propriétaires connus, taille de morceau
 * recommandée pour l'envoi.
 */

/** Types MIME acceptés (D01 §8 ; contrôlés aussi sur les premiers octets à la fin de l'envoi). */
export const ATTACHMENT_MIME_TYPES = ['image/jpeg', 'image/webp', 'application/pdf'] as const;
export type AttachmentMimeType = (typeof ATTACHMENT_MIME_TYPES)[number];

/** Taille maximale d'une pièce (5 Mo ; CHECK `ck_attachments_attachments_size`). */
export const ATTACHMENT_MAX_SIZE_BYTES = 5 * 1024 * 1024;

/** Natures d'une pièce (dictionnaire `attachments.attachments.kind`). */
export const ATTACHMENT_KINDS = [
  'PHOTO',
  'INVOICE',
  'RECEIPT',
  'DELIVERY_NOTE',
  'SUPPLIER_DOCUMENT',
  'OTHER',
] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/**
 * Propriétaires dont la pièce est lue par le serveur (ADR-046) : le type de document est celui de
 * l'agrégat de la commande qui le crée, l'identifiant celui que l'appareil a choisi.
 * - `GOODS_RECEIPT` : bon de livraison d'une réception d'achat (`DELIVERY_NOTE`) ; sa réception
 *   régularise la « photo manquante » (`RECEIPT_PHOTO_MISSING`, AV-246) ;
 * - `STOCK_LOSS` : photo d'une perte ou d'une mortalité (`PHOTO`) ; l'approbation d'une mortalité
 *   l'attend (AV-107) ;
 * - `EXPENSE` : justificatif d'une dépense (`RECEIPT`), cité par la dépense ; exigé au-delà du seuil
 *   de justificatif (ADR-042, ADR-047 §3) ;
 * - `SUPPLIER_INVOICE` : facture fournisseur (`INVOICE`), citée par son enregistrement (ADR-047 §3).
 */
export const ATTACHMENT_OWNER_TYPES = [
  'GOODS_RECEIPT',
  'STOCK_LOSS',
  'EXPENSE',
  'SUPPLIER_INVOICE',
] as const;
export type AttachmentOwnerType = (typeof ATTACHMENT_OWNER_TYPES)[number];

/** Morceau recommandé pour l'envoi des octets (ADR-012 point 3 : 256 Ko). */
export const ATTACHMENT_CHUNK_SIZE_BYTES = 256 * 1024;

/** Statuts d'une pièce côté serveur (SM-ATTACHMENT). */
export const ATTACHMENT_UPLOAD_STATUSES = [
  'PENDING_UPLOAD',
  'AVAILABLE',
  'QUARANTINED',
  'MISSING',
  'SUPERSEDED',
] as const;
export type AttachmentUploadStatus = (typeof ATTACHMENT_UPLOAD_STATUSES)[number];
