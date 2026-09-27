/**
 * P3-08 — « Journée d'un commercial terrain hors ligne » (plan de développement §4, P3 : tests
 * E2E ; WF-J1 étapes 2, 4, 5, 8, 9 ; WF-13 sans vente). Un appareil virtuel (`sync-harness.ts`)
 * travaille toute la journée hors ligne, puis envoie sa file d'attente en un lot par le vrai
 * protocole (`SyncPushService` → pipeline → gestionnaires `fieldwork` et `crm`) et télécharge ses
 * jeux (`SyncPullService`). Rôles réels du seed.
 *
 * Démontre : prise de service acceptée localement, prospect créé et visité dans la session
 * (dépendance `depends_on` vers sa création), interaction, visite lointaine signalée, fin de
 * service ; tout est appliqué dans l'ordre de l'appareil, la file rejouée est idempotente, les jeux
 * `customers`, `crm_activity` et `fieldwork` redonnent l'état du serveur, et l'effort commercial de
 * la journée égale les opérations (AT-015).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FixedClock,
  Uuidv7Generator,
  businessDayEndUtc,
  businessDayStartUtc,
  type IdGenerator,
} from '@gic/domain';
import type { RawCommandEnvelope } from '@gic/contracts';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { SyncPushService } from '../src/sync/sync-push.service.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import { registerCheckinCommands } from '../src/modules/fieldwork/application/commands/checkin-commands.js';
import { SessionRejectedListenerRegistry } from '../src/modules/fieldwork/application/public/index.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerCustomerCommands } from '../src/modules/crm/application/commands/customer-commands.js';
import { registerActivityCommands } from '../src/modules/crm/application/commands/activity-commands.js';
import { flagVisitsOfRejectedSession } from '../src/modules/crm/application/reactions/session-rejection.js';
import { commercialEffort } from '../src/modules/crm/application/public/index.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { VirtualDevice } from './sync-harness.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  insertTestDevice,
  insertTestUser,
  insertTestZone,
  recentBusinessDay,
  shiftBusinessDay,
} from './helpers.js';

// Jour récent (heure réelle) : la fenêtre de 90 jours du jeu `crm_activity` est évaluée par la base.
const DAY = recentBusinessDay(2);
const NEXT_ACTION = shiftBusinessDay(DAY, 8);
const at = (hhmmss: string) => `${DAY}T${hhmmss}.000Z`;
const CENTER = { lat: 4.0511, lng: 9.7679 };
const north = (meters: number) => ({ lat: CENTER.lat + meters / 111_195, lng: CENTER.lng });

describe('P3-08 : journée d’un commercial terrain hors ligne (WF-J1, WF-13 sans vente)', () => {
  let clock: FixedClock;
  let idGenerator: IdGenerator;
  let device: VirtualDevice;
  let seller: string;
  let zoneId: string;
  let outcomeId: string;
  let existingCustomer: string;
  let queue: RawCommandEnvelope[];
  const sessionId = freshUuid();
  const prospectId = freshUuid();
  const nearVisitId = freshUuid();
  const farVisitId = freshUuid();

  function envelope(
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
    dependsOn: readonly string[] = [],
  ): RawCommandEnvelope {
    return {
      command_id: freshUuid(),
      device_seq: device.nextSeq(),
      command_type: commandType,
      command_version: 1,
      author_user_id: seller,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      base_version: null,
      depends_on: [...dependsOn],
      occurred_at: occurredAt,
      client_created_at: occurredAt,
      captured_offline: true,
      backdated_reason: null,
      attachment_ids: [],
      payload,
    };
  }

  beforeAll(async () => {
    clock = new FixedClock(new Date(at('08:00:00')));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    const listeners = new SessionRejectedListenerRegistry();
    listeners.register(flagVisitsOfRejectedSession);
    registerCheckinCommands(
      registry,
      new ApprovalDecisionHandlerRegistry(),
      listeners,
      idGenerator,
      clock,
    );
    registerCustomerCommands(registry, idGenerator);
    registerActivityCommands(registry);
    const pipeline = new CommandPipelineService(db, registry, clock, idGenerator);
    const services = {
      push: new SyncPushService(pipeline, db, clock),
      pull: new SyncPullService(db),
    };

    const cteRole = await db
      .selectFrom('identity_roles')
      .select('id')
      .where('code', '=', 'COMMERCIAL_TERRAIN')
      .executeTakeFirstOrThrow();
    let deviceId = '';
    await db.transaction().execute(async (trx) => {
      const admin = await insertTestUser(trx);
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
      seller = await insertTestUser(trx);
      deviceId = await insertTestDevice(trx, seller, { status: 'ACTIVE' });
      await assignTestRole(trx, seller, fromBin(cteRole.id), admin, {
        scopeType: 'ZONE',
        scopeZoneId: zoneId,
      });
      outcomeId = freshUuid();
      await trx
        .insertInto('catalog_reason_codes')
        .values({
          id: toBin(outcomeId),
          category: 'VISIT_OUTCOME',
          code: `TEST_${outcomeId.replace(/-/g, '').slice(-12).toUpperCase()}`,
          label: 'Intéressé',
          created_by: toBin(admin),
        })
        .execute();
    });
    device = new VirtualDevice(
      services,
      { authenticatedUserId: seller, authenticatedDeviceId: deviceId },
      clock,
    );

    // La veille, en ligne : un client déjà en portefeuille, géolocalisé.
    existingCustomer = freshUuid();
    const previous = await device.push([
      envelope(
        'crm.customer.create',
        'CUSTOMER',
        existingCustomer,
        `${shiftBusinessDay(DAY, -1)}T15:00:00.000Z`,
        {
          displayName: 'Épicerie du Carrefour',
          zoneId,
          sourceCode: 'PROSPECTION_TERRAIN',
          phonePrimary: `6${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
          position: { ...CENTER, accuracyM: 10 },
        },
      ),
    ]);
    expect(previous.results[0]!.status).toBe('APPLIED');

    // La journée, entièrement hors ligne : la file d'attente de l'appareil.
    const createProspect = envelope('crm.customer.create', 'CUSTOMER', prospectId, at('08:10:00'), {
      displayName: 'Restaurant Chez Mama',
      zoneId,
      sourceCode: 'PROSPECTION_TERRAIN',
      phonePrimary: `6${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      position: { ...north(120), accuracyM: 15 },
    });
    queue = [
      envelope('fieldwork.checkin.record', 'GEO_CHECKIN', freshUuid(), at('07:00:00'), {
        checkinType: 'START_SERVICE',
        declaredZoneId: zoneId,
        position: north(180),
        accuracyM: 25,
        clientResult: 'ACCEPTED',
        sessionId,
      }),
      createProspect,
      envelope(
        'crm.visit.record',
        'VISIT',
        nearVisitId,
        at('08:15:00'),
        {
          customerId: prospectId,
          position: { ...north(125), accuracyM: 12 },
          outcomeReasonCodeId: outcomeId,
          nextActionAt: NEXT_ACTION,
          nextActionNote: 'Rappeler pour la commande de poulets',
        },
        [createProspect.command_id],
      ),
      envelope('crm.interaction.record', 'INTERACTION', freshUuid(), at('10:00:00'), {
        customerId: existingCustomer,
        channel: 'APPEL',
        summary: 'Confirmation du passage de 11 h',
      }),
      envelope('crm.visit.record', 'VISIT', farVisitId, at('11:00:00'), {
        customerId: existingCustomer,
        position: { ...north(800), accuracyM: 20 },
        outcomeReasonCodeId: outcomeId,
      }),
      envelope('fieldwork.checkin.record', 'GEO_CHECKIN', freshUuid(), at('16:30:00'), {
        checkinType: 'END_SERVICE',
        declaredZoneId: zoneId,
        position: north(150),
        accuracyM: 30,
        clientResult: 'ACCEPTED',
        sessionId,
      }),
    ];
    clock.setTo(new Date(at('17:00:00'))); // retour de réseau en fin de journée
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('la file de la journée est appliquée dans l’ordre, et son rejeu est idempotent', async () => {
    const first = await device.pushUntilSettled(queue);
    expect(first.results.map((r) => r.status)).toEqual(queue.map(() => 'APPLIED'));
    const replay = await device.pushUntilSettled(queue); // réponse perdue : même lot renvoyé
    expect(replay.results.map((r) => r.status)).toEqual(queue.map(() => 'APPLIED'));
    const visits = await db
      .selectFrom('crm_visits')
      .select('id')
      .where('user_id', '=', toBin(seller))
      .execute();
    expect(visits).toHaveLength(2); // aucun doublon après le rejeu
  });

  it('le serveur rattache les visites à la session et signale la visite lointaine', async () => {
    const near = await db
      .selectFrom('crm_visits')
      .selectAll()
      .where('id', '=', toBin(nearVisitId))
      .executeTakeFirstOrThrow();
    expect(fromBin(near.work_session_id!)).toBe(sessionId);
    expect(near.flags).toEqual([]);
    expect(Number(near.distance_to_customer_m)).toBeLessThan(20);
    const far = await db
      .selectFrom('crm_visits')
      .selectAll()
      .where('id', '=', toBin(farVisitId))
      .executeTakeFirstOrThrow();
    expect(fromBin(far.work_session_id!)).toBe(sessionId);
    expect(far.flags).toEqual(['FAR_FROM_CUSTOMER']);
    const session = await db
      .selectFrom('fieldwork_work_sessions')
      .select(['status', 'close_cause', 'ended_at'])
      .where('id', '=', toBin(sessionId))
      .executeTakeFirstOrThrow();
    expect(session).toMatchObject({ status: 'CLOSED', close_cause: 'END_SERVICE' });
    expect(session.ended_at?.toISOString()).toBe(at('16:30:00'));
  });

  it('les jeux téléchargés redonnent l’état du serveur (customers, crm_activity, fieldwork)', async () => {
    for (const dataset of ['customers', 'crm_activity', 'fieldwork']) {
      await device.pullAll(dataset, clock.now());
    }
    const local = device.localProjection;
    expect(local.get(`customers:CUSTOMER:${prospectId}`)).toMatchObject({
      display_name: 'Restaurant Chez Mama',
      stage: 'PROSPECT',
      owner_user_id: seller,
      acquired_by_user_id: seller,
    });
    expect(local.get(`crm_activity:VISIT:${nearVisitId}`)).toMatchObject({
      work_session_id: sessionId,
      next_action_at: NEXT_ACTION,
    });
    expect(local.get(`crm_activity:VISIT:${farVisitId}`)).toMatchObject({
      flags: ['FAR_FROM_CUSTOMER'],
    });
    expect(local.get(`fieldwork:WORK_SESSION:${sessionId}`)).toMatchObject({
      status: 'CLOSED',
      override_status: 'NOT_REQUIRED',
    });
  });

  it('AT-015 : l’effort commercial de la journée égale les opérations synchronisées', async () => {
    const effort = await commercialEffort(db, {
      userId: seller,
      fromUtc: businessDayStartUtc(DAY), // 00:00 à Douala
      toUtc: businessDayEndUtc(DAY),
    });
    expect(effort).toEqual({
      prospectsCreated: 1,
      visits: 2,
      customersVisited: 2,
      prospectsVisited: 2,
      interactions: 1,
      newCustomers: 0,
    });
  });
});
