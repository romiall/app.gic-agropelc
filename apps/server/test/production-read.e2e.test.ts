/**
 * Lectures HTTP de la production (P7-11, `production-api/`) de bout en bout : NestJS + Fastify,
 * `app.inject()` (même gabarit que procurement-read.e2e.test.ts), documents écrits par le vrai
 * pipeline avec les rôles réels du seed.
 *
 * Démontre : portée SITE (responsables de deux fermes) et ALL (Responsable production, Finance),
 * refus (403 sans droit, 404 hors portée, audité) ; masquage des coûts et valeurs sans
 * `inventory.valuation.read` (RC-05), quantités et indicateurs visibles ; fiche d'un lot (effectif,
 * mortalité, coûts, GMQ, résultat mensuel), vue jour par jour (fenêtre par défaut, bornes) ;
 * collectes d'œufs, lots d'incubation, abattages et répartitions de frais généraux.
 *
 * Les paramètres des calibres, de l'œuf à couver et des durées d'incubation gardent des valeurs
 * stables d'une exécution à l'autre (pas de fin de validité sur les paramètres système).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { businessDayOf, type Clock } from '@gic/domain';
import { AppModule } from '../src/app.module.js';
import { CLOCK } from '../src/platform/clock.provider.js';
import { ID_GENERATOR } from '../src/platform/id-generator.provider.js';
import { registerCorrelationId } from '../src/platform/http/register-correlation-id.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { JWT_KEYS } from '../src/modules/identity/jwt-keys.provider.js';
import { signAccessToken } from '../src/modules/identity/application/public/jwt.js';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import {
  ensureSupplierLot,
  recordStockMove,
  virtualLocationId,
} from '../src/modules/inventory/application/public/index.js';
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

const DAY = '2026-09-12';
const DAY2 = '2026-09-19';
const at = (hhmmss: string, day = DAY) => `${day}T${hhmmss}.000Z`;
let deviceSeq = 0;

/** Codes stables : le paramètre des calibres et celui de l'œuf à couver gardent leur valeur. */
const GRADE_CODE = 'TEST-OEUF-E2E-GROS';
const HATCHING_CODE = 'TEST-OEUF-E2E-COUVER';

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
  token: string;
}

describe('Lectures HTTP de la production (P7-11)', () => {
  let app: NestFastifyApplication;
  let clock: Clock;
  let pipeline: CommandPipelineService;
  let rfeA: Actor;
  let rfeB: Actor;
  let rpr: Actor;
  let fin: Actor;
  let ven: Actor;
  let farmA: string;
  let farmB: string;
  let buildingA: string;
  let buildingB: string;
  let storeA: string;
  let storeB: string;
  let incubatorA: string;
  let houseA: string;
  let coldStoreA: string;
  let chickId: string;
  let broilerId: string;
  let pulletId: string;
  let layerId: string;
  let feedId: string;
  let gradeId: string;
  let hatchingEggId: string;
  let wholeId: string;
  let chickLotA: string;
  let chickLotB: string;
  let pulletLot: string;
  let eggLot: string;
  let lotA: string;
  let lotB: string;
  let layerLot: string;
  let collectionId: string;
  let incubationId: string;
  let slaughterId: string;

  async function get(actor: Actor, url: string) {
    return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${actor.token}` } });
  }

  async function command(
    actor: Actor,
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
  ) {
    const result = await pipeline.handle(
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
    expect(result.status, JSON.stringify(result)).toMatch(/^APPLIED/);
  }

  async function placedLot(
    lotType: string,
    productId: string,
    mainLocationId: string,
    entry: {
      readonly actor: Actor;
      readonly productId: string;
      readonly locationId: string;
      readonly stockLotId: string;
      readonly quantity: number;
    },
  ): Promise<string> {
    const id = freshUuid();
    await command(rpr, 'production.lot.create', 'PRODUCTION_LOT', id, at('06:00:00'), {
      lotType,
      productId,
      mainLocationId,
    });
    await command(
      entry.actor,
      'production.lot.record_entry',
      'LOT_ENTRY',
      freshUuid(),
      at('06:30:00'),
      {
        productionLotId: id,
        sourceKind: 'INTERNAL_STOCK',
        sourceProductId: entry.productId,
        sourceLocationId: entry.locationId,
        sourceStockLotId: entry.stockLotId,
        quantity: entry.quantity,
      },
    );
    return id;
  }

  async function roleId(code: string): Promise<string> {
    const row = await db
      .selectFrom('identity_roles')
      .select('id')
      .where('code', '=', code)
      .executeTakeFirstOrThrow();
    return fromBin(row.id);
  }

  const idsOf = (items: readonly { id: string }[]) => items.map((item) => item.id);

  beforeAll(async () => {
    process.env.SERVER_DATABASE_URL ??=
      'mysql://gic_app:gic_app_password@127.0.0.1:3306/gic_agropelc_test';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerCorrelationId(app, app.get(ID_GENERATOR));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    clock = app.get(CLOCK);
    pipeline = app.get(CommandPipelineService);
    const idGenerator = app.get(ID_GENERATOR);
    const jwtKeys = app.get(JWT_KEYS);

    const roles = {
      rfe: await roleId('RESP_FERME'),
      rpr: await roleId('RESP_PRODUCTION'),
      fin: await roleId('FINANCE'),
      ven: await roleId('VENDEUR_PDV'),
    };
    await db.transaction().execute(async (trx) => {
      const adminId = await insertTestUser(trx);
      const zoneId = await insertTestZone(trx, adminId);
      farmA = await insertTestSite(trx, adminId, zoneId, { siteType: 'FERME' });
      farmB = await insertTestSite(trx, adminId, zoneId, { siteType: 'FERME' });
      buildingA = await insertTestLocation(trx, adminId, farmA, { locationType: 'BUILDING' });
      buildingB = await insertTestLocation(trx, adminId, farmB, { locationType: 'BUILDING' });
      storeA = await insertTestLocation(trx, adminId, farmA);
      storeB = await insertTestLocation(trx, adminId, farmB);
      incubatorA = await insertTestLocation(trx, adminId, farmA, { locationType: 'INCUBATOR' });
      houseA = await insertTestLocation(trx, adminId, farmA, { locationType: 'SLAUGHTERHOUSE' });
      coldStoreA = await insertTestLocation(trx, adminId, farmA);
      const actor = async (
        role: string,
        options: Parameters<typeof assignTestRole>[4] = {},
      ): Promise<Actor> => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, adminId, options);
        return { userId, deviceId, token: '' };
      };
      rfeA = await actor(roles.rfe, { scopeType: 'SITE', scopeSiteId: farmA });
      rfeB = await actor(roles.rfe, { scopeType: 'SITE', scopeSiteId: farmB });
      rpr = await actor(roles.rpr);
      fin = await actor(roles.fin);
      ven = await actor(roles.ven, { scopeType: 'SITE', scopeSiteId: farmA });

      for (const [unit, name, isCount] of [
        ['TETE', 'Tête', 1],
        ['KG', 'Kilogramme', 0],
        ['OEUF', 'Œuf', 1],
        ['PIECE', 'Pièce', 1],
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
      const product = async (values: {
        readonly code?: string;
        readonly name: string;
        readonly family: string;
        readonly species?: string;
        readonly unit: string;
        readonly standardCost?: number;
      }): Promise<string> => {
        if (values.code !== undefined) {
          const existing = await trx
            .selectFrom('catalog_products')
            .select('id')
            .where('code', '=', values.code)
            .executeTakeFirst();
          if (existing) return fromBin(existing.id);
        }
        const id = freshUuid();
        await trx
          .insertInto('catalog_products')
          .values({
            id: toBin(id),
            code: values.code ?? `P-${id.slice(-10)}`,
            name: values.name,
            category_id: toBin(categoryId),
            stock_family: values.family,
            species: values.species ?? null,
            base_unit_code: values.unit,
            lot_tracking: values.family === 'INTRANT' ? 'NONE' : 'REQUIRED',
            is_consumable: values.family === 'INTRANT' ? 1 : 0,
            created_by: toBin(adminId),
          })
          .execute();
        if (values.standardCost !== undefined) {
          await trx
            .insertInto('catalog_product_standard_costs')
            .values({
              id: toBin(freshUuid()),
              product_id: toBin(id),
              unit_cost_xaf: values.standardCost,
              valid_from: new Date('2026-01-01T00:00:00.000Z'),
              created_by: toBin(adminId),
            })
            .execute();
        }
        return id;
      };
      const animal = { family: 'BIOLOGIQUE', unit: 'TETE' };
      chickId = await product({ ...animal, name: 'Poussin chair', species: 'POULET_CHAIR' });
      broilerId = await product({
        ...animal,
        name: 'Poulet de chair vif',
        species: 'POULET_CHAIR',
      });
      pulletId = await product({ ...animal, name: 'Poulette', species: 'PONDEUSE' });
      layerId = await product({ ...animal, name: 'Poule pondeuse', species: 'PONDEUSE' });
      feedId = await product({ name: 'Aliment croissance', family: 'INTRANT', unit: 'KG' });
      const egg = { family: 'PRODUCTION_COMMERCIALISABLE', unit: 'OEUF' };
      gradeId = await product({ ...egg, code: GRADE_CODE, name: 'Œuf gros', standardCost: 90 });
      hatchingEggId = await product({ ...egg, code: HATCHING_CODE, name: 'Œuf à couver' });
      wholeId = await product({
        name: 'Poulet entier',
        family: 'PRODUCTION_COMMERCIALISABLE',
        unit: 'PIECE',
      });
      for (const [key, value] of [
        ['production.egg_grade_product_codes', [GRADE_CODE]],
        ['production.hatching_egg_product_code', HATCHING_CODE],
        // Valeur du seed, datée du jour du test : le seed date ses clés du jour de son exécution.
        [
          'production.incubation_durations',
          { POULE: { candlingDay: 7, transferDay: 18, hatchDay: 21 } },
        ],
      ] as const) {
        await trx
          .insertInto('organization_system_settings')
          .values({
            id: toBin(freshUuid()),
            key,
            value: JSON.stringify(value),
            scope_type: 'GLOBAL',
            valid_from: new Date(at('00:00:00')),
            is_client_visible: 1,
            reason: 'Test P7-11',
            created_by: toBin(adminId),
          })
          .execute();
      }
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
      chickLotA = await supplierLot(chickId, 'PCA');
      chickLotB = await supplierLot(chickId, 'PCB');
      pulletLot = await supplierLot(pulletId, 'PUL');
      eggLot = await supplierLot(hatchingEggId, 'OAC');
      const opening = await virtualLocationId(trx, 'V_OPENING');
      for (const [productId, lotId, locationId, quantity, cost] of [
        [chickId, chickLotA, storeA, 400, 500],
        [chickId, chickLotB, storeB, 100, 500],
        [pulletId, pulletLot, storeA, 200, 3000],
        [hatchingEggId, eggLot, storeA, 100, 150],
        [feedId, undefined, storeA, 500, 300],
      ] as const) {
        await recordStockMove(
          trx,
          { idGenerator },
          {
            productId,
            ...(lotId !== undefined ? { lotId } : {}),
            quantityBase: quantity,
            fromLocationId: opening,
            toLocationId: locationId,
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
    for (const actor of [rfeA, rfeB, rpr, fin, ven]) {
      actor.token = await signAccessToken(
        jwtKeys.privateKey,
        { sub: actor.userId, device_id: actor.deviceId, session_id: freshUuid() },
        clock.now(),
      );
    }

    // Lot de chair de la ferme A : 400 poussins, 3 morts, 50 kg d'aliment, deux pesées, une
    // observation, un abattage de 20 têtes.
    lotA = await placedLot('POULET_CHAIR', broilerId, buildingA, {
      actor: rfeA,
      productId: chickId,
      locationId: storeA,
      stockLotId: chickLotA,
      quantity: 400,
    });
    await command(rfeA, 'production.weighing.record', 'LOT_WEIGHING', freshUuid(), at('07:00:00'), {
      productionLotId: lotA,
      sampleSize: 20,
      avgWeightG: 45,
    });
    await command(rfeA, 'production.mortality.record', 'STOCK_LOSS', freshUuid(), at('08:00:00'), {
      productionLotId: lotA,
      quantity: 3,
    });
    await command(
      rfeA,
      'production.observation.record',
      'LOT_OBSERVATION',
      freshUuid(),
      at('18:00:00'),
      { productionLotId: lotA, observationType: 'AUTRE', text: 'RAS' },
    );
    await command(
      rfeA,
      'production.input.record',
      'CONSUMPTION',
      freshUuid(),
      at('09:00:00', '2026-09-15'),
      {
        productionLotId: lotA,
        locationId: storeA,
        productId: feedId,
        quantityBase: 50,
        unitCode: 'KG',
        quantity: 50,
        costType: 'ALIMENT',
      },
    );
    await command(
      rfeA,
      'production.weighing.record',
      'LOT_WEIGHING',
      freshUuid(),
      at('07:00:00', DAY2),
      { productionLotId: lotA, sampleSize: 20, avgWeightG: 290 },
    );
    slaughterId = freshUuid();
    await command(
      rfeA,
      'production.slaughter.record',
      'SLAUGHTER',
      slaughterId,
      at('10:00:00', DAY2),
      {
        productionLotId: lotA,
        sourceLocationId: buildingA,
        slaughterhouseLocationId: houseA,
        heads: 20,
        condemnedHeads: 0,
        liveWeightG: 40_000,
        outputs: [
          { productId: wholeId, toLocationId: coldStoreA, quantityBase: 20, weightG: 28_000 },
        ],
      },
    );

    // Lot de chair de la ferme B (portée).
    lotB = await placedLot('POULET_CHAIR', broilerId, buildingB, {
      actor: rfeB,
      productId: chickId,
      locationId: storeB,
      stockLotId: chickLotB,
      quantity: 100,
    });

    // Pondeuses de la ferme A et une collecte (180 gros à 90 F).
    layerLot = await placedLot('PONDEUSE', layerId, buildingA, {
      actor: rfeA,
      productId: pulletId,
      locationId: storeA,
      stockLotId: pulletLot,
      quantity: 200,
    });
    collectionId = freshUuid();
    await command(
      rfeA,
      'production.egg_collection.record',
      'EGG_COLLECTION',
      collectionId,
      at('09:00:00', DAY2),
      {
        productionLotId: layerLot,
        storageLocationId: storeA,
        collected: 190,
        broken: 5,
        nonconforming: 5,
        hatching: 0,
        grades: [{ productId: gradeId, quantity: 180 }],
      },
    );

    // Incubation de 100 œufs achetés (150 F l'œuf).
    incubationId = freshUuid();
    await command(
      rfeA,
      'production.incubation.start',
      'INCUBATION_BATCH',
      incubationId,
      at('07:00:00'),
      {
        species: 'POULE',
        eggProductId: hatchingEggId,
        chickProductId: chickId,
        incubatorLocationId: incubatorA,
        eggSource: 'PURCHASED',
        eggsSet: 100,
        sourceLocationId: storeA,
        sourceStockLotId: eggLot,
      },
    );

    // Frais généraux de la ferme A (volaille), répartis par la Finance.
    await command(rpr, 'inventory.overhead.record', 'OVERHEAD_ENTRY', freshUuid(), at('09:00:00'), {
      siteId: farmA,
      label: 'Gardiennage',
      lines: [{ speciesGroup: 'VOLAILLE', amountXaf: 30_000 }],
    });
    await command(
      fin,
      'production.overhead.allocate',
      'OVERHEAD_ALLOCATION',
      freshUuid(),
      at('20:00:00', DAY2),
      { siteId: farmA, speciesGroup: 'VOLAILLE', period: DAY.slice(0, 7) },
    );
  });

  afterAll(async () => {
    await app?.close();
    await closeTestDb();
  });

  it('GET /production/lots : portée SITE par défaut, ALL filtrée par site ; 403 sans droit ; paramètres validés', async () => {
    const own = await get(rfeA, '/api/v1/production/lots?limit=200');
    expect(own.statusCode, own.body).toBe(200);
    const mine = idsOf(own.json().lots);
    expect(mine).toEqual(expect.arrayContaining([lotA, layerLot]));
    expect(mine).not.toContain(lotB);
    expect(idsOf((await get(rfeB, '/api/v1/production/lots?limit=200')).json().lots)).toContain(
      lotB,
    );

    const all = await get(rpr, `/api/v1/production/lots?site_id=${farmB}`);
    expect(idsOf(all.json().lots)).toEqual([lotB]);
    // Un responsable de ferme qui demande une autre ferme n'y voit rien.
    expect((await get(rfeA, `/api/v1/production/lots?site_id=${farmB}`)).json().lots).toEqual([]);

    const layers = await get(rpr, `/api/v1/production/lots?site_id=${farmA}&lot_type=PONDEUSE`);
    expect(idsOf(layers.json().lots)).toEqual([layerLot]);
    const summary = (own.json().lots as { id: string }[]).find((lot) => lot.id === lotA);
    expect(summary).toMatchObject({
      siteId: farmA,
      status: 'ACTIVE',
      initialQuantity: 400,
      headcount: { unsold: 377, rearing: 377 },
    });

    expect((await get(ven, '/api/v1/production/lots')).statusCode).toBe(403);
    expect((await get(rpr, '/api/v1/production/lots?limit=0')).statusCode).toBe(400);
    expect((await get(rpr, '/api/v1/production/lots?lot_type=CANARD')).statusCode).toBe(400);
    expect((await get(rpr, '/api/v1/production/lots/pas-un-uuid')).statusCode).toBe(400);
  });

  it('GET /production/lots/{id} : entrées, pesées, mortalité, coûts, indicateurs ; RC-05 pour le responsable de ferme', async () => {
    const response = await get(rpr, `/api/v1/production/lots/${lotA}`);
    expect(response.statusCode, response.body).toBe(200);
    const { lot } = response.json();
    expect(lot.entries).toEqual([
      expect.objectContaining({ quantity: 400, valueXaf: 200_000, status: 'RECORDED' }),
    ]);
    expect(lot.weighings.map((w: { avgWeightG: number }) => w.avgWeightG)).toEqual([45, 290]);
    expect(lot.mortality.countedQuantity + lot.mortality.pendingQuantity).toBe(3);
    expect(lot.mortality.lostQuantity).toBe(3);
    const costTypes = (lot.costs.breakdown as { costType: string }[]).map((line) => line.costType);
    expect(costTypes).toEqual(expect.arrayContaining(['ALIMENT', 'FRAIS_GENERAUX']));
    expect(lot.costs.netXaf).toBe(
      (lot.costs.breakdown as { netXaf: number }[]).reduce((sum, line) => sum + line.netXaf, 0),
    );
    expect(lot.costs.remainingXaf).toBeGreaterThan(0);
    expect(lot.costs.costPerHeadXaf).toBeGreaterThan(0);
    expect(lot.costs.monthly).toEqual([
      expect.objectContaining({ period: DAY.slice(0, 7), revenueXaf: null }),
    ]);
    // GMQ : (290 − 45) g en 7 jours.
    expect(lot.indicators.averageDailyGainG).toBeCloseTo(35, 1);
    expect(lot.indicators.feedConversionRatio).toBeGreaterThan(0);
    expect(lot.indicators.layingRate).toBeNull();

    const masked = (await get(rfeA, `/api/v1/production/lots/${lotA}`)).json().lot;
    expect(masked.entries[0]).toMatchObject({ quantity: 400, valueXaf: null, unitCostXaf: null });
    expect(masked.costs).toMatchObject({ netXaf: null, remainingXaf: null, costPerHeadXaf: null });
    expect(masked.costs.breakdown[0]).toMatchObject({ debitXaf: null, netXaf: null });
    expect(masked.headcount).toEqual(lot.headcount);
    expect(masked.indicators).toEqual(lot.indicators);

    const layers = (await get(rfeA, `/api/v1/production/lots/${layerLot}`)).json().lot;
    expect(layers.indicators).toMatchObject({ eggsCollected: 190, layingRate: 0.95 });
  });

  it('GET /production/lots/{id} hors portée ⇒ 404 audité', async () => {
    const outside = await get(rfeA, `/api/v1/production/lots/${lotB}`);
    expect(outside.statusCode).toBe(404);
    const denied = await db
      .selectFrom('audit_audit_log')
      .select(['action', 'result'])
      .where('actor_user_id', '=', toBin(rfeA.userId))
      .where('entity_id', '=', toBin(lotB))
      .executeTakeFirstOrThrow();
    expect(denied).toEqual({ action: 'access.denied', result: 'DENIED' });
    expect((await get(rfeA, `/api/v1/production/lots/${freshUuid()}`)).statusCode).toBe(404);
    expect((await get(ven, `/api/v1/production/lots/${lotA}`)).statusCode).toBe(403);
  });

  it('GET /production/lots/{id}/daily : jour par jour, fenêtre par défaut de 7 jours, bornes', async () => {
    const response = await get(rpr, `/api/v1/production/lots/${lotA}/daily?from=${DAY}&to=${DAY2}`);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ production_lot_id: lotA, from: DAY, to: DAY2 });
    expect(body.days).toHaveLength(8);
    const [first] = body.days;
    expect(first).toMatchObject({
      day: DAY,
      enteredQuantity: 400,
      weighings: [{ avgWeightG: 45, sampleSize: 20 }],
      observations: [{ observationType: 'AUTRE', text: 'RAS' }],
      eggs: null,
    });
    expect(first.deaths.counted + first.deaths.pending).toBe(3);
    const feedDay = body.days.find((d: { day: string }) => d.day === '2026-09-15');
    expect(feedDay.consumptions).toEqual([
      { productId: feedId, costType: 'ALIMENT', quantityBase: 50, valueXaf: 15_000 },
    ]);
    const last = body.days[7];
    expect(last).toMatchObject({ day: DAY2, headcountEnd: 377 });

    const masked = await get(
      rfeA,
      `/api/v1/production/lots/${lotA}/daily?from=2026-09-15&to=2026-09-15`,
    );
    expect(masked.json().days[0].consumptions[0]).toMatchObject({
      quantityBase: 50,
      valueXaf: null,
    });

    const byDefault = await get(rfeA, `/api/v1/production/lots/${lotA}/daily`);
    expect(byDefault.statusCode, byDefault.body).toBe(200);
    expect(byDefault.json().days).toHaveLength(7);
    expect(byDefault.json().to).toBe(businessDayOf(clock.now()));

    expect(
      (await get(rpr, `/api/v1/production/lots/${lotA}/daily?from=${DAY2}&to=${DAY}`)).statusCode,
    ).toBe(400);
    expect(
      (await get(rpr, `/api/v1/production/lots/${lotA}/daily?from=2026-01-01&to=${DAY}`))
        .statusCode,
    ).toBe(400);
    expect(
      (await get(rpr, `/api/v1/production/lots/${lotA}/daily?from=2026-02-30`)).statusCode,
    ).toBe(400);
    expect((await get(rfeB, `/api/v1/production/lots/${lotA}/daily`)).statusCode).toBe(404);
  });

  it('GET /production/egg-collections : bilan et calibres, valeur masquée sans droit ; fiche hors portée ⇒ 404', async () => {
    const valued = await get(
      rpr,
      `/api/v1/production/egg-collections?production_lot_id=${layerLot}`,
    );
    expect(valued.statusCode, valued.body).toBe(200);
    expect(valued.json().egg_collections).toEqual([
      expect.objectContaining({
        id: collectionId,
        siteId: farmA,
        collectionDate: DAY2,
        collected: 190,
        broken: 5,
        nonconforming: 5,
        marketable: 180,
        hatching: 0,
        valueXaf: 16_200,
        grades: [{ productId: gradeId, quantity: 180, unitCostXaf: 90 }],
        status: 'RECORDED',
      }),
    ]);
    const masked = await get(rfeA, `/api/v1/production/egg-collections/${collectionId}`);
    expect(masked.json().egg_collection).toMatchObject({
      marketable: 180,
      valueXaf: null,
      grades: [{ quantity: 180, unitCostXaf: null }],
    });
    const window = await get(
      rfeA,
      `/api/v1/production/egg-collections?production_lot_id=${layerLot}&from=${DAY}&to=${DAY}`,
    );
    expect(window.json().egg_collections).toEqual([]);
    expect((await get(rfeB, `/api/v1/production/egg-collections/${collectionId}`)).statusCode).toBe(
      404,
    );
    expect(
      idsOf(
        (await get(rfeB, '/api/v1/production/egg-collections?limit=200')).json().egg_collections,
      ),
    ).not.toContain(collectionId);
  });

  it('GET /production/incubations : compteurs et coût (masqué sans droit) ; fiche avec ses événements', async () => {
    const valued = await get(
      rpr,
      `/api/v1/production/incubations?site_id=${farmA}&status=INCUBATING`,
    );
    expect(valued.statusCode, valued.body).toBe(200);
    expect(valued.json().incubations).toEqual([
      expect.objectContaining({
        id: incubationId,
        eggsSet: 100,
        eggSource: 'PURCHASED',
        status: 'INCUBATING',
        hatchRate: null,
        costXaf: 15_000,
      }),
    ]);
    const detail = await get(rfeA, `/api/v1/production/incubations/${incubationId}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().incubation).toMatchObject({ id: incubationId, costXaf: null });
    expect(Array.isArray(detail.json().incubation.events)).toBe(true);
    expect((await get(rfeB, `/api/v1/production/incubations/${incubationId}`)).statusCode).toBe(
      404,
    );
  });

  it('GET /production/slaughters : rendement et valeurs (masquées sans droit)', async () => {
    const valued = await get(rpr, `/api/v1/production/slaughters?production_lot_id=${lotA}`);
    expect(valued.statusCode, valued.body).toBe(200);
    const [slaughter] = valued.json().slaughters;
    expect(slaughter).toMatchObject({
      id: slaughterId,
      heads: 20,
      condemnedHeads: 0,
      liveWeightG: 40_000,
      outputWeightG: 28_000,
      yieldRate: 0.7,
      status: 'RECORDED',
    });
    expect(slaughter.inputValueXaf).toBeGreaterThan(0);
    expect(slaughter.outputs).toEqual([
      expect.objectContaining({
        productId: wholeId,
        quantity: 20,
        valueXaf: slaughter.inputValueXaf,
      }),
    ]);
    const masked = (await get(rfeA, `/api/v1/production/slaughters/${slaughterId}`)).json()
      .slaughter;
    expect(masked).toMatchObject({ heads: 20, inputValueXaf: null });
    expect(masked.outputs[0]).toMatchObject({ quantity: 20, valueXaf: null, unitCostXaf: null });
    expect((await get(rfeB, `/api/v1/production/slaughters/${slaughterId}`)).statusCode).toBe(404);
  });

  it('GET /production/overhead-allocations : répartition par lot, montants masqués sans droit', async () => {
    const response = await get(
      fin,
      `/api/v1/production/overhead-allocations?site_id=${farmA}&species_group=VOLAILLE&period=${DAY.slice(0, 7)}`,
    );
    expect(response.statusCode, response.body).toBe(200);
    const [allocation] = response.json().overhead_allocations;
    expect(allocation).toMatchObject({
      siteId: farmA,
      speciesGroup: 'VOLAILLE',
      runKind: 'INITIAL',
      allocatedXaf: 30_000,
    });
    const lots = (allocation.lines as { productionLotId: string }[]).map((l) => l.productionLotId);
    expect(lots.sort()).toEqual([lotA, layerLot].sort());
    expect(
      (allocation.lines as { amountXaf: number }[]).reduce((sum, l) => sum + l.amountXaf, 0),
    ).toBe(30_000);

    const masked = await get(rfeA, `/api/v1/production/overhead-allocations?site_id=${farmA}`);
    expect(masked.json().overhead_allocations[0]).toMatchObject({
      poolXaf: null,
      allocatedXaf: null,
    });
    expect(
      (await get(rfeB, `/api/v1/production/overhead-allocations?site_id=${farmA}`)).json()
        .overhead_allocations,
    ).toEqual([]);
    expect(
      (await get(fin, '/api/v1/production/overhead-allocations?period=2026-13')).statusCode,
    ).toBe(400);
  });
});
