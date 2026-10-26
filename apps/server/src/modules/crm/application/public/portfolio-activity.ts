/**
 * Activité commerciale d'un périmètre (P9-15 ; KPI-COM-01 à 05, 11 et 12, ADR-065 §1) : fonctions de référence
 * des tableaux de la tour de contrôle et du tableau commercial. Elles reproduisent, sur les tables du module
 * `crm`, les définitions que la vue `analytics_f_prospecting` expose à l'explorateur (test d'équivalence).
 *
 * - **Prospects créés** : comptes créés dans la période (hors comptes fusionnés), par acquéreur.
 * - **Prospects visités** : comptes distincts au stade `PROSPECT` au moment de leur visite.
 * - **Visites** : visites enregistrées (non annulées).
 * - **Contacts collectés** : comptes créés avec un téléphone renseigné.
 * - **Nouveaux clients** : conversions (`converted_at` dans la période), au titulaire à l'instant de la
 *   conversion ; un compte fusionné n'est compté qu'une fois, par le compte conservé (AV-442).
 * - **Taux de conversion (cohorte)** : prospects créés dans la période et convertis à ce jour ÷ prospects créés.
 * - **Taux visite → commande** : visites de résultat `COMMANDE_PRISE` ÷ visites.
 *
 * Périmètre (`ReadScope`) : les sites sont ceux de rattachement du compte (`home_site_id`), les personnes
 * l'acteur de l'événement (acquéreur, auteur de la visite, titulaire à la conversion). Un périmètre vide ne
 * lit rien.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { num, ratio, type UtcWindow } from '../../../../platform/indicator-window.js';
import { scopeSql, type ReadScope } from '../../../../platform/read-scope.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface PortfolioActivity {
  readonly accountsCreated: number;
  readonly prospectsVisited: number;
  readonly visits: number;
  readonly contactsCollected: number;
  readonly newCustomers: number;
}

export interface ConversionCohort {
  readonly created: number;
  readonly converted: number;
  readonly rate: number | null;
}

export interface VisitToOrderRate {
  readonly visits: number;
  readonly orders: number;
  readonly rate: number | null;
}

/** Résultat de visite qui vaut commande prise (référentiel `catalog_reason_codes`, semé). */
export const ORDER_TAKEN_REASON_CODE = 'COMMANDE_PRISE';

export async function portfolioActivity(
  executor: Executor,
  scope: ReadScope,
  window: UtcWindow,
): Promise<PortfolioActivity> {
  const accounts = await sql<{ created: unknown; contacts: unknown }>`
    SELECT COUNT(*) AS created,
           COALESCE(SUM(c.phone_primary IS NOT NULL AND c.phone_primary <> ''), 0) AS contacts
      FROM crm_customers c
     WHERE c.acquired_at >= ${window.fromUtc} AND c.acquired_at < ${window.toUtc}
       AND c.stage <> 'MERGED'
       AND ${scopeSql(scope, { site: 'c.home_site_id', users: ['c.acquired_by_user_id'] })}
  `.execute(executor);
  const visits = await sql<{ visits: unknown; prospects: unknown }>`
    SELECT COUNT(*) AS visits,
           COUNT(DISTINCT CASE WHEN v.customer_stage_at_visit = 'PROSPECT' THEN v.customer_id END) AS prospects
      FROM crm_visits v
      JOIN crm_customers cu ON cu.id = v.customer_id
     WHERE v.status = 'RECORDED'
       AND v.occurred_at >= ${window.fromUtc} AND v.occurred_at < ${window.toUtc}
       AND ${scopeSql(scope, { site: 'cu.home_site_id', users: ['v.user_id'] })}
  `.execute(executor);
  const conversions = await sql<{ converted: unknown }>`
    SELECT COUNT(DISTINCT c.id) AS converted
      FROM crm_customers c
      JOIN crm_customer_assignments a
        ON a.customer_id = c.id AND a.valid_from <= c.converted_at
       AND (a.valid_to IS NULL OR a.valid_to > c.converted_at)
     WHERE c.converted_at >= ${window.fromUtc} AND c.converted_at < ${window.toUtc}
       AND c.stage <> 'MERGED'
       AND ${scopeSql(scope, { site: 'c.home_site_id', users: ['a.user_id'] })}
  `.execute(executor);
  return {
    accountsCreated: num(accounts.rows[0]?.created),
    prospectsVisited: num(visits.rows[0]?.prospects),
    visits: num(visits.rows[0]?.visits),
    contactsCollected: num(accounts.rows[0]?.contacts),
    newCustomers: num(conversions.rows[0]?.converted),
  };
}

export async function conversionCohort(
  executor: Executor,
  scope: ReadScope,
  window: UtcWindow,
): Promise<ConversionCohort> {
  const { rows } = await sql<{ created: unknown; converted: unknown }>`
    SELECT COUNT(*) AS created, COALESCE(SUM(c.converted_at IS NOT NULL), 0) AS converted
      FROM crm_customers c
     WHERE c.acquired_at >= ${window.fromUtc} AND c.acquired_at < ${window.toUtc}
       AND c.stage <> 'MERGED'
       AND ${scopeSql(scope, { site: 'c.home_site_id', users: ['c.acquired_by_user_id'] })}
  `.execute(executor);
  const created = num(rows[0]?.created);
  const converted = num(rows[0]?.converted);
  return { created, converted, rate: ratio(converted, created) };
}

export async function visitToOrderRate(
  executor: Executor,
  scope: ReadScope,
  window: UtcWindow,
): Promise<VisitToOrderRate> {
  const { rows } = await sql<{ visits: unknown; orders: unknown }>`
    SELECT COUNT(*) AS visits, COALESCE(SUM(rc.code = ${ORDER_TAKEN_REASON_CODE}), 0) AS orders
      FROM crm_visits v
      JOIN crm_customers cu ON cu.id = v.customer_id
      LEFT JOIN catalog_reason_codes rc ON rc.id = v.outcome_reason_code_id
     WHERE v.status = 'RECORDED'
       AND v.occurred_at >= ${window.fromUtc} AND v.occurred_at < ${window.toUtc}
       AND ${scopeSql(scope, { site: 'cu.home_site_id', users: ['v.user_id'] })}
  `.execute(executor);
  const visits = num(rows[0]?.visits);
  const orders = num(rows[0]?.orders);
  return { visits, orders, rate: ratio(orders, visits) };
}
