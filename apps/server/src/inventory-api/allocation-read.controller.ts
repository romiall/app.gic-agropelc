/**
 * Lectures HTTP des quotas d'appareil (P5-17 ; ADR-033 ; 08-api-events/01-architecture-api.md §4.6) :
 * `GET /allocations`, `/allocations/{id}`. Patron de P4-10 (`read-api/read-access.ts`).
 *
 * Droit (AV-189) : `inventory.stock.read` (01-rbac.md §5.3 ; aucune permission de lecture propre aux
 * quotas). Deux modes de liste :
 * - **par emplacement** (`location_id`) : ancrage de P2-05 — l'emplacement doit être dans la portée
 *   (site, zone, détenteur d'un stock mobile), sinon 404 audité ; tous ses quotas sont visibles, avec
 *   le total des restes actifs par produit (part promise du stock) ;
 * - **mes quotas** (sans `location_id`) : ceux dont l'utilisateur est le détenteur (ECR-DIS-01), quel
 *   que soit l'emplacement — un détenteur voit toujours son propre quota.
 * Fiche : visible si son emplacement est dans la portée ou si l'utilisateur en est le détenteur ; le
 * registre (`entries`) l'accompagne (INV-STK-20 : reste = Σ des entrées). Aucun montant (RC-05 sans objet).
 */
import { Controller, Get, HttpCode, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { Clock, IdGenerator } from '@gic/domain';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { CLOCK } from '../platform/clock.provider.js';
import { ID_GENERATOR } from '../platform/id-generator.provider.js';
import { RequiresPermission } from '../platform/http/authorization.decorators.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import type { ResourceLocator } from '../modules/identity/application/public/index.js';
import {
  ALLOCATION_STATUSES,
  INVENTORY_LIST_DEFAULT_LIMIT,
  INVENTORY_LIST_MAX_LIMIT,
  activeAllocationTotals,
  findAllocation,
  findStockLocation,
  listAllocationEntries,
  listAllocations,
  type StockLocationRef,
} from '../modules/inventory/application/public/index.js';
import { idParamSchema, parseOrThrow, ReadAccess, uuidParam } from '../read-api/read-access.js';

const STOCK_READ = 'inventory.stock.read';

const allocationsQuerySchema = z.object({
  location_id: uuidParam.optional(),
  product_id: uuidParam.optional(),
  status: z.enum(ALLOCATION_STATUSES).optional(),
  cursor: uuidParam.optional(),
  limit: z.coerce.number().int().positive().max(INVENTORY_LIST_MAX_LIMIT).optional(),
});

function locationResource(location: StockLocationRef): ResourceLocator {
  return {
    ...(location.siteId !== null ? { siteId: location.siteId } : {}),
    ...(location.zoneId !== null ? { zoneId: location.zoneId } : {}),
    ...(location.custodianUserId !== null ? { ownerUserId: location.custodianUserId } : {}),
  };
}

@Controller('api/v1')
export class AllocationReadController {
  private readonly access: ReadAccess;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) idGenerator: IdGenerator,
  ) {
    this.access = new ReadAccess(db, { clock, idGenerator }, STOCK_READ);
  }

  @Get('allocations')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(STOCK_READ)
  async allocations(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(allocationsQuerySchema, rawQuery);
    const now = this.clock.now();
    const userId = request.auth!.sub;
    const filters = {
      ...(query.product_id !== undefined ? { productId: query.product_id } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.cursor !== undefined ? { beforeId: query.cursor } : {}),
      limit: query.limit ?? INVENTORY_LIST_DEFAULT_LIMIT,
    };
    if (query.location_id === undefined) {
      await this.access.requirePermission(request, now, { type: 'STOCK_ALLOCATION' });
      const page = await listAllocations(this.db, { holderUserId: userId, ...filters });
      return { location_id: null, allocations: page.items, next_cursor: page.nextCursor };
    }
    const entity = { type: 'LOCATION', id: query.location_id };
    await this.access.requirePermission(request, now, entity);
    const location = await this.access.requireVisible(
      request,
      now,
      entity,
      await findStockLocation(this.db, query.location_id),
      locationResource,
    );
    const page = await listAllocations(this.db, { locationId: location.id, ...filters });
    return {
      location_id: location.id,
      allocations: page.items,
      active_totals: await activeAllocationTotals(this.db, location.id),
      next_cursor: page.nextCursor,
    };
  }

  @Get('allocations/:id')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(STOCK_READ)
  async allocation(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    const entity = { type: 'STOCK_ALLOCATION', id };
    await this.access.requirePermission(request, now, entity);
    const allocation = await findAllocation(this.db, id);
    if (!allocation) return this.access.deny(request, now, entity, 'OUT_OF_SCOPE');
    if (allocation.holderUserId !== request.auth!.sub) {
      const location = await findStockLocation(this.db, allocation.locationId);
      if (!location || !(await this.access.allows(request, now, locationResource(location)))) {
        return this.access.deny(request, now, entity, 'OUT_OF_SCOPE');
      }
    }
    return { allocation, entries: await listAllocationEntries(this.db, id) };
  }
}
