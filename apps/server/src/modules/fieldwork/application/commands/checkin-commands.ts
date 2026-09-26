/**
 * `fieldwork.checkin.record`, `fieldwork.checkin.request_override` et la décision
 * `CHECKIN_OVERRIDE` (D03-TER ; SM-WORK-SESSION ; dictionnaire 04-crm-fieldwork).
 *
 * - Toute tentative est enregistrée, acceptée ou refusée (BR-TER-001, INV-TER-02), avec le
 *   géorepère figé et le résultat **recalculé par le serveur**, qui fait foi (BR-TER-003 ;
 *   `evaluateCheckin`, packages/domain — même calcul que l'appareil).
 * - L'appareil ouvre sa session localement dès un résultat local `ACCEPTED` et y rattache ses
 *   visites hors ligne : le serveur crée la session **sous le même identifiant** (`sessionId`).
 *   Si le serveur refuse une prise acceptée localement (géorepère modifié entre-temps), la
 *   session est quand même ouverte, dérogation `PENDING` demandée automatiquement (D03 §12).
 * - Une nouvelle prise acceptée clôt la session ouverte précédente à son heure (`SUPERSEDED`,
 *   BR-TER-009) ; une prise tardive antérieure à la session ouverte est enregistrée déjà close,
 *   à l'heure d'ouverture de celle-ci (INV-TER-01 préservé dans les deux cas). Une session dont
 *   le jour métier est révolu à l'application est close à 23:59 (`AUTO_CLOSED`, BR-TER-008), comme
 *   l'appareil l'a fait hors ligne — `resolveSessionEnd`, packages/domain.
 * - Fin de service : clôt la session ; si une fin antérieure arrive après une clôture (23:59 ou
 *   remplacement), « l'heure réelle la plus ancienne l'emporte » (SM-WORK-SESSION).
 *
 * Signaux de pointage suspect (BR-TER-010) : calculés sur les **pointages** de l'utilisateur
 * seulement — les positions des visites et ventes terrain appartiennent à `crm` et `sales`, que
 * `fieldwork` ne peut pas lire (graphe) ; limite documentée, à compléter par écoute d'événements
 * si le besoin se confirme.
 */
import { z } from 'zod';
import { sql, type Transaction } from 'kysely';
import {
  DomainError,
  businessDayOf,
  businessDayStartUtc,
  businessDayEndUtc,
  buildGeofence,
  canRequestOverride,
  detectCheckinSuspicion,
  evaluateCheckin,
  haversineDistanceM,
  resolveSessionEnd,
  type CheckinResult,
  type Clock,
  type Geofence,
  type GeoPoint,
  type IdGenerator,
} from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { loadCommandOrigin, type CommandOrigin } from '../../../../platform/sync/command-origin.js';
import { fromBin, toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import { jsonValue } from '../../../../platform/kysely/json-value.js';
import { activeZoneAssignmentsAt } from '../../../identity/application/public/index.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';
import {
  currentPolicies,
  requestApproval,
  type ApprovalDecisionHandlerRegistry,
} from '../../../approvals/application/public/index.js';
import type { SessionRejectedListenerRegistry } from '../session-rejection.js';
import { emitWorkSessionChanges } from '../sync-changes.js';

type Uow = Transaction<DB>;

const CHECKIN_RESULTS = [
  'ACCEPTED',
  'REJECTED_OUT_OF_ZONE',
  'REJECTED_LOW_ACCURACY',
  'NO_POSITION',
] as const;
type ServerResult = CheckinResult | 'ZONE_INACTIVE';

const positionSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const recordPayloadSchema = z.object({
  checkinType: z.enum(['START_SERVICE', 'END_SERVICE']),
  declaredZoneId: z.string().uuid(),
  position: positionSchema.nullable(),
  accuracyM: z.number().nonnegative().nullable(),
  /** Résultat calculé sur l'appareil (conservé ; le serveur recalcule, BR-TER-003). */
  clientResult: z.enum(CHECKIN_RESULTS),
  /** START_SERVICE accepté localement : session ouverte par l'appareil (même identifiant côté
   * serveur). END_SERVICE : session à clôturer — à défaut, la session ouverte de l'utilisateur. */
  sessionId: z.string().uuid().optional(),
});
type RecordPayload = z.infer<typeof recordPayloadSchema>;

const overridePayloadSchema = z.object({
  declaredZoneId: z.string().uuid(),
  reason: z.string().trim().min(1).max(2000),
});
type OverridePayload = z.infer<typeof overridePayloadSchema>;

function rejected(errorCode: string, messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode, messageFr };
}

/** Paramètre système numérique (règle 8) ; repli = valeur par défaut documentée du seed. */
async function numberSetting(uow: Uow, key: string, at: Date, fallback: number): Promise<number> {
  const value = await currentSettingValue(uow, { key, scopeType: 'GLOBAL', scopeId: null, at });
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

interface ZoneRef {
  readonly id: string;
  readonly isActive: boolean;
  readonly geofence: Geofence | null;
  readonly maxAccuracyM: number | null;
}

/** Lecture directe d'`organization.zones` (dépendance autorisée, même précédent que
 * `inventory/commands/shared.ts` : `organization` n'expose pas d'API pour ses zones). */
async function loadZone(uow: Uow, zoneId: string): Promise<ZoneRef | undefined> {
  const row = await uow
    .selectFrom('organization_zones')
    .select([
      'id',
      'is_active',
      'geofence_lat',
      'geofence_lng',
      'geofence_radius_m',
      'max_gps_accuracy_m',
    ])
    .where('id', '=', toBin(zoneId))
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    id: fromBin(row.id),
    isActive: Boolean(row.is_active),
    geofence: buildGeofence({
      lat: row.geofence_lat === null ? null : Number(row.geofence_lat),
      lng: row.geofence_lng === null ? null : Number(row.geofence_lng),
      radiusM: row.geofence_radius_m === null ? null : Number(row.geofence_radius_m),
    }),
    maxAccuracyM: row.max_gps_accuracy_m === null ? null : Number(row.max_gps_accuracy_m),
  };
}

/**
 * BR-TER-006 : la zone déclarée est l'une des zones des affectations de portée `ZONE` de
 * l'utilisateur — ou une de leurs sous-zones (DÉDUIT : les géorepères portent souvent sur des
 * secteurs, sous-zones de la zone d'affectation, AV-003). Sans affectation de zone : toute zone
 * active dotée d'un géorepère.
 */
async function isZoneAllowed(uow: Uow, userId: string, zoneId: string, at: Date): Promise<boolean> {
  const assigned = await activeZoneAssignmentsAt(uow, userId, at);
  if (assigned.length === 0) return true;
  const row = await uow
    .selectFrom('organization_zone_ancestors')
    .select('zone_id')
    .where('zone_id', '=', toBin(zoneId))
    .where(
      'ancestor_id',
      'in',
      assigned.map((id) => toBin(id)),
    )
    .executeTakeFirst();
  return row !== undefined;
}

function geoPointOf(lat: unknown, lng: unknown): GeoPoint | null {
  if (lat === null || lng === null || lat === undefined || lng === undefined) return null;
  return { lat: Number(lat), lng: Number(lng) };
}

/** BR-TER-010, sur l'historique de pointages de l'utilisateur (voir l'en-tête). Positions d'autres
 * jours bornées aux 90 derniers jours (DÉDUIT : borne de volumétrie, sans effet métier). */
async function suspicionFlags(
  uow: Uow,
  userId: string,
  occurredAt: Date,
  position: GeoPoint | null,
  accuracyM: number | null,
): Promise<readonly string[]> {
  if (position === null) return [];
  const maxSpeedKmh = await numberSetting(
    uow,
    'fieldwork.suspicion_max_speed_kmh',
    occurredAt,
    150,
  );
  const repeatedAccuracyCount = await numberSetting(
    uow,
    'fieldwork.suspicion_repeated_accuracy_count',
    occurredAt,
    5,
  );
  const user = toBin(userId);
  const previous = await uow
    .selectFrom('fieldwork_geo_checkins')
    .select(['lat', 'lng', 'occurred_at'])
    .where('user_id', '=', user)
    .where('lat', 'is not', null)
    .where('occurred_at', '<', occurredAt)
    .orderBy('occurred_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  const day = businessDayOf(occurredAt);
  const otherDays = await uow
    .selectFrom('fieldwork_geo_checkins')
    .select(['lat', 'lng'])
    .where('user_id', '=', user)
    .where('lat', 'is not', null)
    .where('occurred_at', '>=', new Date(occurredAt.getTime() - 90 * 86_400_000))
    .where((eb) =>
      eb.or([
        eb('occurred_at', '<', businessDayStartUtc(day)),
        eb('occurred_at', '>=', businessDayEndUtc(day)),
      ]),
    )
    .limit(500)
    .execute();
  const accuracies = await uow
    .selectFrom('fieldwork_geo_checkins')
    .select('accuracy_m')
    .where('user_id', '=', user)
    .where('occurred_at', '<', occurredAt)
    .orderBy('occurred_at', 'desc')
    .limit(repeatedAccuracyCount)
    .execute();
  const previousPosition = previous ? geoPointOf(previous.lat, previous.lng) : null;
  return detectCheckinSuspicion({
    position,
    accuracyM,
    occurredAt,
    previous:
      previous && previousPosition
        ? { position: previousPosition, occurredAt: previous.occurred_at }
        : null,
    otherDayPositions: otherDays
      .map((row) => geoPointOf(row.lat, row.lng))
      .filter((p): p is GeoPoint => p !== null),
    previousAccuracies: accuracies.map((row) =>
      row.accuracy_m === null ? null : Number(row.accuracy_m),
    ),
    maxSpeedKmh,
    repeatedAccuracyCount,
  });
}

interface OpenSessionRow {
  readonly id: Buffer;
  readonly started_at: Date;
}

async function lockOpenSession(uow: Uow, userId: string): Promise<OpenSessionRow | undefined> {
  return uow
    .selectFrom('fieldwork_work_sessions')
    .select(['id', 'started_at'])
    .where('user_id', '=', toBin(userId))
    .where('status', '=', 'OPEN')
    .forUpdate()
    .executeTakeFirst();
}

interface NewSession {
  readonly id: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly zoneId: string;
  readonly startedAt: Date;
  readonly startCheckinId: string;
  readonly overrideStatus: 'NOT_REQUIRED' | 'PENDING';
  readonly overrideReason: string | null;
  readonly approvalRequestId: string | null;
  readonly commandId: string;
  readonly origin: CommandOrigin;
  readonly envelope: {
    readonly client_created_at: string;
    readonly captured_offline: boolean;
    readonly backdated_reason: string | null;
  };
}

/**
 * Ouvre une session en respectant INV-TER-01 et BR-TER-009 : la session ouverte existante est
 * close à l'heure de la nouvelle (ou à 23:59 de son jour s'il est révolu et antérieur) ; si elle a
 * commencé **après** (prise tardive synchronisée plus tard), la nouvelle est enregistrée déjà
 * close à l'heure de celle-ci. `now` : horloge serveur à l'application (même référence que la
 * tâche `fieldwork.session.auto_close`).
 */
async function openSession(uow: Uow, session: NewSession, now: Date): Promise<void> {
  const current = await lockOpenSession(uow, session.userId);
  let supersededAt: Date | null = null;
  if (current && fromBin(current.id) !== session.id) {
    if (current.started_at.getTime() <= session.startedAt.getTime()) {
      const end = resolveSessionEnd({
        startedAt: current.started_at,
        supersededAt: session.startedAt,
        now,
      })!;
      await uow
        .updateTable('fieldwork_work_sessions')
        .set({
          status: end.cause === 'AUTO_2359' ? 'AUTO_CLOSED' : 'CLOSED',
          ended_at: end.endedAt,
          close_cause: end.cause,
          updated_by: toBin(session.userId),
          version: sql`version + 1`,
        })
        .where('id', '=', current.id)
        .execute();
      await emitWorkSessionChanges(uow, [current.id]);
    } else {
      supersededAt = current.started_at;
    }
  }
  const end = resolveSessionEnd({ startedAt: session.startedAt, supersededAt, now });
  await uow
    .insertInto('fieldwork_work_sessions')
    .values({
      id: toBin(session.id),
      user_id: toBin(session.userId),
      device_id: toBin(session.deviceId),
      declared_zone_id: toBin(session.zoneId),
      started_at: session.startedAt,
      start_checkin_id: toBin(session.startCheckinId),
      status: end === null ? 'OPEN' : end.cause === 'AUTO_2359' ? 'AUTO_CLOSED' : 'CLOSED',
      ended_at: end?.endedAt ?? null,
      close_cause: end?.cause ?? null,
      override_status: session.overrideStatus,
      override_reason: session.overrideReason,
      approval_request_id: toBinOrNull(session.approvalRequestId),
      occurred_at: session.startedAt,
      client_created_at: new Date(session.envelope.client_created_at),
      received_at_server: session.origin.receivedAt,
      command_id: toBin(session.commandId),
      created_device_id: toBinOrNull(session.origin.deviceId),
      captured_offline: session.envelope.captured_offline ? 1 : 0,
      clock_suspect: session.origin.clockSuspect ? 1 : 0,
      backdated_reason: session.envelope.backdated_reason,
      created_by: toBin(session.userId),
    })
    .execute();
  await emitWorkSessionChanges(uow, [session.id]);
}

/** Demande de dérogation `CHECKIN_OVERRIDE` ; `undefined` si aucune politique n'est active. */
async function requestOverride(
  uow: Uow,
  idGenerator: IdGenerator,
  input: {
    readonly sessionId: string;
    readonly userId: string;
    readonly zoneId: string;
    readonly occurredAt: Date;
    readonly summary: string;
  },
): Promise<string | undefined> {
  const policy = (await currentPolicies(uow, 'CHECKIN_OVERRIDE', input.occurredAt))[0];
  if (!policy) return undefined;
  const requestId = idGenerator.newId();
  await requestApproval(uow, {
    requestId,
    operationType: 'CHECKIN_OVERRIDE',
    subjectType: 'WORK_SESSION',
    subjectId: input.sessionId,
    subjectSummary: input.summary,
    zoneId: input.zoneId,
    requestedBy: input.userId,
    requestedAt: input.occurredAt,
    policyId: policy.id,
    policyVersion: policy.version,
  });
  return requestId;
}

/** Fin de service : session visée (ou ouverte) de l'utilisateur ; renvoie son identifiant. */
async function closeOnEndService(
  uow: Uow,
  input: {
    readonly userId: string;
    readonly sessionId: string | undefined;
    readonly occurredAt: Date;
    readonly checkinId: string;
  },
): Promise<string | null> {
  const target =
    input.sessionId !== undefined
      ? await uow
          .selectFrom('fieldwork_work_sessions')
          .select(['id', 'user_id', 'status', 'started_at', 'ended_at'])
          .where('id', '=', toBin(input.sessionId))
          .forUpdate()
          .executeTakeFirst()
      : await uow
          .selectFrom('fieldwork_work_sessions')
          .select(['id', 'user_id', 'status', 'started_at', 'ended_at'])
          .where('user_id', '=', toBin(input.userId))
          .where('status', '=', 'OPEN')
          .forUpdate()
          .executeTakeFirst();
  if (!target || fromBin(target.user_id) !== input.userId) return null;
  const at = input.occurredAt.getTime();
  if (at < target.started_at.getTime()) return fromBin(target.id); // horloge incohérente : rattachée, sans effet
  const closesEarlier = target.ended_at === null || at < target.ended_at.getTime();
  if (target.status === 'OPEN' || closesEarlier) {
    await uow
      .updateTable('fieldwork_work_sessions')
      .set({
        status: 'CLOSED',
        ended_at: input.occurredAt,
        end_checkin_id: toBin(input.checkinId),
        close_cause: 'END_SERVICE',
        updated_by: toBin(input.userId),
        version: sql`version + 1`,
      })
      .where('id', '=', target.id)
      .execute();
    await emitWorkSessionChanges(uow, [target.id]);
  }
  return fromBin(target.id);
}

function buildHandlers(
  idGenerator: IdGenerator,
  clock: Clock,
): {
  record: CommandHandler<RecordPayload>;
  requestOverride: CommandHandler<OverridePayload>;
} {
  const record: CommandHandler<RecordPayload> = async (uow, envelope) => {
    const checkinId = envelope.aggregate_id;
    const already = await uow
      .selectFrom('fieldwork_geo_checkins')
      .select('id')
      .where('id', '=', toBin(checkinId))
      .executeTakeFirst();
    if (already) return { status: 'APPLIED' }; // rejeu sous un autre command_id

    const payload = envelope.payload;
    const userId = envelope.author_user_id;
    const occurredAt = new Date(envelope.occurred_at);
    const origin = await loadCommandOrigin(uow, envelope.command_id);

    const zone = await loadZone(uow, payload.declaredZoneId);
    if (!zone || zone.geofence === null) {
      return rejected('ZONE_NOT_ALLOWED', 'Zone inconnue ou sans géorepère (BR-TER-006).');
    }
    if (!(await isZoneAllowed(uow, userId, zone.id, occurredAt))) {
      return rejected(
        'ZONE_NOT_ALLOWED',
        "Zone hors des affectations de l'utilisateur (BR-TER-006).",
      );
    }

    const maxAccuracyM =
      zone.maxAccuracyM ??
      (await numberSetting(uow, 'fieldwork.max_gps_accuracy_m', occurredAt, 150));
    let serverResult: ServerResult;
    let distanceM: number | null;
    try {
      if (!zone.isActive) {
        // D03 §14 : zone désactivée pendant la période hors ligne — tentative conservée,
        // résultat ZONE_INACTIVE, qui ne peut ouvrir une session que par dérogation.
        serverResult = 'ZONE_INACTIVE';
        distanceM = payload.position ? haversineDistanceM(payload.position, zone.geofence) : null;
      } else {
        const evaluation = evaluateCheckin({
          position: payload.position,
          accuracyM: payload.accuracyM,
          geofence: zone.geofence,
          maxAccuracyM,
        });
        serverResult = evaluation.result;
        distanceM = evaluation.distanceM;
      }
    } catch (error) {
      if (error instanceof DomainError) return rejected(error.code, error.message);
      throw error;
    }

    // Le pipeline enregistre toujours l'appareil authentifié (RC-02) ; garde défensive, une
    // session exige son appareil (dictionnaire : `device_id` non nul).
    const deviceId = origin.deviceId;
    if (deviceId === null) return rejected('DEVICE_REQUIRED', 'Pointage sans appareil identifié.');
    const flags = await suspicionFlags(
      uow,
      userId,
      occurredAt,
      payload.position,
      payload.accuracyM,
    );
    let sessionId: string | null = null;

    if (payload.checkinType === 'START_SERVICE') {
      const common = {
        userId,
        deviceId,
        zoneId: zone.id,
        startedAt: occurredAt,
        startCheckinId: checkinId,
        commandId: envelope.command_id,
        origin,
        envelope,
      };
      if (serverResult === 'ACCEPTED') {
        sessionId = payload.sessionId ?? idGenerator.newId();
        if (await sessionExists(uow, sessionId))
          return rejected('SESSION_EXISTS', 'Session déjà enregistrée.');
        await openSession(
          uow,
          {
            ...common,
            id: sessionId,
            overrideStatus: 'NOT_REQUIRED',
            overrideReason: null,
            approvalRequestId: null,
          },
          clock.now(),
        );
      } else if (payload.clientResult === 'ACCEPTED' && payload.sessionId !== undefined) {
        // BR-TER-003, D03 §12 : l'appareil a ouvert la session (visites déjà rattachées) — elle
        // est conservée, dérogation demandée automatiquement.
        sessionId = payload.sessionId;
        if (await sessionExists(uow, sessionId))
          return rejected('SESSION_EXISTS', 'Session déjà enregistrée.');
        const approvalRequestId = await requestOverride(uow, idGenerator, {
          sessionId,
          userId,
          zoneId: zone.id,
          occurredAt,
          summary: `Prise de service acceptée sur l'appareil, refusée par le serveur (${serverResult})`,
        });
        await openSession(
          uow,
          {
            ...common,
            id: sessionId,
            overrideStatus: 'PENDING',
            overrideReason: `Recalcul serveur défavorable : ${serverResult}.`,
            approvalRequestId: approvalRequestId ?? null,
          },
          clock.now(),
        );
      }
    } else {
      sessionId = await closeOnEndService(uow, {
        userId,
        sessionId: payload.sessionId,
        occurredAt,
        checkinId,
      });
    }

    await uow
      .insertInto('fieldwork_geo_checkins')
      .values({
        id: toBin(checkinId),
        user_id: toBin(userId),
        checkin_type: payload.checkinType,
        declared_zone_id: toBin(zone.id),
        lat: payload.position === null ? null : String(payload.position.lat),
        lng: payload.position === null ? null : String(payload.position.lng),
        accuracy_m: payload.accuracyM === null ? null : String(payload.accuracyM),
        geofence_lat: String(zone.geofence.lat),
        geofence_lng: String(zone.geofence.lng),
        geofence_radius_m: String(zone.geofence.radiusM),
        max_accuracy_m: String(maxAccuracyM),
        distance_m: distanceM === null ? null : String(distanceM),
        client_result: payload.clientResult,
        server_result: serverResult,
        result_divergence: payload.clientResult !== serverResult ? 1 : 0,
        work_session_id: toBinOrNull(sessionId),
        suspicion_flags: jsonValue(flags),
        occurred_at: occurredAt,
        client_created_at: new Date(envelope.client_created_at),
        received_at_server: origin.receivedAt,
        command_id: toBin(envelope.command_id),
        created_device_id: toBinOrNull(origin.deviceId),
        captured_offline: envelope.captured_offline ? 1 : 0,
        clock_suspect: origin.clockSuspect ? 1 : 0,
        backdated_reason: envelope.backdated_reason,
        created_by: toBin(userId),
      })
      .execute();
    return { status: 'APPLIED' };
  };

  const requestOverrideHandler: CommandHandler<OverridePayload> = async (uow, envelope) => {
    const sessionId = envelope.aggregate_id;
    if (await sessionExists(uow, sessionId)) return { status: 'APPLIED' }; // rejeu

    const userId = envelope.author_user_id;
    const occurredAt = new Date(envelope.occurred_at);
    const zone = await loadZone(uow, envelope.payload.declaredZoneId);
    if (!zone) return rejected('ZONE_NOT_ALLOWED', 'Zone inconnue (BR-TER-006).');
    if (!(await isZoneAllowed(uow, userId, zone.id, occurredAt))) {
      return rejected(
        'ZONE_NOT_ALLOWED',
        "Zone hors des affectations de l'utilisateur (BR-TER-006).",
      );
    }

    // BR-TER-005 : refus du jour métier, postérieurs à la dernière prise acceptée.
    const day = businessDayOf(occurredAt);
    const lastAccepted = await uow
      .selectFrom('fieldwork_geo_checkins')
      .select('occurred_at')
      .where('user_id', '=', toBin(userId))
      .where('checkin_type', '=', 'START_SERVICE')
      .where('server_result', '=', 'ACCEPTED')
      .where('occurred_at', '<=', occurredAt)
      .orderBy('occurred_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    const since = new Date(
      Math.max(businessDayStartUtc(day).getTime(), lastAccepted?.occurred_at.getTime() ?? 0),
    );
    const refusals = await uow
      .selectFrom('fieldwork_geo_checkins')
      .select(['id', 'occurred_at'])
      .where('user_id', '=', toBin(userId))
      .where('checkin_type', '=', 'START_SERVICE')
      .where('server_result', '<>', 'ACCEPTED')
      .where('occurred_at', '>', since)
      .where('occurred_at', '<=', occurredAt)
      .orderBy('occurred_at', 'desc')
      .execute();
    const minAttempts = await numberSetting(uow, 'fieldwork.override_min_attempts', occurredAt, 3);
    const minMinutes = await numberSetting(uow, 'fieldwork.override_min_minutes', occurredAt, 2);
    const lastRefusal = refusals[0];
    if (
      !lastRefusal ||
      !canRequestOverride(
        refusals.map((r) => r.occurred_at),
        minAttempts,
        minMinutes,
      )
    ) {
      return rejected(
        'OVERRIDE_NOT_ALLOWED_YET',
        `Dérogation possible après ${minAttempts} refus sur au moins ${minMinutes} minutes (BR-TER-005).`,
      );
    }

    const origin = await loadCommandOrigin(uow, envelope.command_id);
    if (origin.deviceId === null) {
      return rejected('DEVICE_REQUIRED', 'Dérogation sans appareil identifié.');
    }
    const approvalRequestId = await requestOverride(uow, idGenerator, {
      sessionId,
      userId,
      zoneId: zone.id,
      occurredAt,
      summary: `Dérogation de prise de service après ${refusals.length} refus`,
    });
    if (approvalRequestId === undefined) {
      return rejected(
        'CONTROL_POLICY_MISSING',
        'Aucune politique de contrôle CHECKIN_OVERRIDE configurée (approvals.policy.set).',
      );
    }
    await openSession(
      uow,
      {
        id: sessionId,
        userId,
        deviceId: origin.deviceId,
        zoneId: zone.id,
        startedAt: occurredAt,
        startCheckinId: fromBin(lastRefusal.id),
        overrideStatus: 'PENDING',
        overrideReason: envelope.payload.reason,
        approvalRequestId,
        commandId: envelope.command_id,
        origin,
        envelope,
      },
      clock.now(),
    );
    return { status: 'APPLIED' };
  };

  return { record, requestOverride: requestOverrideHandler };
}

async function sessionExists(uow: Uow, sessionId: string): Promise<boolean> {
  const row = await uow
    .selectFrom('fieldwork_work_sessions')
    .select('id')
    .where('id', '=', toBin(sessionId))
    .executeTakeFirst();
  return row !== undefined;
}

/** Décision `CHECKIN_OVERRIDE` (SM-WORK-SESSION `PENDING → APPROVED | REJECTED`) ; un rejet est
 * notifié aux modules propriétaires des activités rattachées (session-rejection.ts). */
function registerOverrideDecisionHandler(
  decisionRegistry: ApprovalDecisionHandlerRegistry,
  listeners: SessionRejectedListenerRegistry,
): void {
  decisionRegistry.register('CHECKIN_OVERRIDE', async (uow, ctx) => {
    const session = await uow
      .selectFrom('fieldwork_work_sessions')
      .select(['id', 'override_status'])
      .where('id', '=', toBin(ctx.subjectId))
      .forUpdate()
      .executeTakeFirstOrThrow();
    const overrideStatus = ctx.decision === 'APPROVED' ? 'APPROVED' : 'REJECTED';
    await uow
      .updateTable('fieldwork_work_sessions')
      .set({
        override_status: overrideStatus,
        updated_by: toBin(ctx.decidedBy),
        version: sql`version + 1`,
      })
      .where('id', '=', session.id)
      .execute();
    await emitWorkSessionChanges(uow, [session.id]);
    if (overrideStatus === 'REJECTED') await listeners.notify(uow, ctx.subjectId);
  });
}

export function registerCheckinCommands(
  registry: CommandHandlerRegistry,
  decisionRegistry: ApprovalDecisionHandlerRegistry,
  listeners: SessionRejectedListenerRegistry,
  idGenerator: IdGenerator,
  clock: Clock,
): void {
  const handlers = buildHandlers(idGenerator, clock);
  registry.register({
    commandType: 'fieldwork.checkin.record',
    version: 1,
    payloadSchema: recordPayloadSchema,
    permissionCode: 'fieldwork.checkin.perform',
    handler: handlers.record,
  });
  registry.register({
    commandType: 'fieldwork.checkin.request_override',
    version: 1,
    payloadSchema: overridePayloadSchema,
    permissionCode: 'fieldwork.checkin.perform',
    handler: handlers.requestOverride,
  });
  registerOverrideDecisionHandler(decisionRegistry, listeners);
}
