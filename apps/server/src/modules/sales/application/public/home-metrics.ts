/**
 * Chiffres de `sales` pour l'accueil par rôle (ECR-ADM-03 ; ADR-030) : créances, encaissements, dernières
 * ventes. Lecture seule, calculée à la demande sur les opérations (BR-ANA-001) : jamais de valeur stockée.
 * Le jour est le **jour métier** (`Africa/Douala`, BR-ANA-002). Le chiffre d'affaires et l'encaissé d'une
 * période suivent la définition par période d'activité partagée avec le tableau de distribution
 * (`period-activity.ts` ; P5-23, AV-200, AV-209, ADR-041).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin } from '../../../../platform/kysely/uuid-columns.js';
import { scopeSql, type ReadScope } from '../../../../platform/read-scope.js';
import { cashedActivity } from './period-activity.js';

type Executor = Kysely<DB> | Transaction<DB>;

const SALE_SCOPE = { site: 'sales_sales.site_id', users: ['seller_user_id', 'commercial_user_id'] };
const PAYMENT_SCOPE = { site: 'sales_customer_payments.site_id', users: ['received_by_user_id'] };

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
  /** Encaissements confirmés de la période (KPI-FIN-01) ; jamais négatif. */
  readonly paymentsCount: number;
  /** Encaissé net de la période : confirmés − annulations décidées dans la période (AV-200) ; négatif possible. */
  readonly amountXaf: number;
}

/** Encaissé de la période, par période d'activité (KPI-FIN-01 ; AV-200 (b), AV-244). */
export async function cashedSummary(
  executor: Executor,
  scope: ReadScope,
  period: { readonly fromDay: string; readonly toDay: string },
): Promise<CashedSummary> {
  const groups = await cashedByGroup(executor, scope, period);
  return {
    paymentsCount: groups.reduce((sum, group) => sum + group.paymentsCount, 0),
    amountXaf: groups.reduce((sum, group) => sum + group.amountXaf, 0),
  };
}

export interface CashedGroup {
  readonly siteId: string;
  readonly paymentMethodCode: string;
  readonly receivedByUserId: string;
  readonly paymentsCount: number;
  readonly amountXaf: number;
}

/**
 * Encaissé ventilé par site, moyen de paiement et receveur (P5-19 ; KPI-DIS-06 « encaissé du PDV »,
 * ADR-032 §9 : tous moyens du site, distinct de l'attendu de caisse). Même définition que
 * `cashedSummary`, dont il est la ventilation (BR-ANA-009) : par période d'activité (`cashedActivity`).
 */
export async function cashedByGroup(
  executor: Executor,
  scope: ReadScope,
  period: { readonly fromDay: string; readonly toDay: string },
): Promise<readonly CashedGroup[]> {
  const rows = await cashedActivity(executor, scope, period);
  return rows.map((row) => ({
    siteId: fromBin(row.siteId),
    paymentMethodCode: row.paymentMethodCode,
    receivedByUserId: fromBin(row.receivedByUserId),
    paymentsCount: row.confirmedCount,
    amountXaf: row.confirmedXaf - row.cancelledXaf,
  }));
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
