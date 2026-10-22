/**
 * Réglages des exports (P9-20 ; ADR-077 §3, ADR-078 ; NFR-13, AV-433) : lus de `organization.system_settings`
 * (historisés) à l'instant de la demande et du calcul, avec le défaut de la spécification quand une valeur manque ou
 * est mal formée. Aucune limite n'est codée ailleurs.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';

export interface ExportSettings {
  /** Lignes au plus (NFR-13 : 100 000) ; au-delà, l'export termine `FAILED`, jamais tronqué. */
  readonly maxRows: number;
  /** Durée de calcul au plus, en secondes (ADR-077 §3 : 120). */
  readonly maxSeconds: number;
  /** Durée de validité du fichier, en heures (dictionnaire : 24). */
  readonly fileHours: number;
  /** Exports en file ou en cours au plus par demandeur. */
  readonly maxPendingPerUser: number;
}

export const EXPORT_SETTING_KEYS = {
  maxRows: 'analytics.export_max_rows',
  maxSeconds: 'analytics.export_max_seconds',
  fileHours: 'analytics.export_file_hours',
  maxPendingPerUser: 'analytics.export_max_pending_per_user',
} as const;

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  maxRows: 100_000,
  maxSeconds: 120,
  fileHours: 24,
  maxPendingPerUser: 3,
};

const positiveInteger = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;

export async function readExportSettings(
  executor: Kysely<DB> | Transaction<DB>,
  at: Date,
): Promise<ExportSettings> {
  const read = async (key: string): Promise<unknown> =>
    currentSettingValue(executor, { key, scopeType: 'GLOBAL', scopeId: null, at });
  return {
    maxRows: positiveInteger(await read(EXPORT_SETTING_KEYS.maxRows), DEFAULT_EXPORT_SETTINGS.maxRows),
    maxSeconds: positiveInteger(
      await read(EXPORT_SETTING_KEYS.maxSeconds),
      DEFAULT_EXPORT_SETTINGS.maxSeconds,
    ),
    fileHours: positiveInteger(
      await read(EXPORT_SETTING_KEYS.fileHours),
      DEFAULT_EXPORT_SETTINGS.fileHours,
    ),
    maxPendingPerUser: positiveInteger(
      await read(EXPORT_SETTING_KEYS.maxPendingPerUser),
      DEFAULT_EXPORT_SETTINGS.maxPendingPerUser,
    ),
  };
}
