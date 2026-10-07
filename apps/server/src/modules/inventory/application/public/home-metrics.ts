/**
 * Chiffres d'`inventory` pour l'accueil par rôle (ECR-ADM-03 ; ADR-030) : santé du stock (ruptures,
 * seuils, soldes négatifs, valeur) et pertes récentes. Lecture seule sur les soldes et le registre ;
 * jamais de valeur stockée (BR-ANA-001). Le périmètre est celui du **site de l'emplacement**.
 * Les emplacements virtuels (clients, fournisseurs, pertes) ne comptent pas comme du stock.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { scopeSql, type ReadScope } from '../../../../platform/read-scope.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface StockHealth {
  /** Seuils actifs dont le disponible est nul ou négatif (KPI-STK-06, `STOCK_OUT`). */
  readonly stockOut: number;
  /** Seuils actifs sous le minimum mais encore disponibles (`STOCK_LOW`). */
  readonly stockLow: number;
  /** Couples emplacement × produit à solde négatif (INV-STK-05, `STOCK_NEGATIVE`). */
  readonly negativeBalances: number;
  /** Valeur du stock physique (KPI-STK-02) : exige `inventory.valuation.read` côté appelant. */
  readonly valueXaf: number;
  readonly thresholdsCount: number;
}

export async function stockHealth(executor: Executor, scope: ReadScope): Promise<StockHealth> {
  const siteCondition = scopeSql(scope, { site: 'organization_locations.site_id' });

  const thresholds = await executor
    .selectFrom('inventory_stock_thresholds as t')
    .innerJoin('organization_locations', 'organization_locations.id', 't.location_id')
    .leftJoin(
      (eb) =>
        eb
          .selectFrom('inventory_stock_balances as b')
          .select([
            'b.location_id as location_id',
            'b.product_id as product_id',
            sql<string>`SUM(b.qty_on_hand - b.qty_reserved - b.qty_allocated)`.as('available'),
          ])
          .groupBy(['b.location_id', 'b.product_id'])
          .as('bal'),
      (join) =>
        join
          .onRef('bal.location_id', '=', 't.location_id')
          .onRef('bal.product_id', '=', 't.product_id'),
    )
    .select([
      sql<string>`COALESCE(SUM(COALESCE(bal.available, 0) <= 0), 0)`.as('out_count'),
      sql<string>`COALESCE(SUM(COALESCE(bal.available, 0) > 0 AND COALESCE(bal.available, 0) < t.min_qty_base), 0)`.as(
        'low_count',
      ),
      sql<string>`COUNT(*)`.as('total'),
    ])
    .where('t.is_active', '=', 1)
    .where(siteCondition)
    .executeTakeFirstOrThrow();

  const negatives = await executor
    .selectFrom('inventory_stock_balances as b')
    .innerJoin('organization_locations', 'organization_locations.id', 'b.location_id')
    .select(
      sql<string>`COUNT(DISTINCT b.location_id, b.product_id, b.lot_key)`.as('negative_count'),
    )
    .where('organization_locations.is_virtual', '=', 0)
    .where('b.qty_on_hand', '<', '0')
    .where(siteCondition)
    .executeTakeFirstOrThrow();

  const value = await executor
    .selectFrom('inventory_stock_balances as b')
    .innerJoin('organization_locations', 'organization_locations.id', 'b.location_id')
    .select(sql<string>`COALESCE(SUM(b.value_xaf), 0)`.as('value'))
    .where('organization_locations.is_virtual', '=', 0)
    .where(siteCondition)
    .executeTakeFirstOrThrow();

  return {
    stockOut: Number(thresholds.out_count),
    stockLow: Number(thresholds.low_count),
    negativeBalances: Number(negatives.negative_count),
    valueXaf: Number(value.value),
    thresholdsCount: Number(thresholds.total),
  };
}

export interface RecentLosses {
  /** Têtes mortes ou perdues (animaux) depuis `since`, y compris celles en attente de validation. */
  readonly animalHeads: number;
  /** Valeur des pertes tous produits confondus. */
  readonly valueXaf: number;
}

/**
 * Pertes enregistrées depuis `since` (KPI-PRD-02, KPI-STK-03) : mouvements vers `V_LOSS` ou
 * `V_PENDING_LOSS` depuis un emplacement du périmètre. Les animaux se reconnaissent à la famille
 * biologique du produit.
 */
export async function recentLosses(
  executor: Executor,
  scope: ReadScope,
  since: Date,
): Promise<RecentLosses> {
  const row = await executor
    .selectFrom('inventory_stock_moves as m')
    .innerJoin('organization_locations as src', 'src.id', 'm.from_location_id')
    .innerJoin('organization_locations as dst', 'dst.id', 'm.to_location_id')
    .innerJoin('catalog_products as p', 'p.id', 'm.product_id')
    .select([
      sql<string>`COALESCE(SUM(CASE WHEN p.stock_family = 'BIOLOGIQUE' THEN m.quantity ELSE 0 END), 0)`.as(
        'heads',
      ),
      sql<string>`COALESCE(SUM(m.value_xaf), 0)`.as('value'),
    ])
    .where('dst.location_type', 'in', ['V_LOSS', 'V_PENDING_LOSS'])
    .where('m.is_reversal', '=', 0)
    .where('m.occurred_at', '>=', since)
    .where(scopeSql(scope, { site: 'src.site_id' }))
    .executeTakeFirstOrThrow();
  return { animalHeads: Number(row.heads), valueXaf: Number(row.value) };
}
