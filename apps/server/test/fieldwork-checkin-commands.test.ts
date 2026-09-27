/**
 * `fieldwork.checkin.*` et décision `CHECKIN_OVERRIDE` (P3-03, D03-TER, SM-WORK-SESSION) à travers
 * le vrai pipeline de commande, sur une base réelle. Démontre AT-014 (prise à 180 m acceptée, à
 * 1,8 km refusée, puis dérogation validée), INV-TER-01 et INV-TER-02, BR-TER-003 (recalcul serveur
 * défavorable), BR-TER-005, 006, 007, 008, 009 et 010.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { JobHandlerRegistry } from '../src/platform/jobs/job-handler-registry.js';
import { registerCheckinCommands } from '../src/modules/fieldwork/application/commands/checkin-commands.js';
import { SessionRejectedListenerRegistry } from '../src/modules/fieldwork/application/public/index.js';
import {
  SessionAutoCloseJob,
  SESSION_AUTO_CLOSE_JOB_TYPE,
} from '../src/modules/fieldwork/application/jobs/session-auto-close-job.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { fromBin, fromBinOrNull, toBin } from '../src/platform/kysely/uuid-columns.js';
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

const NOW = '2026-10-06T18:00:00.000Z';
const DAY = '2026-10-06';
const CENTER = { lat: 4.0511, lng: 9.7679 };
/** Point à `meters` au nord du centre du géorepère (1° de latitude ≈ 111 195 m). */
const north = (meters: number) => ({ lat: CENTER.lat + meters / 111_195, lng: CENTER.lng });
const at = (hhmmss: string, day = DAY) => `${day}T${hhmmss}.000Z`;
/** `device_seq` unique par appareil (uq_sync_command_inbox_device_seq). */
let deviceSeq = 0;

describe('fieldwork.checkin.* (P3-03)', () => {
  let clock: FixedClock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let listeners: SessionRejectedListenerRegistry;
  const rejectedSessions: string[] = [];
  let admin: string;
  let adminDevice: string;
  let approver: string;
  let approverDevice: string;
  let zoneId: string;
  let subZoneId: string;
  let otherZoneId: string;

  interface Agent {
    readonly userId: string;
    readonly deviceId: string;
  }

  async function newAgent(options: { readonly zoneAssignment?: string } = {}): Promise<Agent> {
    return db.transaction().execute(async (trx) => {
      const userId = await insertTestUser(trx);
      const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
      const role = await insertTestRole(trx, admin, { allowedScopeTypes: ['GLOBAL', 'ZONE'] });
      await grantTestPermission(trx, role, 'fieldwork.checkin.perform', admin, { maxScope: 'OWN' });
      await assignTestRole(
        trx,
        userId,
        role,
        admin,
        options.zoneAssignment !== undefined
          ? { scopeType: 'ZONE', scopeZoneId: options.zoneAssignment }
          : {},
      );
      return { userId, deviceId };
    });
  }

  async function run(
    agent: Agent,
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
  ) {
    return pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: commandType,
        aggregate_type: aggregateType,
        aggregate_id: aggregateId,
        author_user_id: agent.userId,
        base_version: null,
        depends_on: [],
        occurred_at: occurredAt,
        client_created_at: occurredAt,
        captured_offline: true,
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

  function checkin(
    agent: Agent,
    occurredAt: string,
    input: {
      readonly type?: 'START_SERVICE' | 'END_SERVICE';
      readonly position?: { lat: number; lng: number } | null;
      readonly accuracyM?: number | null;
      readonly clientResult?: string;
      readonly sessionId?: string;
      readonly zone?: string;
    } = {},
  ) {
    const checkinId = freshUuid();
    const result = run(agent, 'fieldwork.checkin.record', 'GEO_CHECKIN', checkinId, occurredAt, {
      checkinType: input.type ?? 'START_SERVICE',
      declaredZoneId: input.zone ?? zoneId,
      position: input.position === undefined ? north(100) : input.position,
      accuracyM: input.accuracyM === undefined ? 20 : input.accuracyM,
      clientResult: input.clientResult ?? 'ACCEPTED',
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    });
    return { checkinId, result };
  }

  /** Exécute `fn` avec l'horloge serveur la veille (2026-10-05, 13:00 à Douala). */
  async function onTheEve<T>(fn: () => Promise<T>): Promise<T> {
    clock.setTo(new Date('2026-10-05T12:00:00.000Z'));
    try {
      return await fn();
    } finally {
      clock.setTo(new Date(NOW));
    }
  }

  async function checkinRow(checkinId: string) {
    return db
      .selectFrom('fieldwork_geo_checkins')
      .selectAll()
      .where('id', '=', toBin(checkinId))
      .executeTakeFirstOrThrow();
  }

  async function sessionRow(sessionId: string) {
    return db
      .selectFrom('fieldwork_work_sessions')
      .selectAll()
      .where('id', '=', toBin(sessionId))
      .executeTakeFirst();
  }

  beforeAll(async () => {
    clock = new FixedClock(new Date(NOW));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    const decisionRegistry = new ApprovalDecisionHandlerRegistry();
    listeners = new SessionRejectedListenerRegistry();
    listeners.register(async (_uow, sessionId) => {
      rejectedSessions.push(sessionId);
    });
    registerCheckinCommands(registry, decisionRegistry, listeners, idGenerator, clock);
    registerPolicyCommands(registry);
    registerRequestCommands(registry, decisionRegistry);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    await db.transaction().execute(async (trx) => {
      admin = await insertTestUser(trx);
      adminDevice = await insertTestDevice(trx, admin, { status: 'ACTIVE' });
      approver = await insertTestUser(trx);
      approverDevice = await insertTestDevice(trx, approver, { status: 'ACTIVE' });
      zoneId = await insertTestZone(trx, admin);
      subZoneId = await insertTestZone(trx, admin, { parentId: zoneId });
      otherZoneId = await insertTestZone(trx, admin);
      for (const id of [zoneId, subZoneId, otherZoneId]) {
        await trx
          .updateTable('organization_zones')
          .set({
            geofence_lat: String(CENTER.lat),
            geofence_lng: String(CENTER.lng),
            geofence_radius_m: '500',
          })
          .where('id', '=', toBin(id))
          .execute();
      }

      const adminRole = await insertTestRole(trx, admin);
      await grantTestPermission(trx, adminRole, 'approvals.policy.manage', admin);
      await assignTestRole(trx, admin, adminRole, admin);

      const approverRole = await insertTestRole(trx, approver);
      await grantTestPermission(trx, approverRole, 'approvals.request.read', admin);
      await grantTestPermission(trx, approverRole, 'fieldwork.checkin_override.approve', admin);
      await assignTestRole(trx, approver, approverRole, admin);
    });

    // Politique CHECKIN_OVERRIDE (AV-021 : dérogation validée par un responsable).
    const policyId = freshUuid();
    const policy = await pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: 'approvals.policy.set',
        aggregate_type: 'CONTROL_POLICY',
        aggregate_id: policyId,
        author_user_id: admin,
        base_version: null,
        depends_on: [],
        occurred_at: at('00:00:00'),
        client_created_at: at('00:00:00'),
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload: {
          code: `CHECKIN_OVERRIDE_${policyId.slice(-8)}`,
          operationType: 'CHECKIN_OVERRIDE',
          requiresApproval: true,
          approverPermission: 'fieldwork.checkin_override.approve',
          approverScope: 'TEAM',
        },
      },
      { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
    );
    expect(policy.status).toBe('APPLIED');
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('AT-014 : prise de service à 180 m acceptée — session ouverte sous l’identifiant de l’appareil', async () => {
    const agent = await newAgent();
    const sessionId = freshUuid();
    const { checkinId, result } = checkin(agent, at('07:00:00'), {
      position: north(180),
      sessionId,
    });
    expect((await result).status).toBe('APPLIED');

    const row = await checkinRow(checkinId);
    expect(row.server_result).toBe('ACCEPTED');
    expect(Number(row.distance_m)).toBeCloseTo(180, 0);
    expect(Number(row.geofence_radius_m)).toBe(500);
    expect(fromBinOrNull(row.work_session_id)).toBe(sessionId);

    const session = await sessionRow(sessionId);
    expect(session?.status).toBe('OPEN');
    expect(session?.override_status).toBe('NOT_REQUIRED');
    expect(fromBin(session!.start_checkin_id)).toBe(checkinId);
  });

  it('AT-014 : prise à 1,8 km refusée — tentative conservée, aucune session (INV-TER-02)', async () => {
    const agent = await newAgent();
    const { checkinId, result } = checkin(agent, at('07:00:00'), {
      position: north(1800),
      clientResult: 'REJECTED_OUT_OF_ZONE',
    });
    expect((await result).status).toBe('APPLIED');
    const row = await checkinRow(checkinId);
    expect(row.server_result).toBe('REJECTED_OUT_OF_ZONE');
    expect(Number(row.distance_m)).toBeCloseTo(1800, 0);
    expect(row.work_session_id).toBeNull();
    const sessions = await db
      .selectFrom('fieldwork_work_sessions')
      .select('id')
      .where('user_id', '=', toBin(agent.userId))
      .execute();
    expect(sessions).toHaveLength(0);
  });

  it('AT-014 / BR-TER-005 : dérogation après 3 refus sur 2 minutes, puis validée par un responsable', async () => {
    const agent = await newAgent();
    const refuse = (time: string) =>
      checkin(agent, at(time), { position: north(1800), clientResult: 'REJECTED_OUT_OF_ZONE' })
        .result;
    expect((await refuse('09:00:00')).status).toBe('APPLIED');
    expect((await refuse('09:01:00')).status).toBe('APPLIED');

    const tooEarly = await run(
      agent,
      'fieldwork.checkin.request_override',
      'WORK_SESSION',
      freshUuid(),
      at('09:01:30'),
      {
        declaredZoneId: zoneId,
        reason: 'Réseau GPS instable au marché',
      },
    );
    expect(tooEarly.status).toBe('REJECTED');
    expect(tooEarly.status === 'REJECTED' && tooEarly.error.code).toBe('OVERRIDE_NOT_ALLOWED_YET');

    expect((await refuse('09:02:30')).status).toBe('APPLIED');
    const sessionId = freshUuid();
    const request = await run(
      agent,
      'fieldwork.checkin.request_override',
      'WORK_SESSION',
      sessionId,
      at('09:03:00'),
      {
        declaredZoneId: zoneId,
        reason: 'Réseau GPS instable au marché',
      },
    );
    expect(request.status, JSON.stringify(request)).toBe('APPLIED');

    const pending = await sessionRow(sessionId);
    expect(pending?.status).toBe('OPEN'); // activité autorisée mais signalée (BR-TER-005)
    expect(pending?.override_status).toBe('PENDING');
    expect(pending?.override_reason).toBe('Réseau GPS instable au marché');
    const requestId = fromBinOrNull(pending!.approval_request_id)!;

    const approval = await pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: 'approvals.request.approve',
        aggregate_type: 'APPROVAL_REQUEST',
        aggregate_id: requestId,
        author_user_id: approver,
        base_version: null,
        depends_on: [],
        occurred_at: at('10:00:00'),
        client_created_at: at('10:00:00'),
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload: { requestId },
      },
      {
        authenticatedUserId: approver,
        authenticatedDeviceId: approverDevice,
        transport: 'ONLINE_API',
      },
    );
    expect(approval.status, JSON.stringify(approval)).toBe('APPLIED');
    expect((await sessionRow(sessionId))?.override_status).toBe('APPROVED');
  });

  it('dérogation rejetée : les modules des activités rattachées sont notifiés (session_rejected)', async () => {
    const agent = await newAgent();
    for (const time of ['11:00:00', '11:01:00', '11:02:30']) {
      await checkin(agent, at(time), {
        position: north(1800),
        clientResult: 'REJECTED_OUT_OF_ZONE',
      }).result;
    }
    const sessionId = freshUuid();
    expect(
      (
        await run(
          agent,
          'fieldwork.checkin.request_override',
          'WORK_SESSION',
          sessionId,
          at('11:03:00'),
          {
            declaredZoneId: zoneId,
            reason: 'Batterie faible du GPS',
          },
        )
      ).status,
    ).toBe('APPLIED');
    const requestId = fromBinOrNull((await sessionRow(sessionId))!.approval_request_id)!;
    const rejection = await pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: 'approvals.request.reject',
        aggregate_type: 'APPROVAL_REQUEST',
        aggregate_id: requestId,
        author_user_id: approver,
        base_version: null,
        depends_on: [],
        occurred_at: at('12:00:00'),
        client_created_at: at('12:00:00'),
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload: { requestId, comment: 'Aucune visite attestée dans la zone.' },
      },
      {
        authenticatedUserId: approver,
        authenticatedDeviceId: approverDevice,
        transport: 'ONLINE_API',
      },
    );
    expect(rejection.status, JSON.stringify(rejection)).toBe('APPLIED');
    const session = await sessionRow(sessionId);
    expect(session?.override_status).toBe('REJECTED');
    expect(session?.status).toBe('OPEN'); // les activités restent enregistrées (BR-TER-005)
    expect(rejectedSessions).toContain(sessionId);
  });

  it('BR-TER-003 : acceptée sur l’appareil, refusée par le serveur — session gardée, dérogation demandée', async () => {
    const agent = await newAgent();
    const sessionId = freshUuid();
    const { checkinId, result } = checkin(agent, at('08:00:00'), {
      position: north(900),
      clientResult: 'ACCEPTED', // géorepère local périmé
      sessionId,
    });
    expect((await result).status).toBe('APPLIED');
    const row = await checkinRow(checkinId);
    expect(row.client_result).toBe('ACCEPTED');
    expect(row.server_result).toBe('REJECTED_OUT_OF_ZONE');
    expect(row.result_divergence).toBe(1);
    const session = await sessionRow(sessionId);
    expect(session?.status).toBe('OPEN');
    expect(session?.override_status).toBe('PENDING');
    expect(session?.approval_request_id).not.toBeNull();
  });

  it('BR-TER-009 / INV-TER-01 : une nouvelle prise acceptée clôt la précédente à son heure', async () => {
    const agent = await newAgent();
    const first = freshUuid();
    const second = freshUuid();
    await checkin(agent, at('07:00:00'), { sessionId: first }).result;
    await checkin(agent, at('13:00:00'), { sessionId: second }).result;
    const closed = await sessionRow(first);
    expect(closed?.status).toBe('CLOSED');
    expect(closed?.close_cause).toBe('SUPERSEDED');
    expect(closed?.ended_at?.toISOString()).toBe(at('13:00:00'));
    expect((await sessionRow(second))?.status).toBe('OPEN');

    // Prise tardive antérieure, synchronisée après : enregistrée déjà close (INV-TER-01).
    const late = freshUuid();
    await checkin(agent, at('10:00:00'), { sessionId: late }).result;
    const lateRow = await sessionRow(late);
    expect(lateRow?.status).toBe('CLOSED');
    expect(lateRow?.ended_at?.toISOString()).toBe(at('13:00:00'));
    expect((await sessionRow(second))?.status).toBe('OPEN');
  });

  it('BR-TER-007 : fin de service hors zone — signalée, jamais bloquante, clôt la session', async () => {
    const agent = await newAgent();
    const today = freshUuid();
    await checkin(agent, at('07:00:00'), { sessionId: today }).result;
    const end = checkin(agent, at('17:00:00'), {
      type: 'END_SERVICE',
      position: north(3000),
      clientResult: 'REJECTED_OUT_OF_ZONE',
      sessionId: today,
    });
    expect((await end.result).status).toBe('APPLIED');
    expect((await checkinRow(end.checkinId)).server_result).toBe('REJECTED_OUT_OF_ZONE');
    const closed = await sessionRow(today);
    expect(closed?.status).toBe('CLOSED');
    expect(closed?.close_cause).toBe('END_SERVICE');
    expect(closed?.ended_at?.toISOString()).toBe(at('17:00:00'));
    expect(fromBinOrNull(closed!.end_checkin_id)).toBe(end.checkinId);
  });

  it('BR-TER-008 : prise de la veille reçue le lendemain — close à 23:59 ; une fin antérieure l’emporte', async () => {
    const agent = await newAgent();
    const yesterday = freshUuid();
    await checkin(agent, at('08:00:00', '2026-10-05'), { sessionId: yesterday }).result;
    const auto = await sessionRow(yesterday);
    expect(auto?.status).toBe('AUTO_CLOSED'); // comme l'appareil hors ligne l'a fait à 23:59
    expect(auto?.close_cause).toBe('AUTO_2359');
    expect(auto?.ended_at?.toISOString()).toBe('2026-10-05T22:59:00.000Z'); // 23:59 à Douala

    // Fin de service de la veille à 18:00 (Douala), reçue après : l'heure la plus ancienne l'emporte.
    await checkin(agent, at('17:00:00', '2026-10-05'), {
      type: 'END_SERVICE',
      sessionId: yesterday,
    }).result;
    const corrected = await sessionRow(yesterday);
    expect(corrected?.status).toBe('CLOSED');
    expect(corrected?.close_cause).toBe('END_SERVICE');
    expect(corrected?.ended_at?.toISOString()).toBe(at('17:00:00', '2026-10-05'));
  });

  it('BR-TER-008 / BR-TER-009 : session ouverte la veille, nouvelle prise le lendemain — close à 23:59', async () => {
    const agent = await newAgent();
    const eve = freshUuid();
    await onTheEve(() => checkin(agent, at('08:00:00', '2026-10-05'), { sessionId: eve }).result);
    expect((await sessionRow(eve))?.status).toBe('OPEN');
    const today = freshUuid();
    await checkin(agent, at('07:00:00'), { sessionId: today }).result;
    const closed = await sessionRow(eve);
    expect(closed?.status).toBe('AUTO_CLOSED');
    expect(closed?.close_cause).toBe('AUTO_2359');
    expect(closed?.ended_at?.toISOString()).toBe('2026-10-05T22:59:00.000Z');
    expect((await sessionRow(today))?.status).toBe('OPEN');
  });

  it('BR-TER-008 : tâche fieldwork.session.auto_close — clôt à 23:59 la session oubliée la veille', async () => {
    const agent = await newAgent();
    const eve = freshUuid();
    const sameDay = freshUuid();
    await onTheEve(() => checkin(agent, at('08:00:00', '2026-10-05'), { sessionId: eve }).result);
    const other = await newAgent();
    await checkin(other, at('08:00:00'), { sessionId: sameDay }).result;

    const jobs = new JobHandlerRegistry();
    new SessionAutoCloseJob(clock, jobs).onModuleInit();
    await db.transaction().execute((trx) => jobs.resolve(SESSION_AUTO_CLOSE_JOB_TYPE)!(trx, {}));

    const auto = await sessionRow(eve);
    expect(auto?.status).toBe('AUTO_CLOSED');
    expect(auto?.close_cause).toBe('AUTO_2359');
    expect(auto?.ended_at?.toISOString()).toBe('2026-10-05T22:59:00.000Z');
    expect((await sessionRow(sameDay))?.status).toBe('OPEN'); // 23:59 pas encore passé
  });

  it('BR-TER-006 : zone hors des affectations refusée ; sous-zone de la zone affectée acceptée', async () => {
    const agent = await newAgent({ zoneAssignment: zoneId });
    const refused = checkin(agent, at('07:00:00'), { zone: otherZoneId });
    const outcome = await refused.result;
    expect(outcome.status).toBe('REJECTED');
    expect(outcome.status === 'REJECTED' && outcome.error.code).toBe('ZONE_NOT_ALLOWED');
    const accepted = checkin(agent, at('07:05:00'), { zone: subZoneId, sessionId: freshUuid() });
    expect((await accepted.result).status).toBe('APPLIED');
    expect((await checkinRow(accepted.checkinId)).server_result).toBe('ACCEPTED');
  });

  it('D03 §14 : zone privée de son géorepère pendant la période hors ligne — tentative conservée, ZONE_INACTIVE', async () => {
    const agent = await newAgent();
    const bare = await db.transaction().execute((trx) => insertTestZone(trx, admin));
    const attempt = checkin(agent, at('07:30:00'), { zone: bare, sessionId: freshUuid() });
    expect((await attempt.result).status).toBe('APPLIED');
    const row = await checkinRow(attempt.checkinId);
    expect(row.server_result).toBe('ZONE_INACTIVE');
    expect(row.geofence_radius_m).toBeNull();
    expect(row.result_divergence).toBe(1);
    // Acceptée sur l'appareil, refusée par le serveur : session gardée, dérogation demandée.
    const session = await db
      .selectFrom('fieldwork_work_sessions')
      .select(['status', 'override_status'])
      .where('start_checkin_id', '=', toBin(attempt.checkinId))
      .executeTakeFirstOrThrow();
    expect(session).toEqual({ status: 'OPEN', override_status: 'PENDING' });
  });

  it('BR-TER-002 / BR-TER-010 : sans position (NO_POSITION), précision nulle signalée', async () => {
    const agent = await newAgent();
    const noPosition = checkin(agent, at('06:00:00'), {
      position: null,
      accuracyM: null,
      clientResult: 'NO_POSITION',
    });
    expect((await noPosition.result).status).toBe('APPLIED');
    const row = await checkinRow(noPosition.checkinId);
    expect(row.server_result).toBe('NO_POSITION');
    expect(row.lat).toBeNull();

    const zeroAccuracy = checkin(agent, at('06:30:00'), { accuracyM: 0, sessionId: freshUuid() });
    expect((await zeroAccuracy.result).status).toBe('APPLIED');
    expect((await checkinRow(zeroAccuracy.checkinId)).suspicion_flags).toContain('ACCURACY_ZERO');
  });
});
