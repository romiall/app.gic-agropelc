/**
 * Charges utiles des commandes de la distribution (P5 ; ADR-021, ADR-032, ADR-033) : sessions de
 * caisse, remises de fonds, quotas d'appareil. Contrat partagé entre l'appareil, qui enregistre le
 * fait même sans réseau, et le serveur, qui l'importe pour valider (un seul schéma, jamais deux).
 *
 * Règles communes : montants en XAF **entiers** (ADR-013) ; quantités en unité de base à trois
 * décimales au plus ; le serveur calcule seul l'attendu, l'écart, le statut et le reste (le payload
 * ne porte jamais ce que le serveur doit déterminer : seulement le montant compté ou le fait
 * constaté). L'identifiant de l'agrégat (session, remise, quota) est l'`aggregate_id` de l'enveloppe,
 * choisi par l'appareil (UUIDv7).
 */
import { z } from 'zod';

const uuid = z.string().uuid();
const xafInt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveXaf = xafInt.refine((value) => value > 0, 'Montant strictement positif attendu.');
const text = (max: number) => z.string().trim().min(1).max(max);

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
const nonNegativeQuantity = z
  .number()
  .nonnegative()
  .finite()
  .max(MAX_QUANTITY)
  .refine(hasAtMostThreeDecimals, 'Trois décimales au plus.');

// --- Sessions de caisse (finance.cash_session.*) ------------------------------------------------------------

/** `finance.cash_session.open` — hors ligne possible ; seule une caisse de PDV ouvre une session (AV-165). */
export const cashSessionOpenPayloadSchema = z.object({
  cashAccountId: uuid,
  /** Fonds compté dans le tiroir à l'ouverture (XAF). */
  countedXaf: xafInt,
  comment: text(500).optional(),
});
export type CashSessionOpenPayload = z.infer<typeof cashSessionOpenPayloadSchema>;

/** `finance.cash_session.close` — hors ligne possible ; ne porte que le montant compté (ADR-032 §3). */
export const cashSessionClosePayloadSchema = z.object({
  countedXaf: xafInt,
  comment: text(500).optional(),
});
export type CashSessionClosePayload = z.infer<typeof cashSessionClosePayloadSchema>;

/** `finance.cash_session.force_close` — en ligne, par la Finance ou un responsable ; comptage déclaré. */
export const cashSessionForceClosePayloadSchema = z.object({
  countedXaf: xafInt,
  reason: text(500),
});
export type CashSessionForceClosePayload = z.infer<typeof cashSessionForceClosePayloadSchema>;

/**
 * `finance.cash_session.validate` — en ligne, Finance ou Direction. Le motif est exigé par le serveur
 * dès qu'un écart existe (BR-DIS-007) ; l'écart lui-même n'est jamais fourni.
 */
export const cashSessionValidatePayloadSchema = z.object({
  reason: text(500).optional(),
});
export type CashSessionValidatePayload = z.infer<typeof cashSessionValidatePayloadSchema>;

// --- Remises de fonds (finance.cash_transfer.*) -----------------------------------------------------------------

/**
 * `finance.cash_transfer.send` — hors ligne possible ; sortie du compte source (`TRANSFER_OUT`).
 * `localRef` (P5-15) : référence locale de l'appareil, unique par appareil ; déjà prise hors ligne,
 * la remise est appliquée sans elle (`LOCAL_REF_DUPLICATE`, comme une vente).
 */
export const cashTransferSendPayloadSchema = z
  .object({
    fromAccountId: uuid,
    toAccountId: uuid,
    amountXaf: positiveXaf,
    /** Porteur de l'argent : un utilisateur connu, ou un nom libre (AV-158). */
    carrierUserId: uuid.optional(),
    carrierName: text(120).optional(),
    comment: text(500).optional(),
    localRef: text(20).optional(),
  })
  .refine((payload) => payload.fromAccountId !== payload.toAccountId, {
    message: 'La remise doit viser un autre compte que la source.',
    path: ['toAccountId'],
  });
export type CashTransferSendPayload = z.infer<typeof cashTransferSendPayloadSchema>;

/**
 * `finance.cash_transfer.receive` — le montant réellement reçu ; l'écart est calculé par le serveur.
 * Zéro est un constat (remise perdue en route, AV-175) : écart = − envoyé, sans entrée de trésorerie.
 */
export const cashTransferReceivePayloadSchema = z.object({
  receivedXaf: xafInt,
  comment: text(500).optional(),
});
export type CashTransferReceivePayload = z.infer<typeof cashTransferReceivePayloadSchema>;

/**
 * `finance.cash_transfer.cancel` — depuis `SENT` seulement, par l'expéditeur, hors ligne possible ;
 * l'argent revient au compte source (inverse daté de l'annulation, ADR-032 §2).
 */
export const cashTransferCancelPayloadSchema = z.object({
  reason: text(500),
});
export type CashTransferCancelPayload = z.infer<typeof cashTransferCancelPayloadSchema>;

// --- Quotas d'appareil (inventory.allocation.*) --------------------------------------------------------------------

/**
 * `inventory.allocation.grant` — en ligne seulement ; octroi d'un quota à un couple (utilisateur,
 * appareil) sur un emplacement `SHARED`. Quota au grain (emplacement, produit) : le lot éventuel est
 * indicatif (AV-160). Validité : une date, une durée en heures, ou, par défaut, la fin du jour métier.
 */
export const allocationGrantPayloadSchema = z
  .object({
    holderUserId: uuid,
    holderDeviceId: uuid,
    locationId: uuid,
    productId: uuid,
    lotId: uuid.optional(),
    quantityBase: positiveQuantity,
    validUntil: z.string().datetime().optional(),
    validityHours: z
      .number()
      .positive()
      .max(24 * 31)
      .optional(),
  })
  .refine((payload) => payload.validUntil === undefined || payload.validityHours === undefined, {
    message: 'Indiquer une date de fin ou une durée, pas les deux.',
    path: ['validityHours'],
  });
export type AllocationGrantPayload = z.infer<typeof allocationGrantPayloadSchema>;

/**
 * `inventory.allocation.increase` — en ligne seulement ; augmentation d'un quota existant. L'enveloppe
 * porte la version attendue du quota (`base_version`) pour qu'un double envoi ne la compte pas deux
 * fois (ADR-033 §9).
 */
export const allocationIncreasePayloadSchema = z.object({
  quantityBase: positiveQuantity,
});
export type AllocationIncreasePayload = z.infer<typeof allocationIncreasePayloadSchema>;

/** `inventory.allocation.revoke` — en ligne seulement, par un responsable, motif obligatoire (BR-STK-014). */
export const allocationRevokePayloadSchema = z.object({
  reason: text(500),
});
export type AllocationRevokePayload = z.infer<typeof allocationRevokePayloadSchema>;

/**
 * `inventory.allocation.release` — fait accompli de l'appareil détenteur, hors ligne possible : il
 * déclare le reste de son quota. Un écart avec le reste connu du serveur ouvre un conflit, il n'est
 * jamais corrigé en silence (ADR-033 §9).
 */
export const allocationReleasePayloadSchema = z.object({
  remainingBase: nonNegativeQuantity,
});
export type AllocationReleasePayload = z.infer<typeof allocationReleasePayloadSchema>;
