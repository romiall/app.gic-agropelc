/**
 * Lecture HTTP des rôles (MP-13, ECR-ADM-04 ; 08-api-events/01-architecture-api.md §4.1) : `GET /roles`.
 *
 * Droit : `identity.role_assignment.manage` (l'Admin seul, portée `ALL`, 01-rbac.md §5.1) — la liste ne
 * sert qu'à choisir le rôle d'une affectation. Les rôles sont figés par le seed (ADR-008, AV-257) : seuls
 * les rôles actifs sont rendus, avec les types de périmètre qu'ils permettent
 * (`allowed_scope_types`, contrôle de `identity.role_assignment.grant`). Aucune permission de rôle n'est
 * rendue ni modifiable depuis l'application.
 */
import { Controller, Get, HttpCode, Inject, Req, UseGuards } from '@nestjs/common';
import type { Clock, IdGenerator } from '@gic/domain';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { CLOCK } from '../platform/clock.provider.js';
import { ID_GENERATOR } from '../platform/id-generator.provider.js';
import { RequiresPermission } from '../platform/http/authorization.decorators.js';
import { fromBin } from '../platform/kysely/uuid-columns.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import { ReadAccess } from '../read-api/read-access.js';

const ROLE_ASSIGNMENT_MANAGE = 'identity.role_assignment.manage';

@Controller('api/v1')
export class RolesReadController {
  private readonly access: ReadAccess;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) idGenerator: IdGenerator,
  ) {
    this.access = new ReadAccess(db, { clock, idGenerator }, ROLE_ASSIGNMENT_MANAGE);
  }

  @Get('roles')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ROLE_ASSIGNMENT_MANAGE)
  async roles(@Req() request: AuthenticatedRequest) {
    await this.access.requirePermission(request, this.clock.now(), { type: 'ROLE' });
    const rows = await this.db
      .selectFrom('identity_roles')
      .select(['id', 'code', 'name', 'description', 'allowed_scope_types', 'is_system'])
      .where('is_active', '=', 1)
      .orderBy('name', 'asc')
      .orderBy('code', 'asc')
      .execute();
    return {
      roles: rows.map((row) => ({
        id: fromBin(row.id),
        code: row.code,
        name: row.name,
        description: row.description,
        allowedScopeTypes: row.allowed_scope_types as readonly string[],
        isSystem: Boolean(row.is_system),
      })),
    };
  }
}
