/**
 * Lectures HTTP du pointage (P3-06 ; 08-api-events/01-architecture-api.md §4.4 :
 * `GET /work-sessions?team_id=&date=`). Composition transport hors du module (même précédent
 * qu'`inventory-api/`).
 *
 * Renvoie, pour un jour métier (Douala, défaut : aujourd'hui), les sessions de travail et **toutes
 * les tentatives** de pointage, acceptées ou refusées (INV-TER-02 : présence et audit des refus,
 * ECR-TER-01/02). Ancrage : `user_id` (défaut : soi-même) ou `team_id` (membres de l'équipe à la
 * date). Portée `fieldwork.session.read` évaluée par utilisateur (RC-04 : titulaire = l'agent,
 * zone déclarée) ; ses propres sessions se lisent avec la seule permission (DÉDUIT, comme les
 * lectures « de soi » du CRM). Droit absent ⇒ 403 audité.
 */
import { Controller, Get, HttpCode, Inject, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import {
  businessDayEndUtc,
  businessDayOf,
  businessDayStartUtc,
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
  evaluateAccess,
  hasPermissionAt,
  listConfinementAt,
} from '../modules/identity/application/public/index.js';
import { businessDateParam } from '../read-api/read-access.js';
import { listTeamMembersAt } from '../modules/organization/application/public/index.js';
import { toBin } from '../platform/kysely/uuid-columns.js';
import {
  PRESENCE_LIST_MAX_LIMIT,
  listCheckins,
  listPresenceSheets,
  listWorkSessions,
} from '../modules/fieldwork/application/public/index.js';

const SESSION_READ = 'fieldwork.session.read';
const PRESENCE_READ = 'fieldwork.presence.read';

const presenceQuerySchema = z.object({
  site_id: z.string().uuid().optional(),
  week_start: businessDateParam.optional(),
  from_week: businessDateParam.optional(),
  to_week: businessDateParam.optional(),
  include_cancelled: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().positive().max(PRESENCE_LIST_MAX_LIMIT).optional(),
});

const querySchema = z.object({
  user_id: z.union([z.literal('me'), z.string().uuid()]).optional(),
  team_id: z.string().uuid().optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date attendue au format AAAA-MM-JJ.')
    .optional(),
});

@Controller('api/v1')
export class FieldworkReadController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
  ) {}

  @Get('work-sessions')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(SESSION_READ)
  async workSessions(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const parsed = querySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        `Paramètres de requête invalides : ${parsed.error.issues.map((i) => i.message).join(' ; ')}`,
      );
    }
    const query = parsed.data;
    const now = this.clock.now();
    const me = request.auth!.sub;
    if (!(await hasPermissionAt(this.db, toBin(me), SESSION_READ, now))) {
      await recordDenied(
        this.db,
        { idGenerator: this.idGenerator, clock: this.clock },
        {
          occurredAt: now,
          actorUserId: me,
          actorRoles: [],
          deviceId: request.auth!.device_id,
          action: 'access.denied',
          entityType: 'WORK_SESSION',
          entityId: null,
          reason: `Permission manquante : ${SESSION_READ}.`,
          errorCode: 'FORBIDDEN',
        },
      );
      throw new ApiError(403, 'FORBIDDEN', 'Droit insuffisant pour cette consultation.');
    }
    const day = query.date ?? businessDayOf(now);
    const userIds =
      query.team_id !== undefined
        ? await listTeamMembersAt(this.db, query.team_id, now)
        : [query.user_id === undefined || query.user_id === 'me' ? me : query.user_id];
    const range = { userIds, fromUtc: businessDayStartUtc(day), toUtc: businessDayEndUtc(day) };
    const sessions = await listWorkSessions(this.db, range);
    const checkins = await listCheckins(this.db, range);

    const readable = new Map<string, boolean>();
    const canRead = async (userId: string, zoneId: string): Promise<boolean> => {
      if (userId === me) return true;
      const key = `${userId}:${zoneId}`;
      if (!readable.has(key)) {
        const access = await evaluateAccess(this.db, {
          userId: me,
          permissionCode: SESSION_READ,
          occurredAt: now,
          resource: { ownerUserId: userId, zoneId },
        });
        readable.set(key, access.allowed);
      }
      return readable.get(key)!;
    };
    const visibleSessions = [];
    for (const session of sessions) {
      if (await canRead(session.userId, session.declaredZoneId)) visibleSessions.push(session);
    }
    const visibleCheckins = [];
    for (const checkin of checkins) {
      if (await canRead(checkin.userId, checkin.declaredZoneId)) visibleCheckins.push(checkin);
    }
    return { date: day, sessions: visibleSessions, checkins: visibleCheckins };
  }

  /**
   * Feuilles de présence du personnel (fiche PT ; PP-E, REQ-306, AV-313) : `GET /staff-presence?site_id=&week_start=`.
   * Portée `fieldwork.presence.read` jugée sur le site de chaque feuille ; sans portée `ALL` et sans `site_id`, les
   * sites d'affectation de l'utilisateur. Droit absent ⇒ 403 audité ; feuille hors portée ⇒ absente de la liste.
   */
  @Get('staff-presence')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(PRESENCE_READ)
  async staffPresence(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const parsed = presenceQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        `Paramètres de requête invalides : ${parsed.error.issues.map((i) => i.message).join(' ; ')}`,
      );
    }
    const query = parsed.data;
    const now = this.clock.now();
    const me = request.auth!.sub;
    if (!(await hasPermissionAt(this.db, toBin(me), PRESENCE_READ, now))) {
      await recordDenied(
        this.db,
        { idGenerator: this.idGenerator, clock: this.clock },
        {
          occurredAt: now,
          actorUserId: me,
          actorRoles: [],
          deviceId: request.auth!.device_id,
          action: 'access.denied',
          entityType: 'PRESENCE_SHEET',
          entityId: null,
          reason: `Permission manquante : ${PRESENCE_READ}.`,
          errorCode: 'FORBIDDEN',
        },
      );
      throw new ApiError(403, 'FORBIDDEN', 'Droit insuffisant pour cette consultation.');
    }
    // Pré-filtre par site (sûr, un sur-ensemble) : `null` quand aucun n'est possible (portée `ALL`, ou `SITE` sous une
    // affectation globale comme le responsable de production : tous les sites), sinon les sites des octrois. Chaque
    // feuille est ensuite jugée sur son site (RC-04).
    const confinement = await listConfinementAt(this.db, me, PRESENCE_READ, now);
    const confinedSites = confinement === null ? undefined : confinement.siteIds;
    const siteIds =
      query.site_id !== undefined
        ? confinedSites === undefined || confinedSites.includes(query.site_id)
          ? [query.site_id]
          : []
        : confinedSites;
    const sheets = await listPresenceSheets(this.db, {
      ...(siteIds !== undefined ? { siteIds } : {}),
      ...(query.week_start !== undefined ? { weekStart: query.week_start } : {}),
      ...(query.from_week !== undefined ? { fromWeek: query.from_week } : {}),
      ...(query.to_week !== undefined ? { toWeek: query.to_week } : {}),
      includeCancelled: query.include_cancelled === 'true',
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
    const readable = new Map<string, boolean>();
    const visible = [];
    for (const sheet of sheets) {
      if (!readable.has(sheet.siteId)) {
        const access = await evaluateAccess(this.db, {
          userId: me,
          permissionCode: PRESENCE_READ,
          occurredAt: now,
          resource: { siteId: sheet.siteId },
        });
        readable.set(sheet.siteId, access.allowed);
      }
      if (readable.get(sheet.siteId)) visible.push(sheet);
    }
    return { sheets: visible };
  }
}
