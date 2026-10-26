/**
 * Fraîcheur d'une lecture de l'explorateur (P9-14 ; BR-ANA-005, ADR-075 §7) : l'instant du calcul (l'explorateur lit
 * les vues à l'instant de la requête) et les appareils **du périmètre** sans contact depuis plus de
 * `analytics.freshness_warning_hours` — les ventes de ces appareils peuvent manquer au chiffre affiché.
 *
 * Les appareils du périmètre sont ceux des points de vente que l'étendue de la première permission du jeu atteint
 * (`sync/device-freshness.ts`, AV-202) : étendue totale ou « tout site » ⇒ tous les points de vente ; liste de
 * sites ou de zones ⇒ ceux-là ; étendue par personnes seules ⇒ aucun appareil de site.
 */
import type { Kysely, Transaction } from 'kysely';
import type { AnalyticsFreshness } from '@gic/contracts';
import type { DB } from '../platform/kysely/database.js';
import type { ExactScope } from '../modules/analytics/application/public/index.js';
import {
  listPointsOfSale,
  listSiteIdsInZones,
} from '../modules/organization/application/public/index.js';
import { deviceFreshness, devicesOfSites } from '../sync/device-freshness.js';

type Executor = Kysely<DB> | Transaction<DB>;

/** Sites que l'étendue atteint ; `'ALL'` : tous les points de vente. */
async function scopeSites(
  executor: Executor,
  scope: ExactScope | undefined,
): Promise<'ALL' | readonly string[]> {
  if (scope === undefined || scope.kind === 'ALL') return 'ALL';
  const sites = new Set<string>();
  const zones = new Set<string>();
  for (const clause of scope.clauses) {
    switch (clause.type) {
      case 'ANY_SITE':
      case 'ANY_SITE_AND_PERSONS':
        return 'ALL';
      case 'SITES':
      case 'SITES_AND_SELF':
        for (const id of [...clause.ids, ...clause.viaZoneIds]) sites.add(id);
        break;
      case 'ZONES':
        for (const id of [...clause.ids, ...clause.withSiteIds]) zones.add(id);
        break;
      case 'ZONES_AND_SELF':
        for (const id of clause.ids) zones.add(id);
        break;
      case 'ANY_ZONE':
      case 'ANY_ZONE_AND_PERSONS':
        return 'ALL';
      case 'PERSONS':
        break;
    }
  }
  if (zones.size > 0) {
    for (const siteId of await listSiteIdsInZones(executor, [...zones])) sites.add(siteId);
  }
  return [...sites];
}

export async function explorerFreshness(
  executor: Executor,
  input: { readonly scope: ExactScope | undefined; readonly now: Date },
): Promise<AnalyticsFreshness> {
  const reach = await scopeSites(executor, input.scope);
  const siteIds =
    reach === 'ALL'
      ? (await listPointsOfSale(executor, {})).map((pos) => pos.siteId)
      : reach.length === 0
        ? []
        : (await listPointsOfSale(executor, { siteIds: [...reach] })).map((pos) => pos.siteId);
  const devices = [...new Set([...(await devicesOfSites(executor, siteIds)).values()].flat())];
  const report = await deviceFreshness(executor, { deviceIds: devices, now: input.now });
  return {
    computedAt: input.now.toISOString(),
    devicesInScope: report.devices.filter((device) => device.status === 'ACTIVE').length,
    staleDevices: report.staleCount,
    staleAfterHours: report.warningHours,
  };
}
