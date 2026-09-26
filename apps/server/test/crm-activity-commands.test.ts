/**
 * Visites, interactions et objectifs (P3-05, D02-CRM, SM-VISIT) à travers le vrai pipeline, avec
 * les rôles réels du seed : AT-051 (visite hors ligne à 800 m d'un client géolocalisé, sans
 * session : `far_from_customer` et `out_of_session`, non modifiable, correction par annulation),
 * rattachement à la session de travail (BR-CRM-013), indicateur `SESSION_REJECTED` au rejet
 * d'une dérogation (SM-WORK-SESSION), portée et ancien titulaire hors ligne (D02 §12), compte
 * fusionné, annulations (BR-CRM-016), interactions (BR-CRM-017), objectifs (BR-CRM-018).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
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
import { formatDateColumn } from '../src/modules/crm/application/commands/shared.js';
import { flagVisitsOfRejectedSession } from '../src/modules/crm/application/reactions/session-rejection.js';
import { fromBin, fromBinOrNull, toBin } from '../src/platform/kysely/uuid-columns.js';
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
} from './helpers.js';

const NOW = '2026-10-06T18:00:00.000Z';
const at = (hhmmss: string) => `2026-10-06T${hhmmss}.000Z`;
const CENTER = { lat: 4.0511, lng: 9.7679 };
/** Point à `meters` au nord du centre (1° de latitude ≈ 111 195 m). */
const north = (meters: number) => ({ lat: CENTER.lat + meters / 111_195, lng: CENTER.lng });
let deviceSeq = 0;

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

describe('crm.visit.*, crm.interaction.*, crm.target.* (P3-05)', () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let admin: Actor;
  let approver: Actor;
  let cte1: Actor;
  let cte2: Actor;
  let outsider: Actor;
  let rco: Actor;
  let dir: Actor;
  let zoneId: string;
  let siteId: string;
  let teamId: string;
  let outcomeId: string;
  let lostReasonId: string;
  let cancelReasonId: string;

  type Result = Awaited<ReturnType<CommandPipelineService['handle']>>;
  const code = (r: Result) => (r.status === 'REJECTED' ? r.error.code : r.status);

  async function run(
    actor: Actor,
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
    options: { readonly offline?: boolean } = {},
  ): Promise<Result> {
    return pipeline.handle(
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
  }

  async function createCustomer(actor: Actor, occurredAt = at('07:30:00')): Promise<string> {
    const id = freshUuid();
    const result = await run(actor, 'crm.customer.create', 'CUSTOMER', id, occurredAt, {
      displayName: 'Dépôt de test',
      zoneId,
      sourceCode: 'PROSPECTION_TERRAIN',
      phonePrimary: `6${Math.floor(10_000_000 + Math.random() * 89_999_999)}`,
      position: { ...CENTER, accuracyM: 10 },
    });
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    return id;
  }

  function visit(
    actor: Actor,
    customerId: string,
    occurredAt: string,
    options: {
      readonly position?: { lat: number; lng: number } | null;
      readonly offline?: boolean;
      readonly outcome?: string;
    } = {},
  ) {
    const id = freshUuid();
    const result = run(
      actor,
      'crm.visit.record',
      'VISIT',
      id,
      occurredAt,
      {
        customerId,
        position: options.position === undefined ? { ...CENTER, accuracyM: 15 } : options.position,
        outcomeReasonCodeId: options.outcome ?? outcomeId,
        notes: 'Présentation des prix du mois',
        nextActionAt: '2026-10-09',
      },
      { offline: options.offline ?? false },
    );
    return { id, result };
  }

  async function visitRow(id: string) {
    return db
      .selectFrom('crm_visits')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
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
    const clock = new FixedClock(new Date(NOW));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    const decisions = new ApprovalDecisionHandlerRegistry();
    const listeners = new SessionRejectedListenerRegistry();
    listeners.register(flagVisitsOfRejectedSession); // réaction de crm, comme CrmSessionRejectionRegistrar
    registerCheckinCommands(registry, decisions, listeners, idGenerator, clock);
    registerPolicyCommands(registry);
    registerRequestCommands(registry, decisions);
    registerCustomerCommands(registry, idGenerator);
    registerActivityCommands(registry);
    registerTargetCommands(registry);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    const roles = {
      cte: await roleId('COMMERCIAL_TERRAIN'),
      rco: await roleId('RESP_COMMERCIAL'),
      dir: await roleId('DIRECTION'),
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
      teamId = await insertTestTeam(trx, rcoId, adminId);
      await insertTestTeamMembership(trx, teamId, cte1.userId, adminId);
      await insertTestTeamMembership(trx, teamId, cte2.userId, adminId);
      await assignTestRole(trx, rcoId, roles.rco, adminId, {
        scopeType: 'TEAM',
        scopeTeamId: teamId,
      });
      rco = { userId: rcoId, deviceId: await insertTestDevice(trx, rcoId) };
      dir = await actor(roles.dir);

      outcomeId = freshUuid();
      lostReasonId = freshUuid();
      cancelReasonId = freshUuid();
      for (const [id, category] of [
        [outcomeId, 'VISIT_OUTCOME'],
        [lostReasonId, 'PROSPECT_LOST'],
        [cancelReasonId, 'CANCELLATION'],
      ] as const) {
        await trx
          .insertInto('catalog_reason_codes')
          .values({
            id: toBin(id),
            category,
            code: `TEST_${id.replace(/-/g, '').slice(-12).toUpperCase()}`,
            label: 'Motif de test',
            created_by: toBin(adminId),
          })
          .execute();
      }
    });

    // Politique CHECKIN_OVERRIDE (AV-021), nécessaire au scénario de dérogation rejetée.
    const policyId = freshUuid();
    const policy = await run(
      admin,
      'approvals.policy.set',
      'CONTROL_POLICY',
      policyId,
      at('00:00:00'),
      {
        code: `CHECKIN_OVERRIDE_${policyId.slice(-8)}`,
        operationType: 'CHECKIN_OVERRIDE',
        requiresApproval: true,
        approverPermission: 'fieldwork.checkin_override.approve',
        approverScope: 'TEAM',
      },
    );
    expect(policy.status).toBe('APPLIED');
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('AT-051 : visite hors ligne à 800 m, sans session — indicateurs, non modifiable, correction par annulation', async () => {
    const customerId = await createCustomer(cte1);
    const first = visit(cte1, customerId, at('08:15:00'), { position: north(800), offline: true });
    expect((await first.result).status).toBe('APPLIED');
    const row = await visitRow(first.id);
    expect(row.flags).toEqual(['OUT_OF_SESSION', 'FAR_FROM_CUSTOMER']);
    expect(Number(row.distance_to_customer_m)).toBeCloseTo(800, 0);
    expect(row.work_session_id).toBeNull();
    expect(row.customer_stage_at_visit).toBe('PROSPECT');
    expect(formatDateColumn(row.next_action_at)).toBe('2026-10-09');

    // BR-CRM-016 : non modifiable après synchronisation (déclencheur) ...
    await expect(
      db.updateTable('crm_visits').set({ notes: 'retouche' }).where('id', '=', row.id).execute(),
    ).rejects.toThrow(/non modifiable/);
    // ... la correction passe par l'annulation motivée et une nouvelle visite.
    const cancel = await run(cte1, 'crm.visit.cancel', 'VISIT', first.id, at('09:00:00'), {
      reasonCodeId: cancelReasonId,
      comment: 'Mauvais client sélectionné',
    });
    expect(cancel.status, JSON.stringify(cancel)).toBe('APPLIED');
    const cancelled = await visitRow(first.id);
    expect(cancelled.status).toBe('CANCELLED');
    expect(fromBinOrNull(cancelled.cancelled_by)).toBe(cte1.userId);
    expect(cancelled.open_next_action_at).toBeNull(); // sort des prochaines actions ouvertes
    expect((await visit(cte1, customerId, at('09:05:00'), { offline: true }).result).status).toBe(
      'APPLIED',
    );
  });

  it('BR-CRM-013 : visite rattachée à la session de travail couvrant son heure', async () => {
    const customerId = await createCustomer(cte1);
    const sessionId = freshUuid();
    const checkin = await run(
      cte1,
      'fieldwork.checkin.record',
      'GEO_CHECKIN',
      freshUuid(),
      at('07:00:00'),
      {
        checkinType: 'START_SERVICE',
        declaredZoneId: zoneId,
        position: north(100),
        accuracyM: 20,
        clientResult: 'ACCEPTED',
        sessionId,
      },
    );
    expect(checkin.status, JSON.stringify(checkin)).toBe('APPLIED');
    const during = visit(cte1, customerId, at('09:00:00'));
    expect((await during.result).status).toBe('APPLIED');
    const row = await visitRow(during.id);
    expect(fromBinOrNull(row.work_session_id)).toBe(sessionId);
    expect(row.flags).toEqual([]);
  });

  it('SM-WORK-SESSION : dérogation rejetée — les visites rattachées reçoivent SESSION_REJECTED', async () => {
    const customerId = await createCustomer(cte2);
    for (const time of ['10:00:00', '10:01:00', '10:02:30']) {
      await run(cte2, 'fieldwork.checkin.record', 'GEO_CHECKIN', freshUuid(), at(time), {
        checkinType: 'START_SERVICE',
        declaredZoneId: zoneId,
        position: north(1800),
        accuracyM: 20,
        clientResult: 'REJECTED_OUT_OF_ZONE',
      });
    }
    const sessionId = freshUuid();
    const override = await run(
      cte2,
      'fieldwork.checkin.request_override',
      'WORK_SESSION',
      sessionId,
      at('10:03:00'),
      {
        declaredZoneId: zoneId,
        reason: 'GPS imprécis sous les tôles du marché',
      },
    );
    expect(override.status, JSON.stringify(override)).toBe('APPLIED');
    const pending = visit(cte2, customerId, at('10:30:00'));
    expect((await pending.result).status).toBe('APPLIED');
    expect((await visitRow(pending.id)).flags).toEqual([]); // dérogation en attente : signalée plus tard si rejetée

    const session = await db
      .selectFrom('fieldwork_work_sessions')
      .select('approval_request_id')
      .where('id', '=', toBin(sessionId))
      .executeTakeFirstOrThrow();
    const requestId = fromBin(session.approval_request_id!);
    const rejection = await run(
      approver,
      'approvals.request.reject',
      'APPROVAL_REQUEST',
      requestId,
      at('12:00:00'),
      {
        requestId,
        comment: 'Aucune preuve de présence dans la zone.',
      },
    );
    expect(rejection.status, JSON.stringify(rejection)).toBe('APPLIED');
    expect((await visitRow(pending.id)).flags).toEqual(['SESSION_REJECTED']);
    const after = visit(cte2, customerId, at('12:30:00'));
    expect((await after.result).status).toBe('APPLIED');
    expect((await visitRow(after.id)).flags).toEqual(['SESSION_REJECTED']);
  });

  it('portée : compte d’un collègue refusé ; ancien titulaire hors ligne accepté après réaffectation (D02 §12)', async () => {
    const customerId = await createCustomer(cte1, at('07:00:00'));
    expect(code(await visit(cte2, customerId, at('09:00:00')).result)).toBe('FORBIDDEN_SCOPE');
    const reassign = await run(
      rco,
      'crm.customer.reassign',
      'CUSTOMER',
      customerId,
      at('12:00:00'),
      {
        newOwnerUserId: cte2.userId,
        reason: 'Changement de secteur',
      },
    );
    expect(reassign.status, JSON.stringify(reassign)).toBe('APPLIED');
    // L'ancien titulaire, resté hors ligne, visite après la réaffectation : fait accepté.
    const offline = visit(cte1, customerId, at('13:00:00'), { offline: true });
    expect(code(await offline.result)).toBe('APPLIED');
    // En ligne, le compte n'est plus dans son portefeuille.
    expect(code(await visit(cte1, customerId, at('13:30:00')).result)).toBe('FORBIDDEN_SCOPE');
    expect(code(await visit(cte2, customerId, at('13:30:00')).result)).toBe('APPLIED');
  });

  it('compte fusionné : refusé en ligne, conservé hors ligne sur le compte d’origine', async () => {
    const kept = await createCustomer(cte1, at('07:00:00'));
    const absorbed = await createCustomer(cte1, at('07:10:00'));
    const merge = await run(dir, 'crm.customer.merge', 'CUSTOMER', absorbed, at('11:00:00'), {
      intoCustomerId: kept,
    });
    expect(merge.status, JSON.stringify(merge)).toBe('APPLIED');
    expect(code(await visit(cte1, absorbed, at('12:00:00')).result)).toBe('CUSTOMER_MERGED');
    const offline = visit(cte1, absorbed, at('12:00:00'), { offline: true });
    expect(code(await offline.result)).toBe('APPLIED');
    const row = await visitRow(offline.id);
    expect(fromBin(row.customer_id)).toBe(absorbed);
    expect(row.customer_stage_at_visit).toBe('MERGED');
  });

  it('BR-CRM-012 / SM-VISIT : résultat obligatoire de catégorie VISIT_OUTCOME ; annulations', async () => {
    const customerId = await createCustomer(cte1);
    expect(
      code(await visit(cte1, customerId, at('09:00:00'), { outcome: lostReasonId }).result),
    ).toBe('REFERENCE_INVALID');
    const recorded = visit(cte1, customerId, at('09:10:00'));
    expect(code(await recorded.result)).toBe('APPLIED');
    const cancel = (actor: Actor, payload: Record<string, unknown>) =>
      run(actor, 'crm.visit.cancel', 'VISIT', recorded.id, at('10:00:00'), payload);
    expect(code(await cancel(cte2, { comment: 'Erreur' }))).toBe('FORBIDDEN_SCOPE');
    expect(code(await cancel(cte1, { reasonCodeId: outcomeId, comment: 'Erreur' }))).toBe(
      'REFERENCE_INVALID',
    );
    // Le responsable de l'équipe du visiteur peut annuler (SM-VISIT).
    expect(code(await cancel(rco, { comment: 'Doublon de saisie' }))).toBe('APPLIED');
    expect(fromBinOrNull((await visitRow(recorded.id)).cancelled_by)).toBe(rco.userId);
    expect(code(await cancel(cte1, { comment: 'Encore' }))).toBe('ALREADY_CANCELLED');
  });

  it('BR-CRM-017 : interactions — canal fermé, enregistrement, annulation', async () => {
    const customerId = await createCustomer(cte1);
    const whatsapp = await run(
      cte1,
      'crm.interaction.record',
      'INTERACTION',
      freshUuid(),
      at('09:00:00'),
      {
        customerId,
        channel: 'WHATSAPP',
      },
    );
    expect(code(whatsapp)).toMatch(/^VALIDATION_ERROR/);
    const id = freshUuid();
    const call = await run(
      cte1,
      'crm.interaction.record',
      'INTERACTION',
      id,
      at('09:00:00'),
      {
        customerId,
        channel: 'APPEL',
        summary: 'Relance sur la commande de poussins',
        nextActionAt: '2026-10-12',
      },
      { offline: true },
    );
    expect(call.status, JSON.stringify(call)).toBe('APPLIED');
    const row = await db
      .selectFrom('crm_interactions')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
    expect(row.direction).toBe('SORTANT');
    expect(formatDateColumn(row.next_action_at)).toBe('2026-10-12');
    expect(
      code(
        await run(cte2, 'crm.interaction.record', 'INTERACTION', freshUuid(), at('09:30:00'), {
          customerId,
          channel: 'SMS',
        }),
      ),
    ).toBe('FORBIDDEN_SCOPE');
    expect(
      code(
        await run(cte1, 'crm.interaction.cancel', 'INTERACTION', id, at('10:00:00'), {
          comment: 'Appel non abouti',
        }),
      ),
    ).toBe('APPLIED');
  });

  it('BR-CRM-018 : objectifs — portée du responsable, chevauchement, annulation puis redéfinition', async () => {
    const setTarget = (actor: Actor, targetId: string, payload: Record<string, unknown>) =>
      run(actor, 'crm.target.set', 'SALES_TARGET', targetId, at('08:00:00'), payload);
    const october = {
      metric: 'VISITES',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      targetValue: 40,
    };
    const userTarget = freshUuid();
    expect(
      code(
        await setTarget(rco, userTarget, { targetType: 'USER', userId: cte1.userId, ...october }),
      ),
    ).toBe('APPLIED');
    const stored = await db
      .selectFrom('crm_sales_targets')
      .select(['period_start', 'period_end', 'target_value'])
      .where('id', '=', toBin(userTarget))
      .executeTakeFirstOrThrow();
    expect([formatDateColumn(stored.period_start), formatDateColumn(stored.period_end)]).toEqual([
      '2026-10-01',
      '2026-10-31',
    ]);
    expect(Number(stored.target_value)).toBe(40);
    expect(
      code(
        await setTarget(rco, freshUuid(), {
          targetType: 'USER',
          userId: cte1.userId,
          ...october,
          periodStart: '2026-10-15',
          periodEnd: '2026-11-15',
        }),
      ),
    ).toBe('TARGET_OVERLAP');
    expect(
      code(
        await setTarget(rco, freshUuid(), {
          targetType: 'USER',
          userId: outsider.userId,
          ...october,
        }),
      ),
    ).toBe('FORBIDDEN_SCOPE');
    expect(
      code(await setTarget(rco, freshUuid(), { targetType: 'TEAM', teamId, ...october })),
    ).toBe('APPLIED');
    expect(
      code(await setTarget(rco, freshUuid(), { targetType: 'SITE', siteId, ...october })),
    ).toBe('FORBIDDEN_SCOPE');
    expect(
      code(await setTarget(dir, freshUuid(), { targetType: 'SITE', siteId, ...october })),
    ).toBe('APPLIED');
    expect(
      code(
        await setTarget(cte1, freshUuid(), { targetType: 'USER', userId: cte1.userId, ...october }),
      ),
    ).toBe('FORBIDDEN');
    // Validations : produit requis pour QTE_PRODUIT, montant entier, produit existant.
    expect(
      code(
        await setTarget(rco, freshUuid(), {
          targetType: 'USER',
          userId: cte2.userId,
          ...october,
          metric: 'QTE_PRODUIT',
        }),
      ),
    ).toMatch(/^VALIDATION_ERROR/);
    expect(
      code(
        await setTarget(rco, freshUuid(), {
          targetType: 'USER',
          userId: cte2.userId,
          ...october,
          metric: 'CA',
          targetValue: 1000.5,
        }),
      ),
    ).toMatch(/^VALIDATION_ERROR/);
    expect(
      code(
        await setTarget(rco, freshUuid(), {
          targetType: 'USER',
          userId: cte2.userId,
          ...october,
          metric: 'QTE_PRODUIT',
          productId: freshUuid(),
          targetValue: 12.5,
        }),
      ),
    ).toBe('REFERENCE_INVALID');
    // Un objectif ne se modifie pas : annulation, puis nouvelle définition.
    expect(
      code(await run(rco, 'crm.target.cancel', 'SALES_TARGET', userTarget, at('09:00:00'), {})),
    ).toBe('APPLIED');
    expect(
      code(
        await setTarget(rco, freshUuid(), {
          targetType: 'USER',
          userId: cte1.userId,
          ...october,
          targetValue: 45,
        }),
      ),
    ).toBe('APPLIED');
  });
});
