/**
 * Agrégats d'inventaire pour les lectures de la production (P7-11 ; 08-api-events §4.7) : coûts
 * d'un objet de coût par nature et par mois métier, consommations et mortalités par jour
 * métier (Africa/Douala, UTC+1 sans heure d'été). Lecture seule ; le masquage des valeurs
 * (RC-05) est appliqué par le transport.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';
import type { CostObjectType } from './cost-entries.js';

type Executor = Kysely<DB> | Transaction<DB>;

/** Jour métier `AAAA-MM-JJ` d'une colonne d'instant (UTC → Douala). */
const businessDay = (column: string) =>
  sql<string>`DATE_FORMAT(CONVERT_TZ(${sql.ref(column)}, '+00:00', '+01:00'), '%Y-%m-%d')`;
const businessMonth = (column: string) =>
  sql<string>`DATE_FORMAT(CONVERT_TZ(${sql.ref(column)}, '+00:00', '+01:00'), '%Y-%m')`;

export interface CostBreakdownLine {
  readonly costType: string;
  readonly debitXaf: number;
  readonly creditXaf: number;
  readonly netXaf: number;
}

/** Coûts d'un objet de coût par nature (animaux, aliment, frais généraux, crédits…). */
export async function costObjectBreakdown(
  executor: Executor,
  target: { readonly costObjectType: CostObjectType; readonly costObjectId: string },
): Promise<readonly CostBreakdownLine[]> {
  const rows = await executor
    .selectFrom('inventory_cost_entries')
    .select([
      'cost_type',
      sql<string>`COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount_xaf ELSE 0 END), 0)`.as(
        'debit',
      ),
      sql<string>`COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_xaf ELSE 0 END), 0)`.as(
        'credit',
      ),
    ])
    .where('cost_object_type', '=', target.costObjectType)
    .where('cost_object_id', '=', toBin(target.costObjectId))
    .groupBy('cost_type')
    .orderBy('cost_type', 'asc')
    .execute();
  return rows.map((row) => ({
    costType: row.cost_type,
    debitXaf: Number(row.debit),
    creditXaf: Number(row.credit),
    netXaf: Number(row.debit) - Number(row.credit),
  }));
}

export interface MonthlyCostLine {
  /** Mois métier `AAAA-MM`. */
  readonly period: string;
  readonly debitXaf: number;
  readonly creditXaf: number;
  readonly netXaf: number;
}

/** Coûts d'un objet de coût par mois métier (résultat mensuel d'un lot permanent, AV-109). */
export async function costObjectMonthly(
  executor: Executor,
  target: { readonly costObjectType: CostObjectType; readonly costObjectId: string },
): Promise<readonly MonthlyCostLine[]> {
  const rows = await executor
    .selectFrom('inventory_cost_entries')
    .select([
      businessMonth('occurred_at').as('period'),
      sql<string>`COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount_xaf ELSE 0 END), 0)`.as(
        'debit',
      ),
      sql<string>`COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount_xaf ELSE 0 END), 0)`.as(
        'credit',
      ),
    ])
    .where('cost_object_type', '=', target.costObjectType)
    .where('cost_object_id', '=', toBin(target.costObjectId))
    .groupBy(businessMonth('occurred_at'))
    .orderBy(businessMonth('occurred_at'), 'asc')
    .execute();
  return rows.map((row) => ({
    period: row.period,
    debitXaf: Number(row.debit),
    creditXaf: Number(row.credit),
    netXaf: Number(row.debit) - Number(row.credit),
  }));
}

export interface ConsumptionLine {
  readonly productId: string;
  readonly costType: string | null;
  readonly quantityBase: number;
  readonly valueXaf: number;
}

export interface ConsumptionDayLine extends ConsumptionLine {
  /** Jour métier `AAAA-MM-JJ`. */
  readonly day: string;
}

function consumptionsOf(
  executor: Executor,
  target: { readonly costObjectType: CostObjectType; readonly costObjectId: string },
) {
  return executor
    .selectFrom('inventory_consumptions')
    .where('cost_object_type', '=', target.costObjectType)
    .where('cost_object_id', '=', toBin(target.costObjectId))
    .where('status', '=', 'RECORDED');
}

const qtyOf = (value: string) => Math.round(Number(value) * 1000) / 1000;

/** Consommations enregistrées (non annulées) d'un objet de coût, par jour métier sur `[fromUtc, toUtc)`. */
export async function costObjectConsumptionsByDay(
  executor: Executor,
  target: {
    readonly costObjectType: CostObjectType;
    readonly costObjectId: string;
    readonly fromUtc: Date;
    readonly toUtc: Date;
  },
): Promise<readonly ConsumptionDayLine[]> {
  const rows = await consumptionsOf(executor, target)
    .select([
      businessDay('occurred_at').as('day'),
      'product_id',
      'cost_type',
      sql<string>`COALESCE(SUM(quantity_base), 0)`.as('qty'),
      sql<string>`COALESCE(SUM(value_xaf), 0)`.as('value'),
    ])
    .where('occurred_at', '>=', target.fromUtc)
    .where('occurred_at', '<', target.toUtc)
    .groupBy([businessDay('occurred_at'), 'product_id', 'cost_type'])
    .execute();
  return rows.map((row) => ({
    day: row.day,
    productId: fromBin(row.product_id),
    costType: row.cost_type,
    quantityBase: qtyOf(row.qty),
    valueXaf: Number(row.value),
  }));
}

/** Totaux des consommations enregistrées d'un objet de coût, par produit et nature. */
export async function costObjectConsumptionTotals(
  executor: Executor,
  target: { readonly costObjectType: CostObjectType; readonly costObjectId: string },
): Promise<readonly ConsumptionLine[]> {
  const rows = await consumptionsOf(executor, target)
    .select([
      'product_id',
      'cost_type',
      sql<string>`COALESCE(SUM(quantity_base), 0)`.as('qty'),
      sql<string>`COALESCE(SUM(value_xaf), 0)`.as('value'),
    ])
    .groupBy(['product_id', 'cost_type'])
    .execute();
  return rows.map((row) => ({
    productId: fromBin(row.product_id),
    costType: row.cost_type,
    quantityBase: qtyOf(row.qty),
    valueXaf: Number(row.value),
  }));
}

export interface MortalityDayLine {
  readonly day: string;
  /** Morts comptées (enregistrées, validées, non contestées). */
  readonly countedQuantity: number;
  /** Morts en attente de validation. */
  readonly pendingQuantity: number;
}

/** Mortalités d'un lot de production par jour métier sur `[fromUtc, toUtc)`. */
export async function productionLotMortalityByDay(
  executor: Executor,
  target: { readonly productionLotId: string; readonly fromUtc: Date; readonly toUtc: Date },
): Promise<readonly MortalityDayLine[]> {
  const rows = await executor
    .selectFrom('inventory_loss_declarations')
    .select([
      businessDay('occurred_at').as('day'),
      sql<string>`COALESCE(SUM(CASE WHEN status IN ('RECORDED', 'APPROVED', 'CANCELLATION_PENDING') THEN quantity_base ELSE 0 END), 0)`.as(
        'counted',
      ),
      sql<string>`COALESCE(SUM(CASE WHEN status = 'PENDING_APPROVAL' THEN quantity_base ELSE 0 END), 0)`.as(
        'pending',
      ),
    ])
    .where('category', '=', 'MORTALITE')
    .where('production_lot_id', '=', toBin(target.productionLotId))
    .where('occurred_at', '>=', target.fromUtc)
    .where('occurred_at', '<', target.toUtc)
    .groupBy(businessDay('occurred_at'))
    .execute();
  return rows.map((row) => ({
    day: row.day,
    countedQuantity: Math.round(Number(row.counted) * 1000) / 1000,
    pendingQuantity: Math.round(Number(row.pending) * 1000) / 1000,
  }));
}
