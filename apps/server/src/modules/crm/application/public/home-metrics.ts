/**
 * Chiffres du portefeuille clients pour l'accueil par rôle (ADR-030 ; KPI-COM-13, KPI-COM-14).
 * Lecture seule. Un client est **inactif** quand il n'a aucune vente depuis `inactiveDays` jours
 * (AV-013, 30 par défaut) ; un client jamais vendu depuis sa conversion l'est aussi.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface PortfolioHealth {
  readonly customers: number;
  readonly inactiveCustomers: number;
  readonly prospects: number;
}

/**
 * `ownerUserIds` : titulaires lus (absent : tout le portefeuille). Un tableau vide ne lit rien.
 */
export async function portfolioHealth(
  executor: Executor,
  input: {
    readonly ownerUserIds?: readonly string[];
    readonly at: Date;
    readonly inactiveDays: number;
  },
): Promise<PortfolioHealth> {
  if (input.ownerUserIds?.length === 0) return { customers: 0, inactiveCustomers: 0, prospects: 0 };
  const limit = new Date(input.at.getTime() - input.inactiveDays * 86_400_000);
  const row = await executor
    .selectFrom('crm_customers')
    .select([
      sql<string>`COALESCE(SUM(stage = 'CUSTOMER'), 0)`.as('customers'),
      sql<string>`COALESCE(SUM(stage = 'CUSTOMER' AND (last_sale_at IS NULL OR last_sale_at < ${limit})), 0)`.as(
        'inactive',
      ),
      sql<string>`COALESCE(SUM(stage = 'PROSPECT'), 0)`.as('prospects'),
    ])
    .where('stage', 'in', ['CUSTOMER', 'PROSPECT'])
    .$if(input.ownerUserIds !== undefined, (qb) =>
      qb.where(
        'owner_user_id',
        'in',
        input.ownerUserIds!.map((id) => toBin(id)),
      ),
    )
    .executeTakeFirstOrThrow();
  return {
    customers: Number(row.customers),
    inactiveCustomers: Number(row.inactive),
    prospects: Number(row.prospects),
  };
}
