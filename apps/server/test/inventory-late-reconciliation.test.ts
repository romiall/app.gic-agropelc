/**
 * Rapprochement tardif d'inventaire (BR-STK-044, BR-STK-045, AT-021, INV-STK-09) à travers le vrai pipeline de
 * commande et le vrai enregistreur de mouvements.
 *
 * Scénario WF-08 : un fait saisi hors ligne, daté d'avant le comptage, est synchronisé après la comptabilisation de
 * l'inventaire. Le solde à `counted_at` doit rester la quantité comptée : un ajustement compensatoire daté du comptage
 * (motif `RAPPROCHEMENT_INVENTAIRE`, acteur système) le rétablit, l'écart constaté reste, l'écart net est mis à jour.
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
import {
  recordStockMove,
  type RecordMoveDeps,
} from '../src/modules/inventory/application/public/index.js';
import {
  bucketBalance,
  ledgerBucketsAt,
} from '../src/modules/inventory/application/count-ledger.js';
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

const DAY = '2026-10-02';
const at = (hhmm: string): Date => new Date(`${DAY}T${hhmm}:00.000Z`);
/** Horloge du serveur : après tous les comptages et soumissions du fichier. */
const NOW = at('15:00');
const REASON_CODE = 'RAPPROCHEMENT_INVENTAIRE';

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
  return {
    command_id: freshUuid(),
    device_seq: 1,
    command_version: 1,
    author_user_id: authorUserId,
    base_version: null,
    depends_on: [],
    occurred_at: at('14:00').toISOString(),
    client_created_at: at('14:00').toISOString(),
    captured_offline: false,
    backdated_reason: null,
    attachment_ids: [],
    ...overrides,
  };
}

describe('rapprochement tardif d’inventaire (BR-STK-044, BR-STK-045, AT-021, INV-STK-09)', () => {
  let clock: Clock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let moveDeps: RecordMoveDeps;
  let admin: string;
  let adminDevice: string;
  let approver: string;
  let approverDevice: string;
  let siteId: string;
  let customerLocationId: string;
  let supplierLocationId: string;
  let systemUserId: string | null;
  /** Tous les inventaires comptabilisés par ce fichier : balayage final d'INV-STK-09. */
  const postedCounts: string[] = [];

  beforeAll(async () => {
    clock = new FixedClock(NOW);
    idGenerator = new Uuidv7Generator(clock);
    moveDeps = { idGenerator };
    const decisionRegistry = new ApprovalDecisionHandlerRegistry();
    const registry = new CommandHandlerRegistry();
    registerCountCommands(registry, decisionRegistry, idGenerator, new DocumentSequenceService());
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
      const adminRole = await insertTestRole(trx, admin);
      await grantTestPermission(trx, adminRole, 'inventory.count.perform', admin);
      await grantTestPermission(trx, adminRole, 'approvals.policy.manage', admin);
      await assignTestRole(trx, admin, adminRole, admin);
      const approverRole = await insertTestRole(trx, approver, { allowedScopeTypes: ['SITE'] });
      await grantTestPermission(trx, approverRole, 'approvals.request.read', admin, {
        maxScope: 'ALL',
      });
      await grantTestPermission(trx, approverRole, 'inventory.count.approve', admin, {
        maxScope: 'SITE',
      });
      await assignTestRole(trx, approver, approverRole, admin, {
        scopeType: 'SITE',
        scopeSiteId: siteId,
      });
    });

    const policyId = freshUuid();
    const policy = await pipeline.handle(
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
    expect(policy.status).toBe('APPLIED');

    const virtual = async (locationType: string): Promise<string> =>
      fromBin(
        (
          await db
            .selectFrom('organization_locations')
            .select('id')
            .where('location_type', '=', locationType)
            .executeTakeFirstOrThrow()
        ).id,
      );
    customerLocationId = await virtual('V_CUSTOMER');
    supplierLocationId = await virtual('V_SUPPLIER');

    // Le motif du système (semé en base réelle) : posé ici s'il manque, pour des assertions déterministes.
    const reason = await db
      .selectFrom('catalog_reason_codes')
      .select('id')
      .where('category', '=', 'INVENTORY_ADJUSTMENT')
      .where('code', '=', REASON_CODE)
      .executeTakeFirst();
    if (!reason) {
      await db
        .insertInto('catalog_reason_codes')
        .values({
          id: toBin(freshUuid()),
          category: 'INVENTORY_ADJUSTMENT',
          code: REASON_CODE,
          label: 'Rapprochement tardif d’inventaire (automatique)',
          created_by: toBin(admin),
        })
        .execute();
    }
    const system = await db
      .selectFrom('identity_users')
      .select('id')
      .where('is_system', '=', 1)
      .orderBy('created_at')
      .limit(1)
      .executeTakeFirst();
    systemUserId = system ? fromBin(system.id) : null;
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
    return db
      .transaction()
      .execute((trx) => insertTestLocation(trx, admin, siteId, { locationType: 'STORE' }));
  }

  async function insertProduct(tracking: 'NONE' | 'OPTIONAL'): Promise<string> {
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
    const unit = await db
      .selectFrom('catalog_units')
      .select('code')
      .where('code', '=', 'TETE')
      .executeTakeFirst();
    if (!unit) {
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
        name: 'Produit de test rapprochement',
        category_id: toBin(categoryId),
        stock_family: 'MARCHANDISE',
        base_unit_code: 'TETE',
        lot_tracking: tracking,
        created_by: toBin(admin),
      })
      .execute();
    return productId;
  }

  async function insertLot(productId: string, day: string): Promise<string> {
    const lotId = freshUuid();
    await db
      .insertInto('inventory_stock_lots')
      .values({
        id: toBin(lotId),
        lot_code: `LOT-${lotId.slice(-8)}`,
        product_id: toBin(productId),
        origin_type: 'SUPPLIER_LOT',
        fifo_rank_at: new Date(`${day}T00:00:00.000Z`),
        created_by: toBin(admin),
      })
      .execute();
    return lotId;
  }

  async function opening(
    productId: string,
    locationId: string,
    quantityBase: number,
    unitCostXaf: number,
    lotId?: string,
  ): Promise<void> {
    const v = await db
      .selectFrom('organization_locations')
      .select('id')
      .where('location_type', '=', 'V_OPENING')
      .executeTakeFirstOrThrow();
    await db.transaction().execute((trx) =>
      recordStockMove(trx, moveDeps, {
        productId,
        ...(lotId !== undefined ? { lotId } : {}),
        quantityBase,
        fromLocationId: fromBin(v.id),
        toLocationId: locationId,
        moveType: 'OPENING_BALANCE',
        declaredUnitCostXaf: unitCostXaf,
        occurredAt: at('09:00'),
        sourceDocType: 'INVENTORY_COUNT',
        sourceDocId: freshUuid(),
        createdBy: admin,
        allowNegative: false,
      }),
    );
  }

  /** Une sortie (vente) saisie hors ligne, datée de `occurredAt`, enregistrée maintenant. */
  async function lateSale(
    productId: string,
    locationId: string,
    quantityBase: number,
    occurredAt: Date,
    lotId: string | null = null,
  ): Promise<void> {
    await db.transaction().execute((trx) =>
      recordStockMove(trx, moveDeps, {
        productId,
        lotId,
        quantityBase,
        fromLocationId: locationId,
        toLocationId: customerLocationId,
        moveType: 'SALE',
        occurredAt,
        sourceDocType: 'SALE',
        sourceDocId: freshUuid(),
        createdBy: admin,
        capturedOffline: true,
        allowNegative: true,
      }),
    );
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

  async function recordLines(
    countId: string,
    lines: readonly {
      readonly productId: string;
      readonly countedQtyBase: number;
      readonly lotId?: string;
    }[],
    countedAt: Date = at('12:00'),
  ): Promise<void> {
    const result = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.count.record_lines',
        aggregate_type: 'INVENTORY_COUNT',
        aggregate_id: countId,
        payload: {
          countId,
          lines: lines.map((line) => ({ ...line, countedAt: countedAt.toISOString() })),
        },
      }),
      adminCtx(),
    );
    expect(result.status).toBe('APPLIED');
  }

  async function submit(countId: string) {
    return pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.count.submit',
        aggregate_type: 'INVENTORY_COUNT',
        aggregate_id: countId,
        payload: { countId },
      }),
      adminCtx(),
    );
  }

  async function submitPosted(countId: string): Promise<void> {
    const result = await submit(countId);
    expect(result.status).toBe('APPLIED');
    const row = await countRow(countId);
    expect(row.status).toBe('POSTED');
    postedCounts.push(countId);
  }

  async function countRow(countId: string) {
    return db
      .selectFrom('inventory_inventory_counts')
      .select(['status', 'variance_value_xaf', 'net_variance_after_reconciliation_xaf', 'version'])
      .where('id', '=', toBin(countId))
      .executeTakeFirstOrThrow();
  }

  async function linesOf(countId: string) {
    return db
      .selectFrom('inventory_inventory_count_lines')
      .selectAll()
      .where('count_id', '=', toBin(countId))
      .orderBy('id', 'asc')
      .execute();
  }

  /** Solde (unités) de la portée donnée à `time`, lu dans le registre (sans verrou). */
  async function balanceAt(
    locationId: string,
    productId: string,
    time: Date,
    scope: 'LOT' | 'NO_LOT' | 'ALL_LOTS' = 'ALL_LOTS',
    lotId: string | null = null,
  ): Promise<number> {
    const buckets = await db
      .transaction()
      .execute((trx) => ledgerBucketsAt(trx, { locationId, productId, at: time, lock: false }));
    return bucketBalance(buckets, scope, lotId);
  }

  async function balanceOf(productId: string, locationId: string): Promise<number> {
    const rows = await db
      .selectFrom('inventory_stock_balances')
      .select('qty_on_hand')
      .where('location_id', '=', toBin(locationId))
      .where('product_id', '=', toBin(productId))
      .execute();
    return rows.reduce((sum, row) => sum + Number(row.qty_on_hand), 0);
  }

  /** Les mouvements de rapprochement d'un inventaire (motif du système), du plus ancien au plus récent. */
  async function reconciliationMoves(countId: string) {
    const reason = await db
      .selectFrom('catalog_reason_codes')
      .select('id')
      .where('category', '=', 'INVENTORY_ADJUSTMENT')
      .where('code', '=', REASON_CODE)
      .executeTakeFirstOrThrow();
    const rows = await db
      .selectFrom('inventory_stock_moves')
      .select([
        'move_type',
        'quantity',
        'lot_id',
        'occurred_at',
        'created_by',
        'source_line_id',
        'unit_cost_xaf',
        'value_xaf',
      ])
      .where('source_doc_id', '=', toBin(countId))
      .where('reason_code_id', '=', reason.id)
      .orderBy('recorded_at', 'asc')
      .execute();
    return rows.map((row) => ({
      moveType: row.move_type,
      quantity: Number(row.quantity),
      lotId: fromBinOrNull(row.lot_id),
      occurredAt: row.occurred_at,
      createdBy: fromBin(row.created_by),
      lineId: fromBinOrNull(row.source_line_id),
      unitCostXaf: Number(row.unit_cost_xaf),
      valueXaf: Number(row.value_xaf),
    }));
  }

  it('WF-08 / AT-021 : une vente tardive d’avant le comptage est rapprochée — solde à counted_at = compté, écart net −2', async () => {
    const locationId = await newStore();
    const productId = await insertProduct('NONE');
    await opening(productId, locationId, 100, 500);
    const countId = await openCount(locationId);
    await recordLines(countId, [{ productId, countedQtyBase: 97 }]);
    await submitPosted(countId);
    expect(await balanceAt(locationId, productId, at('12:00'))).toBe(97);
    expect(await reconciliationMoves(countId)).toHaveLength(0);

    // La vente de 10:00, saisie hors ligne, n'arrive qu'après la comptabilisation.
    await lateSale(productId, locationId, 1, at('10:00'));

    expect(await balanceAt(locationId, productId, at('12:00'))).toBe(97); // INV-STK-09
    expect(await balanceOf(productId, locationId)).toBe(97); // 100 − 3 (écart) − 1 (vente) + 1 (rapprochement)
    const moves = await reconciliationMoves(countId);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({
      moveType: 'INVENTORY_GAIN',
      quantity: 1,
      lotId: null,
      unitCostXaf: 500,
      valueXaf: 500,
    });
    expect(moves[0]!.occurredAt.toISOString()).toBe(at('12:00').toISOString()); // daté du comptage
    if (systemUserId !== null) expect(moves[0]!.createdBy).toBe(systemUserId);
    const [line] = await linesOf(countId);
    expect(moves[0]!.lineId).toBe(fromBin(line!.id));
    expect(Number(line!.variance_qty_base)).toBe(-3); // l'écart constaté ne change pas
    expect(Number(line!.reconciled_adjustment_qty_base)).toBe(1);
    const count = await countRow(countId);
    expect(Number(count.variance_value_xaf)).toBe(-1500);
    expect(Number(count.net_variance_after_reconciliation_xaf)).toBe(-1000); // −3 + 1 = −2 unités à 500
  });

  it('un mouvement daté d’après le comptage ne se rapproche pas', async () => {
    const locationId = await newStore();
    const productId = await insertProduct('NONE');
    await opening(productId, locationId, 100, 500);
    const countId = await openCount(locationId);
    await recordLines(countId, [{ productId, countedQtyBase: 97 }]);
    await submitPosted(countId);

    await lateSale(productId, locationId, 2, at('13:00'));

    expect(await reconciliationMoves(countId)).toHaveLength(0);
    expect(await balanceAt(locationId, productId, at('12:00'))).toBe(97);
    expect(await balanceOf(productId, locationId)).toBe(95);
    const [line] = await linesOf(countId);
    expect(Number(line!.reconciled_adjustment_qty_base)).toBe(0);
    expect((await countRow(countId)).net_variance_after_reconciliation_xaf).toBeNull();
  });

  it('un mouvement daté d’avant le comptage mais enregistré avant la soumission entre dans le théorique', async () => {
    const locationId = await newStore();
    const productId = await insertProduct('NONE');
    await opening(productId, locationId, 100, 500);
    await lateSale(productId, locationId, 1, at('10:00'));
    const countId = await openCount(locationId);
    await recordLines(countId, [{ productId, countedQtyBase: 97 }]);
    await submitPosted(countId);

    const [line] = await linesOf(countId);
    expect(Number(line!.theoretical_qty_base)).toBe(99);
    expect(Number(line!.variance_qty_base)).toBe(-2);
    expect(await reconciliationMoves(countId)).toHaveLength(0);
    expect(await balanceAt(locationId, productId, at('12:00'))).toBe(97);
  });

  it('une entrée tardive (réception d’avant le comptage) donne un rapprochement en perte', async () => {
    const locationId = await newStore();
    const productId = await insertProduct('NONE');
    await opening(productId, locationId, 100, 500);
    const countId = await openCount(locationId);
    await recordLines(countId, [{ productId, countedQtyBase: 97 }]);
    await submitPosted(countId);

    await db.transaction().execute((trx) =>
      recordStockMove(trx, moveDeps, {
        productId,
        quantityBase: 5,
        fromLocationId: supplierLocationId,
        toLocationId: locationId,
        moveType: 'PURCHASE_RECEIPT',
        declaredUnitCostXaf: 500,
        occurredAt: at('11:00'),
        sourceDocType: 'GOODS_RECEIPT',
        sourceDocId: freshUuid(),
        createdBy: admin,
        capturedOffline: true,
        allowNegative: false,
      }),
    );

    expect(await balanceAt(locationId, productId, at('12:00'))).toBe(97);
    const moves = await reconciliationMoves(countId);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ moveType: 'INVENTORY_LOSS', quantity: 5 });
    const [line] = await linesOf(countId);
    expect(Number(line!.reconciled_adjustment_qty_base)).toBe(-5);
    // théorique réel 105 pour un compté de 97 : l'écart net est −8 unités à 500.
    expect(Number((await countRow(countId)).net_variance_after_reconciliation_xaf)).toBe(-4000);
  });

  it('plusieurs faits tardifs s’additionnent ; le rapprochement ne se rapproche pas à son tour', async () => {
    const locationId = await newStore();
    const productId = await insertProduct('NONE');
    await opening(productId, locationId, 100, 500);
    const countId = await openCount(locationId);
    await recordLines(countId, [{ productId, countedQtyBase: 97 }]);
    await submitPosted(countId);

    await lateSale(productId, locationId, 1, at('10:00'));
    await lateSale(productId, locationId, 1, at('11:30'));

    const moves = await reconciliationMoves(countId);
    expect(moves.map((move) => move.quantity)).toEqual([1, 1]);
    expect(await balanceAt(locationId, productId, at('12:00'))).toBe(97);
    const [line] = await linesOf(countId);
    expect(Number(line!.reconciled_adjustment_qty_base)).toBe(2);
    expect(Number((await countRow(countId)).net_variance_after_reconciliation_xaf)).toBe(-500); // −3 + 2
  });

  it('par lot : un fait tardif sur un lot ne rapproche que la ligne de ce lot', async () => {
    const locationId = await newStore();
    const productId = await insertProduct('OPTIONAL');
    const lotA = await insertLot(productId, '2026-09-01');
    const lotB = await insertLot(productId, '2026-09-15');
    await opening(productId, locationId, 4, 500, lotA);
    await opening(productId, locationId, 6, 500, lotB);
    const countId = await openCount(locationId);
    await recordLines(countId, [
      { productId, lotId: lotA, countedQtyBase: 4 },
      { productId, lotId: lotB, countedQtyBase: 5 },
    ]);
    await submitPosted(countId);
    const lines = await linesOf(countId);
    expect(lines.map((line) => Boolean(line.all_lots))).toEqual([false, false]);

    await lateSale(productId, locationId, 1, at('10:00'), lotA);

    const moves = await reconciliationMoves(countId);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ moveType: 'INVENTORY_GAIN', quantity: 1, lotId: lotA });
    expect(await balanceAt(locationId, productId, at('12:00'), 'LOT', lotA)).toBe(4);
    expect(await balanceAt(locationId, productId, at('12:00'), 'LOT', lotB)).toBe(5);
  });

  it('BR-STK-045 : un total sans détail de lots se répartit — la perte prend le plus ancien lot d’abord', async () => {
    const locationId = await newStore();
    const productId = await insertProduct('OPTIONAL');
    const lotA = await insertLot(productId, '2026-09-01');
    const lotB = await insertLot(productId, '2026-09-15');
    await opening(productId, locationId, 4, 500, lotA);
    await opening(productId, locationId, 6, 500, lotB);
    const countId = await openCount(locationId);
    await recordLines(countId, [{ productId, countedQtyBase: 7 }]); // total sans lot
    await submitPosted(countId);

    const [line] = await linesOf(countId);
    expect(Boolean(line!.all_lots)).toBe(true);
    expect(Number(line!.theoretical_qty_base)).toBe(10);
    expect(Number(line!.variance_qty_base)).toBe(-3);
    expect(await balanceAt(locationId, productId, at('12:00'), 'LOT', lotA)).toBe(1); // 4 − 3
    expect(await balanceAt(locationId, productId, at('12:00'), 'LOT', lotB)).toBe(6);
    expect(await balanceAt(locationId, productId, at('12:00'))).toBe(7);

    // Un fait tardif sur le lot B : le rapprochement porte sur le lot du fait, le total revient au compté.
    await lateSale(productId, locationId, 1, at('10:00'), lotB);
    const moves = await reconciliationMoves(countId);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ moveType: 'INVENTORY_GAIN', quantity: 1, lotId: lotB });
    expect(await balanceAt(locationId, productId, at('12:00'))).toBe(7);
  });

  it('BR-STK-045 : le gain d’un total sans détail va au lot le plus récent', async () => {
    const locationId = await newStore();
    const productId = await insertProduct('OPTIONAL');
    const lotA = await insertLot(productId, '2026-09-01');
    const lotB = await insertLot(productId, '2026-09-15');
    await opening(productId, locationId, 4, 500, lotA);
    await opening(productId, locationId, 6, 500, lotB);
    const countId = await openCount(locationId);
    await recordLines(countId, [{ productId, countedQtyBase: 12 }]);
    await submitPosted(countId);

    expect(await balanceAt(locationId, productId, at('12:00'), 'LOT', lotA)).toBe(4);
    expect(await balanceAt(locationId, productId, at('12:00'), 'LOT', lotB)).toBe(8); // 6 + 2
    expect(await balanceAt(locationId, productId, at('12:00'))).toBe(12);
  });

  it('une ligne sans lot qui accompagne des lignes de lots reste le seul solde sans lot', async () => {
    const locationId = await newStore();
    const productId = await insertProduct('OPTIONAL');
    const lotA = await insertLot(productId, '2026-09-01');
    await opening(productId, locationId, 4, 500, lotA);
    const countId = await openCount(locationId);
    await recordLines(countId, [
      { productId, lotId: lotA, countedQtyBase: 4 },
      { productId, countedQtyBase: 2 }, // le reste sans lot
    ]);
    await submitPosted(countId);

    const lines = await linesOf(countId);
    const lotLess = lines.find((line) => line.lot_id === null)!;
    expect(Boolean(lotLess.all_lots)).toBe(false);
    expect(Number(lotLess.theoretical_qty_base)).toBe(0);
    expect(Number(lotLess.variance_qty_base)).toBe(2);
    expect(await balanceAt(locationId, productId, at('12:00'), 'LOT', lotA)).toBe(4); // le lot n'est pas touché
    expect(await balanceAt(locationId, productId, at('12:00'), 'NO_LOT')).toBe(2);
  });

  it('inventaire à valider : le fait tardif arrivé entre la soumission et la décision est rapproché à la comptabilisation', async () => {
    const locationId = await newStore();
    const productId = await insertProduct('NONE');
    await opening(productId, locationId, 100, 1000);
    const countId = await openCount(locationId);
    await recordLines(countId, [{ productId, countedQtyBase: 130 }]); // +30 000 : au-dessus du seuil
    const submitted = await submit(countId);
    expect(submitted.status).toBe('APPLIED');
    expect((await countRow(countId)).status).toBe('PENDING_APPROVAL');

    // Pas encore comptabilisé : rien à rapprocher à l'arrivée du fait.
    await lateSale(productId, locationId, 1, at('10:00'));
    expect(await reconciliationMoves(countId)).toHaveLength(0);

    const pending = await db
      .selectFrom('inventory_inventory_counts')
      .select('approval_request_id')
      .where('id', '=', toBin(countId))
      .executeTakeFirstOrThrow();
    const requestId = fromBinOrNull(pending.approval_request_id)!;
    const approved = await pipeline.handle(
      buildEnvelope(approver, {
        command_type: 'approvals.request.approve',
        aggregate_type: 'APPROVAL_REQUEST',
        aggregate_id: requestId,
        payload: { requestId },
      }),
      approverCtx(),
    );
    expect(approved.status).toBe('APPLIED');
    expect((await countRow(countId)).status).toBe('POSTED');
    postedCounts.push(countId);

    // L'écart approuvé (+30) est appliqué tel quel ; la dérive (−1) est rapprochée.
    expect(await balanceAt(locationId, productId, at('12:00'))).toBe(130);
    const moves = await reconciliationMoves(countId);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ moveType: 'INVENTORY_GAIN', quantity: 1 });
    const [line] = await linesOf(countId);
    expect(Number(line!.variance_qty_base)).toBe(30);
    expect(Number(line!.reconciled_adjustment_qty_base)).toBe(1);
    expect(Number((await countRow(countId)).net_variance_after_reconciliation_xaf)).toBe(31_000);
  });

  it('deux inventaires comptabilisés : seul le plus ancien compense, le solde de l’autre reste le compté', async () => {
    const locationId = await newStore();
    const productId = await insertProduct('NONE');
    await opening(productId, locationId, 100, 500);

    const first = await openCount(locationId);
    await recordLines(first, [{ productId, countedQtyBase: 98 }], at('11:00'));
    await submitPosted(first);
    const second = await openCount(locationId);
    await recordLines(second, [{ productId, countedQtyBase: 96 }], at('12:00'));
    await submitPosted(second);
    expect(await balanceAt(locationId, productId, at('11:00'))).toBe(98);
    expect(await balanceAt(locationId, productId, at('12:00'))).toBe(96);

    await lateSale(productId, locationId, 1, at('10:00')); // avant les deux comptages

    expect(await reconciliationMoves(first)).toHaveLength(1);
    expect(await reconciliationMoves(second)).toHaveLength(0);
    expect(await balanceAt(locationId, productId, at('11:00'))).toBe(98);
    expect(await balanceAt(locationId, productId, at('12:00'))).toBe(96);
  });

  it('un fait validé par une transaction concurrente pendant l’attente des soldes est vu par la soumission', async () => {
    const locationId = await newStore();
    const productId = await insertProduct('NONE');
    await opening(productId, locationId, 100, 500);
    const countId = await openCount(locationId);
    await recordLines(countId, [{ productId, countedQtyBase: 97 }]);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inserted!: () => void;
    const insertedMove = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    // La vente tardive tient le solde et ne valide qu'au signal : la soumission l'attend.
    const concurrent = db.transaction().execute(async (trx) => {
      await recordStockMove(trx, moveDeps, {
        productId,
        lotId: null,
        quantityBase: 1,
        fromLocationId: locationId,
        toLocationId: customerLocationId,
        moveType: 'SALE',
        occurredAt: at('10:00'),
        sourceDocType: 'SALE',
        sourceDocId: freshUuid(),
        createdBy: admin,
        capturedOffline: true,
        allowNegative: true,
      });
      inserted();
      await gate;
    });
    await insertedMove;
    const submitting = submit(countId);
    await new Promise((resolve) => setTimeout(resolve, 600));
    release();
    await concurrent;
    const result = await submitting;
    expect(result.status).toBe('APPLIED');
    postedCounts.push(countId);

    const [line] = await linesOf(countId);
    expect(Number(line!.theoretical_qty_base)).toBe(99); // la vente concurrente est comptée
    expect(await balanceAt(locationId, productId, at('12:00'))).toBe(97);
    expect(await reconciliationMoves(countId)).toHaveLength(0); // aucune dérive à rapprocher
  });

  it('INV-STK-09 : le solde de chaque ligne de chaque inventaire comptabilisé ici est la quantité comptée', async () => {
    expect(postedCounts.length).toBeGreaterThan(0);
    for (const countId of postedCounts) {
      const count = await db
        .selectFrom('inventory_inventory_counts')
        .select(['location_id'])
        .where('id', '=', toBin(countId))
        .executeTakeFirstOrThrow();
      for (const line of await linesOf(countId)) {
        const scope = line.lot_id !== null ? 'LOT' : line.all_lots ? 'ALL_LOTS' : 'NO_LOT';
        const balance = await balanceAt(
          fromBin(count.location_id),
          fromBin(line.product_id),
          line.counted_at,
          scope,
          fromBinOrNull(line.lot_id),
        );
        expect(balance, `ligne ${fromBin(line.id)} (${scope})`).toBe(Number(line.counted_qty_base));
      }
    }
  });
});
