/**
 * Visibilité d'un conflit de synchronisation (P5-17, AV-191), commune à la lecture
 * (`GET /sync/conflicts`) et aux commandes `sync.conflict.resolve` / `.dismiss` :
 *
 * 1. **rôle propriétaire** (matrice des conflits §3, BR-SYN-017) : le conflit appartient à l'un des
 *    rôles dont l'utilisateur traite les conflits — `conflictRoles` du catalogue des rôles
 *    (`home-api/role-catalog.ts`, source unique déjà servie par l'accueil) ; Direction et Admin
 *    traitent tous les conflits ; un rôle sans entrée n'en traite aucun ;
 * 2. **portée** de `sync.conflict.resolve` évaluée **sur les seules affectations de ces rôles**
 *    (revue de P5-17 : un rôle cumulé n'étend jamais le périmètre d'un autre) : site du conflit et
 *    auteur de la commande qui l'a produit (inbox) — `ALL` tout, `SITE`/`ZONE` le site, `TEAM` les
 *    commandes de l'équipe. Un conflit système (sans auteur) prend pour titulaire le détenteur de
 *    l'emplacement en cause s'il en a un (stock mobile : `details.fromLocationId` ou `locationId`) ;
 *    sans site ni titulaire, il n'est visible qu'en portée `ALL`.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../platform/kysely/database.js';
import type { ConflictRecord } from '../platform/sync/conflicts.js';
import { activeRoleCodesAt, evaluateAccess } from '../modules/identity/application/public/index.js';
import { ROLE_CATALOG } from '../home-api/role-catalog.js';
import { conflictResource } from './conflict-resource.js';

export { conflictResource } from './conflict-resource.js';

export const CONFLICT_RESOLVE = 'sync.conflict.resolve';

type Executor = Kysely<DB> | Transaction<DB>;

/** Rôles propriétaires dont l'utilisateur lit (et traite) les conflits ; `ALL` : tous. Pré-filtre. */
export async function conflictOwnerRolesOf(
  executor: Executor,
  userId: string,
  at: Date,
): Promise<readonly string[] | 'ALL'> {
  const owners = new Set<string>();
  for (const roleCode of await activeRoleCodesAt(executor, userId, at)) {
    const roles = ROLE_CATALOG[roleCode]?.conflictRoles ?? [];
    if (roles === 'ALL') return 'ALL';
    for (const role of roles) owners.add(role);
  }
  return [...owners];
}

/** Rôles actifs de l'utilisateur qui traitent les conflits de ce rôle propriétaire. */
async function handlingRoles(
  executor: Executor,
  userId: string,
  at: Date,
  ownerRole: string,
): Promise<string[]> {
  return (await activeRoleCodesAt(executor, userId, at)).filter((roleCode) => {
    const roles = ROLE_CATALOG[roleCode]?.conflictRoles ?? [];
    return roles === 'ALL' || roles.includes(ownerRole);
  });
}

export async function conflictVisible(
  executor: Executor,
  input: {
    readonly userId: string;
    readonly at: Date;
    readonly conflict: ConflictRecord;
  },
): Promise<boolean> {
  const roleCodes = await handlingRoles(executor, input.userId, input.at, input.conflict.ownerRole);
  if (roleCodes.length === 0) return false;
  return (
    await evaluateAccess(executor, {
      userId: input.userId,
      permissionCode: CONFLICT_RESOLVE,
      occurredAt: input.at,
      resource: await conflictResource(executor, input.conflict),
      roleCodes,
    })
  ).allowed;
}
