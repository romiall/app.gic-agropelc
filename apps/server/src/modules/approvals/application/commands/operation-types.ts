/**
 * `operation_type` (docs/03-data/dictionnaire/10-approvals-attachments-communication.md,
 * `approvals.control_policies`/`approvals.approval_requests`) : catalogue fermé, partagé par
 * les deux tables (CHECK identique dans les deux migrations). Un seul endroit pour ne pas
 * laisser diverger la liste entre les deux schémas zod qui la consomment.
 */
export const OPERATION_TYPES = [
  'LOSS_DECLARATION',
  'MORTALITY',
  'INVENTORY_ADJUSTMENT',
  'TRANSFER_DISCREPANCY',
  'EXPENSE',
  'PURCHASE_REQUEST',
  'PURCHASE_ORDER',
  'RECEIPT_WITHOUT_PO',
  'RECEIPT_VALUE',
  'SUPPLIER_PAYMENT',
  'PRICE_OVERRIDE',
  'SALE_CANCELLATION',
  'CREDIT_LIMIT_EXCEEDED',
  'CASH_VARIANCE',
  'CHECKIN_OVERRIDE',
  // P6-02 : réception en quarantaine (doublon suspecté, BR-APP-012) et annulation d'une
  // réception comptabilisée (BR-APP-013) — D08 §11.
  'RECEIPT_QUARANTINE',
  'RECEIPT_CANCELLATION',
  // P7-02 : écart d'inventaire portant sur des animaux, validé par le Resp. production (AV-108).
  'ANIMAL_COUNT_ADJUSTMENT',
] as const;

export type OperationType = (typeof OPERATION_TYPES)[number];
