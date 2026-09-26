/**
 * Lectures des visites, interactions et objectifs (P3-06 ; `GET /visits`, `/interactions`,
 * `/targets`) et de l'effort commercial d'un utilisateur sur une période (ECR-CRM-05 en version
 * simple ; AT-015). Aucune décision d'autorisation ici (transport `crm-api/`).
 *
 * Effort commercial (BR-CRM-019 : calculé sur `occurred_at` et l'attribution **figée**, jamais sur
 * le titulaire courant) :
 * - prospects créés : comptes **acquis** par l'utilisateur dans la période (hors comptes absorbés
 *   par fusion, dont l'acquisition est portée par le compte conservé, BR-CRM-007) ;
 * - visites et interactions **enregistrées** (les annulées sont exclues, SM-VISIT) ;
 * - comptes et prospects visités : comptes distincts, et parmi eux ceux visités au stade
 *   `PROSPECT` (`customer_stage_at_visit`) ;
 * - nouveaux clients : conversions de la période attribuées au **titulaire à la date de
 *   conversion** (BR-CRM-010). Chiffre d'affaires et commandes : P4.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { pageOf, type Page } from './customer-query.js';

type Executor = Kysely<DB> | Transaction<DB>;

/** Colonne `DATE` lue (mysql2 : minuit local) → `AAAA-MM-JJ`. */
function dateOnly(value: Date | null): string | null {
  if (value === null) return null;
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

function flagsOf(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export interface ActivityFilter {
  readonly userId?: string;
  /** Ancrage par défaut : l'un de ces auteurs. */
  readonly userIds?: readonly string[];
  readonly customerIds?: readonly string[];
  readonly fromUtc?: Date;
  readonly toUtc?: Date;
  readonly beforeId?: string;
  readonly limit: number;
}

export interface VisitSummary {
  readonly id: string;
  readonly customerId: string;
  /** Zone du compte (portée de lecture, RC-04). */
  readonly customerZoneId: string;
  readonly userId: string;
  readonly workSessionId: string | null;
  readonly customerStageAtVisit: string;
  readonly position: {
    readonly lat: number;
    readonly lng: number;
    readonly accuracyM: number | null;
  } | null;
  readonly distanceToCustomerM: number | null;
  readonly outcomeReasonCodeId: string;
  readonly notes: string | null;
  readonly nextActionAt: string | null;
  readonly nextActionNote: string | null;
  readonly flags: readonly string[];
  readonly status: string;
  readonly cancelledAt: Date | null;
  readonly cancelledBy: string | null;
  readonly cancelComment: string | null;
  readonly occurredAt: Date;
  readonly capturedOffline: boolean;
  readonly clockSuspect: boolean;
}

const EMPTY_PAGE = { items: [], nextCursor: null } as const;

export async function listVisits(
  executor: Executor,
  filter: ActivityFilter,
): Promise<Page<VisitSummary>> {
  if (filter.customerIds?.length === 0 || filter.userIds?.length === 0) return EMPTY_PAGE;
  const rows = await executor
    .selectFrom('crm_visits as v')
    .innerJoin('crm_customers as c', 'c.id', 'v.customer_id')
    .selectAll('v')
    .select('c.zone_id as customer_zone_id')
    .$if(filter.userId !== undefined, (qb) => qb.where('v.user_id', '=', toBin(filter.userId!)))
    .$if(filter.userIds !== undefined, (qb) =>
      qb.where(
        'v.user_id',
        'in',
        filter.userIds!.map((id) => toBin(id)),
      ),
    )
    .$if(filter.customerIds !== undefined, (qb) =>
      qb.where(
        'v.customer_id',
        'in',
        filter.customerIds!.map((id) => toBin(id)),
      ),
    )
    .$if(filter.fromUtc !== undefined, (qb) => qb.where('v.occurred_at', '>=', filter.fromUtc!))
    .$if(filter.toUtc !== undefined, (qb) => qb.where('v.occurred_at', '<', filter.toUtc!))
    .$if(filter.beforeId !== undefined, (qb) => qb.where('v.id', '<', toBin(filter.beforeId!)))
    .orderBy('v.id', 'desc')
    .limit(filter.limit + 1)
    .execute();
  return pageOf(rows, filter.limit, (row) => ({
    id: fromBin(row.id),
    customerId: fromBin(row.customer_id),
    customerZoneId: fromBin(row.customer_zone_id),
    userId: fromBin(row.user_id),
    workSessionId: fromBinOrNull(row.work_session_id),
    customerStageAtVisit: row.customer_stage_at_visit,
    position:
      row.lat === null || row.lng === null
        ? null
        : {
            lat: Number(row.lat),
            lng: Number(row.lng),
            accuracyM: row.accuracy_m === null ? null : Number(row.accuracy_m),
          },
    distanceToCustomerM:
      row.distance_to_customer_m === null ? null : Number(row.distance_to_customer_m),
    outcomeReasonCodeId: fromBin(row.outcome_reason_code_id),
    notes: row.notes,
    nextActionAt: dateOnly(row.next_action_at),
    nextActionNote: row.next_action_note,
    flags: flagsOf(row.flags),
    status: row.status,
    cancelledAt: row.cancelled_at,
    cancelledBy: fromBinOrNull(row.cancelled_by),
    cancelComment: row.cancel_comment,
    occurredAt: row.occurred_at,
    capturedOffline: Boolean(row.captured_offline),
    clockSuspect: Boolean(row.clock_suspect),
  }));
}

export interface InteractionSummary {
  readonly id: string;
  readonly customerId: string;
  readonly customerZoneId: string;
  readonly userId: string;
  readonly channel: string;
  readonly direction: string;
  readonly summary: string | null;
  readonly nextActionAt: string | null;
  readonly nextActionNote: string | null;
  readonly status: string;
  readonly cancelledAt: Date | null;
  readonly occurredAt: Date;
}

export async function listInteractions(
  executor: Executor,
  filter: ActivityFilter,
): Promise<Page<InteractionSummary>> {
  if (filter.customerIds?.length === 0 || filter.userIds?.length === 0) return EMPTY_PAGE;
  const rows = await executor
    .selectFrom('crm_interactions as i')
    .innerJoin('crm_customers as c', 'c.id', 'i.customer_id')
    .selectAll('i')
    .select('c.zone_id as customer_zone_id')
    .$if(filter.userId !== undefined, (qb) => qb.where('i.user_id', '=', toBin(filter.userId!)))
    .$if(filter.userIds !== undefined, (qb) =>
      qb.where(
        'i.user_id',
        'in',
        filter.userIds!.map((id) => toBin(id)),
      ),
    )
    .$if(filter.customerIds !== undefined, (qb) =>
      qb.where(
        'i.customer_id',
        'in',
        filter.customerIds!.map((id) => toBin(id)),
      ),
    )
    .$if(filter.fromUtc !== undefined, (qb) => qb.where('i.occurred_at', '>=', filter.fromUtc!))
    .$if(filter.toUtc !== undefined, (qb) => qb.where('i.occurred_at', '<', filter.toUtc!))
    .$if(filter.beforeId !== undefined, (qb) => qb.where('i.id', '<', toBin(filter.beforeId!)))
    .orderBy('i.id', 'desc')
    .limit(filter.limit + 1)
    .execute();
  return pageOf(rows, filter.limit, (row) => ({
    id: fromBin(row.id),
    customerId: fromBin(row.customer_id),
    customerZoneId: fromBin(row.customer_zone_id),
    userId: fromBin(row.user_id),
    channel: row.channel,
    direction: row.direction,
    summary: row.summary,
    nextActionAt: dateOnly(row.next_action_at),
    nextActionNote: row.next_action_note,
    status: row.status,
    cancelledAt: row.cancelled_at,
    occurredAt: row.occurred_at,
  }));
}

export interface TargetSummary {
  readonly id: string;
  readonly targetType: string;
  readonly userId: string | null;
  readonly teamId: string | null;
  readonly siteId: string | null;
  /** Responsable de l'équipe ciblée (portée d'une cible `TEAM`). */
  readonly teamManagerUserId: string | null;
  readonly metric: string;
  readonly productId: string | null;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly targetValue: number;
  readonly status: string;
}

export async function listTargets(
  executor: Executor,
  filter: {
    readonly userId?: string;
    readonly teamId?: string;
    readonly siteId?: string;
    /** Objectifs dont la période couvre ce jour (`AAAA-MM-JJ`). */
    readonly activeOn?: string;
    readonly includeCancelled?: boolean;
  },
): Promise<readonly TargetSummary[]> {
  const rows = await executor
    .selectFrom('crm_sales_targets as t')
    .leftJoin('organization_teams as team', 'team.id', 't.team_id')
    .selectAll('t')
    .select('team.manager_user_id as team_manager_user_id')
    .$if(filter.userId !== undefined, (qb) => qb.where('t.user_id', '=', toBin(filter.userId!)))
    .$if(filter.teamId !== undefined, (qb) => qb.where('t.team_id', '=', toBin(filter.teamId!)))
    .$if(filter.siteId !== undefined, (qb) => qb.where('t.site_id', '=', toBin(filter.siteId!)))
    .$if(filter.activeOn !== undefined, (qb) =>
      qb
        .where(sql<boolean>`t.period_start <= ${filter.activeOn!}`)
        .where(sql<boolean>`t.period_end >= ${filter.activeOn!}`),
    )
    .$if(filter.includeCancelled !== true, (qb) => qb.where('t.status', '=', 'ACTIVE'))
    .orderBy('t.period_start', 'desc')
    .limit(500)
    .execute();
  return rows.map((row) => ({
    id: fromBin(row.id),
    targetType: row.target_type,
    userId: fromBinOrNull(row.user_id),
    teamId: fromBinOrNull(row.team_id),
    siteId: fromBinOrNull(row.site_id),
    teamManagerUserId: fromBinOrNull(row.team_manager_user_id),
    metric: row.metric,
    productId: fromBinOrNull(row.product_id),
    periodStart: dateOnly(row.period_start)!,
    periodEnd: dateOnly(row.period_end)!,
    targetValue: Number(row.target_value),
    status: row.status,
  }));
}

export interface CommercialEffort {
  readonly prospectsCreated: number;
  readonly visits: number;
  readonly customersVisited: number;
  readonly prospectsVisited: number;
  readonly interactions: number;
  readonly newCustomers: number;
}

/** Effort commercial d'un utilisateur sur `[fromUtc, toUtc[` (voir l'en-tête). */
export async function commercialEffort(
  executor: Executor,
  input: { readonly userId: string; readonly fromUtc: Date; readonly toUtc: Date },
): Promise<CommercialEffort> {
  const user = toBin(input.userId);
  const created = await executor
    .selectFrom('crm_customers')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('acquired_by_user_id', '=', user)
    .where('stage', '<>', 'MERGED')
    .where('acquired_at', '>=', input.fromUtc)
    .where('acquired_at', '<', input.toUtc)
    .executeTakeFirstOrThrow();
  const visits = await executor
    .selectFrom('crm_visits')
    .select((eb) => [
      eb.fn.countAll<number>().as('n'),
      sql<number>`COUNT(DISTINCT customer_id)`.as('customers'),
      sql<number>`COUNT(DISTINCT CASE WHEN customer_stage_at_visit = 'PROSPECT' THEN customer_id END)`.as(
        'prospects',
      ),
    ])
    .where('user_id', '=', user)
    .where('status', '=', 'RECORDED')
    .where('occurred_at', '>=', input.fromUtc)
    .where('occurred_at', '<', input.toUtc)
    .executeTakeFirstOrThrow();
  const interactions = await executor
    .selectFrom('crm_interactions')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('user_id', '=', user)
    .where('status', '=', 'RECORDED')
    .where('occurred_at', '>=', input.fromUtc)
    .where('occurred_at', '<', input.toUtc)
    .executeTakeFirstOrThrow();
  const converted = await executor
    .selectFrom('crm_customers as c')
    .innerJoin('crm_customer_assignments as a', 'a.customer_id', 'c.id')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('a.user_id', '=', user)
    .where('c.converted_at', '>=', input.fromUtc)
    .where('c.converted_at', '<', input.toUtc)
    .whereRef('a.valid_from', '<=', 'c.converted_at')
    .where((eb) =>
      eb.or([eb('a.valid_to', 'is', null), eb('a.valid_to', '>', eb.ref('c.converted_at'))]),
    )
    .executeTakeFirstOrThrow();
  return {
    prospectsCreated: Number(created.n),
    visits: Number(visits.n),
    customersVisited: Number(visits.customers),
    prospectsVisited: Number(visits.prospects),
    interactions: Number(interactions.n),
    newCustomers: Number(converted.n),
  };
}
