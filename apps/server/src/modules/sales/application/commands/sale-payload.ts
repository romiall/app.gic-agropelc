/**
 * Charge utile de `sales.sale.record` (D04 §5 ; UC-VEN-01) : contrat partagé avec l'appareil, qui
 * enregistre la vente même sans réseau. Un fait accompli n'est jamais « corrigé » par le serveur :
 * le prix appliqué, la remise et les quantités sont ceux saisis (BR-VEN-029) ; seules les
 * références (produit, unité, règle de prix, compte) sont contrôlées. Montants en XAF entiers,
 * quantités en nombre décimal à trois décimales au plus (ADR-013).
 */
import { z } from 'zod';

const uuid = z.string().uuid();
const xafInt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Borne de `numeric(14,3)` : au-delà, l'écriture échouerait (erreur SQL, commande rejouée sans fin). */
const MAX_QUANTITY = 99_999_999_999.999;
const quantity = z.number().positive().finite().max(MAX_QUANTITY);

export const saleLineSchema = z.object({
  productId: uuid,
  /** Quantité saisie, dans `unitCode` (unité de base ou conditionnement de vente). */
  quantity,
  unitCode: z.string().trim().min(1).max(20),
  /** Même quantité en unité de base, calculée par l'appareil ; le serveur la recontrôle. */
  quantityBase: quantity,
  /** Poids pesé en kg, obligatoire pour un produit vendu au poids (AV-031). */
  weightKg: quantity.optional(),
  /** Prix catalogue connu de l'appareil à l'instant de la vente ; `null` : aucune règle trouvée. */
  listUnitPriceXaf: xafInt.nullable().optional(),
  /** Règle tarifaire à l'origine du prix catalogue (la version se lit sur la règle). */
  priceRuleId: uuid.optional(),
  /** Prix unitaire appliqué, jamais recalculé (BR-VEN-029). */
  unitPriceXaf: xafInt,
  /** Remise en XAF (le pourcentage saisi est converti par l'appareil, `discountFromPercentXaf`). */
  discountXaf: xafInt.optional(),
  /** Motif de la dérogation de prix (catégorie `PRICE_OVERRIDE`), exigé dès qu'elle existe. */
  overrideReasonCodeId: uuid.optional(),
});
export type SaleLineInput = z.infer<typeof saleLineSchema>;

export const salePaymentSchema = z.object({
  methodCode: z.string().trim().min(1).max(40),
  amountXaf: xafInt.refine((value) => value > 0, 'Montant strictement positif attendu.'),
  /** Référence externe (mobile money, virement, chèque) : unique par moyen de paiement. */
  reference: z.string().trim().min(1).max(80).optional(),
  /** Compte de trésorerie désigné par l'appareil (jeu `cash`), contrôlé par le serveur. */
  cashAccountId: uuid.optional(),
});
export type SalePaymentInput = z.infer<typeof salePaymentSchema>;

export const recordSalePayloadSchema = z.object({
  /** Emplacement source : vente du PDV, stock mobile du commercial, ou emplacement d'élevage. */
  fromLocationId: uuid,
  /** Client ; absent pour une vente anonyme (payée intégralement, AV-027). */
  customerId: uuid.optional(),
  /** Canal choisi par le vendeur ; à défaut, déduit du contexte (BR-VEN-021). */
  channelCode: z.string().trim().min(1).max(20).optional(),
  /** Référence locale du reçu (unique par appareil). */
  localRef: z.string().trim().min(1).max(20).optional(),
  position: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      accuracyM: z.number().nonnegative().max(99_999).optional(),
    })
    .optional(),
  lines: z.array(saleLineSchema).min(1).max(100),
  payments: z.array(salePaymentSchema).max(10).optional(),
});
export type RecordSalePayload = z.infer<typeof recordSalePayloadSchema>;
