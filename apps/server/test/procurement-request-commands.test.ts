/**
 * Demandes d'achat (P6-03, D08-APP, SM-PURCHASE-REQUEST) à travers le vrai pipeline, avec les
 * rôles réels du seed (magasinier demandeur en portée SITE, responsable des achats valideur) :
 * soumission (numéro `DA`, montant estimé, validation obligatoire — BR-APP-003), refus
 * (produit non achetable, site hors périmètre, politique absente), décision, retrait, abandon.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands as registerApprovalRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerRequestCommands } from '../src/modules/procurement/application/commands/request-commands.js';
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
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const NOW = '2026-10-06T18:00:00.000Z';
const at = (hhmmss: string) => `2026-10-06T${hhmmss}.000Z`;
let deviceSeq = 0;

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

describe('procurement.request.* (P6-03)', () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let admin: Actor;
  let storekeeper: Actor;
  let otherStorekeeper: Actor;
  let buyer: Actor;
  let siteId: string;
  let otherSiteId: string;
  let productId: string;
  let serviceProductId: string;
  const unitCode = 'SAC';

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

  function submit(
    actor: Actor,
    overrides: Record<string, unknown> = {},
    occurredAt = at('08:00:00'),
  ) {
    const id = freshUuid();
    const result = run(actor, 'procurement.request.submit', 'PURCHASE_REQUEST', id, occurredAt, {
      siteId,
      neededByDate: '2026-10-15',
      justification: 'Aliment pour la bande 12 (démarrage)',
      lines: [
        { productId, quantityBase: 100, unitCode, quantity: 100, estimatedUnitPriceXaf: 15_000 },
        { productId, quantityBase: 2.5, unitCode, quantity: 2.5, estimatedUnitPriceXaf: 333 },
      ],
      ...overrides,
    });
    return { id, result };
  }

  async function requestRow(id: string) {
    return db
      .selectFrom('procurement_purchase_requests')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
  }

  async function approvalOf(requestId: string) {
    const row = await requestRow(requestId);
    return db
      .selectFrom('approvals_approval_requests')
      .selectAll()
      .where('id', '=', row.approval_request_id!)
      .executeTakeFirstOrThrow();
  }

  function decide(
    actor: Actor,
    approvalRequestId: string,
    decision: 'approve' | 'reject',
    occurredAt: string,
  ) {
    return run(
      actor,
      `approvals.request.${decision}`,
      'APPROVAL_REQUEST',
      approvalRequestId,
      occurredAt,
      {
        requestId: approvalRequestId,
        ...(decision === 'reject' ? { comment: 'Budget du mois épuisé.' } : {}),
      },
    );
  }

  /** Retire les politiques PURCHASE_REQUEST actives le temps de `fn`, puis les restaure (base
   * persistante, même précaution qu'inventory-loss-commands.test.ts). */
  async function withoutActivePolicy<T>(fn: () => Promise<T>): Promise<T> {
    const active = await db
      .selectFrom('approvals_control_policies')
      .select('id')
      .where('operation_type', '=', 'PURCHASE_REQUEST')
      .where('status', '=', 'ACTIVE')
      .execute();
    await db
      .updateTable('approvals_control_policies')
      .set({ status: 'RETIRED', valid_to: new Date(at('00:00:00')) })
      .where('operation_type', '=', 'PURCHASE_REQUEST')
      .where('status', '=', 'ACTIVE')
      .execute();
    try {
      return await fn();
    } finally {
      for (const row of active) {
        await db
          .updateTable('approvals_control_policies')
          .set({ status: 'ACTIVE', valid_to: null })
          .where('id', '=', row.id)
          .execute();
      }
    }
  }

  async function roleId(roleCode: string): Promise<string> {
    const row = await db
      .selectFrom('identity_roles')
      .select('id')
      .where('code', '=', roleCode)
      .executeTakeFirstOrThrow();
    return fromBin(row.id);
  }

  beforeAll(async () => {
    const clock = new FixedClock(new Date(NOW));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    const decisions = new ApprovalDecisionHandlerRegistry();
    registerRequestCommands(registry, decisions, idGenerator, new DocumentSequenceService());
    registerPolicyCommands(registry);
    registerApprovalRequestCommands(registry, decisions);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    const roles = { mag: await roleId('MAGASINIER'), ach: await roleId('RESP_ACHATS') };
    await db.transaction().execute(async (trx) => {
      const adminId = await insertTestUser(trx);
      admin = { userId: adminId, deviceId: await insertTestDevice(trx, adminId) };
      const adminRole = await insertTestRole(trx, adminId);
      await grantTestPermission(trx, adminRole, 'approvals.policy.manage', adminId);
      await assignTestRole(trx, adminId, adminRole, adminId);
      const zoneId = await insertTestZone(trx, adminId);
      siteId = await insertTestSite(trx, adminId, zoneId);
      otherSiteId = await insertTestSite(trx, adminId, zoneId);
      const actor = async (role: string, options: Parameters<typeof assignTestRole>[4] = {}) => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, adminId, options);
        return { userId, deviceId };
      };
      storekeeper = await actor(roles.mag, { scopeType: 'SITE', scopeSiteId: siteId });
      otherStorekeeper = await actor(roles.mag, { scopeType: 'SITE', scopeSiteId: otherSiteId });
      buyer = await actor(roles.ach);

      if (
        !(await trx
          .selectFrom('catalog_units')
          .select('code')
          .where('code', '=', unitCode)
          .executeTakeFirst())
      ) {
        await trx
          .insertInto('catalog_units')
          .values({ code: unitCode, name: 'Sac', is_count: 1 })
          .execute();
      }
      const categoryId = freshUuid();
      await trx
        .insertInto('catalog_product_categories')
        .values({
          id: toBin(categoryId),
          code: `CAT-${categoryId.slice(-8)}`,
          name: 'Aliments',
          created_by: toBin(adminId),
        })
        .execute();
      productId = freshUuid();
      serviceProductId = freshUuid();
      for (const [id, purchasable] of [
        [productId, 1],
        [serviceProductId, 0],
      ] as const) {
        await trx
          .insertInto('catalog_products')
          .values({
            id: toBin(id),
            code: `PRD-${id.slice(-8)}`,
            name: 'Aliment démarrage',
            category_id: toBin(categoryId),
            stock_family: 'INTRANT',
            base_unit_code: unitCode,
            is_purchasable: purchasable,
            created_by: toBin(adminId),
          })
          .execute();
      }
    });

    const policyId = freshUuid();
    const policy = await run(
      admin,
      'approvals.policy.set',
      'CONTROL_POLICY',
      policyId,
      at('00:00:00'),
      {
        code: `PURCHASE_REQUEST_${policyId.slice(-8)}`,
        operationType: 'PURCHASE_REQUEST',
        requiresApproval: true,
        approverPermission: 'procurement.request.approve',
        approverScope: 'ALL',
      },
    );
    expect(policy.status).toBe('APPLIED');
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('BR-APP-002 / BR-APP-003 : soumission — numéro DA, montant estimé, lignes, validation demandée', async () => {
    const { id, result } = submit(storekeeper);
    const outcome = await result;
    expect(outcome.status, JSON.stringify(outcome)).toBe('APPLIED');
    const row = await requestRow(id);
    expect(row.status).toBe('SUBMITTED');
    expect(row.doc_number).toMatch(/^DA-.+-2026-\d{6}$/);
    expect(outcome.status === 'APPLIED' && outcome.server_refs?.docNumber).toBe(row.doc_number);
    expect(Number(row.estimated_total_xaf)).toBe(1_500_833); // 1 500 000 + 832,5 → 833
    const lines = await db
      .selectFrom('procurement_purchase_request_lines')
      .select(['quantity_base', 'ordered_qty_base'])
      .where('request_id', '=', toBin(id))
      .execute();
    expect(lines.map((l) => Number(l.quantity_base)).sort((a, b) => a - b)).toEqual([2.5, 100]);
    const approval = await approvalOf(id);
    expect(approval).toMatchObject({ operation_type: 'PURCHASE_REQUEST', status: 'PENDING' });
    expect(fromBin(approval.requested_by)).toBe(storekeeper.userId);
    // Rejeu hors ligne sous un autre command_id : idempotent.
    const replay = await run(
      storekeeper,
      'procurement.request.submit',
      'PURCHASE_REQUEST',
      id,
      at('08:00:00'),
      {
        siteId,
        justification: 'rejeu',
        lines: [{ productId, quantityBase: 1, unitCode, quantity: 1 }],
      },
    );
    expect(replay.status).toBe('APPLIED');
  });

  it('refus : produit non achetable, site hors périmètre, politique de validation absente', async () => {
    expect(
      code(
        await submit(storekeeper, {
          lines: [{ productId: serviceProductId, quantityBase: 1, unitCode, quantity: 1 }],
        }).result,
      ),
    ).toBe('PRODUCT_NOT_PURCHASABLE');
    expect(code(await submit(otherStorekeeper).result)).toBe('FORBIDDEN_SCOPE');
    expect(
      code(
        await submit(storekeeper, {
          lines: [{ productId, quantityBase: 1.2345, unitCode, quantity: 1 }],
        }).result,
      ),
    ).toBe('TOO_MANY_DECIMALS');
    await withoutActivePolicy(async () => {
      expect(code(await submit(storekeeper).result)).toBe('CONTROL_POLICY_MISSING');
    });
  });

  it('SM-PURCHASE-REQUEST : validation par le responsable des achats, rejet motivé', async () => {
    const approved = submit(storekeeper);
    await approved.result;
    const approval = await approvalOf(approved.id);
    expect(code(await decide(buyer, fromBin(approval.id), 'approve', at('09:00:00')))).toBe(
      'APPLIED',
    );
    expect((await requestRow(approved.id)).status).toBe('APPROVED');

    const refused = submit(storekeeper);
    await refused.result;
    const refusal = await approvalOf(refused.id);
    expect(code(await decide(buyer, fromBin(refusal.id), 'reject', at('09:10:00')))).toBe(
      'APPLIED',
    );
    expect((await requestRow(refused.id)).status).toBe('REJECTED');
  });

  it('retrait par le demandeur ; abandon motivé d’une demande approuvée ; clôture réservée au partiellement commandé', async () => {
    const withdrawn = submit(storekeeper);
    await withdrawn.result;
    expect(
      code(
        await run(
          otherStorekeeper,
          'procurement.request.cancel',
          'PURCHASE_REQUEST',
          withdrawn.id,
          at('10:00:00'),
          {},
        ),
      ),
    ).toBe('FORBIDDEN');
    expect(
      code(
        await run(
          storekeeper,
          'procurement.request.cancel',
          'PURCHASE_REQUEST',
          withdrawn.id,
          at('10:00:00'),
          {},
        ),
      ),
    ).toBe('APPLIED');
    expect((await requestRow(withdrawn.id)).status).toBe('CANCELLED');
    expect((await approvalOf(withdrawn.id)).status).toBe('CANCELLED');

    const abandoned = submit(storekeeper);
    await abandoned.result;
    await decide(buyer, fromBin((await approvalOf(abandoned.id)).id), 'approve', at('10:30:00'));
    expect(
      code(
        await run(
          buyer,
          'procurement.request.close',
          'PURCHASE_REQUEST',
          abandoned.id,
          at('10:40:00'),
          { reason: 'x' },
        ),
      ),
    ).toBe('REQUEST_STATUS_INVALID');
    expect(
      code(
        await run(
          buyer,
          'procurement.request.cancel',
          'PURCHASE_REQUEST',
          abandoned.id,
          at('11:00:00'),
          {},
        ),
      ),
    ).toBe('REASON_REQUIRED');
    expect(
      code(
        await run(
          storekeeper,
          'procurement.request.cancel',
          'PURCHASE_REQUEST',
          abandoned.id,
          at('11:00:00'),
          { reason: 'Plus nécessaire' },
        ),
      ),
    ).toBe('FORBIDDEN');
    expect(
      code(
        await run(
          buyer,
          'procurement.request.cancel',
          'PURCHASE_REQUEST',
          abandoned.id,
          at('11:00:00'),
          { reason: 'Besoin couvert par un don' },
        ),
      ),
    ).toBe('APPLIED');
    expect((await requestRow(abandoned.id)).status).toBe('CANCELLED');
  });
});
