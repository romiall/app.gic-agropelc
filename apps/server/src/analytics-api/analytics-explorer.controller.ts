/**
 * `POST /api/v1/analytics/query` et `GET /api/v1/analytics/catalog` (P9-14 ; UC-ANA-03, BR-ANA-004, 006, 007, 009 ;
 * ADR-074 ; AV-421 à AV-425). L'explorateur : une définition déclarative (jeu, dimensions, mesures, filtres, tri,
 * limite), ou une vue sauvegardée à exécuter, validée par le catalogue du domaine puis compilée en SQL sur la vue
 * `analytics_f_*` du jeu — jamais de SQL libre.
 *
 * Droits (cumulatifs) :
 * - `analytics.explore` ouvre l'outil ; **chaque permission de lecture du jeu** (`dataset.permissions`) ouvre ses
 *   données, et `inventory.valuation.read` ouvre une mesure au coût ; le jeu est jugé **ligne à ligne** par
 *   l'étendue exacte de chacune (intersection, `resolveExactScope`), jamais par le pré-filtre `listConfinementAt`.
 * - Une vue sauvegardée s'exécute avec les droits de **l'exécutant**, jamais ceux de son propriétaire (BR-ANA-007) ;
 *   un champ disparu la rend `OUTDATED` (409, jamais de réécriture silencieuse).
 *
 * Refus et limites : 400 (définition), 403 (`FORBIDDEN`, `FORBIDDEN_MEASURE`, audités), 422 (`QUERY_LIMIT_EXCEEDED`,
 * détail `limit` = `rows` ou `time`), 429 (`QUERY_LIMIT_EXCEEDED`, détail `limit` = `concurrency`). Chaque requête,
 * refus compris, laisse une ligne du journal technique `analytics_query_log` (ADR-074 §10).
 */
import type { z } from 'zod';
import { Body, Controller, Get, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import {
  ANALYTICS_CATALOG_VERSION,
  ANALYTICS_DATASETS,
  businessDayOf,
  datasetOf,
  validateExploration,
  type Clock,
  type DatasetDefinition,
  type ExplorationDefinition,
  type ExplorationErrorCode,
  type ExplorationPlan,
  type IdGenerator,
} from '@gic/domain';
import {
  analyticsCatalogResponseSchema,
  analyticsQueryRequestSchema,
  analyticsQueryResponseSchema,
  catalogDatasetView,
  explorationDefinitionSchema,
} from '@gic/contracts';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { CLOCK } from '../platform/clock.provider.js';
import { ID_GENERATOR } from '../platform/id-generator.provider.js';
import { ApiError } from '../platform/http/api-error.exception.js';
import { RequiresPermission } from '../platform/http/authorization.decorators.js';
import { toBin, fromBin } from '../platform/kysely/uuid-columns.js';
import { recordDenied } from '../audit/record-denied.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import {
  activeRoleCodesAt,
  hasPermissionAt,
} from '../modules/identity/application/public/index.js';
import {
  compileExploration,
  ExplorationLimitError,
  readExplorerLimits,
  recordQueryLog,
  resolveExactScope,
  runExploration,
  type ExactScope,
  type QueryOutcome,
} from '../modules/analytics/application/public/index.js';
import { ReadAccess, parseOrThrow } from '../read-api/read-access.js';
import { explorerFreshness } from './explorer-freshness.js';

export const ANALYTICS_EXPLORE = 'analytics.explore';
export const VALUATION_READ = 'inventory.valuation.read';

/** Statut HTTP d'une erreur de validation de l'exploration. */
const VALIDATION_STATUS: Readonly<Record<ExplorationErrorCode, number>> = {
  ANALYTICS_FIELD_UNKNOWN: 400,
  ANALYTICS_DEFINITION_INVALID: 400,
  ANALYTICS_MIXED_PERIOD_BASIS: 400,
  ANALYTICS_PERIOD_REQUIRED: 400,
  PERIOD_TOO_LONG: 400,
  FORBIDDEN_MEASURE: 403,
  QUERY_LIMIT_EXCEEDED: 422,
};

/** Le jeu est-il perdu pour la vue (champ disparu ou définition devenue invalide) ? */
const OUTDATED_CODES: readonly ExplorationErrorCode[] = [
  'ANALYTICS_FIELD_UNKNOWN',
  'ANALYTICS_DEFINITION_INVALID',
];

/** La définition reçue, sans propriété vide (`exactOptionalPropertyTypes`). */
function definitionFrom(input: z.input<typeof explorationDefinitionSchema>): ExplorationDefinition {
  return {
    dataset: input.dataset,
    ...(input.period !== undefined
      ? {
          period: {
            code: input.period.code,
            ...(input.period.fromDay !== undefined ? { fromDay: input.period.fromDay } : {}),
            ...(input.period.toDay !== undefined ? { toDay: input.period.toDay } : {}),
          },
        }
      : {}),
    dimensions: input.dimensions ?? [],
    measures: input.measures,
    filters: input.filters ?? [],
    sort: input.sort ?? [],
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  };
}

/**
 * Document source d'une ligne (BR-ANA-010, niveau 2 ; P9-21) : présent quand l'exploration regroupe par la dimension
 * du document du jeu (`dataset.source`) et que la ligne la renseigne ; `null` sinon (ligne agrégée).
 */
export function sourceOf(
  dataset: DatasetDefinition,
  values: Readonly<Record<string, string | number | boolean | null>>,
): { readonly type: string; readonly id: string; readonly route: string } | null {
  const source = dataset.source;
  if (source === undefined) return null;
  const id = values[source.dimension];
  if (typeof id !== 'string' || id === '') return null;
  return { type: source.type, id, route: source.route.replace('{id}', id) };
}

interface RequestContext {
  readonly request: AuthenticatedRequest;
  readonly userId: string;
  readonly now: Date;
  readonly startedAt: bigint;
}

@Controller('api/v1')
export class AnalyticsExplorerController {
  private readonly explore: ReadAccess;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
  ) {
    this.explore = new ReadAccess(db, { clock, idGenerator }, ANALYTICS_EXPLORE);
  }

  @Get('analytics/catalog')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ANALYTICS_EXPLORE)
  async catalog(@Req() request: AuthenticatedRequest) {
    const now = this.clock.now();
    await this.explore.requirePermission(request, now, { type: 'ANALYTICS_CATALOG' });
    const userId = toBin(request.auth!.sub);
    const canReadValuation = await hasPermissionAt(this.db, userId, VALUATION_READ, now);
    const datasets: DatasetDefinition[] = [];
    for (const dataset of ANALYTICS_DATASETS) {
      let readable = true;
      for (const permission of dataset.permissions) {
        if (!(await hasPermissionAt(this.db, userId, permission, now))) {
          readable = false;
          break;
        }
      }
      if (readable) datasets.push(dataset);
    }
    return analyticsCatalogResponseSchema.parse({
      version: ANALYTICS_CATALOG_VERSION,
      datasets: datasets.map((dataset) => catalogDatasetView(dataset, canReadValuation)),
    });
  }

  @Post('analytics/query')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ANALYTICS_EXPLORE)
  async query(@Body() rawBody: unknown, @Req() request: AuthenticatedRequest) {
    const body = parseOrThrow(analyticsQueryRequestSchema, rawBody);
    const context: RequestContext = {
      request,
      userId: request.auth!.sub,
      now: this.clock.now(),
      startedAt: process.hrtime.bigint(),
    };
    await this.explore.requirePermission(request, context.now, { type: 'ANALYTICS_QUERY' });

    // La définition : reçue, ou celle d'une vue sauvegardée visible de l'exécutant.
    const view = body.viewId === undefined ? undefined : await this.loadView(context, body.viewId);
    const definition: ExplorationDefinition =
      view !== undefined ? view.definition : definitionFrom(body.definition!);
    const log = (
      outcome: QueryOutcome,
      extra: {
        readonly errorCode?: string;
        readonly rowCount?: number;
        readonly plan?: ExplorationPlan;
        readonly scopeTruncated?: boolean;
      } = {},
    ) =>
      recordQueryLog(this.db, {
        id: this.idGenerator.newId(),
        userId: context.userId,
        dataset: definition.dataset,
        definition: {
          definition,
          ...(body.viewId !== undefined ? { viewId: body.viewId } : {}),
          catalogVersion: ANALYTICS_CATALOG_VERSION,
          period:
            extra.plan?.period == null
              ? null
              : {
                  code: extra.plan.period.code,
                  fromDay: extra.plan.period.fromDay,
                  toDay: extra.plan.period.toDay,
                },
          ...(extra.scopeTruncated ? { scopeTruncated: true } : {}),
        },
        outcome,
        ...(extra.errorCode !== undefined ? { errorCode: extra.errorCode } : {}),
        ...(extra.rowCount !== undefined ? { rowCount: extra.rowCount } : {}),
        durationMs: Number((process.hrtime.bigint() - context.startedAt) / 1_000_000n),
      });

    const limits = await readExplorerLimits(this.db, context.now);
    const userBin = toBin(context.userId);

    // 1. Le droit de lire le jeu (toutes ses permissions) avant d'en dire quoi que ce soit.
    const target = datasetOf(definition.dataset);
    if (target !== undefined) {
      for (const permission of target.permissions) {
        if (!(await hasPermissionAt(this.db, userBin, permission, context.now))) {
          await log('REFUSED', { errorCode: 'FORBIDDEN' });
          return this.refuse(
            context,
            definition.dataset,
            permission,
            'FORBIDDEN',
            403,
            'Droit insuffisant pour consulter ce jeu de données.',
          );
        }
      }
    }

    // 2. La définition contre le catalogue, les limites et le droit de valorisation.
    const canReadValuation = await hasPermissionAt(this.db, userBin, VALUATION_READ, context.now);
    const validation = validateExploration(definition, {
      today: businessDayOf(context.now),
      canReadValuation,
      maxDetailDays: limits.maxDetailDays,
      maxRows: limits.maxRows,
    });
    if (!validation.ok) {
      const outdated = view !== undefined && OUTDATED_CODES.includes(validation.code);
      const code = outdated ? 'VIEW_OUTDATED' : validation.code;
      await log(validation.code === 'QUERY_LIMIT_EXCEEDED' ? 'LIMIT' : 'REFUSED', {
        errorCode: code,
      });
      if (validation.code === 'FORBIDDEN_MEASURE') {
        return this.refuse(
          context,
          definition.dataset,
          VALUATION_READ,
          'FORBIDDEN_MEASURE',
          403,
          validation.message,
        );
      }
      throw new ApiError(
        outdated ? 409 : VALIDATION_STATUS[validation.code],
        code,
        outdated ? `La vue n’est plus exécutable : ${validation.message}` : validation.message,
        {
          ...(validation.field !== undefined ? { field: validation.field } : {}),
          ...(validation.code === 'QUERY_LIMIT_EXCEEDED' ? { limit: 'rows' } : {}),
          ...(outdated ? { view_id: body.viewId } : {}),
        },
      );
    }
    const plan = validation.plan;

    // 3. Les permissions de lecture : celles du jeu, et celle des valeurs au coût si une mesure l'exige.
    const permissions = [
      ...new Set([
        ...plan.dataset.permissions,
        ...(plan.measures.some((measure) => measure.protected === true) ? [VALUATION_READ] : []),
      ]),
    ];
    const scopes: ExactScope[] = [];
    for (const permission of permissions) {
      scopes.push(
        await resolveExactScope(
          this.db,
          { userId: context.userId, permission, at: context.now },
          { maxCandidates: limits.scopeMaxCandidates },
        ),
      );
    }
    const scopeTruncated = scopes.some((scope) => scope.kind === 'CLAUSES' && scope.truncated);

    // 4. Le calcul, borné en lignes, en durée et en requêtes simultanées.
    const compiled = compileExploration(plan, scopes, { maxExecutionMs: limits.maxExecutionMs });
    let result;
    try {
      result = await runExploration(this.db, { userId: context.userId, compiled, limits });
    } catch (error) {
      if (error instanceof ExplorationLimitError) {
        await log('LIMIT', { errorCode: 'QUERY_LIMIT_EXCEEDED', plan, scopeTruncated });
        throw new ApiError(
          error.limit === 'concurrency' ? 429 : 422,
          'QUERY_LIMIT_EXCEEDED',
          error.message,
          { limit: error.limit },
        );
      }
      await log('ERROR', { errorCode: 'QUERY_FAILED', plan, scopeTruncated });
      throw error;
    }

    const freshness = await explorerFreshness(this.db, { scope: scopes[0], now: context.now });
    await log('OK', { rowCount: result.rowCount, plan, scopeTruncated });
    return analyticsQueryResponseSchema.parse({
      dataset: plan.dataset.code,
      catalogVersion: plan.catalogVersion,
      period:
        plan.period === null
          ? null
          : {
              code: plan.period.code,
              fromDay: plan.period.fromDay,
              toDay: plan.period.toDay,
              days: plan.period.days,
            },
      columns: result.columns.map((column) => ({
        name: column.name,
        label: column.label,
        kind: column.kind,
        ...(column.unit !== undefined ? { unit: column.unit } : {}),
        ...(column.dimensionType !== undefined ? { dimensionType: column.dimensionType } : {}),
      })),
      rows: result.rows.map((values) => ({ values, source: sourceOf(plan.dataset, values) })),
      rowCount: result.rowCount,
      totals: result.totals,
      freshness,
      scopeTruncated,
    });
  }

  /** Un refus de droit : audité (`access.denied`, RC-09), jamais silencieux. */
  private async refuse(
    context: RequestContext,
    dataset: string,
    permission: string,
    code: 'FORBIDDEN' | 'FORBIDDEN_MEASURE',
    status: number,
    message: string,
  ): Promise<never> {
    await recordDenied(
      this.db,
      { clock: this.clock, idGenerator: this.idGenerator },
      {
        occurredAt: context.now,
        actorUserId: context.userId,
        actorRoles: [],
        deviceId: context.request.auth!.device_id,
        action: 'access.denied',
        entityType: 'ANALYTICS_DATASET',
        entityId: null,
        reason: `Permission manquante : ${permission} (jeu ${dataset}).`,
        errorCode: code,
      },
    );
    throw new ApiError(status, code, message);
  }

  /** Une vue sauvegardée visible de l'exécutant : la sienne, ou partagée avec un de ses rôles (BR-ANA-007). */
  private async loadView(
    context: RequestContext,
    viewId: string,
  ): Promise<{ readonly definition: ExplorationDefinition }> {
    const row = await this.db
      .selectFrom('analytics_saved_views')
      .select(['owner_user_id', 'definition', 'shared_with_roles'])
      .where('id', '=', toBin(viewId))
      .executeTakeFirst();
    const shared = Array.isArray(row?.shared_with_roles)
      ? (row.shared_with_roles as unknown[]).filter(
          (role): role is string => typeof role === 'string',
        )
      : [];
    const visible =
      row !== undefined &&
      (fromBin(row.owner_user_id) === context.userId ||
        (shared.length > 0 &&
          (await activeRoleCodesAt(this.db, context.userId, context.now)).some((code) =>
            shared.includes(code),
          )));
    if (!visible) {
      await this.explore.deny(
        context.request,
        context.now,
        { type: 'SAVED_VIEW', id: viewId },
        'OUT_OF_SCOPE',
      );
    }
    const parsed = explorationDefinitionSchema.safeParse(row!.definition);
    if (!parsed.success) {
      throw new ApiError(
        409,
        'VIEW_OUTDATED',
        'La vue n’est plus exécutable : définition illisible.',
        {
          view_id: viewId,
        },
      );
    }
    return { definition: definitionFrom(parsed.data) };
  }
}
