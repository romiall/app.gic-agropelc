/**
 * Adaptateur du port `AlertRecipientResolver` (P9-05 ; ADR-072 §2 ; besoin B1) : les destinataires d'une
 * alerte se trouvent **par rôle et par périmètre**, requête inverse que ni `identity` ni `organization`
 * n'exposent. Ce fichier est le seul à la porter : les lectures des affectations, des équipes et des
 * zones y sont isolées pour que des fonctions publiques d'`identity` et d'`organization` les remplacent
 * sans toucher `communication`.
 *
 * Couverture d'une affectation = celle de `evaluateAccess` (RC-04, `scope-evaluation.ts`) : `GLOBAL`
 * couvre tout, `SITE` le site, `ZONE` la zone et ses descendantes (celle du site à défaut de zone),
 * `TEAM` l'équipe dont un propriétaire est membre. Pour les approbateurs, la décision est celle du
 * moteur de droits lui-même (`evaluateAccess`), jamais une réécriture.
 */
import { Injectable } from '@nestjs/common';
import type { UnitOfWork } from '../platform/unit-of-work.js';
import { fromBin, toBin } from '../platform/kysely/uuid-columns.js';
import { evaluateAccess } from '../modules/identity/application/public/index.js';
import type {
  AlertRecipientResolver,
  RecipientPerimeter,
  RoleHolder,
} from '../modules/communication/application/public/index.js';

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

async function zoneOf(uow: UnitOfWork, perimeter: RecipientPerimeter): Promise<string | null> {
  if (perimeter.zoneId !== null) return perimeter.zoneId;
  if (perimeter.siteId === null) return null;
  const row = await uow
    .selectFrom('organization_sites')
    .select('zone_id')
    .where('id', '=', toBin(perimeter.siteId))
    .executeTakeFirst();
  return row ? fromBin(row.zone_id) : null;
}

/** La zone et tous ses ancêtres : une affectation de zone couvre les zones qui en descendent. */
async function zoneLineage(uow: UnitOfWork, zoneId: string): Promise<ReadonlySet<string>> {
  const rows = await uow
    .selectFrom('organization_zone_ancestors')
    .select('ancestor_id')
    .where('zone_id', '=', toBin(zoneId))
    .execute();
  return new Set([zoneId, ...rows.map((row) => fromBin(row.ancestor_id))]);
}

async function teamsOfUsers(
  uow: UnitOfWork,
  userIds: readonly string[],
  at: Date,
): Promise<ReadonlySet<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await uow
    .selectFrom('organization_team_memberships')
    .select('team_id')
    .where('user_id', 'in', userIds.map(toBin))
    .where('valid_from', '<=', at)
    .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', at)]))
    .execute();
  return new Set(rows.map((row) => fromBin(row.team_id)));
}

@Injectable()
export class IdentityRecipientResolver implements AlertRecipientResolver {
  async usersHoldingRolesAt(
    uow: UnitOfWork,
    input: {
      readonly roles: readonly string[];
      readonly perimeter: RecipientPerimeter;
      readonly at: Date;
    },
  ): Promise<readonly RoleHolder[]> {
    if (input.roles.length === 0) return [];
    const { at, perimeter } = input;
    const assignments = await uow
      .selectFrom('identity_user_role_assignments as a')
      .innerJoin('identity_roles as r', 'r.id', 'a.role_id')
      .innerJoin('identity_users as u', 'u.id', 'a.user_id')
      .select([
        'a.user_id',
        'r.code as role_code',
        'a.scope_type',
        'a.scope_site_id',
        'a.scope_zone_id',
        'a.scope_team_id',
      ])
      .where('r.code', 'in', [...input.roles])
      .where('r.is_active', '=', 1)
      .where('u.status', '=', 'ACTIVE')
      .where('a.valid_from', '<=', at)
      .where((eb) => eb.or([eb('a.valid_to', 'is', null), eb('a.valid_to', '>', at)]))
      .where((eb) => eb.or([eb('a.revoked_at', 'is', null), eb('a.revoked_at', '>', at)]))
      .execute();
    if (assignments.length === 0) return [];

    const needsZone = assignments.some((row) => row.scope_type === 'ZONE');
    const objectZone = needsZone ? await zoneOf(uow, perimeter) : null;
    const lineage = objectZone === null ? new Set<string>() : await zoneLineage(uow, objectZone);
    const needsTeam = assignments.some((row) => row.scope_type === 'TEAM');
    const ownerTeams = needsTeam
      ? await teamsOfUsers(uow, perimeter.ownerUserIds, at)
      : new Set<string>();

    const roleOrder = new Map(input.roles.map((code, index) => [code, index]));
    const covering = assignments
      .filter((row) => {
        switch (row.scope_type) {
          case 'GLOBAL':
            return true;
          case 'SITE':
            return (
              perimeter.siteId !== null &&
              row.scope_site_id !== null &&
              fromBin(row.scope_site_id) === perimeter.siteId
            );
          case 'ZONE':
            return row.scope_zone_id !== null && lineage.has(fromBin(row.scope_zone_id));
          case 'TEAM':
            return row.scope_team_id !== null && ownerTeams.has(fromBin(row.scope_team_id));
          default:
            return false;
        }
      })
      .sort(
        (a, b) =>
          (roleOrder.get(a.role_code) ?? 0) - (roleOrder.get(b.role_code) ?? 0) ||
          fromBin(a.user_id).localeCompare(fromBin(b.user_id)),
      );
    const holders = new Map<string, RoleHolder>();
    for (const row of covering) {
      const userId = fromBin(row.user_id);
      if (!holders.has(userId)) holders.set(userId, { userId, roleCode: row.role_code });
    }
    return [...holders.values()];
  }

  async usersHoldingPermissionAt(
    uow: UnitOfWork,
    input: {
      readonly permission: string;
      readonly perimeter: RecipientPerimeter;
      readonly at: Date;
      readonly excludeUserIds: readonly string[];
    },
  ): Promise<readonly string[]> {
    const { at, perimeter } = input;
    const candidates = await uow
      .selectFrom('identity_role_permissions as rp')
      .innerJoin('identity_roles as r', 'r.id', 'rp.role_id')
      .innerJoin('identity_user_role_assignments as a', 'a.role_id', 'r.id')
      .innerJoin('identity_users as u', 'u.id', 'a.user_id')
      .select('a.user_id')
      .distinct()
      .where('rp.permission_code', '=', input.permission)
      .where('r.is_active', '=', 1)
      .where('u.status', '=', 'ACTIVE')
      .where('a.valid_from', '<=', at)
      .where((eb) => eb.or([eb('a.valid_to', 'is', null), eb('a.valid_to', '>', at)]))
      .where((eb) => eb.or([eb('a.revoked_at', 'is', null), eb('a.revoked_at', '>', at)]))
      .execute();
    const excluded = new Set(input.excludeUserIds);
    const approvers: string[] = [];
    for (const candidate of unique(candidates.map((row) => fromBin(row.user_id))).sort()) {
      if (excluded.has(candidate)) continue;
      const access = await evaluateAccess(uow, {
        userId: candidate,
        permissionCode: input.permission,
        occurredAt: at,
        resource: {
          ...(perimeter.siteId !== null ? { siteId: perimeter.siteId } : {}),
          ...(perimeter.zoneId !== null ? { zoneId: perimeter.zoneId } : {}),
          ...(perimeter.ownerUserIds[0] !== undefined
            ? { ownerUserId: perimeter.ownerUserIds[0] }
            : {}),
        },
      });
      if (access.allowed) approvers.push(candidate);
    }
    return approvers;
  }

  /** Actifs **et** affectés : un utilisateur sans affectation active à `at` n'a rien à y faire (§1). */
  async activeUsersAmong(
    uow: UnitOfWork,
    userIds: readonly string[],
    at: Date,
  ): Promise<readonly string[]> {
    if (userIds.length === 0) return [];
    const rows = await uow
      .selectFrom('identity_user_role_assignments as a')
      .innerJoin('identity_roles as r', 'r.id', 'a.role_id')
      .innerJoin('identity_users as u', 'u.id', 'a.user_id')
      .select('a.user_id')
      .distinct()
      .where('a.user_id', 'in', unique(userIds).map(toBin))
      .where('r.is_active', '=', 1)
      .where('u.status', '=', 'ACTIVE')
      .where('a.valid_from', '<=', at)
      .where((eb) => eb.or([eb('a.valid_to', 'is', null), eb('a.valid_to', '>', at)]))
      .where((eb) => eb.or([eb('a.revoked_at', 'is', null), eb('a.revoked_at', '>', at)]))
      .execute();
    return rows.map((row) => fromBin(row.user_id)).sort();
  }

  async teamManagersOf(
    uow: UnitOfWork,
    userIds: readonly string[],
    at: Date,
  ): Promise<readonly string[]> {
    if (userIds.length === 0) return [];
    const rows = await uow
      .selectFrom('organization_team_memberships as m')
      .innerJoin('organization_teams as t', 't.id', 'm.team_id')
      .select('t.manager_user_id')
      .distinct()
      .where('m.user_id', 'in', unique(userIds).map(toBin))
      .where('m.valid_from', '<=', at)
      .where((eb) => eb.or([eb('m.valid_to', 'is', null), eb('m.valid_to', '>', at)]))
      .where('t.is_active', '=', 1)
      .execute();
    // Le responsable doit lui aussi être actif et affecté.
    return this.activeUsersAmong(
      uow,
      rows.map((row) => fromBin(row.manager_user_id)),
      at,
    );
  }
}
