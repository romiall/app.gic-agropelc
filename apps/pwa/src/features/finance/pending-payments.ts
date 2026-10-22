/**
 * Paiements d'un fournisseur en attente de la Direction avec leurs affectations prévues : lus pour le
 * formulaire de paiement (P8E-06) et pour l'affectation d'une avance (revue de P8E-10).
 */
import { readPages, readPath, type ReadResult } from '../sales/online-read.js';
import type { SupplierPaymentItem } from '../treasury/treasury.js';
import {
  PAYMENT_MAX_PAGES,
  PAYMENT_PAGE_LIMIT,
  type SupplierPaymentDetail,
} from './supplier-payment.js';

/** Détails lus des paiements en attente d'un fournisseur (au-delà : seul le total est connu). */
const PENDING_DETAILS_MAX = 20;

export interface PendingRead {
  readonly payments: readonly SupplierPaymentItem[];
  readonly details: readonly SupplierPaymentDetail[];
}

/** Lecture des paiements en attente d'un fournisseur (partagée avec l'affectation d'une avance). */
export const pendingPaymentsPath = (supplierId: string) =>
  `/api/v1/supplier-payments?status=PENDING_APPROVAL&limit=${PAYMENT_PAGE_LIMIT}&supplier_id=${supplierId}`;

/** Paiements du fournisseur en attente de la Direction, avec leurs affectations prévues. */
export async function readPending(path: string): Promise<ReadResult<PendingRead>> {
  const list = await readPages<SupplierPaymentItem>([path], 'supplier_payments', PAYMENT_MAX_PAGES);
  if (!list.ok) return list;
  const details: SupplierPaymentDetail[] = [];
  for (const payment of list.data.items.slice(0, PENDING_DETAILS_MAX)) {
    const read = await readPath<{ readonly supplier_payment: SupplierPaymentDetail }>(
      `/api/v1/supplier-payments/${payment.id}`,
    );
    if (!read.ok) return read;
    details.push(read.data.supplier_payment);
  }
  return { ok: true, data: { payments: list.data.items, details } };
}
