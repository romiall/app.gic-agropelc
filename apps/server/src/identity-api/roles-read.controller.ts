/**
 * Lecture HTTP des rôles (MP-13, ECR-ADM-04 ; 08-api-events/01-architecture-api.md §4.1) : `GET /roles`.
 *
 * Droit : `identity.role_assignment.manage` (l'Admin seul, portée `ALL`, 01-rbac.md §5.1) — la liste ne
 * sert qu'à choisir le rôle d'une affectation : seuls les rôles actifs sont rendus, avec les types de périmètre
 * qu'ils permettent (`allowed_scope_types`, contrôle de `identity.role_assignment.grant`).
 *
 * Éditeur des droits des rôles (questionnaire de clôture, Q28 du 08/11/2026 ; ADR-072) : `GET /roles/editable` et
 * `GET /roles/{id}/permissions`, au droit `identity.role.manage` (Admin et Direction). Le détail d'un rôle rend le
 * catalogue des permissions avec la portée accordée au rôle, les portées que le lecteur peut donner et s'il peut
 * retirer (même règle que la commande, `judgeRolePermissionChange`), et les derniers changements du journal.
 */
import { Controller, Get, HttpCode, Inject, Param, Req, UseGuards } from '@nestjs/common';
import {
  PROTECTED_PERMISSION_CODES,
  PROTECTED_ROLE_CODES,
  grantableScopes,
  heldScopesCover,
  isPermissionScope,
  type Clock,
  type IdGenerator,
  type PermissionScope,
} from '@gic/domain';
import { DATABASE, type Database } from '../platform/kysely/database.provider.js';
import { CLOCK } from '../platform/clock.provider.js';
import { ID_GENERATOR } from '../platform/id-generator.provider.js';
import { RequiresPermission } from '../platform/http/authorization.decorators.js';
import { fromBin, toBin } from '../platform/kysely/uuid-columns.js';
import { AuthGuard, type AuthenticatedRequest } from '../modules/identity/api/auth.guard.js';
import { heldGlobalScopes } from '../modules/identity/application/rbac/rbac-cache.js';
import { idParamSchema, parseOrThrow, ReadAccess } from '../read-api/read-access.js';

const ROLE_ASSIGNMENT_MANAGE = 'identity.role_assignment.manage';
const ROLE_MANAGE = 'identity.role.manage';
/** Derniers changements rendus avec le détail d'un rôle. */
const CHANGES_LIMIT = 100;

const scopesOf = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((scope): scope is string => typeof scope === 'string') : [];

@Controller('api/v1')
export class RolesReadController {
  private readonly access: ReadAccess;
  private readonly manageAccess: ReadAccess;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) idGenerator: IdGenerator,
  ) {
    this.access = new ReadAccess(db, { clock, idGenerator }, ROLE_ASSIGNMENT_MANAGE);
    this.manageAccess = new ReadAccess(db, { clock, idGenerator }, ROLE_MANAGE);
  }

  @Get('roles/editable')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ROLE_MANAGE)
  async editableRoles(@Req() request: AuthenticatedRequest) {
    await this.manageAccess.requirePermission(request, this.clock.now(), { type: 'ROLE' });
    const rows = await this.db
      .selectFrom('identity_roles')
      .select(['id', 'code', 'name', 'description', 'is_system'])
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
        isSystem: Boolean(row.is_system),
        editable: !PROTECTED_ROLE_CODES.includes(row.code),
      })),
    };
  }

  @Get('roles/:id/permissions')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @RequiresPermission(ROLE_MANAGE)
  async rolePermissions(@Param() rawParams: unknown, @Req() request: AuthenticatedRequest) {
    const { id } = parseOrThrow(idParamSchema, rawParams);
    const now = this.clock.now();
    const entity = { type: 'ROLE', id };
    await this.manageAccess.requirePermission(request, now, entity);
    const role = await this.db
      .selectFrom('identity_roles')
      .select(['id', 'code', 'name', 'description', 'is_system', 'is_active'])
      .where('id', '=', toBin(id))
      .executeTakeFirst();
    if (!role || !role.is_active) {
      return this.manageAccess.deny(request, now, entity, 'OUT_OF_SCOPE');
    }
    const roleEditable = !PROTECTED_ROLE_CODES.includes(role.code);
    const [permissions, grants, changes, held] = await Promise.all([
      this.db
        .selectFrom('identity_permissions')
        .select([
          'code',
          'module',
          'description',
          'supported_scopes',
          'is_approval',
          'is_sensitive',
        ])
        .where('deprecated_at', 'is', null)
        .orderBy('module', 'asc')
        .orderBy('code', 'asc')
        .execute(),
      this.db
        .selectFrom('identity_role_permissions')
        .select(['permission_code', 'max_scope'])
        .where('role_id', '=', toBin(id))
        .execute(),
      this.db
        .selectFrom('identity_role_permission_changes as c')
        .innerJoin('identity_users as u', 'u.id', 'c.changed_by')
        .select([
          'c.id',
          'c.permission_code',
          'c.change_type',
          'c.scope_before',
          'c.scope_after',
          'c.reason',
          'c.changed_by',
          'u.full_name',
          'c.changed_at',
        ])
        .where('c.role_id', '=', toBin(id))
        .orderBy('c.changed_at', 'desc')
        .orderBy('c.id', 'desc')
        .limit(CHANGES_LIMIT)
        .execute(),
      heldGlobalScopes(this.db, request.auth!.sub, now),
    ]);
    const current = new Map(grants.map((grant) => [grant.permission_code, grant.max_scope]));
    return {
      role: {
        id: fromBin(role.id),
        code: role.code,
        name: role.name,
        description: role.description,
        isSystem: Boolean(role.is_system),
        editable: roleEditable,
      },
      permissions: permissions.map((permission) => {
        const supported = scopesOf(permission.supported_scopes);
        const maxScope = current.get(permission.code) ?? null;
        const editorScopes: readonly PermissionScope[] = held.get(permission.code) ?? [];
        const editable = roleEditable && !PROTECTED_PERMISSION_CODES.includes(permission.code);
        return {
          code: permission.code,
          module: permission.module,
          description: permission.description,
          supportedScopes: supported,
          isApproval: Boolean(permission.is_approval),
          isSensitive: Boolean(permission.is_sensitive),
          maxScope,
          editable,
          // Même règle que la commande : on ne donne que ce qu'on a, on ne retire que ce qu'on aurait pu donner.
          grantableScopes: editable
            ? grantableScopes(supported, editorScopes).filter(
                (scope) =>
                  maxScope === null ||
                  !isPermissionScope(maxScope) ||
                  heldScopesCover(editorScopes, maxScope),
              )
            : [],
          canRevoke:
            editable &&
            maxScope !== null &&
            isPermissionScope(maxScope) &&
            heldScopesCover(editorScopes, maxScope),
        };
      }),
      changes: changes.map((change) => ({
        id: fromBin(change.id),
        permissionCode: change.permission_code,
        changeType: change.change_type,
        scopeBefore: change.scope_before,
        scopeAfter: change.scope_after,
        reason: change.reason,
        changedByUserId: fromBin(change.changed_by),
        changedByName: change.full_name,
        changedAt: change.changed_at,
      })),
    };
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
