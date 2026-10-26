/**
 * `GET /api/v1/analytics/dashboards/{direction, commercial, stock, production, finance}` (P9-17 ; UC-ANA-01,
 * ADR-066 §1 et §2, AT-038, AT-054). Un tableau de rôle et la tour de contrôle (`direction`) : des blocs d'indicateurs
 * calculés par les fonctions de référence des modules propriétaires, dans le périmètre exact de la permission
 * `analytics.dashboard.<code>` (jamais élargi), avec la période précédente des seuls flux, la fraîcheur et un lien
 * d'exploration par indicateur. Une valeur au coût est `null` sans `inventory.valuation.read` (ADR-035) ; un bloc qui
 * échoue est `unavailable` sans faire échouer la page. `distribution` garde son contrôleur (`distribution-api/`).
 *
 * Paramètres : `period` (nommée, défaut `TODAY`) ou `from` et `to` (jours métier inclus, au plus
 * `analytics.dashboard_max_period_days`). Lecture seule, dans un instantané.
 */
import { Controller, Get, HttpCode, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { BUSINESS_PERIOD_CODES, type Clock, type IdGenerator } from '@gic/domain';
import { dashboardResponseSchema, type DashboardCode } from '@gic/contracts';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { CLOCK } from '../platform/clock.provider.js';
import { ID_GENERATOR } from '../platform/id-generator.provider.js';
import { ApiError } from '../platform/http/api-error.exception.js';
import { RequiresPermission } from '../platform/http/authorization.decorators.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import { businessDateParam, parseOrThrow, ReadAccess } from '../read-api/read-access.js';
import { resolveDashboardPeriod } from '../read-api/dashboard-period.js';
import { buildDashboard, dashboardPermission } from './dashboards/dashboard-builder.js';

const querySchema = z
  .object({
    period: z.enum(BUSINESS_PERIOD_CODES).optional(),
    from: businessDateParam.optional(),
    to: businessDateParam.optional(),
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

@Controller('api/v1')
export class AnalyticsDashboardsController {
  private readonly deps: { readonly clock: Clock; readonly idGenerator: IdGenerator };

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) idGenerator: IdGenerator,
  ) {
    this.deps = { clock, idGenerator };
  }

  @Get('analytics/dashboards/direction')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission('analytics.dashboard.direction')
  direction(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    return this.serve('direction', rawQuery, request);
  }

  @Get('analytics/dashboards/commercial')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission('analytics.dashboard.commercial')
  commercial(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    return this.serve('commercial', rawQuery, request);
  }

  @Get('analytics/dashboards/stock')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission('analytics.dashboard.stock')
  stock(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    return this.serve('stock', rawQuery, request);
  }

  @Get('analytics/dashboards/production')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission('analytics.dashboard.production')
  production(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    return this.serve('production', rawQuery, request);
  }

  @Get('analytics/dashboards/finance')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission('analytics.dashboard.finance')
  finance(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    return this.serve('finance', rawQuery, request);
  }

  private async serve(code: DashboardCode, rawQuery: unknown, request: AuthenticatedRequest) {
    const query = parseOrThrow(querySchema, rawQuery);
    const now = this.clock.now();
    const access = new ReadAccess(this.db, this.deps, dashboardPermission(code));
    await access.requirePermission(request, now, {
      type: `ANALYTICS_DASHBOARD_${code.toUpperCase()}`,
    });
    const period = await resolveDashboardPeriod(this.db, now, query);
    const response = await this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute((trx) => buildDashboard(trx, { userId: request.auth!.sub, at: now, code, period }));
    if (response === null) {
      // Le droit a été retiré entre le contrôle et le calcul : même refus.
      throw new ApiError(403, 'FORBIDDEN', 'Droit insuffisant pour cette consultation.');
    }
    return dashboardResponseSchema.parse(response);
  }
}
