/**
 * P7-08 — incubation, à travers le vrai pipeline (SM-INCUBATION, WF-12) :
 * - AT-029 : 600 œufs incubés = 42 infertiles + 18 morts en coquille + 35 non éclos + 498
 *   poussins viables + 7 non viables (INV-INC-01) ; taux d'éclosion 83 % ; échéancier (AV-047) ;
 *   coût des œufs porté par le lot d'incubation puis par les poussins viables (BR-INC-009),
 *   repris exactement à la mise en place ;
 * - refus : incubateur, espèce, produit, portée, bilan de mirage et d'éclosion, état ;
 * - pertes accidentelles (casse) reprises dans le bilan ; éclosion incomplète hors ligne
 *   complétée en non éclos (`INCUBATION_BALANCE_ADJUSTED`) ; étape hors ligne sur un lot clos
 *   conservée en conflit ; annulation après perte totale ;
 * - revue P7 : valeur des œufs soldée à l'éclosion (aucun reliquat), mirage en double annulé,
 *   éclosion hors ligne au-delà des œufs restants mise en quarantaine, perte en attente
 *   bloquante, rejeu d'une étape sous un autre identifiant, origine des œufs contrôlée.
 *
 * Produit des œufs à couver à code stable (`TEST-OEUF-INCUB`, toujours entré à 150 XAF) et
 * paramètre `production.hatching_egg_product_code` posé par ce fichier : aucune dépendance aux
 * autres jeux de tests de la base partagée.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerLossCommands } from '../src/modules/inventory/application/commands/loss-commands.js';
import { registerLotCommands } from '../src/modules/production/application/commands/lot-commands.js';
import { registerIncubationCommands } from '../src/modules/production/application/commands/incubation-commands.js';
import {
  biologicalLotUnitCostXaf,
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
  grantTestPermission,
  insertTestDevice,
  insertTestLocation,
  insertTestRole,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const DAY = '2026-10-23';
const EGG_CODE = 'TEST-OEUF-INCUB';
const at = (hhmmss: string) => `${DAY}T${hhmmss}.000Z`;
const NOW = at('20:00:00');
let deviceSeq = 0;

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

describe('P7-08 : incubation', () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let admin: Actor;
  let farmManager: Actor;
  let otherFarmManager: Actor;
  let productionManager: Actor;
  let eggStoreId: string;
  let incubatorId: string;
  let hatcherId: string;
  let buildingId: string;
  let eggId: string;
  let chickId: string;
  let broilerId: string;
  let eggLotId: string;

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

  const startPayload = (eggsSet: number, extra: Record<string, unknown> = {}) => ({
    species: 'POULE',
    eggProductId: eggId,
    chickProductId: chickId,
    incubatorLocationId: incubatorId,
    eggSource: 'PURCHASED',
    eggsSet,
    sourceLocationId: eggStoreId,
    sourceStockLotId: eggLotId,
    ...extra,
  });

  async function start(
    eggsSet: number,
    extra: Record<string, unknown> = {},
    actor: Actor = farmManager,
  ): Promise<{ readonly id: string; readonly result: Result }> {
    const id = freshUuid();
    const result = await run(
      actor,
      'production.incubation.start',
      'INCUBATION_BATCH',
      id,
      at('07:00:00'),
      startPayload(eggsSet, extra),
    );
    return { id, result };
  }

  const step = (
    commandType: string,
    payload: Record<string, unknown>,
    time: string,
    options: { readonly offline?: boolean } = {},
  ) =>
    run(
      farmManager,
      `production.incubation.${commandType}`,
      'INCUBATION_EVENT',
      freshUuid(),
      time,
      payload,
      options,
    );

  async function batchRow(batchId: string) {
    return db
      .selectFrom('production_incubation_batches')
      .selectAll()
      .where('id', '=', toBin(batchId))
      .executeTakeFirstOrThrow();
  }

  async function valueOf(locationId: string, productId: string, lotId: Buffer): Promise<number> {
    const row = await db
      .selectFrom('inventory_stock_balances')
      .select('value_xaf')
      .where('location_id', '=', toBin(locationId))
      .where('product_id', '=', toBin(productId))
      .where('lot_key', '=', lotId)
      .executeTakeFirst();
    return row ? Number(row.value_xaf) : 0;
  }

  async function balance(locationId: string, productId: string, lotId: Buffer): Promise<number> {
    const row = await db
      .selectFrom('inventory_stock_balances')
      .select('qty_on_hand')
      .where('location_id', '=', toBin(locationId))
      .where('product_id', '=', toBin(productId))
      .where('lot_key', '=', lotId)
      .executeTakeFirst();
    return row ? Number(row.qty_on_hand) : 0;
  }

  const ymd = (value: Date | null) =>
    value === null
      ? null
      : `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;

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
    registerIncubationCommands(registry, idGenerator, sequences);
    registerLossCommands(registry, decisions, idGenerator, sequences);
    registerRequestCommands(registry, decisions);
    registerPolicyCommands(registry);
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
      eggStoreId = await insertTestLocation(trx, adminId, farmId);
      incubatorId = await insertTestLocation(trx, adminId, farmId, { locationType: 'INCUBATOR' });
      hatcherId = await insertTestLocation(trx, adminId, farmId, { locationType: 'HATCHER' });
      buildingId = await insertTestLocation(trx, adminId, farmId, { locationType: 'BUILDING' });
      const actor = async (role: string, options: Parameters<typeof assignTestRole>[4] = {}) => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, adminId, options);
        return { userId, deviceId };
      };
      farmManager = await actor(roles.rfe, { scopeType: 'SITE', scopeSiteId: farmId });
      otherFarmManager = await actor(roles.rfe, { scopeType: 'SITE', scopeSiteId: otherFarmId });
      productionManager = await actor(roles.rpr);
      void otherFarmId;

      for (const [unit, name] of [
        ['TETE', 'Tête'],
        ['OEUF', 'Œuf'],
      ] as const) {
        if (
          !(await trx
            .selectFrom('catalog_units')
            .select('code')
            .where('code', '=', unit)
            .executeTakeFirst())
        ) {
          await trx.insertInto('catalog_units').values({ code: unit, name, is_count: 1 }).execute();
        }
      }
      const categoryId = freshUuid();
      await trx
        .insertInto('catalog_product_categories')
        .values({
          id: toBin(categoryId),
          code: `CAT-${categoryId.slice(-8)}`,
          name: 'Couvoir',
          created_by: toBin(adminId),
        })
        .execute();
      const existingEgg = await trx
        .selectFrom('catalog_products')
        .select('id')
        .where('code', '=', EGG_CODE)
        .executeTakeFirst();
      eggId = existingEgg ? fromBin(existingEgg.id) : freshUuid();
      chickId = freshUuid();
      broilerId = freshUuid();
      const base = {
        category_id: toBin(categoryId),
        lot_tracking: 'REQUIRED',
        created_by: toBin(adminId),
      };
      await trx
        .insertInto('catalog_products')
        .values([
          {
            ...base,
            id: toBin(chickId),
            code: `PDJ-${chickId.slice(-8)}`,
            name: 'Poussin d’un jour (chair)',
            stock_family: 'BIOLOGIQUE',
            species: 'POULET_CHAIR',
            base_unit_code: 'TETE',
          },
          {
            ...base,
            id: toBin(broilerId),
            code: `PCV-${broilerId.slice(-8)}`,
            name: 'Poulet de chair vif',
            stock_family: 'BIOLOGIQUE',
            species: 'POULET_CHAIR',
            base_unit_code: 'TETE',
          },
        ])
        .execute();
      if (!existingEgg) {
        await trx
          .insertInto('catalog_products')
          .values({
            ...base,
            id: toBin(eggId),
            code: EGG_CODE,
            name: 'Œuf à couver (test incubation)',
            stock_family: 'PRODUCTION_COMMERCIALISABLE',
            base_unit_code: 'OEUF',
          })
          .execute();
      }
      await trx
        .insertInto('organization_system_settings')
        .values({
          id: toBin(freshUuid()),
          key: 'production.hatching_egg_product_code',
          value: JSON.stringify(EGG_CODE),
          scope_type: 'GLOBAL',
          valid_from: new Date(at('00:00:00')),
          is_client_visible: 1,
          reason: 'Test P7-08',
          created_by: toBin(adminId),
        })
        .execute();
      const supplierId = freshUuid();
      await trx
        .insertInto('procurement_suppliers')
        .values({
          id: toBin(supplierId),
          code: `F-${supplierId.slice(-10)}`,
          name: 'Accouveur',
          supplied_categories: JSON.stringify([]),
          status: 'ACTIVE',
          created_by: toBin(adminId),
        })
        .execute();
      eggLotId = await ensureSupplierLot(
        trx,
        { idGenerator },
        {
          productId: eggId,
          supplierId,
          supplierLotRef: `OA-${supplierId.slice(-6)}`,
          fallbackCode: `F:OA-${supplierId.slice(-6)}`,
          expiryDate: null,
          originId: freshUuid(),
          fifoRankAt: new Date(at('05:00:00')),
          createdBy: adminId,
        },
      );
      await recordStockMove(
        trx,
        { idGenerator },
        {
          productId: eggId,
          lotId: eggLotId,
          quantityBase: 1000,
          fromLocationId: await virtualLocationId(trx, 'V_OPENING'),
          toLocationId: eggStoreId,
          moveType: 'OPENING_BALANCE',
          declaredUnitCostXaf: 150,
          occurredAt: new Date(at('05:00:00')),
          sourceDocType: 'INVENTORY_COUNT',
          sourceDocId: freshUuid(),
          createdBy: adminId,
          allowNegative: false,
        },
      );
    });
  });

  beforeAll(async () => {
    const policyId = freshUuid();
    const policy = await run(
      admin,
      'approvals.policy.set',
      'CONTROL_POLICY',
      policyId,
      at('00:00:00'),
      {
        code: `LOSS_DECLARATION_${policyId.slice(-8)}`,
        operationType: 'LOSS_DECLARATION',
        validFrom: at('00:00:00'),
        validTo: at('23:59:59'),
        requiresApproval: false,
      },
    );
    expect(policy.status, JSON.stringify(policy)).toBe('APPLIED');
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('AT-029 : 600 œufs, mirage, transfert, éclosion à 83 % ; coût porté par les poussins viables', async () => {
    const { id, result } = await start(600);
    expect(result).toMatchObject({
      status: 'APPLIED',
      server_refs: { batchCode: expect.stringMatching(/^INC-.+-2026-\d{6}$/) },
    });
    let batch = await batchRow(id);
    expect(batch).toMatchObject({
      status: 'INCUBATING',
      eggs_set_qty: 600,
      egg_source: 'PURCHASED',
      species: 'POULE',
    });
    // Échéancier (AV-047) : J+7, J+18, J+21.
    expect([
      ymd(batch.expected_candling_date),
      ymd(batch.expected_transfer_date),
      ymd(batch.expected_hatch_date),
    ]).toEqual(['2026-10-30', '2026-11-10', '2026-11-13']);
    const stockLot = await db
      .selectFrom('inventory_stock_lots')
      .select(['origin_type', 'lot_code'])
      .where('id', '=', batch.stock_lot_id)
      .executeTakeFirstOrThrow();
    expect(stockLot).toEqual({ origin_type: 'INCUBATION_BATCH', lot_code: batch.batch_code });
    expect(await balance(incubatorId, eggId, batch.stock_lot_id)).toBe(600);
    const cost = () =>
      costObjectBalance(db, { costObjectType: 'INCUBATION_BATCH', costObjectId: id });
    expect((await cost()).netXaf).toBe(90_000);

    const candled = await step(
      'record_candling',
      { batchId: id, infertile: 42, earlyDead: 18 },
      at('08:00:00'),
    );
    expect(candled.status, JSON.stringify(candled)).toBe('APPLIED');
    expect(await balance(incubatorId, eggId, batch.stock_lot_id)).toBe(540);
    expect(
      code(
        await step(
          'record_hatch',
          { batchId: id, unhatched: 35, hatchedViable: 498, hatchedNonviable: 7 },
          at('08:30:00'),
        ),
      ),
    ).toBe('INCUBATION_STATUS_INVALID');
    expect(
      code(
        await step(
          'transfer_to_hatcher',
          { batchId: id, hatcherLocationId: incubatorId },
          at('09:00:00'),
        ),
      ),
    ).toBe('LOCATION_INVALID');
    expect(
      code(
        await step(
          'transfer_to_hatcher',
          { batchId: id, hatcherLocationId: hatcherId },
          at('09:00:00'),
        ),
      ),
    ).toBe('APPLIED');
    batch = await batchRow(id);
    expect(batch).toMatchObject({ status: 'IN_HATCHER', transferred_qty: 540 });
    expect(await balance(hatcherId, eggId, batch.stock_lot_id)).toBe(540);

    expect(
      code(
        await step(
          'record_hatch',
          { batchId: id, unhatched: 35, hatchedViable: 498, hatchedNonviable: 8 },
          at('10:00:00'),
        ),
      ),
    ).toBe('INCUBATION_BALANCE_INVALID');
    const hatched = await step(
      'record_hatch',
      { batchId: id, unhatched: 35, hatchedViable: 498, hatchedNonviable: 7 },
      at('10:00:00'),
    );
    expect(hatched.status, JSON.stringify(hatched)).toBe('APPLIED');
    batch = await batchRow(id);
    expect(batch).toMatchObject({
      status: 'CLOSED',
      infertile_qty: 42,
      early_dead_qty: 18,
      accidental_loss_qty: 0,
      unhatched_qty: 35,
      hatched_viable_qty: 498,
      hatched_nonviable_qty: 7,
      hatch_rate: '0.8300',
    });
    expect(await balance(hatcherId, eggId, batch.stock_lot_id)).toBe(0);
    expect(await balance(hatcherId, chickId, batch.stock_lot_id)).toBe(498);
    // Revue P7 : les œufs sortent à la valeur de leur solde, aucun reliquat sur une quantité
    // nulle ; les poussins portent le coût du lot.
    expect(await valueOf(hatcherId, eggId, batch.stock_lot_id)).toBe(0);
    expect(await valueOf(incubatorId, eggId, batch.stock_lot_id)).toBe(0);
    expect(await valueOf(hatcherId, chickId, batch.stock_lot_id)).toBe(90_000);
    // BR-INC-009 : 90 000 XAF ÷ 498 poussins viables ≈ 181 XAF.
    expect(
      await db
        .transaction()
        .execute((trx) => biologicalLotUnitCostXaf(trx, fromBin(batch.stock_lot_id))),
    ).toBe(181);
    const events = await db
      .selectFrom('production_incubation_events')
      .select('event_type')
      .where('batch_id', '=', toBin(id))
      .orderBy('occurred_at', 'asc')
      .execute();
    expect(events.map((event) => event.event_type)).toEqual([
      'SET',
      'CANDLING',
      'TRANSFER_TO_HATCHER',
      'HATCH',
    ]);

    // Mise en place des 498 poussins : le lot de chair reçoit exactement le coût des œufs.
    const lotId = freshUuid();
    await run(productionManager, 'production.lot.create', 'PRODUCTION_LOT', lotId, at('11:00:00'), {
      lotType: 'POULET_CHAIR',
      productId: broilerId,
      mainLocationId: buildingId,
    });
    const placed = await run(
      farmManager,
      'production.lot.record_entry',
      'LOT_ENTRY',
      freshUuid(),
      at('11:00:00'),
      {
        productionLotId: lotId,
        sourceKind: 'INTERNAL_STOCK',
        sourceProductId: chickId,
        sourceLocationId: hatcherId,
        sourceStockLotId: fromBin(batch.stock_lot_id),
        quantity: 498,
      },
    );
    expect(placed.status, JSON.stringify(placed)).toBe('APPLIED');
    expect(
      (await costObjectBalance(db, { costObjectType: 'PRODUCTION_LOT', costObjectId: lotId }))
        .netXaf,
    ).toBe(90_000);
  });

  it('refus : incubateur, espèce, produit, portée, mirage excessif', async () => {
    expect(code((await start(10, { incubatorLocationId: eggStoreId })).result)).toBe(
      'LOCATION_INVALID',
    );
    expect(code((await start(10, { species: 'AUTRUCHE' })).result)).toBe('SPECIES_UNKNOWN');
    expect(code((await start(10, { chickProductId: eggId })).result)).toBe('CHICK_PRODUCT_INVALID');
    expect(code((await start(10, { eggProductId: chickId })).result)).toBe('EGG_PRODUCT_INVALID');
    expect(code((await start(10, { sourceLocationId: incubatorId })).result)).toBe(
      'EGG_SOURCE_INVALID',
    );
    expect(code((await start(10, {}, otherFarmManager)).result)).toBe('FORBIDDEN_SCOPE');
    const { id } = await start(10);
    expect(
      code(
        await step('record_candling', { batchId: id, infertile: 8, earlyDead: 3 }, at('08:00:00')),
      ),
    ).toBe('INCUBATION_BALANCE_INVALID');
  });

  it('casse reprise au bilan ; éclosion hors ligne complétée ; étape sur un lot clos conservée en conflit', async () => {
    const { id } = await start(50);
    const batch = await batchRow(id);
    const loss = await run(
      farmManager,
      'inventory.loss.declare',
      'STOCK_LOSS',
      freshUuid(),
      at('07:30:00'),
      {
        locationId: incubatorId,
        productId: eggId,
        lotId: fromBin(batch.stock_lot_id),
        quantityBase: 5,
        unitCode: 'OEUF',
        quantity: 5,
        category: 'CASSE',
      },
    );
    expect(loss.status, JSON.stringify(loss)).toBe('APPLIED');
    expect(
      code(
        await step(
          'transfer_to_hatcher',
          { batchId: id, hatcherLocationId: hatcherId },
          at('09:00:00'),
        ),
      ),
    ).toBe('APPLIED');
    expect((await batchRow(id)).transferred_qty).toBe(45);

    const adjusted = await step(
      'record_hatch',
      { batchId: id, unhatched: 1, hatchedViable: 38, hatchedNonviable: 1 },
      at('10:00:00'),
      { offline: true },
    );
    expect(adjusted).toMatchObject({
      status: 'APPLIED_WITH_WARNINGS',
      warnings: ['INCUBATION_BALANCE_ADJUSTED'],
    });
    expect(await batchRow(id)).toMatchObject({
      status: 'CLOSED',
      accidental_loss_qty: 5,
      unhatched_qty: 6,
      hatched_viable_qty: 38,
      hatched_nonviable_qty: 1,
    });

    const late = await step(
      'record_candling',
      { batchId: id, infertile: 2, earlyDead: 0 },
      at('08:00:00'),
      { offline: true },
    );
    expect(late.status).toBe('CONFLICT');
    const conflicts = await db
      .selectFrom('sync_sync_conflicts')
      .select(['conflict_type', 'applied'])
      .where('entity_id', '=', toBin(id))
      .orderBy('conflict_type', 'asc')
      .execute();
    expect(conflicts).toEqual([
      { conflict_type: 'INCUBATION_BALANCE', applied: 1 },
      { conflict_type: 'INCUBATION_CLOSED', applied: 0 },
    ]);
    expect((await batchRow(id)).infertile_qty).toBe(0);
  });

  it('annulation : refusée tant que des œufs restent, acceptée après perte totale', async () => {
    const { id } = await start(20);
    const batch = await batchRow(id);
    const cancel = () =>
      step('cancel', { batchId: id, comment: 'Panne de courant, œufs perdus' }, at('12:00:00'));
    expect(code(await cancel())).toBe('INCUBATION_NOT_EMPTY');
    const loss = await run(
      farmManager,
      'inventory.loss.declare',
      'STOCK_LOSS',
      freshUuid(),
      at('11:00:00'),
      {
        locationId: incubatorId,
        productId: eggId,
        lotId: fromBin(batch.stock_lot_id),
        quantityBase: 20,
        unitCode: 'OEUF',
        quantity: 20,
        category: 'DETERIORATION',
      },
    );
    expect(loss.status, JSON.stringify(loss)).toBe('APPLIED');
    expect(code(await cancel())).toBe('APPLIED');
    const cancelled = await db
      .selectFrom('production_incubation_batches as b')
      .innerJoin('inventory_stock_lots as l', 'l.id', 'b.stock_lot_id')
      .select(['b.status', 'b.accidental_loss_qty', 'l.status as lot_status'])
      .where('b.id', '=', toBin(id))
      .executeTakeFirstOrThrow();
    expect(cancelled).toEqual({
      status: 'CANCELLED',
      accidental_loss_qty: 20,
      lot_status: 'CLOSED',
    });
  });

  it('revue P7 : mirage en double annulé ; éclosion hors ligne excédentaire en quarantaine ; rejeu contrôlé', async () => {
    const { id } = await start(100);
    const first = freshUuid();
    const candle = (eventId: string, time: string) =>
      run(
        farmManager,
        'production.incubation.record_candling',
        'INCUBATION_EVENT',
        eventId,
        at(time),
        { batchId: id, infertile: 10, earlyDead: 0 },
      );
    expect(code(await candle(first, '08:00:00'))).toBe('APPLIED');
    const duplicate = freshUuid();
    expect(code(await candle(duplicate, '08:05:00'))).toBe('APPLIED');
    expect((await batchRow(id)).infertile_qty).toBe(20);
    // Rejeu du même identifiant : appliqué ; sous une autre étape : refusé.
    expect(code(await candle(first, '08:00:00'))).toBe('APPLIED');
    expect(
      code(
        await run(
          farmManager,
          'production.incubation.transfer_to_hatcher',
          'INCUBATION_EVENT',
          first,
          at('08:10:00'),
          { batchId: id, hatcherLocationId: hatcherId },
        ),
      ),
    ).toBe('AGGREGATE_ID_REUSED');
    // Mirage saisi deux fois : annulé par le Responsable production.
    const cancelCandling = (actor: Actor) =>
      run(
        actor,
        'production.incubation.cancel_candling',
        'INCUBATION_EVENT',
        duplicate,
        at('08:20:00'),
        {
          comment: 'Mirage saisi deux fois',
        },
      );
    expect(code(await cancelCandling(farmManager))).toBe('FORBIDDEN');
    expect(code(await cancelCandling(productionManager))).toBe('APPLIED');
    const batch = await batchRow(id);
    expect(batch.infertile_qty).toBe(10);
    expect(await balance(incubatorId, eggId, batch.stock_lot_id)).toBe(90);

    expect(
      code(
        await step(
          'transfer_to_hatcher',
          { batchId: id, hatcherLocationId: hatcherId },
          at('09:00:00'),
        ),
      ),
    ).toBe('APPLIED');
    // Hors ligne, 95 issues pour 90 œufs restants : quarantaine, rien n'est appliqué.
    const excess = await step(
      'record_hatch',
      { batchId: id, unhatched: 5, hatchedViable: 88, hatchedNonviable: 2 },
      at('10:00:00'),
      { offline: true },
    );
    expect(excess.status).toBe('CONFLICT');
    expect((await batchRow(id)).status).toBe('IN_HATCHER');
    expect(await balance(hatcherId, eggId, batch.stock_lot_id)).toBe(90);
    const conflict = await db
      .selectFrom('sync_sync_conflicts')
      .select(['conflict_type', 'applied'])
      .where('entity_id', '=', toBin(id))
      .executeTakeFirstOrThrow();
    expect(conflict).toEqual({ conflict_type: 'INCUBATION_BALANCE', applied: 0 });
  });

  it('revue P7 : une perte d’œufs en attente de validation bloque l’éclosion et l’annulation', async () => {
    const { id } = await start(30);
    const batch = await batchRow(id);
    const pendingLoss = await db.transaction().execute(async (trx) => {
      const [move] = await recordStockMove(
        trx,
        { idGenerator },
        {
          productId: eggId,
          lotId: fromBin(batch.stock_lot_id),
          quantityBase: 5,
          fromLocationId: incubatorId,
          toLocationId: await virtualLocationId(trx, 'V_PENDING_LOSS'),
          moveType: 'LOSS_PENDING',
          occurredAt: new Date(at('08:00:00')),
          sourceDocType: 'LOSS',
          sourceDocId: freshUuid(),
          createdBy: farmManager.userId,
          allowNegative: false,
        },
      );
      return move!;
    });
    expect(pendingLoss.quantity).toBe(5);
    expect(code(await step('cancel', { batchId: id, comment: 'Essai' }, at('09:00:00')))).toBe(
      'INCUBATION_HAS_PENDING_LOSS',
    );
    expect(
      code(
        await step(
          'transfer_to_hatcher',
          { batchId: id, hatcherLocationId: hatcherId },
          at('09:10:00'),
        ),
      ),
    ).toBe('APPLIED');
    expect((await batchRow(id)).transferred_qty).toBe(25);
    expect(
      code(
        await step(
          'record_hatch',
          { batchId: id, unhatched: 1, hatchedViable: 24, hatchedNonviable: 0 },
          at('10:00:00'),
        ),
      ),
    ).toBe('INCUBATION_HAS_PENDING_LOSS');
    const offline = await step(
      'record_hatch',
      { batchId: id, unhatched: 1, hatchedViable: 24, hatchedNonviable: 0 },
      at('10:00:00'),
      { offline: true },
    );
    expect(offline.status).toBe('CONFLICT');
    expect((await batchRow(id)).status).toBe('IN_HATCHER');
  });
});
