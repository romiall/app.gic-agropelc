/**
 * Règles pures de l'alerte `APPROVAL_PENDING_LONG` (P9-09 ; D13 §7.1, SM-APPROVAL « délai de 24 h
 * dépassé », AV-358, AV-416) : une demande de validation en attente depuis au moins `approvals.
 * pending_long_hours` heures. Sans entrée-sortie ; aucune fonction ne lève.
 */

/** Repli du délai (D13 §7.1 : en attente depuis plus de 24 h). */
export const DEFAULT_APPROVAL_PENDING_LONG_HOURS = 24;

/** Plafond du délai (dix ans) : au-delà, l'instant de coupure ne serait plus une date valide. */
export const MAX_APPROVAL_PENDING_LONG_HOURS = 87_600;

/** `approvals.pending_long_hours` : un nombre fini strictement positif (plafonné), sinon 24. */
export function approvalPendingLongHoursOrDefault(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, MAX_APPROVAL_PENDING_LONG_HOURS)
    : DEFAULT_APPROVAL_PENDING_LONG_HOURS;
}

/** Heures entières d'attente depuis la réception par le serveur (jamais négatives). */
export function approvalPendingHours(createdAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / 3_600_000));
}

/**
 * Libellés français des types d'opération pour le message d'alerte (jamais le résumé de la demande, qui
 * peut porter une valeur au coût, RC-05). Alignés sur les libellés de la file de validation de la PWA ;
 * un type inconnu retombe sur son code.
 */
export const APPROVAL_OPERATION_LABELS: Readonly<Record<string, string>> = {
  LOSS_DECLARATION: 'Perte',
  MORTALITY: 'Mortalité',
  INVENTORY_ADJUSTMENT: 'Écart d’inventaire',
  ANIMAL_COUNT_ADJUSTMENT: 'Écart de comptage d’animaux',
  TRANSFER_DISCREPANCY: 'Écart de transfert',
  EXPENSE: 'Dépense',
  PURCHASE_REQUEST: 'Demande d’achat',
  PURCHASE_ORDER: 'Bon de commande',
  RECEIPT_WITHOUT_PO: 'Réception sans bon de commande',
  RECEIPT_VALUE: 'Valeur de réception',
  SUPPLIER_PAYMENT: 'Paiement fournisseur',
  PRICE_OVERRIDE: 'Remise au-delà du plafond',
  SALE_CANCELLATION: 'Annulation de vente',
  CREDIT_LIMIT_EXCEEDED: 'Dépassement d’encours',
  CASH_VARIANCE: 'Écart de caisse',
  CHECKIN_OVERRIDE: 'Dérogation de pointage',
  RECEIPT_QUARANTINE: 'Réception en quarantaine',
  RECEIPT_CANCELLATION: 'Annulation de réception',
  PAYMENT_CANCELLATION: 'Annulation d’encaissement',
  PAYMENT_DUPLICATE: 'Encaissement en double',
  CASH_TRANSFER_DISCREPANCY: 'Écart de remise de fonds',
  INVOICE_MISMATCH: 'Écart de facture fournisseur',
};

export function approvalOperationLabel(operationType: string): string {
  return APPROVAL_OPERATION_LABELS[operationType] ?? operationType;
}
