/**
 * Chiffres de `production` pour l'accueil par rôle (ADR-030 ; KPI-PRD-01).
 * Lecture seule : lots en cours et effectif. Le périmètre est le site du lot. L'alerte « saisie du jour
 * manquante » (`DAILY_ENTRY_MISSING`) n'est pas calculée ici : elle est levée par la passe
 * `production.lots.daily_entry_check` (P9-09, AV-462, `hasDailyEntryOn`), dont la définition de la
 * « saisie du jour » (aucune table d'en-tête) ne doit pas être recréée par cet aperçu.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import type { ReadScope } from '../../../../platform/read-scope.js';
import { listProductionLots } from './production-query.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface ProductionOverview {
  /** Lots `ACTIVE` ou `SELLING`. */
  readonly activeLots: number;
  /** Effectif en élevage (KPI-PRD-01) des lots en cours. */
  readonly rearingHeads: number;
  readonly sellingLots: number;
}

export async function productionOverview(
  executor: Executor,
  scope: ReadScope,
): Promise<ProductionOverview> {
  const siteIds = scope.siteIds;
  const lots: Awaited<ReturnType<typeof listProductionLots>>['items'][number][] = [];
  for (const status of ['ACTIVE', 'SELLING'] as const) {
    let cursor: string | undefined;
    for (;;) {
      const page = await listProductionLots(executor, {
        status,
        ...(siteIds !== undefined ? { siteIds } : {}),
        limit: 200,
        // Le curseur d'une page est l'identifiant du dernier lot rendu : `beforeId` (`cursor` n'est pas un
        // filtre de `listProductionLots` ; l'ignorer relisait la première page sans fin dès 201 lots).
        ...(cursor !== undefined ? { beforeId: cursor } : {}),
      });
      lots.push(...page.items);
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
  }
  if (lots.length === 0) {
    return { activeLots: 0, rearingHeads: 0, sellingLots: 0 };
  }
  const ids = new Set(lots.map((lot) => lot.id));
  return {
    activeLots: ids.size,
    rearingHeads: lots.reduce((sum, lot) => sum + lot.headcount.rearing, 0),
    sellingLots: lots.filter((lot) => lot.status === 'SELLING').length,
  };
}
