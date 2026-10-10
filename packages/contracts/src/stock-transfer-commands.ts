/**
 * Charges utiles des commandes de transfert de stock ajoutées en P5-16 (ADR-021 ; D06 BR-STK-024,
 * BR-STK-025 ; SM-TRANSFER) : réception **sans document** (`inventory.transfer.receive` sans
 * `transferId`) et retour à la source (`inventory.transfer.return_to_source`). Contrat partagé entre
 * l'appareil, qui enregistre le fait même sans réseau, et le serveur, qui l'importe pour valider.
 *
 * La réception sans document ne déclare que ce que l'appareil constate : l'emplacement d'où vient la
 * marchandise, les produits et les quantités reçues (un lot facultatif, **indicatif**, comme
 * `client_lot_hint`). Le serveur seul rapproche, valorise et choisit les lots (AV-180, AV-182).
 * L'identifiant du document est l'`aggregate_id` de l'enveloppe (UUIDv7 de l'appareil).
 */
import { z } from 'zod';

const uuid = z.string().uuid();

/** Borne de `numeric(14,3)` : au-delà, l'écriture échouerait (erreur SQL, commande rejouée sans fin). */
const MAX_QUANTITY = 99_999_999_999.999;
const hasAtMostThreeDecimals = (value: number): boolean =>
  Math.abs(Math.round(value * 1000) / 1000 - value) < 1e-9;
const positiveQuantity = z
  .number()
  .positive()
  .finite()
  .max(MAX_QUANTITY)
  .refine(hasAtMostThreeDecimals, 'Trois décimales au plus.');

/** Nombre maximal de lignes d'une réception sans document. */
export const BLIND_RECEIPT_MAX_LINES = 200;

const blindReceiptLineSchema = z
  .object({
    productId: uuid,
    unitCode: z.string().min(1).max(20),
    receivedQtyBase: positiveQuantity,
    /** Lot constaté sur la marchandise (indicatif : ignoré s'il ne correspond pas au produit). */
    lotId: uuid.optional(),
  })
  .strict();

/**
 * `inventory.transfer.receive` **sans document** (BR-STK-024) — hors ligne possible. Strict : un
 * `transferId` présent désigne la réception avec document, dont le schéma reste celui du serveur.
 */
export const transferBlindReceivePayloadSchema = z
  .object({
    fromLocationId: uuid,
    toLocationId: uuid,
    lines: z.array(blindReceiptLineSchema).min(1).max(BLIND_RECEIPT_MAX_LINES),
    notes: z.string().max(2000).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.fromLocationId === data.toLocationId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Source et destination doivent différer.',
        path: ['toLocationId'],
      });
    }
    const seen = new Set<string>();
    data.lines.forEach((line, index) => {
      if (seen.has(line.productId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Un produit ne figure qu’une fois dans une réception sans document.',
          path: ['lines', index, 'productId'],
        });
      }
      seen.add(line.productId);
    });
  });
export type TransferBlindReceivePayload = z.infer<typeof transferBlindReceivePayloadSchema>;

/**
 * `inventory.transfer.return_to_source` (BR-STK-025, SM-TRANSFER `DISPATCHED → RETURNED`) — hors
 * ligne possible ; le motif est obligatoire.
 */
export const transferReturnToSourcePayloadSchema = z
  .object({
    transferId: uuid,
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type TransferReturnToSourcePayload = z.infer<typeof transferReturnToSourcePayloadSchema>;
