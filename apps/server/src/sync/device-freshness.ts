/**
 * Fraîcheur des appareils (P5-19 ; BR-ANA-005, D05 §12 « dernier contact de l'appareil », AV-165,
 * AV-202) : dernier contact de chaque appareil et opérations restantes déclarées par auteur, pour le
 * tableau de distribution (P5-20) et l'accueil. Couche `sync` (propriétaire de `sync_device_sync_state`) ;
 * `identity_devices` est une référence universelle (graphe des dépendances, note 1) ; les autres
 * modules sont lus par leur API publique.
 *
 * - **Dernier contact** = le plus récent de : connexion (`identity_devices.last_seen_at`), dernier envoi
 *   (`last_push_at`) et dernier pull (`last_pull_at`, écrit à chaque pull depuis P5-19) de la ligne
 *   `_device`. Un appareil est **en retard** sans contact depuis plus de
 *   `analytics.freshness_warning_hours` heures (2 par défaut).
 * - **Opérations restantes** : dernier total déclaré à un envoi (`pending_reported`, P5-07), par
 *   appareil et par auteur (tablette partagée) — `null` quand l'appareil n'a rien déclaré.
 * - **Appareils d'un site** (AV-202) : rattachés au site (`designated_site_id`), appareil désigné de
 *   son PDV, détenteurs d'un quota actif sur un emplacement du site.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../platform/kysely/uuid-columns.js';
import {
  currentSettingValue,
  listPointsOfSale,
} from '../modules/organization/application/public/index.js';
import { activeAllocationHolderDevices } from '../modules/inventory/application/public/index.js';
import { DEVICE_DATASET, authorOfDataset } from './sync-state-datasets.js';

type Executor = Kysely<DB> | Transaction<DB>;

export const FRESHNESS_WARNING_HOURS_KEY = 'analytics.freshness_warning_hours';
/** Défaut de BR-ANA-005 quand le paramètre manque ou est mal formé. */
export const DEFAULT_FRESHNESS_WARNING_HOURS = 2;

/** Appareils de chaque site (AV-202) ; un tableau vide ne lit rien. */
export async function devicesOfSites(
  executor: Executor,
  siteIds: readonly string[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  const bySite = new Map<string, Set<string>>();
  if (siteIds.length === 0) return new Map();
  const add = (siteId: string, deviceId: string) => {
    const set = bySite.get(siteId) ?? new Set<string>();
    set.add(deviceId);
    bySite.set(siteId, set);
  };
  const designated = await executor
    .selectFrom('identity_devices')
    .select(['id', 'designated_site_id'])
    .where(
      'designated_site_id',
      'in',
      siteIds.map((id) => toBin(id)),
    )
    .where('status', '=', 'ACTIVE')
    .execute();
  for (const row of designated) add(fromBin(row.designated_site_id!), fromBin(row.id));
  for (const pos of await listPointsOfSale(executor, { siteIds })) {
    if (pos.designatedDeviceId !== null) add(pos.siteId, pos.designatedDeviceId);
  }
  for (const holder of await activeAllocationHolderDevices(executor, siteIds)) {
    add(holder.siteId, holder.deviceId);
  }
  return new Map([...bySite.entries()].map(([site, set]) => [site, [...set].sort()]));
}

export interface AuthorFreshness {
  readonly userId: string;
  readonly lastPushAt: Date | null;
  readonly lastPullAt: Date | null;
  readonly pendingReported: number | null;
}

export interface DeviceFreshness {
  readonly deviceId: string;
  readonly shortCode: string;
  readonly label: string | null;
  readonly status: string;
  readonly isShared: boolean;
  readonly designatedSiteId: string | null;
  readonly lastSeenAt: Date | null;
  readonly lastPushAt: Date | null;
  readonly lastPullAt: Date | null;
  readonly lastContactAt: Date | null;
  readonly stale: boolean;
  readonly pendingReported: number | null;
  readonly authors: readonly AuthorFreshness[];
}

export interface DeviceFreshnessReport {
  readonly warningHours: number;
  readonly devices: readonly DeviceFreshness[];
  /** Appareils **en service** (`ACTIVE`) en retard (BR-ANA-005). Un appareil bloqué, perdu ou retiré reste
   * listé (désigné d'un PDV, détenteur d'un quota) sans compter : son signal est ailleurs (révocation
   * en attente, désignation à changer). */
  readonly staleCount: number;
}

/** Seuil en heures : paramètre global à `at`, sinon le défaut (jamais codé en dur ailleurs). */
export async function freshnessWarningHoursAt(executor: Executor, at: Date): Promise<number> {
  const value = await currentSettingValue(executor, {
    key: FRESHNESS_WARNING_HOURS_KEY,
    scopeType: 'GLOBAL',
    scopeId: null,
    at,
  });
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_FRESHNESS_WARNING_HOURS;
}

const latest = (...dates: readonly (Date | null)[]): Date | null =>
  dates.reduce<Date | null>(
    (max, date) => (date !== null && (max === null || date.getTime() > max.getTime()) ? date : max),
    null,
  );

/** Fraîcheur des appareils donnés ; un tableau vide ne lit rien. */
export async function deviceFreshness(
  executor: Executor,
  input: {
    readonly deviceIds: readonly string[];
    readonly now: Date;
    readonly warningHours?: number;
  },
): Promise<DeviceFreshnessReport> {
  const warningHours = input.warningHours ?? (await freshnessWarningHoursAt(executor, input.now));
  if (input.deviceIds.length === 0) return { warningHours, devices: [], staleCount: 0 };
  const ids = input.deviceIds.map((id) => toBin(id));
  const devices = await executor
    .selectFrom('identity_devices')
    .select([
      'id',
      'short_code',
      'label',
      'status',
      'is_shared',
      'designated_site_id',
      'last_seen_at',
    ])
    .where('id', 'in', ids)
    .orderBy('short_code')
    .execute();
  const states = await executor
    .selectFrom('sync_device_sync_state')
    .select(['device_id', 'dataset', 'last_push_at', 'last_pull_at', 'pending_reported'])
    .where('device_id', 'in', ids)
    .where((eb) =>
      eb.or([eb('dataset', '=', DEVICE_DATASET), eb('dataset', 'like', sql<string>`${'\\_a:%'}`)]),
    )
    .execute();
  const thresholdMs = warningHours * 3_600_000;
  const report: DeviceFreshness[] = devices.map((device) => {
    const own = states.filter((state) => state.device_id.equals(device.id));
    const deviceState = own.find((state) => state.dataset === DEVICE_DATASET);
    const lastPushAt = deviceState?.last_push_at ?? null;
    const lastPullAt = deviceState?.last_pull_at ?? null;
    const lastContactAt = latest(device.last_seen_at, lastPushAt, lastPullAt);
    const authors: AuthorFreshness[] = [];
    for (const state of own) {
      if (state.dataset === DEVICE_DATASET) continue;
      const userId = authorOfDataset(state.dataset);
      if (userId === null) continue;
      authors.push({
        userId,
        lastPushAt: state.last_push_at,
        lastPullAt: state.last_pull_at,
        pendingReported: state.pending_reported,
      });
    }
    authors.sort((a, b) => a.userId.localeCompare(b.userId));
    return {
      deviceId: fromBin(device.id),
      shortCode: device.short_code,
      label: device.label,
      status: device.status,
      isShared: Boolean(device.is_shared),
      designatedSiteId: fromBinOrNull(device.designated_site_id),
      lastSeenAt: device.last_seen_at,
      lastPushAt,
      lastPullAt,
      lastContactAt,
      stale: lastContactAt === null || input.now.getTime() - lastContactAt.getTime() > thresholdMs,
      pendingReported: deviceState?.pending_reported ?? null,
      authors,
    };
  });
  return {
    warningHours,
    devices: report,
    staleCount: report.filter((device) => device.stale && device.status === 'ACTIVE').length,
  };
}
