/**
 * P7-06 — saisie du jour d'un lot, à travers le vrai pipeline (UC-PRD-03 à 06) :
 * - mortalité : déclaration `MORTALITE` sur le lot et son lot de traçabilité, validation
 *   `MORTALITY` (AV-048), photo attendue (AV-107), effectif en élevage diminué, coût du lot
 *   inchangé (BR-PRD-013), contrôles de portée, d'emplacement, de cause et d'état du lot ;
 * - consommation d'intrant imputée au lot (BR-PRD-007), nature conservée ;
 * - pesée et son annulation (BR-PRD-015), observation « RAS » (AV-117) ;
 * - hors ligne sur un lot clôturé : saisie appliquée avec le conflit `LOT_CLOSED`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerLossCommands } from '../src/modules/inventory/application/commands/loss-commands.js';
import { registerLotCommands } from '../src/modules/production/application/commands/lot-commands.js';
import { registerDailyCommands } from '../src/modules/production/application/commands/daily-commands.js';
import {
  costObjectBalance,
  ensureSupplierLot,
  lotHeadcount,
  recordStockMove,
  virtualLocationId,
} from '../src/modules/inventory/application/public/index.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
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

const DAY = '2026-10-21';
const at = (hhmmss: string) => `${DAY}T${hhmmss}.000Z`;
const NOW = at('20:00:00');
let deviceSeq = 0;

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

describe('P7-06 : saisie du jour', () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let admin: Actor;
  let farmManager: Actor;
  let otherFarmManager: Actor;
  let productionManager: Actor;
  let buildingId: string;
  let farmStoreId: string;
  let otherStoreId: string;
  let chickId: string;
  let broilerId: string;
  let feedId: string;
  let chickLotId: string;
  let lossReasonId: string;
  let rejectionReasonId: string;
  let lotId: string;
  let stockLotId: string;

  type Result = Awaited<ReturnType<CommandPipelineService['handle']>>;
  const code = (r: Result) => (r.status === 'REJECTED' ? r.error.code : r.status);

  async function run(
    actor: Actor,
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
    options: { readonly attachmentIds?: readonly string[]; readonly offline?: boolean } = {},
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
        attachment_ids: [...(options.attachmentIds ?? [])],
        payload,
      },
      {
        authenticatedUserId: actor.userId,
        authenticatedDeviceId: actor.deviceId,
        transport: options.offline ? 'SYNC_PUSH' : 'ONLINE_API',
      },
    );
  }

  /** Lot de poulets de chair mis en place avec `quantity` poussins à 500 XAF. */
  async function placedLot(quantity: number, time: string): Promise<string> {
    const id = freshUuid();
    const created = await run(
      productionManager,
      'production.lot.create',
      'PRODUCTION_LOT',
      id,
      time,
      {
        lotType: 'POULET_CHAIR',
        productId: broilerId,
        mainLocationId: buildingId,
      },
    );
    expect(created.status, JSON.stringify(created)).toBe('APPLIED');
    const placed = await run(
      farmManager,
      'production.lot.record_entry',
      'LOT_ENTRY',
      freshUuid(),
      time,
      {
        productionLotId: id,
        sourceKind: 'INTERNAL_STOCK',
        sourceProductId: chickId,
        sourceLocationId: farmStoreId,
        sourceStockLotId: chickLotId,
        quantity,
      },
    );
    expect(placed.status, JSON.stringify(placed)).toBe('APPLIED');
    return id;
  }

  const mortality = (lot: string, quantity: number, extra: Record<string, unknown> = {}) => ({
    productionLotId: lot,
    quantity,
    ...extra,
  });

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
    const sequences = new DocumentSequenceService();
    registerLotCommands(registry, idGenerator, sequences);
    registerDailyCommands(registry, idGenerator, sequences);
    registerLossCommands(registry, decisions, idGenerator, sequences);
    registerPolicyCommands(registry);
    registerRequestCommands(registry, decisions);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    const roles = { rfe: await roleId('RESP_FERME'), rpr: await roleId('RESP_PRODUCTION') };
    await db.transaction().execute(async (trx) => {
      const adminId = await insertTestUser(trx);
      admin = { userId: adminId, deviceId: await insertTestDevice(trx, adminId) };
      const adminRole = await insertTestRole(trx, adminId);
      await grantTestPermission(trx, adminRole, 'approvals.policy.manage', adminId);
      await assignTestRole(trx, adminId, adminRole, adminId);
      const zoneId = await insertTestZone(trx, adminId);
      const farmId = await insertTestSite(trx, adminId, zoneId, { siteType: 'FERME' });
      const otherFarmId = await insertTestSite(trx, adminId, zoneId, { siteType: 'FERME' });
      buildingId = await insertTestLocation(trx, adminId, farmId, { locationType: 'BUILDING' });
      farmStoreId = await insertTestLocation(trx, adminId, farmId);
      otherStoreId = await insertTestLocation(trx, adminId, otherFarmId);
      const actor = async (role: string, options: Parameters<typeof assignTestRole>[4] = {}) => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, adminId, options);
        return { userId, deviceId };
      };
      farmManager = await actor(roles.rfe, { scopeType: 'SITE', scopeSiteId: farmId });
      otherFarmManager = await actor(roles.rfe, { scopeType: 'SITE', scopeSiteId: otherFarmId });
      productionManager = await actor(roles.rpr);

      for (const [unit, name, isCount] of [
        ['TETE', 'Tête', 1],
        ['KG', 'Kilogramme', 0],
      ] as const) {
        if (
          !(await trx
            .selectFrom('catalog_units')
            .select('code')
            .where('code', '=', unit)
            .executeTakeFirst())
        ) {
          await trx
            .insertInto('catalog_units')
            .values({ code: unit, name, is_count: isCount })
            .execute();
        }
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
      chickId = freshUuid();
      broilerId = freshUuid();
      feedId = freshUuid();
      const base = { category_id: toBin(categoryId), created_by: toBin(adminId) };
      await trx
        .insertInto('catalog_products')
        .values([
          {
            ...base,
            id: toBin(chickId),
            code: `PRD-${chickId.slice(-8)}`,
            name: 'Poussin d’un jour (chair)',
            stock_family: 'BIOLOGIQUE',
            species: 'POULET_CHAIR',
            base_unit_code: 'TETE',
            lot_tracking: 'REQUIRED',
          },
          {
            ...base,
            id: toBin(broilerId),
            code: `PRD-${broilerId.slice(-8)}`,
            name: 'Poulet de chair vif',
            stock_family: 'BIOLOGIQUE',
            species: 'POULET_CHAIR',
            base_unit_code: 'TETE',
            lot_tracking: 'REQUIRED',
          },
          {
            ...base,
            id: toBin(feedId),
            code: `PRD-${feedId.slice(-8)}`,
            name: 'Aliment croissance',
            stock_family: 'INTRANT',
            base_unit_code: 'KG',
            lot_tracking: 'NONE',
            is_consumable: 1,
          },
        ])
        .execute();
      lossReasonId = freshUuid();
      rejectionReasonId = freshUuid();
      await trx
        .insertInto('catalog_reason_codes')
        .values([
          {
            id: toBin(lossReasonId),
            code: `MAL-${lossReasonId.slice(-8)}`,
            category: 'LOSS',
            label: 'Maladie respiratoire',
            created_by: toBin(adminId),
          },
          {
            id: toBin(rejectionReasonId),
            code: `REJ-${rejectionReasonId.slice(-8)}`,
            category: 'REJECTION',
            label: 'Sacs déchirés',
            created_by: toBin(adminId),
          },
        ])
        .execute();
      const supplierId = freshUuid();
      await trx
        .insertInto('procurement_suppliers')
        .values({
          id: toBin(supplierId),
          code: `F-${supplierId.slice(-10)}`,
          name: 'Couvoir',
          supplied_categories: JSON.stringify([]),
          status: 'ACTIVE',
          created_by: toBin(adminId),
        })
        .execute();
      chickLotId = await ensureSupplierLot(
        trx,
        { idGenerator },
        {
          productId: chickId,
          supplierId,
          supplierLotRef: `PC-${supplierId.slice(-6)}`,
          fallbackCode: `F:PC-${supplierId.slice(-6)}`,
          expiryDate: null,
          originId: freshUuid(),
          fifoRankAt: new Date(at('05:00:00')),
          createdBy: adminId,
        },
      );
      const opening = await virtualLocationId(trx, 'V_OPENING');
      for (const [productId, lot, quantity, cost] of [
        [chickId, chickLotId, 1000, 500],
        [feedId, undefined, 1000, 300],
      ] as const) {
        await recordStockMove(
          trx,
          { idGenerator },
          {
            productId,
            ...(lot !== undefined ? { lotId: lot } : {}),
            quantityBase: quantity,
            fromLocationId: opening,
            toLocationId: farmStoreId,
            moveType: 'OPENING_BALANCE',
            declaredUnitCostXaf: cost,
            occurredAt: new Date(at('05:00:00')),
            sourceDocType: 'INVENTORY_COUNT',
            sourceDocId: freshUuid(),
            createdBy: adminId,
            allowNegative: false,
          },
        );
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
        code: `MORTALITY_${policyId.slice(-8)}`,
        operationType: 'MORTALITY',
        validFrom: at('00:00:00'),
        requiresApproval: true,
        requiresPhoto: true,
        approverPermission: 'production.mortality.approve',
        approverScope: 'ALL',
        condition: { relativePct: 0, absoluteHeads: 0 },
      },
    );
    expect(policy.status, JSON.stringify(policy)).toBe('APPLIED');

    lotId = await placedLot(100, at('06:00:00'));
    const lot = await db
      .selectFrom('production_production_lots')
      .select('stock_lot_id')
      .where('id', '=', toBin(lotId))
      .executeTakeFirstOrThrow();
    stockLotId = fromBin(lot.stock_lot_id);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('mortalité : déclaration MORTALITE du lot, validation attendue, effectif diminué, coût inchangé', async () => {
    const record = (payload: unknown, actor: Actor = farmManager, options = {}) =>
      run(
        actor,
        'production.mortality.record',
        'STOCK_LOSS',
        freshUuid(),
        at('08:00:00'),
        payload,
        options,
      );
    expect(code(await record(mortality(lotId, 3), otherFarmManager))).toBe('FORBIDDEN_SCOPE');
    expect(code(await record(mortality(lotId, 3, { locationId: otherStoreId })))).toBe(
      'SITE_MISMATCH',
    );
    expect(code(await record(mortality(lotId, 3, { reasonCodeId: rejectionReasonId })))).toBe(
      'REFERENCE_INVALID',
    );
    const lossId = freshUuid();
    const declared = await run(
      farmManager,
      'production.mortality.record',
      'STOCK_LOSS',
      lossId,
      at('08:00:00'),
      mortality(lotId, 3, { reasonCodeId: lossReasonId, comment: 'Toux' }),
      { attachmentIds: [freshUuid()] },
    );
    expect(declared).toMatchObject({
      status: 'APPLIED',
      server_refs: { docNumber: expect.stringMatching(/^PRT-/), status: 'PENDING_APPROVAL' },
    });
    const loss = await db
      .selectFrom('inventory_loss_declarations')
      .selectAll()
      .where('id', '=', toBin(lossId))
      .executeTakeFirstOrThrow();
    expect(loss).toMatchObject({
      category: 'MORTALITE',
      status: 'PENDING_APPROVAL',
      unit_code: 'TETE',
    });
    expect(fromBin(loss.production_lot_id!)).toBe(lotId);
    expect(fromBin(loss.lot_id!)).toBe(stockLotId);
    expect(fromBin(loss.location_id)).toBe(buildingId);
    expect(await lotHeadcount(db, { lotId: stockLotId, scope: 'REARING' })).toBe(97);
    // BR-PRD-013 : la mortalité ne réduit pas le coût du lot.
    expect(
      (await costObjectBalance(db, { costObjectType: 'PRODUCTION_LOT', costObjectId: lotId }))
        .netXaf,
    ).toBe(50_000);

    const planned = freshUuid();
    await run(
      productionManager,
      'production.lot.create',
      'PRODUCTION_LOT',
      planned,
      at('08:00:00'),
      {
        lotType: 'POULET_CHAIR',
        productId: broilerId,
        mainLocationId: buildingId,
      },
    );
    expect(code(await record(mortality(planned, 1)))).toBe('LOT_NOT_ACTIVE');
    expect(code(await record(mortality(freshUuid(), 1)))).toBe('NOT_FOUND');
  });

  it('consommation d’intrant imputée au lot ; produit non consommable et emplacement refusés', async () => {
    const consume = (payload: Record<string, unknown>) =>
      run(farmManager, 'production.input.record', 'CONSUMPTION', freshUuid(), at('09:00:00'), {
        productionLotId: lotId,
        locationId: farmStoreId,
        productId: feedId,
        quantityBase: 20,
        unitCode: 'KG',
        quantity: 20,
        costType: 'ALIMENT',
        ...payload,
      });
    expect(code(await consume({ productId: chickId, unitCode: 'TETE' }))).toBe(
      'PRODUCT_NOT_CONSUMABLE',
    );
    expect(code(await consume({ locationId: otherStoreId }))).toBe('SITE_MISMATCH');
    const before = await costObjectBalance(db, {
      costObjectType: 'PRODUCTION_LOT',
      costObjectId: lotId,
    });
    const consumed = await consume({});
    expect(consumed.status, JSON.stringify(consumed)).toBe('APPLIED');
    const after = await costObjectBalance(db, {
      costObjectType: 'PRODUCTION_LOT',
      costObjectId: lotId,
      costTypes: ['ALIMENT'],
    });
    expect(after.debitXaf).toBe(6_000);
    expect(
      (await costObjectBalance(db, { costObjectType: 'PRODUCTION_LOT', costObjectId: lotId }))
        .netXaf,
    ).toBe(before.netXaf + 6_000);
    const row = await db
      .selectFrom('inventory_consumptions')
      .select(['cost_type', 'cost_object_type'])
      .where('cost_object_id', '=', toBin(lotId))
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ cost_type: 'ALIMENT', cost_object_type: 'PRODUCTION_LOT' });
  });

  it('pesée, annulation de pesée, observation « RAS »', async () => {
    const weigh = (id: string, payload: Record<string, unknown>) =>
      run(farmManager, 'production.weighing.record', 'LOT_WEIGHING', id, at('10:00:00'), {
        productionLotId: lotId,
        sampleSize: 10,
        avgWeightG: 452.5,
        ...payload,
      });
    expect(code(await weigh(freshUuid(), { locationId: farmStoreId }))).toBe('LOCATION_INVALID');
    const weighingId = freshUuid();
    expect(code(await weigh(weighingId, { locationId: buildingId, totalWeightKg: 4.525 }))).toBe(
      'APPLIED',
    );
    const row = await db
      .selectFrom('production_lot_weighings')
      .selectAll()
      .where('id', '=', toBin(weighingId))
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      sample_size: 10,
      avg_weight_g: '452.5',
      source: 'MANUAL',
      status: 'RECORDED',
    });
    const cancel = () =>
      run(farmManager, 'production.weighing.cancel', 'LOT_WEIGHING', weighingId, at('10:30:00'), {
        comment: 'Balance mal tarée',
      });
    expect(code(await cancel())).toBe('APPLIED');
    expect(code(await cancel())).toBe('APPLIED');
    const cancelled = await db
      .selectFrom('production_lot_weighings')
      .select(['status', 'cancel_comment'])
      .where('id', '=', toBin(weighingId))
      .executeTakeFirstOrThrow();
    expect(cancelled).toEqual({ status: 'CANCELLED', cancel_comment: 'Balance mal tarée' });

    const observationId = freshUuid();
    const observed = await run(
      farmManager,
      'production.observation.record',
      'LOT_OBSERVATION',
      observationId,
      at('18:00:00'),
      { productionLotId: lotId, observationType: 'AUTRE', text: 'RAS' },
    );
    expect(observed.status).toBe('APPLIED');
    const observation = await db
      .selectFrom('production_lot_observations')
      .select(['observation_type', 'text', 'severity'])
      .where('id', '=', toBin(observationId))
      .executeTakeFirstOrThrow();
    expect(observation).toEqual({ observation_type: 'AUTRE', text: 'RAS', severity: 'INFO' });
  });

  it('hors ligne sur un lot clôturé : saisies appliquées avec le conflit LOT_CLOSED', async () => {
    // Lot vidé par l'annulation de sa mise en place, puis clôturé.
    const closedId = freshUuid();
    await run(
      productionManager,
      'production.lot.create',
      'PRODUCTION_LOT',
      closedId,
      at('11:00:00'),
      {
        lotType: 'POULET_CHAIR',
        productId: broilerId,
        mainLocationId: buildingId,
      },
    );
    const entryId = freshUuid();
    await run(farmManager, 'production.lot.record_entry', 'LOT_ENTRY', entryId, at('11:00:00'), {
      productionLotId: closedId,
      sourceKind: 'INTERNAL_STOCK',
      sourceProductId: chickId,
      sourceLocationId: farmStoreId,
      sourceStockLotId: chickLotId,
      quantity: 5,
    });
    await run(
      productionManager,
      'production.lot.cancel_entry',
      'LOT_ENTRY',
      entryId,
      at('11:10:00'),
      {
        comment: 'Erreur',
      },
    );
    expect(
      code(
        await run(
          productionManager,
          'production.lot.close',
          'PRODUCTION_LOT',
          closedId,
          at('11:20:00'),
          {},
        ),
      ),
    ).toBe('APPLIED');

    const observation = () =>
      run(
        farmManager,
        'production.observation.record',
        'LOT_OBSERVATION',
        freshUuid(),
        at('11:05:00'),
        { productionLotId: closedId, observationType: 'SANITAIRE', text: 'Litière humide' },
        { offline: true },
      );
    expect(await observation()).toMatchObject({
      status: 'APPLIED_WITH_WARNINGS',
      warnings: ['LOT_CLOSED'],
    });
    expect(
      code(
        await run(
          farmManager,
          'production.weighing.record',
          'LOT_WEIGHING',
          freshUuid(),
          at('11:30:00'),
          {
            productionLotId: closedId,
            sampleSize: 5,
            avgWeightG: 40,
          },
        ),
      ),
    ).toBe('LOT_NOT_ACTIVE');
    const conflicts = await db
      .selectFrom('sync_sync_conflicts')
      .select(['conflict_type', 'owner_role'])
      .where('entity_id', '=', toBin(closedId))
      .execute();
    expect(conflicts).toEqual([{ conflict_type: 'LOT_CLOSED', owner_role: 'RESP_PRODUCTION' }]);
  });
});
