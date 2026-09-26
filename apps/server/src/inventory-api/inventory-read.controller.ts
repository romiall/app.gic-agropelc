/**
 * Lectures HTTP du stock (P2-05 ; 08-api-events/01-architecture-api.md §4.6). Composition
 * transport hors du module (même précédent que `catalog-api/`) : `AuthGuard` est transport
 * interne d'`identity`, jamais son API publique.
 *
 * Portée (01-architecture-api.md §2 : « toute requête est restreinte à la portée de
 * l'utilisateur ») — contrairement au catalogue (`catalog.product.read` = ALL pour tous les
 * rôles), les droits de stock sont bornés au site, à la zone ou au détenteur (01-rbac.md §5.3) :
 * - chaque lecture est ancrée sur un **emplacement** (`location_id` obligatoire, DÉDUIT :
 *   c'est la seule ressource du stock qui porte un site, une zone et un détenteur — la liste
 *   de documents d'un emplacement hérite de sa portée) ; l'accès est évalué par
 *   `evaluateAccess` (RC-04) sur le site/la zone de l'emplacement et, pour un emplacement
 *   `MOBILE`, sur son détenteur (01-rbac.md §3, propriétaire = `custodian_user_id`) ;
 * - hors portée ⇒ 404, comme une ressource inexistante (01-architecture-api.md §2, sans
 *   distinction) ; droit absent ⇒ 403. Les deux refus sont audités (`access.denied`,
 *   BR-AUD-004) ;
 * - `/stock/availability` (réponse par zone) filtre ses emplacements un par un.
 *
 * Mesures financières (RC-05, BR-STK-054) : coûts et valeurs ne sont renvoyés qu'avec
 * `inventory.valuation.read` en plus du droit de lecture ; sinon remplacés par `null`
 * (champ présent, valeur masquée — le contrat de réponse reste le même pour tous).
 *
 * Droit de lecture des documents — AV-094 (TRANCHÉ 26/09/2026) :
 * - pertes : `inventory.loss.read`, réservé à l'encadrement dans son périmètre (Direction,
 *   responsables commercial, de production et de ferme, magasinier, finance) ; un déclarant de
 *   terrain (vendeur, commercial) détient la portée `OWN` et ne lit que **ses** déclarations —
 *   une vendeuse ne lit pas les pertes déclarées par ses collègues (secret administratif) ;
 * - transferts, consommations, inventaires, seuils : `inventory.stock.read` ;
 * - registre des mouvements : `inventory.ledger.read` ; registre de coûts :
 *   `inventory.valuation.read`.
 */
import { Controller, Get, HttpCode, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { Clock, IdGenerator } from '@gic/domain';
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
  type ResourceLocator,
} from '../modules/identity/application/public/index.js';
import { toBin } from '../platform/kysely/uuid-columns.js';
import {
  COMMERCIAL_LOCATION_TYPES,
  INVENTORY_LIST_DEFAULT_LIMIT,
  INVENTORY_LIST_MAX_LIMIT,
  decodeStockMovesCursor,
  findStockLocation,
  getInventoryCount,
  getTransfer,
  listAvailabilityInZone,
  listConsumptions,
  listCostEntries,
  listInventoryCounts,
  listLossDeclarations,
  listStockBalances,
  listStockMoves,
  listStockThresholds,
  listTransfers,
  stockBalanceAt,
  type StockLocationRef,
} from '../modules/inventory/application/public/index.js';

const STOCK_READ = 'inventory.stock.read';
const LEDGER_READ = 'inventory.ledger.read';
const VALUATION_READ = 'inventory.valuation.read';
const LOSS_READ = 'inventory.loss.read';

/** Toutes les valeurs de `organization.locations.location_type` physiques (dictionnaire D02). */
const PHYSICAL_LOCATION_TYPES = [
  'STORE',
  'POS',
  'BUILDING',
  'PEN',
  'INCUBATOR',
  'HATCHER',
  'MOBILE',
] as const;

const uuid = z.string().uuid();
const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ.');
const limit = z.coerce.number().int().positive().max(INVENTORY_LIST_MAX_LIMIT).optional();
const idCursor = uuid.optional();

const stockQuerySchema = z.object({ location_id: uuid, product_id: uuid.optional() });
const stockAtQuerySchema = z.object({
  location_id: uuid,
  at: z.string().datetime({ offset: true }),
  product_id: uuid.optional(),
});
const availabilityQuerySchema = z.object({
  zone_id: uuid,
  product_id: uuid,
  location_scope: z.enum(['COMMERCIAL', 'PHYSICAL']).optional(),
});
const stockMovesQuerySchema = z.object({
  location_id: uuid,
  product_id: uuid.optional(),
  from: businessDate.optional(),
  to: businessDate.optional(),
  cursor: z.string().min(1).max(200).optional(),
  limit,
});
const transfersQuerySchema = z.object({
  location_id: uuid,
  direction: z.enum(['IN', 'OUT']).optional(),
  status: z.string().min(1).max(30).optional(),
  cursor: idCursor,
  limit,
});
const documentsQuerySchema = z.object({
  location_id: uuid,
  status: z.string().min(1).max(30).optional(),
  cursor: idCursor,
  limit,
});
const consumptionsQuerySchema = documentsQuerySchema.extend({
  cost_object_type: z.enum(['PRODUCTION_LOT', 'INCUBATION_BATCH', 'SITE']).optional(),
  cost_object_id: uuid.optional(),
});
const thresholdsQuerySchema = z.object({ location_id: uuid, product_id: uuid.optional() });
const costsQuerySchema = z.object({
  cost_object_type: z.enum(['PRODUCTION_LOT', 'INCUBATION_BATCH', 'SITE']),
  cost_object_id: uuid,
  cursor: idCursor,
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

function resourceOf(location: StockLocationRef): ResourceLocator {
  return {
    ...(location.siteId !== null ? { siteId: location.siteId } : {}),
    ...(location.zoneId !== null ? { zoneId: location.zoneId } : {}),
    ...(location.custodianUserId !== null ? { ownerUserId: location.custodianUserId } : {}),
  };
}

type Masked<T, K extends keyof T> = Omit<T, K> & { readonly [P in K]: T[P] | null };

/** RC-05 : champ financier conservé mais mis à `null` sans `inventory.valuation.read`. */
function mask<T extends object, K extends keyof T>(
  item: T,
  keys: readonly K[],
  visible: boolean,
): Masked<T, K> {
  if (visible) return item;
  const copy = { ...item } as Record<PropertyKey, unknown>;
  for (const key of keys) copy[key] = null;
  return copy as Masked<T, K>;
}

function pageLimit(value: number | undefined): number {
  return value ?? INVENTORY_LIST_DEFAULT_LIMIT;
}

const NOT_FOUND_MESSAGE = 'Ressource introuvable.';

@Controller('api/v1')
export class InventoryReadController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
  ) {}

  private async deny(
    request: AuthenticatedRequest,
    now: Date,
    entity: { readonly type: string; readonly id?: string },
    permissionCode: string,
    reason: 'NO_PERMISSION' | 'OUT_OF_SCOPE',
  ): Promise<never> {
    const auth = request.auth!;
    const errorCode = reason === 'NO_PERMISSION' ? 'FORBIDDEN' : 'NOT_FOUND';
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
            ? `Permission manquante : ${permissionCode}.`
            : `Hors portée : ${permissionCode}.`,
        errorCode,
      },
    );
    if (reason === 'NO_PERMISSION') {
      throw new ApiError(403, 'FORBIDDEN', 'Droit insuffisant pour cette consultation.');
    }
    throw new ApiError(404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
  }

  /** Emplacement existant ET dans la portée de `permissionCode` pour l'utilisateur, à `now`. */
  private async authorizedLocation(
    request: AuthenticatedRequest,
    now: Date,
    locationId: string,
    permissionCode: string,
  ): Promise<StockLocationRef> {
    const location = await findStockLocation(this.db, locationId);
    if (!location) {
      if (!(await hasPermissionAt(this.db, toBin(request.auth!.sub), permissionCode, now))) {
        return this.deny(
          request,
          now,
          { type: 'LOCATION', id: locationId },
          permissionCode,
          'NO_PERMISSION',
        );
      }
      throw new ApiError(404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
    }
    const access = await evaluateAccess(this.db, {
      userId: request.auth!.sub,
      permissionCode,
      occurredAt: now,
      resource: resourceOf(location),
    });
    if (!access.allowed) {
      return this.deny(
        request,
        now,
        { type: 'LOCATION', id: locationId },
        permissionCode,
        access.reason,
      );
    }
    return location;
  }

  private async canReadValuation(
    request: AuthenticatedRequest,
    now: Date,
    resource: ResourceLocator,
  ): Promise<boolean> {
    const access = await evaluateAccess(this.db, {
      userId: request.auth!.sub,
      permissionCode: VALUATION_READ,
      occurredAt: now,
      resource,
    });
    return access.allowed;
  }

  @Get('stock')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(STOCK_READ)
  async stock(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(stockQuerySchema, rawQuery);
    const now = this.clock.now();
    const location = await this.authorizedLocation(request, now, query.location_id, STOCK_READ);
    const financial = await this.canReadValuation(request, now, resourceOf(location));
    const balances = await listStockBalances(this.db, {
      locationId: location.id,
      custodyMode: location.custodyMode,
      ...(query.product_id !== undefined ? { productId: query.product_id } : {}),
    });
    return {
      location_id: location.id,
      balances: balances.map((b) => mask(b, ['unitCostXaf', 'valueXaf'], financial)),
    };
  }

  @Get('stock/at')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(STOCK_READ)
  async stockAt(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(stockAtQuerySchema, rawQuery);
    const now = this.clock.now();
    const location = await this.authorizedLocation(request, now, query.location_id, STOCK_READ);
    const financial = await this.canReadValuation(request, now, resourceOf(location));
    const at = new Date(query.at);
    const balances = await stockBalanceAt(this.db, {
      locationId: location.id,
      at,
      ...(query.product_id !== undefined ? { productId: query.product_id } : {}),
    });
    return {
      location_id: location.id,
      at,
      balances: balances.map((b) => mask(b, ['ledgerValueXaf'], financial)),
    };
  }

  @Get('stock/availability')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(STOCK_READ)
  async availability(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(availabilityQuerySchema, rawQuery);
    const now = this.clock.now();
    if (!(await hasPermissionAt(this.db, toBin(request.auth!.sub), STOCK_READ, now))) {
      return this.deny(
        request,
        now,
        { type: 'ZONE', id: query.zone_id },
        STOCK_READ,
        'NO_PERMISSION',
      );
    }
    const candidates = await listAvailabilityInZone(this.db, {
      zoneId: query.zone_id,
      productId: query.product_id,
      locationTypes:
        query.location_scope === 'PHYSICAL' ? PHYSICAL_LOCATION_TYPES : COMMERCIAL_LOCATION_TYPES,
    });
    const locations = [];
    for (const line of candidates) {
      const access = await evaluateAccess(this.db, {
        userId: request.auth!.sub,
        permissionCode: STOCK_READ,
        occurredAt: now,
        resource: {
          siteId: line.siteId,
          zoneId: line.zoneId,
          ...(line.custodianUserId !== null ? { ownerUserId: line.custodianUserId } : {}),
        },
      });
      if (access.allowed) locations.push(line);
    }
    const totalAvailable =
      Math.round(locations.reduce((sum, l) => sum + l.qtyAvailable, 0) * 1000) / 1000;
    return {
      zone_id: query.zone_id,
      product_id: query.product_id,
      location_scope: query.location_scope ?? 'COMMERCIAL',
      total_available: totalAvailable,
      locations,
    };
  }

  @Get('stock-moves')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(LEDGER_READ)
  async stockMoves(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(stockMovesQuerySchema, rawQuery);
    const after = query.cursor !== undefined ? decodeStockMovesCursor(query.cursor) : undefined;
    if (query.cursor !== undefined && after === undefined) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Curseur invalide.');
    }
    const now = this.clock.now();
    const location = await this.authorizedLocation(request, now, query.location_id, LEDGER_READ);
    const financial = await this.canReadValuation(request, now, resourceOf(location));
    const page = await listStockMoves(this.db, {
      locationId: location.id,
      ...(query.product_id !== undefined ? { productId: query.product_id } : {}),
      ...(query.from !== undefined ? { fromBusinessDate: query.from } : {}),
      ...(query.to !== undefined ? { toBusinessDate: query.to } : {}),
      ...(after !== undefined ? { after } : {}),
      limit: pageLimit(query.limit),
    });
    return {
      location_id: location.id,
      moves: page.moves.map((m) => mask(m, ['unitCostXaf', 'valueXaf'], financial)),
      next_cursor: page.nextCursor,
    };
  }

  @Get('transfers')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(STOCK_READ)
  async transfers(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(transfersQuerySchema, rawQuery);
    const now = this.clock.now();
    const location = await this.authorizedLocation(request, now, query.location_id, STOCK_READ);
    const page = await listTransfers(this.db, {
      locationId: location.id,
      ...(query.direction !== undefined ? { direction: query.direction } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.cursor !== undefined ? { beforeId: query.cursor } : {}),
      limit: pageLimit(query.limit),
    });
    return { transfers: page.items, next_cursor: page.nextCursor };
  }

  /** Accessible si la source **ou** la destination est dans la portée (les deux parties du
   * transfert en ont besoin : expédition, réception, SM-TRANSFER). */
  @Get('transfers/:id')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(STOCK_READ)
  async transfer(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    const transfer = await getTransfer(this.db, id);
    if (!transfer) {
      if (!(await hasPermissionAt(this.db, toBin(request.auth!.sub), STOCK_READ, now))) {
        return this.deny(request, now, { type: 'STOCK_TRANSFER', id }, STOCK_READ, 'NO_PERMISSION');
      }
      throw new ApiError(404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
    }
    let reason: 'NO_PERMISSION' | 'OUT_OF_SCOPE' = 'OUT_OF_SCOPE';
    for (const locationId of [transfer.fromLocationId, transfer.toLocationId]) {
      const location = await findStockLocation(this.db, locationId);
      if (!location) continue;
      const access = await evaluateAccess(this.db, {
        userId: request.auth!.sub,
        permissionCode: STOCK_READ,
        occurredAt: now,
        resource: resourceOf(location),
      });
      if (access.allowed) return { transfer };
      reason = access.reason;
    }
    return this.deny(request, now, { type: 'STOCK_TRANSFER', id }, STOCK_READ, reason);
  }

  /** AV-094 : portée pleine (`ALL`, `ZONE`, `SITE`) sur l'emplacement ⇒ toutes ses
   * déclarations ; portée `OWN` seulement ⇒ celles dont l'utilisateur est le déclarant. La
   * portée pleine est évaluée **sans** propriétaire : le détenteur d'un emplacement `MOBILE` n'est
   * pas, par là même, lecteur des pertes que d'autres y auraient déclarées. */
  @Get('losses')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(LOSS_READ)
  async losses(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(documentsQuerySchema, rawQuery);
    const now = this.clock.now();
    const userId = request.auth!.sub;
    const location = await findStockLocation(this.db, query.location_id);
    if (!location) {
      if (!(await hasPermissionAt(this.db, toBin(userId), LOSS_READ, now))) {
        return this.deny(
          request,
          now,
          { type: 'LOCATION', id: query.location_id },
          LOSS_READ,
          'NO_PERMISSION',
        );
      }
      throw new ApiError(404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
    }
    const siteAndZone: ResourceLocator = {
      ...(location.siteId !== null ? { siteId: location.siteId } : {}),
      ...(location.zoneId !== null ? { zoneId: location.zoneId } : {}),
    };
    const full = await evaluateAccess(this.db, {
      userId,
      permissionCode: LOSS_READ,
      occurredAt: now,
      resource: siteAndZone,
    });
    let declaredBy: string | undefined;
    if (!full.allowed) {
      if (full.reason === 'NO_PERMISSION') {
        return this.deny(
          request,
          now,
          { type: 'LOCATION', id: location.id },
          LOSS_READ,
          'NO_PERMISSION',
        );
      }
      const own = await evaluateAccess(this.db, {
        userId,
        permissionCode: LOSS_READ,
        occurredAt: now,
        resource: { ...siteAndZone, ownerUserId: userId },
      });
      if (!own.allowed) {
        return this.deny(
          request,
          now,
          { type: 'LOCATION', id: location.id },
          LOSS_READ,
          'OUT_OF_SCOPE',
        );
      }
      declaredBy = userId;
    }
    const financial = await this.canReadValuation(request, now, siteAndZone);
    const page = await listLossDeclarations(this.db, {
      locationId: location.id,
      ...(declaredBy !== undefined ? { declaredBy } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.cursor !== undefined ? { beforeId: query.cursor } : {}),
      limit: pageLimit(query.limit),
    });
    return {
      losses: page.items.map((l) => mask(l, ['unitCostXaf', 'valueXaf'], financial)),
      next_cursor: page.nextCursor,
    };
  }

  @Get('consumptions')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(STOCK_READ)
  async consumptions(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(consumptionsQuerySchema, rawQuery);
    const now = this.clock.now();
    const location = await this.authorizedLocation(request, now, query.location_id, STOCK_READ);
    const financial = await this.canReadValuation(request, now, resourceOf(location));
    const page = await listConsumptions(this.db, {
      locationId: location.id,
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.cost_object_type !== undefined ? { costObjectType: query.cost_object_type } : {}),
      ...(query.cost_object_id !== undefined ? { costObjectId: query.cost_object_id } : {}),
      ...(query.cursor !== undefined ? { beforeId: query.cursor } : {}),
      limit: pageLimit(query.limit),
    });
    return {
      consumptions: page.items.map((c) => mask(c, ['valueXaf'], financial)),
      next_cursor: page.nextCursor,
    };
  }

  @Get('inventory-counts')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(STOCK_READ)
  async inventoryCounts(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(documentsQuerySchema, rawQuery);
    const now = this.clock.now();
    const location = await this.authorizedLocation(request, now, query.location_id, STOCK_READ);
    const financial = await this.canReadValuation(request, now, resourceOf(location));
    const page = await listInventoryCounts(this.db, {
      locationId: location.id,
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.cursor !== undefined ? { beforeId: query.cursor } : {}),
      limit: pageLimit(query.limit),
    });
    return {
      inventory_counts: page.items.map((c) =>
        mask(c, ['varianceValueXaf', 'absVarianceValueXaf'], financial),
      ),
      next_cursor: page.nextCursor,
    };
  }

  @Get('inventory-counts/:id')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(STOCK_READ)
  async inventoryCount(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    const count = await getInventoryCount(this.db, id);
    if (!count) {
      if (!(await hasPermissionAt(this.db, toBin(request.auth!.sub), STOCK_READ, now))) {
        return this.deny(
          request,
          now,
          { type: 'INVENTORY_COUNT', id },
          STOCK_READ,
          'NO_PERMISSION',
        );
      }
      throw new ApiError(404, 'NOT_FOUND', NOT_FOUND_MESSAGE);
    }
    const location = await this.authorizedLocation(request, now, count.locationId, STOCK_READ);
    const financial = await this.canReadValuation(request, now, resourceOf(location));
    const { lines, ...header } = count;
    return {
      inventory_count: {
        ...mask(header, ['varianceValueXaf', 'absVarianceValueXaf'], financial),
        lines: lines.map((line) => mask(line, ['unitCostXaf', 'declaredUnitCostXaf'], financial)),
      },
    };
  }

  @Get('thresholds')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(STOCK_READ)
  async thresholds(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(thresholdsQuerySchema, rawQuery);
    const now = this.clock.now();
    const location = await this.authorizedLocation(request, now, query.location_id, STOCK_READ);
    const thresholds = await listStockThresholds(this.db, {
      locationId: location.id,
      custodyMode: location.custodyMode,
      ...(query.product_id !== undefined ? { productId: query.product_id } : {}),
    });
    return { location_id: location.id, thresholds };
  }

  /** Registre de coûts : mesure financière de bout en bout (RC-05) — `inventory.valuation.
   * read` suffit et est requis. Portée : un objet de coût `SITE` porte son site ; un lot de
   * production ou d'incubation (module `production`, P7) n'a pas encore de site résoluble
   * ici — seule une portée `ALL` y donne accès (la matrice n'accorde de toute façon
   * `inventory.valuation.read` qu'en `ALL`, 01-rbac.md §5.3). */
  @Get('costs')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(VALUATION_READ)
  async costs(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(costsQuerySchema, rawQuery);
    const now = this.clock.now();
    const resource: ResourceLocator =
      query.cost_object_type === 'SITE' ? { siteId: query.cost_object_id } : {};
    const access = await evaluateAccess(this.db, {
      userId: request.auth!.sub,
      permissionCode: VALUATION_READ,
      occurredAt: now,
      resource,
    });
    if (!access.allowed) {
      return this.deny(
        request,
        now,
        { type: query.cost_object_type, id: query.cost_object_id },
        VALUATION_READ,
        access.reason,
      );
    }
    const page = await listCostEntries(this.db, {
      costObjectType: query.cost_object_type,
      costObjectId: query.cost_object_id,
      ...(query.cursor !== undefined ? { beforeId: query.cursor } : {}),
      limit: pageLimit(query.limit),
    });
    return { cost_entries: page.items, next_cursor: page.nextCursor };
  }
}
