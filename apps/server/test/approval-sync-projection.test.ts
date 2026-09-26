/**
 * Projection `/sync/pull` des demandes de validation (AV-094, P2). Dictionnaire
 * `approvals.approval_requests` : « Offline DL (celles de l'utilisateur) » — une demande (résumé
 * d'une perte, d'un écart…) ne parvient qu'à l'appareil de son demandeur, dans le jeu `comms`,
 * jamais aux autres utilisateurs, ni par le repli générique `GLOBAL` des commandes
 * `approvals.request.*` (jeu `approval_request`), ni avec son montant (RC-05).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';
import type { Change } from '@gic/contracts';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { requestApproval } from '../src/modules/approvals/application/public/index.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestRole,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const OCCURRED_AT = '2026-10-05T09:00:00.000Z';

describe('projection des demandes de validation (AV-094)', () => {
  let clock: Clock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let pullService: SyncPullService;
  let cursor0: number;
  let requester: string;
  let other: string;
  let approver: string;
  let device: string;
  let siteId: string;
  let requestId: string;

  async function pull(userId: string, dataset: string): Promise<readonly Change[]> {
    const response = await pullService.pull(
      { dataset, cursor: cursor0, limit: 500 },
      { authenticatedUserId: userId, authenticatedDeviceId: device, now: clock.now() },
    );
    return response.changes.filter((c) => c.entity_id === requestId);
  }

  beforeAll(async () => {
    clock = new FixedClock(new Date(OCCURRED_AT));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    registerPolicyCommands(registry);
    registerRequestCommands(registry, new ApprovalDecisionHandlerRegistry());
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);
    pullService = new SyncPullService(db);

    await db.transaction().execute(async (trx) => {
      requester = await insertTestUser(trx);
      other = await insertTestUser(trx);
      approver = await insertTestUser(trx);
      device = await insertTestDevice(trx, requester, { status: 'ACTIVE' });
      const zoneId = await insertTestZone(trx, requester);
      siteId = await insertTestSite(trx, requester, zoneId);

      const adminRole = await insertTestRole(trx, requester);
      await grantTestPermission(trx, adminRole, 'approvals.policy.manage', requester);
      await assignTestRole(trx, requester, adminRole, requester);

      const approverRole = await insertTestRole(trx, approver, { allowedScopeTypes: ['SITE'] });
      await grantTestPermission(trx, approverRole, 'approvals.request.read', approver);
      await grantTestPermission(
        trx,
        approverRole,
        'inventory.transfer_discrepancy.approve',
        approver,
        {
          maxScope: 'SITE',
        },
      );
      await assignTestRole(trx, approver, approverRole, approver, {
        scopeType: 'SITE',
        scopeSiteId: siteId,
      });
    });

    // Politique réelle (clé étrangère de la demande) ; même permission d'approbateur que les
    // autres politiques TRANSFER_DISCREPANCY de la base de test partagée.
    const policyId = freshUuid();
    const policy = await pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: 1,
        command_version: 1,
        command_type: 'approvals.policy.set',
        aggregate_type: 'CONTROL_POLICY',
        aggregate_id: policyId,
        author_user_id: requester,
        base_version: null,
        depends_on: [],
        occurred_at: OCCURRED_AT,
        client_created_at: OCCURRED_AT,
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload: {
          code: `TRF_DISCREPANCY_${policyId.slice(-8)}`,
          operationType: 'TRANSFER_DISCREPANCY',
          requiresApproval: true,
          approverPermission: 'inventory.transfer_discrepancy.approve',
          approverScope: 'SITE',
        },
      },
      { authenticatedUserId: requester, authenticatedDeviceId: device, transport: 'ONLINE_API' },
    );
    expect(policy.status).toBe('APPLIED');

    const maxSeq = await db
      .selectFrom('sync_change_feed')
      .select(({ fn }) => fn.max('seq').as('seq'))
      .executeTakeFirst();
    cursor0 = Number(maxSeq?.seq ?? 0);

    requestId = freshUuid();
    await db.transaction().execute((trx) =>
      requestApproval(trx, {
        requestId,
        operationType: 'TRANSFER_DISCREPANCY',
        subjectType: 'STOCK_TRANSFER',
        subjectId: freshUuid(),
        subjectSummary: 'Écart de réception confidentiel',
        siteId,
        amountXaf: 12_000,
        requestedBy: requester,
        requestedAt: new Date(OCCURRED_AT),
        policyId,
        policyVersion: 1,
      }),
    );
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('en attente : servie au seul demandeur (jeu comms, portée USER), sans montant', async () => {
    const mine = await pull(requester, 'comms');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.scope_type).toBe('USER');
    expect(mine[0]!.data!.status).toBe('PENDING');
    expect(mine[0]!.data!.subject_summary).toBe('Écart de réception confidentiel');
    expect(mine[0]!.data).not.toHaveProperty('amount_xaf');

    expect(await pull(other, 'comms')).toHaveLength(0);
  });

  it('décidée : le demandeur reçoit la décision ; le repli GLOBAL ne sert rien à personne', async () => {
    const decision = await pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: 1,
        command_version: 1,
        command_type: 'approvals.request.reject',
        aggregate_type: 'APPROVAL_REQUEST',
        aggregate_id: requestId,
        author_user_id: approver,
        base_version: null,
        depends_on: [],
        occurred_at: OCCURRED_AT,
        client_created_at: OCCURRED_AT,
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload: { requestId, comment: 'Justification insuffisante.' },
      },
      { authenticatedUserId: approver, authenticatedDeviceId: device, transport: 'ONLINE_API' },
    );
    expect(decision.status, JSON.stringify(decision)).toBe('APPLIED');

    const mine = await pull(requester, 'comms');
    expect(mine[mine.length - 1]!.data!.status).toBe('REJECTED');
    expect(mine[mine.length - 1]!.data!.decision_comment).toBe('Justification insuffisante.');

    // Ligne générique écrite par le pipeline (jeu `approval_request`, GLOBAL) : présente dans le
    // flux, mais la projection la refuse — y compris au demandeur lui-même.
    expect(await pull(other, 'approval_request')).toHaveLength(0);
    expect(await pull(requester, 'approval_request')).toHaveLength(0);
    expect(await pull(other, 'comms')).toHaveLength(0);
  });
});
