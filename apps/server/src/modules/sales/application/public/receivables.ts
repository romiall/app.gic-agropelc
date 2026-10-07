/**
 * Encours d'un client (BR-VEN-025, D09 §7.1) : somme des soldes dus de ses ventes non annulées. Les
 * créances et l'encours ne sont jamais stockés (ADR-010) : ils se calculent sur `balance_due_xaf`
 * (colonne générée, index `(customer_id, occurred_at)`). Un compte fusionné s'ajoute à celui qui
 * l'a absorbé (BR-CRM-007) : l'appelant passe le compte conservé.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { receivableAging, type AgingBucket } from '@gic/domain';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { absorbedCustomerIds } from '../../../crm/application/public/index.js';

export async function customerOutstandingXaf(
  executor: Kysely<DB> | Transaction<DB>,
  keptCustomerId: string,
): Promise<number> {
  const accounts = [keptCustomerId, ...(await absorbedCustomerIds(executor, keptCustomerId))];
  const row = await executor
    .selectFrom('sales_sales')
    .select(sql<string>`COALESCE(SUM(balance_due_xaf), 0)`.as('outstanding'))
    .where(
      'customer_id',
      'in',
      accounts.map((id) => toBin(id)),
    )
    .where('status', '<>', 'CANCELLED')
    // Lecture verrouillante : le compte est verrouillé par l'appelant, mais en isolation répétable
    // une lecture simple ne verrait pas la vente à crédit d'une transaction concurrente déjà validée
    // (plafond dépassé sans être détecté, BR-VEN-025).
    .forShare()
    .executeTakeFirst();
  return Number(row?.outstanding ?? 0);
}

export interface ReceivableLine {
  readonly saleId: string;
  readonly docNumber: string;
  readonly customerId: string | null;
  readonly siteId: string;
  readonly commercialUserId: string | null;
  readonly occurredAt: Date;
  /** Échéance `AAAA-MM-JJ` (AV-129). */
  readonly dueDate: string;
  readonly netTotalXaf: number;
  readonly amountPaidXaf: number;
  readonly balanceDueXaf: number;
  readonly daysOverdue: number;
  readonly overdue: boolean;
  readonly bucket: AgingBucket;
}

export interface ReceivableFilter {
  /** Jour métier de référence `AAAA-MM-JJ` (Africa/Douala). */
  readonly today: string;
  readonly customerIds?: readonly string[];
  readonly siteIds?: readonly string[];
  readonly commercialUserId?: string;
  /** Seulement les créances échues (échéance antérieure au jour). */
  readonly overdueOnly?: boolean;
  readonly limit?: number;
}

/**
 * BR-FIN-007 : créances par vente — ventes non annulées au solde dû positif, avec leur échéance, leurs
 * jours de retard et leur tranche d'ancienneté (`receivableAging`). La plus ancienne échéance d'abord.
 */
export async function listReceivables(
  executor: Kysely<DB> | Transaction<DB>,
  filter: ReceivableFilter,
): Promise<readonly ReceivableLine[]> {
  const rows = await executor
    .selectFrom('sales_sales')
    .select([
      'id',
      'doc_number',
      'customer_id',
      'site_id',
      'commercial_user_id',
      'occurred_at',
      'net_total_xaf',
      'amount_paid_xaf',
      'balance_due_xaf',
      sql<string>`DATE_FORMAT(due_date, '%Y-%m-%d')`.as('due'),
    ])
    .where('status', '<>', 'CANCELLED')
    .where('balance_due_xaf', '>', 0)
    .where('due_date', 'is not', null)
    .$if(filter.overdueOnly === true, (qb) => qb.where('due_date', '<', sql<Date>`${filter.today}`))
    .$if(filter.customerIds !== undefined, (qb) =>
      qb.where(
        'customer_id',
        'in',
        filter.customerIds!.map((id) => toBin(id)),
      ),
    )
    .$if(filter.siteIds !== undefined, (qb) =>
      qb.where(
        'site_id',
        'in',
        filter.siteIds!.map((id) => toBin(id)),
      ),
    )
    .$if(filter.commercialUserId !== undefined, (qb) =>
      qb.where('commercial_user_id', '=', toBin(filter.commercialUserId!)),
    )
    .orderBy('due_date', 'asc')
    .orderBy('occurred_at', 'asc')
    .orderBy('id', 'asc')
    .$if(filter.limit !== undefined, (qb) => qb.limit(filter.limit!))
    .execute();
  return rows.map((row) => {
    const aging = receivableAging(row.due!, filter.today);
    return {
      saleId: fromBin(row.id),
      docNumber: row.doc_number,
      customerId: fromBinOrNull(row.customer_id),
      siteId: fromBin(row.site_id),
      commercialUserId: fromBinOrNull(row.commercial_user_id),
      occurredAt: row.occurred_at,
      dueDate: row.due!,
      netTotalXaf: Number(row.net_total_xaf),
      amountPaidXaf: Number(row.amount_paid_xaf),
      balanceDueXaf: Number(row.balance_due_xaf),
      ...aging,
    };
  });
}

export interface ReceivableAgingSummary {
  readonly totalXaf: number;
  readonly overdueXaf: number;
  readonly count: number;
  readonly buckets: Readonly<Record<AgingBucket, number>>;
}

/** Créances par ancienneté (D09 §6) : total, échu, et montant par tranche. */
export function summarizeReceivables(lines: readonly ReceivableLine[]): ReceivableAgingSummary {
  const buckets: Record<AgingBucket, number> = { '0-30': 0, '31-60': 0, '61-90': 0, '>90': 0 };
  let totalXaf = 0;
  let overdueXaf = 0;
  for (const line of lines) {
    totalXaf += line.balanceDueXaf;
    if (line.overdue) {
      overdueXaf += line.balanceDueXaf;
      buckets[line.bucket] += line.balanceDueXaf;
    }
  }
  return { totalXaf, overdueXaf, count: lines.length, buckets };
}
