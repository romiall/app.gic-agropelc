/**
 * Lecture HTTP des comptes utilisateurs (MP-08, ECR-ADM-04 partiel ; 08-api-events/01-architecture-api.md
 * §4.1) : `GET /users`. Patron de MP-06 (`devices-read.controller.ts`).
 *
 * Droit : `identity.user.read` (01-rbac.md §5.1 : Direction, Admin, Finance en `ALL` ; Resp. commercial
 * `TEAM` ; Resp. production, Resp. ferme, magasinier `SITE`). Portée d'un compte : la personne elle-même
 * (titulaire), sur chacun des sites de ses affectations `SITE` et des zones de ses affectations `ZONE`
 * (`enrollerLocators`, la règle des appareils, BR-ADM-025) ; une portée `ALL` voit tout. La liste est
 * filtrée élément par élément : une page peut être plus courte que `limit`, suivre `next_cursor`.
 *
 * Chaque compte porte ses rôles actifs et l'action que le lecteur peut y faire (`actions.resetPassword` :
 * `identity.user.manage`, sauf son propre compte et un compte désactivé ; AV-252, AV-281). Jamais le
 * mot de passe ni son empreinte ; l'utilisateur système n'est jamais listé.
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
  USER_STATUSES,
  activeRoleAssignmentsAt,
  enrollerLocators,
  evaluateAccess,
  listUsersPage,
  locatorsInScope,
  type ResourceLocator,
  type UserSummary,
} from '../modules/identity/application/public/index.js';
import { parseOrThrow, ReadAccess, uuidParam } from '../read-api/read-access.js';

const USER_READ = 'identity.user.read';
const USER_MANAGE = 'identity.user.manage';
const USERS_DEFAULT_LIMIT = 50;
const USERS_MAX_LIMIT = 200;
/** Lectures successives au plus pour remplir une page filtrée par la portée. */
const MAX_SCANS = 10;

type UserScope = (permissionCode: string, user: UserSummary) => Promise<boolean>;

const usersQuerySchema = z.object({
  status: z.enum(USER_STATUSES).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  cursor: uuidParam.optional(),
  limit: z.coerce.number().int().positive().max(USERS_MAX_LIMIT).optional(),
});

@Controller('api/v1')
export class UsersReadController {
  private readonly access: ReadAccess;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) idGenerator: IdGenerator,
  ) {
    this.access = new ReadAccess(db, { clock, idGenerator }, USER_READ);
  }

  @Get('users')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(USER_READ)
  async users(@Query() rawQuery: unknown, @Req() request: AuthenticatedRequest) {
    const query = parseOrThrow(usersQuerySchema, rawQuery);
    const now = this.clock.now();
    await this.access.requirePermission(request, now, { type: 'USER' });
    const readerId = request.auth!.sub;
    const limit = query.limit ?? USERS_DEFAULT_LIMIT;
    const scope = this.scopeOf(readerId, now);
    const visible: UserSummary[] = [];
    let cursor = query.cursor;
    let nextCursor: string | null = null;
    for (let scan = 0; scan < MAX_SCANS; scan++) {
      const page = await listUsersPage(this.db, {
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.q !== undefined ? { query: query.q } : {}),
        ...(cursor !== undefined ? { beforeId: cursor } : {}),
        limit,
      });
      let stoppedAt: number | null = null;
      for (const [index, user] of page.items.entries()) {
        if (await scope(USER_READ, user)) {
          visible.push(user);
          if (visible.length === limit) {
            stoppedAt = index;
            break;
          }
        }
      }
      if (stoppedAt !== null) {
        const hasMoreInPage = stoppedAt < page.items.length - 1;
        nextCursor = hasMoreInPage || page.nextCursor !== null ? visible.at(-1)!.id : null;
        break;
      }
      if (page.nextCursor === null) {
        nextCursor = null;
        break;
      }
      cursor = page.nextCursor;
      // Lectures épuisées sans remplir la page : la suite reprend après le dernier lu.
      nextCursor = page.nextCursor;
    }
    return { users: await this.present(readerId, now, scope, visible), next_cursor: nextCursor };
  }

  /**
   * Portée pour une requête : une portée `ALL` est reconnue une fois par permission ; les ressources de
   * chaque compte (lui-même, ses sites, les sites de ses zones) sont lues une fois.
   */
  private scopeOf(readerId: string, at: Date): UserScope {
    const everything = new Map<string, Promise<boolean>>();
    const locators = new Map<string, Promise<readonly ResourceLocator[]>>();
    const hasAll = (permissionCode: string) => {
      let known = everything.get(permissionCode);
      if (!known) {
        known = evaluateAccess(this.db, {
          userId: readerId,
          permissionCode,
          occurredAt: at,
          resource: {},
        }).then((result) => result.allowed);
        everything.set(permissionCode, known);
      }
      return known;
    };
    const locatorsOf = (user: UserSummary) => {
      let known = locators.get(user.id);
      if (!known) {
        known = enrollerLocators(this.db, user.id, at);
        locators.set(user.id, known);
      }
      return known;
    };
    return async (permissionCode, user) =>
      (await hasAll(permissionCode)) ||
      locatorsInScope(this.db, {
        userId: readerId,
        permissionCode,
        at,
        locators: await locatorsOf(user),
      });
  }

  /** Rôles actifs et action permise au lecteur. */
  private async present(
    readerId: string,
    now: Date,
    scope: UserScope,
    users: readonly UserSummary[],
  ) {
    const presented = [];
    for (const user of users) {
      const roles = await activeRoleAssignmentsAt(this.db, user.id, now);
      presented.push({
        id: user.id,
        fullName: user.fullName,
        phone: user.phone,
        email: user.email,
        status: user.status,
        statusChangedAt: user.statusChangedAt?.toISOString() ?? null,
        mustChangePassword: user.mustChangePassword,
        lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
        createdAt: user.createdAt.toISOString(),
        roles: [...new Set(roles.map((assignment) => assignment.roleCode))].sort(),
        actions: {
          resetPassword:
            user.id !== readerId &&
            user.status !== 'DEACTIVATED' &&
            (await scope(USER_MANAGE, user)),
        },
      });
    }
    return presented;
  }
}
