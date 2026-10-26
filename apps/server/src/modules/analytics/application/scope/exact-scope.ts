/**
 * Étendue exacte des lignes qu'un utilisateur peut lire pour une permission de lecture (P9-14 ; BR-ANA-004,
 * ADR-074 §4, AV-423) — l'étendue qui borne l'explorateur, les exports et les instantanés.
 *
 * MySQL n'a pas de sécurité au niveau des lignes et une requête d'agrégat ne se juge pas ligne à ligne : l'étendue
 * se calcule **avant** la requête et se compile en clause `WHERE` (`scope-sql.ts`). Elle ne se déduit pas de
 * `listConfinementAt` (un pré-filtre sur-ensemble : `null` n'y dit pas « tout est permis »). Elle se **construit
 * par `evaluateAccess`**, la fonction même qui juge un document :
 * - `evaluateAccess({})` permis : portée maximale `ALL`, aucune restriction ;
 * - pour chaque site, zone et utilisateur **candidat**, `evaluateAccess` est appelée sur une ressource qui ne
 *   porte que cet attribut (`{siteId}`, `{zoneId}`, `{ownerUserId}`) : un élément retenu est donc visible
 *   « par un octroi, pour toute ressource portant cet attribut » — la clause ne rend jamais plus que
 *   `evaluateAccess`. Exception, traitée à part : la zone d'une ligne qui porte aussi un site. Sans zone propre,
 *   `evaluateAccess` la déduit du site ; avec elle, elle juge celle-ci, qui peut différer. Un site n'est donc
 *   « lu pour lui-même » que s'il l'est avec une zone inexistante, et sinon « lu par sa zone » (`viaZoneIds`) ;
 * - une permission `OWN` sous une affectation de site ou de zone exige le couple (périmètre, soi) : essayé pour
 *   chaque site et zone candidats, retenu sous forme de clause conjonctive ;
 * - une ressource qui ne porte « aucun site précis » (portée `SITE` sous une affectation globale) est sondée par
 *   un identifiant qui n'existe pas : permis ⇒ « tout site » (`ANY_SITE`), « toute zone » (`ANY_ZONE`).
 *
 * Les candidats viennent des affectations de l'utilisateur et de ses équipes (API publique d'`identity` et
 * d'`organization`), non d'un balayage de toute l'entreprise : le coût est celui de son périmètre. Au-delà de
 * `maxCandidates` par sorte, les derniers sont écartés (étendue plus étroite, jamais plus large) et `truncated`
 * le dit.
 *
 * **Règle fermée** : une permission absente, une affectation expirée ou une étendue qui ne se résout pas donne
 * une étendue vide (aucune ligne), jamais `ALL`.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import {
  activeRoleAssignmentsAt,
  activeSiteAssignmentsAt,
  activeZoneAssignmentsAt,
  evaluateAccess,
  listConfinementAt,
  type ResourceLocator,
} from '../../../identity/application/public/index.js';
import {
  listManagedTeamMembersAt,
  listSiteIdsInZones,
  listTeamMembersAt,
  listZoneIdsWithDescendants,
} from '../../../organization/application/public/index.js';

type Executor = Kysely<DB> | Transaction<DB>;

/** Identifiant bien formé qui ne désigne aucun site, aucune zone : sonde « tout site » / « toute zone ». */
export const SCOPE_PROBE_ID = '00000000-0000-7000-8000-00000000dead';

/** Au plus ce nombre de candidats par sorte (sites, zones, utilisateurs) : au-delà, étendue tronquée. */
export const DEFAULT_MAX_SCOPE_CANDIDATES = 500;

export type ScopeClause =
  /** La ligne porte un site (quel qu'il soit). */
  | { readonly type: 'ANY_SITE' }
  /** La ligne porte une zone (quelle qu'elle soit). */
  | { readonly type: 'ANY_ZONE' }
  /**
   * Sites lus pour eux-mêmes (`ids` : affectation de site, quelle que soit la zone de la ligne) et sites lus par
   * leur zone (`viaZoneIds` : affectation de zone). Un jeu qui porte la zone propre de la ligne lit ces derniers
   * par `ZONES` : la zone d'une ligne peut différer de celle de son site.
   */
  | {
      readonly type: 'SITES';
      readonly ids: readonly string[];
      readonly viaZoneIds: readonly string[];
    }
  /**
   * Zones lues sans exiger de site (`ids` : portée `ZONE`) et zones lues pour une ligne qui porte aussi un site
   * (`withSiteIds` : portée `SITE` sous une affectation de zone ; sans objet pour un jeu sans colonne de site).
   */
  | {
      readonly type: 'ZONES';
      readonly ids: readonly string[];
      readonly withSiteIds: readonly string[];
    }
  | { readonly type: 'PERSONS'; readonly ids: readonly string[] }
  /**
   * Site dans la liste **et** personne = l'utilisateur (permission `OWN` sous une affectation de site ; `viaZoneIds` :
   * sous une affectation de zone, lus par leur site pour un jeu sans colonne de zone).
   */
  | {
      readonly type: 'SITES_AND_SELF';
      readonly ids: readonly string[];
      readonly viaZoneIds: readonly string[];
      readonly userId: string;
    }
  /** Zone dans la liste **et** personne = l'utilisateur (permission `OWN` sous une affectation de zone). */
  | { readonly type: 'ZONES_AND_SELF'; readonly ids: readonly string[]; readonly userId: string }
  /** La ligne porte un site **et** une personne de la liste (portée `SITE` sous une affectation d'équipe). */
  | { readonly type: 'ANY_SITE_AND_PERSONS'; readonly ids: readonly string[] }
  /** La ligne porte une zone **et** une personne de la liste (portée `ZONE` sous une affectation d'équipe). */
  | { readonly type: 'ANY_ZONE_AND_PERSONS'; readonly ids: readonly string[] };

export type ExactScope =
  | { readonly kind: 'ALL' }
  | {
      readonly kind: 'CLAUSES';
      /** Union des clauses ; vide : aucune ligne. */
      readonly clauses: readonly ScopeClause[];
      /** Des candidats ont été écartés faute de place : l'étendue est plus étroite que le droit. */
      readonly truncated: boolean;
    };

export interface ExactScopeInput {
  readonly userId: string;
  readonly permission: string;
  readonly at: Date;
}

export interface ExactScopeOptions {
  readonly maxCandidates?: number;
}

const NONE: ExactScope = { kind: 'CLAUSES', clauses: [], truncated: false };

/** Étendue vide : aucune ligne. */
export const EMPTY_SCOPE: ExactScope = NONE;

function capped(
  ids: Iterable<string>,
  max: number,
): { readonly ids: readonly string[]; readonly truncated: boolean } {
  const unique = [...new Set(ids)].sort();
  return unique.length > max
    ? { ids: unique.slice(0, max), truncated: true }
    : { ids: unique, truncated: false };
}

export async function resolveExactScope(
  executor: Executor,
  input: ExactScopeInput,
  options: ExactScopeOptions = {},
): Promise<ExactScope> {
  const max = options.maxCandidates ?? DEFAULT_MAX_SCOPE_CANDIDATES;
  const allowed = async (resource: ResourceLocator): Promise<boolean> =>
    (
      await evaluateAccess(executor, {
        userId: input.userId,
        permissionCode: input.permission,
        occurredAt: input.at,
        resource,
      })
    ).allowed;

  // Portée maximale `ALL` : aucune ressource n'est refusée (l'affectation n'y change rien).
  if (await allowed({})) return { kind: 'ALL' };

  const confinement = await listConfinementAt(executor, input.userId, input.permission, input.at);
  const zoneAssignments = await activeZoneAssignmentsAt(executor, input.userId, input.at);
  const siteAssignments = await activeSiteAssignmentsAt(executor, input.userId, input.at);
  const zoneCandidates = capped(await listZoneIdsWithDescendants(executor, zoneAssignments), max);
  const siteCandidates = capped(
    [
      ...(confinement?.siteIds ?? []),
      ...siteAssignments,
      ...(await listSiteIdsInZones(executor, zoneAssignments)),
    ],
    max,
  );
  // Personnes : soi, les membres des équipes qu'on dirige et ceux de l'équipe d'une affectation de portée équipe.
  const assignmentTeams = new Set<string>();
  for (const assignment of await activeRoleAssignmentsAt(executor, input.userId, input.at)) {
    if (assignment.scopeTeamId !== null) assignmentTeams.add(assignment.scopeTeamId);
  }
  const teamMembers: string[] = [];
  for (const teamId of assignmentTeams) {
    teamMembers.push(...(await listTeamMembersAt(executor, teamId, input.at)));
  }
  const personCandidates = capped(
    [
      input.userId,
      ...(confinement?.ownerUserIds ?? []),
      ...(await listManagedTeamMembersAt(executor, input.userId, input.at)),
      ...teamMembers,
    ],
    max,
  );
  const truncated =
    zoneCandidates.truncated || siteCandidates.truncated || personCandidates.truncated;

  const anySite = await allowed({ siteId: SCOPE_PROBE_ID });
  const anyZone = await allowed({ zoneId: SCOPE_PROBE_ID });

  const filter = async (
    ids: readonly string[],
    locator: (id: string) => ResourceLocator,
  ): Promise<readonly string[]> => {
    const kept: string[] = [];
    for (const id of ids) if (await allowed(locator(id))) kept.push(id);
    return kept;
  };

  // Un site se lit pour lui-même (affectation de site : la zone de la ligne n'y change rien, jugée avec une zone
  // qui n'existe pas) ou par sa zone (affectation de zone : `evaluateAccess` déduit la zone du site, mais une
  // ligne qui porte sa propre zone est jugée sur celle-ci).
  const sites = anySite ? [] : await filter(siteCandidates.ids, (siteId) => ({ siteId }));
  const pureSites = await filter(sites, (siteId) => ({ siteId, zoneId: SCOPE_PROBE_ID }));
  const pureSiteSet = new Set(pureSites);
  const viaZoneSites = sites.filter((siteId) => !pureSiteSet.has(siteId));
  const zones = anyZone ? [] : await filter(zoneCandidates.ids, (zoneId) => ({ zoneId }));
  const zoneSet = new Set(zones);
  // Portée `SITE` sous une affectation de zone : la zone suffit pourvu que la ligne porte un site.
  const zonesWithSite =
    anySite || anyZone
      ? []
      : (await filter(zoneCandidates.ids, (zoneId) => ({ zoneId, siteId: SCOPE_PROBE_ID }))).filter(
          (zoneId) => !zoneSet.has(zoneId),
        );
  const persons = await filter(personCandidates.ids, (ownerUserId) => ({ ownerUserId }));

  // Couples (périmètre, soi) : seulement là où ni le périmètre seul ni soi seul ne suffisent.
  const selfAlone = persons.includes(input.userId);
  const pairSites: string[] = [];
  const pairViaZoneSites: string[] = [];
  const pairZones: string[] = [];
  if (!selfAlone) {
    const siteSet = new Set(sites);
    for (const siteId of siteCandidates.ids) {
      if (anySite || pureSiteSet.has(siteId)) continue;
      if (await allowed({ siteId, zoneId: SCOPE_PROBE_ID, ownerUserId: input.userId })) {
        pairSites.push(siteId);
      } else if (!siteSet.has(siteId) && (await allowed({ siteId, ownerUserId: input.userId }))) {
        pairViaZoneSites.push(siteId);
      }
    }
    for (const zoneId of zoneCandidates.ids) {
      if (anyZone || zoneSet.has(zoneId)) continue;
      if (await allowed({ zoneId, ownerUserId: input.userId })) pairZones.push(zoneId);
    }
  }

  // Une affectation d'équipe ne juge que le propriétaire : un site (ou une zone) quelconque et un membre.
  const anySitePersons: string[] = [];
  const anyZonePersons: string[] = [];
  for (const ownerUserId of personCandidates.ids) {
    if (persons.includes(ownerUserId)) continue;
    if (!anySite && (await allowed({ siteId: SCOPE_PROBE_ID, ownerUserId }))) {
      anySitePersons.push(ownerUserId);
    }
    if (!anyZone && (await allowed({ zoneId: SCOPE_PROBE_ID, ownerUserId }))) {
      anyZonePersons.push(ownerUserId);
    }
  }

  const clauses: ScopeClause[] = [];
  if (anySite) clauses.push({ type: 'ANY_SITE' });
  if (anyZone) clauses.push({ type: 'ANY_ZONE' });
  if (pureSites.length > 0 || viaZoneSites.length > 0) {
    clauses.push({ type: 'SITES', ids: pureSites, viaZoneIds: viaZoneSites });
  }
  if (zones.length > 0 || zonesWithSite.length > 0) {
    clauses.push({ type: 'ZONES', ids: zones, withSiteIds: zonesWithSite });
  }
  if (persons.length > 0) clauses.push({ type: 'PERSONS', ids: persons });
  if (anySitePersons.length > 0)
    clauses.push({ type: 'ANY_SITE_AND_PERSONS', ids: anySitePersons });
  if (anyZonePersons.length > 0)
    clauses.push({ type: 'ANY_ZONE_AND_PERSONS', ids: anyZonePersons });
  if (pairSites.length > 0 || pairViaZoneSites.length > 0) {
    clauses.push({
      type: 'SITES_AND_SELF',
      ids: pairSites,
      viaZoneIds: pairViaZoneSites,
      userId: input.userId,
    });
  }
  if (pairZones.length > 0) {
    clauses.push({ type: 'ZONES_AND_SELF', ids: pairZones, userId: input.userId });
  }
  return { kind: 'CLAUSES', clauses, truncated };
}
