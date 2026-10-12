/**
 * Lectures de la structure (P5-17 ; 08-api-events/01-architecture-api.md §4.2 : `GET /sites`,
 * `/locations?site_id=`, `/points-of-sale`). Aucune décision d'autorisation ici : la couche de
 * transport `organization-api/` évalue la portée (`org.structure.read`, RC-04) sur le site et sa zone.
 * Un site fermé reste consultable (BR-ADM-008) ; les emplacements virtuels globaux (sans site) ne sont
 * jamais listés par site.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface SiteSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly siteType: string;
  readonly zoneId: string;
  readonly address: string | null;
  readonly lat: number | null;
  readonly lng: number | null;
  readonly status: string;
  readonly openedOn: string | null;
  readonly closedOn: string | null;
  readonly version: number;
}

export interface LocationSummary {
  readonly id: string;
  readonly siteId: string | null;
  readonly parentLocationId: string | null;
  readonly code: string;
  readonly name: string;
  readonly locationType: string;
  readonly isVirtual: boolean;
  readonly custodyMode: string | null;
  readonly custodianUserId: string | null;
  readonly designatedDeviceId: string | null;
  readonly capacity: number | null;
  readonly status: string;
  readonly version: number;
}

export interface PointOfSaleSummary {
  readonly siteId: string;
  readonly siteCode: string;
  readonly siteName: string;
  readonly siteStatus: string;
  readonly zoneId: string;
  readonly salesLocationId: string;
  readonly replenishmentSourceLocationId: string | null;
  readonly custodyMode: 'EXCLUSIVE_DEVICE' | 'SHARED';
  readonly designatedDeviceId: string | null;
  readonly openingHours: string | null;
  readonly version: number;
}

/** Jour `AAAA-MM-JJ` d'une colonne DATE (lue à minuit UTC par le pilote, réglé en UTC). */
function dateOnly(value: Date | null): string | null {
  if (value === null) return null;
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${value.getUTCFullYear()}-${month}-${day}`;
}

const numberOrNull = (value: unknown): number | null => (value === null ? null : Number(value));

type SiteRow = Awaited<ReturnType<ReturnType<typeof selectSites>['execute']>>[number];

function selectSites(executor: Executor) {
  return executor.selectFrom('organization_sites').selectAll();
}

function toSite(row: SiteRow): SiteSummary {
  return {
    id: fromBin(row.id),
    code: row.code,
    name: row.name,
    siteType: row.site_type,
    zoneId: fromBin(row.zone_id),
    address: row.address,
    lat: numberOrNull(row.lat),
    lng: numberOrNull(row.lng),
    status: row.status,
    openedOn: dateOnly(row.opened_on),
    closedOn: dateOnly(row.closed_on),
    version: row.version,
  };
}

/** Sites, par code ; filtres facultatifs (type, statut, zone directe). */
export async function listSites(
  executor: Executor,
  filter: {
    readonly siteType?: string;
    readonly status?: string;
    readonly zoneId?: string;
  } = {},
): Promise<readonly SiteSummary[]> {
  const rows = await selectSites(executor)
    .$if(filter.siteType !== undefined, (qb) => qb.where('site_type', '=', filter.siteType!))
    .$if(filter.status !== undefined, (qb) => qb.where('status', '=', filter.status!))
    .$if(filter.zoneId !== undefined, (qb) => qb.where('zone_id', '=', toBin(filter.zoneId!)))
    .orderBy('code', 'asc')
    .execute();
  return rows.map(toSite);
}

export async function findSite(executor: Executor, id: string): Promise<SiteSummary | null> {
  const row = await selectSites(executor).where('id', '=', toBin(id)).executeTakeFirst();
  return row ? toSite(row) : null;
}

/** Emplacements d'un site (physiques et virtuels rattachés au site), par code. */
export async function listLocations(
  executor: Executor,
  filter: {
    readonly siteId: string;
    readonly status?: string;
    readonly locationType?: string;
  },
): Promise<readonly LocationSummary[]> {
  const rows = await executor
    .selectFrom('organization_locations')
    .selectAll()
    .where('site_id', '=', toBin(filter.siteId))
    .$if(filter.status !== undefined, (qb) => qb.where('status', '=', filter.status!))
    .$if(filter.locationType !== undefined, (qb) =>
      qb.where('location_type', '=', filter.locationType!),
    )
    .orderBy('code', 'asc')
    .execute();
  return rows.map((row) => ({
    id: fromBin(row.id),
    siteId: fromBinOrNull(row.site_id),
    parentLocationId: fromBinOrNull(row.parent_location_id),
    code: row.code,
    name: row.name,
    locationType: row.location_type,
    isVirtual: Boolean(row.is_virtual),
    custodyMode: row.custody_mode,
    custodianUserId: fromBinOrNull(row.custodian_user_id),
    designatedDeviceId: fromBinOrNull(row.designated_device_id),
    capacity: numberOrNull(row.capacity),
    status: row.status,
    version: row.version,
  }));
}

/** Points de vente configurés, avec leur site ; filtre facultatif par sites. */
export async function listPointsOfSale(
  executor: Executor,
  filter: { readonly siteIds?: readonly string[] } = {},
): Promise<readonly PointOfSaleSummary[]> {
  if (filter.siteIds !== undefined && filter.siteIds.length === 0) return [];
  const rows = await executor
    .selectFrom('organization_points_of_sale as p')
    .innerJoin('organization_sites as s', 's.id', 'p.site_id')
    .select([
      'p.site_id',
      's.code as site_code',
      's.name as site_name',
      's.status as site_status',
      's.zone_id',
      'p.sales_location_id',
      'p.replenishment_source_location_id',
      'p.custody_mode',
      'p.designated_device_id',
      'p.opening_hours',
      'p.version',
    ])
    .$if(filter.siteIds !== undefined, (qb) =>
      qb.where(
        'p.site_id',
        'in',
        filter.siteIds!.map((id) => toBin(id)),
      ),
    )
    .orderBy('s.code', 'asc')
    .execute();
  return rows.map((row) => ({
    siteId: fromBin(row.site_id),
    siteCode: row.site_code,
    siteName: row.site_name,
    siteStatus: row.site_status,
    zoneId: fromBin(row.zone_id),
    salesLocationId: fromBin(row.sales_location_id),
    replenishmentSourceLocationId: fromBinOrNull(row.replenishment_source_location_id),
    custodyMode: row.custody_mode === 'SHARED' ? 'SHARED' : 'EXCLUSIVE_DEVICE',
    designatedDeviceId: fromBinOrNull(row.designated_device_id),
    openingHours: row.opening_hours,
    version: row.version,
  }));
}
