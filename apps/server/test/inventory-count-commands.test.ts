/**
 * `inventory.count.*` (P2-04, SM-INVENTORY-COUNT) à travers le vrai pipeline de commande.
 * Démontre : ouverture (unicité IN_PROGRESS par emplacement) ; saisie de lignes (upsert) ;
 * soumission — calcul du théorique en rejouant `inventory_stock_moves`, écart valorisé,
 * seuil paramétrable (`inventory.count_approval_threshold_xaf`) décidant POSTED immédiat ou
 * PENDING_APPROVAL ; décision `INVENTORY_ADJUSTMENT` (approve/reject) ; annulation ; garde
 * CONTROL_POLICY_MISSING (§5, transfer-commands.ts, même patron pour INVENTORY_ADJUSTMENT).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerCountCommands } from '../src/modules/inventory/application/commands/count-commands.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { recordStockMove, type RecordMoveDeps } from '../src/modules/inventory/application/public/index.js';
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

const OCCURRED_AT = '2026-10-02T09:00:00.000Z';

function buildEnvelope(
  authorUserId: string,
  overrides: {
    readonly command_type: string;
    readonly aggregate_type: string;
    readonly aggregate_id: string;
    readonly payload: unknown;
  },
): Record<string, unknown> {
  return {
    command_id: freshUuid(),
    device_seq: 1,
    command_version: 1,
    author_user_id: authorUserId,
    base_version: null,
    depends_on: [],
    occurred_at: OCCURRED_AT,
    client_created_at: OCCURRED_AT,
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
    .values({ id: toBin(categoryId), code: `CAT-${categoryId.slice(-8)}`, name: 'Test', created_by: toBin(admin) })
    .execute();
  const already = await db.selectFrom('catalog_units').select('code').where('code', '=', 'TETE').executeTakeFirst();
  if (!already) {
    await db.insertInto('catalog_units').values({ code: 'TETE', name: 'Tête', is_count: 1 }).execute();
  }
  const productId = freshUuid();
  await db
    .insertInto('catalog_products')
    .values({
      id: toBin(productId),
      code: `PRD-${productId.slice(-8)}`,
      name: 'Produit de test inventaire',
      category_id: toBin(categoryId),
      stock_family: 'MARCHANDISE',
      base_unit_code: 'TETE',
      lot_tracking: 'NONE',
      created_by: toBin(admin),
    })
    .execute();
  return productId;
}

describe('inventory.count.* (P2-04, SM-INVENTORY-COUNT)', () => {
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

  beforeAll(async () => {
    clock = new FixedClock(new Date(OCCURRED_AT));
    idGenerator = new Uuidv7Generator(clock);
    moveDeps = { idGenerator };
    decisionRegistry = new ApprovalDecisionHandlerRegistry();

    const registry = new CommandHandlerRegistry();
    registerCountCommands(registry, decisionRegistry, idGenerator, new DocumentSequenceService());
    registerPolicyCommands(registry);
    registerRequestCommands(registry, decisionRegistry);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    admin = await db.transaction().execute((trx) => insertTestUser(trx));
    adminDevice = await db.transaction().execute((trx) => insertTestDevice(trx, admin, { status: 'ACTIVE' }));
    approver = await db.transaction().execute((trx) => insertTestUser(trx));
    approverDevice = await db.transaction().execute((trx) => insertTestDevice(trx, approver, { status: 'ACTIVE' }));

    await db.transaction().execute(async (trx) => {
      const zoneId = await insertTestZone(trx, admin);
      siteId = await insertTestSite(trx, admin, zoneId);

      const adminRole = await insertTestRole(trx, admin);
      await grantTestPermission(trx, adminRole, 'inventory.count.perform', admin);
      await grantTestPermission(trx, adminRole, 'approvals.policy.manage', admin);
      await assignTestRole(trx, admin, adminRole, admin);

      const approverRole = await insertTestRole(trx, approver, { allowedScopeTypes: ['SITE'] });
      await grantTestPermission(trx, approverRole, 'approvals.request.read', admin, { maxScope: 'ALL' });
      await grantTestPermission(trx, approverRole, 'inventory.count.approve', admin, { maxScope: 'SITE' });
      await assignTestRole(trx, approver, approverRole, admin, { scopeType: 'SITE', scopeSiteId: siteId });
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

  async function newStore(): Promise<string> {
    return db.transaction().execute((trx) => insertTestLocation(trx, admin, siteId, { locationType: 'STORE' }));
  }

  async function openingBalance(productId: string, locationId: string, quantityBase: number, unitCostXaf: number): Promise<void> {
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
        declaredUnitCostXaf: unitCostXaf,
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

  async function openCount(locationId: string): Promise<string> {
    const countId = freshUuid();
    const result = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.count.open',
        aggregate_type: 'INVENTORY_COUNT',
        aggregate_id: countId,
        payload: { locationId, countType: 'FULL' },
      }),
      adminCtx(),
    );
    expect(result.status).toBe('APPLIED');
    return countId;
  }

  async function recordLine(countId: string, productId: string, countedQtyBase: number): Promise<void> {
    const result = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.count.record_lines',
        aggregate_type: 'INVENTORY_COUNT',
        aggregate_id: countId,
        payload: { countId, lines: [{ productId, countedAt: OCCURRED_AT, countedQtyBase }] },
      }),
      adminCtx(),
    );
    expect(result.status).toBe('APPLIED');
  }

  it('open : IN_PROGRESS ; un second open sur le même emplacement -> REJECTED COUNT_ALREADY_IN_PROGRESS', async () => {
    const locationId = await newStore();
    const countId = await openCount(locationId);

    const row = await db
      .selectFrom('inventory_inventory_counts')
      .select(['status', 'doc_number'])
      .where('id', '=', toBin(countId))
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('IN_PROGRESS');
    expect(row.doc_number).toMatch(/^INV-/);

    const second = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.count.open',
        aggregate_type: 'INVENTORY_COUNT',
        aggregate_id: freshUuid(),
        payload: { locationId, countType: 'SPOT' },
      }),
      adminCtx(),
    );
    expect(second.status).toBe('REJECTED');
    expect(second.status === 'REJECTED' && second.error.code).toBe('COUNT_ALREADY_IN_PROGRESS');
  });

  it('record_lines : upsert — une seconde saisie du même (produit, sans lot) corrige la ligne, n’en crée pas une seconde', async () => {
    const locationId = await newStore();
    const productId = await insertProduct(admin);
    const countId = await openCount(locationId);

    await recordLine(countId, productId, 40);
    await recordLine(countId, productId, 45); // correction avant soumission

    const lines = await db
      .selectFrom('inventory_inventory_count_lines')
      .select(['counted_qty_base'])
      .where('count_id', '=', toBin(countId))
      .execute();
    expect(lines).toHaveLength(1);
    expect(Number(lines[0]!.counted_qty_base)).toBe(45);
  });

  it('submit sans écart -> POSTED direct, aucun mouvement d’ajustement', async () => {
    const locationId = await newStore();
    const productId = await insertProduct(admin);
    await openingBalance(productId, locationId, 100, 500);
    const countId = await openCount(locationId);
    await recordLine(countId, productId, 100);

    const result = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.count.submit',
        aggregate_type: 'INVENTORY_COUNT',
        aggregate_id: countId,
        payload: { countId },
      }),
      adminCtx(),
    );
    expect(result.status).toBe('APPLIED');

    const row = await db
      .selectFrom('inventory_inventory_counts')
      .select(['status', 'variance_value_xaf', 'abs_variance_value_xaf'])
      .where('id', '=', toBin(countId))
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('POSTED');
    expect(Number(row.variance_value_xaf)).toBe(0);
    expect(Number(row.abs_variance_value_xaf)).toBe(0);
    expect(await balanceOf(productId, locationId)).toBe(100); // inchangé

    const line = await db
      .selectFrom('inventory_inventory_count_lines')
      .select(['theoretical_qty_base', 'variance_qty_base'])
      .where('count_id', '=', toBin(countId))
      .executeTakeFirstOrThrow();
    expect(Number(line.theoretical_qty_base)).toBe(100);
    expect(Number(line.variance_qty_base)).toBe(0);

    const gainMoves = await db
      .selectFrom('inventory_stock_moves')
      .select(['id'])
      .where('source_doc_id', '=', toBin(countId))
      .execute();
    expect(gainMoves).toHaveLength(0);
  });

  it('submit avec écart sous le seuil (25 000 XAF) -> POSTED direct, INVENTORY_LOSS appliqué (compté < théorique)', async () => {
    const locationId = await newStore();
    const productId = await insertProduct(admin);
    await openingBalance(productId, locationId, 100, 1000); // CMUP 1000 XAF
    const countId = await openCount(locationId);
    await recordLine(countId, productId, 95); // écart -5 * 1000 = -5000 XAF (< 25 000)

    const result = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.count.submit',
        aggregate_type: 'INVENTORY_COUNT',
        aggregate_id: countId,
        payload: { countId },
      }),
      adminCtx(),
    );
    expect(result.status).toBe('APPLIED');

    const row = await db
      .selectFrom('inventory_inventory_counts')
      .select(['status', 'variance_value_xaf', 'abs_variance_value_xaf'])
      .where('id', '=', toBin(countId))
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('POSTED');
    expect(Number(row.variance_value_xaf)).toBe(-5000);
    expect(Number(row.abs_variance_value_xaf)).toBe(5000);

    expect(await balanceOf(productId, locationId)).toBe(95); // ajusté à la baisse
    const lossMove = await db
      .selectFrom('inventory_stock_moves')
      .select(['quantity', 'move_type'])
      .where('source_doc_id', '=', toBin(countId))
      .executeTakeFirstOrThrow();
    expect(lossMove.move_type).toBe('INVENTORY_LOSS');
    expect(Number(lossMove.quantity)).toBe(5);
  });

  it('submit avec écart au-dessus du seuil sans politique active -> REJECTED CONTROL_POLICY_MISSING', async () => {
    const locationId = await newStore();
    const productId = await insertProduct(admin);
    await openingBalance(productId, locationId, 100, 1000);
    const countId = await openCount(locationId);
    await recordLine(countId, productId, 130); // écart +30 * 1000 = 30 000 XAF (>= 25 000)

    // `currentPolicies` lit directement la table et renvoie TOUTE politique ACTIVE pour cet
    // `operationType`, quel que soit son `code` (même piège que le test CONTROL_POLICY_MISSING
    // de inventory-transfer-commands.test.ts) : une exécution antérieure de ce fichier a pu
    // laisser une politique INVENTORY_ADJUSTMENT active (le describe suivant en crée une,
    // jamais retirée après ses propres tests — ces commandes commitent réellement, jamais de
    // rollback). On retire donc ici toutes les politiques actives de ce type, puis on restaure
    // exactement celles qui l'étaient.
    const activeAdjustmentPolicies = await db
      .selectFrom('approvals_control_policies')
      .select('id')
      .where('operation_type', '=', 'INVENTORY_ADJUSTMENT')
      .where('status', '=', 'ACTIVE')
      .execute();
    await db
      .updateTable('approvals_control_policies')
      .set({ status: 'RETIRED', valid_to: new Date(OCCURRED_AT) })
      .where('operation_type', '=', 'INVENTORY_ADJUSTMENT')
      .where('status', '=', 'ACTIVE')
      .execute();

    let result: Awaited<ReturnType<typeof pipeline.handle>>;
    try {
      result = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'inventory.count.submit',
          aggregate_type: 'INVENTORY_COUNT',
          aggregate_id: countId,
          payload: { countId },
        }),
        adminCtx(),
      );
    } finally {
      for (const row of activeAdjustmentPolicies) {
        await db
          .updateTable('approvals_control_policies')
          .set({ status: 'ACTIVE', valid_to: null })
          .where('id', '=', row.id)
          .execute();
      }
    }
    expect(result.status).toBe('REJECTED');
    expect(result.status === 'REJECTED' && result.error.code).toBe('CONTROL_POLICY_MISSING');

    // Aucun effet : le compte reste IN_PROGRESS (rollback complet de la transaction).
    const row = await db
      .selectFrom('inventory_inventory_counts')
      .select(['status'])
      .where('id', '=', toBin(countId))
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('IN_PROGRESS');
  });

  it('cancel : IN_PROGRESS -> CANCELLED', async () => {
    const locationId = await newStore();
    const countId = await openCount(locationId);

    const result = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.count.cancel',
        aggregate_type: 'INVENTORY_COUNT',
        aggregate_id: countId,
        payload: { countId },
      }),
      adminCtx(),
    );
    expect(result.status).toBe('APPLIED');
    const row = await db
      .selectFrom('inventory_inventory_counts')
      .select(['status'])
      .where('id', '=', toBin(countId))
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('CANCELLED');
  });

  describe('écart au-dessus du seuil avec politique active -> PENDING_APPROVAL -> décision', () => {
    beforeAll(async () => {
      const policyId = freshUuid();
      const result = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'approvals.policy.set',
          aggregate_type: 'CONTROL_POLICY',
          aggregate_id: policyId,
          payload: {
            code: `INV_ADJ_${policyId.slice(-8)}`,
            operationType: 'INVENTORY_ADJUSTMENT',
            requiresApproval: true,
            approverPermission: 'inventory.count.approve',
            approverScope: 'SITE',
          },
        }),
        adminCtx(),
      );
      expect(result.status).toBe('APPLIED');
    });

    async function submitWithGap(): Promise<{ readonly countId: string; readonly locationId: string; readonly productId: string }> {
      const locationId = await newStore();
      const productId = await insertProduct(admin);
      await openingBalance(productId, locationId, 100, 1000);
      const countId = await openCount(locationId);
      await recordLine(countId, productId, 130); // +30 000 XAF, au-dessus du seuil.

      const result = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'inventory.count.submit',
          aggregate_type: 'INVENTORY_COUNT',
          aggregate_id: countId,
          payload: { countId },
        }),
        adminCtx(),
      );
      expect(result.status).toBe('APPLIED');
      return { countId, locationId, productId };
    }

    it('submit -> PENDING_APPROVAL, aucun mouvement appliqué encore', async () => {
      const { countId, locationId, productId } = await submitWithGap();

      const row = await db
        .selectFrom('inventory_inventory_counts')
        .select(['status', 'approval_request_id'])
        .where('id', '=', toBin(countId))
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('PENDING_APPROVAL');
      expect(row.approval_request_id).not.toBeNull();
      expect(await balanceOf(productId, locationId)).toBe(100); // pas encore ajusté
    });

    it('approve -> POSTED, INVENTORY_GAIN appliqué (compté > théorique)', async () => {
      const { countId, locationId, productId } = await submitWithGap();
      const pending = await db
        .selectFrom('inventory_inventory_counts')
        .select('approval_request_id')
        .where('id', '=', toBin(countId))
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
        .selectFrom('inventory_inventory_counts')
        .select(['status'])
        .where('id', '=', toBin(countId))
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('POSTED');
      expect(await balanceOf(productId, locationId)).toBe(130);

      const gainMove = await db
        .selectFrom('inventory_stock_moves')
        .select(['move_type', 'quantity', 'unit_cost_xaf'])
        .where('source_doc_id', '=', toBin(countId))
        .executeTakeFirstOrThrow();
      expect(gainMove.move_type).toBe('INVENTORY_GAIN');
      expect(Number(gainMove.quantity)).toBe(30);
      expect(Number(gainMove.unit_cost_xaf)).toBe(1000); // coût figé à la soumission.
    });

    it('reject -> REJECTED, aucun mouvement appliqué', async () => {
      const { countId, locationId, productId } = await submitWithGap();
      const pending = await db
        .selectFrom('inventory_inventory_counts')
        .select('approval_request_id')
        .where('id', '=', toBin(countId))
        .executeTakeFirstOrThrow();
      const requestId = fromBinOrNull(pending.approval_request_id)!;

      const rejectResult = await pipeline.handle(
        buildEnvelope(approver, {
          command_type: 'approvals.request.reject',
          aggregate_type: 'APPROVAL_REQUEST',
          aggregate_id: requestId,
          payload: { requestId, comment: 'Recomptage nécessaire.' },
        }),
        approverCtx(),
      );
      expect(rejectResult.status).toBe('APPLIED');

      const row = await db
        .selectFrom('inventory_inventory_counts')
        .select(['status'])
        .where('id', '=', toBin(countId))
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('REJECTED');
      expect(await balanceOf(productId, locationId)).toBe(100); // inchangé

      const moves = await db
        .selectFrom('inventory_stock_moves')
        .select(['id'])
        .where('source_doc_id', '=', toBin(countId))
        .execute();
      expect(moves).toHaveLength(0);
    });
  });
});
