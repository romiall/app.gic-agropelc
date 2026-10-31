/**
 * Présentation des statuts du domaine achats (lot L7) : ton de la pastille. Aucune logique métier ici :
 * les statuts viennent des jeux et des lectures, leur libellé des clés de texte.
 */
import type { BadgeTone } from '../../components/ui/index.js';

/** Demande d'achat (`purchase_request.status.*`). */
export function requestStatusTone(status: string): BadgeTone {
  switch (status) {
    case 'APPROVED':
    case 'ORDERED':
      return 'ok';
    case 'SUBMITTED':
    case 'PARTIALLY_ORDERED':
      return 'info';
    case 'PENDING':
      return 'warn';
    case 'REJECTED':
      return 'bad';
    default:
      return 'muted';
  }
}

/** Bon de commande (`orders_po.status.*`, `purchase_receipt.order_status.*`). */
export function orderStatusTone(status: string): BadgeTone {
  switch (status) {
    case 'APPROVED':
    case 'RECEIVED':
      return 'ok';
    case 'SENT':
      return 'info';
    case 'PENDING_APPROVAL':
    case 'PARTIALLY_RECEIVED':
      return 'warn';
    default:
      return 'muted';
  }
}

/** Réception (`purchase_receipt.status.*`). */
export function receiptStatusTone(status: string): BadgeTone {
  switch (status) {
    case 'POSTED':
      return 'ok';
    case 'POSTED_PENDING_REVIEW':
    case 'QUARANTINED':
    case 'CANCELLATION_PENDING':
      return 'warn';
    case 'REJECTED':
    case 'REVIEW_REJECTED':
      return 'bad';
    default:
      return 'muted';
  }
}
