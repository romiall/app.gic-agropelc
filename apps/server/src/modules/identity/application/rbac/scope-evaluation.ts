/**
 * Intersection « portée maximale ∩ périmètre de l'affectation » (01-rbac.md §2 « Droit
 * effectif », §3 propriété OWN). Consommé par `rights-check.ts::evaluateAccess`, jamais
 * appelé directement hors de `identity` (module interne, pas exporté par `application/
 * public`).
 *
 * Modèle retenu, pour chaque portée maximale de la permission (`role_permissions.max_scope`) :
 * - `ALL`  : aucune restriction.
 * - `OWN`  : `ressource.ownerUserId === utilisateur`, ET la ressource reste dans le
 *   périmètre concret de l'affectation (`affectationCovers`) — une affectation `SITE`
 *   restreint donc aussi une permission `OWN` aux ressources de ce site.
 * - `SITE` : la ressource porte un site, ET `affectationCovers`.
 * - `ZONE` : la ressource porte une zone (directement, ou via son site), ET `affectationCovers`.
 * - `TEAM` : cas particulier documenté (§2, ligne TEAM) — voir `isWithinTeamScope` : ne
 *   passe PAS par `affectationCovers`, qui redeviendrait un second filtre en ET alors que la
 *   règle documentée dit « équipe dont l'utilisateur est responsable, OU équipe de
 *   l'affectation TEAM » — un OU entre deux sources d'éligibilité, pas une intersection. DÉDUIT
 *   (non explicité par la source) : une permission `TEAM` accordée par une affectation
 *   `SITE`/`ZONE` n'ajoute aucune restriction supplémentaire par site/zone au-delà de ce que
 *   `isWithinTeamScope` calcule déjà — combinaison absente des exemples §8 et de la matrice
 *   §5 ; paramétrable si un cas réel l'exige plus tard.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { toBin, fromBin } from '../../../../platform/kysely/uuid-columns.js';
import type { CachedGrant } from './rbac-cache.js';

/** Attributs de la ressource visée, résolus par l'appelant (RC-04 : la portée de
 * l'*opération*, jamais celle du demandeur). Un champ absent (`undefined`) signifie que la
 * ressource ne porte pas cet attribut (ex. un compte client n'a pas de `siteId`). */
export interface ResourceLocator {
  readonly ownerUserId?: string;
  readonly siteId?: string;
  readonly zoneId?: string;
}

type Executor = Kysely<DB> | Transaction<DB>;

async function zoneIdOfSite(executor: Executor, siteId: string): Promise<string | undefined> {
  const row = await executor
    .selectFrom('organization_sites')
    .select('zone_id')
    .where('id', '=', toBin(siteId))
    .executeTakeFirst();
  return row ? fromBin(row.zone_id) : undefined;
}

/** `organization.zone_ancestors` : la zone elle-même (`depth=0`) compte comme son propre ancêtre. */
async function zoneIsSelfOrDescendant(
  executor: Executor,
  zoneId: string,
  ancestorZoneId: string,
): Promise<boolean> {
  const row = await executor
    .selectFrom('organization_zone_ancestors')
    .select('zone_id')
    .where('zone_id', '=', toBin(zoneId))
    .where('ancestor_id', '=', toBin(ancestorZoneId))
    .executeTakeFirst();
  return row !== undefined;
}

async function isTeamMemberAt(
  executor: Executor,
  teamId: string,
  userId: string,
  occurredAt: Date,
): Promise<boolean> {
  const row = await executor
    .selectFrom('organization_team_memberships')
    .select('id')
    .where('team_id', '=', toBin(teamId))
    .where('user_id', '=', toBin(userId))
    .where('valid_from', '<=', occurredAt)
    .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', occurredAt)]))
    .executeTakeFirst();
  return row !== undefined;
}

async function isMemberOfAnyManagedTeam(
  executor: Executor,
  managerUserId: string,
  memberUserId: string,
  occurredAt: Date,
): Promise<boolean> {
  const row = await executor
    .selectFrom('organization_team_memberships as tm')
    .innerJoin('organization_teams as t', 't.id', 'tm.team_id')
    .select('tm.id')
    .where('t.manager_user_id', '=', toBin(managerUserId))
    .where('tm.user_id', '=', toBin(memberUserId))
    .where('tm.valid_from', '<=', occurredAt)
    .where((eb) => eb.or([eb('tm.valid_to', 'is', null), eb('tm.valid_to', '>', occurredAt)]))
    .executeTakeFirst();
  return row !== undefined;
}

/** Périmètre concret de l'affectation (indépendant de `max_scope`) — le second terme de l'intersection. */
async function affectationCovers(
  executor: Executor,
  grant: CachedGrant,
  resource: ResourceLocator,
  occurredAt: Date,
): Promise<boolean> {
  switch (grant.scopeType) {
    case 'GLOBAL':
      return true;
    case 'SITE':
      return resource.siteId !== undefined && resource.siteId === grant.scopeSiteId;
    case 'ZONE': {
      if (grant.scopeZoneId === null) return false;
      const resourceZoneId =
        resource.zoneId ??
        (resource.siteId !== undefined ? await zoneIdOfSite(executor, resource.siteId) : undefined);
      if (resourceZoneId === undefined) return false;
      return zoneIsSelfOrDescendant(executor, resourceZoneId, grant.scopeZoneId);
    }
    case 'TEAM':
      if (resource.ownerUserId === undefined || grant.scopeTeamId === null) return false;
      return isTeamMemberAt(executor, grant.scopeTeamId, resource.ownerUserId, occurredAt);
  }
}

/** §2 ligne TEAM : propriétaire membre d'une équipe dirigée par l'utilisateur, ou de
 * l'équipe de l'affectation TEAM ; l'utilisateur lui-même est toujours inclus. */
async function isWithinTeamScope(
  executor: Executor,
  grant: CachedGrant,
  resource: ResourceLocator,
  granteeUserId: string,
  occurredAt: Date,
): Promise<boolean> {
  if (resource.ownerUserId === undefined) return false;
  if (resource.ownerUserId === granteeUserId) return true;
  if (await isMemberOfAnyManagedTeam(executor, granteeUserId, resource.ownerUserId, occurredAt)) {
    return true;
  }
  if (grant.scopeType === 'TEAM' && grant.scopeTeamId !== null) {
    return isTeamMemberAt(executor, grant.scopeTeamId, resource.ownerUserId, occurredAt);
  }
  return false;
}

/** Vrai si `resource` tombe dans l'intersection (portée maximale du grant ∩ périmètre de son affectation). */
export async function resourceInGrantScope(
  executor: Executor,
  grant: CachedGrant,
  resource: ResourceLocator,
  granteeUserId: string,
  occurredAt: Date,
): Promise<boolean> {
  switch (grant.maxScope) {
    case 'ALL':
      return true;
    case 'OWN':
      if (resource.ownerUserId === undefined || resource.ownerUserId !== granteeUserId)
        return false;
      return affectationCovers(executor, grant, resource, occurredAt);
    case 'SITE':
      if (resource.siteId === undefined) return false;
      return affectationCovers(executor, grant, resource, occurredAt);
    case 'ZONE':
      if (resource.zoneId === undefined && resource.siteId === undefined) return false;
      return affectationCovers(executor, grant, resource, occurredAt);
    case 'TEAM':
      return isWithinTeamScope(executor, grant, resource, granteeUserId, occurredAt);
  }
}
