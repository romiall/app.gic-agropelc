/**
 * `GET /api/v1/analytics/dashboards/distribution` (P5-20 ; ECR-DIS-04, D05 BR-DIS-010, KPI-DIS-01 à 07,
 * AT-042 ; AV-164, AV-204 à AV-207 ; ADR-035). Servi par la couche de transport avant le module
 * d'analyse (P9), qui le reprend sans changement.
 *
 * Droit : `analytics.dashboard.distribution` (01-rbac.md §5.1 : Direction et Finance `ALL`, Resp.
 * commercial `ZONE`, Vendeur et Magasinier `SITE`). Périmètre (AV-204) : les PDV que la permission
 * atteint (`evaluateAccess` PDV par PDV, zone et descendance comprises) ; aucun PDV ⇒ réponse vide,
 * jamais « tout ». `site_id` hors portée ou inconnu ⇒ 404 audité (RC-07). Droits annexes par site
 * (AV-205, AV-206) : valeurs (`inventory.valuation.read`), détail de caisse (`finance.cash.read`),
 * receveurs (`sales.payment.read`), auteurs d'un appareil (`sync.monitor.read`) ; sinon `null`.
 * Période (AV-207) : `period` nommée (BR-ANA-002, défaut `TODAY`) ou `from`/`to` (bornes incluses,
 * au plus `analytics.dashboard_max_period_days` jours).
 */
import { Controller, Get, HttpCode, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import {
  BUSINESS_PERIOD_CODES,
  businessDayOf,
  businessPeriodDays,
  businessPeriodOf,
  type Clock,
  type IdGenerator,
} from '@gic/domain';
import { distributionDashboardResponseSchema } from '@gic/contracts';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { CLOCK } from '../platform/clock.provider.js';
import { ID_GENERATOR } from '../platform/id-generator.provider.js';
import { ApiError } from '../platform/http/api-error.exception.js';
import { RequiresPermission } from '../platform/http/authorization.decorators.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import {
  currentSettingValue,
  listPointsOfSale,
  type PointOfSaleSummary,
} from '../modules/organization/application/public/index.js';
import {
  assertPeriod,
  businessDateParam,
  parseOrThrow,
  ReadAccess,
  uuidParam,
} from '../read-api/read-access.js';
import { distributionTargetsOf } from '../read-api/distribution-targets.js';
import {
  buildDistributionDashboard,
  type SiteVisibility,
} from './distribution-dashboard.service.js';

export const DISTRIBUTION_DASHBOARD_READ = 'analytics.dashboard.distribution';
export const DASHBOARD_MAX_PERIOD_DAYS_KEY = 'analytics.dashboard_max_period_days';
/** Défaut du paramètre semé (AV-207) quand il manque ou est mal formé. */
const DEFAULT_MAX_PERIOD_DAYS = 366;

const querySchema = z
  .object({
    period: z.enum(BUSINESS_PERIOD_CODES).optional(),
    from: businessDateParam.optional(),
    to: businessDateParam.optional(),
    site_id: uuidParam.optional(),
    product_id: uuidParam.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.period !== undefined && (value.from !== undefined || value.to !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Période nommée et dates sont exclusives.',
      });
    }
    if ((value.from === undefined) !== (value.to === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'from et to vont ensemble.' });
    }
  });

const resourceOf = (pos: PointOfSaleSummary) => ({ siteId: pos.siteId, zoneId: pos.zoneId });

@Controller('api/v1')
export class DistributionDashboardController {
  private readonly access: ReadAccess;
  private readonly valuation: ReadAccess;
  private readonly cashRead: ReadAccess;
  private readonly paymentRead: ReadAccess;
  private readonly syncMonitor: ReadAccess;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) idGenerator: IdGenerator,
  ) {
    const deps = { clock, idGenerator };
    this.access = new ReadAccess(db, deps, DISTRIBUTION_DASHBOARD_READ);
    this.valuation = new ReadAccess(db, deps, 'inventory.valuation.read');
    this.cashRead = new ReadAccess(db, deps, 'finance.cash.read');
    this.paymentRead = new ReadAccess(db, deps, 'sales.payment.read');
    this.syncMonitor = new ReadAccess(db, deps, 'sync.monitor.read');
  }

  /** Droit annexe évalué par PDV (court-circuit si la portée est `ALL`). */
  private async perSite(
    access: ReadAccess,
    request: AuthenticatedRequest,
    now: Date,
    points: readonly PointOfSaleSummary[],
  ): Promise<ReadonlySet<string>> {
    if (await access.allowsAll(request, now)) return new Set(points.map((pos) => pos.siteId));
    const allowed = new Set<string>();
    for (const pos of points) {
      if (await access.allows(request, now, resourceOf(pos))) allowed.add(pos.siteId);
    }
    return allowed;
  }

  @Get('analytics/dashboards/distribution')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(DISTRIBUTION_DASHBOARD_READ)
  async distribution(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(querySchema, rawQuery);
    const now = this.clock.now();
    await this.access.requirePermission(request, now, { type: 'DISTRIBUTION_DASHBOARD' });

    // Période (AV-207).
    let period: {
      code: (typeof BUSINESS_PERIOD_CODES)[number] | 'CUSTOM';
      fromDay: string;
      toDay: string;
    };
    if (query.from !== undefined && query.to !== undefined) {
      assertPeriod(query.from, query.to);
      const maxValue = await currentSettingValue(this.db, {
        key: DASHBOARD_MAX_PERIOD_DAYS_KEY,
        scopeType: 'GLOBAL',
        scopeId: null,
        at: now,
      });
      const maxDays =
        typeof maxValue === 'number' && Number.isInteger(maxValue) && maxValue > 0
          ? maxValue
          : DEFAULT_MAX_PERIOD_DAYS;
      if (businessPeriodDays({ fromDay: query.from, toDay: query.to }) > maxDays) {
        throw new ApiError(400, 'VALIDATION_ERROR', `Période limitée à ${maxDays} jours.`);
      }
      period = { code: 'CUSTOM', fromDay: query.from, toDay: query.to };
    } else {
      const code = query.period ?? 'TODAY';
      period = { code, ...businessPeriodOf(code, businessDayOf(now)) };
    }

    // Périmètre (AV-204) : PDV que la permission atteint.
    const configured = await listPointsOfSale(
      this.db,
      query.site_id !== undefined ? { siteIds: [query.site_id] } : {},
    );
    if (query.site_id !== undefined) {
      await this.access.requireVisible(
        request,
        now,
        { type: 'SITE', id: query.site_id },
        configured[0],
        resourceOf,
      );
    }
    const allSites = await this.access.allowsAll(request, now);
    const kept: PointOfSaleSummary[] = [];
    for (const pos of configured) {
      if (allSites || (await this.access.allows(request, now, resourceOf(pos)))) kept.push(pos);
    }
    const targets = await distributionTargetsOf(this.db, kept);

    // Droits annexes par site (AV-205, AV-206).
    const [value, cashDetail, receivers, authors] = await Promise.all([
      this.perSite(this.valuation, request, now, kept),
      this.perSite(this.cashRead, request, now, kept),
      this.perSite(this.paymentRead, request, now, kept),
      this.perSite(this.syncMonitor, request, now, kept),
    ]);
    const visibility = (siteId: string): SiteVisibility => ({
      value: value.has(siteId),
      cashDetail: cashDetail.has(siteId),
      receivers: receivers.has(siteId),
      authors: authors.has(siteId),
    });

    // Un seul instantané pour toutes les lectures (comme `ledger-reconciliation.ts`) : une vente validée
    // entre la lecture du registre et celle de `sales` ferait afficher un faux écart de rapprochement.
    const response = await this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute((trx) =>
        buildDistributionDashboard(trx, {
          targets,
          period,
          now,
          ...(query.product_id !== undefined ? { productIds: [query.product_id] } : {}),
          visibility,
          allSites: allSites && query.site_id === undefined,
        }),
      );
    return distributionDashboardResponseSchema.parse(response);
  }
}
