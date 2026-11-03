/**
 * Règles pures de l'écran ECR-SYN-02 « Supervision de la synchronisation » (RP-3 ; UC-SYN-08 ; BR-ANA-005).
 * Synthèse de la fraîcheur des appareils (`GET /devices`), files d'attente annoncées (`pendingReported`)
 * et conflits ouverts (`GET /sync/conflicts?status=OPEN`).
 */
import type { DeviceStatus } from '../devices/devices.js';

export const MONITOR_DEVICES_PATH = '/api/v1/devices?limit=200';
export const OPEN_CONFLICTS_PATH = '/api/v1/sync/conflicts?status=OPEN&limit=200';

export type SyncMonitorFilter = 'ALL' | 'STALE' | 'PENDING_QUEUE' | 'INACTIVE';

export const SYNC_MONITOR_FILTERS: readonly SyncMonitorFilter[] = [
  'ALL',
  'STALE',
  'PENDING_QUEUE',
  'INACTIVE',
];

export interface MonitoredDeviceView {
  readonly id: string;
  readonly shortCode: string;
  readonly label: string | null;
  readonly status: DeviceStatus;
  readonly platform: string | null;
  readonly appVersion: string | null;
  readonly isShared: boolean;
  readonly designatedSiteId: string | null;
  readonly enrolledByUserId: string;
  readonly enrolledByName: string | null;
  readonly createdAt: string;
  readonly lastPushAt: string | null;
  readonly lastPullAt: string | null;
  readonly lastContactAt: string | null;
  readonly stale: boolean;
  readonly pendingReported: number;
}

export interface SyncMonitorSummary {
  readonly activeCount: number;
  readonly staleCount: number;
  readonly pendingDevicesCount: number;
  readonly pendingOperationsCount: number;
  readonly openConflictsCount: number;
}

export function filterFromQuery(raw: string | null): SyncMonitorFilter {
  if (raw === 'STALE' || raw === 'PENDING_QUEUE' || raw === 'INACTIVE') return raw;
  return 'ALL';
}

export function summarizeMonitoredDevices(
  devices: readonly MonitoredDeviceView[],
  openConflictsCount: number,
): SyncMonitorSummary {
  const active = devices.filter((d) => d.status === 'ACTIVE');
  const staleCount = active.filter((d) => d.stale).length;
  const pendingDevicesCount = devices.filter((d) => (d.pendingReported ?? 0) > 0).length;
  const pendingOperationsCount = devices.reduce((sum, d) => sum + (d.pendingReported ?? 0), 0);
  return {
    activeCount: active.length,
    staleCount,
    pendingDevicesCount,
    pendingOperationsCount,
    openConflictsCount,
  };
}

export function filterMonitoredDevices(
  devices: readonly MonitoredDeviceView[],
  filter: SyncMonitorFilter,
  search: string,
): MonitoredDeviceView[] {
  const needle = search.trim().toLowerCase();
  return devices
    .filter((device) => {
      if (filter === 'STALE' && !device.stale) return false;
      if (filter === 'PENDING_QUEUE' && (device.pendingReported ?? 0) <= 0) return false;
      if (filter === 'INACTIVE' && device.status === 'ACTIVE') return false;
      if (!needle) return true;
      return [device.shortCode, device.enrolledByName, device.platform, device.label]
        .filter((v): v is string => typeof v === 'string')
        .some((v) => v.toLowerCase().includes(needle));
    })
    .sort((a, b) => {
      // Appareils en retard ou avec file en attente en tête, puis par code court.
      if (a.stale !== b.stale) return a.stale ? -1 : 1;
      const aPending = a.pendingReported ?? 0;
      const bPending = b.pendingReported ?? 0;
      if (aPending !== bPending) return bPending - aPending;
      return a.shortCode.localeCompare(b.shortCode, 'fr');
    });
}
