/**
 * Lectures des appareils (MP-06, ECR-ADM-05 ; dictionnaire `identity.devices`) pour la couche de transport
 * (`GET /devices`, `/devices/{id}`). Aucune décision d'autorisation ici : `identity-api/` évalue la portée
 * de chaque appareil (`deviceInScope`, AV-247). Pagination par curseur, du plus récent au plus ancien sur
 * `id`.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

export const DEVICE_STATUSES = ['PENDING', 'ACTIVE', 'BLOCKED', 'LOST', 'RETIRED'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

export interface DeviceSummary {
  readonly id: string;
  readonly shortCode: string;
  readonly label: string | null;
  readonly status: DeviceStatus;
  readonly statusReason: string | null;
  readonly statusChangedAt: Date | null;
  readonly platform: string | null;
  readonly appVersion: string | null;
  readonly isShared: boolean;
  readonly designatedSiteId: string | null;
  readonly enrolledByUserId: string;
  readonly approvedByUserId: string | null;
  readonly lastSeenAt: Date | null;
  readonly createdAt: Date;
  readonly version: number;
}

function selectDevices(executor: Executor) {
  return executor
    .selectFrom('identity_devices')
    .select([
      'id',
      'short_code',
      'label',
      'status',
      'status_reason',
      'status_changed_at',
      'platform',
      'app_version',
      'is_shared',
      'designated_site_id',
      'enrolled_by_user_id',
      'approved_by',
      'last_seen_at',
      'created_at',
      'version',
    ]);
}

type DeviceRow = Awaited<ReturnType<ReturnType<typeof selectDevices>['executeTakeFirstOrThrow']>>;

function toSummary(row: DeviceRow): DeviceSummary {
  return {
    id: fromBin(row.id),
    shortCode: row.short_code,
    label: row.label,
    status: row.status as DeviceStatus,
    statusReason: row.status_reason,
    statusChangedAt: row.status_changed_at,
    platform: row.platform,
    appVersion: row.app_version,
    isShared: Boolean(row.is_shared),
    designatedSiteId: fromBinOrNull(row.designated_site_id),
    enrolledByUserId: fromBin(row.enrolled_by_user_id),
    approvedByUserId: fromBinOrNull(row.approved_by),
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    version: row.version,
  };
}

/**
 * Page d'appareils, filtres facultatifs : état, recherche (code court exact, insensible à la casse, ou
 * libellé contenant le texte) ; du plus récent au plus ancien.
 */
export async function listDevicesPage(
  executor: Executor,
  filter: {
    readonly status?: DeviceStatus;
    readonly query?: string;
    readonly beforeId?: string;
    readonly limit: number;
  },
): Promise<{ readonly items: readonly DeviceSummary[]; readonly nextCursor: string | null }> {
  const query = filter.query?.trim();
  const rows = await selectDevices(executor)
    .$if(filter.status !== undefined, (qb) => qb.where('status', '=', filter.status!))
    .$if(query !== undefined && query !== '', (qb) =>
      qb.where((eb) =>
        eb.or([
          eb('short_code', '=', query!.toUpperCase()),
          eb('label', 'like', `%${query!.replace(/[\\%_]/g, (char) => `\\${char}`)}%`),
        ]),
      ),
    )
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

export async function findDevice(executor: Executor, id: string): Promise<DeviceSummary | null> {
  const row = await selectDevices(executor).where('id', '=', toBin(id)).executeTakeFirst();
  return row ? toSummary(row) : null;
}
