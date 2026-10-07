/**
 * Lectures des sessions de travail pour les modules qui y rattachent leurs activités (BR-CRM-013
 * « une visite est rattachée automatiquement à la session de travail ouverte de l'utilisateur à
 * `occurred_at` » ; ventes terrain en P4). API publique de `fieldwork`.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface WorkSessionRef {
  readonly id: string;
  readonly userId: string;
  readonly status: string;
  readonly overrideStatus: string;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  /** Zone déclarée à l'ouverture (BR-VEN-022 : repli de la zone d'une vente sans PDV ni client). */
  readonly declaredZoneId: string;
}

function toRef(row: {
  readonly id: Buffer;
  readonly user_id: Buffer;
  readonly status: string;
  readonly override_status: string;
  readonly started_at: Date;
  readonly ended_at: Date | null;
  readonly declared_zone_id: Buffer;
}): WorkSessionRef {
  return {
    id: fromBin(row.id),
    userId: fromBin(row.user_id),
    status: row.status,
    overrideStatus: row.override_status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    declaredZoneId: fromBin(row.declared_zone_id),
  };
}

const COLUMNS = [
  'id',
  'user_id',
  'status',
  'override_status',
  'started_at',
  'ended_at',
  'declared_zone_id',
] as const;

export async function findWorkSession(
  executor: Executor,
  sessionId: string,
): Promise<WorkSessionRef | undefined> {
  const row = await executor
    .selectFrom('fieldwork_work_sessions')
    .select([...COLUMNS])
    .where('id', '=', toBin(sessionId))
    .executeTakeFirst();
  return row ? toRef(row) : undefined;
}

/** Session de l'utilisateur couvrant `at` : commencée au plus tard à `at`, pas encore terminée à
 * `at` (ou toujours ouverte). La plus récente si plusieurs (ne devrait pas arriver). */
export async function findWorkSessionAt(
  executor: Executor,
  userId: string,
  at: Date,
): Promise<WorkSessionRef | undefined> {
  const row = await executor
    .selectFrom('fieldwork_work_sessions')
    .select([...COLUMNS])
    .where('user_id', '=', toBin(userId))
    .where('started_at', '<=', at)
    .where((eb) => eb.or([eb('ended_at', 'is', null), eb('ended_at', '>', at)]))
    .orderBy('started_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ? toRef(row) : undefined;
}

export interface WorkSessionSummary extends WorkSessionRef {
  readonly deviceId: string;
  readonly declaredZoneId: string;
  readonly closeCause: string | null;
  readonly overrideReason: string | null;
  readonly approvalRequestId: string | null;
  readonly startCheckinId: string;
  readonly endCheckinId: string | null;
}

/** Sessions des utilisateurs commencées dans `[fromUtc, toUtc[` (ex. un jour métier). */
export async function listWorkSessions(
  executor: Executor,
  filter: { readonly userIds: readonly string[]; readonly fromUtc: Date; readonly toUtc: Date },
): Promise<readonly WorkSessionSummary[]> {
  if (filter.userIds.length === 0) return [];
  const rows = await executor
    .selectFrom('fieldwork_work_sessions')
    .selectAll()
    .where(
      'user_id',
      'in',
      filter.userIds.map((id) => toBin(id)),
    )
    .where('started_at', '>=', filter.fromUtc)
    .where('started_at', '<', filter.toUtc)
    .orderBy('started_at', 'asc')
    .execute();
  return rows.map((row) => ({
    ...toRef(row),
    deviceId: fromBin(row.device_id),
    declaredZoneId: fromBin(row.declared_zone_id),
    closeCause: row.close_cause,
    overrideReason: row.override_reason,
    approvalRequestId: row.approval_request_id ? fromBin(row.approval_request_id) : null,
    startCheckinId: fromBin(row.start_checkin_id),
    endCheckinId: row.end_checkin_id ? fromBin(row.end_checkin_id) : null,
  }));
}

export interface CheckinSummary {
  readonly id: string;
  readonly userId: string;
  readonly checkinType: string;
  readonly declaredZoneId: string;
  readonly position: { readonly lat: number; readonly lng: number } | null;
  readonly accuracyM: number | null;
  readonly distanceM: number | null;
  readonly geofenceRadiusM: number | null;
  readonly clientResult: string;
  readonly serverResult: string;
  readonly resultDivergence: boolean;
  readonly workSessionId: string | null;
  readonly suspicionFlags: readonly string[];
  readonly occurredAt: Date;
  readonly clockSuspect: boolean;
}

/** Toutes les tentatives (acceptées ou refusées, INV-TER-02) des utilisateurs sur la période. */
export async function listCheckins(
  executor: Executor,
  filter: { readonly userIds: readonly string[]; readonly fromUtc: Date; readonly toUtc: Date },
): Promise<readonly CheckinSummary[]> {
  if (filter.userIds.length === 0) return [];
  const rows = await executor
    .selectFrom('fieldwork_geo_checkins')
    .selectAll()
    .where(
      'user_id',
      'in',
      filter.userIds.map((id) => toBin(id)),
    )
    .where('occurred_at', '>=', filter.fromUtc)
    .where('occurred_at', '<', filter.toUtc)
    .orderBy('occurred_at', 'asc')
    .execute();
  return rows.map((row) => ({
    id: fromBin(row.id),
    userId: fromBin(row.user_id),
    checkinType: row.checkin_type,
    declaredZoneId: fromBin(row.declared_zone_id),
    position:
      row.lat === null || row.lng === null ? null : { lat: Number(row.lat), lng: Number(row.lng) },
    accuracyM: row.accuracy_m === null ? null : Number(row.accuracy_m),
    distanceM: row.distance_m === null ? null : Number(row.distance_m),
    geofenceRadiusM: row.geofence_radius_m === null ? null : Number(row.geofence_radius_m),
    clientResult: row.client_result,
    serverResult: row.server_result,
    resultDivergence: Boolean(row.result_divergence),
    workSessionId: row.work_session_id ? fromBin(row.work_session_id) : null,
    suspicionFlags: Array.isArray(row.suspicion_flags)
      ? row.suspicion_flags.filter((v): v is string => typeof v === 'string')
      : [],
    occurredAt: row.occurred_at,
    clockSuspect: Boolean(row.clock_suspect),
  }));
}
