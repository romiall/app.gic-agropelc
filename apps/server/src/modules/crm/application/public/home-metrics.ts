/**
 * Chiffres du portefeuille clients pour l'accueil par rôle (ADR-030 ; KPI-COM-13, KPI-COM-14) et pour le bloc
 * COMMERCIAL des tableaux (P9-17). Lecture seule. Un client est **inactif** quand il n'a aucune vente depuis
 * `inactiveDays` jours (AV-013, réglage `crm.inactive_after_days`, 30 par défaut) ; un client jamais vendu depuis
 * sa conversion l'est aussi.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';

type Executor = Kysely<DB> | Transaction<DB>;

/** Réglage du délai d'inactivité d'un client (AV-013). */
export const INACTIVE_AFTER_DAYS_KEY = 'crm.inactive_after_days';
/** Défaut quand le réglage manque ou n'est pas un entier positif (valeur semée : 30). */
export const DEFAULT_INACTIVE_AFTER_DAYS = 30;
/** Borne technique (100 ans), hors seuil métier : au-delà, la date limite sortirait des dates de la base. */
const INACTIVE_AFTER_DAYS_TECHNICAL_MAX = 36_500;

/**
 * Nombre de jours sans vente après lequel un client est inactif : le réglage `crm.inactive_after_days` en vigueur
 * à `at` (TB-5 ; AV-013), un entier positif ; toute autre valeur retombe sur 30.
 */
export async function inactiveAfterDays(executor: Executor, at: Date): Promise<number> {
  const value = await currentSettingValue(executor, {
    key: INACTIVE_AFTER_DAYS_KEY,
    scopeType: 'GLOBAL',
    scopeId: null,
    at,
  });
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= INACTIVE_AFTER_DAYS_TECHNICAL_MAX
    ? value
    : DEFAULT_INACTIVE_AFTER_DAYS;
}

export interface PortfolioHealth {
  readonly customers: number;
  readonly inactiveCustomers: number;
  readonly prospects: number;
}

/**
 * Filtres, tous en ET (TB-1) :
 * - `ownerUserIds` : titulaires lus (absent : pas de filtre) ;
 * - `siteIds` : sites de rattachement lus (colonne `home_site_id`, renseignée par convention pour un compte sans
 *   titulaire, BR-CRM-003 ; absent : pas de filtre).
 * Un tableau vide ne lit rien (zéros), jamais tout le portefeuille.
 */
export async function portfolioHealth(
  executor: Executor,
  input: {
    readonly ownerUserIds?: readonly string[];
    readonly siteIds?: readonly string[];
    readonly at: Date;
    readonly inactiveDays: number;
  },
): Promise<PortfolioHealth> {
  if (input.ownerUserIds?.length === 0 || input.siteIds?.length === 0) {
    return { customers: 0, inactiveCustomers: 0, prospects: 0 };
  }
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
    .$if(input.siteIds !== undefined, (qb) =>
      qb.where(
        'home_site_id',
        'in',
        input.siteIds!.map((id) => toBin(id)),
      ),
    )
    .executeTakeFirstOrThrow();
  return {
    customers: Number(row.customers),
    inactiveCustomers: Number(row.inactive),
    prospects: Number(row.prospects),
  };
}
