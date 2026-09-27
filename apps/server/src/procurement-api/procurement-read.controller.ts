/**
 * Lectures HTTP des achats (P6-06 ; 08-api-events/01-architecture-api.md §4.8) :
 * `GET /purchase-requests`, `/purchase-requests/{id}`, `/purchase-orders` (reliquats),
 * `/purchase-orders/{id}`, `/purchase-orders/{id}/matching` (commandé, livré, rejeté, accepté,
 * facturé), `/receipts`, `/receipts/{id}`. Composition transport hors du module (même précédent
 * que `crm-api/` et `inventory-api/`).
 *
 * Droit (01-rbac.md §5.5) : `procurement.order.read` pour les trois documents — DÉDUIT : aucune
 * permission de lecture propre aux demandes d'achat ni aux réceptions ; chaque demandeur
 * (`procurement.request.create`) et chaque réceptionnaire (`procurement.receipt.record`) la
 * détient sur le même périmètre. Portée (RC-04) : site du document ; une DA est aussi visible de
 * son demandeur. Une liste sans `site_id` porte, sauf portée `ALL`, sur les sites d'affectation de
 * l'utilisateur (et ses propres DA). Élément hors portée ⇒ absent de la liste, ou 404 pour une
 * fiche ; droit absent ⇒ 403 ; les deux refus d'une fiche sont audités (BR-AUD-004).
 *
 * RC-05 : prix d'achat, coûts de réception et valeurs du rapprochement à `null` sans
 * `inventory.valuation.read` (le coût de réception est le coût d'entrée en stock) ; le prix
 * estimé d'une DA, saisi par le demandeur, reste visible.
 */
import { Controller, Get, HttpCode, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import {
  DomainError,
  businessDayEndUtc,
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
import {
  activeSiteAssignmentsAt,
  evaluateAccess,
  hasPermissionAt,
  type ResourceLocator,
} from '../modules/identity/application/public/index.js';
import { toBin } from '../platform/kysely/uuid-columns.js';
import {
  PROCUREMENT_LIST_DEFAULT_LIMIT,
  PROCUREMENT_LIST_MAX_LIMIT,
  getGoodsReceipt,
  getPurchaseOrder,
  getPurchaseRequest,
  listGoodsReceipts,
  listPurchaseOrders,
  listPurchaseRequests,
  purchaseOrderMatching,
  type GoodsReceiptSummary,
  type OrderMatching,
  type PurchaseOrderSummary,
  type PurchaseRequestSummary,
} from '../modules/procurement/application/public/index.js';

const ORDER_READ = 'procurement.order.read';
const VALUATION_READ = 'inventory.valuation.read';

const uuid = z.string().uuid();
const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ.');
const limit = z.coerce.number().int().positive().max(PROCUREMENT_LIST_MAX_LIMIT).optional();

const requestsQuerySchema = z.object({
  site_id: uuid.optional(),
  requested_by: z.union([z.literal('me'), uuid]).optional(),
  status: z
    .enum([
      'SUBMITTED',
      'APPROVED',
      'REJECTED',
      'PARTIALLY_ORDERED',
      'ORDERED',
      'CANCELLED',
      'CLOSED',
    ])
    .optional(),
  cursor: uuid.optional(),
  limit,
});
const ordersQuerySchema = z.object({
  site_id: uuid.optional(),
  supplier_id: uuid.optional(),
  status: z
    .enum([
      'DRAFT',
      'PENDING_APPROVAL',
      'APPROVED',
      'SENT',
      'PARTIALLY_RECEIVED',
      'RECEIVED',
      'CLOSED',
      'CANCELLED',
    ])
    .optional(),
  cursor: uuid.optional(),
  limit,
});
const receiptsQuerySchema = z.object({
  site_id: uuid.optional(),
  purchase_order_id: uuid.optional(),
  supplier_id: uuid.optional(),
  status: z
    .enum([
      'POSTED',
      'POSTED_PENDING_REVIEW',
      'REVIEW_REJECTED',
      'QUARANTINED',
      'REJECTED',
      'CANCELLATION_PENDING',
      'CANCELLED',
    ])
    .optional(),
  from: businessDate.optional(),
  to: businessDate.optional(),
  cursor: uuid.optional(),
  limit,
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

function businessRange(from: string | undefined, to: string | undefined) {
  try {
    return {
      ...(from !== undefined ? { from: businessDayStartUtc(from) } : {}),
      ...(to !== undefined ? { to: businessDayEndUtc(to) } : {}),
    };
  } catch (error) {
    if (error instanceof DomainError) throw new ApiError(400, 'VALIDATION_ERROR', error.message);
    throw error;
  }
}

/** RC-05 : valeurs d'achat masquées sans `inventory.valuation.read`. */
function maskOrder(order: PurchaseOrderSummary) {
  return {
    ...order,
    totalXaf: null,
    lines: order.lines.map((line) => ({ ...line, unitPriceXaf: null, lineTotalXaf: null })),
  };
}

function maskReceipt(receipt: GoodsReceiptSummary) {
  return {
    ...receipt,
    totalAcceptedValueXaf: null,
    lines: receipt.lines.map((line) => ({ ...line, unitCostXaf: null })),
  };
}

function maskMatching(matching: OrderMatching) {
  return {
    ...matching,
    lines: matching.lines.map((line) => ({
      ...line,
      unitPriceXaf: null,
      orderedValueXaf: null,
      acceptedValueXaf: null,
      invoicedValueXaf: null,
    })),
    totals: {
      orderedValueXaf: null,
      acceptedValueXaf: null,
      invoicedValueXaf: null,
      paidXaf: null,
    },
  };
}

const NOT_FOUND_MESSAGE = 'Ressource introuvable.';

@Controller('api/v1')
export class ProcurementReadController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
  ) {}

  private async deny(
    request: AuthenticatedRequest,
    now: Date,
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
            ? `Permission manquante : ${ORDER_READ}.`
            : `Hors portée : ${ORDER_READ}.`,
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
    entity: { readonly type: string; readonly id?: string },
  ): Promise<void> {
    if (!(await hasPermissionAt(this.db, toBin(request.auth!.sub), ORDER_READ, now))) {
      await this.deny(request, now, entity, 'NO_PERMISSION');
    }
  }

  private async allowed(
    request: AuthenticatedRequest,
    now: Date,
    resource: ResourceLocator,
  ): Promise<boolean> {
    const access = await evaluateAccess(this.db, {
      userId: request.auth!.sub,
      permissionCode: ORDER_READ,
      occurredAt: now,
      resource,
    });
    return access.allowed;
  }

  /** Portée `ALL` : seule une portée sans restriction admet une ressource vide. */
  private hasAllScope(request: AuthenticatedRequest, now: Date): Promise<boolean> {
    return this.allowed(request, now, {});
  }

  private canValue(request: AuthenticatedRequest, now: Date): Promise<boolean> {
    return hasPermissionAt(this.db, toBin(request.auth!.sub), VALUATION_READ, now);
  }

  private async keepAllowed<T>(
    request: AuthenticatedRequest,
    now: Date,
    items: readonly T[],
    resourceOf: (item: T) => ResourceLocator,
  ): Promise<T[]> {
    const kept: T[] = [];
    for (const item of items) {
      if (await this.allowed(request, now, resourceOf(item))) kept.push(item);
    }
    return kept;
  }

  /** Fiche : 404 (audité) si le document est inconnu ou hors portée. */
  private async requireVisible<T>(
    request: AuthenticatedRequest,
    now: Date,
    entity: { readonly type: string; readonly id: string },
    item: T | undefined,
    resourceOf: (item: T) => ResourceLocator,
  ): Promise<T> {
    if (item === undefined || !(await this.allowed(request, now, resourceOf(item)))) {
      return this.deny(request, now, entity, 'OUT_OF_SCOPE');
    }
    return item;
  }

  @Get('purchase-requests')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ORDER_READ)
  async purchaseRequests(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(requestsQuerySchema, rawQuery);
    const now = this.clock.now();
    await this.requirePermission(request, now, { type: 'PURCHASE_REQUEST' });
    const me = request.auth!.sub;
    const all = await this.hasAllScope(request, now);
    const requestedBy = query.requested_by === 'me' ? me : query.requested_by;
    const anchored = query.site_id !== undefined || requestedBy !== undefined;
    const page = await listPurchaseRequests(this.db, {
      ...(!all && !anchored
        ? { anyOf: { siteIds: await activeSiteAssignmentsAt(this.db, me, now), requestedBy: [me] } }
        : {}),
      ...(query.site_id !== undefined ? { siteId: query.site_id } : {}),
      ...(requestedBy !== undefined ? { requestedBy } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.cursor !== undefined ? { beforeId: query.cursor } : {}),
      limit: query.limit ?? PROCUREMENT_LIST_DEFAULT_LIMIT,
    });
    const purchaseRequests = all
      ? [...page.items]
      : await this.keepAllowed(request, now, page.items, requestResourceOf);
    return { purchase_requests: purchaseRequests, next_cursor: page.nextCursor };
  }

  @Get('purchase-requests/:id')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ORDER_READ)
  async purchaseRequest(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    const entity = { type: 'PURCHASE_REQUEST', id };
    await this.requirePermission(request, now, entity);
    const found = await getPurchaseRequest(this.db, id);
    return {
      purchase_request: await this.requireVisible(request, now, entity, found, requestResourceOf),
    };
  }

  @Get('purchase-orders')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ORDER_READ)
  async purchaseOrders(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(ordersQuerySchema, rawQuery);
    const now = this.clock.now();
    await this.requirePermission(request, now, { type: 'PURCHASE_ORDER' });
    const all = await this.hasAllScope(request, now);
    const page = await listPurchaseOrders(this.db, {
      ...(!all && query.site_id === undefined
        ? { siteIds: await activeSiteAssignmentsAt(this.db, request.auth!.sub, now) }
        : {}),
      ...(query.site_id !== undefined ? { siteId: query.site_id } : {}),
      ...(query.supplier_id !== undefined ? { supplierId: query.supplier_id } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.cursor !== undefined ? { beforeId: query.cursor } : {}),
      limit: query.limit ?? PROCUREMENT_LIST_DEFAULT_LIMIT,
    });
    const visible = all
      ? [...page.items]
      : await this.keepAllowed(request, now, page.items, siteResourceOf);
    const valued = await this.canValue(request, now);
    return {
      purchase_orders: valued ? visible : visible.map(maskOrder),
      next_cursor: page.nextCursor,
    };
  }

  @Get('purchase-orders/:id')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ORDER_READ)
  async purchaseOrder(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    const entity = { type: 'PURCHASE_ORDER', id };
    await this.requirePermission(request, now, entity);
    const order = await this.requireVisible(
      request,
      now,
      entity,
      await getPurchaseOrder(this.db, id),
      siteResourceOf,
    );
    return { purchase_order: (await this.canValue(request, now)) ? order : maskOrder(order) };
  }

  @Get('purchase-orders/:id/matching')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ORDER_READ)
  async matching(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    const entity = { type: 'PURCHASE_ORDER', id };
    await this.requirePermission(request, now, entity);
    const matching = await this.requireVisible(
      request,
      now,
      entity,
      await purchaseOrderMatching(this.db, id),
      siteResourceOf,
    );
    return { matching: (await this.canValue(request, now)) ? matching : maskMatching(matching) };
  }

  @Get('receipts')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ORDER_READ)
  async receipts(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(receiptsQuerySchema, rawQuery);
    const now = this.clock.now();
    await this.requirePermission(request, now, { type: 'GOODS_RECEIPT' });
    const all = await this.hasAllScope(request, now);
    const page = await listGoodsReceipts(this.db, {
      ...(!all && query.site_id === undefined
        ? { siteIds: await activeSiteAssignmentsAt(this.db, request.auth!.sub, now) }
        : {}),
      ...(query.site_id !== undefined ? { siteId: query.site_id } : {}),
      ...(query.purchase_order_id !== undefined
        ? { purchaseOrderId: query.purchase_order_id }
        : {}),
      ...(query.supplier_id !== undefined ? { supplierId: query.supplier_id } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...businessRange(query.from, query.to),
      ...(query.cursor !== undefined ? { beforeId: query.cursor } : {}),
      limit: query.limit ?? PROCUREMENT_LIST_DEFAULT_LIMIT,
    });
    const visible = all
      ? [...page.items]
      : await this.keepAllowed(request, now, page.items, siteResourceOf);
    const valued = await this.canValue(request, now);
    return { receipts: valued ? visible : visible.map(maskReceipt), next_cursor: page.nextCursor };
  }

  @Get('receipts/:id')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ORDER_READ)
  async receipt(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    const entity = { type: 'GOODS_RECEIPT', id };
    await this.requirePermission(request, now, entity);
    const receipt = await this.requireVisible(
      request,
      now,
      entity,
      await getGoodsReceipt(this.db, id),
      siteResourceOf,
    );
    return { receipt: (await this.canValue(request, now)) ? receipt : maskReceipt(receipt) };
  }
}

function requestResourceOf(item: PurchaseRequestSummary): ResourceLocator {
  return { siteId: item.siteId, ownerUserId: item.requestedBy };
}

function siteResourceOf(item: { readonly siteId: string }): ResourceLocator {
  return { siteId: item.siteId };
}
