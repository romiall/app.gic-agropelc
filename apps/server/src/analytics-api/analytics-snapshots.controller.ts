/**
 * `GET /api/v1/analytics/snapshots/me` (P9-18 ; ADR-076 §5 à §7, AT-054) : les instantanés personnels d'indicateurs de
 * l'appelant — un par `(tableau, période)` —, avec leur date de calcul (« à jour au »). Route **propre à
 * l'appelant** (`@SelfScoped()`) : l'identité vient du jeton, jamais d'un paramètre, donc jamais l'instantané d'un
 * autre. Même contenu que le jeu hors ligne `kpi` : la route sert aux clients en ligne et aux tests.
 */
import { Controller, Get, HttpCode, Inject, Req, UseGuards } from '@nestjs/common';
import { kpiSnapshotSchema, dashboardKpiSchema } from '@gic/contracts';
import { z } from 'zod';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { SelfScoped } from '../platform/http/authorization.decorators.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import { listSnapshotsOf } from '../modules/analytics/application/public/index.js';

const snapshotsResponseSchema = z.object({ snapshots: z.array(kpiSnapshotSchema) });

@Controller('api/v1')
export class AnalyticsSnapshotsController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get('analytics/snapshots/me')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @SelfScoped()
  async mine(@Req() request: AuthenticatedRequest) {
    const rows = await listSnapshotsOf(this.db, request.auth!.sub);
    return snapshotsResponseSchema.parse({
      snapshots: rows.map((row) => ({
        scopeKey: row.scopeKey,
        periodKey: row.periodKey,
        computedAt: row.computedAt.toISOString(),
        kpis: row.kpis.map((kpi) => dashboardKpiSchema.parse(kpi)),
      })),
    });
  }
}
