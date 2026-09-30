/**
 * P7-10 — répartition des frais généraux d'une ferme (ADR-026 amendé ; AV-104 à AV-106), à
 * travers le vrai pipeline :
 * - octobre, volaille : 63 000 XAF répartis entre deux lots au prorata têtes × jours
 *   (100 têtes × 31 j = 3 100 ; 200 têtes × 16 j = 3 200) → 31 000 et 32 000 XAF ; rien à
 *   répartir ensuite ; un frais saisi après → régularisation sur ce seul montant ;
 * - séparation des espèces (AV-104) : les frais du porc vont au seul lot de porcs ; un mois
 *   sans lot de l'espèce garde ses frais non répartis ;
 * - clôture d'un lot en cours de mois (AV-105) : part estimée sur les frais connus (têtes ×
 *   jours écoulés), puis la répartition du mois l'exclut ;
 * - refus : permission, mois futur, site qui n'est pas une ferme ; annulation d'un frais d'un
 *   mois déjà réparti.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerOverheadCommands as registerInventoryOverheadCommands } from '../src/modules/inventory/application/commands/overhead-commands.js';
import { registerLotCommands } from '../src/modules/production/application/commands/lot-commands.js';
import { registerOverheadCommands } from '../src/modules/production/application/commands/overhead-commands.js';
import {
  costObjectBalance,
  ensureSupplierLot,
  recordStockMove,
  virtualLocationId,
} from '../src/modules/inventory/application/public/index.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  insertTestDevice,
  insertTestLocation,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const NOW = '2026-11-05T12:00:00.000Z';
let deviceSeq = 0;

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

describe('P7-10 : répartition des frais généraux', () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let farmManager: Actor;
  let productionManager: Actor;
  let finance: Actor;
  let farmId: string;
  let storeSiteId: string;
  let buildingId: string;
  let storeId: string;
  let chickId: string;
  let broilerId: string;
  let pigletId: string;
  let pigId: string;
  let chickLotId: string;
  let pigletLotId: string;
  let lotA: string;
  let lotB: string;
  let pigLot: string;

  type Result = Awaited<ReturnType<CommandPipelineService['handle']>>;
  const code = (r: Result) => (r.status === 'REJECTED' ? r.error.code : r.status);

  async function run(
    actor: Actor,
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
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
        captured_offline: false,
        backdated_reason: null,
        attachment_ids: [],
        payload,
      },
      {
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        transport: 'ONLINE_API',
      },
    );
  }

  async function lot(
    lotType: string,
    productId: string,
    createdAt: string,
    placement: { readonly productId: string; readonly lotId: string; readonly quantity: number },
  ): Promise<string> {
    const id = freshUuid();
    const created = await run(
      productionManager,
      'production.lot.create',
      'PRODUCTION_LOT',
      id,
      createdAt,
      {
        lotType,
        productId,
        mainLocationId: buildingId,
      },
    );
    expect(created.status, JSON.stringify(created)).toBe('APPLIED');
    const placed = await run(
      farmManager,
      'production.lot.record_entry',
      'LOT_ENTRY',
      freshUuid(),
      createdAt,
      {
        productionLotId: id,
        sourceKind: 'INTERNAL_STOCK',
        sourceProductId: placement.productId,
        sourceLocationId: storeId,
        sourceStockLotId: placement.lotId,
        quantity: placement.quantity,
      },
    );
    expect(placed.status, JSON.stringify(placed)).toBe('APPLIED');
    return id;
  }

  async function overhead(
    occurredAt: string,
    lines: readonly { readonly speciesGroup: string; readonly amountXaf: number }[],
  ): Promise<string> {
    const id = freshUuid();
    const result = await run(
      productionManager,
      'inventory.overhead.record',
      'OVERHEAD_ENTRY',
      id,
      occurredAt,
      {
        siteId: farmId,
        label: 'Gardiennage et électricité',
        lines,
      },
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    return id;
  }

  const allocate = (
    speciesGroup: string,
    period: string,
    actor: Actor = finance,
    siteId: string = farmId,
  ) =>
    run(actor, 'production.overhead.allocate', 'OVERHEAD_ALLOCATION', freshUuid(), NOW, {
      siteId,
      speciesGroup,
      period,
    });

  const overheadsOf = async (lotId: string) =>
    (
      await costObjectBalance(db, {
        costObjectType: 'PRODUCTION_LOT',
        costObjectId: lotId,
        costTypes: ['FRAIS_GENERAUX'],
      })
    ).netXaf;

  async function linesOf(runId: string) {
    const rows = await db
      .selectFrom('production_overhead_allocation_lines')
      .select(['production_lot_id', 'head_days', 'amount_xaf'])
      .where('allocation_id', '=', toBin(runId))
      .execute();
    return new Map(
      rows.map((r) => [fromBin(r.production_lot_id), [Number(r.head_days), r.amount_xaf]]),
    );
  }

  async function lastRun(period: string, speciesGroup: string) {
    return db
      .selectFrom('production_overhead_allocations')
      .selectAll()
      .where('site_id', '=', toBin(farmId))
      .where('period', '=', period)
      .where('species_group', '=', speciesGroup)
      .orderBy('sequence', 'desc')
      .executeTakeFirstOrThrow();
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
    const sequences = new DocumentSequenceService();
    registerLotCommands(registry, idGenerator, sequences);
    registerInventoryOverheadCommands(registry, idGenerator);
    registerOverheadCommands(registry, idGenerator);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    const roles = {
      rfe: await roleId('RESP_FERME'),
      rpr: await roleId('RESP_PRODUCTION'),
      fin: await roleId('FINANCE'),
    };
    await db.transaction().execute(async (trx) => {
      const adminId = await insertTestUser(trx);
      const zoneId = await insertTestZone(trx, adminId);
      farmId = await insertTestSite(trx, adminId, zoneId, { siteType: 'FERME' });
      storeSiteId = await insertTestSite(trx, adminId, zoneId);
      buildingId = await insertTestLocation(trx, adminId, farmId, { locationType: 'BUILDING' });
      storeId = await insertTestLocation(trx, adminId, farmId);
      const actor = async (role: string, options: Parameters<typeof assignTestRole>[4] = {}) => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, adminId, options);
        return { userId, deviceId };
      };
      farmManager = await actor(roles.rfe, { scopeType: 'SITE', scopeSiteId: farmId });
      productionManager = await actor(roles.rpr);
      finance = await actor(roles.fin);

      if (
        !(await trx
          .selectFrom('catalog_units')
          .select('code')
          .where('code', '=', 'TETE')
          .executeTakeFirst())
      ) {
        await trx
          .insertInto('catalog_units')
          .values({ code: 'TETE', name: 'Tête', is_count: 1 })
          .execute();
      }
      const categoryId = freshUuid();
      await trx
        .insertInto('catalog_product_categories')
        .values({
          id: toBin(categoryId),
          code: `CAT-${categoryId.slice(-8)}`,
          name: 'Élevage',
          created_by: toBin(adminId),
        })
        .execute();
      const product = async (name: string, species: string) => {
        const id = freshUuid();
        await trx
          .insertInto('catalog_products')
          .values({
            id: toBin(id),
            code: `P-${id.slice(-10)}`,
            name,
            category_id: toBin(categoryId),
            stock_family: 'BIOLOGIQUE',
            species,
            base_unit_code: 'TETE',
            lot_tracking: 'REQUIRED',
            created_by: toBin(adminId),
          })
          .execute();
        return id;
      };
      chickId = await product('Poussin', 'POULET_CHAIR');
      broilerId = await product('Poulet de chair vif', 'POULET_CHAIR');
      pigletId = await product('Porcelet', 'PORC');
      pigId = await product('Porc charcutier', 'PORC');
      const supplierId = freshUuid();
      await trx
        .insertInto('procurement_suppliers')
        .values({
          id: toBin(supplierId),
          code: `F-${supplierId.slice(-10)}`,
          name: 'Fournisseur',
          supplied_categories: JSON.stringify([]),
          status: 'ACTIVE',
          created_by: toBin(adminId),
        })
        .execute();
      const stock = async (productId: string, ref: string, quantity: number, cost: number) => {
        const lotId = await ensureSupplierLot(
          trx,
          { idGenerator },
          {
            productId,
            supplierId,
            supplierLotRef: `${ref}-${supplierId.slice(-6)}`,
            fallbackCode: `F:${ref}-${supplierId.slice(-6)}`,
            expiryDate: null,
            originId: freshUuid(),
            fifoRankAt: new Date('2026-09-01T05:00:00.000Z'),
            createdBy: adminId,
          },
        );
        await recordStockMove(
          trx,
          { idGenerator },
          {
            productId,
            lotId,
            quantityBase: quantity,
            fromLocationId: await virtualLocationId(trx, 'V_OPENING'),
            toLocationId: storeId,
            moveType: 'OPENING_BALANCE',
            declaredUnitCostXaf: cost,
            occurredAt: new Date('2026-09-01T05:00:00.000Z'),
            sourceDocType: 'INVENTORY_COUNT',
            sourceDocId: freshUuid(),
            createdBy: adminId,
            allowNegative: false,
          },
        );
        return lotId;
      };
      chickLotId = await stock(chickId, 'PC', 1000, 500);
      pigletLotId = await stock(pigletId, 'PG', 10, 20_000);
    });

    // Octobre : lot A (100 têtes dès le 1er), lot B (200 têtes dès le 16), 10 porcs dès le 1er.
    lotA = await lot('POULET_CHAIR', broilerId, '2026-10-01T10:00:00.000Z', {
      productId: chickId,
      lotId: chickLotId,
      quantity: 100,
    });
    lotB = await lot('POULET_CHAIR', broilerId, '2026-10-16T10:00:00.000Z', {
      productId: chickId,
      lotId: chickLotId,
      quantity: 200,
    });
    pigLot = await lot('PORC_ENGRAISSEMENT', pigId, '2026-10-01T10:00:00.000Z', {
      productId: pigletId,
      lotId: pigletLotId,
      quantity: 10,
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('octobre : prorata têtes × jours au franc près, puis régularisation du seul montant nouveau', async () => {
    const entryId = await overhead('2026-10-20T09:00:00.000Z', [
      { speciesGroup: 'VOLAILLE', amountXaf: 63_000 },
      { speciesGroup: 'PORC', amountXaf: 10_000 },
    ]);
    expect(code(await allocate('VOLAILLE', '2026-10', farmManager))).toBe('FORBIDDEN');
    const first = await allocate('VOLAILLE', '2026-10');
    expect(first).toMatchObject({
      status: 'APPLIED',
      server_refs: { runKind: 'INITIAL', allocatedXaf: '63000', lots: '2' },
    });
    const run1 = await lastRun('2026-10', 'VOLAILLE');
    expect(run1).toMatchObject({
      run_kind: 'INITIAL',
      sequence: 1,
      pool_xaf: 63_000,
      allocated_xaf: 63_000,
    });
    expect(Number(run1.head_days_total)).toBe(6300);
    const lines = await linesOf(fromBin(run1.id));
    expect(lines.get(lotA)).toEqual([3100, 31_000]);
    expect(lines.get(lotB)).toEqual([3200, 32_000]);
    expect(await overheadsOf(lotA)).toBe(31_000);
    expect(await overheadsOf(lotB)).toBe(32_000);
    expect(await overheadsOf(pigLot)).toBe(0);

    expect(code(await allocate('VOLAILLE', '2026-10'))).toBe('NOTHING_TO_ALLOCATE');
    // Le mois est réparti : la saisie ne s'annule plus (inventory, ADR-026).
    expect(
      code(
        await run(productionManager, 'inventory.overhead.cancel', 'OVERHEAD_ENTRY', entryId, NOW, {
          entryId,
          comment: 'Erreur',
        }),
      ),
    ).toBe('OVERHEAD_ALREADY_ALLOCATED');

    await overhead('2026-10-28T09:00:00.000Z', [{ speciesGroup: 'VOLAILLE', amountXaf: 6_300 }]);
    const second = await allocate('VOLAILLE', '2026-10', productionManager);
    expect(second).toMatchObject({
      status: 'APPLIED',
      server_refs: { runKind: 'REGULARIZATION', allocatedXaf: '6300' },
    });
    expect((await lastRun('2026-10', 'VOLAILLE')).sequence).toBe(2);
    expect(await overheadsOf(lotA)).toBe(34_100);
    expect(await overheadsOf(lotB)).toBe(35_200);
  });

  it('espèces séparées ; mois sans lot : frais conservés ; refus', async () => {
    expect(await allocate('PORC', '2026-10')).toMatchObject({
      status: 'APPLIED',
      server_refs: { runKind: 'INITIAL', allocatedXaf: '10000', lots: '1' },
    });
    expect(await overheadsOf(pigLot)).toBe(10_000);
    expect(await overheadsOf(lotA)).toBe(34_100);

    await overhead('2026-09-15T09:00:00.000Z', [{ speciesGroup: 'PORC', amountXaf: 5_000 }]);
    expect(code(await allocate('PORC', '2026-09'))).toBe('NO_LOT_TO_ALLOCATE');
    const pool = await costObjectBalance(db, {
      costObjectType: 'SITE',
      costObjectId: farmId,
      costTypes: ['FRAIS_GENERAUX'],
      speciesGroup: 'PORC',
      from: new Date('2026-08-31T23:00:00.000Z'),
      at: new Date('2026-09-30T22:59:59.999Z'),
    });
    expect(pool.netXaf).toBe(5_000);

    expect(code(await allocate('VOLAILLE', '2026-12'))).toBe('PERIOD_INVALID');
    expect(code(await allocate('VOLAILLE', '2026-10', finance, storeSiteId))).toBe('SITE_NOT_FARM');
  });

  it('AV-105 : clôture en cours de mois → part estimée ; la répartition du mois exclut le lot clos', async () => {
    await overhead('2026-11-03T09:00:00.000Z', [{ speciesGroup: 'VOLAILLE', amountXaf: 10_000 }]);
    // Lot C : 50 têtes du 1er au 3 novembre, transférées au lot A le 4.
    const lotC = await lot('POULET_CHAIR', broilerId, '2026-11-01T10:00:00.000Z', {
      productId: chickId,
      lotId: chickLotId,
      quantity: 50,
    });
    const moved = await run(
      farmManager,
      'production.lot.record_entry',
      'LOT_ENTRY',
      freshUuid(),
      '2026-11-04T10:00:00.000Z',
      {
        productionLotId: lotA,
        sourceKind: 'TRANSFER',
        sourceProductionLotId: lotC,
        sourceLocationId: buildingId,
        quantity: 50,
      },
    );
    expect(moved.status, JSON.stringify(moved)).toBe('APPLIED');

    const closed = await run(
      productionManager,
      'production.lot.close',
      'PRODUCTION_LOT',
      lotC,
      NOW,
      {},
    );
    expect(closed.status, JSON.stringify(closed)).toBe('APPLIED');
    // Têtes × jours du 1er au 5 novembre : A 100 × 3 + 150 × 2 = 600 ; B 200 × 5 = 1 000 ;
    // C 50 × 3 = 150 ; part de C = 10 000 × 150 / 1 750 → 857 XAF.
    const estimate = await lastRun('2026-11', 'VOLAILLE');
    expect(estimate).toMatchObject({
      run_kind: 'CLOSING_ESTIMATE',
      sequence: 1,
      pool_xaf: 10_000,
      allocated_xaf: 857,
    });
    expect(fromBin(estimate.production_lot_id!)).toBe(lotC);
    expect(Number(estimate.head_days_total)).toBe(1750);
    expect(await overheadsOf(lotC)).toBe(857);
    const summary = (
      await db
        .selectFrom('production_production_lots')
        .select('closing_summary')
        .where('id', '=', toBin(lotC))
        .executeTakeFirstOrThrow()
    ).closing_summary;
    expect(summary).toMatchObject({
      overheadXaf: 857,
      overheadEstimateXaf: 857,
      unrecoveredCostXaf: 857,
    });

    // Répartition de novembre : 9 143 XAF restants entre A (600) et B (1 000), sans C.
    expect(await allocate('VOLAILLE', '2026-11')).toMatchObject({
      status: 'APPLIED',
      server_refs: { runKind: 'INITIAL', allocatedXaf: '9143', lots: '2' },
    });
    const run2 = await lastRun('2026-11', 'VOLAILLE');
    const lines = await linesOf(fromBin(run2.id));
    expect(lines.get(lotA)).toEqual([600, 3_429]);
    expect(lines.get(lotB)).toEqual([1000, 5_714]);
    expect(lines.has(lotC)).toBe(false);
    expect(await overheadsOf(lotC)).toBe(857);
  });
});
