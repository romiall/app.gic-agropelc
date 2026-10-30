/**
 * AT-054 — P9-27 (AV-462 choix (b), AV-475 à AV-478) : fonctions de référence de KPI-PRD-04 (aliment consommé),
 * KPI-PRD-05 (poids moyen, dernière pesée) et KPI-PRD-09 (coût par tête). Chaque fonction est comparée à la
 * définition indépendante écrite sur les lignes sources (SQL direct, fiche d'un lot `getProductionLot`, lecture
 * jour par jour `productionLotDaily`) et, pour l'aliment, à la vue de l'explorateur `analytics_f_production_daily`.
 *
 * Monde validé (le pipeline de commandes écrit hors transaction annulée, documents complets) : deux fermes neuves
 * (A et B), des produits neufs, des lots de poulets et de porcs, un lot clos, un lot vidé, un lot planifié. Tous
 * les faits sont datés du 21/10/2026, antérieurs à l'horloge de l'essai (jamais d'horloge décalée vers le futur) ;
 * tous les contrôles portent sur les sites ou les lots de ce monde (assertions relatives).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerConsumptionCommands } from '../src/modules/inventory/application/commands/consumption-commands.js';
import { registerLotCommands } from '../src/modules/production/application/commands/lot-commands.js';
import { registerDailyCommands } from '../src/modules/production/application/commands/daily-commands.js';
import {
  costObjectConsumptionsByDay,
  ensureSupplierLot,
  feedConsumedByCostObjects,
  recordStockMove,
  virtualLocationId,
} from '../src/modules/inventory/application/public/index.js';
import {
  costPerHead,
  feedConsumption,
  getProductionLot,
  latestWeighing,
  productionLotDaily,
  referenceLotType,
} from '../src/modules/production/application/public/index.js';
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

/** Fenêtre de l'essai : 09h00 à 13h00 à Douala, bornes comprises dans la journée. */
const SUB_FROM = new Date(at('08:00:00'));
const SUB_TO = new Date(at('12:00:00'));
/** Journée métier entière du 21/10/2026 (Africa/Douala, UTC+1) : celle de la vue de l'explorateur. */
const DAY_FROM = new Date('2026-10-20T23:00:00.000Z');
const DAY_TO = new Date('2026-10-21T23:00:00.000Z');

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

interface LotRef {
  readonly id: string;
  readonly stockLotId: string;
  readonly lotType: string;
}

describe('AT-054 / P9-27 : indicateurs d’élevage d’un lot (KPI-PRD-04, 05 et 09)', () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let productionManager: Actor;
  let farmA: Actor;
  let farmB: Actor;
  let clerk: Actor;
  let siteA: string;
  let siteB: string;
  let buildingA: string;
  let buildingB: string;
  let storeA: string;
  let storeB: string;
  let chickId: string;
  let pigletId: string;
  let broilerId: string;
  let hogId: string;
  let feedId: string;
  let chickLotId: string;
  let pigletLotId: string;
  let l1: LotRef;
  let l2: LotRef;
  let l3: LotRef;
  let l5: LotRef;
  let lz: LotRef;
  let l4: LotRef;
  let lb: LotRef;
  let planned: LotRef;
  /** Les deux pesées de L2 au même instant : identifiants et poids. */
  let tie: { readonly a: { id: string; avg: number }; readonly b: { id: string; avg: number } };

  type Result = Awaited<ReturnType<CommandPipelineService['handle']>>;
  const describeResult = (result: Result) => JSON.stringify(result);

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

  async function applied(result: Promise<Result>): Promise<void> {
    const outcome = await result;
    expect(outcome.status, describeResult(outcome)).toBe('APPLIED');
  }

  interface Source {
    readonly productId: string;
    readonly locationId: string;
    readonly stockLotId: string;
  }

  /** Lot mis en place avec `quantity` têtes prises dans le stock de la ferme. */
  async function placeLot(input: {
    readonly lotType: string;
    readonly productId: string;
    readonly buildingId: string;
    readonly source: Source;
    readonly placer: Actor;
    readonly quantity: number;
    readonly time: string;
  }): Promise<{ readonly lot: LotRef; readonly entryId: string }> {
    const id = freshUuid();
    await applied(
      run(productionManager, 'production.lot.create', 'PRODUCTION_LOT', id, input.time, {
        lotType: input.lotType,
        productId: input.productId,
        mainLocationId: input.buildingId,
      }),
    );
    const entryId = freshUuid();
    await applied(
      run(input.placer, 'production.lot.record_entry', 'LOT_ENTRY', entryId, input.time, {
        productionLotId: id,
        sourceKind: 'INTERNAL_STOCK',
        sourceProductId: input.source.productId,
        sourceLocationId: input.source.locationId,
        sourceStockLotId: input.source.stockLotId,
        quantity: input.quantity,
      }),
    );
    const row = await db
      .selectFrom('production_production_lots')
      .select('stock_lot_id')
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
    return {
      lot: { id, stockLotId: fromBin(row.stock_lot_id), lotType: input.lotType },
      entryId,
    };
  }

  /** Consommation d'intrant imputée à un lot (`production.input.record`) ; rend son identifiant. */
  async function consume(
    lot: LotRef,
    time: string,
    quantity: number,
    options: {
      readonly costType?: 'ALIMENT' | 'VETERINAIRE' | 'AUTRE_INTRANT';
      readonly actor?: Actor;
      readonly locationId?: string;
    } = {},
  ): Promise<string> {
    const id = freshUuid();
    await applied(
      run(options.actor ?? farmA, 'production.input.record', 'CONSUMPTION', id, time, {
        productionLotId: lot.id,
        locationId: options.locationId ?? storeA,
        productId: feedId,
        quantityBase: quantity,
        unitCode: 'KG',
        quantity,
        costType: options.costType ?? 'ALIMENT',
      }),
    );
    return id;
  }

  async function weigh(lot: LotRef, time: string, avgWeightG: number, actor = farmA) {
    const id = freshUuid();
    await applied(
      run(actor, 'production.weighing.record', 'LOT_WEIGHING', id, time, {
        productionLotId: lot.id,
        sampleSize: 10,
        avgWeightG,
      }),
    );
    return id;
  }

  beforeAll(async () => {
    const clock = new FixedClock(new Date(NOW));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    const sequences = new DocumentSequenceService();
    registerLotCommands(registry, idGenerator, sequences);
    registerDailyCommands(registry, idGenerator, sequences);
    registerConsumptionCommands(registry, idGenerator);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    const roleId = async (code: string): Promise<string> => {
      const row = await db
        .selectFrom('identity_roles')
        .select('id')
        .where('code', '=', code)
        .executeTakeFirstOrThrow();
      return fromBin(row.id);
    };
    const roles = { rfe: await roleId('RESP_FERME'), rpr: await roleId('RESP_PRODUCTION') };

    await db.transaction().execute(async (trx) => {
      const adminId = await insertTestUser(trx);
      const zoneId = await insertTestZone(trx, adminId);
      siteA = await insertTestSite(trx, adminId, zoneId, { siteType: 'FERME' });
      siteB = await insertTestSite(trx, adminId, zoneId, { siteType: 'FERME' });
      buildingA = await insertTestLocation(trx, adminId, siteA, { locationType: 'BUILDING' });
      buildingB = await insertTestLocation(trx, adminId, siteB, { locationType: 'BUILDING' });
      storeA = await insertTestLocation(trx, adminId, siteA);
      storeB = await insertTestLocation(trx, adminId, siteB);

      const actor = async (role: string, options: Parameters<typeof assignTestRole>[4] = {}) => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, adminId, options);
        return { userId, deviceId };
      };
      productionManager = await actor(roles.rpr);
      farmA = await actor(roles.rfe, { scopeType: 'SITE', scopeSiteId: siteA });
      farmB = await actor(roles.rfe, { scopeType: 'SITE', scopeSiteId: siteB });
      const clerkRole = await insertTestRole(trx, adminId);
      await grantTestPermission(trx, clerkRole, 'inventory.consumption.record', adminId);
      clerk = await actor(clerkRole);

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
      pigletId = freshUuid();
      broilerId = freshUuid();
      hogId = freshUuid();
      feedId = freshUuid();
      const base = { category_id: toBin(categoryId), created_by: toBin(adminId) };
      const animal = (id: string, name: string, species: 'POULET_CHAIR' | 'PORC') => ({
        ...base,
        id: toBin(id),
        code: `PRD-${id.slice(-8)}`,
        name,
        stock_family: 'BIOLOGIQUE',
        species,
        base_unit_code: 'TETE',
        lot_tracking: 'REQUIRED',
      });
      await trx
        .insertInto('catalog_products')
        .values([
          animal(chickId, 'Poussin d’un jour (chair)', 'POULET_CHAIR'),
          animal(broilerId, 'Poulet de chair vif', 'POULET_CHAIR'),
          animal(pigletId, 'Porcelet sevré', 'PORC'),
          animal(hogId, 'Porc charcutier vif', 'PORC'),
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
      const supplierLot = (productId: string, ref: string) =>
        ensureSupplierLot(
          trx,
          { idGenerator },
          {
            productId,
            supplierId,
            supplierLotRef: `${ref}-${supplierId.slice(-6)}`,
            fallbackCode: `F:${ref}-${supplierId.slice(-6)}`,
            expiryDate: null,
            originId: freshUuid(),
            fifoRankAt: new Date(at('05:00:00')),
            createdBy: adminId,
          },
        );
      chickLotId = await supplierLot(chickId, 'PC');
      pigletLotId = await supplierLot(pigletId, 'PP');
      const opening = await virtualLocationId(trx, 'V_OPENING');
      for (const [productId, lot, quantity, cost, location] of [
        [chickId, chickLotId, 1000, 500, storeA],
        [pigletId, pigletLotId, 100, 2000, storeA],
        [feedId, undefined, 1000, 300, storeA],
        [chickId, chickLotId, 100, 500, storeB],
        [feedId, undefined, 1000, 300, storeB],
      ] as const) {
        await recordStockMove(
          trx,
          { idGenerator },
          {
            productId,
            ...(lot !== undefined ? { lotId: lot } : {}),
            quantityBase: quantity,
            fromLocationId: opening,
            toLocationId: location,
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

    const chicksOfA: Source = { productId: chickId, locationId: storeA, stockLotId: chickLotId };
    const chicksOfB: Source = { productId: chickId, locationId: storeB, stockLotId: chickLotId };
    const pigletsOfA: Source = { productId: pigletId, locationId: storeA, stockLotId: pigletLotId };
    const poultry = { lotType: 'POULET_CHAIR', productId: broilerId, time: at('06:00:00') };

    // Lots en élevage de la ferme A : L1 (100 têtes), L2 (40), L3 porcs (10), L5 sans pesée (20).
    l1 = (
      await placeLot({
        ...poultry,
        buildingId: buildingA,
        source: chicksOfA,
        placer: farmA,
        quantity: 100,
      })
    ).lot;
    l2 = (
      await placeLot({
        ...poultry,
        buildingId: buildingA,
        source: chicksOfA,
        placer: farmA,
        quantity: 40,
      })
    ).lot;
    l3 = (
      await placeLot({
        lotType: 'PORC_ENGRAISSEMENT',
        productId: hogId,
        time: at('06:00:00'),
        buildingId: buildingA,
        source: pigletsOfA,
        placer: farmA,
        quantity: 10,
      })
    ).lot;
    l5 = (
      await placeLot({
        ...poultry,
        buildingId: buildingA,
        source: chicksOfA,
        placer: farmA,
        quantity: 20,
      })
    ).lot;
    // Lot de la ferme B (hors périmètre du site A).
    lb = (
      await placeLot({
        ...poultry,
        buildingId: buildingB,
        source: chicksOfB,
        placer: farmB,
        quantity: 50,
      })
    ).lot;
    // Lot en élevage dont la mise en place est annulée : actif, effectif nul, coût nul.
    const emptied = await placeLot({
      ...poultry,
      buildingId: buildingA,
      source: chicksOfA,
      placer: farmA,
      quantity: 5,
    });
    lz = emptied.lot;
    await applied(
      run(
        productionManager,
        'production.lot.cancel_entry',
        'LOT_ENTRY',
        emptied.entryId,
        at('06:30:00'),
        { comment: 'Erreur de saisie' },
      ),
    );
    // Lot clos : vidé puis clôturé, avec un aliment saisi hors ligne après la clôture (conflit LOT_CLOSED).
    const closed = await placeLot({
      ...poultry,
      time: at('11:00:00'),
      buildingId: buildingA,
      source: chicksOfA,
      placer: farmA,
      quantity: 5,
    });
    l4 = closed.lot;
    await applied(
      run(
        productionManager,
        'production.lot.cancel_entry',
        'LOT_ENTRY',
        closed.entryId,
        at('11:10:00'),
        { comment: 'Erreur de saisie' },
      ),
    );
    await applied(
      run(productionManager, 'production.lot.close', 'PRODUCTION_LOT', l4.id, at('11:20:00'), {}),
    );
    // Lot planifié : créé, jamais mis en place.
    const plannedId = freshUuid();
    await applied(
      run(productionManager, 'production.lot.create', 'PRODUCTION_LOT', plannedId, at('06:00:00'), {
        lotType: 'POULET_CHAIR',
        productId: broilerId,
        mainLocationId: buildingA,
      }),
    );
    const plannedRow = await db
      .selectFrom('production_production_lots')
      .select('stock_lot_id')
      .where('id', '=', toBin(plannedId))
      .executeTakeFirstOrThrow();
    planned = {
      id: plannedId,
      stockLotId: fromBin(plannedRow.stock_lot_id),
      lotType: 'POULET_CHAIR',
    };

    // Aliment de L1 : avant la fenêtre, pile à son début (inclus), dedans, juste avant sa fin, pile à sa fin
    // (exclu), après ; plus une consommation vétérinaire, un autre intrant et une consommation annulée.
    await consume(l1, at('07:00:00'), 20);
    await consume(l1, at('08:00:00'), 30);
    await consume(l1, at('10:00:00'), 10);
    await consume(l1, `${DAY}T11:59:59.999Z`, 5);
    await consume(l1, at('12:00:00'), 7);
    await consume(l1, at('13:00:00'), 3);
    await consume(l1, at('09:00:00'), 2, { costType: 'VETERINAIRE' });
    await consume(l1, at('09:10:00'), 1, { costType: 'AUTRE_INTRANT' });
    const cancelledId = await consume(l1, at('09:30:00'), 4);
    await applied(
      run(clerk, 'inventory.consumption.cancel', 'CONSUMPTION', cancelledId, at('09:40:00'), {
        consumptionId: cancelledId,
      }),
    );
    await consume(l2, at('09:00:00'), 12);
    await consume(l3, at('08:30:00'), 6);
    await consume(lb, at('10:00:00'), 40, { actor: farmB, locationId: storeB });
    // Aliment imputé au site (et non à un lot) : ne compte pas.
    const siteFeedId = freshUuid();
    await applied(
      run(clerk, 'inventory.consumption.record', 'CONSUMPTION', siteFeedId, at('10:30:00'), {
        locationId: storeA,
        productId: feedId,
        quantityBase: 9,
        unitCode: 'KG',
        quantity: 9,
        costObjectType: 'SITE',
        costObjectId: siteA,
        costType: 'ALIMENT',
      }),
    );
    const late = await run(
      farmA,
      'production.input.record',
      'CONSUMPTION',
      freshUuid(),
      at('11:07:00'),
      {
        productionLotId: l4.id,
        locationId: storeA,
        productId: feedId,
        quantityBase: 2,
        unitCode: 'KG',
        quantity: 2,
        costType: 'ALIMENT',
      },
      { offline: true },
    );
    expect(late, describeResult(late)).toMatchObject({
      status: 'APPLIED_WITH_WARNINGS',
      warnings: ['LOT_CLOSED'],
    });

    // Pesées : L1 (400 g, 600 g, puis 800 g annulée), L2 (900 g puis deux pesées au même instant), L3, LZ, LB.
    await weigh(l1, at('08:00:00'), 400);
    await weigh(l1, at('10:00:00'), 600);
    const cancelledWeighing = await weigh(l1, at('11:00:00'), 800);
    await applied(
      run(farmA, 'production.weighing.cancel', 'LOT_WEIGHING', cancelledWeighing, at('11:05:00'), {
        comment: 'Balance mal tarée',
      }),
    );
    await weigh(l2, at('09:00:00'), 900);
    const tieA = { id: await weigh(l2, at('10:00:00'), 1000), avg: 1000 };
    const tieB = { id: await weigh(l2, at('10:00:00'), 1100), avg: 1100 };
    tie = { a: tieA, b: tieB };
    await weigh(l3, at('11:00:00'), 30_000);
    await weigh(lz, at('09:30:00'), 5000);
    await weigh(lb, at('10:00:00'), 5000, farmB);
  }, 180_000);

  afterAll(async () => {
    await closeTestDb();
  });

  const scopeA = () => ({ siteIds: [siteA] });

  /** Définition indépendante : Σ des consommations d'aliment enregistrées des lots d'un site sur `[from, to[`. */
  async function feedOfSiteBySql(site: string, from: Date, to: Date): Promise<number> {
    const { rows } = await sql<{ qty: string }>`
      SELECT COALESCE(SUM(c.quantity_base), 0) AS qty
        FROM inventory_consumptions c
        JOIN production_production_lots pl ON pl.id = c.cost_object_id
       WHERE c.cost_object_type = 'PRODUCTION_LOT' AND c.cost_type = 'ALIMENT' AND c.status = 'RECORDED'
         AND pl.site_id = ${toBin(site)}
         AND c.occurred_at >= ${from} AND c.occurred_at < ${to}
    `.execute(db);
    return Number(rows[0]?.qty);
  }

  describe('KPI-PRD-04 : feedConsumption', () => {
    it('égale les documents : SQL direct, consommations par jour, fiche jour par jour', async () => {
      const result = await feedConsumption(db, scopeA(), { fromUtc: SUB_FROM, toUtc: SUB_TO });
      // L1 : 30 (début inclus) + 10 + 5 (11:59:59,999) ; L2 : 12 ; L3 : 6 ; L4 (clos) : 2.
      expect(result.quantity).toBe(65);
      expect(result.quantity).toBe(await feedOfSiteBySql(siteA, SUB_FROM, SUB_TO));
      const byLot = new Map(result.lots.map((lot) => [lot.lotId, lot.quantity]));
      expect(byLot.get(l1.id)).toBe(45);
      expect(byLot.get(l2.id)).toBe(12);
      expect(byLot.get(l3.id)).toBe(6);
      expect(byLot.get(l4.id)).toBe(2);
      expect(
        byLot.has(l5.id) || byLot.has(lz.id) || byLot.has(planned.id) || byLot.has(lb.id),
      ).toBe(false);
      const ids = result.lots.map((lot) => lot.lotId);
      expect(ids).toEqual([...ids].sort());

      // Consommations par jour d'un objet de coût : même somme (filtre sur la nature ALIMENT).
      let perDay = 0;
      for (const lot of [l1, l2, l3, l4, l5, lz, planned]) {
        const lines = await costObjectConsumptionsByDay(db, {
          costObjectType: 'PRODUCTION_LOT',
          costObjectId: lot.id,
          fromUtc: SUB_FROM,
          toUtc: SUB_TO,
        });
        perDay += lines
          .filter((line) => line.costType === 'ALIMENT')
          .reduce((sum, line) => sum + line.quantityBase, 0);
      }
      expect(perDay).toBe(result.quantity);

      // Journée entière : 75 (L1) + 12 + 6 + 2 = 95 ; la fiche jour par jour des lots donne la même somme.
      const wholeDay = await feedConsumption(db, scopeA(), { fromUtc: DAY_FROM, toUtc: DAY_TO });
      expect(wholeDay.quantity).toBe(95);
      expect(wholeDay.quantity).toBe(await feedOfSiteBySql(siteA, DAY_FROM, DAY_TO));
      let daily = 0;
      for (const lot of [l1, l2, l3, l4, l5, lz, planned]) {
        const days = await productionLotDaily(db, lot, DAY, DAY);
        for (const entry of days) {
          daily += entry.consumptions
            .filter((line) => line.costType === 'ALIMENT')
            .reduce((sum, line) => sum + line.quantityBase, 0);
        }
      }
      expect(daily).toBe(wholeDay.quantity);
    });

    it('égale la vue de l’explorateur (lien f_production_daily / feed_consumed)', async () => {
      const wholeDay = await feedConsumption(db, scopeA(), { fromUtc: DAY_FROM, toUtc: DAY_TO });
      const { rows } = await sql<{ qty: string }>`
        SELECT COALESCE(SUM(feed_quantity), 0) AS qty
          FROM analytics_f_production_daily
         WHERE feed_quantity IS NOT NULL AND site_id = ${toBin(siteA)} AND business_day = ${DAY}
      `.execute(db);
      expect(Number(rows[0]?.qty)).toBe(wholeDay.quantity);
    });

    it('exclut l’annulé, le vétérinaire, l’autre intrant, l’imputation au site et l’autre ferme', async () => {
      const wholeDay = await feedConsumption(db, scopeA(), { fromUtc: DAY_FROM, toUtc: DAY_TO });
      // Annulée (4), vétérinaire (2), autre intrant (1), imputée au site (9) : aucune dans les 95.
      expect(wholeDay.quantity).toBe(95);
      const other = await feedConsumption(
        db,
        { siteIds: [siteB] },
        { fromUtc: DAY_FROM, toUtc: DAY_TO },
      );
      expect(other.quantity).toBe(40);
      expect(other.lots).toEqual([{ lotId: lb.id, quantity: 40 }]);
      // Étendue par personne : l'auteur des lots (le responsable de production) voit les deux fermes.
      const mine = await feedConsumption(
        db,
        { userIds: [productionManager.userId] },
        { fromUtc: DAY_FROM, toUtc: DAY_TO },
      );
      expect(mine.quantity).toBeGreaterThanOrEqual(95 + 40);
      const both = await feedConsumption(
        db,
        { siteIds: [siteA], userIds: [farmA.userId] },
        { fromUtc: DAY_FROM, toUtc: DAY_TO },
      );
      expect(both).toEqual({ quantity: 0, lots: [] });
    });

    it('bornes de la fenêtre : début inclus, fin exclue', async () => {
      const lots = [l1.id];
      const feed = (from: string, to: string) =>
        feedConsumedByCostObjects(db, {
          costObjectType: 'PRODUCTION_LOT',
          costObjectIds: lots,
          fromUtc: new Date(from),
          toUtc: new Date(to),
        });
      // Début pile sur la consommation de 08h00 : comptée ; une milliseconde après : non.
      expect((await feed(at('08:00:00'), at('09:00:00'))).get(l1.id)).toBe(30);
      expect((await feed(`${DAY}T08:00:00.001Z`, at('09:00:00'))).get(l1.id)).toBeUndefined();
      // Fin pile sur la consommation de 12h00 : exclue ; une milliseconde après : comptée.
      expect((await feed(at('11:00:00'), at('12:00:00'))).get(l1.id)).toBe(5);
      expect((await feed(at('11:00:00'), `${DAY}T12:00:00.001Z`)).get(l1.id)).toBe(12);
    });

    it('périmètre vide : zéro, sans requête « IN () »', async () => {
      const window = { fromUtc: DAY_FROM, toUtc: DAY_TO };
      expect(await feedConsumption(db, { siteIds: [] }, window)).toEqual({ quantity: 0, lots: [] });
      expect(await feedConsumption(db, { userIds: [] }, window)).toEqual({ quantity: 0, lots: [] });
    });

    it('feedConsumedByCostObjects : liste vide, inconnus, plus de 500 identifiants', async () => {
      const base = {
        costObjectType: 'PRODUCTION_LOT' as const,
        fromUtc: DAY_FROM,
        toUtc: DAY_TO,
      };
      expect((await feedConsumedByCostObjects(db, { ...base, costObjectIds: [] })).size).toBe(0);
      const unknown = await feedConsumedByCostObjects(db, {
        ...base,
        costObjectIds: [freshUuid(), freshUuid()],
      });
      expect(unknown.size).toBe(0);

      const real = [l1.id, l2.id, l3.id, l4.id];
      const small = await feedConsumedByCostObjects(db, { ...base, costObjectIds: real });
      const many: string[] = Array.from({ length: 1200 }, () => freshUuid());
      many[0] = real[0]!;
      many[499] = real[1]!;
      many[500] = real[2]!;
      many[1199] = real[3]!;
      const big = await feedConsumedByCostObjects(db, { ...base, costObjectIds: many });
      expect(new Map(big)).toEqual(new Map(small));
      expect(big.size).toBe(4);
    });
  });

  describe('KPI-PRD-05 : latestWeighing', () => {
    it('par lot : dernière pesée enregistrée = documents ; annulée et postérieure ignorées', async () => {
      const result = await latestWeighing(db, scopeA(), { at: new Date(NOW) });
      const lots = new Map(result.lots.map((lot) => [lot.lotId, lot]));
      // Lots en élevage seulement : ni le lot clos, ni le lot planifié, ni la ferme B.
      expect([...lots.keys()].sort()).toEqual([l1.id, l2.id, l3.id, l5.id, lz.id].sort());
      expect(result.lots.map((lot) => lot.lotCode)).toEqual(
        [...result.lots.map((lot) => lot.lotCode)].sort(),
      );

      // L1 : la pesée annulée de 800 g (la plus récente) est ignorée → 600 g, comme la fiche du lot.
      const detail = await getProductionLot(db, l1.id);
      const recorded = detail!.weighings.filter((w) => w.status === 'RECORDED');
      const last = recorded[recorded.length - 1]!;
      expect(lots.get(l1.id)!.avgWeightG).toBe(last.avgWeightG);
      expect(lots.get(l1.id)!.avgWeightG).toBe(600);
      expect(new Date(lots.get(l1.id)!.weighedAt!).getTime()).toBe(
        new Date(last.occurredAt).getTime(),
      );
      expect(lots.get(l1.id)!.sampleSize).toBe(10);
      // Un lot sans aucune pesée : null, et il reste dans la liste.
      expect(lots.get(l5.id)).toMatchObject({
        avgWeightG: null,
        sampleSize: null,
        weighedAt: null,
      });
      expect(lots.get(l5.id)!.rearingHeads).toBe(20);
    });

    it('égalité d’instant : l’identifiant le plus grand l’emporte, comme ORDER BY … id DESC', async () => {
      const { rows } = await sql<{ avg: unknown; id: Buffer }>`
        SELECT w.avg_weight_g AS avg, w.id
          FROM production_lot_weighings w
         WHERE w.production_lot_id = ${toBin(l2.id)} AND w.status = 'RECORDED' AND w.occurred_at <= ${new Date(NOW)}
         ORDER BY w.occurred_at DESC, w.id DESC
         LIMIT 1
      `.execute(db);
      const expected = tie.a.id > tie.b.id ? tie.a : tie.b;
      expect(fromBin(rows[0]!.id)).toBe(expected.id);
      const result = await latestWeighing(db, scopeA(), { at: new Date(NOW) });
      const l2Line = result.lots.find((lot) => lot.lotId === l2.id)!;
      expect(l2Line.avgWeightG).toBe(Number(rows[0]!.avg));
      expect(l2Line.avgWeightG).toBe(expected.avg);
    });

    it('à un instant antérieur : les pesées postérieures sont ignorées (borne comprise)', async () => {
      const early = await latestWeighing(db, scopeA(), { at: new Date(at('09:00:00')) });
      const lots = new Map(early.lots.map((lot) => [lot.lotId, lot]));
      expect(lots.get(l1.id)!.avgWeightG).toBe(400);
      // 900 g pesés pile à 09h00 : comptés ; les pesées de 10h00 sont postérieures.
      expect(lots.get(l2.id)!.avgWeightG).toBe(900);
      expect(lots.get(l3.id)!.avgWeightG).toBeNull();
      expect(lots.get(lz.id)!.avgWeightG).toBeNull();
      const chicken = early.byLotType.find((type) => type.lotType === 'POULET_CHAIR')!;
      // (400 × 100 + 900 × 40) ÷ 140 = 542,857… → 542,9.
      expect(chicken.avgWeightG).toBe(542.9);
      expect(chicken.weighedLots).toBe(2);
      const pigs = early.byLotType.find((type) => type.lotType === 'PORC_ENGRAISSEMENT')!;
      expect(pigs).toMatchObject({ weighedLots: 0, weighedHeads: 0, avgWeightG: null });
    });

    it('par type : moyenne pondérée par l’effectif en élevage, lots pesés à effectif nul exclus', async () => {
      const result = await latestWeighing(db, scopeA(), { at: new Date(NOW) });
      const chicken = result.byLotType.find((type) => type.lotType === 'POULET_CHAIR')!;
      const tieAvg = (tie.a.id > tie.b.id ? tie.a : tie.b).avg;
      expect(chicken.lots).toBe(4);
      // Pesés : L1, L2 et LZ (vidé, effectif nul) ; sans pesée : L5.
      expect(chicken.weighedLots).toBe(3);
      expect(chicken.rearingHeads).toBe(160);
      expect(chicken.weighedHeads).toBe(140);
      expect(chicken.avgWeightG).toBe(Math.round(((600 * 100 + tieAvg * 40) / 140) * 10) / 10);
      const pigs = result.byLotType.find((type) => type.lotType === 'PORC_ENGRAISSEMENT')!;
      expect(pigs).toMatchObject({ lots: 1, weighedLots: 1, rearingHeads: 10, avgWeightG: 30_000 });
      // Plus de têtes d'abord : poulets (160) avant porcs (10).
      expect(result.byLotType.map((type) => type.lotType)).toEqual([
        'POULET_CHAIR',
        'PORC_ENGRAISSEMENT',
      ]);
    });

    it('referenceLotType : le type le plus nombreux, égalité au code croissant, null sans tête', () => {
      expect(referenceLotType([])).toBeNull();
      expect(referenceLotType([{ lotType: 'POULET_CHAIR', rearingHeads: 0 }])).toBeNull();
      const types = [
        { lotType: 'PORC_ENGRAISSEMENT', rearingHeads: 10 },
        { lotType: 'POULET_CHAIR', rearingHeads: 160 },
      ];
      expect(referenceLotType(types)).toBe('POULET_CHAIR');
      expect(types.map((type) => type.lotType)).toEqual(['PORC_ENGRAISSEMENT', 'POULET_CHAIR']);
      expect(
        referenceLotType([
          { lotType: 'PONDEUSE', rearingHeads: 5 },
          { lotType: 'PORC_NAISSAGE', rearingHeads: 5 },
          { lotType: 'POULET_CHAIR', rearingHeads: 4 },
        ]),
      ).toBe('PONDEUSE');
    });

    it('n’est pas la mesure « average_weight » de l’explorateur (moyenne des pesées, AV-329)', async () => {
      const { rows } = await sql<{ avg: unknown }>`
        SELECT AVG(average_weight_kg) AS avg
          FROM analytics_f_production_daily
         WHERE lot_id = ${toBin(l1.id)} AND average_weight_kg IS NOT NULL
      `.execute(db);
      const explorerKg = Number(rows[0]?.avg);
      // Pesées enregistrées de L1 : 400 g et 600 g → moyenne 0,5 kg ; la dernière pesée vaut 0,6 kg.
      expect(explorerKg).toBeCloseTo(0.5, 6);
      const result = await latestWeighing(db, scopeA(), { at: new Date(NOW) });
      const l1Line = result.lots.find((lot) => lot.lotId === l1.id)!;
      expect(l1Line.avgWeightG! / 1000).not.toBeCloseTo(explorerKg, 6);
    });

    it('périmètre vide : listes vides ; ferme B hors du site A', async () => {
      const at20 = { at: new Date(NOW) };
      expect(await latestWeighing(db, { siteIds: [] }, at20)).toEqual({ lots: [], byLotType: [] });
      expect(await latestWeighing(db, { userIds: [] }, at20)).toEqual({ lots: [], byLotType: [] });
      const farmBOnly = await latestWeighing(db, { siteIds: [siteB] }, at20);
      expect(farmBOnly.lots.map((lot) => lot.lotId)).toEqual([lb.id]);
      expect(farmBOnly.lots[0]!.avgWeightG).toBe(5000);
    });
  });

  describe('KPI-PRD-09 : costPerHead', () => {
    it('par lot : coût restant, effectif non vendu et coût par tête égaux à la fiche du lot', async () => {
      const result = await costPerHead(db, scopeA());
      const lots = new Map(result.lots.map((lot) => [lot.lotId, lot]));
      expect([...lots.keys()].sort()).toEqual([l1.id, l2.id, l3.id, l5.id, lz.id].sort());
      for (const ref of [l1, l2, l3, l5, lz]) {
        const detail = await getProductionLot(db, ref.id);
        const line = lots.get(ref.id)!;
        expect(line.unsoldHeads).toBe(detail!.headcount.unsold);
        expect(line.remainingCostXaf).toBe(detail!.costs.remainingXaf);
        expect(line.costPerHeadXaf).toBe(detail!.costs.costPerHeadXaf);
      }
      // Lot vidé : effectif nul, donc pas de coût par tête.
      expect(lots.get(lz.id)).toMatchObject({ unsoldHeads: 0, costPerHeadXaf: null });
      expect(lots.get(l1.id)!.costPerHeadXaf).not.toBeNull();
    });

    it('par type : Σ coûts ÷ Σ effectifs (franc demi supérieur), pas la moyenne des coûts par tête', async () => {
      const result = await costPerHead(db, scopeA());
      const chickens = result.lots.filter((lot) => lot.lotType === 'POULET_CHAIR');
      const withHeads = chickens.filter((lot) => lot.unsoldHeads > 0);
      const totalCost = withHeads.reduce((sum, lot) => sum + Math.max(0, lot.remainingCostXaf), 0);
      const totalHeads = withHeads.reduce((sum, lot) => sum + lot.unsoldHeads, 0);
      const type = result.byLotType.find((entry) => entry.lotType === 'POULET_CHAIR')!;
      expect(type.lots).toBe(chickens.length);
      expect(type.unsoldHeads).toBe(totalHeads);
      expect(type.remainingCostXaf).toBe(totalCost);
      expect(type.costPerHeadXaf).toBe(Math.round(totalCost / totalHeads));
      // Les effectifs diffèrent (100, 40, 20) : la moyenne simple des coûts par tête serait une autre valeur.
      const simpleMean = Math.round(
        withHeads.reduce((sum, lot) => sum + lot.costPerHeadXaf!, 0) / withHeads.length,
      );
      expect(withHeads.length).toBe(3);
      expect(type.costPerHeadXaf).not.toBe(simpleMean);
      expect(type.rearingHeads).toBe(160);

      const pigs = result.byLotType.find((entry) => entry.lotType === 'PORC_ENGRAISSEMENT')!;
      const pigLot = result.lots.find((lot) => lot.lotId === l3.id)!;
      expect(pigs).toMatchObject({ lots: 1, unsoldHeads: 10, rearingHeads: 10 });
      expect(pigs.costPerHeadXaf).toBe(pigLot.costPerHeadXaf);
      expect(result.byLotType.map((entry) => entry.lotType)).toEqual([
        'POULET_CHAIR',
        'PORC_ENGRAISSEMENT',
      ]);
    });

    it('lots hors élevage absents ; périmètre vide : listes vides', async () => {
      const result = await costPerHead(db, scopeA());
      const ids = result.lots.map((lot) => lot.lotId);
      expect(ids).not.toContain(l4.id);
      expect(ids).not.toContain(planned.id);
      expect(ids).not.toContain(lb.id);
      expect(await costPerHead(db, { siteIds: [] })).toEqual({ lots: [], byLotType: [] });
      expect(await costPerHead(db, { userIds: [] })).toEqual({ lots: [], byLotType: [] });
    });
  });
});
