/**
 * P9-10 : alerte `CHECKIN_SUSPICIOUS` (D13 §7.1, BR-TER-010, AV-418) — `CheckInSuspicious` publié par
 * `fieldwork.checkin.record` quand le pointage porte au moins un signal. Les pointages passent par le vrai
 * pipeline de commande (base partagée : zone, agents et pointages neufs).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerCheckinCommands } from '../src/modules/fieldwork/application/commands/checkin-commands.js';
import { SessionRejectedListenerRegistry } from '../src/modules/fieldwork/application/public/index.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { handleAlertEvent } from '../src/modules/communication/application/events/alerts-consumer.js';
import { toDomainEvent } from '../src/platform/events/domain-event.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { rolledBack } from './communication-test-kit.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestRole,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

vi.setConfig({ testTimeout: 120_000 });

afterAll(closeTestDb);

const NOW = '2026-10-06T18:00:00.000Z';
const DAY = '2026-10-06';
const PREVIOUS_DAY = '2026-10-05';
const CENTER = { lat: 4.0511, lng: 9.7679 };
/** Point à `meters` au nord du centre du géorepère (1° de latitude ≈ 111 195 m). */
const north = (meters: number) => ({ lat: CENTER.lat + meters / 111_195, lng: CENTER.lng });
const at = (hhmmss: string, day = DAY) => `${day}T${hhmmss}.000Z`;
let deviceSeq = 0;
/** Un rejeu garde le `device_seq` de la commande d'origine (sinon : `COMMAND_ID_REUSED`). */
const seqByCommand = new Map<string, number>();

interface Agent {
  readonly userId: string;
  readonly deviceId: string;
}

describe('CHECKIN_SUSPICIOUS : pointage à signal, à l’enregistrement (P9-10)', () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let admin: string;
  let zoneId: string;

  async function newAgent(): Promise<Agent> {
    return db.transaction().execute(async (trx) => {
      const userId = await insertTestUser(trx);
      const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
      const role = await insertTestRole(trx, admin, { allowedScopeTypes: ['GLOBAL', 'ZONE'] });
      await grantTestPermission(trx, role, 'fieldwork.checkin.perform', admin, { maxScope: 'OWN' });
      await assignTestRole(trx, userId, role, admin);
      return { userId, deviceId };
    });
  }

  async function run(
    agent: Agent,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
    options: { readonly commandId?: string; readonly offline?: boolean } = {},
  ) {
    const commandId = options.commandId ?? freshUuid();
    const seq = seqByCommand.get(commandId) ?? ++deviceSeq;
    seqByCommand.set(commandId, seq);
    return pipeline.handle(
      {
        command_id: commandId,
        device_seq: seq,
        command_version: 1,
        command_type: 'fieldwork.checkin.record',
        aggregate_type: 'GEO_CHECKIN',
        aggregate_id: aggregateId,
        author_user_id: agent.userId,
        base_version: null,
        depends_on: [],
        occurred_at: occurredAt,
        client_created_at: occurredAt,
        captured_offline: options.offline ?? true,
        backdated_reason: null,
        attachment_ids: [],
        payload,
      },
      {
        authenticatedUserId: agent.userId,
        authenticatedDeviceId: agent.deviceId,
        transport: 'SYNC_PUSH',
      },
    );
  }

  async function checkin(
    agent: Agent,
    occurredAt: string,
    input: {
      readonly type?: 'START_SERVICE' | 'END_SERVICE';
      readonly position?: { lat: number; lng: number } | null;
      readonly accuracyM?: number | null;
      readonly clientResult?: string;
      readonly zone?: string;
      readonly checkinId?: string;
      readonly commandId?: string;
      readonly sessionId?: string;
      readonly offline?: boolean;
    } = {},
  ) {
    const checkinId = input.checkinId ?? freshUuid();
    const result = await run(
      agent,
      checkinId,
      occurredAt,
      {
        checkinType: input.type ?? 'START_SERVICE',
        declaredZoneId: input.zone ?? zoneId,
        position: input.position === undefined ? north(100) : input.position,
        accuracyM: input.accuracyM === undefined ? 20 : input.accuracyM,
        clientResult: input.clientResult ?? 'ACCEPTED',
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      },
      {
        ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
        ...(input.offline === undefined ? {} : { offline: input.offline }),
      },
    );
    return { checkinId, result };
  }

  async function suspiciousEvents(checkinId: string) {
    return (
      await db
        .selectFrom('platform_domain_events')
        .selectAll()
        .where('event_type', '=', 'CheckInSuspicious')
        .where('aggregate_id', '=', toBin(checkinId))
        .orderBy('seq')
        .execute()
    ).map((row) => toDomainEvent(row));
  }

  beforeAll(async () => {
    const clock = new FixedClock(new Date(NOW));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    const decisionRegistry = new ApprovalDecisionHandlerRegistry();
    registerCheckinCommands(
      registry,
      decisionRegistry,
      new SessionRejectedListenerRegistry(),
      idGenerator,
      clock,
    );
    registerPolicyCommands(registry);
    registerRequestCommands(registry, decisionRegistry);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    await db.transaction().execute(async (trx) => {
      admin = await insertTestUser(trx);
      zoneId = await insertTestZone(trx, admin);
      await trx
        .updateTable('organization_zones')
        .set({
          geofence_lat: String(CENTER.lat),
          geofence_lng: String(CENTER.lng),
          geofence_radius_m: '500',
        })
        .where('id', '=', toBin(zoneId))
        .execute();
    });
  });

  it('un pointage ordinaire ne publie rien', async () => {
    const agent = await newAgent();
    const { checkinId, result } = await checkin(agent, at('07:00:00'), { accuracyM: 12 });
    expect(result.status).toBe('APPLIED');
    expect(await suspiciousEvents(checkinId)).toEqual([]);
  });

  it('précision nulle : un événement, sans coordonnées, libellés français et distance arrondie', async () => {
    const agent = await newAgent();
    const sessionId = freshUuid();
    const { checkinId, result } = await checkin(agent, at('07:00:00'), {
      position: north(180.7),
      accuracyM: 0,
      sessionId,
    });
    expect(result.status).toBe('APPLIED');

    const events = await suspiciousEvents(checkinId);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event!.producerModule).toBe('fieldwork');
    expect(event!.aggregateType).toBe('GEO_CHECKIN');
    const user = await db
      .selectFrom('identity_users')
      .select('full_name')
      .where('id', '=', toBin(agent.userId))
      .executeTakeFirstOrThrow();
    expect(event!.payload).toEqual({
      checkin_id: checkinId,
      user_id: agent.userId,
      user_label: user.full_name,
      zone_id: zoneId,
      checkin_type: 'START_SERVICE',
      server_result: 'ACCEPTED',
      flags: 'Précision GPS nulle',
      flag_codes: ['ACCURACY_ZERO'],
      distance_m: 181,
      accuracy_m: 0,
      work_session_id: sessionId,
      occurred_at: at('07:00:00'),
      business_day: DAY,
      captured_offline: true,
    });
    // Ni latitude ni longitude : la charge utile est conservée en entier avec l'alerte (ADR-061 §4).
    expect(JSON.stringify(event!.payload)).not.toMatch(/"(lat|lng|latitude|longitude)"/);
    expect(event!.commandId).not.toBeNull();
    // Daté de la détection par le serveur, comme les alertes critiques de stock (AV-407 étendu, AV-418).
    expect(event!.occurredAt.toISOString()).toBe(NOW);
  });

  it('vitesse impossible : le pointage refusé hors zone alerte aussi (toute tentative à signal)', async () => {
    const agent = await newAgent();
    const first = await checkin(agent, at('08:00:00'), { position: CENTER, accuracyM: 15 });
    expect(first.result.status).toBe('APPLIED');
    // 30 km en 10 minutes : 180 km/h ; hors du géorepère, refusé par le serveur.
    const second = await checkin(agent, at('08:10:00'), {
      position: north(30_000),
      accuracyM: 15,
      clientResult: 'REJECTED_OUT_OF_ZONE',
    });
    expect(second.result.status).toBe('APPLIED');
    const row = await db
      .selectFrom('fieldwork_geo_checkins')
      .select('server_result')
      .where('id', '=', toBin(second.checkinId))
      .executeTakeFirstOrThrow();
    expect(row.server_result).toBe('REJECTED_OUT_OF_ZONE');

    expect(await suspiciousEvents(first.checkinId)).toEqual([]);
    const [event] = await suspiciousEvents(second.checkinId);
    expect(event!.payload).toMatchObject({
      server_result: 'REJECTED_OUT_OF_ZONE',
      flags: 'Vitesse impossible depuis la position précédente',
      flag_codes: ['SPEED_IMPLAUSIBLE'],
      distance_m: 30_000,
      work_session_id: null,
    });
  });

  it('le résultat publié est celui du serveur, non celui de l’appareil', async () => {
    const agent = await newAgent();
    // L'appareil se croit dans la zone (ACCEPTED) ; à 30 km, le serveur refuse. Sans identifiant de session,
    // aucune dérogation n'est demandée.
    const { checkinId, result } = await checkin(agent, at('08:00:00'), {
      position: north(30_000),
      accuracyM: 0,
      clientResult: 'ACCEPTED',
    });
    expect(result.status).toBe('APPLIED');
    const [event] = await suspiciousEvents(checkinId);
    expect(event!.payload).toMatchObject({
      server_result: 'REJECTED_OUT_OF_ZONE',
      flag_codes: ['ACCURACY_ZERO'],
    });
  });

  it('pointage appliqué tard : daté de l’application, jour métier et heure du fait dans la charge utile', async () => {
    const agent = await newAgent();
    const { checkinId, result } = await checkin(agent, at('21:30:00', PREVIOUS_DAY), {
      accuracyM: 0,
      offline: false,
    });
    expect(result.status).toBe('APPLIED');
    const [event] = await suspiciousEvents(checkinId);
    expect(event!.occurredAt.toISOString()).toBe(NOW);
    expect(event!.payload).toMatchObject({
      occurred_at: at('21:30:00', PREVIOUS_DAY),
      // 22:30 à Douala la veille : le jour métier du fait n'est pas celui de la détection.
      business_day: PREVIOUS_DAY,
      captured_offline: false,
    });
  });

  it('fin de service à signal : alerte aussi, avec son type de pointage', async () => {
    const agent = await newAgent();
    const start = await checkin(agent, at('07:00:00'), { accuracyM: 12, sessionId: freshUuid() });
    expect(start.result.status).toBe('APPLIED');
    const end = await checkin(agent, at('17:00:00'), { type: 'END_SERVICE', accuracyM: 0 });
    expect(end.result.status).toBe('APPLIED');
    const [event] = await suspiciousEvents(end.checkinId);
    expect(event!.payload).toMatchObject({
      checkin_type: 'END_SERVICE',
      flag_codes: ['ACCURACY_ZERO'],
    });
  });

  it('mêmes coordonnées qu’un autre jour : signal, deux signaux joints dans l’ordre de la détection', async () => {
    const agent = await newAgent();
    const spot = north(120);
    const earlier = await checkin(agent, at('07:00:00', PREVIOUS_DAY), {
      position: spot,
      accuracyM: 11,
    });
    expect(earlier.result.status).toBe('APPLIED');
    expect(await suspiciousEvents(earlier.checkinId)).toEqual([]);
    const later = await checkin(agent, at('07:00:00'), { position: spot, accuracyM: 0 });
    expect(later.result.status).toBe('APPLIED');
    const [event] = await suspiciousEvents(later.checkinId);
    expect(event!.payload).toMatchObject({
      flag_codes: ['ACCURACY_ZERO', 'COORDINATES_REPEATED'],
      flags: "Précision GPS nulle ; Mêmes coordonnées qu'un autre jour",
    });
  });

  it('même précision sur plus de 5 pointages consécutifs : alerte au sixième seulement', async () => {
    const agent = await newAgent();
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      // Positions distinctes, même précision : seul ACCURACY_REPEATED peut jouer.
      const { checkinId, result } = await checkin(agent, at(`0${i + 1}:00:00`), {
        position: north(100 + i * 7),
        accuracyM: 9,
      });
      expect(result.status).toBe('APPLIED');
      ids.push(checkinId);
    }
    for (const id of ids.slice(0, 5)) expect(await suspiciousEvents(id)).toEqual([]);
    const [event] = await suspiciousEvents(ids[5]!);
    expect(event!.payload).toMatchObject({
      flag_codes: ['ACCURACY_REPEATED'],
      flags: 'Même précision répétée',
    });
  });

  it('sans position : aucun signal, aucun événement', async () => {
    const agent = await newAgent();
    const { checkinId, result } = await checkin(agent, at('07:00:00'), {
      position: null,
      accuracyM: null,
      clientResult: 'NO_POSITION',
    });
    expect(result.status).toBe('APPLIED');
    expect(await suspiciousEvents(checkinId)).toEqual([]);
  });

  it('commande rejetée (zone inconnue) : le pointage n’existe pas et aucun événement ne reste', async () => {
    const agent = await newAgent();
    const checkinId = freshUuid();
    const result = await run(agent, checkinId, at('07:00:00'), {
      checkinType: 'START_SERVICE',
      declaredZoneId: freshUuid(),
      position: north(100),
      accuracyM: 0,
      clientResult: 'ACCEPTED',
    });
    expect(result.status).toBe('REJECTED');
    expect(await suspiciousEvents(checkinId)).toEqual([]);
  });

  it('commande rejetée après le calcul des signaux (SESSION_EXISTS) : ni pointage ni événement', async () => {
    const agent = await newAgent();
    const sessionId = freshUuid();
    const first = await checkin(agent, at('07:00:00'), { accuracyM: 12, sessionId });
    expect(first.result.status).toBe('APPLIED');
    // Même session sous un autre pointage, avec un signal (précision nulle) : les signaux sont calculés puis
    // la session existante rejette la commande, avant l'écriture du pointage et de l'événement.
    const second = await checkin(agent, at('07:05:00'), { accuracyM: 0, sessionId });
    expect(second.result.status).toBe('REJECTED');
    expect(second.result.error?.code).toBe('SESSION_EXISTS');
    expect(await suspiciousEvents(second.checkinId)).toEqual([]);
    const rows = await db
      .selectFrom('fieldwork_geo_checkins')
      .select('id')
      .where('id', '=', toBin(second.checkinId))
      .execute();
    expect(rows).toEqual([]);
  });

  it('rejeu : même commande ou même pointage sous une autre commande, un seul événement', async () => {
    const agent = await newAgent();
    const commandId = freshUuid();
    const first = await checkin(agent, at('07:00:00'), { accuracyM: 0, commandId });
    expect(first.result.status).toBe('APPLIED');
    const sameCommand = await checkin(agent, at('07:00:00'), {
      accuracyM: 0,
      commandId,
      checkinId: first.checkinId,
    });
    expect(sameCommand.result.status).toBe('APPLIED');
    const otherCommand = await checkin(agent, at('07:00:00'), {
      accuracyM: 0,
      checkinId: first.checkinId,
    });
    expect(otherCommand.result.status).toBe('APPLIED');
    expect(await suspiciousEvents(first.checkinId)).toHaveLength(1);
  });

  it('bout en bout : le consommateur lève une alerte d’événement, manuelle, au propriétaire du pointage', async () => {
    const agent = await newAgent();
    const { checkinId } = await checkin(agent, at('07:00:00'), { accuracyM: 0 });
    const events = await suspiciousEvents(checkinId);
    expect(events).toHaveLength(1);
    await rolledBack(async (uow: UnitOfWork) => {
      await handleAlertEvent(uow, events[0]!, { idGenerator });
      const alerts = await uow
        .selectFrom('communication_alerts')
        .select([
          'severity',
          'status',
          'title',
          'message',
          'dedup_key',
          'owner_user_id',
          'zone_id',
          'nature',
        ])
        .where('dedup_key', '=', `CHECKIN_SUSPICIOUS:${checkinId}`)
        .execute();
      expect(alerts).toHaveLength(1);
      const [alert] = alerts;
      expect(alert).toMatchObject({
        severity: 'WARNING',
        status: 'OPEN',
        title: 'Pointage suspect',
        nature: 'EVENT',
      });
      expect(fromBin(alert!.owner_user_id as Buffer)).toBe(agent.userId);
      expect(fromBin(alert!.zone_id as Buffer)).toBe(zoneId);
      expect(alert!.message).toContain('Signaux : Précision GPS nulle');
    });
  });
});
