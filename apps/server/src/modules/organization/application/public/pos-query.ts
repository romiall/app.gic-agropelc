/**
 * Configuration d'un point de vente (organization.points_of_sale), lue par les modules de niveau
 * supérieur (`sales`, `finance`, `inventory`) sans lire la table : le PDV d'un emplacement de vente,
 * son magasin source, son mode de garde et son appareil désigné (P5-05, D05 UC-DIS-01). Le mode de
 * garde fait foi sur l'emplacement de vente (`organization_locations`, INV-DIS-01) ; la table PDV en
 * est la configuration d'origine, reportée par `organization.pos.configure` dans la même transaction.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';

export interface PosConfig {
  readonly siteId: string;
  readonly salesLocationId: string;
  readonly replenishmentSourceLocationId: string | null;
  readonly custodyMode: 'EXCLUSIVE_DEVICE' | 'SHARED';
  readonly designatedDeviceId: string | null;
  readonly version: number;
}

type Executor = Kysely<DB> | Transaction<DB>;

const COLUMNS = [
  'site_id',
  'sales_location_id',
  'replenishment_source_location_id',
  'custody_mode',
  'designated_device_id',
  'version',
] as const;

function toConfig(row: {
  site_id: Buffer;
  sales_location_id: Buffer;
  replenishment_source_location_id: Buffer | null;
  custody_mode: string;
  designated_device_id: Buffer | null;
  version: number;
}): PosConfig {
  return {
    siteId: fromBin(row.site_id),
    salesLocationId: fromBin(row.sales_location_id),
    replenishmentSourceLocationId: fromBinOrNull(row.replenishment_source_location_id),
    custodyMode: row.custody_mode === 'SHARED' ? 'SHARED' : 'EXCLUSIVE_DEVICE',
    designatedDeviceId: fromBinOrNull(row.designated_device_id),
    version: row.version,
  };
}

/** Configuration du PDV d'un site ; `null` si le site n'est pas (encore) configuré comme PDV. */
export async function findPosConfigBySite(
  executor: Executor,
  siteId: string,
): Promise<PosConfig | null> {
  const row = await executor
    .selectFrom('organization_points_of_sale')
    .select(COLUMNS)
    .where('site_id', '=', toBin(siteId))
    .executeTakeFirst();
  return row ? toConfig(row) : null;
}

/** PDV dont l'appareil donné est l'appareil désigné (mode `EXCLUSIVE_DEVICE`) ; `null` s'il n'en désigne aucun. */
export async function findPosConfigByDesignatedDevice(
  executor: Executor,
  deviceId: string,
): Promise<PosConfig | null> {
  const row = await executor
    .selectFrom('organization_points_of_sale')
    .select(COLUMNS)
    .where('designated_device_id', '=', toBin(deviceId))
    .executeTakeFirst();
  return row ? toConfig(row) : null;
}

/** PDV dont l'emplacement donné est l'emplacement de vente ; `null` si ce n'en est pas un. */
export async function findPosConfigBySalesLocation(
  executor: Executor,
  salesLocationId: string,
): Promise<PosConfig | null> {
  const row = await executor
    .selectFrom('organization_points_of_sale')
    .select(COLUMNS)
    .where('sales_location_id', '=', toBin(salesLocationId))
    .executeTakeFirst();
  return row ? toConfig(row) : null;
}
