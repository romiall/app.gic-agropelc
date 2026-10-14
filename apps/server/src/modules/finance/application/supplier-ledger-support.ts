/**
 * Utilitaires internes des factures et paiements fournisseurs (P8 ; ADR-043 ; SM-SUPPLIER-INVOICE,
 * SM-SUPPLIER-PAYMENT ; D09 §7.4, §17), partagés par les commandes et les décisions
 * `INVOICE_MISMATCH` et `SUPPLIER_PAYMENT`.
 *
 * - Numérotation `FF` et `PF` (ADR-043 §10) : série globale de code `finance.supplier_series_code`
 *   (validé comme celui des remises, `SIEGE` par défaut), compteur clé par le code.
 * - Approbation d'une facture (factorisée entre la façade `finance.supplier_invoice.approve` et la
 *   décision `INVOICE_MISMATCH`) : statut `APPROVED`, quantités facturées écrites par `procurement`.
 */
import type { Transaction } from 'kysely';
import {
  businessDayOf,
  cashTransferSeriesCodeFrom,
  quantityFromDecimal,
  quantityToDecimal,
  invoicedQuantitiesByOrderLine,
  matchSupplierInvoice,
  quantityExcessSince,
  supplierInvoiceStatusFromPaid,
  supplierInvoiceTransition,
  type IdGenerator,
  type InvoiceMismatchDetail,
  type SupplierInvoiceStatus,
} from '@gic/domain';
import { sql } from 'kysely';
import type { DB } from '../../../platform/kysely/database.js';
import type { DocumentSequenceService } from '../../../platform/document-sequences/document-sequence.service.js';
import { jsonValue } from '../../../platform/kysely/json-value.js';
import { fromBin, fromBinOrNull, toBin } from '../../../platform/kysely/uuid-columns.js';
import { currentSettingValue } from '../../organization/application/public/index.js';
import {
  currentPolicies,
  type ActiveControlPolicy,
} from '../../approvals/application/public/index.js';
import {
  applyInvoicedQuantities,
  lockOrderForInvoicing,
} from '../../procurement/application/public/index.js';
import { cashTransferCounterKey } from './cash-transfer-support.js';

type Uow = Transaction<DB>;

export const SUPPLIER_INVOICE_DOC_TYPE = 'FF';
export const SUPPLIER_PAYMENT_DOC_TYPE = 'PF';
export const INVOICE_RECORD_PERMISSION = 'finance.supplier_invoice.record';
export const INVOICE_APPROVE_PERMISSION = 'finance.supplier_invoice.approve';
export const PAYMENT_RECORD_PERMISSION = 'finance.supplier_payment.record';
export const PAYMENT_APPROVE_PERMISSION = 'finance.supplier_payment.approve';

export async function settingAt(uow: Uow, key: string, at: Date): Promise<unknown> {
  return currentSettingValue(uow, { key, scopeType: 'GLOBAL', scopeId: null, at });
}

export async function numberSettingAt(
  uow: Uow,
  key: string,
  at: Date,
  fallback: number,
): Promise<number> {
  const value = await settingAt(uow, key, at);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Numéro `FF-{CODE}-{AAAA}-{seq6}` ou `PF-…` sur la série globale (ADR-043 §10). */
export async function nextSupplierDocNumber(
  uow: Uow,
  documentSequences: DocumentSequenceService,
  input: { readonly docType: 'FF' | 'PF'; readonly at: Date },
): Promise<string> {
  const code = cashTransferSeriesCodeFrom(
    await settingAt(uow, 'finance.supplier_series_code', input.at),
  );
  return documentSequences.next(uow, {
    docType: input.docType,
    siteId: cashTransferCounterKey(code),
    codeSite: code,
    year: Number(businessDayOf(input.at).slice(0, 4)),
  });
}

/** Politique applicable d'un type : la plus récente qui exige une validation et nomme un approbateur. */
export async function decisionPolicy(
  uow: Uow,
  operationType: 'INVOICE_MISMATCH' | 'SUPPLIER_PAYMENT',
  at: Date,
): Promise<ActiveControlPolicy | undefined> {
  return (await currentPolicies(uow, operationType, at)).find(
    (policy) => policy.requiresApproval && policy.approverPermission !== null,
  );
}

export interface SupplierInvoiceRow {
  readonly id: string;
  readonly docNumber: string;
  readonly supplierId: string;
  readonly supplierInvoiceRef: string;
  readonly purchaseOrderId: string | null;
  readonly totalXaf: number;
  readonly paidXaf: number;
  readonly status: SupplierInvoiceStatus;
  readonly approvalRequestId: string | null;
  readonly approvedAt: Date | null;
  readonly createdBy: string;
}

export async function loadSupplierInvoice(
  uow: Uow,
  invoiceId: string,
  options: { readonly lock?: 'update' } = {},
): Promise<SupplierInvoiceRow | undefined> {
  let query = uow
    .selectFrom('finance_supplier_invoices')
    .select([
      'id',
      'doc_number',
      'supplier_id',
      'supplier_invoice_ref',
      'purchase_order_id',
      'total_xaf',
      'paid_xaf',
      'status',
      'approval_request_id',
      'approved_at',
      'created_by',
    ])
    .where('id', '=', toBin(invoiceId));
  if (options.lock === 'update') query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (!row) return undefined;
  return {
    id: fromBin(row.id),
    docNumber: row.doc_number,
    supplierId: fromBin(row.supplier_id),
    supplierInvoiceRef: row.supplier_invoice_ref,
    purchaseOrderId: fromBinOrNull(row.purchase_order_id),
    totalXaf: Number(row.total_xaf),
    paidXaf: Number(row.paid_xaf),
    status: row.status as SupplierInvoiceStatus,
    approvalRequestId: fromBinOrNull(row.approval_request_id),
    approvedAt: row.approved_at,
    createdBy: fromBin(row.created_by),
  };
}

/** Quantités d'une facture par ligne de BC (lignes rattachées et chiffrées). */
export async function invoiceOrderQuantities(
  uow: Uow,
  invoiceId: string,
): Promise<ReadonlyMap<string, number>> {
  const lines = await uow
    .selectFrom('finance_supplier_invoice_lines')
    .select(['po_line_id', 'quantity_base', 'line_total_xaf'])
    .where('invoice_id', '=', toBin(invoiceId))
    .execute();
  const byLine = invoicedQuantitiesByOrderLine(
    lines.map((line) => ({
      poLineId: fromBinOrNull(line.po_line_id),
      quantity:
        line.quantity_base === null ? null : quantityFromDecimal(Number(line.quantity_base)),
      unitPriceXaf: null,
      lineTotalXaf: Number(line.line_total_xaf),
    })),
  );
  return new Map(
    [...byLine].map(([poLineId, quantity]) => [poLineId, quantityToDecimal(quantity)]),
  );
}

/**
 * Applique (+1) ou retire (−1) les quantités facturées d'une facture rattachée à un BC : BC verrouillé
 * puis écriture par `procurement` (ADR-043 §3).
 */
export async function applyInvoiceQuantities(
  uow: Uow,
  invoice: SupplierInvoiceRow,
  sign: 1 | -1,
): Promise<void> {
  if (invoice.purchaseOrderId === null) return;
  const quantities = await invoiceOrderQuantities(uow, invoice.id);
  if (quantities.size === 0) return;
  await lockOrderForInvoicing(uow, invoice.purchaseOrderId);
  await applyInvoicedQuantities(uow, {
    orderId: invoice.purchaseOrderId,
    lines: [...quantities].map(([poLineId, quantity]) => ({
      poLineId,
      deltaBase: sign * quantity,
    })),
  });
}

/** Événement nommé d'une facture ou d'un paiement fournisseur (D09 §10 ; outbox, ADR-011). */
export async function insertSupplierEvent(
  uow: Uow,
  idGenerator: IdGenerator,
  input: {
    readonly eventType: string;
    readonly aggregateType: 'SUPPLIER_INVOICE' | 'SUPPLIER_PAYMENT';
    readonly aggregateId: string;
    readonly occurredAt: Date;
    readonly commandId: string | null;
    readonly payload: Record<string, unknown>;
  },
): Promise<void> {
  await uow
    .insertInto('platform_domain_events')
    .values({
      event_id: toBin(idGenerator.newId()),
      event_type: input.eventType,
      producer_module: 'finance',
      aggregate_type: input.aggregateType,
      aggregate_id: toBin(input.aggregateId),
      occurred_at: input.occurredAt,
      payload: jsonValue(input.payload),
      ...(input.commandId !== null ? { command_id: toBin(input.commandId) } : {}),
    })
    .execute();
}

/**
 * Approbation d'une facture en écart ou contestée (SM-SUPPLIER-INVOICE) : `APPROVED`, dette = montant
 * facturé, quantités facturées appliquées. Partagée par la façade et la décision `INVOICE_MISMATCH`.
 * La facture est déjà verrouillée par l'appelant.
 */
export async function approveSupplierInvoice(
  uow: Uow,
  idGenerator: IdGenerator,
  input: {
    readonly invoice: SupplierInvoiceRow;
    readonly approvedBy: string;
    readonly approvedAt: Date;
    readonly reason: string;
    readonly commandId: string | null;
  },
): Promise<void> {
  const { invoice } = input;
  const next = supplierInvoiceTransition(invoice.status, 'APPROVE', invoice.paidXaf);
  await uow
    .updateTable('finance_supplier_invoices')
    .set({
      status: next,
      approved_by: toBin(input.approvedBy),
      approved_at: input.approvedAt,
      approval_reason: input.reason,
      updated_by: toBin(input.approvedBy),
      version: sql`version + 1`,
    })
    .where('id', '=', toBin(invoice.id))
    .execute();
  await applyInvoiceQuantities(uow, invoice, 1);
  await insertSupplierEvent(uow, idGenerator, {
    eventType: 'SupplierInvoiceApproved',
    aggregateType: 'SUPPLIER_INVOICE',
    aggregateId: invoice.id,
    occurredAt: input.approvedAt,
    commandId: input.commandId,
    payload: {
      docNumber: invoice.docNumber,
      totalXaf: invoice.totalXaf,
      approvedBy: input.approvedBy,
    },
  });
}

/**
 * Revue de P8-14 (ADR-043 §3, AV-274) : lignes de BC dont l'approbation de cette facture porterait le
 * facturé au-delà de l'accepté sans que l'écart de la demande le dise — une autre facture des mêmes
 * lignes a été approuvée depuis la saisie. Rapprochement refait sous le verrou du BC, aux tolérances
 * en vigueur à la décision.
 */
export async function quantityExcessSinceRequest(
  uow: Uow,
  invoice: SupplierInvoiceRow,
  at: Date,
): Promise<readonly string[]> {
  if (invoice.purchaseOrderId === null) return [];
  const order = await lockOrderForInvoicing(uow, invoice.purchaseOrderId);
  if (!order) return [];
  const stored = await uow
    .selectFrom('finance_supplier_invoices')
    .select('mismatch_details')
    .where('id', '=', toBin(invoice.id))
    .executeTakeFirstOrThrow();
  const raw: unknown = stored.mismatch_details;
  const recorded = (typeof raw === 'string' ? JSON.parse(raw) : (raw ?? [])) as
    readonly InvoiceMismatchDetail[];
  const lines = await uow
    .selectFrom('finance_supplier_invoice_lines')
    .select(['po_line_id', 'quantity_base', 'unit_price_xaf', 'line_total_xaf'])
    .where('invoice_id', '=', toBin(invoice.id))
    .orderBy('line_no')
    .execute();
  const current = matchSupplierInvoice({
    supplierId: invoice.supplierId,
    order: {
      supplierId: order.supplierId,
      lines: order.lines.map((line) => ({
        poLineId: line.poLineId,
        unitPriceXaf: line.unitPriceXaf,
        accepted: quantityFromDecimal(line.acceptedQtyBase),
        invoiced: quantityFromDecimal(line.invoicedQtyBase),
      })),
    },
    lines: lines.map((line) => ({
      poLineId: fromBinOrNull(line.po_line_id),
      quantity:
        line.quantity_base === null ? null : quantityFromDecimal(Number(line.quantity_base)),
      unitPriceXaf: line.unit_price_xaf === null ? null : Number(line.unit_price_xaf),
      lineTotalXaf: Number(line.line_total_xaf),
    })),
    printedTotalXaf: null,
    qtyTolerancePct: await numberSettingAt(uow, 'finance.invoice_match_qty_tolerance_pct', at, 0),
    priceToleranceXaf: await numberSettingAt(uow, 'finance.invoice_match_price_tolerance_xaf', at, 0),
    withoutOrderMode: 'REVIEW',
  });
  return quantityExcessSince(recorded, current);
}

/** Contestation d'une facture en écart (`MISMATCH` → `DISPUTED`). Facture déjà verrouillée. */
export async function disputeSupplierInvoice(
  uow: Uow,
  input: {
    readonly invoice: SupplierInvoiceRow;
    readonly by: string;
    readonly at: Date;
    readonly reason: string;
  },
): Promise<void> {
  const next = supplierInvoiceTransition(input.invoice.status, 'DISPUTE', input.invoice.paidXaf);
  await uow
    .updateTable('finance_supplier_invoices')
    .set({
      status: next,
      disputed_by: toBin(input.by),
      disputed_at: input.at,
      dispute_reason: input.reason,
      updated_by: toBin(input.by),
      version: sql`version + 1`,
    })
    .where('id', '=', toBin(input.invoice.id))
    .execute();
}

/** Factures verrouillées par identifiant croissant (rang des documents, ADR-043 §9). */
export async function lockSupplierInvoices(
  uow: Uow,
  invoiceIds: readonly string[],
): Promise<ReadonlyMap<string, SupplierInvoiceRow>> {
  const locked = new Map<string, SupplierInvoiceRow>();
  // Ordre binaire de MySQL = ordre des chaînes en minuscules (revue de P8-14).
  for (const id of [...new Set(invoiceIds.map((value) => value.toLowerCase()))].sort()) {
    const invoice = await loadSupplierInvoice(uow, id, { lock: 'update' });
    if (invoice) locked.set(id, invoice);
  }
  return locked;
}

/**
 * Ajoute (affectation activée) ou retire (affectation contrepassée) un montant au payé d'une facture
 * déjà verrouillée ; statut recalculé (INV-FIN-07 : `supplierInvoiceStatusFromPaid` refuse un payé au-delà
 * du total).
 */
export async function adjustInvoicePaid(
  uow: Uow,
  input: { readonly invoice: SupplierInvoiceRow; readonly deltaXaf: number; readonly by: string },
): Promise<SupplierInvoiceRow> {
  const paidXaf = input.invoice.paidXaf + input.deltaXaf;
  const status = supplierInvoiceStatusFromPaid(input.invoice.totalXaf, paidXaf);
  await uow
    .updateTable('finance_supplier_invoices')
    .set({ paid_xaf: paidXaf, status, updated_by: toBin(input.by), version: sql`version + 1` })
    .where('id', '=', toBin(input.invoice.id))
    .execute();
  return { ...input.invoice, paidXaf, status };
}
