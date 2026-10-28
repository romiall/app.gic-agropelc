/**
 * De l'étendue exacte au périmètre des fonctions de référence (P9-17 ; ADR-065 §4) : les fonctions de référence des
 * modules prennent un `ReadScope` (sites ET personnes), l'étendue exacte d'un utilisateur (ADR-064 §4) est une union
 * de clauses. L'adaptateur ne traduit que ce qui se dit **exactement** en `ReadScope` ; le reste est `null`, jamais
 * une approximation plus large :
 * - étendue totale ou « tout site / toute zone » : tout (`ALL_SCOPE`) ;
 * - étendue tronquée (plus de `analytics.scope_max_candidates` candidats, TB-6) : `null` (`SCOPE_TRUNCATED`) ;
 * - étendue vide : un périmètre vide (rien à lire) ;
 * - sites et zones (les zones se développent en leurs sites) : `{ siteIds }` ;
 * - personnes seules : `{ userIds }` ;
 * - périmètre et soi (`OWN` sous une affectation de site ou de zone) : `{ siteIds, userIds: [soi] }` (un ET) ;
 * - toute autre union (sites OU personnes, plusieurs couples) : `null` — le bloc est alors indisponible
 *   (`SCOPE_UNSUPPORTED`), la lecture exacte restant celle de l'explorateur.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../platform/kysely/database.js';
import { ALL_SCOPE, type ReadScope } from '../../platform/read-scope.js';
import type { ExactScope } from '../../modules/analytics/application/public/index.js';
import { listSiteIdsInZones } from '../../modules/organization/application/public/index.js';

type Executor = Kysely<DB> | Transaction<DB>;

/** Cause de l'indisponibilité d'un bloc dont l'étendue n'est pas exprimable en `ReadScope`. */
export type ScopeIssue = 'SCOPE_TRUNCATED' | 'SCOPE_UNSUPPORTED';

/** Pourquoi `readScopeOf` a rendu `null` pour cette étendue (TB-6). */
export function scopeIssueOf(scope: ExactScope): ScopeIssue {
  return scope.kind === 'CLAUSES' && scope.truncated ? 'SCOPE_TRUNCATED' : 'SCOPE_UNSUPPORTED';
}

export async function readScopeOf(
  executor: Executor,
  scope: ExactScope,
): Promise<ReadScope | null> {
  if (scope.kind === 'ALL') return ALL_SCOPE;
  // « Tout site » et « toute zone » gardent ALL_SCOPE, même tronqués : la troncature ne retire que des candidats
  // déjà couverts par « tout » (approximation admise : plus large que « toute ligne portant un site »).
  if (scope.clauses.some((clause) => clause.type === 'ANY_SITE' || clause.type === 'ANY_ZONE')) {
    return ALL_SCOPE;
  }
  // TB-6 : des candidats ont été écartés au-delà de `analytics.scope_max_candidates` ; l'étendue est plus étroite
  // que le droit, donc non exacte, même vide : le bloc est indisponible (SCOPE_TRUNCATED), comme l'export (AV-445).
  if (scope.truncated) return null;
  if (scope.clauses.length === 0) return { siteIds: [] };
  const sites = new Set<string>();
  const zones = new Set<string>();
  const persons = new Set<string>();
  let pairs: { siteIds: Set<string>; zoneIds: Set<string>; userId: string } | null = null;
  let others = 0;
  for (const clause of scope.clauses) {
    switch (clause.type) {
      case 'SITES':
        for (const id of [...clause.ids, ...clause.viaZoneIds]) sites.add(id);
        break;
      case 'ZONES':
        for (const id of [...clause.ids, ...clause.withSiteIds]) zones.add(id);
        break;
      case 'PERSONS':
        for (const id of clause.ids) persons.add(id);
        break;
      case 'SITES_AND_SELF': {
        if (pairs !== null && pairs.userId !== clause.userId) return null;
        pairs ??= { siteIds: new Set(), zoneIds: new Set(), userId: clause.userId };
        for (const id of [...clause.ids, ...clause.viaZoneIds]) pairs.siteIds.add(id);
        break;
      }
      case 'ZONES_AND_SELF': {
        if (pairs !== null && pairs.userId !== clause.userId) return null;
        pairs ??= { siteIds: new Set(), zoneIds: new Set(), userId: clause.userId };
        for (const id of clause.ids) pairs.zoneIds.add(id);
        break;
      }
      default:
        others += 1;
    }
  }
  if (others > 0) return null;
  const hasPlain = sites.size > 0 || zones.size > 0;
  if (pairs !== null) {
    // Un couple (périmètre, soi) n'est exact que seul : mêlé à d'autres clauses, il est une union.
    if (hasPlain || persons.size > 0) return null;
    const pairSites = new Set(pairs.siteIds);
    if (pairs.zoneIds.size > 0) {
      for (const id of await listSiteIdsInZones(executor, [...pairs.zoneIds])) pairSites.add(id);
    }
    return { siteIds: [...pairSites], userIds: [pairs.userId] };
  }
  if (hasPlain && persons.size > 0) return null;
  if (persons.size > 0) return { userIds: [...persons] };
  if (zones.size > 0) {
    for (const id of await listSiteIdsInZones(executor, [...zones])) sites.add(id);
  }
  return { siteIds: [...sites] };
}
