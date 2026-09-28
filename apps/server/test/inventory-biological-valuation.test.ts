/**
 * P7-03 — valorisation des lots biologiques dans `recordStockMove` (ADR-027 ; AV-097, AV-098,
 * AV-100) sur l'exemple de la stratégie finance (lot de 2 400 poulets, coût 5 600 000 XAF,
 * 90 morts) :
 * - coût par tête = coût restant ÷ effectif non vendu : les ventes sortent à 2 424 et non plus à
 *   4 275 (formule écrite), et la somme des sorties égale exactement le coût du lot ;
 * - la mortalité ne réduit pas le coût restant (BR-PRD-013) ;
 * - le transit restitue exactement la valeur expédiée ;
 * - aucun CMUP pour un lot biologique ; CMUP recalculé pour une production commercialisable
 *   déclarée (œufs au coût standard, découpes d'abattage à valeur répartie) ;
 * - incubation : rendement à 0 au mirage, poussins au coût du lot ÷ viables (BR-INC-009) ;
 * - lot clôturé : mouvement refusé en ligne, appliqué hors ligne (INV-PRD-02) ;
 * - écart d'inventaire sur un lot d'animaux valorisé au coût par tête.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import type { Transaction } from 'kysely';
import type { DB } from '../src/platform/kysely/database.js';
import {
  InventoryMoveError,
  biologicalLotUnitCostXaf,
  createStockLot,
  recordCostEntry,
  recordStockMove,
  setStockLotStatus,
  virtualLocationId,
  type MoveType,
  type RecordedMove,
} from '../src/modules/inventory/application/public/index.js';
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

describe('P7-03 : valorisation des lots biologiques (ADR-027)', () => {
  let idGenerator: IdGenerator;
  let admin: string;
  let buildingId: string;
  let storeId: string;
  let chickenId: string;
  let eggId: string;
  let carcassId: string;
  let chickId: string;
  let hatchingEggId: string;

  async function tx<T>(fn: (trx: Transaction<DB>) => Promise<T>): Promise<T> {
    return db.transaction().execute(fn);
  }

  async function move(
    input: {
      productId: string;
      lotId: string;
      quantityBase: number;
      from: string;
      to: string;
      moveType: MoveType;
      declaredUnitCostXaf?: number;
      declaredValueXaf?: number;
      allowNegative?: boolean;
      reversesMoveId?: string;
    },
    occurredAt = at('10:00:00'),
  ): Promise<RecordedMove> {
    const [recorded] = await tx(async (trx) =>
      recordStockMove(
        trx,
        { idGenerator },
        {
          productId: input.productId,
          lotId: input.lotId,
          quantityBase: input.quantityBase,
          fromLocationId: await resolve(trx, input.from),
          toLocationId: await resolve(trx, input.to),
          moveType: input.moveType,
          ...(input.declaredUnitCostXaf !== undefined
            ? { declaredUnitCostXaf: input.declaredUnitCostXaf }
            : {}),
          ...(input.declaredValueXaf !== undefined
            ? { declaredValueXaf: input.declaredValueXaf }
            : {}),
          ...(input.reversesMoveId !== undefined ? { reversesMoveId: input.reversesMoveId } : {}),
          occurredAt,
          sourceDocType: 'LOT_ENTRY',
          sourceDocId: freshUuid(),
          createdBy: admin,
          allowNegative: input.allowNegative ?? false,
        },
      ),
    );
    return recorded!;
  }

  async function resolve(trx: Transaction<DB>, location: string): Promise<string> {
    return location.startsWith('V_') ? virtualLocationId(trx, location) : location;
  }

  async function newLot(
    originType: 'PRODUCTION_LOT' | 'INCUBATION_BATCH' | 'COLLECTION' | 'TRANSFORMATION',
    productId: string | null,
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
          fifoRankAt: at('06:00:00'),
          expiryDate: null,
          createdBy: admin,
        },
      ),
    );
    return { lotId, originId };
  }

  async function debit(
    costObjectType: 'PRODUCTION_LOT' | 'INCUBATION_BATCH',
    costObjectId: string,
    costType: 'ANIMAUX' | 'ALIMENT' | 'VETERINAIRE' | 'DEPENSE_DIRECTE' | 'OEUFS',
    amountXaf: number,
  ): Promise<void> {
    await tx((trx) =>
      recordCostEntry(
        trx,
        { idGenerator },
        {
          costObjectType,
          costObjectId,
          costType,
          amountXaf,
          direction: 'DEBIT',
          sourceType: 'MANUAL',
          sourceId: freshUuid(),
          occurredAt: at('08:00:00'),
          createdBy: admin,
          comment: 'Test P7-03',
        },
      ),
    );
  }

  async function cmupOf(productId: string): Promise<number | null> {
    const row = await db
      .selectFrom('inventory_product_valuations')
      .select('avg_unit_cost_xaf')
      .where('product_id', '=', toBin(productId))
      .executeTakeFirst();
    return row ? Number(row.avg_unit_cost_xaf) : null;
  }

  beforeAll(async () => {
    idGenerator = new Uuidv7Generator(new FixedClock(NOW));
    await tx(async (trx) => {
      admin = await insertTestUser(trx);
      const zoneId = await insertTestZone(trx, admin);
      const farmId = await insertTestSite(trx, admin, zoneId, { siteType: 'FERME' });
      buildingId = await insertTestLocation(trx, admin, farmId, { locationType: 'BUILDING' });
      storeId = await insertTestLocation(trx, admin, farmId);
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
          name: 'P7-03',
          created_by: toBin(admin),
        })
        .execute();
      const product = async (name: string, family: string, species: string | null) => {
        const id = freshUuid();
        await trx
          .insertInto('catalog_products')
          .values({
            id: toBin(id),
            code: `PRD-${id.slice(-8)}`,
            name,
            category_id: toBin(categoryId),
            stock_family: family,
            species,
            base_unit_code: 'TETE',
            lot_tracking: 'REQUIRED',
            created_by: toBin(admin),
          })
          .execute();
        return id;
      };
      chickenId = await product('Poulet de chair vif', 'BIOLOGIQUE', 'POULET_CHAIR');
      chickId = await product('Poussin d’un jour', 'BIOLOGIQUE', 'POULET_CHAIR');
      eggId = await product('Œuf de consommation GROS', 'PRODUCTION_COMMERCIALISABLE', null);
      hatchingEggId = await product('Œuf à couver', 'PRODUCTION_COMMERCIALISABLE', null);
      carcassId = await product('Poulet entier abattu', 'PRODUCTION_COMMERCIALISABLE', null);
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('exemple de la stratégie finance : ventes au coût restant, conservation exacte du coût du lot', async () => {
    const { lotId, originId } = await newLot('PRODUCTION_LOT', chickenId);
    const placement = await move({
      productId: chickenId,
      lotId,
      quantityBase: 2400,
      from: 'V_PRODUCTION',
      to: buildingId,
      moveType: 'PRODUCTION_OUTPUT',
      declaredUnitCostXaf: 450,
    });
    expect(placement.valueXaf).toBe(1_080_000);
    await debit('PRODUCTION_LOT', originId, 'ANIMAUX', 1_080_000);
    await debit('PRODUCTION_LOT', originId, 'ALIMENT', 4_200_000);
    await debit('PRODUCTION_LOT', originId, 'VETERINAIRE', 180_000);
    await debit('PRODUCTION_LOT', originId, 'DEPENSE_DIRECTE', 140_000);

    // 90 morts : valorisés au coût par tête (indicateur), le coût restant ne baisse pas.
    const mortality = await move({
      productId: chickenId,
      lotId,
      quantityBase: 90,
      from: buildingId,
      to: 'V_LOSS',
      moveType: 'LOSS',
    });
    expect(mortality.unitCostXaf).toBe(2333); // 5 600 000 ÷ 2 400
    expect(await tx((trx) => biologicalLotUnitCostXaf(trx, lotId))).toBe(2424); // 5 600 000 ÷ 2 310

    const firstSale = await move({
      productId: chickenId,
      lotId,
      quantityBase: 1000,
      from: buildingId,
      to: 'V_CUSTOMER',
      moveType: 'SALE',
    });
    expect(firstSale.unitCostXaf).toBe(2424);
    // La formule écrite aurait donné 5 600 000 ÷ 1 310 = 4 275 : le coût restant garde 2 424.
    expect(await tx((trx) => biologicalLotUnitCostXaf(trx, lotId))).toBe(2424);

    // Sortie vers un PDV par le transit : la réception restitue exactement la valeur expédiée.
    const dispatch = await move({
      productId: chickenId,
      lotId,
      quantityBase: 310,
      from: buildingId,
      to: 'V_TRANSIT',
      moveType: 'TRANSFER_DISPATCH',
    });
    const receipt = await move({
      productId: chickenId,
      lotId,
      quantityBase: 310,
      from: 'V_TRANSIT',
      to: storeId,
      moveType: 'TRANSFER_RECEIPT',
    });
    expect(receipt.valueXaf).toBe(dispatch.valueXaf);

    const secondSale = await move({
      productId: chickenId,
      lotId,
      quantityBase: 1000,
      from: buildingId,
      to: 'V_CUSTOMER',
      moveType: 'SALE',
    });
    const lastSale = await move({
      productId: chickenId,
      lotId,
      quantityBase: 310,
      from: storeId,
      to: 'V_CUSTOMER',
      moveType: 'SALE',
    });
    // Conservation : Σ coûts des ventes = coût du lot, au franc près.
    expect(firstSale.valueXaf + secondSale.valueXaf + lastSale.valueXaf).toBe(5_600_000);
    expect(await cmupOf(chickenId)).toBeNull(); // aucun CMUP pour un lot biologique
  });

  it('mortalité en attente puis rendue : la valeur revient, le coût restant est inchangé', async () => {
    const { lotId, originId } = await newLot('PRODUCTION_LOT', chickenId);
    await move({
      productId: chickenId,
      lotId,
      quantityBase: 100,
      from: 'V_PRODUCTION',
      to: buildingId,
      moveType: 'PRODUCTION_OUTPUT',
      declaredUnitCostXaf: 500,
    });
    await debit('PRODUCTION_LOT', originId, 'ANIMAUX', 50_000);
    const pending = await move({
      productId: chickenId,
      lotId,
      quantityBase: 4,
      from: buildingId,
      to: 'V_PENDING_LOSS',
      moveType: 'LOSS_PENDING',
    });
    expect(pending.valueXaf).toBe(2_000);
    expect(await tx((trx) => biologicalLotUnitCostXaf(trx, lotId))).toBe(521); // 50 000 ÷ 96
    const released = await move({
      productId: chickenId,
      lotId,
      quantityBase: 4,
      from: 'V_PENDING_LOSS',
      to: buildingId,
      moveType: 'LOSS_RELEASE',
    });
    expect(released.valueXaf).toBe(2_000);
    expect(await tx((trx) => biologicalLotUnitCostXaf(trx, lotId))).toBe(500);
  });

  it('productions commercialisables : CMUP recalculé (œufs au coût standard, découpes à valeur répartie)', async () => {
    const eggs = await newLot('COLLECTION', null);
    await move({
      productId: eggId,
      lotId: eggs.lotId,
      quantityBase: 300,
      from: 'V_PRODUCTION',
      to: storeId,
      moveType: 'PRODUCTION_OUTPUT',
      declaredUnitCostXaf: 60,
    });
    await move({
      productId: eggId,
      lotId: eggs.lotId,
      quantityBase: 100,
      from: 'V_PRODUCTION',
      to: storeId,
      moveType: 'PRODUCTION_OUTPUT',
      declaredUnitCostXaf: 70,
    });
    expect(await cmupOf(eggId)).toBeCloseTo(62.5, 3);

    const carcasses = await newLot('TRANSFORMATION', null);
    const output = await move({
      productId: carcassId,
      lotId: carcasses.lotId,
      quantityBase: 3,
      from: 'V_PRODUCTION',
      to: storeId,
      moveType: 'PRODUCTION_OUTPUT',
      declaredValueXaf: 10_000,
    });
    expect(output.valueXaf).toBe(10_000);
    expect(output.unitCostXaf).toBe(3333);
    expect(await cmupOf(carcassId)).toBeCloseTo(3333.333, 2);
  });

  it('incubation : rendement à 0 au mirage, poussins au coût du lot ÷ viables (BR-INC-009)', async () => {
    const batch = await newLot('INCUBATION_BATCH', null);
    await move({
      productId: hatchingEggId,
      lotId: batch.lotId,
      quantityBase: 600,
      from: 'V_PRODUCTION',
      to: storeId,
      moveType: 'PRODUCTION_OUTPUT',
      declaredUnitCostXaf: 100,
    });
    await debit('INCUBATION_BATCH', batch.originId, 'OEUFS', 60_000);
    await debit('INCUBATION_BATCH', batch.originId, 'DEPENSE_DIRECTE', 9_720);
    const candling = await move({
      productId: hatchingEggId,
      lotId: batch.lotId,
      quantityBase: 60,
      from: storeId,
      to: 'V_PRODUCTION',
      moveType: 'PRODUCTION_INPUT',
      declaredUnitCostXaf: 0,
    });
    expect(candling.valueXaf).toBe(0);
    await move({
      productId: hatchingEggId,
      lotId: batch.lotId,
      quantityBase: 540,
      from: storeId,
      to: 'V_PRODUCTION',
      moveType: 'PRODUCTION_INPUT',
      declaredUnitCostXaf: 0,
    });
    const chickUnit = Math.floor(69_720 / 498 + 0.5); // 140
    await move({
      productId: chickId,
      lotId: batch.lotId,
      quantityBase: 498,
      from: 'V_PRODUCTION',
      to: storeId,
      moveType: 'PRODUCTION_OUTPUT',
      declaredUnitCostXaf: chickUnit,
    });
    expect(await tx((trx) => biologicalLotUnitCostXaf(trx, batch.lotId))).toBe(140);
    const placement = await move({
      productId: chickId,
      lotId: batch.lotId,
      quantityBase: 498,
      from: storeId,
      to: 'V_PRODUCTION',
      moveType: 'PRODUCTION_INPUT',
    });
    expect(placement.valueXaf).toBe(69_720); // dernière sortie : tout le coût du lot d'incubation
  });

  it('lot clôturé : refusé en ligne, appliqué hors ligne (INV-PRD-02) ; les inverses restent possibles', async () => {
    const { lotId, originId } = await newLot('PRODUCTION_LOT', chickenId);
    const entry = await move({
      productId: chickenId,
      lotId,
      quantityBase: 10,
      from: 'V_PRODUCTION',
      to: buildingId,
      moveType: 'PRODUCTION_OUTPUT',
      declaredUnitCostXaf: 400,
    });
    await debit('PRODUCTION_LOT', originId, 'ANIMAUX', 4_000);
    await tx((trx) => setStockLotStatus(trx, lotId, 'CLOSED'));
    await expect(
      move({
        productId: chickenId,
        lotId,
        quantityBase: 1,
        from: buildingId,
        to: 'V_LOSS',
        moveType: 'LOSS',
      }),
    ).rejects.toThrow(InventoryMoveError);
    await expect(
      move({
        productId: chickenId,
        lotId,
        quantityBase: 1,
        from: buildingId,
        to: 'V_LOSS',
        moveType: 'LOSS',
      }),
    ).rejects.toMatchObject({ code: 'LOT_CLOSED' });
    const offline = await move({
      productId: chickenId,
      lotId,
      quantityBase: 1,
      from: buildingId,
      to: 'V_LOSS',
      moveType: 'LOSS',
      allowNegative: true,
    });
    expect(offline.unitCostXaf).toBe(400);
    const reversal = await move({
      productId: chickenId,
      lotId,
      quantityBase: 10,
      from: buildingId,
      to: 'V_PRODUCTION',
      moveType: 'PRODUCTION_INPUT',
      reversesMoveId: entry.moveId,
      allowNegative: true,
    });
    expect(reversal.unitCostXaf).toBe(400);
  });
});
