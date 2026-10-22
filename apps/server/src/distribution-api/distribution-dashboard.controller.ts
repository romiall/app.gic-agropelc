/**
 * `GET /api/v1/analytics/dashboards/distribution` (P5-20 ; ECR-DIS-04, D05 BR-DIS-010, KPI-DIS-01 à 07,
 * AT-042 ; AV-164, AV-204 à AV-207 ; ADR-035). Servi par la couche de transport avant le module
 * d'analyse (P9), qui le reprend sans changement de contrat (ADR-076 §3).
 *
 * Droit : `analytics.dashboard.distribution` (01-rbac.md §5.1 : Direction et Finance `ALL`, Resp.
 * commercial `ZONE`, Vendeur et Magasinier `SITE`). Périmètre (AV-204) : les PDV que la permission
 * atteint (`evaluateAccess` PDV par PDV, zone et descendance comprises) ; aucun PDV ⇒ réponse vide,
 * jamais « tout » — calculé par `resolveDashboardScope` (P9-17), que la tour de contrôle et les instantanés
 * appellent aussi. `site_id` hors portée ou inconnu ⇒ 404 audité (RC-07). Droits annexes par site
 * (AV-205, AV-206) : valeurs (`inventory.valuation.read`), détail de caisse (`finance.cash.read`),
 * receveurs (`sales.payment.read`), auteurs d'un appareil (`sync.monitor.read`) ; sinon `null`.
 * Période (AV-207) : `period` nommée (BR-ANA-002, défaut `TODAY`) ou `from`/`to` (bornes incluses,
 * au plus `analytics.dashboard_max_period_days` jours), résolues par `resolveAnalyticsPeriod` (P9-16).
 */
import { Controller, Get, HttpCode, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { BUSINESS_PERIOD_CODES, type Clock, type IdGenerator } from '@gic/domain';
import { distributionDashboardResponseSchema } from '@gic/contracts';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { CLOCK } from '../platform/clock.provider.js';
import { ID_GENERATOR } from '../platform/id-generator.provider.js';
import { RequiresPermission } from '../platform/http/authorization.decorators.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import { businessDateParam, parseOrThrow, ReadAccess, uuidParam } from '../read-api/read-access.js';
import { resolveDashboardPeriod } from '../read-api/dashboard-period.js';
import { buildDistributionDashboard } from './distribution-dashboard.service.js';
import { DISTRIBUTION_DASHBOARD_READ, resolveDashboardScope } from './dashboard-scope.js';

export { DISTRIBUTION_DASHBOARD_READ };
export { DASHBOARD_MAX_PERIOD_DAYS_KEY } from '../read-api/dashboard-period.js';

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

@Controller('api/v1')
export class DistributionDashboardController {
  private readonly access: ReadAccess;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) idGenerator: IdGenerator,
  ) {
    this.access = new ReadAccess(db, { clock, idGenerator }, DISTRIBUTION_DASHBOARD_READ);
  }

  @Get('analytics/dashboards/distribution')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(DISTRIBUTION_DASHBOARD_READ)
  async distribution(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(querySchema, rawQuery);
    const now = this.clock.now();
    await this.access.requirePermission(request, now, { type: 'DISTRIBUTION_DASHBOARD' });

    // Période (AV-207) : résolveur commun du module d'analyse (P9-16).
    const resolved = await resolveDashboardPeriod(this.db, now, query);
    const period = { code: resolved.code, fromDay: resolved.fromDay, toDay: resolved.toDay };

    // Périmètre (AV-204) : PDV que la permission atteint.
    const scope = await resolveDashboardScope(this.db, {
      userId: request.auth!.sub,
      at: now,
      ...(query.site_id !== undefined ? { siteId: query.site_id } : {}),
    });
    if (scope.status === 'SITE_NOT_VISIBLE') {
      return this.access.deny(
        request,
        now,
        { type: 'SITE', id: query.site_id! },
        'OUT_OF_SCOPE',
      );
    }

    // Un seul instantané pour toutes les lectures (comme `ledger-reconciliation.ts`) : une vente validée
    // entre la lecture du registre et celle de `sales` ferait afficher un faux écart de rapprochement.
    const response = await this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute((trx) =>
        buildDistributionDashboard(trx, {
          targets: scope.targets,
          period,
          now,
          ...(query.product_id !== undefined ? { productIds: [query.product_id] } : {}),
          visibility: scope.visibility,
          allSites: scope.allSites && query.site_id === undefined,
        }),
      );
    return distributionDashboardResponseSchema.parse(response);
  }
}
