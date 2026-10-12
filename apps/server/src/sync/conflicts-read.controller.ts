/**
 * Lecture des conflits de synchronisation (P5-17 ; 08-api-events/01-architecture-api.md §4.11) :
 * `GET /sync/conflicts`, `/sync/conflicts/{id}` — la file de résolution de la Finance, du magasinier et
 * des autres rôles propriétaires (matrice des conflits §3). Patron de P4-10 (`read-api/read-access.ts`).
 *
 * Droit (AV-189) : `sync.conflict.resolve` — la file sert à traiter ; `sync.monitor.read` (supervision)
 * n'est détenu ni par la Finance ni par le Resp. achats. Visibilité (AV-191, `conflict-access.ts`) : rôle
 * propriétaire du conflit parmi ceux de l'utilisateur, puis portée sur le site et l'auteur. Statut par
 * défaut : `OPEN`. Hors visibilité ⇒ absent de la liste, 404 audité pour une fiche ; droit absent ⇒ 403.
 */
import { Controller, Get, HttpCode, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { Clock, IdGenerator } from '@gic/domain';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { CLOCK } from '../platform/clock.provider.js';
import { ID_GENERATOR } from '../platform/id-generator.provider.js';
import { RequiresPermission } from '../platform/http/authorization.decorators.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import {
  CONFLICT_STATUSES,
  findConflict,
  listConflicts,
  type ConflictRecord,
} from '../platform/sync/conflicts.js';
import { idParamSchema, parseOrThrow, ReadAccess, uuidParam } from '../read-api/read-access.js';
import { CONFLICT_RESOLVE, conflictOwnerRolesOf, conflictVisible } from './conflict-access.js';

const CONFLICT_LIST_DEFAULT_LIMIT = 50;
const CONFLICT_LIST_MAX_LIMIT = 200;

const conflictsQuerySchema = z.object({
  status: z.enum(CONFLICT_STATUSES).optional(),
  conflict_type: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/, 'Type de conflit attendu en majuscules.')
    .max(40)
    .optional(),
  site_id: uuidParam.optional(),
  entity_id: uuidParam.optional(),
  cursor: uuidParam.optional(),
  limit: z.coerce.number().int().positive().max(CONFLICT_LIST_MAX_LIMIT).optional(),
});

@Controller('api/v1/sync')
export class ConflictsReadController {
  private readonly access: ReadAccess;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) idGenerator: IdGenerator,
  ) {
    this.access = new ReadAccess(db, { clock, idGenerator }, CONFLICT_RESOLVE);
  }

  @Get('conflicts')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(CONFLICT_RESOLVE)
  async conflicts(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(conflictsQuerySchema, rawQuery);
    const now = this.clock.now();
    const userId = request.auth!.sub;
    await this.access.requirePermission(request, now, { type: 'SYNC_CONFLICT' });
    const ownerRoles = await conflictOwnerRolesOf(this.db, userId, now);
    // Pré-filtre sûr (sur-ensemble) : sites et auteurs couverts par les octrois, plus les conflits
    // système ; chaque conflit est ensuite évalué sur l'affectation de son rôle propriétaire.
    const confinement = await this.access.confinement(request, now);
    const page = await listConflicts(this.db, {
      status: query.status ?? 'OPEN',
      ...(ownerRoles !== 'ALL' ? { ownerRoles } : {}),
      ...(query.site_id !== undefined ? { siteIds: [query.site_id] } : {}),
      ...(confinement !== null
        ? {
            confinement: {
              siteIds: confinement.siteIds,
              authorUserIds: confinement.ownerUserIds,
            },
          }
        : {}),
      ...(query.conflict_type !== undefined ? { conflictType: query.conflict_type } : {}),
      ...(query.entity_id !== undefined ? { entityId: query.entity_id } : {}),
      ...(query.cursor !== undefined ? { beforeId: query.cursor } : {}),
      limit: query.limit ?? CONFLICT_LIST_DEFAULT_LIMIT,
    });
    const kept: ConflictRecord[] = [];
    for (const conflict of page.items) {
      if (await conflictVisible(this.db, { userId, at: now, conflict })) {
        kept.push(conflict);
      }
    }
    return { conflicts: kept, next_cursor: page.nextCursor };
  }

  @Get('conflicts/:id')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(CONFLICT_RESOLVE)
  async conflict(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    const entity = { type: 'SYNC_CONFLICT', id };
    await this.access.requirePermission(request, now, entity);
    const conflict = await findConflict(this.db, id);
    if (
      !conflict ||
      !(await conflictVisible(this.db, { userId: request.auth!.sub, at: now, conflict }))
    ) {
      return this.access.deny(request, now, entity, 'OUT_OF_SCOPE');
    }
    return { conflict };
  }
}
