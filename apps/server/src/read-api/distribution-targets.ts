/**
 * Cibles d'une lecture de distribution (P5-20 ; ADR-035, AV-204) : à partir des PDV **déjà filtrés** par
 * l'appelant (portée de la permission, `evaluateAccess`), leurs sites, emplacements de vente et caisses
 * de PDV. Couche de transport, partagée par le tableau de distribution (`distribution-api/`) et l'accueil
 * (`home-api/`) : elle compose les API publiques d'`organization` et de `finance`.
 *
 * Un périmètre vide ne lit rien (ADR-030 §5) : en particulier, `listCashAccounts` avec `siteIds: []`
 * renverrait les comptes **sans site** (caisse centrale, banque) ; on ne l'appelle donc pas.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../platform/kysely/database.js';
import type { PointOfSaleSummary } from '../modules/organization/application/public/index.js';
import { listCashAccounts } from '../modules/finance/application/public/index.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface DistributionTargets {
  readonly pointsOfSale: readonly PointOfSaleSummary[];
  readonly siteIds: readonly string[];
  readonly salesLocationIds: readonly string[];
  /** Caisses de PDV des sites, tous statuts (une session à valider d'une caisse remplacée compte). */
  readonly cashAccountIds: readonly string[];
  readonly cashAccountsBySite: ReadonlyMap<string, readonly string[]>;
}

export async function distributionTargetsOf(
  executor: Executor,
  pointsOfSale: readonly PointOfSaleSummary[],
): Promise<DistributionTargets> {
  if (pointsOfSale.length === 0) {
    return {
      pointsOfSale: [],
      siteIds: [],
      salesLocationIds: [],
      cashAccountIds: [],
      cashAccountsBySite: new Map(),
    };
  }
  const siteIds = pointsOfSale.map((pos) => pos.siteId);
  const known = new Set(siteIds);
  const accounts = (
    await listCashAccounts(executor, { siteIds, accountType: 'CAISSE_PDV' })
  ).filter((account) => account.siteId !== null && known.has(account.siteId));
  const bySite = new Map<string, string[]>();
  for (const account of accounts) {
    const list = bySite.get(account.siteId!) ?? [];
    list.push(account.id);
    bySite.set(account.siteId!, list);
  }
  return {
    pointsOfSale,
    siteIds,
    salesLocationIds: pointsOfSale.map((pos) => pos.salesLocationId),
    cashAccountIds: accounts.map((account) => account.id),
    cashAccountsBySite: bySite,
  };
}
