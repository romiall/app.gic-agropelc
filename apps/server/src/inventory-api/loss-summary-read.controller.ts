/**
 * Synthèse de la valeur des pertes (P8-11 ; ADR-044 §3 ; BR-FIN-044, KPI-FIN-08 ; AT-041) :
 * `GET /api/v1/losses/summary?from=&to=&group_by=product|lot|reason&site_id=`.
 *
 * Droit `inventory.loss.read` (AV-094 : encadrement dans son périmètre). Avec `site_id` : portée pleine
 * sur ce site (sinon 404 audité) ; sans `site_id` : portée `ALL` exigée (sinon 400, préciser le site).
 * Valeurs masquées sans `inventory.valuation.read` (RC-05). Période en jours métier de Douala.
 */
import { Controller, Get, HttpCode, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { businessDayEndUtc, businessDayStartUtc, type Clock, type IdGenerator } from '@gic/domain';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { CLOCK } from '../platform/clock.provider.js';
import { ID_GENERATOR } from '../platform/id-generator.provider.js';
import { ApiError } from '../platform/http/api-error.exception.js';
import { RequiresPermission } from '../platform/http/authorization.decorators.js';
import { recordDenied } from '../audit/record-denied.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import { evaluateAccess, hasPermissionAt } from '../modules/identity/application/public/index.js';
import { toBin } from '../platform/kysely/uuid-columns.js';
import { businessDateParam } from '../read-api/read-access.js';
import {
  LOSS_SUMMARY_GROUPS,
  lossValueSummary,
} from '../modules/inventory/application/public/index.js';

const LOSS_READ = 'inventory.loss.read';
const VALUATION_READ = 'inventory.valuation.read';

/** Jour métier existant au calendrier : une date impossible donne 400, jamais 500 (revue de P8-14). */
const businessDate = businessDateParam;
const querySchema = z.object({
  from: businessDate,
  to: businessDate,
  group_by: z.enum(LOSS_SUMMARY_GROUPS).default('product'),
  site_id: z.string().uuid().optional(),
});

/** Clé stable d'une ligne de synthèse (produit, lot ou motif). */
const lineKey = (line: {
  readonly productId: string | null;
  readonly productionLotId: string | null;
  readonly category: string | null;
  readonly reasonCodeId: string | null;
}): string =>
  [line.productId, line.productionLotId, line.category, line.reasonCodeId].join('|');

@Controller('api/v1')
export class LossSummaryReadController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
  ) {}

  private async deny(
    request: AuthenticatedRequest,
    now: Date,
    entityId: string | null,
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
        entityType: 'SITE',
        entityId,
        reason:
          reason === 'NO_PERMISSION'
            ? `Permission manquante : ${LOSS_READ}.`
            : `Hors portée : ${LOSS_READ}.`,
        errorCode: reason === 'NO_PERMISSION' ? 'FORBIDDEN' : 'NOT_FOUND',
      },
    );
    if (reason === 'NO_PERMISSION')
      throw new ApiError(403, 'FORBIDDEN', 'Droit insuffisant pour cette consultation.');
    throw new ApiError(404, 'NOT_FOUND', 'Ressource introuvable.');
  }

  @Get('losses/summary')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(LOSS_READ)
  async summary(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const parsed = querySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        `Paramètres de requête invalides : ${parsed.error.issues.map((i) => i.message).join(' ; ')}`,
      );
    }
    const query = parsed.data;
    if (query.to < query.from) throw new ApiError(400, 'VALIDATION_ERROR', 'Période invalide.');
    const now = this.clock.now();
    const userId = request.auth!.sub;
    if (!(await hasPermissionAt(this.db, toBin(userId), LOSS_READ, now))) {
      return this.deny(request, now, query.site_id ?? null, 'NO_PERMISSION');
    }
    const resource = query.site_id !== undefined ? { siteId: query.site_id } : {};
    const access = await evaluateAccess(this.db, {
      userId,
      permissionCode: LOSS_READ,
      occurredAt: now,
      resource,
    });
    if (!access.allowed) {
      if (query.site_id === undefined) {
        throw new ApiError(
          400,
          'VALIDATION_ERROR',
          'Préciser le site (site_id) : votre périmètre ne couvre pas tous les sites.',
        );
      }
      return this.deny(request, now, query.site_id, 'OUT_OF_SCOPE');
    }
    const valued = (
      await evaluateAccess(this.db, {
        userId,
        permissionCode: VALUATION_READ,
        occurredAt: now,
        resource,
      })
    ).allowed;
    const lines = await lossValueSummary(this.db, {
      fromUtc: businessDayStartUtc(query.from),
      toUtc: businessDayEndUtc(query.to),
      groupBy: query.group_by,
      ...(query.site_id !== undefined ? { siteIds: [query.site_id] } : {}),
    });
    return {
      from: query.from,
      to: query.to,
      group_by: query.group_by,
      // Sans valorisation (RC-05), ni la valeur ni l'ordre qu'elle donne : tri par quantité.
      lines: valued
        ? lines
        : [...lines]
            .sort(
              (a, b) =>
                b.quantityBase - a.quantityBase ||
                b.pendingQuantityBase - a.pendingQuantityBase ||
                lineKey(a).localeCompare(lineKey(b)),
            )
            .map((line) => ({ ...line, valueXaf: null, pendingValueXaf: null })),
      total_value_xaf: valued ? lines.reduce((sum, line) => sum + line.valueXaf, 0) : null,
    };
  }
}
