/**
 * Lectures des quotas d'appareil (P5-17 ; ADR-033 ; dictionnaire `inventory.stock_allocations`,
 * `stock_allocation_entries`) pour la couche de transport (`GET /allocations`, `/allocations/{id}`).
 * Aucune décision d'autorisation ici (RC-04 : `inventory-api/` évalue la portée sur l'emplacement du
 * quota et son détenteur). Pagination par curseur, du plus récent au plus ancien sur `id` (UUIDv7).
 * Le registre (`entries`) fait foi : reste = Σ des entrées (INV-STK-20).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

export const ALLOCATION_STATUSES = ['ACTIVE', 'CLOSED', 'REVOKED'] as const;
export type AllocationStatus = (typeof ALLOCATION_STATUSES)[number];

export interface AllocationSummary {
  readonly id: string;
  readonly allocationType: string;
  readonly locationId: string;
  readonly productId: string;
  readonly lotId: string | null;
  readonly holderUserId: string | null;
  readonly holderDeviceId: string | null;
  readonly quantityGranted: number;
  readonly quantityRemaining: number;
  readonly validUntil: string | null;
  readonly status: AllocationStatus;
  readonly closeCause: string | null;
  readonly revocationPending: boolean;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
  readonly revokeReason: string | null;
  readonly releasedAt: string | null;
  readonly releaseDeclaredRemaining: number | null;
  readonly grantedBy: string;
  readonly createdAt: string;
  /** Version de l'agrégat (`base_version` de `inventory.allocation.increase`, ADR-033 §9). */
  readonly version: number;
}

export interface AllocationEntryLine {
  readonly id: string;
  readonly entryType: string;
  readonly quantity: number;
  readonly stockMoveId: string | null;
  readonly occurredAt: string;
  readonly createdBy: string;
}

export interface ActiveAllocationTotal {
  readonly productId: string;
  readonly activeCount: number;
  readonly quantityRemaining: number;
}

type AllocationRow = Awaited<ReturnType<ReturnType<typeof selectAllocations>['execute']>>[number];

function selectAllocations(executor: Executor) {
  return executor.selectFrom('inventory_stock_allocations').selectAll();
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

function toSummary(row: AllocationRow): AllocationSummary {
  return {
    id: fromBin(row.id),
    allocationType: row.allocation_type,
    locationId: fromBin(row.location_id),
    productId: fromBin(row.product_id),
    lotId: fromBinOrNull(row.lot_id),
    holderUserId: fromBinOrNull(row.holder_user_id),
    holderDeviceId: fromBinOrNull(row.holder_device_id),
    quantityGranted: Number(row.quantity_granted),
    quantityRemaining: Number(row.quantity_remaining),
    validUntil: iso(row.valid_until),
    status: row.status as AllocationStatus,
    closeCause: row.close_cause,
    revocationPending: Boolean(row.revocation_pending),
    revokedAt: iso(row.revoked_at),
    revokedBy: fromBinOrNull(row.revoked_by),
    revokeReason: row.revoke_reason,
    releasedAt: iso(row.released_at),
    releaseDeclaredRemaining:
      row.release_declared_remaining === null ? null : Number(row.release_declared_remaining),
    grantedBy: fromBin(row.granted_by),
    createdAt: row.created_at.toISOString(),
    version: row.version,
  };
}

/**
 * Quotas d'un emplacement **ou** d'un détenteur (au moins l'un des deux), filtres facultatifs ;
 * du plus récent au plus ancien.
 */
export async function listAllocations(
  executor: Executor,
  filter: {
    readonly locationId?: string;
    readonly holderUserId?: string;
    readonly productId?: string;
    readonly status?: AllocationStatus;
    readonly beforeId?: string;
    readonly limit: number;
  },
): Promise<{ readonly items: readonly AllocationSummary[]; readonly nextCursor: string | null }> {
  if (filter.locationId === undefined && filter.holderUserId === undefined) {
    throw new Error('listAllocations : un emplacement ou un détenteur est requis.');
  }
  const rows = await selectAllocations(executor)
    .$if(filter.locationId !== undefined, (qb) =>
      qb.where('location_id', '=', toBin(filter.locationId!)),
    )
    .$if(filter.holderUserId !== undefined, (qb) =>
      qb.where('holder_user_id', '=', toBin(filter.holderUserId!)),
    )
    .$if(filter.productId !== undefined, (qb) =>
      qb.where('product_id', '=', toBin(filter.productId!)),
    )
    .$if(filter.status !== undefined, (qb) => qb.where('status', '=', filter.status!))
    .$if(filter.beforeId !== undefined, (qb) => qb.where('id', '<', toBin(filter.beforeId!)))
    .orderBy('id', 'desc')
    .limit(filter.limit + 1)
    .execute();
  const hasMore = rows.length > filter.limit;
  const page = hasMore ? rows.slice(0, filter.limit) : rows;
  return {
    items: page.map(toSummary),
    nextCursor: hasMore ? fromBin(page[page.length - 1]!.id) : null,
  };
}

export async function findAllocation(
  executor: Executor,
  id: string,
): Promise<AllocationSummary | null> {
  const row = await selectAllocations(executor).where('id', '=', toBin(id)).executeTakeFirst();
  return row ? toSummary(row) : null;
}

/** Registre d'un quota, dans l'ordre chronologique (`occurred_at`, puis `id`). */
export async function listAllocationEntries(
  executor: Executor,
  allocationId: string,
): Promise<readonly AllocationEntryLine[]> {
  const rows = await executor
    .selectFrom('inventory_stock_allocation_entries')
    .select(['id', 'entry_type', 'quantity', 'stock_move_id', 'occurred_at', 'created_by'])
    .where('allocation_id', '=', toBin(allocationId))
    .orderBy('occurred_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return rows.map((row) => ({
    id: fromBin(row.id),
    entryType: row.entry_type,
    quantity: Number(row.quantity),
    stockMoveId: fromBinOrNull(row.stock_move_id),
    occurredAt: row.occurred_at.toISOString(),
    createdBy: fromBin(row.created_by),
  }));
}

/** Σ des restes des quotas **actifs** d'un emplacement, par produit (la part promise du stock). */
export async function activeAllocationTotals(
  executor: Executor,
  locationId: string,
): Promise<readonly ActiveAllocationTotal[]> {
  const rows = await executor
    .selectFrom('inventory_stock_allocations')
    .select([
      'product_id',
      sql<string>`COUNT(*)`.as('active_count'),
      sql<string>`SUM(quantity_remaining)`.as('remaining'),
    ])
    .where('location_id', '=', toBin(locationId))
    .where('status', '=', 'ACTIVE')
    .groupBy('product_id')
    .orderBy('product_id')
    .execute();
  return rows.map((row) => ({
    productId: fromBin(row.product_id),
    activeCount: Number(row.active_count),
    quantityRemaining: Number(row.remaining),
  }));
}

/**
 * Appareils détenteurs d'un quota actif sur un emplacement des sites donnés (P5-19, AV-202 : appareils
 * d'un PDV pour la fraîcheur de synchronisation). Un tableau vide ne lit rien.
 */
export async function activeAllocationHolderDevices(
  executor: Executor,
  siteIds: readonly string[],
): Promise<readonly { readonly siteId: string; readonly deviceId: string }[]> {
  if (siteIds.length === 0) return [];
  const rows = await executor
    .selectFrom('inventory_stock_allocations as a')
    .innerJoin('organization_locations as l', 'l.id', 'a.location_id')
    .select(['l.site_id as site_id', 'a.holder_device_id as device_id'])
    .distinct()
    .where('a.status', '=', 'ACTIVE')
    .where('a.holder_device_id', 'is not', null)
    .where(
      'l.site_id',
      'in',
      siteIds.map((id) => toBin(id)),
    )
    .execute();
  return rows.map((row) => ({ siteId: fromBin(row.site_id!), deviceId: fromBin(row.device_id!) }));
}
