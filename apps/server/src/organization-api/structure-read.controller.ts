/**
 * Lectures HTTP de la structure (P5-17 ; 08-api-events/01-architecture-api.md §4.2) : `GET /sites`,
 * `/locations?site_id=`, `/points-of-sale`. Patron de P4-10 (`read-api/read-access.ts`).
 *
 * Droit (01-rbac.md §5.1) : `org.structure.read` (Direction, Admin, Finance, Resp. commercial…
 * `ALL` ; Commercial terrain `ZONE` ; Vendeur, Resp. ferme, Magasinier `SITE`). Portée (RC-04, AV-189) :
 * le site et sa zone ; un site hors portée est absent de la liste, un emplacement ou un PDV d'un site
 * hors portée aussi ; `/locations` exige le site (`site_id`), hors portée ou inconnu ⇒ 404 audité.
 * Le PDV est complété, dans cette couche de transport, par l'identifiant de sa caisse (`CAISSE_PDV`
 * active du site) et de sa session ouverte (`finance`), sans aucun montant (ceux-ci relèvent de
 * `finance.cash.read`, `GET /cash-accounts`, `/cash-sessions`).
 */
import { Controller, Get, HttpCode, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { Clock, IdGenerator } from '@gic/domain';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { CLOCK } from '../platform/clock.provider.js';
import { ID_GENERATOR } from '../platform/id-generator.provider.js';
import { RequiresPermission } from '../platform/http/authorization.decorators.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import {
  findSite,
  listLocations,
  listPointsOfSale,
  listSites,
  type SiteSummary,
} from '../modules/organization/application/public/index.js';
import {
  findCashSessionCovering,
  listCashAccounts,
} from '../modules/finance/application/public/index.js';
import { parseOrThrow, ReadAccess, uuidParam } from '../read-api/read-access.js';

const STRUCTURE_READ = 'org.structure.read';

const SITE_TYPES = ['FERME', 'MAGASIN', 'POINT_DE_VENTE', 'BUREAU'] as const;
const sitesQuerySchema = z.object({
  site_type: z.enum(SITE_TYPES).optional(),
  status: z.enum(['ACTIVE', 'CLOSED']).optional(),
  zone_id: uuidParam.optional(),
});
const locationsQuerySchema = z.object({
  site_id: uuidParam,
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  location_type: z.string().min(1).max(40).optional(),
});
const pointsOfSaleQuerySchema = z.object({ site_id: uuidParam.optional() });

const siteResource = (site: { readonly id: string; readonly zoneId: string }) => ({
  siteId: site.id,
  zoneId: site.zoneId,
});

@Controller('api/v1')
export class StructureReadController {
  private readonly access: ReadAccess;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) idGenerator: IdGenerator,
  ) {
    this.access = new ReadAccess(db, { clock, idGenerator }, STRUCTURE_READ);
  }

  private async visibleSites(
    request: AuthenticatedRequest,
    now: Date,
    sites: readonly SiteSummary[],
  ): Promise<SiteSummary[]> {
    if (await this.access.allowsAll(request, now)) return [...sites];
    const kept: SiteSummary[] = [];
    for (const site of sites) {
      if (await this.access.allows(request, now, siteResource(site))) kept.push(site);
    }
    return kept;
  }

  @Get('sites')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(STRUCTURE_READ)
  async sites(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(sitesQuerySchema, rawQuery);
    const now = this.clock.now();
    await this.access.requirePermission(request, now, { type: 'SITE' });
    const sites = await listSites(this.db, {
      ...(query.site_type !== undefined ? { siteType: query.site_type } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.zone_id !== undefined ? { zoneId: query.zone_id } : {}),
    });
    return { sites: await this.visibleSites(request, now, sites) };
  }

  @Get('locations')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(STRUCTURE_READ)
  async locations(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(locationsQuerySchema, rawQuery);
    const now = this.clock.now();
    const entity = { type: 'SITE', id: query.site_id };
    await this.access.requirePermission(request, now, entity);
    const site = await this.access.requireVisible(
      request,
      now,
      entity,
      await findSite(this.db, query.site_id),
      siteResource,
    );
    const locations = await listLocations(this.db, {
      siteId: site.id,
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.location_type !== undefined ? { locationType: query.location_type } : {}),
    });
    return { site, locations };
  }

  @Get('points-of-sale')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(STRUCTURE_READ)
  async pointsOfSale(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(pointsOfSaleQuerySchema, rawQuery);
    const now = this.clock.now();
    await this.access.requirePermission(request, now, { type: 'POINT_OF_SALE' });
    const all = await this.access.allowsAll(request, now);
    const points = await listPointsOfSale(
      this.db,
      query.site_id !== undefined ? { siteIds: [query.site_id] } : {},
    );
    const result = [];
    for (const point of points) {
      if (
        !all &&
        !(await this.access.allows(request, now, { siteId: point.siteId, zoneId: point.zoneId }))
      ) {
        continue;
      }
      // Caisse du PDV (une seule caisse active par site, BR-FIN-010) et sa session ouverte, par identifiants.
      const [cash] = await listCashAccounts(this.db, {
        siteIds: [point.siteId],
        accountType: 'CAISSE_PDV',
        status: 'ACTIVE',
      });
      const session = cash ? await findCashSessionCovering(this.db, cash.id, now) : null;
      result.push({
        ...point,
        cashAccountId: cash?.id ?? null,
        openCashSessionId: session?.status === 'OPEN' ? session.id : null,
      });
    }
    return { points_of_sale: result };
  }
}
