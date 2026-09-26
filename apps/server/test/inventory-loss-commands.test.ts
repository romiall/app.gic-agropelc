/**
 * `inventory.loss.*` (P2-04, SM-LOSS) à travers le vrai pipeline de commande. Démontre :
 * politique absente -> RECORDED direct (BR-STK-032) ; politique avec validation ->
 * PENDING_APPROVAL ; retrait par le déclarant avant décision ; les deux issues de rejet
 * (BR-STK-033, AV-038) ; les gardes de validation du payload (CK dictionnaire). Même niveau
 * que inventory-transfer-commands.test.ts (pipeline réel, base MySQL réelle).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerLossCommands } from '../src/modules/inventory/application/commands/loss-commands.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import {
  recordStockMove,
  type RecordMoveDeps,
} from '../src/modules/inventory/application/public/index.js';
import { toBin, fromBin, fromBinOrNull } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestLocation,
  insertTestRole,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const OCCURRED_AT = '2026-09-29T09:00:00.000Z';

function buildEnvelope(
  authorUserId: string,
  overrides: {
    readonly command_type: string;
    readonly aggregate_type: string;
    readonly aggregate_id: string;
    readonly payload: unknown;
    readonly occurred_at?: string;
  },
): Record<string, unknown> {
  const occurredAt = overrides.occurred_at ?? OCCURRED_AT;
  return {
    command_id: freshUuid(),
    device_seq: 1,
    command_version: 1,
    author_user_id: authorUserId,
    base_version: null,
    depends_on: [],
    occurred_at: occurredAt,
    client_created_at: occurredAt,
    captured_offline: false,
    backdated_reason: null,
    attachment_ids: [],
    ...overrides,
  };
}

async function insertProduct(admin: string): Promise<string> {
  const categoryId = freshUuid();
  await db
    .insertInto('catalog_product_categories')
    .values({
      id: toBin(categoryId),
      code: `CAT-${categoryId.slice(-8)}`,
      name: 'Test',
      created_by: toBin(admin),
    })
    .execute();
  const already = await db
    .selectFrom('catalog_units')
    .select('code')
    .where('code', '=', 'TETE')
    .executeTakeFirst();
  if (!already) {
    await db
      .insertInto('catalog_units')
      .values({ code: 'TETE', name: 'Tête', is_count: 1 })
      .execute();
  }
  const productId = freshUuid();
  await db
    .insertInto('catalog_products')
    .values({
      id: toBin(productId),
      code: `PRD-${productId.slice(-8)}`,
      name: 'Produit de test perte',
      category_id: toBin(categoryId),
      stock_family: 'MARCHANDISE',
      base_unit_code: 'TETE',
      lot_tracking: 'NONE',
      created_by: toBin(admin),
    })
    .execute();
  return productId;
}

describe('inventory.loss.* (P2-04, SM-LOSS)', () => {
  let clock: Clock;
  let idGenerator: IdGenerator;
  let decisionRegistry: ApprovalDecisionHandlerRegistry;
  let pipeline: CommandPipelineService;
  let moveDeps: RecordMoveDeps;
  let admin: string;
  let adminDevice: string;
  let approver: string;
  let approverDevice: string;
  let siteId: string;
  let storeA: string;

  beforeAll(async () => {
    clock = new FixedClock(new Date(OCCURRED_AT));
    idGenerator = new Uuidv7Generator(clock);
    moveDeps = { idGenerator };
    decisionRegistry = new ApprovalDecisionHandlerRegistry();

    const registry = new CommandHandlerRegistry();
    registerLossCommands(registry, decisionRegistry, idGenerator, new DocumentSequenceService());
    registerPolicyCommands(registry);
    registerRequestCommands(registry, decisionRegistry);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    admin = await db.transaction().execute((trx) => insertTestUser(trx));
    adminDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, admin, { status: 'ACTIVE' }));
    approver = await db.transaction().execute((trx) => insertTestUser(trx));
    approverDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, approver, { status: 'ACTIVE' }));

    await db.transaction().execute(async (trx) => {
      const zoneId = await insertTestZone(trx, admin);
      siteId = await insertTestSite(trx, admin, zoneId);
      storeA = await insertTestLocation(trx, admin, siteId, { locationType: 'STORE' });

      const adminRole = await insertTestRole(trx, admin);
      await grantTestPermission(trx, adminRole, 'inventory.loss.declare', admin);
      await grantTestPermission(trx, adminRole, 'approvals.policy.manage', admin);
      await assignTestRole(trx, admin, adminRole, admin);

      const approverRole = await insertTestRole(trx, approver, { allowedScopeTypes: ['SITE'] });
      await grantTestPermission(trx, approverRole, 'approvals.request.read', admin, {
        maxScope: 'ALL',
      });
      await grantTestPermission(trx, approverRole, 'inventory.loss.approve', admin, {
        maxScope: 'SITE',
      });
      await assignTestRole(trx, approver, approverRole, admin, {
        scopeType: 'SITE',
        scopeSiteId: siteId,
      });
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const adminCtx = () => ({
    authenticatedUserId: admin,
    authenticatedDeviceId: adminDevice,
    transport: 'ONLINE_API' as const,
  });
  const approverCtx = () => ({
    authenticatedUserId: approver,
    authenticatedDeviceId: approverDevice,
    transport: 'ONLINE_API' as const,
  });

  async function openingBalance(
    productId: string,
    locationId: string,
    quantityBase: number,
  ): Promise<void> {
    const opening = await db
      .selectFrom('organization_locations')
      .select('id')
      .where('location_type', '=', 'V_OPENING')
      .executeTakeFirstOrThrow();
    await db.transaction().execute((trx) =>
      recordStockMove(trx, moveDeps, {
        productId,
        quantityBase,
        fromLocationId: fromBin(opening.id),
        toLocationId: locationId,
        moveType: 'OPENING_BALANCE',
        declaredUnitCostXaf: 500,
        occurredAt: new Date(OCCURRED_AT),
        sourceDocType: 'INVENTORY_COUNT',
        sourceDocId: freshUuid(),
        createdBy: admin,
        allowNegative: false,
      }),
    );
  }

  async function balanceOf(productId: string, locationId: string): Promise<number> {
    const row = await db
      .selectFrom('inventory_stock_balances')
      .select('qty_on_hand')
      .where('location_id', '=', toBin(locationId))
      .where('product_id', '=', toBin(productId))
      .executeTakeFirst();
    return row ? Number(row.qty_on_hand) : 0;
  }

  function declarePayload(
    productId: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      locationId: storeA,
      productId,
      quantityBase: 5,
      unitCode: 'TETE',
      quantity: 5,
      category: 'CASSE',
      comment: 'Casse en manutention.',
      ...overrides,
    };
  }

  /** Retire toutes les politiques actives `LOSS_DECLARATION` puis restaure exactement
   * celles qui l'étaient (même précaution que le test CONTROL_POLICY_MISSING de
   * inventory-transfer-commands.test.ts : `approvals.policy.set` ne retire que la version
   * précédente du même code, jamais les autres codes actifs du même operationType, et ces
   * tests commitent réellement — pas de rollback). */
  async function withoutActiveLossPolicy<T>(fn: () => Promise<T>): Promise<T> {
    const active = await db
      .selectFrom('approvals_control_policies')
      .select('id')
      .where('operation_type', '=', 'LOSS_DECLARATION')
      .where('status', '=', 'ACTIVE')
      .execute();
    await db
      .updateTable('approvals_control_policies')
      .set({ status: 'RETIRED', valid_to: new Date(OCCURRED_AT) })
      .where('operation_type', '=', 'LOSS_DECLARATION')
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

  async function setLossPolicy(requiresApproval: boolean): Promise<void> {
    const policyId = freshUuid();
    const result = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'approvals.policy.set',
        aggregate_type: 'CONTROL_POLICY',
        aggregate_id: policyId,
        payload: {
          code: `LOSS_${policyId.slice(-8)}`,
          operationType: 'LOSS_DECLARATION',
          requiresApproval,
          ...(requiresApproval
            ? { approverPermission: 'inventory.loss.approve', approverScope: 'SITE' }
            : {}),
        },
      }),
      adminCtx(),
    );
    expect(result.status).toBe('APPLIED');
  }

  it('sans politique active -> RECORDED direct, mouvement LOSS emplacement -> V_LOSS', async () => {
    const productId = await insertProduct(admin);
    await openingBalance(productId, storeA, 50);

    await withoutActiveLossPolicy(async () => {
      const lossId = freshUuid();
      const result = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'inventory.loss.declare',
          aggregate_type: 'STOCK_LOSS',
          aggregate_id: lossId,
          payload: declarePayload(productId),
        }),
        adminCtx(),
      );
      expect(result.status).toBe('APPLIED');

      const row = await db
        .selectFrom('inventory_loss_declarations')
        .select(['status', 'requires_approval', 'unit_cost_xaf', 'value_xaf', 'doc_number'])
        .where('id', '=', toBin(lossId))
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('RECORDED');
      expect(row.requires_approval).toBe(0);
      expect(Number(row.unit_cost_xaf)).toBe(500);
      expect(Number(row.value_xaf)).toBe(2500); // 5 * 500
      expect(row.doc_number).toMatch(/^PRT-/);

      expect(await balanceOf(productId, storeA)).toBe(45);
      const vLoss = await db
        .selectFrom('organization_locations')
        .select('id')
        .where('location_type', '=', 'V_LOSS')
        .executeTakeFirstOrThrow();
      expect(await balanceOf(productId, fromBin(vLoss.id))).toBe(5);
    });
  });

  it('commentaire requis pour INEXPLIQUEE/VOL_SUSPECTE (CK) -> REJECTED VALIDATION_ERROR', async () => {
    const productId = await insertProduct(admin);
    const result = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.loss.declare',
        aggregate_type: 'STOCK_LOSS',
        aggregate_id: freshUuid(),
        payload: declarePayload(productId, { category: 'VOL_SUSPECTE', comment: undefined }),
      }),
      adminCtx(),
    );
    expect(result.status).toBe('REJECTED');
    expect(result.status === 'REJECTED' && result.error.code).toMatch(/^VALIDATION_ERROR/);
  });

  it('productionLotId requis pour MORTALITE (CK) -> REJECTED VALIDATION_ERROR', async () => {
    const productId = await insertProduct(admin);
    const result = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.loss.declare',
        aggregate_type: 'STOCK_LOSS',
        aggregate_id: freshUuid(),
        payload: declarePayload(productId, { category: 'MORTALITE', comment: undefined }),
      }),
      adminCtx(),
    );
    expect(result.status).toBe('REJECTED');
    expect(result.status === 'REJECTED' && result.error.code).toMatch(/^VALIDATION_ERROR/);
  });

  describe('avec politique active (requiresApproval) -> PENDING_APPROVAL', () => {
    beforeAll(async () => {
      await setLossPolicy(true);
    });

    async function declareWithApproval(productId: string): Promise<string> {
      await openingBalance(productId, storeA, 50);
      const lossId = freshUuid();
      const result = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'inventory.loss.declare',
          aggregate_type: 'STOCK_LOSS',
          aggregate_id: lossId,
          payload: declarePayload(productId),
        }),
        adminCtx(),
      );
      expect(result.status).toBe('APPLIED');
      return lossId;
    }

    it('déclaration -> PENDING_APPROVAL, mouvement LOSS_PENDING emplacement -> V_PENDING_LOSS', async () => {
      const productId = await insertProduct(admin);
      const lossId = await declareWithApproval(productId);

      const row = await db
        .selectFrom('inventory_loss_declarations')
        .select(['status', 'requires_approval', 'approval_request_id'])
        .where('id', '=', toBin(lossId))
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('PENDING_APPROVAL');
      expect(row.requires_approval).toBe(1);
      expect(row.approval_request_id).not.toBeNull();

      expect(await balanceOf(productId, storeA)).toBe(45);
      const vPendingLoss = await db
        .selectFrom('organization_locations')
        .select('id')
        .where('location_type', '=', 'V_PENDING_LOSS')
        .executeTakeFirstOrThrow();
      expect(await balanceOf(productId, fromBin(vPendingLoss.id))).toBe(5);
    });

    it('withdraw par le déclarant -> CANCELLED, LOSS_RELEASE retourne le stock à l’emplacement', async () => {
      const productId = await insertProduct(admin);
      const lossId = await declareWithApproval(productId);

      const withdrawResult = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'inventory.loss.withdraw',
          aggregate_type: 'STOCK_LOSS',
          aggregate_id: lossId,
          payload: { lossId },
        }),
        adminCtx(),
      );
      expect(withdrawResult.status).toBe('APPLIED');

      const row = await db
        .selectFrom('inventory_loss_declarations')
        .select(['status', 'approval_request_id'])
        .where('id', '=', toBin(lossId))
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('CANCELLED');
      expect(await balanceOf(productId, storeA)).toBe(50); // stock intégralement revenu

      const approvalRow = await db
        .selectFrom('approvals_approval_requests')
        .select(['status'])
        .where('id', '=', row.approval_request_id!)
        .executeTakeFirstOrThrow();
      expect(approvalRow.status).toBe('CANCELLED');
    });

    it('withdraw par un autre utilisateur -> REJECTED FORBIDDEN', async () => {
      const productId = await insertProduct(admin);
      const lossId = await declareWithApproval(productId);

      const result = await pipeline.handle(
        buildEnvelope(approver, {
          command_type: 'inventory.loss.withdraw',
          aggregate_type: 'STOCK_LOSS',
          aggregate_id: lossId,
          payload: { lossId },
        }),
        approverCtx(),
      );
      expect(result.status).toBe('REJECTED');
      expect(result.status === 'REJECTED' && result.error.code).toBe('FORBIDDEN');
    });

    it('approve -> APPROVED, LOSS_CONFIRMATION V_PENDING_LOSS -> V_LOSS', async () => {
      const productId = await insertProduct(admin);
      const lossId = await declareWithApproval(productId);
      const pending = await db
        .selectFrom('inventory_loss_declarations')
        .select('approval_request_id')
        .where('id', '=', toBin(lossId))
        .executeTakeFirstOrThrow();
      const requestId = fromBinOrNull(pending.approval_request_id)!;

      const approveResult = await pipeline.handle(
        buildEnvelope(approver, {
          command_type: 'approvals.request.approve',
          aggregate_type: 'APPROVAL_REQUEST',
          aggregate_id: requestId,
          payload: { requestId },
        }),
        approverCtx(),
      );
      expect(approveResult.status).toBe('APPLIED');

      const row = await db
        .selectFrom('inventory_loss_declarations')
        .select(['status'])
        .where('id', '=', toBin(lossId))
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('APPROVED');

      const vLoss = await db
        .selectFrom('organization_locations')
        .select('id')
        .where('location_type', '=', 'V_LOSS')
        .executeTakeFirstOrThrow();
      expect(await balanceOf(productId, fromBin(vLoss.id))).toBe(5);
      const vPendingLoss = await db
        .selectFrom('organization_locations')
        .select('id')
        .where('location_type', '=', 'V_PENDING_LOSS')
        .executeTakeFirstOrThrow();
      expect(await balanceOf(productId, fromBin(vPendingLoss.id))).toBe(0);
    });

    it('reject ERREUR_DECLARATION -> REJECTED_RETURNED, LOSS_RELEASE retourne le stock', async () => {
      const productId = await insertProduct(admin);
      const lossId = await declareWithApproval(productId);
      const pending = await db
        .selectFrom('inventory_loss_declarations')
        .select('approval_request_id')
        .where('id', '=', toBin(lossId))
        .executeTakeFirstOrThrow();
      const requestId = fromBinOrNull(pending.approval_request_id)!;

      const rejectResult = await pipeline.handle(
        buildEnvelope(approver, {
          command_type: 'approvals.request.reject',
          aggregate_type: 'APPROVAL_REQUEST',
          aggregate_id: requestId,
          payload: {
            requestId,
            comment: 'Erreur de saisie : produit intact.',
            decisionOption: 'ERREUR_DECLARATION',
          },
        }),
        approverCtx(),
      );
      expect(rejectResult.status).toBe('APPLIED');

      const row = await db
        .selectFrom('inventory_loss_declarations')
        .select(['status', 'category'])
        .where('id', '=', toBin(lossId))
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('REJECTED_RETURNED');
      expect(row.category).toBe('CASSE'); // catégorie inchangée (contrairement à PERTE_NON_JUSTIFIEE)
      expect(await balanceOf(productId, storeA)).toBe(50); // stock intégralement revenu
    });

    it('reject PERTE_NON_JUSTIFIEE -> REJECTED_UNJUSTIFIED, catégorie reclassée INEXPLIQUEE, responsabilité imputée au déclarant', async () => {
      const productId = await insertProduct(admin);
      const lossId = await declareWithApproval(productId);
      const pending = await db
        .selectFrom('inventory_loss_declarations')
        .select('approval_request_id')
        .where('id', '=', toBin(lossId))
        .executeTakeFirstOrThrow();
      const requestId = fromBinOrNull(pending.approval_request_id)!;

      const rejectResult = await pipeline.handle(
        buildEnvelope(approver, {
          command_type: 'approvals.request.reject',
          aggregate_type: 'APPROVAL_REQUEST',
          aggregate_id: requestId,
          payload: {
            requestId,
            comment: 'Aucune trace de casse constatée sur place.',
            decisionOption: 'PERTE_NON_JUSTIFIEE',
          },
        }),
        approverCtx(),
      );
      expect(rejectResult.status).toBe('APPLIED');

      const row = await db
        .selectFrom('inventory_loss_declarations')
        .select(['status', 'category', 'responsibility_user_id', 'comment'])
        .where('id', '=', toBin(lossId))
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('REJECTED_UNJUSTIFIED');
      expect(row.category).toBe('INEXPLIQUEE');
      expect(fromBinOrNull(row.responsibility_user_id)).toBe(admin);
      expect(row.comment).toBe('Casse en manutention.'); // déjà présent, non écrasé

      // Solde V_LOSS non vérifié ici (cumulatif avec le test « approve » précédent, même
      // produit non réutilisé mais même emplacement virtuel partagé) : on vérifie le
      // mouvement lui-même, filtré par ce `lossId`, plutôt que le solde global.
      const move = await db
        .selectFrom('inventory_stock_moves')
        .select(['quantity'])
        .where('product_id', '=', toBin(productId))
        .where('move_type', '=', 'LOSS_CONFIRMATION')
        .where('source_doc_id', '=', toBin(lossId))
        .executeTakeFirstOrThrow();
      expect(Number(move.quantity)).toBe(5);
    });
  });
});
