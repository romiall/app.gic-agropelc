/**
 * Chiffres de `sales` pour l'accueil par rôle (ECR-ADM-03 ; ADR-030) : chiffre d'affaires, créances,
 * encaissements, dernières ventes. Lecture seule, calculée à la demande sur les opérations
 * (BR-ANA-001) : jamais de valeur stockée. Le jour est le **jour métier** (`Africa/Douala`,
 * BR-ANA-002), colonne générée `business_date`. Une vente entièrement annulée est exclue ; le montant
 * annulé en partie est retranché (BR-ANA-003 : la contre-écriture à sa propre date viendra avec
 * `sales.sale.cancel`, P4-05).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin } from '../../../../platform/kysely/uuid-columns.js';
import { scopeSql, type ReadScope } from '../../../../platform/read-scope.js';

type Executor = Kysely<DB> | Transaction<DB>;

const SALE_SCOPE = { site: 'sales_sales.site_id', users: ['seller_user_id', 'commercial_user_id'] };
const PAYMENT_SCOPE = { site: 'sales_customer_payments.site_id', users: ['received_by_user_id'] };

export interface SalesPeriodSummary {
  readonly salesCount: number;
  /** CA net : total des ventes − montants annulés. */
  readonly netXaf: number;
  readonly paidXaf: number;
  readonly dueXaf: number;
  /** Ventes portant au moins une anomalie (drapeau) sur la période. */
  readonly flaggedCount: number;
}

/** Ventes du périmètre dont le jour métier est dans `[fromDay, toDay]` (inclus, `AAAA-MM-JJ`). */
export async function salesPeriodSummary(
  executor: Executor,
  scope: ReadScope,
  period: { readonly fromDay: string; readonly toDay: string },
): Promise<SalesPeriodSummary> {
  const row = await executor
    .selectFrom('sales_sales')
    .select([
      sql<string>`COUNT(*)`.as('count'),
      sql<string>`COALESCE(SUM(total_xaf - cancelled_xaf), 0)`.as('net'),
      sql<string>`COALESCE(SUM(amount_paid_xaf), 0)`.as('paid'),
      sql<string>`COALESCE(SUM(total_xaf - cancelled_xaf - amount_paid_xaf), 0)`.as('due'),
      sql<string>`COALESCE(SUM(JSON_LENGTH(flags) > 0), 0)`.as('flagged'),
    ])
    .where('status', '<>', 'CANCELLED')
    .where(sql`business_date`, '>=', sql<Date>`${period.fromDay}`)
    .where(sql`business_date`, '<=', sql<Date>`${period.toDay}`)
    .where(scopeSql(scope, SALE_SCOPE))
    .executeTakeFirstOrThrow();
  return {
    salesCount: Number(row.count),
    netXaf: Number(row.net),
    paidXaf: Number(row.paid),
    dueXaf: Number(row.due),
    flaggedCount: Number(row.flagged),
  };
}

export interface SalesDay {
  readonly day: string;
  readonly salesCount: number;
  readonly netXaf: number;
}

/** CA net par jour métier sur la période (les jours sans vente sont complétés par l'appelant). */
export async function salesDailySeries(
  executor: Executor,
  scope: ReadScope,
  period: { readonly fromDay: string; readonly toDay: string },
): Promise<readonly SalesDay[]> {
  const rows = await executor
    .selectFrom('sales_sales')
    .select([
      sql<string>`DATE_FORMAT(business_date, '%Y-%m-%d')`.as('day'),
      sql<string>`COUNT(*)`.as('count'),
      sql<string>`COALESCE(SUM(total_xaf - cancelled_xaf), 0)`.as('net'),
    ])
    .where('status', '<>', 'CANCELLED')
    .where(sql`business_date`, '>=', sql<Date>`${period.fromDay}`)
    .where(sql`business_date`, '<=', sql<Date>`${period.toDay}`)
    .where(scopeSql(scope, SALE_SCOPE))
    .groupBy(sql`business_date`)
    .orderBy(sql`business_date`)
    .execute();
  return rows.map((row) => ({
    day: row.day,
    salesCount: Number(row.count),
    netXaf: Number(row.net),
  }));
}

export interface ReceivablesSummary {
  /** Σ soldes dus des ventes non annulées (KPI-FIN-02). */
  readonly outstandingXaf: number;
  readonly openCount: number;
  /** Part dont l'échéance est dépassée à `today` (KPI-FIN-03). */
  readonly overdueXaf: number;
  readonly overdueCount: number;
}

export async function receivablesSummary(
  executor: Executor,
  scope: ReadScope,
  today: string,
): Promise<ReceivablesSummary> {
  const row = await executor
    .selectFrom('sales_sales')
    .select([
      sql<string>`COALESCE(SUM(balance_due_xaf), 0)`.as('outstanding'),
      sql<string>`COUNT(*)`.as('open'),
      sql<string>`COALESCE(SUM(CASE WHEN due_date < ${today} THEN balance_due_xaf ELSE 0 END), 0)`.as(
        'overdue',
      ),
      sql<string>`COALESCE(SUM(due_date < ${today}), 0)`.as('overdue_count'),
    ])
    .where('status', '<>', 'CANCELLED')
    .where(sql`balance_due_xaf`, '>', 0)
    .where(scopeSql(scope, SALE_SCOPE))
    .executeTakeFirstOrThrow();
  return {
    outstandingXaf: Number(row.outstanding),
    openCount: Number(row.open),
    overdueXaf: Number(row.overdue),
    overdueCount: Number(row.overdue_count),
  };
}

export interface CashedSummary {
  readonly paymentsCount: number;
  readonly amountXaf: number;
}

/** Encaissements confirmés (`RECORDED`) dont le jour métier est dans la période (KPI-FIN-01). */
export async function cashedSummary(
  executor: Executor,
  scope: ReadScope,
  period: { readonly fromDay: string; readonly toDay: string },
): Promise<CashedSummary> {
  const row = await executor
    .selectFrom('sales_customer_payments')
    .select([
      sql<string>`COUNT(*)`.as('count'),
      sql<string>`COALESCE(SUM(amount_xaf), 0)`.as('amount'),
    ])
    .where('status', '=', 'RECORDED')
    .where(sql`business_date`, '>=', sql<Date>`${period.fromDay}`)
    .where(sql`business_date`, '<=', sql<Date>`${period.toDay}`)
    .where(scopeSql(scope, PAYMENT_SCOPE))
    .executeTakeFirstOrThrow();
  return { paymentsCount: Number(row.count), amountXaf: Number(row.amount) };
}

/** Encaissements mis de côté comme doublons, en attente de décision de la Finance (AV-056). */
export async function suspectPaymentsCount(executor: Executor, scope: ReadScope): Promise<number> {
  const row = await executor
    .selectFrom('sales_customer_payments')
    .select(sql<string>`COUNT(*)`.as('count'))
    .where('status', '=', 'SUSPECT_DUPLICATE')
    .where(scopeSql(scope, PAYMENT_SCOPE))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

export interface RecentSale {
  readonly id: string;
  readonly docNumber: string;
  readonly occurredAt: Date;
  readonly customerId: string | null;
  readonly totalXaf: number;
  readonly paymentStatus: string;
  readonly flags: readonly string[];
  readonly sellerUserId: string;
}

/** Dernières ventes du périmètre, de la plus récente à la plus ancienne. */
export async function recentSales(
  executor: Executor,
  scope: ReadScope,
  limit: number,
): Promise<readonly RecentSale[]> {
  const rows = await executor
    .selectFrom('sales_sales')
    .select([
      'id',
      'doc_number',
      'occurred_at',
      'customer_id',
      'total_xaf',
      'payment_status',
      'flags',
      'seller_user_id',
    ])
    .where('status', '<>', 'CANCELLED')
    .where(scopeSql(scope, SALE_SCOPE))
    .orderBy('occurred_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
  return rows.map((row) => {
    const flags = typeof row.flags === 'string' ? JSON.parse(row.flags) : row.flags;
    return {
      id: fromBin(row.id),
      docNumber: row.doc_number,
      occurredAt: row.occurred_at,
      customerId: row.customer_id ? fromBin(row.customer_id) : null,
      totalXaf: Number(row.total_xaf),
      paymentStatus: row.payment_status ?? 'UNPAID',
      flags: Array.isArray(flags) ? (flags as string[]) : [],
      sellerUserId: fromBin(row.seller_user_id),
    };
  });
}
