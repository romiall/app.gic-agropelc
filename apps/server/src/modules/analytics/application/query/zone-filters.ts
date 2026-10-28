/**
 * Filtres de zone de l'explorateur (AV-375, défaut (a)) : une zone filtrée couvre ses descendantes (fermeture
 * transitive `organization_zone_ancestors`, la zone étant sa propre ancêtre). Les descendantes sont lues ici,
 * avant la compilation, par l'API publique d'`organization` ; le compilateur reste sans entrée-sortie.
 */
import type { Kysely, Transaction } from 'kysely';
import type { ExplorationPlan } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { listZoneIdsWithDescendants } from '../../../organization/application/public/index.js';
import { isZoneFilter } from './compile-exploration.js';

/** Chaque zone citée par un filtre de zone du plan → la zone et ses descendantes. */
export async function zoneDescendantsOf(
  executor: Kysely<DB> | Transaction<DB>,
  plan: ExplorationPlan,
): Promise<ReadonlyMap<string, readonly string[]>> {
  const zones = new Set<string>();
  for (const filter of plan.filters) {
    if (!isZoneFilter(plan, filter)) continue;
    const values =
      filter.op === 'IN' ? (filter.value as readonly string[]) : [String(filter.value)];
    for (const value of values) zones.add(value);
  }
  const descendants = new Map<string, readonly string[]>();
  for (const zone of zones) {
    const found = await listZoneIdsWithDescendants(executor, [zone]);
    descendants.set(zone, found.includes(zone) ? found : [zone, ...found]);
  }
  return descendants;
}
