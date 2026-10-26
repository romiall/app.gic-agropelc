/**
 * Périmètre d'un tableau de distribution (P9-17 ; ADR-066 §3, extrait du contrôleur de P5-20 sans changement de
 * comportement) : les points de vente que la permission `analytics.dashboard.distribution` atteint pour un
 * utilisateur, leurs cibles de lecture (emplacements, comptes de trésorerie, sites) et les droits annexes par
 * site (valeurs, détail de caisse, receveurs, auteurs d'un appareil — AV-205, AV-206).
 *
 * Fonction **sans requête HTTP** : ni refus audité ni `AuthenticatedRequest`. Le contrôleur, le bloc DISTRIBUTION de
 * la tour de contrôle et la tâche d'instantanés l'appellent ; un droit perdu fait sauter l'utilisateur de la tâche,
 * et le contrôleur traduit le refus en 404 audité (RC-07).
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../platform/kysely/database.js';
import { evaluateAccess } from '../modules/identity/application/public/index.js';
import {
  listPointsOfSale,
  type PointOfSaleSummary,
} from '../modules/organization/application/public/index.js';
import {
  distributionTargetsOf,
  type DistributionTargets,
} from '../read-api/distribution-targets.js';
import type { SiteVisibility } from './distribution-dashboard.service.js';

type Executor = Kysely<DB> | Transaction<DB>;

export const DISTRIBUTION_DASHBOARD_READ = 'analytics.dashboard.distribution';

const resourceOf = (pos: PointOfSaleSummary) => ({ siteId: pos.siteId, zoneId: pos.zoneId });

export type DashboardScope =
  | {
      readonly status: 'OK';
      readonly kept: readonly PointOfSaleSummary[];
      /** La permission atteint tous les sites (portée `ALL`). */
      readonly allSites: boolean;
      readonly targets: DistributionTargets;
      readonly visibility: (siteId: string) => SiteVisibility;
    }
  /** `siteId` demandé : inconnu, pas un point de vente ou hors de la portée de la permission. */
  | { readonly status: 'SITE_NOT_VISIBLE' };

export interface DashboardScopeInput {
  readonly userId: string;
  readonly at: Date;
  readonly siteId?: string;
}

export async function resolveDashboardScope(
  executor: Executor,
  input: DashboardScopeInput,
): Promise<DashboardScope> {
  const allows = async (
    permissionCode: string,
    resource: { siteId?: string; zoneId?: string },
  ): Promise<boolean> =>
    (
      await evaluateAccess(executor, {
        userId: input.userId,
        permissionCode,
        occurredAt: input.at,
        resource,
      })
    ).allowed;

  const configured = await listPointsOfSale(
    executor,
    input.siteId !== undefined ? { siteIds: [input.siteId] } : {},
  );
  if (input.siteId !== undefined) {
    const requested = configured[0];
    if (requested === undefined || !(await allows(DISTRIBUTION_DASHBOARD_READ, resourceOf(requested)))) {
      return { status: 'SITE_NOT_VISIBLE' };
    }
  }
  const allSites = await allows(DISTRIBUTION_DASHBOARD_READ, {});
  const kept: PointOfSaleSummary[] = [];
  for (const pos of configured) {
    if (allSites || (await allows(DISTRIBUTION_DASHBOARD_READ, resourceOf(pos)))) kept.push(pos);
  }
  const targets = await distributionTargetsOf(executor, kept);

  // Droit annexe évalué par PDV (court-circuit si la portée est `ALL`).
  const perSite = async (permissionCode: string): Promise<ReadonlySet<string>> => {
    if (await allows(permissionCode, {})) return new Set(kept.map((pos) => pos.siteId));
    const allowed = new Set<string>();
    for (const pos of kept) {
      if (await allows(permissionCode, resourceOf(pos))) allowed.add(pos.siteId);
    }
    return allowed;
  };
  const [value, cashDetail, receivers, authors] = await Promise.all([
    perSite('inventory.valuation.read'),
    perSite('finance.cash.read'),
    perSite('sales.payment.read'),
    perSite('sync.monitor.read'),
  ]);
  return {
    status: 'OK',
    kept,
    allSites,
    targets,
    visibility: (siteId: string): SiteVisibility => ({
      value: value.has(siteId),
      cashDetail: cashDetail.has(siteId),
      receivers: receivers.has(siteId),
      authors: authors.has(siteId),
    }),
  };
}
