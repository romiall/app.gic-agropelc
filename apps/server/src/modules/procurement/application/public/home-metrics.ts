/**
 * Chiffres de `procurement` pour l'accueil par rôle (ADR-030 ; KPI-APP-*) : nombre de demandes
 * d'achat, de bons de commande et de réceptions par statut. Lecture seule, sur toute l'entreprise
 * (les achats sont gérés centralement, RESP_ACHATS en portée `ALL`).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface ProcurementOverview {
  readonly requestsByStatus: Readonly<Record<string, number>>;
  readonly ordersByStatus: Readonly<Record<string, number>>;
  readonly receiptsByStatus: Readonly<Record<string, number>>;
}

function toCounts(rows: readonly { readonly status: string; readonly count: string }[]) {
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}

export async function procurementOverview(executor: Executor): Promise<ProcurementOverview> {
  const count = sql<string>`COUNT(*)`.as('count');
  const [requests, orders, receipts] = await Promise.all([
    executor
      .selectFrom('procurement_purchase_requests')
      .select(['status', count])
      .groupBy('status')
      .execute(),
    executor
      .selectFrom('procurement_purchase_orders')
      .select(['status', count])
      .groupBy('status')
      .execute(),
    executor
      .selectFrom('procurement_goods_receipts')
      .select(['status', count])
      .groupBy('status')
      .execute(),
  ]);
  return {
    requestsByStatus: toCounts(requests),
    ordersByStatus: toCounts(orders),
    receiptsByStatus: toCounts(receipts),
  };
}
