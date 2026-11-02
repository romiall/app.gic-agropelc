/**
 * Lecture des zones (S-19, RP-1 ; `GET /zones`). Aucune décision d'autorisation ici : la couche de
 * transport `organization-api/` évalue la portée (`org.structure.read`, RC-04) zone par zone.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface ZoneSummary {
  readonly id: string;
  readonly parentId: string | null;
  readonly code: string;
  readonly name: string;
  readonly level: string;
  readonly depth: number;
  /** Géorepère de pointage (BR-TER-001) : les trois valeurs ensemble, ou aucune (contrainte de base). */
  readonly geofence: {
    readonly lat: number;
    readonly lng: number;
    readonly radiusM: number;
  } | null;
  readonly maxGpsAccuracyM: number | null;
  readonly isActive: boolean;
  readonly version: number;
}

/** Zones, de la racine aux feuilles (profondeur puis code) ; les zones inactives restent consultables. */
export async function listZones(executor: Executor): Promise<readonly ZoneSummary[]> {
  const rows = await executor
    .selectFrom('organization_zones')
    .selectAll()
    .orderBy('depth', 'asc')
    .orderBy('code', 'asc')
    .execute();
  return rows.map((row) => ({
    id: fromBin(row.id),
    parentId: fromBinOrNull(row.parent_id),
    code: row.code,
    name: row.name,
    level: row.level,
    depth: row.depth,
    geofence:
      row.geofence_lat !== null && row.geofence_lng !== null && row.geofence_radius_m !== null
        ? {
            lat: Number(row.geofence_lat),
            lng: Number(row.geofence_lng),
            radiusM: Number(row.geofence_radius_m),
          }
        : null,
    maxGpsAccuracyM: row.max_gps_accuracy_m === null ? null : Number(row.max_gps_accuracy_m),
    isActive: Boolean(row.is_active),
    version: row.version,
  }));
}
