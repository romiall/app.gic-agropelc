/**
 * Lectures HTTP de la finance opérationnelle (P8-09 ; 08-api-events/01-architecture-api.md §4.9 ;
 * ADR-060, ADR-061 ; AV-365) : `GET /expenses`, `/expenses/{id}`, `/supplier-invoices`,
 * `/supplier-invoices/{id}`, `/supplier-payments`, `/supplier-payments/{id}`, `/payables`.
 *
 * - Dépenses : `finance.expense.read` (01-rbac.md §5.5 : Direction, Finance, Resp. production, Resp.
 *   achats `ALL` ; Resp. commercial `TEAM` ; vendeur et Resp. ferme `SITE` ; commerciaux et magasinier
 *   `OWN`). Portée : site de la dépense, propriété de son auteur. Hors portée : absente de la liste, ou
 *   404 audité pour le détail ; droit absent : 403 audité.
 * - Factures, paiements, dettes : `finance.payable.read` (Direction, Resp. achats, Finance ; `ALL`,
 *   AV-365).
 * - Listes paginées par curseur (UUIDv7, du plus récent au plus ancien) ; périodes en jours métier.
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
import { ApiError } from '../platform/http/api-error.exception.js';
import { RequiresPermission } from '../platform/http/authorization.decorators.js';
import { recordDenied } from '../audit/record-denied.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import { evaluateAccess, hasPermissionAt } from '../modules/identity/application/public/index.js';
import { toBin } from '../platform/kysely/uuid-columns.js';
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

const uuid = z.string().uuid();
const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ.');
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
const idParamSchema = z.object({ id: uuid });

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      `Paramètres de requête invalides : ${parsed.error.issues.map((i) => i.message).join(' ; ')}`,
    );
  }
  return parsed.data;
}

@Controller('api/v1')
export class FinanceOperationsReadController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
  ) {}

  private async deny(
    request: AuthenticatedRequest,
    now: Date,
    permission: string,
    entity: { readonly type: string; readonly id?: string },
    reason: 'NO_PERMISSION' | 'OUT_OF_SCOPE',
  ): Promise<never> {
    const auth = request.auth!;
    await recordDenied(
      this.db,
      { idGenerator: this.idGenerator, clock: this.clock },
      {
        occurredAt: now,
        actorUserId: auth.sub,
        actorRoles: [],
        deviceId: auth.device_id,
        action: 'access.denied',
        entityType: entity.type,
        entityId: entity.id ?? null,
        reason:
          reason === 'NO_PERMISSION'
            ? `Permission manquante : ${permission}.`
            : `Hors portée : ${permission}.`,
        errorCode: reason === 'NO_PERMISSION' ? 'FORBIDDEN' : 'NOT_FOUND',
      },
    );
    if (reason === 'NO_PERMISSION') {
      throw new ApiError(403, 'FORBIDDEN', 'Droit insuffisant pour cette consultation.');
    }
    throw new ApiError(404, 'NOT_FOUND', 'Ressource introuvable.');
  }

  private async requirePermission(
    request: AuthenticatedRequest,
    now: Date,
    permission: string,
    entity: { readonly type: string; readonly id?: string },
  ): Promise<void> {
    if (!(await hasPermissionAt(this.db, toBin(request.auth!.sub), permission, now))) {
      await this.deny(request, now, permission, entity, 'NO_PERMISSION');
    }
  }

  /** Dépense dans la portée du lecteur : site de la dépense, propriété de son auteur. */
  private async expenseVisible(
    request: AuthenticatedRequest,
    now: Date,
    expense: ExpenseSummary,
  ): Promise<boolean> {
    return (
      await evaluateAccess(this.db, {
        userId: request.auth!.sub,
        permissionCode: EXPENSE_READ,
        occurredAt: now,
        resource: { siteId: expense.siteId, ownerUserId: expense.createdBy },
      })
    ).allowed;
  }

  @Get('expenses')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(EXPENSE_READ)
  async expenses(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(expensesQuerySchema, rawQuery);
    if (query.from !== undefined && query.to !== undefined && query.to < query.from) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Période invalide.');
    }
    const now = this.clock.now();
    await this.requirePermission(request, now, EXPENSE_READ, { type: 'EXPENSE' });
    const page = await listExpenses(this.db, {
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
    return { expenses: kept, next_cursor: page.nextCursor };
  }

  @Get('expenses/:id')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(EXPENSE_READ)
  async expense(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    const entity = { type: 'EXPENSE', id };
    await this.requirePermission(request, now, EXPENSE_READ, entity);
    const expense = await getExpense(this.db, id);
    if (!expense || !(await this.expenseVisible(request, now, expense))) {
      return this.deny(request, now, EXPENSE_READ, entity, 'OUT_OF_SCOPE');
    }
    return { expense };
  }

  @Get('supplier-invoices')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(PAYABLE_READ)
  async invoices(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(invoicesQuerySchema, rawQuery);
    await this.requirePermission(request, this.clock.now(), PAYABLE_READ, {
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
    await this.requirePermission(request, now, PAYABLE_READ, entity);
    const invoice = await getSupplierInvoice(this.db, id);
    if (!invoice) return this.deny(request, now, PAYABLE_READ, entity, 'OUT_OF_SCOPE');
    return { supplier_invoice: invoice };
  }

  @Get('supplier-payments')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(PAYABLE_READ)
  async payments(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(paymentsQuerySchema, rawQuery);
    await this.requirePermission(request, this.clock.now(), PAYABLE_READ, {
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
    await this.requirePermission(request, now, PAYABLE_READ, entity);
    const payment = await getSupplierPayment(this.db, id);
    if (!payment) return this.deny(request, now, PAYABLE_READ, entity, 'OUT_OF_SCOPE');
    return { supplier_payment: payment };
  }

  @Get('payables')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(PAYABLE_READ)
  async payables(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(payablesQuerySchema, rawQuery);
    const now = this.clock.now();
    await this.requirePermission(request, now, PAYABLE_READ, { type: 'SUPPLIER_INVOICE' });
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
