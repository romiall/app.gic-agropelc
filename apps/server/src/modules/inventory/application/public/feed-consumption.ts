/**
 * Aliment consommé par objet de coût (P9-27 ; KPI-PRD-04, AV-462 choix (b), AV-476) : somme des quantités de base
 * des consommations `RECORDED` de nature `ALIMENT` imputées à un objet de coût (un lot de production en pratique),
 * datées de `[fromUtc, toUtc[`. C'est la lecture de `costObjectConsumptionsByDay` (filtre `ALIMENT`) et de la vue
 * `analytics_f_production_daily` (deuxième branche), regroupée par objet : `inventory` reste seul lecteur de
 * `inventory_consumptions` (règle 5), `production` choisit les lots du périmètre.
 *
 * Unité : la quantité de base du produit (kg pour les aliments, hypothèse déjà faite par l'indice de consommation).
 * Les consommations annulées (`CANCELLED`), de nature vétérinaire ou autre intrant, ou imputées à un autre type
 * d'objet de coût, ne comptent pas.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';
import type { CostObjectType } from './cost-entries.js';

type Executor = Kysely<DB> | Transaction<DB>;

/** Identifiants par requête : une liste `IN (…)` sans borne alourdirait l'analyse de la requête. */
const ID_CHUNK = 500;

export async function feedConsumedByCostObjects(
  executor: Executor,
  input: {
    readonly costObjectType: CostObjectType;
    readonly costObjectIds: readonly string[];
    /** Début de la période (inclus). */
    readonly fromUtc: Date;
    /** Fin de la période (exclue). */
    readonly toUtc: Date;
  },
): Promise<ReadonlyMap<string, number>> {
  const result = new Map<string, number>();
  if (input.costObjectIds.length === 0) return result;
  for (let start = 0; start < input.costObjectIds.length; start += ID_CHUNK) {
    const chunk = input.costObjectIds.slice(start, start + ID_CHUNK);
    const rows = await executor
      .selectFrom('inventory_consumptions')
      .select(['cost_object_id', sql<string>`COALESCE(SUM(quantity_base), 0)`.as('qty')])
      .where('cost_object_type', '=', input.costObjectType)
      .where(
        'cost_object_id',
        'in',
        chunk.map((id) => toBin(id)),
      )
      .where('cost_type', '=', 'ALIMENT')
      .where('status', '=', 'RECORDED')
      .where('occurred_at', '>=', input.fromUtc)
      .where('occurred_at', '<', input.toUtc)
      .groupBy('cost_object_id')
      .execute();
    for (const row of rows) {
      const id = fromBin(row.cost_object_id);
      // Un identifiant répété dans la liste ne double pas la somme : une ligne par objet et par requête.
      result.set(id, Math.round(Number(row.qty) * 1000) / 1000);
    }
  }
  return result;
}
