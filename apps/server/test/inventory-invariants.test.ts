/**
 * Invariants du stock (P2-07 ; 02-domain-model/01-invariants.md, INV-STK-*) et tests
 * d'acceptation AT-016, AT-022 — sur une base réelle, via `recordStockMove` et le vrai
 * pipeline de commande. Complète les tests P2-03/P2-04 (INV-STK-02 couple par type, INV-STK-06
 * refus en ligne, BR-STK-018 hors ligne : inventory-record-move.test.ts ; INV-STK-14 :
 * inventory-loss-commands.test.ts) par ce qui n'y était pas démontré.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';
import { sql } from 'kysely';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { JobHandlerRegistry } from '../src/platform/jobs/job-handler-registry.js';
import { registerTransferCommands } from '../src/modules/inventory/application/commands/transfer-commands.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import {
  LedgerReconciliationJob,
  LEDGER_RECONCILIATION_JOB_TYPE,
} from '../src/modules/inventory/application/jobs/ledger-reconciliation-job.js';
import {
  InventoryMoveError,
  rebuildStockBalances,
  recordStockMove,
  verifyStockLedger,
  type RecordMoveInput,
} from '../src/modules/inventory/application/public/index.js';
import { fromBin, fromBinOrNull, toBin } from '../src/platform/kysely/uuid-columns.js';
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

const OCCURRED_AT = '2026-10-04T09:00:00.000Z';

describe('invariants du stock (P2-07)', () => {
  let clock: Clock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let admin: string;
  let adminDevice: string;
  let approver: string;
  let approverDevice: string;
  let storeA: string;
  let storeB: string;
  const virtual: Record<string, string> = {};

  function envelope(
    author: string,
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    payload: unknown,
  ): Record<string, unknown> {
    return {
      command_id: freshUuid(),
      device_seq: 1,
      command_version: 1,
      command_type: commandType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      author_user_id: author,
      base_version: null,
      depends_on: [],
      occurred_at: OCCURRED_AT,
      client_created_at: OCCURRED_AT,
      captured_offline: false,
      backdated_reason: null,
      attachment_ids: [],
      payload,
    };
  }

  async function asAdmin(
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    payload: unknown,
  ): Promise<void> {
    const result = await pipeline.handle(
      envelope(admin, commandType, aggregateType, aggregateId, payload),
      { authenticatedUserId: admin, authenticatedDeviceId: adminDevice, transport: 'ONLINE_API' },
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
  }

  async function insertProduct(lotTracking: 'NONE' | 'OPTIONAL' | 'REQUIRED'): Promise<string> {
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
    const productId = freshUuid();
    await db
      .insertInto('catalog_products')
      .values({
        id: toBin(productId),
        code: `PRD-${productId.slice(-8)}`,
        name: 'Produit de test invariants',
        category_id: toBin(categoryId),
        stock_family: 'MARCHANDISE',
        base_unit_code: 'TETE',
        lot_tracking: lotTracking,
        created_by: toBin(admin),
      })
      .execute();
    return productId;
  }

  async function insertLot(productId: string): Promise<string> {
    const lotId = freshUuid();
    await db
      .insertInto('inventory_stock_lots')
      .values({
        id: toBin(lotId),
        lot_code: `L-${lotId.slice(-12)}`,
        product_id: toBin(productId),
        origin_type: 'SUPPLIER_LOT',
        fifo_rank_at: new Date(OCCURRED_AT),
        created_by: toBin(admin),
      })
      .execute();
    return lotId;
  }

  function move(
    input: Omit<
      RecordMoveInput,
      'occurredAt' | 'sourceDocType' | 'sourceDocId' | 'createdBy' | 'allowNegative'
    > &
      Partial<Pick<RecordMoveInput, 'allowNegative' | 'sourceDocType' | 'sourceDocId'>>,
  ) {
    return db.transaction().execute((trx) =>
      recordStockMove(
        trx,
        { idGenerator },
        {
          occurredAt: new Date(OCCURRED_AT),
          sourceDocType: 'INVENTORY_COUNT',
          sourceDocId: freshUuid(),
          createdBy: admin,
          allowNegative: false,
          ...input,
        },
      ),
    );
  }

  async function balanceOf(productId: string, locationId: string): Promise<number> {
    const row = await db
      .selectFrom('inventory_stock_balances')
      .select(sql<string>`SUM(qty_on_hand)`.as('qty'))
      .where('location_id', '=', toBin(locationId))
      .where('product_id', '=', toBin(productId))
      .executeTakeFirst();
    return Number(row?.qty ?? 0);
  }

  /** Solde net d'un emplacement pour les seuls mouvements d'un document (transit par transfert,
   * stratégie stock §6 : « le solde de transit par transfert se calcule avec source_doc_id »). */
  async function netForDocument(locationId: string, sourceDocId: string): Promise<number> {
    const location = toBin(locationId);
    const row = await db
      .selectFrom('inventory_stock_moves')
      .select(
        sql<string>`SUM(CASE WHEN to_location_id = ${location} THEN quantity ELSE -quantity END)`.as(
          'qty',
        ),
      )
      .where('source_doc_id', '=', toBin(sourceDocId))
      .where((eb) =>
        eb.or([eb('to_location_id', '=', location), eb('from_location_id', '=', location)]),
      )
      .executeTakeFirst();
    return Number(row?.qty ?? 0);
  }

  async function expectMoveError(promise: Promise<unknown>, code: string): Promise<void> {
    await expect(promise).rejects.toBeInstanceOf(InventoryMoveError);
    await expect(promise).rejects.toMatchObject({ code });
  }

  beforeAll(async () => {
    clock = new FixedClock(new Date(OCCURRED_AT));
    idGenerator = new Uuidv7Generator(clock);
    const decisionRegistry = new ApprovalDecisionHandlerRegistry();
    const registry = new CommandHandlerRegistry();
    registerTransferCommands(
      registry,
      decisionRegistry,
      idGenerator,
      new DocumentSequenceService(),
    );
    registerPolicyCommands(registry);
    registerRequestCommands(registry, decisionRegistry);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    await db.transaction().execute(async (trx) => {
      admin = await insertTestUser(trx);
      approver = await insertTestUser(trx);
      adminDevice = await insertTestDevice(trx, admin, { status: 'ACTIVE' });
      approverDevice = await insertTestDevice(trx, approver, { status: 'ACTIVE' });
      const zoneId = await insertTestZone(trx, admin);
      const siteId = await insertTestSite(trx, admin, zoneId);
      storeA = await insertTestLocation(trx, admin, siteId, { locationType: 'STORE' });
      storeB = await insertTestLocation(trx, admin, siteId, { locationType: 'STORE' });

      const adminRole = await insertTestRole(trx, admin);
      for (const code of [
        'inventory.transfer.dispatch',
        'inventory.transfer.receive',
        'approvals.policy.manage',
      ]) {
        await grantTestPermission(trx, adminRole, code, admin);
      }
      await assignTestRole(trx, admin, adminRole, admin);

      const approverRole = await insertTestRole(trx, approver, { allowedScopeTypes: ['SITE'] });
      await grantTestPermission(trx, approverRole, 'approvals.request.read', admin);
      await grantTestPermission(
        trx,
        approverRole,
        'inventory.transfer_discrepancy.approve',
        admin,
        {
          maxScope: 'SITE',
        },
      );
      await assignTestRole(trx, approver, approverRole, admin, {
        scopeType: 'SITE',
        scopeSiteId: siteId,
      });

      const unit = await trx
        .selectFrom('catalog_units')
        .select('code')
        .where('code', '=', 'TETE')
        .executeTakeFirst();
      if (!unit) {
        await trx
          .insertInto('catalog_units')
          .values({ code: 'TETE', name: 'Tête', is_count: 1 })
          .execute();
      }
    });

    for (const type of [
      'V_OPENING',
      'V_SUPPLIER',
      'V_CONSUMPTION',
      'V_TRANSIT',
      'V_PENDING_LOSS',
      'V_LOSS',
    ]) {
      const row = await db
        .selectFrom('organization_locations')
        .select('id')
        .where('location_type', '=', type)
        .executeTakeFirstOrThrow();
      virtual[type] = fromBin(row.id);
    }
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('INV-STK-04 / AT-022 : un mouvement ne peut être ni modifié ni supprimé en base', async () => {
    const productId = await insertProduct('NONE');
    const [recorded] = await move({
      productId,
      quantityBase: 10,
      fromLocationId: virtual.V_OPENING!,
      toLocationId: storeA,
      moveType: 'OPENING_BALANCE',
      declaredUnitCostXaf: 500,
    });

    await expect(
      db
        .updateTable('inventory_stock_moves')
        .set({ quantity: '99' })
        .where('id', '=', toBin(recorded!.moveId))
        .execute(),
    ).rejects.toThrow(/registre immuable/);
    await expect(
      db.deleteFrom('inventory_stock_moves').where('id', '=', toBin(recorded!.moveId)).execute(),
    ).rejects.toThrow(/suppression physique interdite/);
    expect(await balanceOf(productId, storeA)).toBe(10);
  });

  it('INV-STK-04 : un inverse est conforme à l’origine, unique, et reprend le coût d’origine (BR-STK-052)', async () => {
    const productId = await insertProduct('NONE');
    await move({
      productId,
      quantityBase: 10,
      fromLocationId: virtual.V_OPENING!,
      toLocationId: storeA,
      moveType: 'OPENING_BALANCE',
      declaredUnitCostXaf: 500,
    });
    const [consumption] = await move({
      productId,
      quantityBase: 2,
      fromLocationId: storeA,
      toLocationId: virtual.V_CONSUMPTION!,
      moveType: 'CONSUMPTION',
      sourceDocType: 'CONSUMPTION',
    });
    expect(consumption!.unitCostXaf).toBe(500);
    // Le CMUP change après la consommation : l'inverse ne doit pas le suivre.
    await move({
      productId,
      quantityBase: 8,
      fromLocationId: virtual.V_SUPPLIER!,
      toLocationId: storeA,
      moveType: 'PURCHASE_RECEIPT',
      declaredUnitCostXaf: 1500,
      sourceDocType: 'GOODS_RECEIPT',
    });

    const reversal = {
      productId,
      fromLocationId: virtual.V_CONSUMPTION!,
      toLocationId: storeA,
      moveType: 'CONSUMPTION_REVERSAL' as const,
      sourceDocType: 'CONSUMPTION' as const,
      reversesMoveId: consumption!.moveId,
    };
    await expectMoveError(move({ ...reversal, quantityBase: 1 }), 'REVERSAL_INVALID');
    await expectMoveError(
      move({ ...reversal, quantityBase: 2, reversedUnitCostXaf: 999 }),
      'REVERSAL_INVALID',
    );

    const [inverse] = await move({ ...reversal, quantityBase: 2 });
    expect(inverse!.unitCostXaf).toBe(500);
    await expectMoveError(move({ ...reversal, quantityBase: 2 }), 'REVERSAL_INVALID');
    expect(await balanceOf(productId, storeA)).toBe(18);
  });

  it('INV-STK-13 / BR-STK-050 : lot obligatoire, interdit ou cohérent selon le produit', async () => {
    const required = await insertProduct('REQUIRED');
    const none = await insertProduct('NONE');
    const otherLot = await insertLot(none);
    const ownLot = await insertLot(required);
    const opening = {
      quantityBase: 5,
      fromLocationId: virtual.V_OPENING!,
      toLocationId: storeA,
      moveType: 'OPENING_BALANCE' as const,
      declaredUnitCostXaf: 400,
    };

    await expectMoveError(move({ ...opening, productId: required }), 'LOT_REQUIRED');
    await expectMoveError(
      move({ ...opening, productId: required, lotId: otherLot }),
      'LOT_MISMATCH',
    );
    await expectMoveError(move({ ...opening, productId: none, lotId: otherLot }), 'LOT_MISMATCH');
    await move({ ...opening, productId: required, lotId: ownLot });
    expect(await balanceOf(required, storeA)).toBe(5);

    // Exception documentée (record-move.ts, checkLot) : un fait hors ligne sans lot résoluble
    // — sortie d'un emplacement sans aucun lot en solde — est appliqué plutôt que rejeté.
    const [offline] = await move({
      productId: required,
      quantityBase: 1,
      fromLocationId: storeB,
      toLocationId: virtual.V_CONSUMPTION!,
      moveType: 'CONSUMPTION',
      sourceDocType: 'CONSUMPTION',
      allowNegative: true,
    });
    expect(offline!.lotId).toBeNull();
  });

  it('INV-STK-02 / INV-STK-15 : contraintes en base (quantité > 0, coût unitaire ≥ 0)', async () => {
    const productId = await insertProduct('NONE');
    const base = {
      product_id: toBin(productId),
      from_location_id: toBin(virtual.V_OPENING!),
      to_location_id: toBin(storeA),
      move_type: 'OPENING_BALANCE',
      value_xaf: 0,
      occurred_at: new Date(OCCURRED_AT),
      source_doc_type: 'INVENTORY_COUNT',
      source_doc_id: toBin(freshUuid()),
      created_by: toBin(admin),
    };
    await expect(
      db
        .insertInto('inventory_stock_moves')
        .values({ ...base, id: toBin(freshUuid()), quantity: '0', unit_cost_xaf: 100 })
        .execute(),
    ).rejects.toThrow(/ck_inventory_stock_moves_quantity/);
    await expect(
      db
        .insertInto('inventory_stock_moves')
        .values({ ...base, id: toBin(freshUuid()), quantity: '1', unit_cost_xaf: -1 })
        .execute(),
    ).rejects.toThrow(/ck_inventory_stock_moves_unit_cost/);
  });

  it('AT-016 / INV-STK-08 : 58 plateaux expédiés, 57 reçus — perte en transit validée, conservation respectée', async () => {
    const productId = await insertProduct('NONE');
    await move({
      productId,
      quantityBase: 100,
      fromLocationId: virtual.V_OPENING!,
      toLocationId: storeA,
      moveType: 'OPENING_BALANCE',
      declaredUnitCostXaf: 2000,
    });
    const policyId = freshUuid();
    await asAdmin('approvals.policy.set', 'CONTROL_POLICY', policyId, {
      code: `TRF_DISCREPANCY_${policyId.slice(-8)}`,
      operationType: 'TRANSFER_DISCREPANCY',
      requiresApproval: true,
      approverPermission: 'inventory.transfer_discrepancy.approve',
      approverScope: 'SITE',
    });

    const transferId = freshUuid();
    await asAdmin('inventory.transfer.dispatch', 'STOCK_TRANSFER', transferId, {
      fromLocationId: storeA,
      toLocationId: storeB,
      lines: [{ productId, unitCode: 'TETE', quantityBase: 58 }],
    });
    const line = await db
      .selectFrom('inventory_stock_transfer_lines')
      .select('id')
      .where('transfer_id', '=', toBin(transferId))
      .executeTakeFirstOrThrow();
    await asAdmin('inventory.transfer.receive', 'STOCK_TRANSFER', transferId, {
      transferId,
      lines: [{ transferLineId: fromBin(line.id), receivedQtyBase: 57 }],
    });
    const pending = await db
      .selectFrom('inventory_stock_transfers')
      .select(['status', 'approval_request_id'])
      .where('id', '=', toBin(transferId))
      .executeTakeFirstOrThrow();
    expect(pending.status).toBe('DISCREPANCY_PENDING');
    // Pendant la validation, l'écart est indisponible (V_PENDING_LOSS), ni à A ni à B.
    expect(await netForDocument(virtual.V_PENDING_LOSS!, transferId)).toBe(1);

    const requestId = fromBinOrNull(pending.approval_request_id)!;
    const approval = await pipeline.handle(
      envelope(approver, 'approvals.request.approve', 'APPROVAL_REQUEST', requestId, { requestId }),
      {
        authenticatedUserId: approver,
        authenticatedDeviceId: approverDevice,
        transport: 'ONLINE_API',
      },
    );
    expect(approval.status, JSON.stringify(approval)).toBe('APPLIED');

    const closed = await db
      .selectFrom('inventory_stock_transfers')
      .select('status')
      .where('id', '=', toBin(transferId))
      .executeTakeFirstOrThrow();
    expect(closed.status).toBe('CLOSED');

    // INV-STK-08 : par ligne, expédié = reçu + écart + retourné ; transit du transfert nul.
    const closedLine = await db
      .selectFrom('inventory_stock_transfer_lines')
      .select([
        'dispatched_qty_base',
        'received_qty_base',
        'discrepancy_qty_base',
        'returned_qty_base',
      ])
      .where('transfer_id', '=', toBin(transferId))
      .executeTakeFirstOrThrow();
    expect(Number(closedLine.dispatched_qty_base)).toBe(
      Number(closedLine.received_qty_base) +
        Number(closedLine.discrepancy_qty_base) +
        Number(closedLine.returned_qty_base),
    );
    expect(await netForDocument(virtual.V_TRANSIT!, transferId)).toBe(0);
    expect(await netForDocument(virtual.V_PENDING_LOSS!, transferId)).toBe(0);
    expect(await netForDocument(virtual.V_LOSS!, transferId)).toBe(1);

    expect(await balanceOf(productId, storeA)).toBe(42);
    expect(await balanceOf(productId, storeB)).toBe(57);
    // INV-STK-03 : conservation — Σ des soldes du produit sur tous les emplacements = 0.
    const total = await db
      .selectFrom('inventory_stock_balances')
      .select(sql<string>`SUM(qty_on_hand)`.as('qty'))
      .where('product_id', '=', toBin(productId))
      .executeTakeFirstOrThrow();
    expect(Number(total.qty)).toBe(0);
  });

  it('INV-STK-01 / INV-STK-03 : réconciliation quotidienne — écart détecté (LEDGER_MISMATCH), projection reconstruite', async () => {
    const productId = await insertProduct('NONE');
    await move({
      productId,
      quantityBase: 12,
      fromLocationId: virtual.V_OPENING!,
      toLocationId: storeA,
      moveType: 'OPENING_BALANCE',
      declaredUnitCostXaf: 300,
    });
    await move({
      productId,
      quantityBase: 4,
      fromLocationId: storeA,
      toLocationId: storeB,
      moveType: 'INTERNAL_MOVE',
      sourceDocType: 'TRANSFER',
    });

    const jobs = new JobHandlerRegistry();
    new LedgerReconciliationJob(jobs).onModuleInit();
    const reconcile = jobs.resolve(LEDGER_RECONCILIATION_JOB_TYPE)!;
    // Portée limitée au produit du test : la base de test est partagée (et, en exécution
    // parallèle, écrite par d'autres fichiers au même moment) — seul ce produit est altéré.
    const scope = { productIds: [productId] };
    const verify = () => db.transaction().execute((trx) => verifyStockLedger(trx, scope));

    expect((await verify()).ok).toBe(true);

    // Altération directe de la projection (hors registre) : exactement ce que le job doit voir.
    await db
      .updateTable('inventory_stock_balances')
      .set({ qty_on_hand: sql`qty_on_hand + 5` })
      .where('location_id', '=', toBin(storeA))
      .where('product_id', '=', toBin(productId))
      .execute();

    try {
      const verification = await verify();
      expect(verification.ok).toBe(false);
      expect(verification.mismatches).toEqual([
        { locationId: storeA, productId, lotId: null, projectedQty: 13, ledgerQty: 8 },
      ]);
      expect(verification.conservationBreaches).toEqual([{ productId, totalQty: 5 }]);
      // Le job, lui, vérifie toute la base : il voit au moins cette altération.
      await expect(db.transaction().execute((trx) => reconcile(trx, {}))).rejects.toThrow(
        /LEDGER_MISMATCH/,
      );
    } finally {
      // Réparation garantie, même si une assertion échoue : aucune altération ne reste en base.
      const corrected = await db.transaction().execute((trx) => rebuildStockBalances(trx, scope));
      expect(corrected).toBe(1);
    }

    expect(await balanceOf(productId, storeA)).toBe(8);
    expect((await verify()).ok).toBe(true);
    await db.transaction().execute((trx) => reconcile(trx, {}));
  });
});
