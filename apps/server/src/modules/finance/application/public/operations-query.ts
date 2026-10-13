/**
 * Lectures de la finance opérationnelle (P8-09 ; 08-api-events/01-architecture-api.md §4.9) :
 * dépenses, factures et paiements fournisseurs, dettes (`finance_v_payables`, KPI-FIN-05), payé d'un
 * bon de commande pour le rapprochement de P6 (composé dans `procurement-api`). Sans contrôle de
 * droit : la couche de transport (`finance-api/`) filtre par portée.
 *
 * Pagination par curseur (UUIDv7, du plus récent au plus ancien), `limit` ≤ 200 ; périodes en jours
 * métier de Douala, bornes fournies en UTC par l'appelant.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import { receivableAging, type AgingBucket } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

export const OPERATIONS_LIST_DEFAULT_LIMIT = 50;
export const OPERATIONS_LIST_MAX_LIMIT = 200;

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

const parsed = <T>(value: unknown): T | null =>
  value === null || value === undefined
    ? null
    : ((typeof value === 'string' ? JSON.parse(value) : value) as T);

function page<T extends { readonly id: string }>(rows: readonly T[], limit: number): Page<T> {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? items[items.length - 1]!.id : null };
}

// --- Dépenses ------------------------------------------------------------------------------------

export interface ExpenseSummary {
  readonly id: string;
  readonly docNumber: string;
  readonly siteId: string;
  readonly categoryId: string;
  readonly categoryCode: string;
  readonly categoryLabel: string;
  readonly amountXaf: number;
  readonly payeeName: string | null;
  readonly supplierId: string | null;
  readonly description: string;
  readonly costObjectType: string | null;
  readonly costObjectId: string | null;
  readonly speciesGroup: string | null;
  readonly paidNow: boolean;
  readonly paidFromAccountId: string | null;
  readonly paidAt: Date | null;
  readonly status: string;
  readonly reviewReasons: readonly string[];
  readonly approvalRequestId: string | null;
  readonly reclassifiedCategoryId: string | null;
  readonly responsibilityUserId: string | null;
  readonly cancelReason: string | null;
  readonly occurredAt: Date;
  readonly businessDate: string;
  readonly capturedOffline: boolean;
  readonly createdBy: string;
}

export interface ExpenseFilter {
  readonly fromUtc?: Date;
  readonly toUtc?: Date;
  readonly siteId?: string;
  readonly categoryId?: string;
  readonly status?: string;
  readonly costObjectId?: string;
  readonly createdBy?: string;
  readonly beforeId?: string;
  readonly limit: number;
}

function expenseQuery(executor: Executor) {
  return executor
    .selectFrom('finance_expenses as e')
    .innerJoin('finance_expense_categories as c', 'c.id', 'e.category_id')
    .select([
      'e.id as id',
      'e.doc_number as doc_number',
      'e.site_id as site_id',
      'e.category_id as category_id',
      'c.code as category_code',
      'c.label as category_label',
      'e.amount_xaf as amount_xaf',
      'e.payee_name as payee_name',
      'e.supplier_id as supplier_id',
      'e.description as description',
      'e.cost_object_type as cost_object_type',
      'e.cost_object_id as cost_object_id',
      'e.species_group as species_group',
      'e.paid_now as paid_now',
      'e.paid_from_account_id as paid_from_account_id',
      'e.paid_at as paid_at',
      'e.status as status',
      'e.review_reasons as review_reasons',
      'e.approval_request_id as approval_request_id',
      'e.reclassified_category_id as reclassified_category_id',
      'e.responsibility_user_id as responsibility_user_id',
      'e.cancel_reason as cancel_reason',
      'e.occurred_at as occurred_at',
      'e.business_date as business_date',
      'e.captured_offline as captured_offline',
      'e.created_by as created_by',
    ]);
}

type ExpenseRowOf = Awaited<ReturnType<ReturnType<typeof expenseQuery>['executeTakeFirstOrThrow']>>;

function expenseOf(row: ExpenseRowOf): ExpenseSummary {
  return {
    id: fromBin(row.id),
    docNumber: row.doc_number,
    siteId: fromBin(row.site_id),
    categoryId: fromBin(row.category_id),
    categoryCode: row.category_code,
    categoryLabel: row.category_label,
    amountXaf: Number(row.amount_xaf),
    payeeName: row.payee_name,
    supplierId: fromBinOrNull(row.supplier_id),
    description: row.description,
    costObjectType: row.cost_object_type,
    costObjectId: fromBinOrNull(row.cost_object_id),
    speciesGroup: row.species_group,
    paidNow: Boolean(row.paid_now),
    paidFromAccountId: fromBinOrNull(row.paid_from_account_id),
    paidAt: row.paid_at,
    status: row.status,
    reviewReasons: parsed<string[]>(row.review_reasons) ?? [],
    approvalRequestId: fromBinOrNull(row.approval_request_id),
    reclassifiedCategoryId: fromBinOrNull(row.reclassified_category_id),
    responsibilityUserId: fromBinOrNull(row.responsibility_user_id),
    cancelReason: row.cancel_reason,
    occurredAt: row.occurred_at,
    businessDate:
      row.business_date instanceof Date
        ? row.business_date.toISOString().slice(0, 10)
        : String(row.business_date),
    capturedOffline: Boolean(row.captured_offline),
    createdBy: fromBin(row.created_by),
  };
}

export async function listExpenses(
  executor: Executor,
  filter: ExpenseFilter,
): Promise<Page<ExpenseSummary>> {
  const rows = await expenseQuery(executor)
    .$if(filter.fromUtc !== undefined, (qb) => qb.where('e.occurred_at', '>=', filter.fromUtc!))
    .$if(filter.toUtc !== undefined, (qb) => qb.where('e.occurred_at', '<', filter.toUtc!))
    .$if(filter.siteId !== undefined, (qb) => qb.where('e.site_id', '=', toBin(filter.siteId!)))
    .$if(filter.categoryId !== undefined, (qb) =>
      qb.where('e.category_id', '=', toBin(filter.categoryId!)),
    )
    .$if(filter.status !== undefined, (qb) => qb.where('e.status', '=', filter.status!))
    .$if(filter.costObjectId !== undefined, (qb) =>
      qb.where('e.cost_object_id', '=', toBin(filter.costObjectId!)),
    )
    .$if(filter.createdBy !== undefined, (qb) =>
      qb.where('e.created_by', '=', toBin(filter.createdBy!)),
    )
    .$if(filter.beforeId !== undefined, (qb) => qb.where('e.id', '<', toBin(filter.beforeId!)))
    .orderBy('e.id', 'desc')
    .limit(filter.limit + 1)
    .execute();
  return page(rows.map(expenseOf), filter.limit);
}

export async function getExpense(
  executor: Executor,
  expenseId: string,
): Promise<ExpenseSummary | undefined> {
  const row = await expenseQuery(executor).where('e.id', '=', toBin(expenseId)).executeTakeFirst();
  return row ? expenseOf(row) : undefined;
}

// --- Factures fournisseurs -------------------------------------------------------------------------

export interface SupplierInvoiceSummary {
  readonly id: string;
  readonly docNumber: string;
  readonly siteId: string | null;
  readonly supplierId: string;
  readonly supplierInvoiceRef: string;
  readonly invoiceDate: string;
  readonly dueDate: string;
  readonly purchaseOrderId: string | null;
  readonly totalXaf: number;
  readonly printedTotalXaf: number | null;
  readonly paidXaf: number;
  readonly balanceXaf: number;
  readonly status: string;
  readonly mismatchDetails: readonly unknown[];
  readonly approvalRequestId: string | null;
  readonly approvedBy: string | null;
  readonly approvedAt: Date | null;
  readonly approvalReason: string | null;
  readonly disputeReason: string | null;
  readonly cancelReason: string | null;
  readonly occurredAt: Date;
  readonly createdBy: string;
}

export interface SupplierInvoiceLine {
  readonly lineNo: number;
  readonly poLineId: string | null;
  readonly receiptLineId: string | null;
  readonly productId: string | null;
  readonly description: string;
  readonly quantityBase: number | null;
  readonly unitPriceXaf: number | null;
  readonly lineTotalXaf: number;
}

export interface PaymentAllocationView {
  readonly paymentId: string;
  readonly invoiceId: string;
  readonly amountXaf: number;
  readonly status: string;
  readonly activatedAt: Date | null;
  readonly reversedAt: Date | null;
}

const day = (value: Date | string): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

function invoiceQuery(executor: Executor) {
  return executor.selectFrom('finance_supplier_invoices').selectAll();
}

type InvoiceRowOf = Awaited<ReturnType<ReturnType<typeof invoiceQuery>['executeTakeFirstOrThrow']>>;

function invoiceOf(row: InvoiceRowOf): SupplierInvoiceSummary {
  const totalXaf = Number(row.total_xaf);
  const paidXaf = Number(row.paid_xaf);
  return {
    id: fromBin(row.id),
    docNumber: row.doc_number,
    siteId: fromBinOrNull(row.site_id),
    supplierId: fromBin(row.supplier_id),
    supplierInvoiceRef: row.supplier_invoice_ref,
    invoiceDate: day(row.invoice_date),
    dueDate: day(row.due_date),
    purchaseOrderId: fromBinOrNull(row.purchase_order_id),
    totalXaf,
    printedTotalXaf: row.printed_total_xaf === null ? null : Number(row.printed_total_xaf),
    paidXaf,
    balanceXaf: row.status === 'CANCELLED' ? 0 : totalXaf - paidXaf,
    status: row.status,
    mismatchDetails: parsed<unknown[]>(row.mismatch_details) ?? [],
    approvalRequestId: fromBinOrNull(row.approval_request_id),
    approvedBy: fromBinOrNull(row.approved_by),
    approvedAt: row.approved_at,
    approvalReason: row.approval_reason,
    disputeReason: row.dispute_reason,
    cancelReason: row.cancel_reason,
    occurredAt: row.occurred_at,
    createdBy: fromBin(row.created_by),
  };
}

export async function listSupplierInvoices(
  executor: Executor,
  filter: {
    readonly supplierId?: string;
    readonly status?: string;
    readonly purchaseOrderId?: string;
    readonly beforeId?: string;
    readonly limit: number;
  },
): Promise<Page<SupplierInvoiceSummary>> {
  const rows = await invoiceQuery(executor)
    .$if(filter.supplierId !== undefined, (qb) =>
      qb.where('supplier_id', '=', toBin(filter.supplierId!)),
    )
    .$if(filter.status !== undefined, (qb) => qb.where('status', '=', filter.status!))
    .$if(filter.purchaseOrderId !== undefined, (qb) =>
      qb.where('purchase_order_id', '=', toBin(filter.purchaseOrderId!)),
    )
    .$if(filter.beforeId !== undefined, (qb) => qb.where('id', '<', toBin(filter.beforeId!)))
    .orderBy('id', 'desc')
    .limit(filter.limit + 1)
    .execute();
  return page(rows.map(invoiceOf), filter.limit);
}

async function allocationsWhere(
  executor: Executor,
  column: 'invoice_id' | 'payment_id',
  id: string,
): Promise<readonly PaymentAllocationView[]> {
  const rows = await executor
    .selectFrom('finance_supplier_payment_allocations')
    .select(['payment_id', 'invoice_id', 'amount_xaf', 'status', 'activated_at', 'reversed_at'])
    .where(column, '=', toBin(id))
    .orderBy('created_at')
    .execute();
  return rows.map((row) => ({
    paymentId: fromBin(row.payment_id),
    invoiceId: fromBin(row.invoice_id),
    amountXaf: Number(row.amount_xaf),
    status: row.status,
    activatedAt: row.activated_at,
    reversedAt: row.reversed_at,
  }));
}

export async function getSupplierInvoice(
  executor: Executor,
  invoiceId: string,
): Promise<
  | (SupplierInvoiceSummary & {
      readonly lines: readonly SupplierInvoiceLine[];
      readonly allocations: readonly PaymentAllocationView[];
    })
  | undefined
> {
  const row = await invoiceQuery(executor).where('id', '=', toBin(invoiceId)).executeTakeFirst();
  if (!row) return undefined;
  const lines = await executor
    .selectFrom('finance_supplier_invoice_lines')
    .selectAll()
    .where('invoice_id', '=', row.id)
    .orderBy('line_no')
    .execute();
  return {
    ...invoiceOf(row),
    lines: lines.map((line) => ({
      lineNo: line.line_no,
      poLineId: fromBinOrNull(line.po_line_id),
      receiptLineId: fromBinOrNull(line.receipt_line_id),
      productId: fromBinOrNull(line.product_id),
      description: line.description,
      quantityBase: line.quantity_base === null ? null : Number(line.quantity_base),
      unitPriceXaf: line.unit_price_xaf === null ? null : Number(line.unit_price_xaf),
      lineTotalXaf: Number(line.line_total_xaf),
    })),
    allocations: await allocationsWhere(executor, 'invoice_id', invoiceId),
  };
}

// --- Paiements fournisseurs ------------------------------------------------------------------------

export interface SupplierPaymentSummary {
  readonly id: string;
  readonly docNumber: string;
  readonly supplierId: string;
  readonly amountXaf: number;
  readonly paymentMethodCode: string;
  readonly fromAccountId: string;
  readonly externalReference: string | null;
  readonly status: string;
  readonly unallocatedXaf: number;
  readonly disbursedAt: Date | null;
  readonly approvalRequestId: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
  readonly cancelReason: string | null;
  readonly occurredAt: Date;
  readonly createdBy: string;
}

function paymentQuery(executor: Executor) {
  return executor.selectFrom('finance_supplier_payments').selectAll();
}

type PaymentRowOf = Awaited<ReturnType<ReturnType<typeof paymentQuery>['executeTakeFirstOrThrow']>>;

function paymentOf(row: PaymentRowOf): SupplierPaymentSummary {
  return {
    id: fromBin(row.id),
    docNumber: row.doc_number,
    supplierId: fromBin(row.supplier_id),
    amountXaf: Number(row.amount_xaf),
    paymentMethodCode: row.payment_method_code,
    fromAccountId: fromBin(row.from_account_id),
    externalReference: row.external_reference,
    status: row.status,
    unallocatedXaf: Number(row.unallocated_xaf),
    disbursedAt: row.disbursed_at,
    approvalRequestId: fromBinOrNull(row.approval_request_id),
    decidedBy: fromBinOrNull(row.decided_by),
    decidedAt: row.decided_at,
    cancelReason: row.cancel_reason,
    occurredAt: row.occurred_at,
    createdBy: fromBin(row.created_by),
  };
}

export async function listSupplierPayments(
  executor: Executor,
  filter: {
    readonly supplierId?: string;
    readonly status?: string;
    readonly beforeId?: string;
    readonly limit: number;
  },
): Promise<Page<SupplierPaymentSummary>> {
  const rows = await paymentQuery(executor)
    .$if(filter.supplierId !== undefined, (qb) =>
      qb.where('supplier_id', '=', toBin(filter.supplierId!)),
    )
    .$if(filter.status !== undefined, (qb) => qb.where('status', '=', filter.status!))
    .$if(filter.beforeId !== undefined, (qb) => qb.where('id', '<', toBin(filter.beforeId!)))
    .orderBy('id', 'desc')
    .limit(filter.limit + 1)
    .execute();
  return page(rows.map(paymentOf), filter.limit);
}

export async function getSupplierPayment(
  executor: Executor,
  paymentId: string,
): Promise<
  (SupplierPaymentSummary & { readonly allocations: readonly PaymentAllocationView[] }) | undefined
> {
  const row = await paymentQuery(executor).where('id', '=', toBin(paymentId)).executeTakeFirst();
  if (!row) return undefined;
  return {
    ...paymentOf(row),
    allocations: await allocationsWhere(executor, 'payment_id', paymentId),
  };
}

// --- Dettes (KPI-FIN-05) ---------------------------------------------------------------------------

export interface PayableLine {
  readonly invoiceId: string;
  readonly docNumber: string;
  readonly supplierInvoiceRef: string;
  readonly invoiceDate: string;
  readonly dueDate: string;
  readonly totalXaf: number;
  readonly paidXaf: number;
  readonly balanceXaf: number;
  readonly daysOverdue: number;
  readonly overdue: boolean;
  readonly bucket: AgingBucket;
}

export interface SupplierPayables {
  readonly supplierId: string;
  readonly balanceXaf: number;
  readonly overdueXaf: number;
  readonly advanceXaf: number;
  /** Dette nette des avances (BR-FIN-032 : un paiement non affecté est une avance). */
  readonly netXaf: number;
  readonly buckets: Readonly<Record<AgingBucket, number>>;
  readonly invoices: readonly PayableLine[];
}

/**
 * Dettes par fournisseur (BR-FIN-032, KPI-FIN-05) : factures de `finance_v_payables`, ancienneté au
 * jour métier `today` (`receivableAging`, mêmes tranches que les créances, AV-360), avances des
 * paiements décaissés non affectés.
 */
export async function supplierPayables(
  executor: Executor,
  filter: { readonly supplierId?: string; readonly today: string },
): Promise<readonly SupplierPayables[]> {
  const rows = await executor
    .selectFrom('finance_v_payables as v')
    .innerJoin('finance_supplier_invoices as i', 'i.id', 'v.invoice_id')
    .select([
      'v.supplier_id as supplier_id',
      'v.invoice_id as invoice_id',
      'v.doc_number as doc_number',
      'v.supplier_invoice_ref as supplier_invoice_ref',
      'v.invoice_date as invoice_date',
      'v.due_date as due_date',
      'v.total_xaf as total_xaf',
      'v.paid_xaf as paid_xaf',
      'v.balance_xaf as balance_xaf',
    ])
    .$if(filter.supplierId !== undefined, (qb) =>
      qb.where('v.supplier_id', '=', toBin(filter.supplierId!)),
    )
    .orderBy('v.due_date')
    .execute();
  const advances = await executor
    .selectFrom('finance_supplier_payments')
    .select(['supplier_id', sql<string>`SUM(unallocated_xaf)`.as('advance')])
    .where('status', '=', 'RECORDED')
    .where('unallocated_xaf', '>', 0)
    .$if(filter.supplierId !== undefined, (qb) =>
      qb.where('supplier_id', '=', toBin(filter.supplierId!)),
    )
    .groupBy('supplier_id')
    .execute();
  const bySupplier = new Map<string, SupplierPayables & { invoices: PayableLine[] }>();
  const entry = (supplierId: string) => {
    let current = bySupplier.get(supplierId);
    if (!current) {
      current = {
        supplierId,
        balanceXaf: 0,
        overdueXaf: 0,
        advanceXaf: 0,
        netXaf: 0,
        buckets: { '0-30': 0, '31-60': 0, '61-90': 0, '>90': 0 },
        invoices: [],
      };
      bySupplier.set(supplierId, current);
    }
    return current;
  };
  for (const row of rows) {
    const supplierId = fromBin(row.supplier_id);
    const dueDate = day(row.due_date);
    const aging = receivableAging(dueDate, filter.today);
    const balanceXaf = Number(row.balance_xaf);
    const current = entry(supplierId);
    current.invoices.push({
      invoiceId: fromBin(row.invoice_id),
      docNumber: row.doc_number,
      supplierInvoiceRef: row.supplier_invoice_ref,
      invoiceDate: day(row.invoice_date),
      dueDate,
      totalXaf: Number(row.total_xaf),
      paidXaf: Number(row.paid_xaf),
      balanceXaf,
      daysOverdue: aging.daysOverdue,
      overdue: aging.overdue,
      bucket: aging.bucket,
    });
    bySupplier.set(supplierId, {
      ...current,
      balanceXaf: current.balanceXaf + balanceXaf,
      overdueXaf: current.overdueXaf + (aging.overdue ? balanceXaf : 0),
      buckets: { ...current.buckets, [aging.bucket]: current.buckets[aging.bucket] + balanceXaf },
    });
  }
  for (const advance of advances) {
    const supplierId = fromBin(advance.supplier_id);
    const current = entry(supplierId);
    bySupplier.set(supplierId, { ...current, advanceXaf: Number(advance.advance) });
  }
  return [...bySupplier.values()]
    .map((supplier) => ({ ...supplier, netXaf: supplier.balanceXaf - supplier.advanceXaf }))
    .sort((a, b) => b.balanceXaf - a.balanceXaf || a.supplierId.localeCompare(b.supplierId));
}

/** Payé d'un bon de commande : Σ affectations actives des factures non annulées de ce BC. */
export async function paidXafOfPurchaseOrder(
  executor: Executor,
  purchaseOrderId: string,
): Promise<number> {
  const row = await executor
    .selectFrom('finance_supplier_payment_allocations as a')
    .innerJoin('finance_supplier_invoices as i', 'i.id', 'a.invoice_id')
    .select(sql<string>`COALESCE(SUM(a.amount_xaf), 0)`.as('paid'))
    .where('i.purchase_order_id', '=', toBin(purchaseOrderId))
    .where('a.status', '=', 'ACTIVE')
    .executeTakeFirstOrThrow();
  return Number(row.paid);
}

export interface ExpensesSummary {
  /** KPI-FIN-04 : Σ dépenses valides de la période (enregistrées sans validation, approuvées, payées). */
  readonly totalXaf: number;
  readonly count: number;
  readonly byCategory: readonly {
    readonly code: string;
    readonly label: string;
    readonly amountXaf: number;
    readonly count: number;
  }[];
  /** En attente de validation (à payer ou déjà payées). */
  readonly pendingXaf: number;
  /** Payées puis rejetées : reclassées non justifiées, imputées au déclarant (AV-355). */
  readonly unjustifiedXaf: number;
}

/** Dépenses d'une période, par catégorie (KPI-FIN-04), datées de leur `occurred_at`. */
export async function expensesSummary(
  executor: Executor,
  period: { readonly fromUtc: Date; readonly toUtc: Date },
): Promise<ExpensesSummary> {
  const rows = await executor
    .selectFrom('finance_expenses as e')
    .innerJoin('finance_expense_categories as c', 'c.id', 'e.category_id')
    .select([
      'c.code as code',
      'c.label as label',
      'e.status as status',
      sql<string>`SUM(e.amount_xaf)`.as('amount'),
      sql<string>`COUNT(*)`.as('count'),
    ])
    .where('e.occurred_at', '>=', period.fromUtc)
    .where('e.occurred_at', '<', period.toUtc)
    .groupBy(['c.code', 'c.label', 'e.status'])
    .execute();
  const valid = new Set(['RECORDED', 'APPROVED', 'PAID']);
  const byCategory = new Map<
    string,
    { code: string; label: string; amountXaf: number; count: number }
  >();
  let pendingXaf = 0;
  let unjustifiedXaf = 0;
  for (const row of rows) {
    const amount = Number(row.amount);
    if (valid.has(row.status)) {
      const current = byCategory.get(row.code) ?? {
        code: row.code,
        label: row.label,
        amountXaf: 0,
        count: 0,
      };
      byCategory.set(row.code, {
        ...current,
        amountXaf: current.amountXaf + amount,
        count: current.count + Number(row.count),
      });
    } else if (row.status === 'PENDING_APPROVAL' || row.status === 'PAID_PENDING_APPROVAL') {
      pendingXaf += amount;
    } else if (row.status === 'PAID_REJECTED') {
      unjustifiedXaf += amount;
    }
  }
  const categories = [...byCategory.values()].sort(
    (a, b) => b.amountXaf - a.amountXaf || a.code.localeCompare(b.code),
  );
  return {
    totalXaf: categories.reduce((sum, line) => sum + line.amountXaf, 0),
    count: categories.reduce((sum, line) => sum + line.count, 0),
    byCategory: categories,
    pendingXaf,
    unjustifiedXaf,
  };
}
