/**
 * Lectures HTTP de la finance opérationnelle (P8-09 ; 08-api-events/01-architecture-api.md §4.9 ;
 * ADR-042, ADR-043 ; AV-278) : `GET /expenses`, `/expenses/{id}`, `/supplier-invoices`,
 * `/supplier-invoices/{id}`, `/supplier-payments`, `/supplier-payments/{id}`, `/payables`.
 *
 * - Dépenses : `finance.expense.read` (01-rbac.md §5.5 : Direction, Finance, Resp. production, Resp.
 *   achats `ALL` ; Resp. commercial `TEAM` ; vendeur et Resp. ferme `SITE` ; commerciaux et magasinier
 *   `OWN`). Portée : site de la dépense, propriété de son auteur. Hors portée : absente de la liste, ou
 *   404 audité pour le détail ; droit absent : 403 audité.
 * - Factures, paiements, dettes : `finance.payable.read` (Direction, Resp. achats, Finance ; `ALL`,
 *   AV-278).
 * - Listes paginées par curseur (UUIDv7, du plus récent au plus ancien) ; périodes en jours métier
 *   (une date impossible donne 400). La liste des dépenses est pré-filtrée par le périmètre du lecteur
 *   (`ReadAccess.confinement` : sites, auteurs) avant la pagination, puis affinée élément par élément
 *   (revue de P8-14 : une page ne doit pas être vide parce que les plus récentes sont hors portée).
 * - Pièces d'une dépense (P8E-03, ADR-047 §3) : chaque dépense rendue porte ses pièces (`attachments` :
 *   identifiant, nature, état d'envoi), que son lecteur ouvre par `GET /attachments/{id}/content`. Seules
 *   celles de l'auteur de la dépense sont rendues : la photo d'un tiers ne passe pas pour son justificatif
 *   (revue de P8E-03).
 */
import { Controller, Get, HttpCode, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import {
  EXPENSE_STATUSES,
  SUPPLIER_INVOICE_STATUSES,
  SUPPLIER_PAYMENT_STATUSES,
  businessDayEndUtc,
  businessDayOf,
  businessDayStartUtc,
  type Clock,
  type IdGenerator,
} from '@gic/domain';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { CLOCK } from '../platform/clock.provider.js';
import { ID_GENERATOR } from '../platform/id-generator.provider.js';
import { RequiresPermission } from '../platform/http/authorization.decorators.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import { attachmentsOfOwners } from '../modules/attachments/application/public/index.js';
import {
  ReadAccess,
  assertPeriod,
  businessDateParam,
  idParamSchema,
  parseOrThrow,
  uuidParam,
} from '../read-api/read-access.js';
import {
  OPERATIONS_LIST_DEFAULT_LIMIT,
  OPERATIONS_LIST_MAX_LIMIT,
  getExpense,
  getSupplierInvoice,
  getSupplierPayment,
  listExpenses,
  listSupplierInvoices,
  listSupplierPayments,
  supplierPayables,
  type ExpenseSummary,
} from '../modules/finance/application/public/index.js';

const EXPENSE_READ = 'finance.expense.read';
const PAYABLE_READ = 'finance.payable.read';

const uuid = uuidParam;
const businessDate = businessDateParam;
const limit = z.coerce.number().int().positive().max(OPERATIONS_LIST_MAX_LIMIT).optional();
const expensesQuerySchema = z.object({
  from: businessDate.optional(),
  to: businessDate.optional(),
  site_id: uuid.optional(),
  category_id: uuid.optional(),
  status: z.enum(EXPENSE_STATUSES).optional(),
  cost_object_id: uuid.optional(),
  created_by: uuid.optional(),
  cursor: uuid.optional(),
  limit,
});
const invoicesQuerySchema = z.object({
  supplier_id: uuid.optional(),
  status: z.enum(SUPPLIER_INVOICE_STATUSES).optional(),
  purchase_order_id: uuid.optional(),
  cursor: uuid.optional(),
  limit,
});
const paymentsQuerySchema = z.object({
  supplier_id: uuid.optional(),
  status: z.enum(SUPPLIER_PAYMENT_STATUSES).optional(),
  cursor: uuid.optional(),
  limit,
});
const payablesQuerySchema = z.object({ supplier_id: uuid.optional() });

@Controller('api/v1')
export class FinanceOperationsReadController {
  private readonly expenseRead: ReadAccess;
  private readonly payableRead: ReadAccess;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) idGenerator: IdGenerator,
  ) {
    const deps = { clock, idGenerator };
    this.expenseRead = new ReadAccess(db, deps, EXPENSE_READ);
    this.payableRead = new ReadAccess(db, deps, PAYABLE_READ);
  }

  /** Dépense dans la portée du lecteur : site de la dépense, propriété de son auteur. */
  private expenseVisible(
    request: AuthenticatedRequest,
    now: Date,
    expense: ExpenseSummary,
  ): Promise<boolean> {
    return this.expenseRead.allows(request, now, {
      siteId: expense.siteId,
      ownerUserId: expense.createdBy,
    });
  }

  /** Pièces de l'auteur de chaque dépense rendue (justificatif) : son lecteur les lit (ADR-047 §3). */
  private async withAttachments(expenses: readonly ExpenseSummary[]) {
    const owned = await attachmentsOfOwners(
      this.db,
      expenses.map((expense) => ({ ownerType: 'EXPENSE', ownerId: expense.id })),
    );
    return expenses.map((expense) => ({
      ...expense,
      attachments: (owned.get(`EXPENSE:${expense.id}`) ?? [])
        .filter((attachment) => attachment.createdBy === expense.createdBy)
        .map((attachment) => ({
          id: attachment.id,
          kind: attachment.kind,
          uploadStatus: attachment.uploadStatus,
        })),
    }));
  }

  @Get('expenses')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(EXPENSE_READ)
  async expenses(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(expensesQuerySchema, rawQuery);
    assertPeriod(query.from, query.to);
    const now = this.clock.now();
    await this.expenseRead.requirePermission(request, now, { type: 'EXPENSE' });
    const anyOf = await this.expenseRead.confinement(request, now);
    const page = await listExpenses(this.db, {
      ...(anyOf !== null ? { anyOf } : {}),
      ...(query.from !== undefined ? { fromUtc: businessDayStartUtc(query.from) } : {}),
      ...(query.to !== undefined ? { toUtc: businessDayEndUtc(query.to) } : {}),
      ...(query.site_id !== undefined ? { siteId: query.site_id } : {}),
      ...(query.category_id !== undefined ? { categoryId: query.category_id } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.cost_object_id !== undefined ? { costObjectId: query.cost_object_id } : {}),
      ...(query.created_by !== undefined ? { createdBy: query.created_by } : {}),
      ...(query.cursor !== undefined ? { beforeId: query.cursor } : {}),
      limit: query.limit ?? OPERATIONS_LIST_DEFAULT_LIMIT,
    });
    const kept: ExpenseSummary[] = [];
    for (const expense of page.items) {
      if (await this.expenseVisible(request, now, expense)) kept.push(expense);
    }
    return { expenses: await this.withAttachments(kept), next_cursor: page.nextCursor };
  }

  @Get('expenses/:id')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(EXPENSE_READ)
  async expense(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    const entity = { type: 'EXPENSE', id };
    await this.expenseRead.requirePermission(request, now, entity);
    const expense = await getExpense(this.db, id);
    if (!expense || !(await this.expenseVisible(request, now, expense))) {
      return this.expenseRead.deny(request, now, entity, 'OUT_OF_SCOPE');
    }
    return { expense: (await this.withAttachments([expense]))[0] };
  }

  @Get('supplier-invoices')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(PAYABLE_READ)
  async invoices(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(invoicesQuerySchema, rawQuery);
    await this.payableRead.requirePermission(request, this.clock.now(), {
      type: 'SUPPLIER_INVOICE',
    });
    const page = await listSupplierInvoices(this.db, {
      ...(query.supplier_id !== undefined ? { supplierId: query.supplier_id } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.purchase_order_id !== undefined
        ? { purchaseOrderId: query.purchase_order_id }
        : {}),
      ...(query.cursor !== undefined ? { beforeId: query.cursor } : {}),
      limit: query.limit ?? OPERATIONS_LIST_DEFAULT_LIMIT,
    });
    return { supplier_invoices: page.items, next_cursor: page.nextCursor };
  }

  @Get('supplier-invoices/:id')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(PAYABLE_READ)
  async invoice(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    const entity = { type: 'SUPPLIER_INVOICE', id };
    await this.payableRead.requirePermission(request, now, entity);
    const invoice = await getSupplierInvoice(this.db, id);
    if (!invoice) return this.payableRead.deny(request, now, entity, 'OUT_OF_SCOPE');
    return { supplier_invoice: invoice };
  }

  @Get('supplier-payments')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(PAYABLE_READ)
  async payments(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(paymentsQuerySchema, rawQuery);
    await this.payableRead.requirePermission(request, this.clock.now(), {
      type: 'SUPPLIER_PAYMENT',
    });
    const page = await listSupplierPayments(this.db, {
      ...(query.supplier_id !== undefined ? { supplierId: query.supplier_id } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.cursor !== undefined ? { beforeId: query.cursor } : {}),
      limit: query.limit ?? OPERATIONS_LIST_DEFAULT_LIMIT,
    });
    return { supplier_payments: page.items, next_cursor: page.nextCursor };
  }

  @Get('supplier-payments/:id')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(PAYABLE_READ)
  async payment(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    const entity = { type: 'SUPPLIER_PAYMENT', id };
    await this.payableRead.requirePermission(request, now, entity);
    const payment = await getSupplierPayment(this.db, id);
    if (!payment) return this.payableRead.deny(request, now, entity, 'OUT_OF_SCOPE');
    return { supplier_payment: payment };
  }

  @Get('payables')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(PAYABLE_READ)
  async payables(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(payablesQuerySchema, rawQuery);
    const now = this.clock.now();
    await this.payableRead.requirePermission(request, now, { type: 'SUPPLIER_INVOICE' });
    const today = businessDayOf(now);
    const suppliers = await supplierPayables(this.db, {
      today,
      ...(query.supplier_id !== undefined ? { supplierId: query.supplier_id } : {}),
    });
    return {
      as_of: today,
      total_balance_xaf: suppliers.reduce((sum, supplier) => sum + supplier.balanceXaf, 0),
      total_advance_xaf: suppliers.reduce((sum, supplier) => sum + supplier.advanceXaf, 0),
      suppliers,
    };
  }
}
