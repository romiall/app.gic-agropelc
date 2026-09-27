/**
 * Projections `/sync/pull` du CRM et du pointage (P3-07) : jeux `customers`, `crm_activity`
 * (01-architecture-offline.md §3.1, filtres `USER`, `TEAM`, `SITE`) et `fieldwork` (sessions de
 * l'agent), alimentés par `crm` et `fieldwork` via `platform/sync/change-feed.ts`. Données
 * écrites par le vrai pipeline avec les rôles réels du seed ; téléchargement par le vrai
 * `SyncPullService`.
 *
 * Démontre : un commercial reçoit son portefeuille, le responsable celui de son équipe, le
 * vendeur les clients de son PDV, et personne d'autre ; `SCOPE_EXIT` vers l'ancien titulaire à la
 * réaffectation (§5.3) ; une visite parvient à son auteur, au titulaire du compte (ancien
 * titulaire hors ligne, D02 §12) et à l'équipe ; les objectifs à leur cible ; les décisions du
 * serveur sur une session (dérogation rejetée, clôture) reviennent à l'agent ; le repli générique
 * `GLOBAL` du pipeline ne sert jamais une donnée CRM.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import type { Change } from '@gic/contracts';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerCheckinCommands } from '../src/modules/fieldwork/application/commands/checkin-commands.js';
import { SessionRejectedListenerRegistry } from '../src/modules/fieldwork/application/public/index.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerCustomerCommands } from '../src/modules/crm/application/commands/customer-commands.js';
import { registerActivityCommands } from '../src/modules/crm/application/commands/activity-commands.js';
import { registerTargetCommands } from '../src/modules/crm/application/commands/target-commands.js';
import { flagVisitsOfRejectedSession } from '../src/modules/crm/application/reactions/session-rejection.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestRole,
  insertTestSite,
  insertTestTeam,
  insertTestTeamMembership,
  insertTestUser,
  insertTestZone,
  monthEndOf,
  recentBusinessDay,
} from './helpers.js';

// Jour récent (heure réelle) : la fenêtre de 90 jours du jeu `crm_activity` est évaluée par la base.
const DAY = recentBusinessDay(2);
const NOW = `${DAY}T18:00:00.000Z`;
const at = (hhmmss: string) => `${DAY}T${hhmmss}.000Z`;
const MONTH_START = `${DAY.slice(0, 7)}-01`;
const CENTER = { lat: 4.0511, lng: 9.7679 };
const north = (meters: number) => ({ lat: CENTER.lat + meters / 111_195, lng: CENTER.lng });
let deviceSeq = 0;

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

describe('projections /sync/pull du CRM et du pointage (P3-07)', () => {
  let clock: FixedClock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let pullService: SyncPullService;
  let cursor0: number;
  let admin: Actor;
  let approver: Actor;
  let cte1: Actor;
  let cte2: Actor;
  let outsider: Actor;
  let rco: Actor;
  let ven: Actor;
  let zoneId: string;
  let siteId: string;
  let outcomeId: string;

  async function run(
    actor: Actor,
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
    options: { readonly offline?: boolean } = {},
  ): Promise<void> {
    const result = await pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++deviceSeq,
        command_version: 1,
        command_type: commandType,
        aggregate_type: aggregateType,
        aggregate_id: aggregateId,
        author_user_id: actor.userId,
        base_version: null,
        depends_on: [],
        occurred_at: occurredAt,
        client_created_at: occurredAt,
        captured_offline: options.offline ?? false,
        backdated_reason: null,
        attachment_ids: [],
        payload,
      },
      {
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        transport: options.offline ? 'SYNC_PUSH' : 'ONLINE_API',
      },
    );
    expect(result.status, JSON.stringify(result)).toMatch(/^APPLIED/);
  }

  async function pull(actor: Actor, dataset: string): Promise<readonly Change[]> {
    const response = await pullService.pull(
      { dataset, cursor: cursor0, limit: 2000 },
      {
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        now: clock.now(),
      },
    );
    return response.changes;
  }

  /** Dernier état reçu pour une entité (l'appareil applique les changements dans l'ordre). */
  function latest(changes: readonly Change[], entityType: string, entityId: string) {
    const matching = changes.filter(
      (c) => c.entity_type === entityType && c.entity_id === entityId,
    );
    return matching[matching.length - 1];
  }

  async function createCustomer(actor: Actor, occurredAt: string): Promise<string> {
    const id = freshUuid();
    await run(actor, 'crm.customer.create', 'CUSTOMER', id, occurredAt, {
      displayName: 'Compte synchronisé',
      zoneId,
      sourceCode: 'PROSPECTION_TERRAIN',
      phonePrimary: `6${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      position: { ...CENTER, accuracyM: 10 },
    });
    return id;
  }

  async function roleId(code: string): Promise<string> {
    const row = await db
      .selectFrom('identity_roles')
      .select('id')
      .where('code', '=', code)
      .executeTakeFirstOrThrow();
    return fromBin(row.id);
  }

  beforeAll(async () => {
    clock = new FixedClock(new Date(NOW));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    const decisions = new ApprovalDecisionHandlerRegistry();
    const listeners = new SessionRejectedListenerRegistry();
    listeners.register(flagVisitsOfRejectedSession);
    registerCheckinCommands(registry, decisions, listeners, idGenerator, clock);
    registerPolicyCommands(registry);
    registerRequestCommands(registry, decisions);
    registerCustomerCommands(registry, idGenerator);
    registerActivityCommands(registry);
    registerTargetCommands(registry);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);
    pullService = new SyncPullService(db);

    const roles = {
      cte: await roleId('COMMERCIAL_TERRAIN'),
      rco: await roleId('RESP_COMMERCIAL'),
      ven: await roleId('VENDEUR_PDV'),
    };
    await db.transaction().execute(async (trx) => {
      const adminId = await insertTestUser(trx);
      admin = { userId: adminId, deviceId: await insertTestDevice(trx, adminId) };
      const adminRole = await insertTestRole(trx, adminId);
      await grantTestPermission(trx, adminRole, 'approvals.policy.manage', adminId);
      await assignTestRole(trx, adminId, adminRole, adminId);
      const approverId = await insertTestUser(trx);
      approver = { userId: approverId, deviceId: await insertTestDevice(trx, approverId) };
      const approverRole = await insertTestRole(trx, adminId);
      await grantTestPermission(trx, approverRole, 'approvals.request.read', adminId);
      await grantTestPermission(trx, approverRole, 'fieldwork.checkin_override.approve', adminId);
      await assignTestRole(trx, approverId, approverRole, adminId);

      zoneId = await insertTestZone(trx, adminId);
      await trx
        .updateTable('organization_zones')
        .set({
          geofence_lat: String(CENTER.lat),
          geofence_lng: String(CENTER.lng),
          geofence_radius_m: '500',
        })
        .where('id', '=', toBin(zoneId))
        .execute();
      siteId = await insertTestSite(trx, adminId, zoneId);
      const actor = async (
        role: string,
        options: Parameters<typeof assignTestRole>[4] = {},
      ): Promise<Actor> => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, adminId, options);
        return { userId, deviceId };
      };
      cte1 = await actor(roles.cte, { scopeType: 'ZONE', scopeZoneId: zoneId });
      cte2 = await actor(roles.cte, { scopeType: 'ZONE', scopeZoneId: zoneId });
      outsider = await actor(roles.cte, { scopeType: 'ZONE', scopeZoneId: zoneId });
      const rcoId = await insertTestUser(trx);
      const team = await insertTestTeam(trx, rcoId, adminId);
      await insertTestTeamMembership(trx, team, cte1.userId, adminId);
      await insertTestTeamMembership(trx, team, cte2.userId, adminId);
      await assignTestRole(trx, rcoId, roles.rco, adminId, {
        scopeType: 'TEAM',
        scopeTeamId: team,
      });
      rco = { userId: rcoId, deviceId: await insertTestDevice(trx, rcoId) };
      ven = await actor(roles.ven, { scopeType: 'SITE', scopeSiteId: siteId });

      outcomeId = freshUuid();
      await trx
        .insertInto('catalog_reason_codes')
        .values({
          id: toBin(outcomeId),
          category: 'VISIT_OUTCOME',
          code: `TEST_${outcomeId.replace(/-/g, '').slice(-12).toUpperCase()}`,
          label: 'Intéressé',
          created_by: toBin(adminId),
        })
        .execute();
    });
    const policyId = freshUuid();
    await run(admin, 'approvals.policy.set', 'CONTROL_POLICY', policyId, at('00:00:00'), {
      code: `CHECKIN_OVERRIDE_${policyId.slice(-8)}`,
      operationType: 'CHECKIN_OVERRIDE',
      requiresApproval: true,
      approverPermission: 'fieldwork.checkin_override.approve',
      approverScope: 'TEAM',
    });

    const maxSeq = await db
      .selectFrom('sync_change_feed')
      .select((eb) => eb.fn.max('seq').as('seq'))
      .executeTakeFirst();
    cursor0 = Number(maxSeq?.seq ?? 0);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('customers : portefeuille du commercial, de l’équipe pour le responsable, clients du PDV', async () => {
    const own = await createCustomer(cte1, at('07:00:00'));
    const counter = freshUuid();
    await run(ven, 'crm.customer.create', 'CUSTOMER', counter, at('07:05:00'), {
      displayName: 'Client comptoir',
      zoneId,
      sourceCode: 'VISITE_SPONTANEE',
      phonePrimary: `6${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
    });

    const forOwner = latest(await pull(cte1, 'customers'), 'CUSTOMER', own);
    expect(forOwner).toMatchObject({ change_type: 'UPSERT', scope_type: 'USER' });
    expect(forOwner?.data).toMatchObject({ id: own, owner_user_id: cte1.userId, version: 1 });
    expect(latest(await pull(rco, 'customers'), 'CUSTOMER', own)?.scope_type).toBe('TEAM');
    expect(latest(await pull(cte2, 'customers'), 'CUSTOMER', own)).toBeUndefined();
    expect(latest(await pull(ven, 'customers'), 'CUSTOMER', own)).toBeUndefined();
    const forPos = latest(await pull(ven, 'customers'), 'CUSTOMER', counter);
    expect(forPos).toMatchObject({ change_type: 'UPSERT', scope_type: 'SITE' });
    expect(latest(await pull(cte1, 'customers'), 'CUSTOMER', counter)).toBeUndefined();
    // Repli générique GLOBAL du pipeline (jeu `customer`) : jamais servi.
    expect((await pull(outsider, 'customer')).filter((c) => c.entity_type === 'CUSTOMER')).toEqual(
      [],
    );
  });

  it('§5.3 : réaffectation — SCOPE_EXIT vers l’ancien titulaire, UPSERT vers le nouveau, équipe inchangée', async () => {
    const customerId = await createCustomer(cte1, at('07:10:00'));
    await run(rco, 'crm.customer.reassign', 'CUSTOMER', customerId, at('12:00:00'), {
      newOwnerUserId: cte2.userId,
      reason: 'Changement de tournée',
    });
    const exit = latest(await pull(cte1, 'customers'), 'CUSTOMER', customerId);
    expect(exit).toMatchObject({
      change_type: 'SCOPE_EXIT',
      scope_type: 'USER',
      scope_id: cte1.userId,
    });
    const arrival = latest(await pull(cte2, 'customers'), 'CUSTOMER', customerId);
    expect(arrival?.data).toMatchObject({ owner_user_id: cte2.userId });
    // Même équipe : le responsable garde le compte, sans sortie de périmètre.
    const team = (await pull(rco, 'customers')).filter((c) => c.entity_id === customerId);
    expect(team.some((c) => c.change_type === 'SCOPE_EXIT')).toBe(false);
    expect(team[team.length - 1]?.data).toMatchObject({ owner_user_id: cte2.userId });
  });

  it('crm_activity : visite vers l’auteur, le titulaire (ancien titulaire hors ligne) et l’équipe ; objectifs vers leur cible', async () => {
    const customerId = await createCustomer(cte1, at('07:20:00'));
    await run(rco, 'crm.customer.reassign', 'CUSTOMER', customerId, at('12:00:00'), {
      newOwnerUserId: cte2.userId,
      reason: 'Congé',
    });
    // L'ancien titulaire, resté hors ligne, visite après la réaffectation (D02 §12).
    const visitId = freshUuid();
    await run(
      cte1,
      'crm.visit.record',
      'VISIT',
      visitId,
      at('13:00:00'),
      { customerId, position: { ...CENTER, accuracyM: 9 }, outcomeReasonCodeId: outcomeId },
      { offline: true },
    );
    expect(latest(await pull(cte1, 'crm_activity'), 'VISIT', visitId)?.data).toMatchObject({
      id: visitId,
      user_id: cte1.userId,
    });
    expect(latest(await pull(cte2, 'crm_activity'), 'VISIT', visitId)).toBeDefined(); // nouveau titulaire informé
    expect(latest(await pull(rco, 'crm_activity'), 'VISIT', visitId)?.scope_type).toBe('TEAM');
    expect(latest(await pull(outsider, 'crm_activity'), 'VISIT', visitId)).toBeUndefined();

    const targetId = freshUuid();
    await run(rco, 'crm.target.set', 'SALES_TARGET', targetId, at('08:00:00'), {
      targetType: 'USER',
      userId: cte1.userId,
      metric: 'VISITES',
      periodStart: MONTH_START,
      periodEnd: monthEndOf(DAY),
      targetValue: 30,
    });
    expect(latest(await pull(cte1, 'crm_activity'), 'SALES_TARGET', targetId)?.data).toMatchObject({
      metric: 'VISITES',
      period_start: MONTH_START,
      status: 'ACTIVE',
    });
    expect(latest(await pull(cte2, 'crm_activity'), 'SALES_TARGET', targetId)).toBeUndefined();
  });

  it('fieldwork : les décisions du serveur sur une session reviennent à l’agent ; visites marquées SESSION_REJECTED', async () => {
    for (const time of ['09:00:00', '09:01:00', '09:02:30']) {
      await run(cte2, 'fieldwork.checkin.record', 'GEO_CHECKIN', freshUuid(), at(time), {
        checkinType: 'START_SERVICE',
        declaredZoneId: zoneId,
        position: north(1800),
        accuracyM: 20,
        clientResult: 'REJECTED_OUT_OF_ZONE',
      });
    }
    const sessionId = freshUuid();
    await run(
      cte2,
      'fieldwork.checkin.request_override',
      'WORK_SESSION',
      sessionId,
      at('09:03:00'),
      {
        declaredZoneId: zoneId,
        reason: 'Signal GPS perdu',
      },
    );
    const customerId = await createCustomer(cte2, at('09:10:00'));
    const visitId = freshUuid();
    await run(cte2, 'crm.visit.record', 'VISIT', visitId, at('09:30:00'), {
      customerId,
      position: { ...CENTER, accuracyM: 9 },
      outcomeReasonCodeId: outcomeId,
    });
    const pending = latest(await pull(cte2, 'fieldwork'), 'WORK_SESSION', sessionId);
    expect(pending?.data).toMatchObject({ status: 'OPEN', override_status: 'PENDING' });

    const session = await db
      .selectFrom('fieldwork_work_sessions')
      .select('approval_request_id')
      .where('id', '=', toBin(sessionId))
      .executeTakeFirstOrThrow();
    const requestId = fromBin(session.approval_request_id!);
    await run(approver, 'approvals.request.reject', 'APPROVAL_REQUEST', requestId, at('11:00:00'), {
      requestId,
      comment: 'Présence non attestée.',
    });
    expect(latest(await pull(cte2, 'fieldwork'), 'WORK_SESSION', sessionId)?.data).toMatchObject({
      override_status: 'REJECTED',
    });
    expect(latest(await pull(cte2, 'crm_activity'), 'VISIT', visitId)?.data).toMatchObject({
      flags: ['SESSION_REJECTED'],
    });
    // Le jeu `fieldwork` est personnel : ni le responsable ni un collègue ne le reçoivent.
    expect(latest(await pull(rco, 'fieldwork'), 'WORK_SESSION', sessionId)).toBeUndefined();

    await run(cte2, 'fieldwork.checkin.record', 'GEO_CHECKIN', freshUuid(), at('17:00:00'), {
      checkinType: 'END_SERVICE',
      declaredZoneId: zoneId,
      position: CENTER,
      accuracyM: 15,
      clientResult: 'ACCEPTED',
      sessionId,
    });
    expect(latest(await pull(cte2, 'fieldwork'), 'WORK_SESSION', sessionId)?.data).toMatchObject({
      status: 'CLOSED',
      close_cause: 'END_SERVICE',
    });
  });
});
