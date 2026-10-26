/**
 * Éléments communs des tâches d'alerte de synchronisation (P9-10 ; AV-421 à AV-424) : lecture des appareils
 * (libellé, titulaire, site, statut) et des réglages globaux. `identity_devices` est une référence
 * universelle en lecture (graphe des dépendances, note 1), comme dans `device-freshness.ts`.
 */
import type { Clock, IdGenerator } from '@gic/domain';
import { fromBin, fromBinOrNull, toBin } from '../../platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../../platform/unit-of-work.js';
import { currentSettingValue } from '../../modules/organization/application/public/index.js';

export interface SyncAlertDeps {
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
}

export interface AlertDevice {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  /** Utilisateur qui a enrôlé l'appareil : son titulaire par convention (MP-06, AV-247). */
  readonly enrolledByUserId: string;
  readonly designatedSiteId: string | null;
  /** Date du dernier changement d'état (passage à `ACTIVE` pour un appareil actif). */
  readonly statusChangedAt: Date;
  readonly isShared: boolean;
}

/** Libellé affiché d'un appareil : son nom, à défaut son code court. */
export function deviceLabel(label: string | null, shortCode: string): string {
  return label !== null && label.trim() !== '' ? label : `Appareil ${shortCode}`;
}

const DEVICE_COLUMNS = [
  'id',
  'label',
  'short_code',
  'status',
  'enrolled_by_user_id',
  'designated_site_id',
  'status_changed_at',
  'is_shared',
] as const;

function toAlertDevices(
  rows: readonly {
    readonly id: Buffer;
    readonly label: string | null;
    readonly short_code: string;
    readonly status: string;
    readonly enrolled_by_user_id: Buffer;
    readonly designated_site_id: Buffer | null;
    readonly status_changed_at: Date;
    readonly is_shared: number;
  }[],
): ReadonlyMap<string, AlertDevice> {
  return new Map(
    rows.map((row) => [
      fromBin(row.id),
      {
        id: fromBin(row.id),
        label: deviceLabel(row.label, row.short_code),
        status: row.status,
        enrolledByUserId: fromBin(row.enrolled_by_user_id),
        designatedSiteId: fromBinOrNull(row.designated_site_id),
        statusChangedAt: row.status_changed_at,
        isShared: Boolean(row.is_shared),
      },
    ]),
  );
}

/** Appareils donnés, indexés par identifiant ; un tableau vide ne lit rien. */
export async function loadAlertDevices(
  uow: UnitOfWork,
  deviceIds: readonly string[],
): Promise<ReadonlyMap<string, AlertDevice>> {
  if (deviceIds.length === 0) return new Map();
  const rows = await uow
    .selectFrom('identity_devices')
    .select(DEVICE_COLUMNS)
    .where(
      'id',
      'in',
      deviceIds.map((id) => toBin(id)),
    )
    .execute();
  return toAlertDevices(rows);
}

/** Tous les appareils en service (`ACTIVE`), indexés par identifiant. */
export async function loadActiveAlertDevices(
  uow: UnitOfWork,
): Promise<ReadonlyMap<string, AlertDevice>> {
  const rows = await uow
    .selectFrom('identity_devices')
    .select(DEVICE_COLUMNS)
    .where('status', '=', 'ACTIVE')
    .execute();
  return toAlertDevices(rows);
}

/** Réglage global à l'instant `at` (valeur brute : chaque règle du domaine la valide). */
export async function globalSetting(uow: UnitOfWork, key: string, at: Date): Promise<unknown> {
  return currentSettingValue(uow, { key, scopeType: 'GLOBAL', scopeId: null, at });
}
