/**
 * Tableau de distribution (ECR-DIS-04 ; D05 BR-DIS-010 ; D11 KPI-DIS-01 à 07 ; AT-042 ; P5-20,
 * ADR-035) : réponse de `GET /api/v1/analytics/dashboards/distribution`, partagée entre le serveur (qui
 * la compose à partir des fonctions de métriques des modules, BR-ANA-009) et la PWA (qui l'affiche).
 * Reprise sans changement par le module d'analyse (P9).
 *
 * Tout indicateur est **calculé** (BR-ANA-001). Quantités en unité de base du produit (`numeric(14,3)`,
 * jamais sommées entre produits, négatives possibles sur une période : retour à la source, annulation
 * datée) ; montants en XAF entiers (ADR-013). Une mesure masquée (valeur de stock sans
 * `inventory.valuation.read`, détail sans le droit du domaine) vaut `null` (AV-205, AV-206).
 */
import { z } from 'zod';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const uuid = z.string().uuid();
/** Quantité en unité de base ; négative possible sur une période. */
const qty = z.number().finite();
/** Montant en XAF entiers ; négatif possible (écart). */
const xaf = z.number().int();
const count = z.number().int().nonnegative();
const instant = z.string().min(1).max(40);

export const DISTRIBUTION_PERIOD_CODES = [
  'TODAY',
  'YESTERDAY',
  'WEEK',
  'MONTH',
  'YEAR',
  'CUSTOM',
] as const;
export const distributionPeriodCodeSchema = z.enum(DISTRIBUTION_PERIOD_CODES);
export type DistributionPeriodCode = z.infer<typeof distributionPeriodCodeSchema>;

export const distributionReplenishmentSchema = z.object({
  minQty: qty,
  targetQty: qty,
  availableQty: qty,
  inTransitInQty: qty,
  state: z.enum(['OK', 'STOCK_LOW', 'STOCK_OUT']),
  suggestedQty: qty,
});

/** Une ligne PDV × produit. Les champs de stock valent `null` pour un produit `SERVICE` (INV-VEN-08). */
export const distributionProductRowSchema = z.object({
  productId: uuid,
  productCode: z.string().min(1).max(40),
  productName: z.string().min(1).max(200),
  baseUnitCode: z.string().min(1).max(20),
  stocked: z.boolean(),
  // Période (KPI-DIS-01 à 05).
  /** KPI-DIS-01 : envoyé vers le PDV, net des retours à la source à leur date (AV-199). */
  sentQty: qty.nullable(),
  /** KPI-DIS-02 : reçu (requalifications et marchandise d'un écart rejeté comprises). */
  receivedQty: qty.nullable(),
  /** KPI-DIS-03 : vendu net (registre pour un produit stocké, ventes pour un service). */
  soldNetQty: qty,
  /** Montant net des lignes vendues (prix de vente, non masqué). */
  soldNetXaf: xaf,
  /** KPI-DIS-04 : perdu à l'emplacement + écarts de transfert confirmés (AV-164). */
  lostQty: qty.nullable(),
  lostPendingQty: qty.nullable(),
  /** Écarts de transfert constatés et non encore tranchés sur la période. */
  transitPendingQty: qty.nullable(),
  openingQty: qty.nullable(),
  /** KPI-DIS-05 : restant, solde à la fin de la période. */
  remainingQty: qty.nullable(),
  // Instant de lecture.
  toDeliverQty: qty,
  allocatedQty: qty.nullable(),
  unallocatedQty: qty.nullable(),
  overcommitted: z.boolean().nullable(),
  /** KPI-DIS-07 : `null` sans seuil actif. */
  replenish: distributionReplenishmentSchema.nullable(),
  // Mesures de valeur (RC-05) : `null` sans `inventory.valuation.read` sur le site.
  remainingValueXaf: xaf.nullable(),
  lostValueXaf: xaf.nullable(),
  /** Identité de rapprochement (AV-199) ; `null` pour un service. */
  reconciliation: z
    .object({
      residualQty: qty,
      reconciled: z.boolean(),
      /** Le vendu de `sales` égale le vendu net du registre. */
      salesMatchLedger: z.boolean(),
    })
    .nullable(),
});
export type DistributionProductRow = z.infer<typeof distributionProductRowSchema>;

export const distributionCashSessionSchema = z.object({
  status: z.string().min(1).max(30),
  businessDate: day,
  openedAt: instant,
  closedAt: instant.nullable(),
  varianceXaf: xaf.nullable(),
  currentVarianceXaf: xaf.nullable(),
  forceClosed: z.boolean(),
  /** Gravité de l'écart courant (`finance.cash_variance_*`). */
  severity: z.enum(['NONE', 'WARNING', 'CRITICAL']),
  /** Session ouverte depuis plus de `finance.cash_session_force_close_hours`. */
  openLong: z.boolean(),
  /** Détail sous `finance.cash.read` (AV-205). */
  detail: z.object({ sessionId: uuid, openedByUserId: uuid }).nullable(),
});
export type DistributionCashSession = z.infer<typeof distributionCashSessionSchema>;

export const distributionDeviceSchema = z.object({
  deviceId: uuid,
  shortCode: z.string().min(1).max(20),
  label: z.string().max(200).nullable(),
  status: z.string().min(1).max(20),
  isShared: z.boolean(),
  lastContactAt: instant.nullable(),
  stale: z.boolean(),
  pendingReported: count.nullable(),
  /** Par auteur, sous `sync.monitor.read` (AV-205). */
  authors: z
    .array(
      z.object({
        userId: uuid,
        lastPushAt: instant.nullable(),
        lastPullAt: instant.nullable(),
        pendingReported: count.nullable(),
      }),
    )
    .nullable(),
});
export type DistributionDevice = z.infer<typeof distributionDeviceSchema>;

export const distributionPointOfSaleSchema = z.object({
  siteId: uuid,
  siteCode: z.string().min(1).max(40),
  siteName: z.string().min(1).max(200),
  siteStatus: z.string().min(1).max(20),
  zoneId: uuid,
  salesLocationId: uuid,
  custodyMode: z.enum(['SHARED', 'EXCLUSIVE_DEVICE']),
  products: z.array(distributionProductRowSchema),
  /** Ventes du PDV en XAF, services compris. */
  sales: z.object({ soldXaf: xaf, cancelledXaf: xaf, netXaf: xaf }),
  /** KPI-DIS-06 : encaissé du site, tous moyens (ADR-032 §9 ; AV-200). */
  cashed: z.object({
    amountXaf: xaf,
    paymentsCount: count,
    byMethod: z.array(
      z.object({
        paymentMethodCode: z.string().min(1).max(40),
        amountXaf: xaf,
        paymentsCount: count,
      }),
    ),
    /** Sous `sales.payment.read` (AV-205). */
    byReceiver: z
      .array(
        z.object({
          userId: uuid,
          fullName: z.string().max(200).nullable(),
          amountXaf: xaf,
          paymentsCount: count,
        }),
      )
      .nullable(),
  }),
  cash: z.object({
    accountsCount: count,
    openSession: distributionCashSessionSchema.nullable(),
    sessionOfDay: distributionCashSessionSchema.nullable(),
    pendingValidationCount: count,
    pendingAdjustmentsCount: count,
    transfers: z.object({
      inTransitCount: count,
      inTransitXaf: xaf,
      overdueCount: count,
      discrepancyCount: count,
    }),
  }),
  devices: z.object({
    count,
    staleCount: count,
    lastContactAt: instant.nullable(),
    items: z.array(distributionDeviceSchema),
  }),
  /** Toutes les lignes stockées se rapprochent du registre (identité et ventes). */
  reconciled: z.boolean(),
});
export type DistributionPointOfSale = z.infer<typeof distributionPointOfSaleSchema>;

export const distributionDashboardResponseSchema = z.object({
  /** Instant du calcul (BR-ANA-005). */
  generatedAt: instant,
  businessDay: day,
  period: z.object({ code: distributionPeriodCodeSchema, fromDay: day, toDay: day }),
  scope: z.object({ allSites: z.boolean(), pointsOfSaleCount: count }),
  /** BR-ANA-005 : appareils des PDV du périmètre sans contact depuis plus du seuil. */
  freshness: z.object({
    warningHours: z.number().positive(),
    devicesCount: count,
    staleDevices: count,
  }),
  totals: z.object({
    soldNetXaf: xaf,
    cashedXaf: xaf,
    paymentsCount: count,
    /** `null` dès qu'une ligne est masquée : jamais un total partiel. */
    remainingValueXaf: xaf.nullable(),
    lostValueXaf: xaf.nullable(),
    cashSessionsToValidate: count,
    cashAdjustmentsToValidate: count,
    cashTransfers: z.object({
      inTransitCount: count,
      inTransitXaf: xaf,
      overdueCount: count,
      overdueXaf: xaf,
      discrepancyCount: count,
      unreceivedHours: z.number().positive(),
    }),
  }),
  /** Totaux par produit, tous PDV du périmètre ; jamais entre produits. */
  products: z.array(
    z.object({
      productId: uuid,
      productCode: z.string().min(1).max(40),
      baseUnitCode: z.string().min(1).max(20),
      stocked: z.boolean(),
      sentQty: qty,
      receivedQty: qty,
      soldNetQty: qty,
      lostQty: qty,
      remainingQty: qty,
      toDeliverQty: qty,
    }),
  ),
  pointsOfSale: z.array(distributionPointOfSaleSchema),
});
export type DistributionDashboardResponse = z.infer<typeof distributionDashboardResponseSchema>;
