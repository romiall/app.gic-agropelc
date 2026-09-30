/**
 * Effectif d'un lot de stock (INV-PRD-01 : l'effectif d'un lot de production n'est jamais saisi,
 * c'est la somme des soldes de son lot de traçabilité). Calculé à partir des mouvements, à un
 * instant donné (`occurred_at` ≤ `at`), sans dépendre de `production` :
 * - `REARING` (effectif en élevage, BR-PRD-003) : emplacements `BUILDING` et `PEN` — base du
 *   seuil relatif de mortalité (BR-PRD-006) et des têtes × jours (ADR-026) ;
 * - `UNSOLD` (effectif non vendu) : tous les emplacements physiques et le transit — base du coût
 *   par tête (ADR-027). Une mortalité en attente de validation (`V_PENDING_LOSS`) n'y est plus.
 *
 * Un lot = un produit (AV-099) : l'effectif est celui du lot, tous produits confondus.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import { headDaysInPeriod } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

/**
 * `PENDING_LOSS` : têtes du lot en attente de validation d'une perte (`V_PENDING_LOSS`, toutes
 * catégories) — elles peuvent revenir au lot si la déclaration est rejetée ; la clôture les
 * refuse (revue P7).
 */
export type HeadcountScope = 'REARING' | 'UNSOLD' | 'PENDING_LOSS';

function scopeCondition(scope: HeadcountScope, alias: 'fl' | 'tl') {
  if (scope === 'REARING') {
    return sql<boolean>`${sql.ref(`${alias}.location_type`)} IN ('BUILDING', 'PEN')`;
  }
  if (scope === 'PENDING_LOSS') {
    return sql<boolean>`${sql.ref(`${alias}.location_type`)} = 'V_PENDING_LOSS'`;
  }
  return sql<boolean>`(${sql.ref(`${alias}.is_virtual`)} = 0 OR ${sql.ref(`${alias}.location_type`)} = 'V_TRANSIT')`;
}

/** Effectif du lot à `at` (inclus), ou actuel si `at` est omis. */
export async function lotHeadcount(
  executor: Executor,
  input: { readonly lotId: string; readonly scope: HeadcountScope; readonly at?: Date },
): Promise<number> {
  const at = input.at;
  const row = await executor
    .selectFrom('inventory_stock_moves as m')
    .innerJoin('organization_locations as fl', 'fl.id', 'm.from_location_id')
    .innerJoin('organization_locations as tl', 'tl.id', 'm.to_location_id')
    .select(
      sql<string>`COALESCE(SUM(
        (CASE WHEN ${scopeCondition(input.scope, 'tl')} THEN m.quantity ELSE 0 END)
        - (CASE WHEN ${scopeCondition(input.scope, 'fl')} THEN m.quantity ELSE 0 END)
      ), 0)`.as('qty'),
    )
    .where('m.lot_id', '=', toBin(input.lotId))
    .$if(at !== undefined, (qb) => qb.where('m.occurred_at', '<=', at!))
    .executeTakeFirstOrThrow();
  return Math.round(Number(row.qty) * 1000) / 1000;
}

/**
 * Têtes × jours du lot sur des jours métier consécutifs (ADR-026, AV-104) : effectif en fin de
 * chaque jour (Africa/Douala), jamais négatif. `fromUtc` est le début (inclus) du premier jour,
 * `toUtc` la fin (exclue) du dernier ; `days` la liste ordonnée des jours métier `AAAA-MM-JJ`.
 */
export async function lotHeadDays(
  executor: Executor,
  input: {
    readonly lotId: string;
    readonly scope: HeadcountScope;
    readonly fromUtc: Date;
    readonly toUtc: Date;
    readonly days: readonly string[];
  },
): Promise<number> {
  const opening = await lotHeadcount(executor, {
    lotId: input.lotId,
    scope: input.scope,
    at: new Date(input.fromUtc.getTime() - 1),
  });
  const rows = await executor
    .selectFrom('inventory_stock_moves as m')
    .innerJoin('organization_locations as fl', 'fl.id', 'm.from_location_id')
    .innerJoin('organization_locations as tl', 'tl.id', 'm.to_location_id')
    .select([
      sql<string>`DATE_FORMAT(CONVERT_TZ(m.occurred_at, '+00:00', '+01:00'), '%Y-%m-%d')`.as('day'),
      sql<string>`SUM(
        (CASE WHEN ${scopeCondition(input.scope, 'tl')} THEN m.quantity ELSE 0 END)
        - (CASE WHEN ${scopeCondition(input.scope, 'fl')} THEN m.quantity ELSE 0 END)
      )`.as('delta'),
    ])
    .where('m.lot_id', '=', toBin(input.lotId))
    .where('m.occurred_at', '>=', input.fromUtc)
    .where('m.occurred_at', '<', input.toUtc)
    .groupBy(sql`DATE_FORMAT(CONVERT_TZ(m.occurred_at, '+00:00', '+01:00'), '%Y-%m-%d')`)
    .execute();
  return headDaysInPeriod({
    openingHeadcount: opening,
    movements: rows.map((row) => ({ day: row.day, delta: Number(row.delta) })),
    days: input.days,
  });
}

/**
 * Quantité d'un produit d'un lot sortie en perte, calculée sur les mouvements (et non sur les
 * déclarations, qui ne retiennent qu'un lot quand le FIFO en touche plusieurs) : entrées dans
 * `V_LOSS` ou `V_PENDING_LOSS` depuis un emplacement physique, moins les retours (perte rejetée
 * ou annulée) ; la confirmation d'une perte en attente ne compte pas deux fois (revue P7).
 */
export async function lotLostQuantity(
  executor: Executor,
  input: { readonly lotId: string; readonly productId: string },
): Promise<number> {
  const row = await executor
    .selectFrom('inventory_stock_moves as m')
    .innerJoin('organization_locations as fl', 'fl.id', 'm.from_location_id')
    .innerJoin('organization_locations as tl', 'tl.id', 'm.to_location_id')
    .select(
      sql<string>`COALESCE(SUM(
        (CASE WHEN fl.is_virtual = 0 AND tl.location_type IN ('V_LOSS', 'V_PENDING_LOSS') THEN m.quantity ELSE 0 END)
        - (CASE WHEN fl.location_type IN ('V_LOSS', 'V_PENDING_LOSS') AND tl.is_virtual = 0 THEN m.quantity ELSE 0 END)
      ), 0)`.as('qty'),
    )
    .where('m.lot_id', '=', toBin(input.lotId))
    .where('m.product_id', '=', toBin(input.productId))
    .executeTakeFirstOrThrow();
  return Math.round(Number(row.qty) * 1000) / 1000;
}
