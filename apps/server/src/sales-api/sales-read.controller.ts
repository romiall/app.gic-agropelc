/**
 * Lectures HTTP des ventes (P4-10 ; 08-api-events/01-architecture-api.md §4.5) : `GET /orders`,
 * `/orders/{id}`, `/sales`, `/sales/{id}`, `/sales/{id}/receipt`, `/deliveries`, `/payments`,
 * `/payments/{id}`, `/receivables`. Composition transport hors du module (même précédent que
 * `production-api/`).
 *
 * Droits (01-rbac.md §5.3) : `sales.order.read` (commandes et livraisons), `sales.sale.read`
 * (ventes et reçus), `sales.payment.read` (encaissements), `sales.receivable.read` (créances).
 * Portée (RC-04) : site, zone et titulaire du document (commercial attributaire, à défaut l'auteur
 * ou le vendeur, ou le receveur d'un encaissement). Une liste, sauf portée `ALL`, ne parcourt que
 * les sites et titulaires admissibles (`listConfinementAt`), puis vérifie chaque élément. Élément
 * hors portée ⇒ absent d'une liste, ou 404 pour une fiche ; droit absent ⇒ 403 ; les refus d'une
 * fiche sont audités (BR-AUD-004).
 *
 * RC-05 : le coût figé d'une ligne de vente (`unitCostXaf`, `costXaf`) est `null` sans
 * `inventory.valuation.read` ; les prix et montants de vente restent visibles.
 */
import { Controller, Get, HttpCode, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import {
  businessDayEndUtc,
  businessDayOf,
  businessDayStartUtc,
  type AgingBucket,
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
import {
  evaluateAccess,
  hasPermissionAt,
  listConfinementAt,
  userFullNames,
  type ResourceLocator,
} from '../modules/identity/application/public/index.js';
import { toBin } from '../platform/kysely/uuid-columns.js';
import { getCustomer } from '../modules/crm/application/public/index.js';
import {
  SALES_LIST_DEFAULT_LIMIT,
  SALES_LIST_MAX_LIMIT,
  getOrder,
  getPayment,
  getSale,
  listDeliveryNotes,
  listOrders,
  listPayments,
  listReceivables,
  listSales,
  summarizeReceivables,
  type ListScope,
  type SaleDetail,
  type SalesResource,
} from '../modules/sales/application/public/index.js';

const ORDER_READ = 'sales.order.read';
const SALE_READ = 'sales.sale.read';
const PAYMENT_READ = 'sales.payment.read';
const RECEIVABLE_READ = 'sales.receivable.read';
const VALUATION_READ = 'inventory.valuation.read';

const uuid = z.string().uuid();
const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ.');
const limit = z.coerce.number().int().positive().max(SALES_LIST_MAX_LIMIT).optional();
const period = { from: businessDate.optional(), to: businessDate.optional() };

const ordersQuerySchema = z.object({
  site_id: uuid.optional(),
  customer_id: uuid.optional(),
  fulfilment_location_id: uuid.optional(),
  status: z
    .enum(['DRAFT', 'CONFIRMED', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CLOSED', 'CANCELLED'])
    .optional(),
  ...period,
  cursor: uuid.optional(),
  limit,
});
const salesQuerySchema = z.object({
  site_id: uuid.optional(),
  customer_id: uuid.optional(),
  order_id: uuid.optional(),
  commercial_user_id: uuid.optional(),
  status: z.enum(['CONFIRMED', 'CANCELLATION_REQUESTED', 'CANCELLED']).optional(),
  payment_status: z.enum(['UNPAID', 'PARTIALLY_PAID', 'PAID']).optional(),
  ...period,
  cursor: uuid.optional(),
  limit,
});
const deliveriesQuerySchema = z.object({
  site_id: uuid.optional(),
  order_id: uuid.optional(),
  ...period,
  cursor: uuid.optional(),
  limit,
});
const paymentsQuerySchema = z.object({
  site_id: uuid.optional(),
  customer_id: uuid.optional(),
  status: z
    .enum(['RECORDED', 'SUSPECT_DUPLICATE', 'REJECTED', 'CANCELLATION_REQUESTED', 'CANCELLED'])
    .optional(),
  ...period,
  cursor: uuid.optional(),
  limit,
});
const receivablesQuerySchema = z.object({
  site_id: uuid.optional(),
  customer_id: uuid.optional(),
  commercial_user_id: uuid.optional(),
  aging: z.enum(['0-30', '31-60', '61-90', '>90']).optional(),
  overdue_only: z.enum(['true', 'false']).optional(),
  as_of: businessDate.optional(),
});
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

function periodOf(query: { readonly from?: string | undefined; readonly to?: string | undefined }) {
  if (query.from !== undefined && query.to !== undefined && query.to < query.from) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Période invalide.');
  }
  return {
    ...(query.from !== undefined ? { fromUtc: businessDayStartUtc(query.from) } : {}),
    ...(query.to !== undefined ? { toUtc: businessDayEndUtc(query.to) } : {}),
  };
}

const NOT_FOUND_MESSAGE = 'Ressource introuvable.';
const resourceOf = (resource: SalesResource): ResourceLocator => ({ ...resource });

@Controller('api/v1')
export class SalesReadController {
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
    throw new ApiError(404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
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

  private async allowed(
    request: AuthenticatedRequest,
    now: Date,
    permission: string,
    resource: ResourceLocator,
  ): Promise<boolean> {
    return (
      await evaluateAccess(this.db, {
        userId: request.auth!.sub,
        permissionCode: permission,
        occurredAt: now,
        resource,
      })
    ).allowed;
  }

  /**
   * Pré-filtre d'une liste : aucun pour la portée `ALL` ; sinon les sites et titulaires admissibles
   * (`listConfinementAt`) — un commercial à portée `OWN` ne parcourt que ses documents, un vendeur
   * ceux de son site. Chaque élément est ensuite vérifié (`keepAllowed`).
   */
  private async listScope(
    request: AuthenticatedRequest,
    now: Date,
    permission: string,
  ): Promise<{ readonly all: boolean; readonly anyOf?: ListScope }> {
    if (await this.allowed(request, now, permission, {})) return { all: true };
    const anyOf = await listConfinementAt(this.db, request.auth!.sub, permission, now);
    return anyOf === null ? { all: false } : { all: false, anyOf };
  }

  private async keepAllowed<T extends { readonly resource: SalesResource }>(
    request: AuthenticatedRequest,
    now: Date,
    permission: string,
    all: boolean,
    items: readonly T[],
  ): Promise<T[]> {
    if (all) return [...items];
    const kept: T[] = [];
    for (const item of items) {
      if (await this.allowed(request, now, permission, resourceOf(item.resource))) kept.push(item);
    }
    return kept;
  }

  private async requireVisible<T extends { readonly resource: SalesResource }>(
    request: AuthenticatedRequest,
    now: Date,
    permission: string,
    entity: { readonly type: string; readonly id: string },
    item: T | undefined,
  ): Promise<T> {
    if (
      item === undefined ||
      !(await this.allowed(request, now, permission, resourceOf(item.resource)))
    ) {
      return this.deny(request, now, permission, entity, 'OUT_OF_SCOPE');
    }
    return item;
  }

  /** RC-05 : coût figé des lignes masqué sans droit de valorisation. */
  private async costMasked(
    request: AuthenticatedRequest,
    now: Date,
    sale: SaleDetail,
  ): Promise<SaleDetail> {
    if (await hasPermissionAt(this.db, toBin(request.auth!.sub), VALUATION_READ, now)) return sale;
    return {
      ...sale,
      lines: sale.lines.map((line) => ({ ...line, unitCostXaf: null, costXaf: null })),
    };
  }

  // --- Commandes -----------------------------------------------------------------------------------

  @Get('orders')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ORDER_READ)
  async orders(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(ordersQuerySchema, rawQuery);
    const now = this.clock.now();
    await this.requirePermission(request, now, ORDER_READ, { type: 'SALES_ORDER' });
    const scope = await this.listScope(request, now, ORDER_READ);
    const page = await listOrders(this.db, {
      ...(scope.anyOf !== undefined ? { anyOf: scope.anyOf } : {}),
      ...(query.site_id !== undefined ? { siteId: query.site_id } : {}),
      ...(query.customer_id !== undefined ? { customerId: query.customer_id } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.fulfilment_location_id !== undefined
        ? { fulfilmentLocationId: query.fulfilment_location_id }
        : {}),
      ...periodOf(query),
      ...(query.cursor !== undefined ? { beforeId: query.cursor } : {}),
      limit: query.limit ?? SALES_LIST_DEFAULT_LIMIT,
    });
    return {
      orders: await this.keepAllowed(request, now, ORDER_READ, scope.all, page.items),
      next_cursor: page.nextCursor,
    };
  }

  @Get('orders/:id')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ORDER_READ)
  async order(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    const entity = { type: 'SALES_ORDER', id };
    await this.requirePermission(request, now, ORDER_READ, entity);
    const order = await this.requireVisible(
      request,
      now,
      ORDER_READ,
      entity,
      await getOrder(this.db, id),
    );
    return { order };
  }

  @Get('deliveries')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ORDER_READ)
  async deliveries(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(deliveriesQuerySchema, rawQuery);
    const now = this.clock.now();
    await this.requirePermission(request, now, ORDER_READ, { type: 'DELIVERY_NOTE' });
    const scope = await this.listScope(request, now, ORDER_READ);
    const page = await listDeliveryNotes(this.db, {
      ...(scope.anyOf !== undefined ? { anyOf: scope.anyOf } : {}),
      ...(query.site_id !== undefined ? { siteId: query.site_id } : {}),
      ...(query.order_id !== undefined ? { orderId: query.order_id } : {}),
      ...periodOf(query),
      ...(query.cursor !== undefined ? { beforeId: query.cursor } : {}),
      limit: query.limit ?? SALES_LIST_DEFAULT_LIMIT,
    });
    return {
      deliveries: await this.keepAllowed(request, now, ORDER_READ, scope.all, page.items),
      next_cursor: page.nextCursor,
    };
  }

  // --- Ventes --------------------------------------------------------------------------------------

  @Get('sales')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(SALE_READ)
  async sales(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(salesQuerySchema, rawQuery);
    const now = this.clock.now();
    await this.requirePermission(request, now, SALE_READ, { type: 'SALE' });
    const scope = await this.listScope(request, now, SALE_READ);
    const page = await listSales(this.db, {
      ...(scope.anyOf !== undefined ? { anyOf: scope.anyOf } : {}),
      ...(query.site_id !== undefined ? { siteId: query.site_id } : {}),
      ...(query.customer_id !== undefined ? { customerId: query.customer_id } : {}),
      ...(query.order_id !== undefined ? { orderId: query.order_id } : {}),
      ...(query.commercial_user_id !== undefined
        ? { commercialUserId: query.commercial_user_id }
        : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.payment_status !== undefined ? { paymentStatus: query.payment_status } : {}),
      ...periodOf(query),
      ...(query.cursor !== undefined ? { beforeId: query.cursor } : {}),
      limit: query.limit ?? SALES_LIST_DEFAULT_LIMIT,
    });
    return {
      sales: await this.keepAllowed(request, now, SALE_READ, scope.all, page.items),
      next_cursor: page.nextCursor,
    };
  }

  @Get('sales/:id')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(SALE_READ)
  async sale(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    const entity = { type: 'SALE', id };
    await this.requirePermission(request, now, SALE_READ, entity);
    const sale = await this.requireVisible(
      request,
      now,
      SALE_READ,
      entity,
      await getSale(this.db, id),
    );
    return { sale: await this.costMasked(request, now, sale) };
  }

  /**
   * Reçu d'une vente (BR-VEN-024) : numéro officiel, date, client, vendeur, lignes au prix appliqué,
   * totaux, encaissements affectés et reste dû — sans coût ni marge.
   */
  @Get('sales/:id/receipt')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(SALE_READ)
  async receipt(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    const entity = { type: 'SALE', id };
    await this.requirePermission(request, now, SALE_READ, entity);
    const sale = await this.requireVisible(
      request,
      now,
      SALE_READ,
      entity,
      await getSale(this.db, id),
    );
    const customer = sale.customerId ? await getCustomer(this.db, sale.customerId) : undefined;
    const names = await userFullNames(this.db, [sale.sellerUserId]);
    return {
      receipt: {
        docNumber: sale.docNumber,
        occurredAt: sale.occurredAt,
        businessDay: businessDayOf(new Date(sale.occurredAt)),
        status: sale.status,
        customer: customer
          ? { id: customer.id, name: customer.displayName, phone: customer.phonePrimary }
          : null,
        seller: { id: sale.sellerUserId, name: names.get(sale.sellerUserId) ?? null },
        lines: sale.lines.map((line) => ({
          productName: line.productName,
          quantity: line.quantity,
          unitCode: line.unitCode,
          unitPriceXaf: line.unitPriceXaf,
          discountXaf: line.discountXaf,
          lineTotalXaf: line.lineTotalXaf,
        })),
        totalXaf: sale.totalXaf,
        cancelledXaf: sale.cancelledXaf,
        netTotalXaf: sale.netTotalXaf,
        payments: sale.payments
          .filter((payment) => payment.status === 'ACTIVE')
          .map((payment) => ({
            docNumber: payment.docNumber,
            methodCode: payment.methodCode,
            amountXaf: payment.amountXaf,
          })),
        amountPaidXaf: sale.amountPaidXaf,
        balanceDueXaf: sale.balanceDueXaf,
        dueDate: sale.dueDate,
      },
    };
  }

  // --- Encaissements -------------------------------------------------------------------------------

  @Get('payments')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(PAYMENT_READ)
  async payments(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(paymentsQuerySchema, rawQuery);
    const now = this.clock.now();
    await this.requirePermission(request, now, PAYMENT_READ, { type: 'CUSTOMER_PAYMENT' });
    const scope = await this.listScope(request, now, PAYMENT_READ);
    const page = await listPayments(this.db, {
      ...(scope.anyOf !== undefined ? { anyOf: scope.anyOf } : {}),
      ...(query.site_id !== undefined ? { siteId: query.site_id } : {}),
      ...(query.customer_id !== undefined ? { customerId: query.customer_id } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...periodOf(query),
      ...(query.cursor !== undefined ? { beforeId: query.cursor } : {}),
      limit: query.limit ?? SALES_LIST_DEFAULT_LIMIT,
    });
    return {
      payments: await this.keepAllowed(request, now, PAYMENT_READ, scope.all, page.items),
      next_cursor: page.nextCursor,
    };
  }

  @Get('payments/:id')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(PAYMENT_READ)
  async payment(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    const entity = { type: 'CUSTOMER_PAYMENT', id };
    await this.requirePermission(request, now, PAYMENT_READ, entity);
    const payment = await this.requireVisible(
      request,
      now,
      PAYMENT_READ,
      entity,
      await getPayment(this.db, id),
    );
    return { payment };
  }

  // --- Créances ------------------------------------------------------------------------------------

  /**
   * BR-FIN-007 : créances par vente (échéance, jours de retard, tranche) et leur synthèse par
   * ancienneté, au jour métier courant ou `as_of`.
   */
  @Get('receivables')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(RECEIVABLE_READ)
  async receivables(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(receivablesQuerySchema, rawQuery);
    const now = this.clock.now();
    await this.requirePermission(request, now, RECEIVABLE_READ, { type: 'RECEIVABLE' });
    const scope = await this.listScope(request, now, RECEIVABLE_READ);
    const today = query.as_of ?? businessDayOf(now);
    const lines = await listReceivables(this.db, {
      today,
      ...(scope.anyOf !== undefined ? { anyOf: scope.anyOf } : {}),
      ...(query.site_id !== undefined ? { siteIds: [query.site_id] } : {}),
      ...(query.customer_id !== undefined ? { customerIds: [query.customer_id] } : {}),
      ...(query.commercial_user_id !== undefined
        ? { commercialUserId: query.commercial_user_id }
        : {}),
      ...(query.overdue_only === 'true' || query.aging !== undefined ? { overdueOnly: true } : {}),
    });
    const withResource = lines.map((line) => ({
      ...line,
      occurredAt: line.occurredAt.toISOString(),
      resource: {
        ownerUserId: line.commercialUserId ?? line.sellerUserId,
        siteId: line.siteId,
        zoneId: line.zoneId,
      },
    }));
    const kept = (
      await this.keepAllowed(request, now, RECEIVABLE_READ, scope.all, withResource)
    ).filter((line) => query.aging === undefined || line.bucket === (query.aging as AgingBucket));
    return {
      as_of: today,
      summary: summarizeReceivables(
        kept.map((line) => ({ ...line, occurredAt: new Date(line.occurredAt) })),
      ),
      receivables: kept,
    };
  }
}
