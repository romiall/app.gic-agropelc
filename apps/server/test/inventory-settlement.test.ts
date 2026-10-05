/**
 * P4-03 — règlement de la marchandise vendue (ADR-029 ; INV-STK-16 à 18, BR-STK-055 à 057) :
 * annulation totale ou partielle d'une vente (`returnSoldGoods`), livraison d'une commande
 * (`deliverSoldGoods`), net d'une ligne (`soldGoodsPosition`), emplacement « à livrer » d'un site
 * (`ensureToDeliverLocation`). Flux F1 à F7 de l'ADR sur une base réelle, avec le compte
 * applicatif `gic_app` (aucun droit `UPDATE` sur le registre : aucune lecture verrouillante).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import type { Transaction } from 'kysely';
import type { DB } from '../src/platform/kysely/database.js';
import {
  InventoryMoveError,
  biologicalLotRemainingCostXaf,
  biologicalLotUnitCostXaf,
  createStockLot,
  deliverSoldGoods,
  lotHeadcount,
  recordCostEntry,
  recordStockMove,
  returnSoldGoods,
  reverseDocumentMoves,
  setStockLotStatus,
  soldGoodsPosition,
  verifyStockLedger,
  virtualLocationId,
  type MoveType,
  type SettledMove,
} from '../src/modules/inventory/application/public/index.js';
import {
  ensureToDeliverLocation,
  ToDeliverLocationError,
} from '../src/modules/organization/application/public/index.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  closeTestDb,
  db,
  freshUuid,
  insertTestLocation,
  insertTestSite,
  insertTestUser,
  insertTestZone,
} from './helpers.js';

const NOW = new Date('2026-10-09T18:00:00.000Z');
const at = (hhmmss: string) => new Date(`2026-10-09T${hhmmss}.000Z`);

describe('P4-03 : règlement de la marchandise vendue (ADR-029)', () => {
  let idGenerator: IdGenerator;
  let admin: string;
  let zoneId: string;
  let siteId: string;
  let storeId: string;
  let buildingId: string;
  let toDeliverId: string;
  let categoryId: string;

  async function tx<T>(fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    return db.transaction().execute(fn);
  }

  async function newProduct(
    options: { biological?: boolean; lotTracking?: 'NONE' | 'REQUIRED' } = {},
  ): Promise<string> {
    const id = freshUuid();
    await db
      .insertInto('catalog_products')
      .values({
        id: toBin(id),
        code: `PRD-${id.slice(-10)}`,
        name: options.biological ? 'Porc de test' : 'Marchandise de test',
        category_id: toBin(categoryId),
        stock_family: options.biological ? 'BIOLOGIQUE' : 'MARCHANDISE',
        species: options.biological ? 'PORC' : null,
        base_unit_code: 'TETE',
        lot_tracking: options.lotTracking ?? (options.biological ? 'REQUIRED' : 'NONE'),
        created_by: toBin(admin),
      })
      .execute();
    return id;
  }

  async function newLot(
    originType: 'PRODUCTION_LOT' | 'COLLECTION',
    productId: string,
    rank: string,
  ): Promise<{ readonly lotId: string; readonly originId: string }> {
    const originId = freshUuid();
    const lotId = await tx((trx) =>
      createStockLot(
        trx,
        { idGenerator },
        {
          originType,
          originId,
          lotCode: `T-${originId.slice(-12)}`,
          productId,
          fifoRankAt: at(rank),
          expiryDate: null,
          createdBy: admin,
        },
      ),
    );
    return { lotId, originId };
  }

  async function record(
    trx: Transaction<DB>,
    input: {
      productId: string;
      lotId?: string;
      quantityBase: number;
      from: string;
      to: string;
      moveType: MoveType;
      sourceDocType?: 'GOODS_RECEIPT' | 'SALE' | 'LOT_ENTRY';
      sourceDocId?: string;
      sourceLineId?: string;
      declaredUnitCostXaf?: number;
      declaredValueXaf?: number;
      reversesMoveId?: string;
      originMoveId?: string;
    },
  ) {
    return recordStockMove(
      trx,
      { idGenerator },
      {
        productId: input.productId,
        ...(input.lotId !== undefined ? { lotId: input.lotId } : {}),
        quantityBase: input.quantityBase,
        fromLocationId: input.from.startsWith('V_')
          ? await virtualLocationId(trx, input.from)
          : input.from,
        toLocationId: input.to.startsWith('V_') ? await virtualLocationId(trx, input.to) : input.to,
        moveType: input.moveType,
        ...(input.declaredUnitCostXaf !== undefined
          ? { declaredUnitCostXaf: input.declaredUnitCostXaf }
          : {}),
        ...(input.declaredValueXaf !== undefined
          ? { declaredValueXaf: input.declaredValueXaf }
          : {}),
        ...(input.reversesMoveId !== undefined ? { reversesMoveId: input.reversesMoveId } : {}),
        ...(input.originMoveId !== undefined ? { originMoveId: input.originMoveId } : {}),
        occurredAt: at('10:00:00'),
        sourceDocType: input.sourceDocType ?? 'GOODS_RECEIPT',
        sourceDocId: input.sourceDocId ?? freshUuid(),
        ...(input.sourceLineId !== undefined ? { sourceLineId: input.sourceLineId } : {}),
        createdBy: admin,
        allowNegative: false,
      },
    );
  }

  /** Entre du stock dans un emplacement physique (réception valorisée). */
  async function receive(
    productId: string,
    quantity: number,
    unitCost: number,
    options: { lotId?: string; location?: string } = {},
  ): Promise<void> {
    await tx((trx) =>
      record(trx, {
        productId,
        ...(options.lotId !== undefined ? { lotId: options.lotId } : {}),
        quantityBase: quantity,
        from: 'V_SUPPLIER',
        to: options.location ?? storeId,
        moveType: 'PURCHASE_RECEIPT',
        declaredUnitCostXaf: unitCost,
      }),
    );
  }

  interface Line {
    readonly saleId: string;
    readonly saleLineId: string;
  }

  /** Vente : `to` est `V_CUSTOMER` (directe) ou l'emplacement « à livrer » (commande). */
  async function sell(
    productId: string,
    quantity: number,
    options: {
      to?: string;
      from?: string;
      lotId?: string;
      declaredValueXaf?: number;
      line?: Line;
    } = {},
  ): Promise<Line> {
    const line = options.line ?? { saleId: freshUuid(), saleLineId: freshUuid() };
    await tx((trx) =>
      record(trx, {
        productId,
        ...(options.lotId !== undefined ? { lotId: options.lotId } : {}),
        quantityBase: quantity,
        from: options.from ?? storeId,
        to: options.to ?? 'V_CUSTOMER',
        moveType: 'SALE',
        sourceDocType: 'SALE',
        sourceDocId: line.saleId,
        sourceLineId: line.saleLineId,
        ...(options.declaredValueXaf !== undefined
          ? { declaredValueXaf: options.declaredValueXaf }
          : {}),
      }),
    );
    return line;
  }

  const settleInput = (line: Line, quantityBase: number, lotId?: string) => ({
    ...line,
    quantityBase,
    ...(lotId !== undefined ? { lotId } : {}),
    sourceDocId: freshUuid(),
    occurredAt: at('11:00:00'),
    createdBy: admin,
  });

  const giveBack = (
    line: Line,
    quantity: number,
    lotId?: string,
  ): Promise<readonly SettledMove[]> =>
    tx((trx) => returnSoldGoods(trx, { idGenerator }, settleInput(line, quantity, lotId)));

  const deliver = (line: Line, quantity: number): Promise<readonly SettledMove[]> =>
    tx((trx) => deliverSoldGoods(trx, { idGenerator }, settleInput(line, quantity)));

  const position = (line: Line) => soldGoodsPosition(db, line);

  async function rejection(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof InventoryMoveError) return error.code;
      throw error;
    }
    throw new Error('rejet attendu');
  }

  async function balance(locationId: string, productId: string): Promise<number> {
    const rows = await db
      .selectFrom('inventory_stock_balances')
      .select('qty_on_hand')
      .where('location_id', '=', toBin(locationId))
      .where('product_id', '=', toBin(productId))
      .execute();
    return rows.reduce((sum, row) => sum + Number(row.qty_on_hand), 0);
  }

  async function customerBalance(productId: string): Promise<number> {
    return tx(async (trx) => balance(await virtualLocationId(trx, 'V_CUSTOMER'), productId));
  }

  beforeAll(async () => {
    idGenerator = new Uuidv7Generator(new FixedClock(NOW));
    await tx(async (trx) => {
      admin = await insertTestUser(trx);
      zoneId = await insertTestZone(trx, admin);
      siteId = await insertTestSite(trx, admin, zoneId, { siteType: 'FERME' });
      storeId = await insertTestLocation(trx, admin, siteId);
      buildingId = await insertTestLocation(trx, admin, siteId, { locationType: 'BUILDING' });
      toDeliverId = (
        await ensureToDeliverLocation(trx, { idGenerator }, { siteId, createdBy: admin })
      ).locationId;
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
      categoryId = freshUuid();
      await trx
        .insertInto('catalog_product_categories')
        .values({
          id: toBin(categoryId),
          code: `CAT-${categoryId.slice(-8)}`,
          name: 'P4-03',
          created_by: toBin(admin),
        })
        .execute();
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // -------------------------------------------------------------------------------------------

  it('F1 — vente directe annulée en totalité : un retour, net nul en quantité et en valeur', async () => {
    const product = await newProduct();
    await receive(product, 10, 100);
    const line = await sell(product, 10);
    expect(await customerBalance(product)).toBe(10);

    const settled = await giveBack(line, 10);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ quantity: 10, valueXaf: 1000, unitCostXaf: 100 });

    expect(await position(line)).toMatchObject({
      soldQuantity: 10,
      returnedQuantity: 10,
      netQuantity: 0,
      remainingQuantity: 0,
      soldValueXaf: 1000,
      returnedValueXaf: 1000,
      netValueXaf: 0,
    });
    expect(await balance(storeId, product)).toBe(10);
    expect(await customerBalance(product)).toBe(0);

    // Le mouvement n'est pas un inverse : rattaché à la vente (ADR-029).
    const rows = await db
      .selectFrom('inventory_stock_moves')
      .select(['is_reversal', 'reverses_move_id', 'origin_seq', 'move_type', 'source_doc_type'])
      .where('origin_move_id', '=', toBin(settled[0]!.originMoveId))
      .execute();
    expect(rows).toEqual([
      {
        is_reversal: 0,
        reverses_move_id: null,
        origin_seq: 1,
        move_type: 'CUSTOMER_RETURN',
        source_doc_type: 'SALE_CANCELLATION',
      },
    ]);
  });

  it('F2 — annulée en deux fois (2 puis 8 sur 1 001) : valeur exacte ; au-delà, refus sans mouvement', async () => {
    const product = await newProduct();
    await receive(product, 10, 100);
    const line = await sell(product, 10, { declaredValueXaf: 1001 });

    const first = await giveBack(line, 2);
    const second = await giveBack(line, 8);
    expect([first[0]!.valueXaf, second[0]!.valueXaf]).toEqual([200, 801]);
    expect((await position(line)).returnedValueXaf).toBe(1001);

    expect(await rejection(giveBack(line, 1))).toBe('SETTLEMENT_EXCEEDS_REMAINING');

    // 11 sur 10 : refusé avant tout mouvement.
    const other = await sell(product, 5);
    expect(await rejection(giveBack(other, 6))).toBe('SETTLEMENT_EXCEEDS_REMAINING');
    expect((await position(other)).returnedQuantity).toBe(0);
    expect(await rejection(giveBack(other, 0))).toBe('QUANTITY_INVALID');
  });

  it('F3 — ligne répartie sur deux lots par le FIFO : le retour reprend le lot le plus récent d’abord', async () => {
    const product = await newProduct({ lotTracking: 'REQUIRED' });
    const older = await newLot('COLLECTION', product, '06:00:00');
    const newer = await newLot('COLLECTION', product, '07:00:00');
    await receive(product, 6, 100, { lotId: older.lotId });
    await receive(product, 4, 110, { lotId: newer.lotId });

    // FIFO : 6 du lot ancien et 4 du lot récent, valorisés au CMUP du produit (104) : 624 et 416.
    const line = await sell(product, 10);
    expect((await position(line)).soldValueXaf).toBe(1040);

    // 3 sur les 4 du lot récent : ⌊(2 × 416 × 3 000 + 4 000) / 8 000⌋ = 312.
    const first = await giveBack(line, 3);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ lotId: newer.lotId, quantity: 3, valueXaf: 312 });

    // Puis le reste du lot récent (104) et 4 sur les 6 du lot ancien (⌊…⌋ = 416).
    const second = await giveBack(line, 5);
    expect(second.map((move) => [move.lotId, move.quantity, move.valueXaf])).toEqual([
      [newer.lotId, 1, 104],
      [older.lotId, 4, 416],
    ]);
    const after = await position(line);
    expect(after).toMatchObject({ netQuantity: 2, returnedQuantity: 8, netValueXaf: 208 });
    // Le net est celui d'une vente de 2 pièces du lot le plus ancien.
    expect(after.origins.map((o) => [o.lotId, o.remainingQuantity])).toEqual([
      [older.lotId, 2],
      [newer.lotId, 0],
    ]);

    // Retour ciblé sur un lot (perte ciblée, AV-131).
    const targeted = await giveBack(line, 1, older.lotId);
    expect(targeted[0]).toMatchObject({ lotId: older.lotId, quantity: 1 });
    expect(await rejection(giveBack(line, 1, newer.lotId))).toBe('SETTLEMENT_EXCEEDS_REMAINING');
  });

  it('F4 — commande : vente vers « à livrer », livraison de 4, annulation des 6 restants', async () => {
    const product = await newProduct();
    await receive(product, 10, 100);
    const line = await sell(product, 10, { to: toDeliverId, declaredValueXaf: 2400 });
    expect(await balance(toDeliverId, product)).toBe(10);
    expect(await balance(storeId, product)).toBe(0);

    const delivery = await deliver(line, 4);
    expect(delivery[0]).toMatchObject({ quantity: 4, valueXaf: 960 });
    expect(await balance(toDeliverId, product)).toBe(6);
    expect(await customerBalance(product)).toBe(4);

    const mid = await position(line);
    expect(mid).toMatchObject({ deliveredQuantity: 4, remainingQuantity: 6, netQuantity: 10 });

    const cancel = await giveBack(line, 6);
    expect(cancel[0]).toMatchObject({ quantity: 6, valueXaf: 1440 });
    expect(await balance(toDeliverId, product)).toBe(0);
    expect(await balance(storeId, product)).toBe(6);

    expect(await position(line)).toMatchObject({
      soldQuantity: 10,
      deliveredQuantity: 4,
      returnedQuantity: 6,
      remainingQuantity: 0,
      deliveredValueXaf: 960,
      returnedValueXaf: 1440,
      netValueXaf: 960,
    });
    // Plus rien à livrer ni à annuler.
    expect(await rejection(deliver(line, 1))).toBe('SETTLEMENT_EXCEEDS_REMAINING');
    expect(await rejection(giveBack(line, 1))).toBe('SETTLEMENT_EXCEEDS_REMAINING');
  });

  it('F4 — « livrer puis annuler deux fois » ne passe pas même si une autre commande alimente le solde', async () => {
    const product = await newProduct();
    await receive(product, 20, 100);
    const first = await sell(product, 10, { to: toDeliverId });
    await sell(product, 10, { to: toDeliverId }); // alimente le même solde « à livrer »
    await deliver(first, 10);
    expect(await balance(toDeliverId, product)).toBe(10);
    // Annuler 10 de la première vente : tout est livré, le solde mutualisé ne doit pas être entamé.
    expect(await rejection(giveBack(first, 10))).toBe('SETTLEMENT_EXCEEDS_REMAINING');
    expect(await balance(toDeliverId, product)).toBe(10);
  });

  it('une vente directe ne se livre pas', async () => {
    const product = await newProduct();
    await receive(product, 3, 100);
    const line = await sell(product, 3);
    expect(await rejection(deliver(line, 3))).toBe('SETTLEMENT_EXCEEDS_REMAINING');
  });

  it('F5 — lot biologique : coût restant, effectif et coût par tête exacts à chaque étape', async () => {
    const pig = await newProduct({ biological: true });
    const { lotId, originId } = await newLot('PRODUCTION_LOT', pig, '06:00:00');
    await tx((trx) =>
      record(trx, {
        productId: pig,
        lotId,
        quantityBase: 3,
        from: 'V_PRODUCTION',
        to: buildingId,
        moveType: 'PRODUCTION_OUTPUT',
        sourceDocType: 'LOT_ENTRY',
        declaredUnitCostXaf: 10,
      }),
    );
    await tx((trx) =>
      recordCostEntry(
        trx,
        { idGenerator },
        {
          costObjectType: 'PRODUCTION_LOT',
          costObjectId: originId,
          costType: 'ANIMAUX',
          amountXaf: 100,
          direction: 'DEBIT',
          sourceType: 'MANUAL',
          sourceId: freshUuid(),
          occurredAt: at('08:00:00'),
          createdBy: admin,
          comment: 'Test P4-03',
        },
      ),
    );
    const remainingCost = () => tx((trx) => biologicalLotRemainingCostXaf(trx, lotId));
    const headcount = () => tx((trx) => lotHeadcount(trx, { lotId, scope: 'UNSOLD' }));
    expect(await remainingCost()).toBe(100);

    // Les 3 têtes sont vendues sur commande : la dernière sortie emporte tout le coût restant.
    const line = await sell(pig, 3, { lotId, from: buildingId, to: toDeliverId });
    expect((await position(line)).soldValueXaf).toBe(100);
    expect(await remainingCost()).toBe(0);
    expect(await headcount()).toBe(0);

    // Livraisons de 1 puis 1 : 33 + 34 ; la livraison n'est pas une seconde sortie.
    expect((await deliver(line, 1))[0]!.valueXaf).toBe(33);
    expect((await deliver(line, 1))[0]!.valueXaf).toBe(34);
    expect(await remainingCost()).toBe(0);

    // Annulation de la dernière tête : 33 francs reviennent au lot, la tête aussi.
    expect((await giveBack(line, 1))[0]!.valueXaf).toBe(33);
    expect(await remainingCost()).toBe(33);
    expect(await headcount()).toBe(1);
    expect(await tx((trx) => biologicalLotUnitCostXaf(trx, lotId))).toBe(33);
    // Σ sorties nettes + coût restant = coût du lot, au franc près.
    expect((await position(line)).netValueXaf + (await remainingCost())).toBe(100);
  });

  it('F5 — annulation totale d’une vente de lot biologique : la valeur d’origine revient exactement ; lot clôturé toléré', async () => {
    const pig = await newProduct({ biological: true });
    const { lotId, originId } = await newLot('PRODUCTION_LOT', pig, '06:00:00');
    await tx((trx) =>
      record(trx, {
        productId: pig,
        lotId,
        quantityBase: 3,
        from: 'V_PRODUCTION',
        to: buildingId,
        moveType: 'PRODUCTION_OUTPUT',
        sourceDocType: 'LOT_ENTRY',
        declaredUnitCostXaf: 10,
      }),
    );
    await tx((trx) =>
      recordCostEntry(
        trx,
        { idGenerator },
        {
          costObjectType: 'PRODUCTION_LOT',
          costObjectId: originId,
          costType: 'ANIMAUX',
          amountXaf: 101,
          direction: 'DEBIT',
          sourceType: 'MANUAL',
          sourceId: freshUuid(),
          occurredAt: at('08:00:00'),
          createdBy: admin,
          comment: 'Test P4-03',
        },
      ),
    );
    const line = await sell(pig, 3, { lotId, from: buildingId });
    expect((await position(line)).soldValueXaf).toBe(101);
    // Le lot est clôturé (effectif non vendu nul) : le retour est tout de même accepté.
    await tx((trx) => setStockLotStatus(trx, lotId, 'CLOSED'));
    const settled = await giveBack(line, 3);
    expect(settled[0]).toMatchObject({ quantity: 3, valueXaf: 101 });
    expect(await tx((trx) => biologicalLotRemainingCostXaf(trx, lotId))).toBe(101);
    // Mais une nouvelle vente reste refusée sur un lot clôturé (INV-PRD-02).
    expect(await rejection(sell(pig, 1, { lotId, from: buildingId }))).toBe('LOT_CLOSED');
  });

  it('garde-fous : une vente, une livraison et un retour ne s’inversent pas ; origine exigée et contrôlée', async () => {
    const product = await newProduct();
    const other = await newProduct();
    await receive(product, 10, 100);
    await receive(other, 10, 100);
    const line = await sell(product, 10);
    const originId = (await position(line)).origins[0]!.moveId;

    const attempt = (input: Parameters<typeof record>[1]) =>
      rejection(tx((trx) => record(trx, input)));
    const returnOf = {
      productId: product,
      quantityBase: 1,
      from: 'V_CUSTOMER',
      to: storeId,
      moveType: 'CUSTOMER_RETURN' as const,
    };

    // Un retour cite toujours le SALE dont il consomme une part ; un autre type n'en cite pas.
    expect(await attempt(returnOf)).toBe('ORIGIN_REQUIRED');
    expect(
      await attempt({
        productId: product,
        quantityBase: 1,
        from: storeId,
        to: 'V_CUSTOMER',
        moveType: 'SALE',
        sourceDocType: 'SALE',
        originMoveId: originId,
      }),
    ).toBe('ORIGIN_INVALID');
    // Un mouvement rattaché n'est pas un inverse.
    expect(await attempt({ ...returnOf, originMoveId: originId, reversesMoveId: originId })).toBe(
      'ORIGIN_INVALID',
    );
    // Autre produit que celui de l'origine ; retour vers un autre emplacement que le départ.
    expect(await attempt({ ...returnOf, productId: other, originMoveId: originId })).toBe(
      'ORIGIN_INVALID',
    );
    expect(await attempt({ ...returnOf, to: buildingId, originMoveId: originId })).toBe(
      'ORIGIN_INVALID',
    );

    // Un retour ne s'inverse pas non plus : le stock repartirait chez le client.
    const [returned] = await giveBack(line, 4);
    expect(
      await attempt({
        productId: product,
        quantityBase: 4,
        from: storeId,
        to: 'V_CUSTOMER',
        moveType: 'SALE',
        sourceDocType: 'SALE',
        reversesMoveId: returned!.moveId,
      }),
    ).toBe('REVERSAL_INVALID');

    // Inverser le document d'une vente par la voie des inverses : refusé.
    expect(
      await rejection(
        tx((trx) =>
          reverseDocumentMoves(
            trx,
            { idGenerator },
            {
              sourceDocType: 'SALE',
              sourceDocId: line.saleId,
              occurredAt: at('12:00:00'),
              createdBy: admin,
              allowNegative: false,
            },
          ),
        ),
      ),
    ).toBe('MOVE_TYPE_INVALID');
  });

  it('un SALE vers l’emplacement « à livrer » d’un autre site est refusé (INV-STK-18)', async () => {
    const product = await newProduct();
    await receive(product, 2, 100);
    const otherToDeliver = await tx(async (trx) => {
      const otherSite = await insertTestSite(trx, admin, zoneId);
      return (
        await ensureToDeliverLocation(trx, { idGenerator }, { siteId: otherSite, createdBy: admin })
      ).locationId;
    });
    expect(await rejection(sell(product, 1, { to: otherToDeliver }))).toBe('LOCATION_INVALID');
    expect((await balance(otherToDeliver, product)) + (await balance(storeId, product))).toBe(2);
  });

  it('concurrence : deux annulations simultanées de 6 sur 10 — une seule aboutit, l’autre échoue sans dépassement', async () => {
    const product = await newProduct();
    await receive(product, 10, 100);
    const line = await sell(product, 10);

    // A écrit son retour sans le valider ; B part du même état (rien de visible), calcule le même
    // rang de séquence et attend la clé d'unicité jusqu'à la validation de A.
    let second!: Promise<unknown>;
    await db.transaction().execute(async (trxA) => {
      await returnSoldGoods(trxA, { idGenerator }, settleInput(line, 6));
      second = db
        .transaction()
        .execute((trxB) => returnSoldGoods(trxB, { idGenerator }, settleInput(line, 6)))
        .then(
          () => 'OK' as const,
          (error: unknown) => error,
        );
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    const outcome = await second;

    // B a échoué : doublon de séquence (erreur réessayable) ou, si elle a vu l'état validé, rejet
    // métier ; jamais de dépassement.
    expect(outcome).not.toBe('OK');
    const verdict =
      outcome instanceof InventoryMoveError
        ? outcome.code
        : (outcome as { errno?: number }).errno === 1062
          ? 'DUPLICATE_SEQ'
          : 'AUTRE';
    expect(['DUPLICATE_SEQ', 'SETTLEMENT_EXCEEDS_REMAINING']).toContain(verdict);
    expect((await position(line)).returnedQuantity).toBe(6);
    // Rejouée sur l'état validé, la seconde annulation est un rejet métier définitif.
    expect(await rejection(giveBack(line, 6))).toBe('SETTLEMENT_EXCEEDS_REMAINING');
  });

  it('la réconciliation du registre ne relève aucun écart (INV-STK-17 et INV-STK-18)', async () => {
    const product = await newProduct();
    await receive(product, 10, 100);
    const line = await sell(product, 10, { to: toDeliverId, declaredValueXaf: 999 });
    await deliver(line, 3);
    await giveBack(line, 7);
    const verification = await tx((trx) => verifyStockLedger(trx, { productIds: [product] }));
    expect(verification).toMatchObject({
      ok: true,
      mismatches: [],
      conservationBreaches: [],
      toDeliverBreaches: [],
      settlementBreaches: [],
    });
  });

  it('emplacement « à livrer » : créé une fois par site, retrouvé ensuite, création concurrente sans doublon', async () => {
    const result = await tx(async (trx) => {
      const site = await insertTestSite(trx, admin, zoneId);
      return site;
    });
    const [a, b] = await Promise.all([
      tx((trx) =>
        ensureToDeliverLocation(trx, { idGenerator }, { siteId: result, createdBy: admin }),
      ),
      tx((trx) =>
        ensureToDeliverLocation(trx, { idGenerator }, { siteId: result, createdBy: admin }),
      ),
    ]);
    expect(a.locationId).toBe(b.locationId);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    const again = await tx((trx) =>
      ensureToDeliverLocation(trx, { idGenerator }, { siteId: result, createdBy: admin }),
    );
    expect(again).toMatchObject({ locationId: a.locationId, created: false });
    const rows = await db
      .selectFrom('organization_locations')
      .select(['location_type', 'is_virtual'])
      .where('site_id', '=', toBin(result))
      .where('location_type', '=', 'V_TO_DELIVER')
      .execute();
    expect(rows).toEqual([{ location_type: 'V_TO_DELIVER', is_virtual: 1 }]);

    let error: unknown;
    try {
      await tx((trx) =>
        ensureToDeliverLocation(trx, { idGenerator }, { siteId: freshUuid(), createdBy: admin }),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ToDeliverLocationError);
    expect((error as ToDeliverLocationError).code).toBe('SITE_NOT_FOUND');
  });
});
