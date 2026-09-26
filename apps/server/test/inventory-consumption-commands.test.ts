/**
 * `inventory.consumption.{record,cancel}` (P2-04, BR-STK-036) à travers le vrai pipeline de
 * commande. Démontre l'enregistrement d'une consommation imputée à un objet de coût (mouvement
 * CONSUMPTION + écriture `inventory_cost_entries` DEBIT), et son annulation intégrale
 * (mouvement CONSUMPTION_REVERSAL au coût d'origine + écriture de coût inverse CREDIT).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerConsumptionCommands } from '../src/modules/inventory/application/commands/consumption-commands.js';
import {
  recordStockMove,
  type RecordMoveDeps,
} from '../src/modules/inventory/application/public/index.js';
import { toBin, fromBin } from '../src/platform/kysely/uuid-columns.js';
import {
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
  assignTestRole,
} from './helpers.js';

const OCCURRED_AT = '2026-09-30T09:00:00.000Z';

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
      name: 'Produit de test consommation',
      category_id: toBin(categoryId),
      stock_family: 'MARCHANDISE',
      base_unit_code: 'TETE',
      lot_tracking: 'NONE',
      created_by: toBin(admin),
    })
    .execute();
  return productId;
}

describe('inventory.consumption.* (P2-04, BR-STK-036)', () => {
  let clock: Clock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let moveDeps: RecordMoveDeps;
  let admin: string;
  let adminDevice: string;
  let storeA: string;

  beforeAll(async () => {
    clock = new FixedClock(new Date(OCCURRED_AT));
    idGenerator = new Uuidv7Generator(clock);
    moveDeps = { idGenerator };

    const registry = new CommandHandlerRegistry();
    registerConsumptionCommands(registry, idGenerator);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    admin = await db.transaction().execute((trx) => insertTestUser(trx));
    adminDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, admin, { status: 'ACTIVE' }));

    await db.transaction().execute(async (trx) => {
      const zoneId = await insertTestZone(trx, admin);
      const siteId = await insertTestSite(trx, admin, zoneId);
      storeA = await insertTestLocation(trx, admin, siteId, { locationType: 'STORE' });

      const adminRole = await insertTestRole(trx, admin);
      await grantTestPermission(trx, adminRole, 'inventory.consumption.record', admin);
      await assignTestRole(trx, admin, adminRole, admin);
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
        declaredUnitCostXaf: 300,
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

  it('record : mouvement CONSUMPTION emplacement -> V_CONSUMPTION + écriture de coût DEBIT', async () => {
    const productId = await insertProduct(admin);
    await openingBalance(productId, storeA, 50);
    const costObjectId = freshUuid();

    const consumptionId = freshUuid();
    const result = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.consumption.record',
        aggregate_type: 'STOCK_CONSUMPTION',
        aggregate_id: consumptionId,
        payload: {
          locationId: storeA,
          productId,
          quantityBase: 6,
          unitCode: 'TETE',
          quantity: 6,
          costObjectType: 'SITE',
          costObjectId,
          costType: 'ALIMENT',
        },
      }),
      adminCtx(),
    );
    expect(result.status).toBe('APPLIED');

    const row = await db
      .selectFrom('inventory_consumptions')
      .select(['status', 'value_xaf', 'cost_object_type'])
      .where('id', '=', toBin(consumptionId))
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('RECORDED');
    expect(Number(row.value_xaf)).toBe(1800); // 6 * 300 (CMUP courant)

    expect(await balanceOf(productId, storeA)).toBe(44);
    const vConsumption = await db
      .selectFrom('organization_locations')
      .select('id')
      .where('location_type', '=', 'V_CONSUMPTION')
      .executeTakeFirstOrThrow();
    expect(await balanceOf(productId, fromBin(vConsumption.id))).toBe(6);

    const costEntry = await db
      .selectFrom('inventory_cost_entries')
      .select(['direction', 'amount_xaf', 'cost_type', 'cost_object_id'])
      .where('cost_object_id', '=', toBin(costObjectId))
      .executeTakeFirstOrThrow();
    expect(costEntry.direction).toBe('DEBIT');
    expect(Number(costEntry.amount_xaf)).toBe(1800);
    expect(costEntry.cost_type).toBe('ALIMENT');
  });

  it('cancel : mouvement CONSUMPTION_REVERSAL au coût d’origine + écriture de coût inverse CREDIT', async () => {
    const productId = await insertProduct(admin);
    await openingBalance(productId, storeA, 50);
    const costObjectId = freshUuid();

    const consumptionId = freshUuid();
    await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.consumption.record',
        aggregate_type: 'STOCK_CONSUMPTION',
        aggregate_id: consumptionId,
        payload: {
          locationId: storeA,
          productId,
          quantityBase: 10,
          unitCode: 'TETE',
          quantity: 10,
          costObjectType: 'PRODUCTION_LOT',
          costObjectId,
          costType: 'VETERINAIRE',
        },
      }),
      adminCtx(),
    );
    expect(await balanceOf(productId, storeA)).toBe(40);

    const cancelResult = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.consumption.cancel',
        aggregate_type: 'STOCK_CONSUMPTION',
        aggregate_id: consumptionId,
        payload: { consumptionId, cancelComment: 'Saisie en double.' },
      }),
      adminCtx(),
    );
    expect(cancelResult.status).toBe('APPLIED');

    const row = await db
      .selectFrom('inventory_consumptions')
      .select(['status', 'cancel_comment'])
      .where('id', '=', toBin(consumptionId))
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('CANCELLED');
    expect(row.cancel_comment).toBe('Saisie en double.');

    // Stock intégralement revenu (BR-STK-052 : au coût d'origine, jamais recalculé).
    expect(await balanceOf(productId, storeA)).toBe(50);

    const reverseMove = await db
      .selectFrom('inventory_stock_moves')
      .select(['unit_cost_xaf', 'quantity'])
      .where('product_id', '=', toBin(productId))
      .where('move_type', '=', 'CONSUMPTION_REVERSAL')
      .where('source_doc_id', '=', toBin(consumptionId))
      .executeTakeFirstOrThrow();
    expect(Number(reverseMove.unit_cost_xaf)).toBe(300); // coût d'origine, pas le CMUP courant.
    expect(Number(reverseMove.quantity)).toBe(10);

    const entries = await db
      .selectFrom('inventory_cost_entries')
      .select(['direction', 'amount_xaf', 'reverses_entry_id'])
      .where('cost_object_id', '=', toBin(costObjectId))
      .orderBy('created_at', 'asc')
      .execute();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.direction).toBe('DEBIT');
    expect(entries[1]!.direction).toBe('CREDIT');
    expect(Number(entries[1]!.amount_xaf)).toBe(3000); // 10 * 300, identique au DEBIT d'origine.
    expect(entries[1]!.reverses_entry_id?.toString('hex')).toBeDefined();
  });

  it('cancel sur une consommation déjà annulée -> REJECTED CONSUMPTION_STATUS_INVALID', async () => {
    const productId = await insertProduct(admin);
    await openingBalance(productId, storeA, 20);
    const consumptionId = freshUuid();
    await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.consumption.record',
        aggregate_type: 'STOCK_CONSUMPTION',
        aggregate_id: consumptionId,
        payload: {
          locationId: storeA,
          productId,
          quantityBase: 3,
          unitCode: 'TETE',
          quantity: 3,
          costObjectType: 'SITE',
          costObjectId: freshUuid(),
          costType: 'AUTRE_INTRANT',
        },
      }),
      adminCtx(),
    );
    await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.consumption.cancel',
        aggregate_type: 'STOCK_CONSUMPTION',
        aggregate_id: consumptionId,
        payload: { consumptionId },
      }),
      adminCtx(),
    );

    const second = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.consumption.cancel',
        aggregate_type: 'STOCK_CONSUMPTION',
        aggregate_id: consumptionId,
        payload: { consumptionId },
      }),
      adminCtx(),
    );
    expect(second.status).toBe('REJECTED');
    expect(second.status === 'REJECTED' && second.error.code).toBe('CONSUMPTION_STATUS_INVALID');
  });
});
