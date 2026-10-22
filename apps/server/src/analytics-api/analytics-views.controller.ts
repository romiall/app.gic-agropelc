/**
 * `GET /api/v1/analytics/views` et `GET /api/v1/analytics/views/{id}` (P9-19 ; UC-ANA-04, BR-ANA-007, ADR-077 §2,
 * AT-046). Les vues sauvegardées que le lecteur voit — les siennes et celles partagées avec l'un de ses rôles — avec leur
 * **exécutabilité** pour lui (`OK`, `OUTDATED`, `UNAVAILABLE`), calculée contre le catalogue et ses droits **sans lire
 * de données**. Une vue qu'il ne voit pas est introuvable (existence opaque, refus audité). L'exécution d'une vue est
 * `POST /analytics/query` avec `viewId` (explorateur) ; les écritures sont les commandes `analytics.view.*`.
 */
import { Controller, Get, HttpCode, Inject, Param, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { Clock, IdGenerator } from '@gic/domain';
import { savedViewSchema, explorationDefinitionSchema } from '@gic/contracts';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { CLOCK } from '../platform/clock.provider.js';
import { ID_GENERATOR } from '../platform/id-generator.provider.js';
import { RequiresPermission } from '../platform/http/authorization.decorators.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import {
  listReadableViews,
  readReadableView,
  type ReadableView,
} from '../modules/analytics/application/public/index.js';
import { ReadAccess, idParamSchema, parseOrThrow } from '../read-api/read-access.js';

export const ANALYTICS_EXPLORE = 'analytics.explore';

const listSchema = z.object({ views: z.array(savedViewSchema) });

function viewResponse(readable: ReadableView): z.input<typeof savedViewSchema> {
  const { view } = readable;
  return {
    id: view.id,
    name: view.name,
    dataset: view.dataset,
    // Une définition illisible (vue ancienne) reste listée : elle est `OUTDATED`, jamais cachée ni réécrite.
    definition: explorationDefinitionSchema.catch({
      dataset: view.dataset,
      dimensions: [],
      measures: ['unavailable'],
      filters: [],
      sort: [],
    }).parse(view.definition),
    catalogVersion: view.catalogVersion,
    ownerUserId: view.ownerUserId,
    sharedWithRoles: [...view.sharedWithRoles],
    isDefaultForRole: view.isDefaultForRole,
    executability: readable.executability,
    updatedAt: view.updatedAt.toISOString(),
  };
}

@Controller('api/v1')
export class AnalyticsViewsController {
  private readonly access: ReadAccess;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) idGenerator: IdGenerator,
  ) {
    this.access = new ReadAccess(db, { clock, idGenerator }, ANALYTICS_EXPLORE);
  }

  @Get('analytics/views')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ANALYTICS_EXPLORE)
  async list(@Req() request: AuthenticatedRequest) {
    const now = this.clock.now();
    await this.access.requirePermission(request, now, { type: 'ANALYTICS_VIEW' });
    const views = await listReadableViews(this.db, { userId: request.auth!.sub, at: now });
    return listSchema.parse({ views: views.map(viewResponse) });
  }

  @Get('analytics/views/:id')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ANALYTICS_EXPLORE)
  async one(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    await this.access.requirePermission(request, now, { type: 'ANALYTICS_VIEW', id });
    const readable = await readReadableView(this.db, {
      userId: request.auth!.sub,
      viewId: id,
      at: now,
    });
    if (readable === undefined) {
      return this.access.deny(request, now, { type: 'ANALYTICS_VIEW', id }, 'OUT_OF_SCOPE');
    }
    return savedViewSchema.parse(viewResponse(readable));
  }
}
