/**
 * Lectures des comptes clients (P3-06 ; 08-api-events/01-architecture-api.md §4.4 :
 * `GET /customers`, `/customers/{id}`, `/customers/duplicate-check`). Même contrat que les
 * lectures d'`inventory` : aucune décision d'autorisation ici — la portée est décidée par le
 * transport `crm-api/` (RC-04), à partir de `customerResourceOf`.
 *
 * Pagination par curseur, du plus récent au plus ancien sur `id` (UUIDv7 de création,
 * 01-architecture-api.md §2) ; le curseur est l'`id` du dernier élément **examiné**.
 */
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import type { CrmCustomers } from '../../../../platform/kysely/schema.generated.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import type { ResourceLocator } from '../../../identity/application/public/index.js';

type Executor = Kysely<DB> | Transaction<DB>;

export const CRM_LIST_DEFAULT_LIMIT = 50;
export const CRM_LIST_MAX_LIMIT = 200;

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export function pageOf<Row extends { readonly id: Buffer }, T>(
  rows: readonly Row[],
  limit: number,
  map: (row: Row) => T,
): Page<T> {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return { items: page.map(map), nextCursor: hasMore && last ? fromBin(last.id) : null };
}

export interface CustomerSummary {
  readonly id: string;
  readonly stage: string;
  readonly pipelineStepId: string | null;
  readonly customerType: string;
  readonly displayName: string;
  readonly contactName: string | null;
  readonly businessActivity: string | null;
  readonly categoryId: string | null;
  readonly phonePrimary: string | null;
  readonly phoneSecondary: string | null;
  readonly email: string | null;
  readonly addressText: string | null;
  readonly zoneId: string;
  readonly position: {
    readonly lat: number;
    readonly lng: number;
    readonly accuracyM: number | null;
  } | null;
  readonly sourceCode: string;
  readonly acquiredByUserId: string;
  readonly acquiredAt: Date;
  readonly ownerUserId: string | null;
  readonly homeSiteId: string | null;
  readonly convertedAt: Date | null;
  readonly firstSaleId: string | null;
  readonly conversionReverted: boolean;
  readonly lostReasonCodeId: string | null;
  readonly mergedIntoId: string | null;
  readonly duplicateOfId: string | null;
  readonly creditAllowed: boolean;
  readonly creditLimitXaf: number | null;
  readonly paymentTermsDays: number | null;
  readonly lastSaleAt: Date | null;
  readonly version: number;
}

export function toCustomerSummary(row: Selectable<CrmCustomers>): CustomerSummary {
  return {
    id: fromBin(row.id),
    stage: row.stage,
    pipelineStepId: fromBinOrNull(row.pipeline_step_id),
    customerType: row.customer_type,
    displayName: row.display_name,
    contactName: row.contact_name,
    businessActivity: row.business_activity,
    categoryId: fromBinOrNull(row.category_id),
    phonePrimary: row.phone_primary,
    phoneSecondary: row.phone_secondary,
    email: row.email,
    addressText: row.address_text,
    zoneId: fromBin(row.zone_id),
    position:
      row.lat === null || row.lng === null
        ? null
        : {
            lat: Number(row.lat),
            lng: Number(row.lng),
            accuracyM: row.geo_accuracy_m === null ? null : Number(row.geo_accuracy_m),
          },
    sourceCode: row.source_code,
    acquiredByUserId: fromBin(row.acquired_by_user_id),
    acquiredAt: row.acquired_at,
    ownerUserId: fromBinOrNull(row.owner_user_id),
    homeSiteId: fromBinOrNull(row.home_site_id),
    convertedAt: row.converted_at,
    firstSaleId: fromBinOrNull(row.first_sale_id),
    conversionReverted: Boolean(row.conversion_reverted),
    lostReasonCodeId: fromBinOrNull(row.lost_reason_code_id),
    mergedIntoId: fromBinOrNull(row.merged_into_id),
    duplicateOfId: fromBinOrNull(row.duplicate_of_id),
    creditAllowed: Boolean(row.credit_allowed),
    creditLimitXaf: row.credit_limit_xaf === null ? null : Number(row.credit_limit_xaf),
    paymentTermsDays: row.payment_terms_days,
    lastSaleAt: row.last_sale_at,
    version: row.version,
  };
}

/** Ressource d'autorisation d'un compte à l'instant de la lecture (titulaire courant, RC-04). */
export function customerResourceOf(customer: CustomerSummary): ResourceLocator {
  return {
    ...(customer.ownerUserId !== null ? { ownerUserId: customer.ownerUserId } : {}),
    ...(customer.homeSiteId !== null ? { siteId: customer.homeSiteId } : {}),
    zoneId: customer.zoneId,
  };
}

export interface CustomerListFilter {
  /** Ancrage par défaut d'une liste sans critère : titulaires OU sites de rattachement. */
  readonly anyOf?: {
    readonly ownerUserIds: readonly string[];
    readonly siteIds: readonly string[];
  };
  readonly ownerUserId?: string;
  readonly siteId?: string;
  /** Zone ou l'une de ses sous-zones. */
  readonly zoneId?: string;
  /** Défaut : tous les stades sauf `MERGED`. */
  readonly stage?: string;
  /** Recherche approchée sur le nom affiché ou le téléphone. */
  readonly q?: string;
  readonly beforeId?: string;
  readonly limit: number;
}

export async function listCustomers(
  executor: Executor,
  filter: CustomerListFilter,
): Promise<Page<CustomerSummary>> {
  const digits = filter.q?.replace(/\D/g, '') ?? '';
  if (filter.anyOf && filter.anyOf.ownerUserIds.length + filter.anyOf.siteIds.length === 0) {
    return { items: [], nextCursor: null };
  }
  const rows = await executor
    .selectFrom('crm_customers')
    .selectAll()
    .$if(filter.anyOf !== undefined, (qb) =>
      qb.where((eb) =>
        eb.or([
          ...(filter.anyOf!.ownerUserIds.length > 0
            ? [
                eb(
                  'owner_user_id',
                  'in',
                  filter.anyOf!.ownerUserIds.map((id) => toBin(id)),
                ),
              ]
            : []),
          ...(filter.anyOf!.siteIds.length > 0
            ? [
                eb(
                  'home_site_id',
                  'in',
                  filter.anyOf!.siteIds.map((id) => toBin(id)),
                ),
              ]
            : []),
        ]),
      ),
    )
    .$if(filter.ownerUserId !== undefined, (qb) =>
      qb.where('owner_user_id', '=', toBin(filter.ownerUserId!)),
    )
    .$if(filter.siteId !== undefined, (qb) => qb.where('home_site_id', '=', toBin(filter.siteId!)))
    .$if(filter.zoneId !== undefined, (qb) =>
      qb.where(
        'zone_id',
        'in',
        executor
          .selectFrom('organization_zone_ancestors')
          .select('zone_id')
          .where('ancestor_id', '=', toBin(filter.zoneId!)),
      ),
    )
    .$if(filter.stage !== undefined, (qb) => qb.where('stage', '=', filter.stage!))
    .$if(filter.stage === undefined, (qb) => qb.where('stage', '<>', 'MERGED'))
    .$if(filter.q !== undefined && filter.q.trim() !== '', (qb) =>
      qb.where((eb) =>
        eb.or([
          eb('display_name', 'like', `%${filter.q!.trim()}%`),
          ...(digits.length >= 4 ? [eb('phone_primary', 'like', `%${digits}%`)] : []),
        ]),
      ),
    )
    .$if(filter.beforeId !== undefined, (qb) => qb.where('id', '<', toBin(filter.beforeId!)))
    .orderBy('id', 'desc')
    .limit(filter.limit + 1)
    .execute();
  return pageOf(rows, filter.limit, toCustomerSummary);
}

export async function getCustomer(
  executor: Executor,
  customerId: string,
): Promise<CustomerSummary | undefined> {
  const row = await executor
    .selectFrom('crm_customers')
    .selectAll()
    .where('id', '=', toBin(customerId))
    .executeTakeFirst();
  return row ? toCustomerSummary(row) : undefined;
}

/** Compte détenant ce téléphone normalisé parmi les comptes uniques (INV-CRM-03). */
export async function findCustomerByPhone(
  executor: Executor,
  phone: string,
): Promise<CustomerSummary | undefined> {
  const row = await executor
    .selectFrom('crm_customers')
    .selectAll()
    .where('phone_key', '=', phone)
    .executeTakeFirst();
  return row ? toCustomerSummary(row) : undefined;
}

/** Comptes absorbés par fusion dans ce compte (lectures agrégées, BR-CRM-007). */
export async function absorbedCustomerIds(
  executor: Executor,
  customerId: string,
): Promise<readonly string[]> {
  const rows = await executor
    .selectFrom('crm_customers')
    .select('id')
    .where('merged_into_id', '=', toBin(customerId))
    .execute();
  return rows.map((row) => fromBin(row.id));
}

export interface AssignmentPeriod {
  readonly userId: string;
  readonly validFrom: Date;
  readonly validTo: Date | null;
  readonly assignedBy: string;
  readonly reason: string | null;
}

/** Titulaires successifs (CM §8 ; BR-CRM-005), du plus ancien au plus récent. */
export async function listCustomerAssignments(
  executor: Executor,
  customerId: string,
): Promise<readonly AssignmentPeriod[]> {
  const rows = await executor
    .selectFrom('crm_customer_assignments')
    .select(['user_id', 'valid_from', 'valid_to', 'assigned_by', 'reason'])
    .where('customer_id', '=', toBin(customerId))
    .orderBy('valid_from', 'asc')
    .execute();
  return rows.map((row) => ({
    userId: fromBin(row.user_id),
    validFrom: row.valid_from,
    validTo: row.valid_to,
    assignedBy: fromBin(row.assigned_by),
    reason: row.reason,
  }));
}

export interface StageChange {
  readonly fromStage: string | null;
  readonly toStage: string;
  readonly fromStepId: string | null;
  readonly toStepId: string | null;
  readonly occurredAt: Date;
  readonly actorUserId: string;
  readonly reasonCodeId: string | null;
  readonly causeRef: string | null;
}

/** Évolution du compte (BR-CRM-008), dans l'ordre de l'heure métier. */
export async function listCustomerStageHistory(
  executor: Executor,
  customerId: string,
): Promise<readonly StageChange[]> {
  const rows = await executor
    .selectFrom('crm_customer_stage_history')
    .selectAll()
    .where('customer_id', '=', toBin(customerId))
    .orderBy('occurred_at', 'asc')
    .orderBy(sql`created_at`, 'asc')
    .execute();
  return rows.map((row) => ({
    fromStage: row.from_stage,
    toStage: row.to_stage,
    fromStepId: fromBinOrNull(row.from_step_id),
    toStepId: fromBinOrNull(row.to_step_id),
    occurredAt: row.occurred_at,
    actorUserId: fromBin(row.actor_user_id),
    reasonCodeId: fromBinOrNull(row.reason_code_id),
    causeRef: fromBinOrNull(row.cause_ref),
  }));
}
