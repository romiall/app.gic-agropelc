/**
 * Lectures HTTP de la production (P7-11 ; 08-api-events/01-architecture-api.md §4.7) :
 * `GET /production/lots`, `/production/lots/{id}`, `/production/lots/{id}/daily`,
 * `/production/egg-collections[/{id}]`, `/production/incubations[/{id}]`,
 * `/production/slaughters[/{id}]`, `/production/overhead-allocations`. Composition transport
 * hors du module (même précédent que `procurement-api/`).
 *
 * Droit (01-rbac.md) : `production.lot.read` (Direction, Resp. production, Achats, Finance :
 * toutes fermes ; Resp. ferme : sa ferme). Portée (RC-04) : site du document ; une liste sans
 * `site_id` porte, sauf portée `ALL`, sur les sites d'affectation de l'utilisateur. Élément hors
 * portée ⇒ absent de la liste, ou 404 pour une fiche ; droit absent ⇒ 403 ; les refus d'une fiche
 * sont audités (BR-AUD-004).
 *
 * RC-05 : coûts, valeurs et montants à `null` sans `inventory.valuation.read` (coût des lots,
 * valeur des entrées et des collectes, coût des lots d'incubation, valeurs d'abattage, frais
 * généraux répartis) ; quantités, effectifs et indicateurs zootechniques restent visibles.
 */
import { Controller, Get, HttpCode, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import {
  DomainError,
  addBusinessDays,
  businessDayOf,
  nextBusinessDay,
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
  PRODUCTION_DAILY_MAX_DAYS,
  PRODUCTION_LIST_DEFAULT_LIMIT,
  PRODUCTION_LIST_MAX_LIMIT,
  getEggCollection,
  getIncubationBatch,
  getProductionLot,
  getSlaughter,
  listEggCollections,
  listIncubationBatches,
  listOverheadAllocations,
  listProductionLots,
  listSlaughters,
  productionLotDaily,
  type EggCollectionSummary,
  type IncubationBatchSummary,
  type LotDay,
  type OverheadAllocationSummary,
  type ProductionLotDetail,
  type SlaughterSummary,
} from '../modules/production/application/public/index.js';

const LOT_READ = 'production.lot.read';
const VALUATION_READ = 'inventory.valuation.read';

const uuid = z.string().uuid();
const businessDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ.');
const limit = z.coerce.number().int().positive().max(PRODUCTION_LIST_MAX_LIMIT).optional();

const lotsQuerySchema = z.object({
  site_id: uuid.optional(),
  status: z.enum(['PLANNED', 'ACTIVE', 'SELLING', 'CLOSED', 'CANCELLED']).optional(),
  lot_type: z
    .enum([
      'POULET_CHAIR',
      'PONDEUSE',
      'PORC_ENGRAISSEMENT',
      'REPRODUCTEUR_VOLAILLE',
      'PORC_NAISSAGE',
    ])
    .optional(),
  cursor: uuid.optional(),
  limit,
});
const dailyQuerySchema = z.object({ from: businessDate.optional(), to: businessDate.optional() });
const collectionsQuerySchema = z.object({
  site_id: uuid.optional(),
  production_lot_id: uuid.optional(),
  from: businessDate.optional(),
  to: businessDate.optional(),
  cursor: uuid.optional(),
  limit,
});
const incubationsQuerySchema = z.object({
  site_id: uuid.optional(),
  status: z.enum(['INCUBATING', 'IN_HATCHER', 'CLOSED', 'CANCELLED']).optional(),
  cursor: uuid.optional(),
  limit,
});
const slaughtersQuerySchema = z.object({
  site_id: uuid.optional(),
  production_lot_id: uuid.optional(),
  cursor: uuid.optional(),
  limit,
});
const allocationsQuerySchema = z.object({
  site_id: uuid.optional(),
  species_group: z.enum(['VOLAILLE', 'PORC']).optional(),
  period: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Période attendue au format AAAA-MM.')
    .optional(),
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

/** Montants d'un objet (clés en `…Xaf`) remis à `null` (RC-05), récursivement. */
function maskAmounts<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => maskAmounts(item)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = key.endsWith('Xaf') ? null : maskAmounts(item);
    }
    return out as T;
  }
  return value;
}

const NOT_FOUND_MESSAGE = 'Ressource introuvable.';
const siteResourceOf = (item: { readonly siteId: string }): ResourceLocator => ({
  siteId: item.siteId,
});

@Controller('api/v1/production')
export class ProductionReadController {
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
            ? `Permission manquante : ${LOT_READ}.`
            : `Hors portée : ${LOT_READ}.`,
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
    if (!(await hasPermissionAt(this.db, toBin(request.auth!.sub), LOT_READ, now))) {
      await this.deny(request, now, entity, 'NO_PERMISSION');
    }
  }

  private async allowed(
    request: AuthenticatedRequest,
    now: Date,
    resource: ResourceLocator,
  ): Promise<boolean> {
    return (
      await evaluateAccess(this.db, {
        userId: request.auth!.sub,
        permissionCode: LOT_READ,
        occurredAt: now,
        resource,
      })
    ).allowed;
  }

  /** Portée `ALL` : seule une portée sans restriction admet une ressource vide. */
  private hasAllScope(request: AuthenticatedRequest, now: Date): Promise<boolean> {
    return this.allowed(request, now, {});
  }

  private canValue(request: AuthenticatedRequest, now: Date): Promise<boolean> {
    return hasPermissionAt(this.db, toBin(request.auth!.sub), VALUATION_READ, now);
  }

  /** Sites d'une liste : ceux d'affectation sauf portée `ALL` ou `site_id` explicite. */
  private async siteScope(
    request: AuthenticatedRequest,
    now: Date,
    siteId: string | undefined,
  ): Promise<{ readonly all: boolean; readonly siteIds?: readonly string[] }> {
    const all = await this.hasAllScope(request, now);
    if (all || siteId !== undefined) return { all };
    return { all, siteIds: await activeSiteAssignmentsAt(this.db, request.auth!.sub, now) };
  }

  private async keepAllowed<T extends { readonly siteId: string }>(
    request: AuthenticatedRequest,
    now: Date,
    all: boolean,
    items: readonly T[],
  ): Promise<T[]> {
    if (all) return [...items];
    const kept: T[] = [];
    for (const item of items) {
      if (await this.allowed(request, now, siteResourceOf(item))) kept.push(item);
    }
    return kept;
  }

  /** Fiche : 404 (audité) si le document est inconnu ou hors portée. */
  private async requireVisible<T extends { readonly siteId: string }>(
    request: AuthenticatedRequest,
    now: Date,
    entity: { readonly type: string; readonly id: string },
    item: T | undefined,
  ): Promise<T> {
    if (item === undefined || !(await this.allowed(request, now, siteResourceOf(item)))) {
      return this.deny(request, now, entity, 'OUT_OF_SCOPE');
    }
    return item;
  }

  private async valued<T>(request: AuthenticatedRequest, now: Date, value: T): Promise<T> {
    return (await this.canValue(request, now)) ? value : maskAmounts(value);
  }

  @Get('lots')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(LOT_READ)
  async lots(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(lotsQuerySchema, rawQuery);
    const now = this.clock.now();
    await this.requirePermission(request, now, { type: 'PRODUCTION_LOT' });
    const scope = await this.siteScope(request, now, query.site_id);
    const page = await listProductionLots(this.db, {
      ...(scope.siteIds !== undefined ? { siteIds: scope.siteIds } : {}),
      ...(query.site_id !== undefined ? { siteId: query.site_id } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.lot_type !== undefined ? { lotType: query.lot_type } : {}),
      ...(query.cursor !== undefined ? { beforeId: query.cursor } : {}),
      limit: query.limit ?? PRODUCTION_LIST_DEFAULT_LIMIT,
    });
    return {
      lots: await this.keepAllowed(request, now, scope.all, page.items),
      next_cursor: page.nextCursor,
    };
  }

  @Get('lots/:id')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(LOT_READ)
  async lot(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    const entity = { type: 'PRODUCTION_LOT', id };
    await this.requirePermission(request, now, entity);
    const lot = await this.requireVisible(
      request,
      now,
      entity,
      await getProductionLot(this.db, id),
    );
    return { lot: await this.valued<ProductionLotDetail>(request, now, lot) };
  }

  @Get('lots/:id/daily')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(LOT_READ)
  async daily(
    @Param() rawParams: unknown,
    @Query() rawQuery: unknown,
    @Req() request: AuthenticatedRequest,
  ) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const query = parseOrThrow(dailyQuerySchema, rawQuery);
    const now = this.clock.now();
    const entity = { type: 'PRODUCTION_LOT', id };
    await this.requirePermission(request, now, entity);
    const lot = await this.requireVisible(
      request,
      now,
      entity,
      await getProductionLot(this.db, id),
    );
    // Fenêtre par défaut : les 7 derniers jours métier ; au plus un trimestre.
    const to = query.to ?? businessDayOf(now);
    let from = query.from;
    let span = 1;
    try {
      from ??= addBusinessDays(to, -6);
      for (let day = from; day < to; day = nextBusinessDay(day)) {
        span += 1;
        if (span > PRODUCTION_DAILY_MAX_DAYS) break;
      }
    } catch (error) {
      if (error instanceof DomainError) throw new ApiError(400, 'VALIDATION_ERROR', error.message);
      throw error;
    }
    if (from > to || span > PRODUCTION_DAILY_MAX_DAYS) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        `Période invalide : du plus ancien au plus récent, ${PRODUCTION_DAILY_MAX_DAYS} jours au plus.`,
      );
    }
    const days = await productionLotDaily(this.db, lot, from, to);
    return {
      production_lot_id: id,
      from,
      to,
      days: await this.valued<readonly LotDay[]>(request, now, days),
    };
  }

  @Get('egg-collections')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(LOT_READ)
  async collections(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(collectionsQuerySchema, rawQuery);
    const now = this.clock.now();
    await this.requirePermission(request, now, { type: 'EGG_COLLECTION' });
    const scope = await this.siteScope(request, now, query.site_id);
    const page = await listEggCollections(this.db, {
      ...(scope.siteIds !== undefined ? { siteIds: scope.siteIds } : {}),
      ...(query.site_id !== undefined ? { siteId: query.site_id } : {}),
      ...(query.production_lot_id !== undefined
        ? { productionLotId: query.production_lot_id }
        : {}),
      ...(query.from !== undefined ? { fromDay: query.from } : {}),
      ...(query.to !== undefined ? { toDay: query.to } : {}),
      ...(query.cursor !== undefined ? { beforeId: query.cursor } : {}),
      limit: query.limit ?? PRODUCTION_LIST_DEFAULT_LIMIT,
    });
    const visible = await this.keepAllowed(request, now, scope.all, page.items);
    return {
      egg_collections: await this.valued<readonly EggCollectionSummary[]>(request, now, visible),
      next_cursor: page.nextCursor,
    };
  }

  @Get('egg-collections/:id')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(LOT_READ)
  async collection(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    const entity = { type: 'EGG_COLLECTION', id };
    await this.requirePermission(request, now, entity);
    const found = await this.requireVisible(
      request,
      now,
      entity,
      await getEggCollection(this.db, id),
    );
    return { egg_collection: await this.valued<EggCollectionSummary>(request, now, found) };
  }

  @Get('incubations')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(LOT_READ)
  async incubations(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(incubationsQuerySchema, rawQuery);
    const now = this.clock.now();
    await this.requirePermission(request, now, { type: 'INCUBATION_BATCH' });
    const scope = await this.siteScope(request, now, query.site_id);
    const page = await listIncubationBatches(this.db, {
      ...(scope.siteIds !== undefined ? { siteIds: scope.siteIds } : {}),
      ...(query.site_id !== undefined ? { siteId: query.site_id } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.cursor !== undefined ? { beforeId: query.cursor } : {}),
      limit: query.limit ?? PRODUCTION_LIST_DEFAULT_LIMIT,
    });
    const visible = await this.keepAllowed(request, now, scope.all, page.items);
    return {
      incubations: await this.valued<readonly IncubationBatchSummary[]>(request, now, visible),
      next_cursor: page.nextCursor,
    };
  }

  @Get('incubations/:id')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(LOT_READ)
  async incubation(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    const entity = { type: 'INCUBATION_BATCH', id };
    await this.requirePermission(request, now, entity);
    const found = await this.requireVisible(
      request,
      now,
      entity,
      await getIncubationBatch(this.db, id),
    );
    return { incubation: await this.valued(request, now, found) };
  }

  @Get('slaughters')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(LOT_READ)
  async slaughters(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(slaughtersQuerySchema, rawQuery);
    const now = this.clock.now();
    await this.requirePermission(request, now, { type: 'SLAUGHTER' });
    const scope = await this.siteScope(request, now, query.site_id);
    const page = await listSlaughters(this.db, {
      ...(scope.siteIds !== undefined ? { siteIds: scope.siteIds } : {}),
      ...(query.site_id !== undefined ? { siteId: query.site_id } : {}),
      ...(query.production_lot_id !== undefined
        ? { productionLotId: query.production_lot_id }
        : {}),
      ...(query.cursor !== undefined ? { beforeId: query.cursor } : {}),
      limit: query.limit ?? PRODUCTION_LIST_DEFAULT_LIMIT,
    });
    const visible = await this.keepAllowed(request, now, scope.all, page.items);
    return {
      slaughters: await this.valued<readonly SlaughterSummary[]>(request, now, visible),
      next_cursor: page.nextCursor,
    };
  }

  @Get('slaughters/:id')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(LOT_READ)
  async slaughter(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    const entity = { type: 'SLAUGHTER', id };
    await this.requirePermission(request, now, entity);
    const found = await this.requireVisible(request, now, entity, await getSlaughter(this.db, id));
    return { slaughter: await this.valued<SlaughterSummary>(request, now, found) };
  }

  @Get('overhead-allocations')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(LOT_READ)
  async allocations(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(allocationsQuerySchema, rawQuery);
    const now = this.clock.now();
    await this.requirePermission(request, now, { type: 'OVERHEAD_ALLOCATION' });
    const scope = await this.siteScope(request, now, query.site_id);
    const page = await listOverheadAllocations(this.db, {
      ...(scope.siteIds !== undefined ? { siteIds: scope.siteIds } : {}),
      ...(query.site_id !== undefined ? { siteId: query.site_id } : {}),
      ...(query.species_group !== undefined ? { speciesGroup: query.species_group } : {}),
      ...(query.period !== undefined ? { period: query.period } : {}),
      ...(query.cursor !== undefined ? { beforeId: query.cursor } : {}),
      limit: query.limit ?? PRODUCTION_LIST_DEFAULT_LIMIT,
    });
    const visible = await this.keepAllowed(request, now, scope.all, page.items);
    return {
      overhead_allocations: await this.valued<readonly OverheadAllocationSummary[]>(
        request,
        now,
        visible,
      ),
      next_cursor: page.nextCursor,
    };
  }
}
