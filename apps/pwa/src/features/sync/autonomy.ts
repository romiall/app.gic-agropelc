/**
 * Autonomie hors connexion (AV-009, défaut ; 06-offline-sync/01-architecture-offline.md §8 ; AV-314).
 * Durée depuis la dernière synchronisation complète (`last_sync_at` : tous les jeux tirés), mesurée
 * à l'horloge de l'appareil : au-delà de `offline.warning_hours` (48 h par défaut), bandeau permanent
 * « connectez-vous dès que possible » ; au-delà de `offline.max_autonomy_hours` (168 h, 7 jours),
 * lecture seule : consultation possible, toute nouvelle opération refusée sur l'appareil jusqu'à une
 * synchronisation réussie ; l'outbox reste intacte et continue de partir. Un appareil jamais
 * synchronisé n'est pas bloqué (il n'a aucune donnée de référence ; l'activation exige le réseau).
 */
import type { GicDatabase } from '../../storage/db.js';
import { listProjected } from '../../storage/projections.js';
import { settingValue } from '../sales/stock.js';
import type { SettingData } from '../sales/types.js';

/** Défauts d'AV-009 quand le paramètre n'est pas servi ou mal saisi (seed : 48 et 168). */
export const DEFAULT_WARNING_HOURS = 48;
export const DEFAULT_MAX_AUTONOMY_HOURS = 168;

const HOUR_MS = 3_600_000;

/** Heures lues d'un paramètre : nombre (ou texte numérique) strictement positif, sinon le défaut. */
export function hoursFrom(value: unknown, fallback: number): number {
  const hours = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof hours === 'number' && Number.isFinite(hours) && hours > 0 ? hours : fallback;
}

export type AutonomyLevel = 'OK' | 'WARNING' | 'READ_ONLY';

export interface Autonomy {
  readonly level: AutonomyLevel;
  /** Heures entières écoulées depuis la dernière synchronisation complète ; `null` si jamais. */
  readonly hours: number | null;
  readonly maxHours: number;
}

export function autonomyOf(input: {
  readonly lastSyncAt: string | null;
  readonly now: Date;
  readonly settings: readonly SettingData[];
}): Autonomy {
  const warningHours = hoursFrom(
    settingValue(input.settings, 'offline.warning_hours', null, input.now),
    DEFAULT_WARNING_HOURS,
  );
  const maxHours = hoursFrom(
    settingValue(input.settings, 'offline.max_autonomy_hours', null, input.now),
    DEFAULT_MAX_AUTONOMY_HOURS,
  );
  if (input.lastSyncAt === null) return { level: 'OK', hours: null, maxHours };
  const elapsedMs = input.now.getTime() - new Date(input.lastSyncAt).getTime();
  const hours = Math.max(0, Math.floor(elapsedMs / HOUR_MS));
  const level: AutonomyLevel =
    elapsedMs > maxHours * HOUR_MS
      ? 'READ_ONLY'
      : elapsedMs > warningHours * HOUR_MS
        ? 'WARNING'
        : 'OK';
  return { level, hours, maxHours };
}

/** Lecture de l'état d'autonomie dans la base locale (dernière synchronisation, paramètres `me`). */
export async function loadAutonomy(db: GicDatabase, now: Date): Promise<Autonomy> {
  const [meta, settings] = await Promise.all([
    db.syncMeta.get('device'),
    listProjected<SettingData>(db, 'me', 'SETTING'),
  ]);
  return autonomyOf({ lastSyncAt: meta?.last_sync_at ?? null, now, settings });
}

/** Opération refusée sur l'appareil : autonomie dépassée, lecture seule (AV-009). */
export class OfflineReadOnlyError extends Error {
  readonly code = 'OFFLINE_READ_ONLY';

  constructor(readonly hours: number) {
    super(`Lecture seule : aucune synchronisation depuis ${hours} h (AV-009).`);
    this.name = 'OfflineReadOnlyError';
  }
}
