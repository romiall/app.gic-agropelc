/**
 * ECR-TER-01 « PRENDRE SERVICE / FIN DE SERVICE » (UC-TER-01 à 03, BR-TER-001 à 008) : logique pure.
 *
 * - Toute tentative est enregistrée, acceptée ou refusée (BR-TER-001) : l'appareil évalue la position
 *   contre le géorepère de la zone déclarée (`evaluateCheckin`, même calcul que le serveur, qui
 *   recalcule) et envoie son résultat.
 * - Une prise acceptée sur l'appareil ouvre aussitôt la session de travail, sous un identifiant choisi
 *   par l'appareil et repris par le serveur ; une fin de service la clôt, même hors zone (signalé,
 *   jamais bloquant, BR-TER-007). Sans fin de service, la session se clôt à 23:59 (BR-TER-008).
 * - Après des refus répétés (3 sur au moins 2 minutes par défaut), une dérogation motivée ouvre une
 *   session « en attente de validation » (BR-TER-005).
 * - Zones proposées : actives et dotées d'un géorepère ; les affectations de zone de l'utilisateur ne
 *   sont pas servies à l'appareil (S-19) : le serveur tranche (`ZONE_NOT_ALLOWED`).
 */
import {
  buildGeofence,
  businessDayOf,
  canRequestOverride,
  evaluateCheckin,
  haversineDistanceM,
  sessionAutoCloseAt,
  type CheckinResult,
  type Geofence,
  type GeoPoint,
} from '@gic/domain';
import type { OutboxCommand } from '../../storage/db.js';
import { stillInFlight } from '../sales/pending.js';
import type { WorkSessionData, ZoneData } from '../sales/types.js';
import type { Position } from '../crm/prospect.js';

/** Paramètres semés, tant qu'ils ne sont pas servis à l'appareil (S-15). */
export const DEFAULT_MAX_GPS_ACCURACY_M = 150;
export const DEFAULT_OVERRIDE_MIN_ATTEMPTS = 3;
export const DEFAULT_OVERRIDE_MIN_MINUTES = 2;
export const MAX_OVERRIDE_REASON_LENGTH = 2000;

export type CheckinType = 'START_SERVICE' | 'END_SERVICE';

export interface CheckinPayload {
  readonly checkinType?: CheckinType;
  readonly declaredZoneId?: string;
  readonly clientResult?: CheckinResult;
  readonly sessionId?: string;
}

const decimal = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Géorepère d'une zone, ou `null` (zone sans géorepère, ou géorepère illisible). */
export function zoneGeofence(zone: ZoneData): Geofence | null {
  try {
    return buildGeofence({
      lat: decimal(zone.geofence_lat),
      lng: decimal(zone.geofence_lng),
      radiusM: decimal(zone.geofence_radius_m),
    });
  } catch {
    return null;
  }
}

export interface ServiceZone {
  readonly zone: ZoneData;
  readonly geofence: Geofence;
  readonly maxAccuracyM: number;
}

/** Zones où l'on peut prendre service : actives, avec un géorepère, par nom. */
export function serviceZones(
  zones: ReadonlyMap<string, ZoneData>,
  fallbackMaxAccuracyM: number,
): ServiceZone[] {
  const result: ServiceZone[] = [];
  for (const zone of zones.values()) {
    if (zone.is_active === false || zone.is_active === 0) continue;
    const geofence = zoneGeofence(zone);
    if (!geofence) continue;
    result.push({
      zone,
      geofence,
      maxAccuracyM: decimal(zone.max_gps_accuracy_m) ?? fallbackMaxAccuracyM,
    });
  }
  return result.sort((a, b) => a.zone.name.localeCompare(b.zone.name, 'fr'));
}

/** Zone dont le géorepère contient la position, la plus proche de son centre ; sinon aucune. */
export function zoneAt(position: GeoPoint, zones: readonly ServiceZone[]): ServiceZone | undefined {
  let best: { readonly zone: ServiceZone; readonly distance: number } | undefined;
  for (const candidate of zones) {
    const distance = haversineDistanceM(position, candidate.geofence);
    if (distance > candidate.geofence.radiusM) continue;
    if (!best || distance < best.distance) best = { zone: candidate, distance };
  }
  return best?.zone;
}

export interface CheckinEvaluationView {
  readonly result: CheckinResult;
  readonly distanceM: number | null;
}

/** Évaluation locale d'une tentative (BR-TER-002, BR-TER-003). */
export function evaluateAt(position: Position | null, zone: ServiceZone): CheckinEvaluationView {
  try {
    return evaluateCheckin({
      position: position ? { lat: position.lat, lng: position.lng } : null,
      accuracyM: position?.accuracyM ?? null,
      geofence: zone.geofence,
      maxAccuracyM: zone.maxAccuracyM,
    });
  } catch {
    return { result: 'NO_POSITION', distanceM: null };
  }
}

/** Charge utile de `fieldwork.checkin.record` : toutes les clés requises, `null` sans position. */
export function checkinPayload(input: {
  readonly checkinType: CheckinType;
  readonly zoneId: string;
  readonly position: Position | null;
  readonly clientResult: CheckinResult;
  readonly sessionId?: string;
}) {
  return {
    checkinType: input.checkinType,
    declaredZoneId: input.zoneId,
    position: input.position ? { lat: input.position.lat, lng: input.position.lng } : null,
    accuracyM: input.position?.accuracyM ?? null,
    clientResult: input.clientResult,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };
}

export interface CheckinAttempt {
  readonly commandId: string;
  readonly type: CheckinType;
  readonly zoneId: string;
  readonly clientResult: CheckinResult;
  readonly occurredAt: string;
  readonly status: OutboxCommand['status'];
}

/** Tentatives du jour métier de l'utilisateur saisies sur l'appareil, la plus récente d'abord. */
export function todayAttempts(
  outbox: readonly OutboxCommand[],
  userId: string,
  today: string,
): CheckinAttempt[] {
  return outbox
    .filter(
      (command) =>
        command.command_type === 'fieldwork.checkin.record' &&
        command.author_user_id === userId &&
        businessDayOf(new Date(command.occurred_at)) === today,
    )
    .map((command) => {
      const payload = command.payload as CheckinPayload;
      return {
        commandId: command.command_id,
        type: payload.checkinType ?? 'START_SERVICE',
        zoneId: payload.declaredZoneId ?? '',
        clientResult: payload.clientResult ?? 'NO_POSITION',
        occurredAt: command.occurred_at,
        status: command.status,
      };
    })
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

/**
 * BR-TER-005 : dérogation possible après `minAttempts` prises refusées, étalées sur `minMinutes`,
 * depuis la dernière prise acceptée du jour (même règle que le serveur, `canRequestOverride`).
 */
export function overrideAllowed(
  attempts: readonly CheckinAttempt[],
  minAttempts: number,
  minMinutes: number,
): boolean {
  const starts = attempts.filter((attempt) => attempt.type === 'START_SERVICE');
  const lastAccepted = starts.find((attempt) => attempt.clientResult === 'ACCEPTED');
  const rejected = starts
    .filter(
      (attempt) =>
        attempt.clientResult !== 'ACCEPTED' &&
        (!lastAccepted || attempt.occurredAt > lastAccepted.occurredAt),
    )
    .map((attempt) => new Date(attempt.occurredAt));
  return canRequestOverride(rejected, minAttempts, minMinutes);
}

/**
 * Sessions de travail vues par l'appareil : celles du jeu `fieldwork`, complétées par les prises,
 * fins de service et dérogations saisies sur l'appareil et pas encore retéléchargées (ADR-037 §3).
 * Une session sans fin se termine à 23:59 du jour où elle a commencé (BR-TER-008) ; une nouvelle prise
 * clôt la précédente (INV-TER-01).
 */
export function deviceWorkSessions(
  downloaded: readonly WorkSessionData[],
  ownOutbox: readonly OutboxCommand[],
  pulledAt: string | undefined,
): WorkSessionData[] {
  const sessions = new Map<string, WorkSessionData>(downloaded.map((s) => [s.id, s]));
  // Une nouvelle prise clôt la session ouverte à son heure, ou à 23:59 si cette heure est passée
  // avant (`resolveSessionEnd` du serveur).
  const closeOpen = (userId: string, at: string) => {
    for (const session of sessions.values()) {
      if (session.user_id !== userId || session.ended_at !== null) continue;
      if (session.started_at > at) continue;
      const autoAt = sessionAutoCloseAt(new Date(session.started_at)).toISOString();
      sessions.set(session.id, {
        ...session,
        ended_at: autoAt < at ? autoAt : at,
        status: 'CLOSED',
      });
    }
  };
  const inFlight = ownOutbox
    .filter(
      (command) =>
        (command.command_type === 'fieldwork.checkin.record' ||
          command.command_type === 'fieldwork.checkin.request_override') &&
        stillInFlight(command, pulledAt),
    )
    .sort((a, b) => a.device_seq - b.device_seq);
  for (const command of inFlight) {
    const payload = command.payload as CheckinPayload;
    const opened =
      command.command_type === 'fieldwork.checkin.request_override'
        ? { id: command.aggregate_id, override: 'PENDING' }
        : payload.checkinType === 'START_SERVICE' &&
            payload.clientResult === 'ACCEPTED' &&
            payload.sessionId
          ? { id: payload.sessionId, override: 'NOT_REQUIRED' }
          : null;
    if (opened) {
      if (sessions.has(opened.id)) continue;
      closeOpen(command.author_user_id, command.occurred_at);
      sessions.set(opened.id, {
        id: opened.id,
        user_id: command.author_user_id,
        declared_zone_id: payload.declaredZoneId ?? '',
        started_at: command.occurred_at,
        ended_at: null,
        status: 'OPEN',
        override_status: opened.override,
        pending_command_id: command.command_id,
      });
    } else if (payload.checkinType === 'END_SERVICE') {
      const target = payload.sessionId ? sessions.get(payload.sessionId) : undefined;
      if (target) {
        if (target.ended_at === null && target.started_at <= command.occurred_at) {
          sessions.set(target.id, { ...target, ended_at: command.occurred_at, status: 'CLOSED' });
        }
      } else {
        closeOpen(command.author_user_id, command.occurred_at);
      }
    }
  }
  return [...sessions.values()].map((session) =>
    session.ended_at === null
      ? {
          ...session,
          ended_at: sessionAutoCloseAt(new Date(session.started_at)).toISOString(),
          auto_close: true,
        }
      : session,
  );
}
