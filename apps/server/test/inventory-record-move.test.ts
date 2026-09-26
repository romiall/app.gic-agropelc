/**
 * `recordStockMove` (P2-03) contre MySQL réel : partie double (INV-STK-01/02/03), CMUP
 * (AV-042), sélection FIFO multi-lots (BR-STK-050), refus en ligne d'un solde négatif
 * (BR-STK-017) vs acceptation hors ligne (BR-STK-018), validation des couples
 * source/destination (D06 §7.7).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Uuidv7Generator, FixedClock, type IdGenerator } from '@gic/domain';
import {
  recordStockMove,
  InventoryMoveError,
  type RecordMoveDeps,
} from '../src/modules/inventory/application/public/index.js';
import { toBin, fromBin } from '../src/platform/kysely/uuid-columns.js';
import {
  closeTestDb,
  db,
  freshUuid,
  insertTestLocation,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const OCCURRED_AT = new Date('2026-09-27T09:00:00.000Z');

async function insertProduct(
  trx: Parameters<typeof insertTestZone>[0],
  createdBy: string,
  overrides: { readonly lotTracking?: string } = {},
): Promise<string> {
  const categoryId = freshUuid();
  await trx
    .insertInto('catalog_product_categories')
    .values({
      id: toBin(categoryId),
      code: `CAT-${categoryId.slice(-8)}`,
      name: 'Test',
      created_by: toBin(createdBy),
    })
    .execute();
  const already = await trx
    .selectFrom('catalog_units')
    .select('code')
    .where('code', '=', 'TETE')
    .executeTakeFirst();
  if (!already) {
    await trx
      .insertInto('catalog_units')
      .values({ code: 'TETE', name: 'Tête', is_count: 1 })
      .execute();
  }
  const productId = freshUuid();
  await trx
    .insertInto('catalog_products')
    .values({
      id: toBin(productId),
      code: `PRD-${productId.slice(-8)}`,
      name: 'Produit de test',
      category_id: toBin(categoryId),
      stock_family: 'MARCHANDISE',
      base_unit_code: 'TETE',
      lot_tracking: overrides.lotTracking ?? 'NONE',
      created_by: toBin(createdBy),
    })
    .execute();
  return productId;
}

async function virtualLocationId(locationType: string): Promise<string> {
  const row = await db
    .selectFrom('organization_locations')
    .select('id')
    .where('location_type', '=', locationType)
    .executeTakeFirstOrThrow();
  return fromBin(row.id);
}

describe('recordStockMove (P2-03)', () => {
  let idGenerator: IdGenerator;
  let deps: RecordMoveDeps;
  let admin: string;
  let siteId: string;
  let storeId: string;

  beforeAll(async () => {
    idGenerator = new Uuidv7Generator(new FixedClock(OCCURRED_AT));
    deps = { idGenerator };
    admin = await db.transaction().execute((trx) => insertTestUser(trx));
    await db.transaction().execute(async (trx) => {
      const zoneId = await insertTestZone(trx, admin);
      siteId = await insertTestSite(trx, admin, zoneId);
      storeId = await insertTestLocation(trx, admin, siteId, { locationType: 'STORE' });
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('OPENING_BALANCE : entrée valorisée, CMUP initialisé, conservation respectée', async () => {
    const productId = await db.transaction().execute((trx) => insertProduct(trx, admin));
    const opening = await virtualLocationId('V_OPENING');

    await db.transaction().execute((trx) =>
      recordStockMove(trx, deps, {
        productId,
        quantityBase: 100,
        fromLocationId: opening,
        toLocationId: storeId,
        moveType: 'OPENING_BALANCE',
        declaredUnitCostXaf: 450,
        occurredAt: OCCURRED_AT,
        sourceDocType: 'INVENTORY_COUNT',
        sourceDocId: freshUuid(),
        createdBy: admin,
        allowNegative: false,
      }),
    );

    const storeBalance = await db
      .selectFrom('inventory_stock_balances')
      .select(['qty_on_hand'])
      .where('location_id', '=', toBin(storeId))
      .where('product_id', '=', toBin(productId))
      .executeTakeFirstOrThrow();
    expect(Number(storeBalance.qty_on_hand)).toBe(100);

    const openingBalance = await db
      .selectFrom('inventory_stock_balances')
      .select(['qty_on_hand'])
      .where('location_id', '=', toBin(opening))
      .where('product_id', '=', toBin(productId))
      .executeTakeFirstOrThrow();
    expect(Number(openingBalance.qty_on_hand)).toBe(-100); // INV-STK-03 : conservation.

    const valuation = await db
      .selectFrom('inventory_product_valuations')
      .select(['avg_unit_cost_xaf', 'qty_basis'])
      .where('product_id', '=', toBin(productId))
      .executeTakeFirstOrThrow();
    expect(Number(valuation.avg_unit_cost_xaf)).toBe(450);
    expect(Number(valuation.qty_basis)).toBe(100);
  });

  it('PURCHASE_RECEIPT : recalcule le CMUP par moyenne pondérée', async () => {
    const productId = await db.transaction().execute((trx) => insertProduct(trx, admin));
    const opening = await virtualLocationId('V_OPENING');
    const supplier = await virtualLocationId('V_SUPPLIER');

    await db.transaction().execute((trx) =>
      recordStockMove(trx, deps, {
        productId,
        quantityBase: 100,
        fromLocationId: opening,
        toLocationId: storeId,
        moveType: 'OPENING_BALANCE',
        declaredUnitCostXaf: 400,
        occurredAt: OCCURRED_AT,
        sourceDocType: 'INVENTORY_COUNT',
        sourceDocId: freshUuid(),
        createdBy: admin,
        allowNegative: false,
      }),
    );
    await db.transaction().execute((trx) =>
      recordStockMove(trx, deps, {
        productId,
        quantityBase: 50,
        fromLocationId: supplier,
        toLocationId: storeId,
        moveType: 'PURCHASE_RECEIPT',
        declaredUnitCostXaf: 460,
        occurredAt: OCCURRED_AT,
        sourceDocType: 'GOODS_RECEIPT',
        sourceDocId: freshUuid(),
        createdBy: admin,
        allowNegative: false,
      }),
    );

    const valuation = await db
      .selectFrom('inventory_product_valuations')
      .select(['avg_unit_cost_xaf', 'qty_basis'])
      .where('product_id', '=', toBin(productId))
      .executeTakeFirstOrThrow();
    // (100*400 + 50*460) / 150 = 420
    expect(Number(valuation.avg_unit_cost_xaf)).toBe(420);
    expect(Number(valuation.qty_basis)).toBe(150);
  });

  it('SALE : sortie au CMUP courant, V_CUSTOMER négatif (conservation)', async () => {
    const productId = await db.transaction().execute((trx) => insertProduct(trx, admin));
    const opening = await virtualLocationId('V_OPENING');
    const customer = await virtualLocationId('V_CUSTOMER');

    await db.transaction().execute((trx) =>
      recordStockMove(trx, deps, {
        productId,
        quantityBase: 100,
        fromLocationId: opening,
        toLocationId: storeId,
        moveType: 'OPENING_BALANCE',
        declaredUnitCostXaf: 450,
        occurredAt: OCCURRED_AT,
        sourceDocType: 'INVENTORY_COUNT',
        sourceDocId: freshUuid(),
        createdBy: admin,
        allowNegative: false,
      }),
    );
    const [saleMove] = await db.transaction().execute((trx) =>
      recordStockMove(trx, deps, {
        productId,
        quantityBase: 10,
        fromLocationId: storeId,
        toLocationId: customer,
        moveType: 'SALE',
        occurredAt: OCCURRED_AT,
        sourceDocType: 'SALE',
        sourceDocId: freshUuid(),
        createdBy: admin,
        allowNegative: false,
      }),
    );
    expect(saleMove!.unitCostXaf).toBe(450); // CMUP courant, pas de coût déclaré.

    const storeBalance = await db
      .selectFrom('inventory_stock_balances')
      .select(['qty_on_hand'])
      .where('location_id', '=', toBin(storeId))
      .where('product_id', '=', toBin(productId))
      .executeTakeFirstOrThrow();
    expect(Number(storeBalance.qty_on_hand)).toBe(90);
  });

  it('en ligne, une sortie qui rendrait le solde négatif est refusée (BR-STK-017)', async () => {
    const productId = await db.transaction().execute((trx) => insertProduct(trx, admin));
    const customer = await virtualLocationId('V_CUSTOMER');

    await expect(
      db.transaction().execute((trx) =>
        recordStockMove(trx, deps, {
          productId,
          quantityBase: 5,
          fromLocationId: storeId,
          toLocationId: customer,
          moveType: 'SALE',
          occurredAt: OCCURRED_AT,
          sourceDocType: 'SALE',
          sourceDocId: freshUuid(),
          createdBy: admin,
          allowNegative: false,
        }),
      ),
    ).rejects.toThrow(InventoryMoveError);
  });

  it('hors ligne, la même sortie est appliquée malgré un solde négatif (BR-STK-018)', async () => {
    const productId = await db.transaction().execute((trx) => insertProduct(trx, admin));
    const customer = await virtualLocationId('V_CUSTOMER');

    const [move] = await db.transaction().execute((trx) =>
      recordStockMove(trx, deps, {
        productId,
        quantityBase: 5,
        fromLocationId: storeId,
        toLocationId: customer,
        moveType: 'SALE',
        occurredAt: OCCURRED_AT,
        sourceDocType: 'SALE',
        sourceDocId: freshUuid(),
        createdBy: admin,
        capturedOffline: true,
        allowNegative: true,
      }),
    );
    expect(move!.fromBalanceAfter).toBe(-5);
  });

  it('couple source/destination invalide pour le type -> InventoryMoveError MOVE_TYPE_INVALID', async () => {
    const productId = await db.transaction().execute((trx) => insertProduct(trx, admin));
    const customer = await virtualLocationId('V_CUSTOMER');

    await expect(
      db.transaction().execute((trx) =>
        recordStockMove(trx, deps, {
          productId,
          quantityBase: 5,
          // SALE exige from=PHYSIQUE, to=V_CUSTOMER ; ici from=V_CUSTOMER est invalide.
          fromLocationId: customer,
          toLocationId: storeId,
          moveType: 'SALE',
          occurredAt: OCCURRED_AT,
          sourceDocType: 'SALE',
          sourceDocId: freshUuid(),
          createdBy: admin,
          allowNegative: false,
        }),
      ),
    ).rejects.toMatchObject({ code: 'MOVE_TYPE_INVALID' });
  });

  it('sortie sans lot désigné sur un produit multi-lots -> FIFO sur plusieurs lots (BR-STK-050)', async () => {
    const productId = await db
      .transaction()
      .execute((trx) => insertProduct(trx, admin, { lotTracking: 'OPTIONAL' }));
    const supplier = await virtualLocationId('V_SUPPLIER');
    const customer = await virtualLocationId('V_CUSTOMER');

    const lot1 = freshUuid();
    const lot2 = freshUuid();
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('inventory_stock_lots')
        .values({
          id: toBin(lot1),
          lot_code: `L1-${lot1.slice(-8)}`,
          product_id: toBin(productId),
          origin_type: 'SUPPLIER_LOT',
          fifo_rank_at: new Date('2026-09-01T00:00:00.000Z'),
          created_by: toBin(admin),
        })
        .execute();
      await trx
        .insertInto('inventory_stock_lots')
        .values({
          id: toBin(lot2),
          lot_code: `L2-${lot2.slice(-8)}`,
          product_id: toBin(productId),
          origin_type: 'SUPPLIER_LOT',
          fifo_rank_at: new Date('2026-09-15T00:00:00.000Z'),
          created_by: toBin(admin),
        })
        .execute();
    });

    await db.transaction().execute((trx) =>
      recordStockMove(trx, deps, {
        productId,
        lotId: lot1,
        quantityBase: 30,
        fromLocationId: supplier,
        toLocationId: storeId,
        moveType: 'PURCHASE_RECEIPT',
        declaredUnitCostXaf: 100,
        occurredAt: new Date('2026-09-01T00:00:00.000Z'),
        sourceDocType: 'GOODS_RECEIPT',
        sourceDocId: freshUuid(),
        createdBy: admin,
        allowNegative: false,
      }),
    );
    await db.transaction().execute((trx) =>
      recordStockMove(trx, deps, {
        productId,
        lotId: lot2,
        quantityBase: 50,
        fromLocationId: supplier,
        toLocationId: storeId,
        moveType: 'PURCHASE_RECEIPT',
        declaredUnitCostXaf: 110,
        occurredAt: new Date('2026-09-15T00:00:00.000Z'),
        sourceDocType: 'GOODS_RECEIPT',
        sourceDocId: freshUuid(),
        createdBy: admin,
        allowNegative: false,
      }),
    );

    // Sortie de 40 sans lot désigné : FIFO -> 30 du lot1 (le plus ancien) + 10 du lot2.
    const moves = await db.transaction().execute((trx) =>
      recordStockMove(trx, deps, {
        productId,
        quantityBase: 40,
        fromLocationId: storeId,
        toLocationId: customer,
        moveType: 'SALE',
        occurredAt: OCCURRED_AT,
        sourceDocType: 'SALE',
        sourceDocId: freshUuid(),
        createdBy: admin,
        allowNegative: false,
      }),
    );
    expect(moves).toHaveLength(2);
    const byLot = new Map(moves.map((m) => [m.lotId, m.quantity]));
    expect(byLot.get(lot1)).toBe(30);
    expect(byLot.get(lot2)).toBe(10);

    const lot1Balance = await db
      .selectFrom('inventory_stock_balances')
      .select(['qty_on_hand'])
      .where('location_id', '=', toBin(storeId))
      .where('product_id', '=', toBin(productId))
      .where('lot_key', '=', toBin(lot1))
      .executeTakeFirstOrThrow();
    expect(Number(lot1Balance.qty_on_hand)).toBe(0);
    const lot2Balance = await db
      .selectFrom('inventory_stock_balances')
      .select(['qty_on_hand'])
      .where('location_id', '=', toBin(storeId))
      .where('product_id', '=', toBin(productId))
      .where('lot_key', '=', toBin(lot2))
      .executeTakeFirstOrThrow();
    expect(Number(lot2Balance.qty_on_hand)).toBe(40);
  });
});
