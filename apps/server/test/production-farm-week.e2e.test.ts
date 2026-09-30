/**
 * P7-13 — « Saisie du jour d'une semaine hors ligne » (plan de développement §4, P7 : tests E2E ;
 * D07 §12 : la ferme est une zone de connectivité faible, toutes les saisies quotidiennes
 * fonctionnent hors ligne ; clôture et validations en ligne). Un appareil virtuel
 * (`sync-harness.ts`) du responsable de ferme télécharge les jeux `production` et `stock`, saisit
 * hors ligne sept jours de mortalités, d'aliment, de collectes, de pesées et d'observations, puis
 * envoie toute sa file en un lot par le vrai protocole (`SyncPushService` → pipeline →
 * gestionnaires `production`, `inventory`, `approvals`) ; le Responsable production valide les
 * mortalités en ligne ; l'appareil retélécharge le jeu `production`.
 *
 * Démontre : chaque saisie est appliquée à sa date métier (vue jour par jour du lot) ; le rejeu du
 * même lot est idempotent (aucun doublon) ; la mortalité attend la validation (AV-048), comptée
 * seulement après décision, et l'appareil reçoit le nouveau statut ; indicateurs de la semaine
 * (mortalité, GMQ, indice de consommation, taux de ponte).
 *
 * Heures relatives à l'heure réelle (fenêtre de 30 jours du jeu `production` évaluée par la base) :
 * jours métier J-8 à J-1 (Africa/Douala). Le paramètre des calibres est posé une minute avant chaque
 * collecte, avec la valeur stable des autres tests de production.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FixedClock,
  Uuidv7Generator,
  addBusinessDays,
  businessDayOf,
  type IdGenerator,
} from '@gic/domain';
import type { PushResponse, RawCommandEnvelope } from '@gic/contracts';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { SyncPushService } from '../src/sync/sync-push.service.js';
import { SyncPullService } from '../src/sync/sync-pull.service.js';
import { registerPolicyCommands } from '../src/modules/approvals/application/commands/policy-commands.js';
import { registerRequestCommands } from '../src/modules/approvals/application/commands/request-commands.js';
import { ApprovalDecisionHandlerRegistry } from '../src/modules/approvals/application/decision-handler-registry.js';
import { registerLossCommands } from '../src/modules/inventory/application/commands/loss-commands.js';
import { registerConsumptionCommands } from '../src/modules/inventory/application/commands/consumption-commands.js';
import { registerLotCommands } from '../src/modules/production/application/commands/lot-commands.js';
import { registerDailyCommands } from '../src/modules/production/application/commands/daily-commands.js';
import { registerEggCollectionCommands } from '../src/modules/production/application/commands/egg-collection-commands.js';
import {
  ensureSupplierLot,
  recordStockMove,
  virtualLocationId,
} from '../src/modules/inventory/application/public/index.js';
import {
  getProductionLot,
  productionLotDaily,
} from '../src/modules/production/application/public/index.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { VirtualDevice } from './sync-harness.js';
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

const NOW = new Date(Math.floor(Date.now() / 1000) * 1000);
const TODAY = businessDayOf(NOW);
/** Jour métier J-k (Africa/Douala). */
const day = (k: number) => addBusinessDays(TODAY, -k);
/** Instant `hh:mm` du jour métier J-k, en ISO UTC (Douala = UTC+1). */
const on = (k: number, hhmm: string) => new Date(`${day(k)}T${hhmm}:00+01:00`).toISOString();
const GRADE_CODE = 'TEST-OEUF-E2E-GROS';
const WEEK = [7, 6, 5, 4, 3, 2, 1] as const;
/** Morts par jour : 17 sur la semaine. */
const DEATHS: Readonly<Record<number, number>> = { 7: 2, 6: 3, 5: 2, 4: 3, 3: 2, 2: 3, 1: 2 };
let onlineSeq = 0;

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

describe('P7-13 : saisie du jour d’une semaine hors ligne', () => {
  let clock: FixedClock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let device: VirtualDevice;
  let farmManager: Actor;
  let productionManager: Actor;
  let policyAdmin: Actor;
  let buildingId: string;
  let storeId: string;
  let feedId: string;
  let gradeId: string;
  let broilerLot: string;
  let layerLot: string;
  let batch: readonly RawCommandEnvelope[];
  let firstPush: PushResponse;

  async function online(
    actor: Actor,
    commandType: string,
    aggregateType: string,
    aggregateId: string,
    occurredAt: string,
    payload: unknown,
  ): Promise<void> {
    const result = await pipeline.handle(
      {
        command_id: freshUuid(),
        device_seq: ++onlineSeq,
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

  /** Commande saisie hors ligne sur l'appareil du responsable de ferme. */
  function offline(
    commandType: string,
    aggregateType: string,
    occurredAt: string,
    payload: unknown,
  ): RawCommandEnvelope {
    return {
      command_id: freshUuid(),
      device_seq: device.nextSeq(),
      command_version: 1,
      command_type: commandType,
      author_user_id: farmManager.userId,
      aggregate_type: aggregateType,
      aggregate_id: freshUuid(),
      base_version: null,
      depends_on: [],
      occurred_at: occurredAt,
      client_created_at: occurredAt,
      captured_offline: true,
      backdated_reason: null,
      attachment_ids: [],
      payload,
    };
  }

  /** Entités du jeu `production` présentes sur l'appareil, par type. */
  function local(entityType: string): Record<string, unknown>[] {
    return [...device.localProjection.entries()]
      .filter(([key]) => key.startsWith(`production:${entityType}:`))
      .map(([, data]) => data);
  }

  async function roleId(code: string): Promise<string> {
    const row = await db
      .selectFrom('identity_roles')
      .select('id')
      .where('code', '=', code)
      .executeTakeFirstOrThrow();
    return fromBin(row.id);
  }

  beforeAll(async () => {
    clock = new FixedClock(NOW);
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    const decisions = new ApprovalDecisionHandlerRegistry();
    const sequences = new DocumentSequenceService();
    registerPolicyCommands(registry);
    registerRequestCommands(registry, decisions);
    registerLossCommands(registry, decisions, idGenerator, sequences);
    registerConsumptionCommands(registry, idGenerator);
    registerLotCommands(registry, idGenerator, sequences);
    registerDailyCommands(registry, idGenerator, sequences);
    registerEggCollectionCommands(registry, idGenerator, sequences);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);
    const services = {
      push: new SyncPushService(pipeline, db, clock),
      pull: new SyncPullService(db),
    };

    const roles = { rfe: await roleId('RESP_FERME'), rpr: await roleId('RESP_PRODUCTION') };
    let chickId = '';
    let broilerId = '';
    let pulletId = '';
    let layerId = '';
    let chickLot = '';
    let pulletLot = '';
    await db.transaction().execute(async (trx) => {
      const rootId = await insertTestUser(trx);
      policyAdmin = { userId: rootId, deviceId: await insertTestDevice(trx, rootId) };
      const policyRole = await insertTestRole(trx, rootId);
      await grantTestPermission(trx, policyRole, 'approvals.policy.manage', rootId);
      await assignTestRole(trx, rootId, policyRole, rootId);
      const zoneId = await insertTestZone(trx, rootId);
      const farmId = await insertTestSite(trx, rootId, zoneId, { siteType: 'FERME' });
      buildingId = await insertTestLocation(trx, rootId, farmId, { locationType: 'BUILDING' });
      storeId = await insertTestLocation(trx, rootId, farmId);
      const actor = async (role: string, options: Parameters<typeof assignTestRole>[4] = {}) => {
        const userId = await insertTestUser(trx);
        const deviceId = await insertTestDevice(trx, userId, { status: 'ACTIVE' });
        await assignTestRole(trx, userId, role, rootId, options);
        return { userId, deviceId };
      };
      farmManager = await actor(roles.rfe, { scopeType: 'SITE', scopeSiteId: farmId });
      productionManager = await actor(roles.rpr);

      for (const [unit, name, isCount] of [
        ['TETE', 'Tête', 1],
        ['KG', 'Kilogramme', 0],
        ['OEUF', 'Œuf', 1],
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
          name: 'Ferme',
          created_by: toBin(rootId),
        })
        .execute();
      const product = async (values: {
        readonly name: string;
        readonly family: string;
        readonly species?: string;
        readonly unit: string;
      }): Promise<string> => {
        const id = freshUuid();
        await trx
          .insertInto('catalog_products')
          .values({
            id: toBin(id),
            code: `P-${id.slice(-10)}`,
            name: values.name,
            category_id: toBin(categoryId),
            stock_family: values.family,
            species: values.species ?? null,
            base_unit_code: values.unit,
            lot_tracking: values.family === 'INTRANT' ? 'NONE' : 'REQUIRED',
            is_consumable: values.family === 'INTRANT' ? 1 : 0,
            created_by: toBin(rootId),
          })
          .execute();
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
      const grade = await trx
        .selectFrom('catalog_products')
        .select('id')
        .where('code', '=', GRADE_CODE)
        .executeTakeFirst();
      if (grade) {
        gradeId = fromBin(grade.id);
      } else {
        gradeId = freshUuid();
        await trx
          .insertInto('catalog_products')
          .values({
            id: toBin(gradeId),
            code: GRADE_CODE,
            name: 'Œuf gros',
            category_id: toBin(categoryId),
            stock_family: 'PRODUCTION_COMMERCIALISABLE',
            base_unit_code: 'OEUF',
            lot_tracking: 'REQUIRED',
            created_by: toBin(rootId),
          })
          .execute();
        await trx
          .insertInto('catalog_product_standard_costs')
          .values({
            id: toBin(freshUuid()),
            product_id: toBin(gradeId),
            unit_cost_xaf: 90,
            valid_from: new Date('2026-01-01T00:00:00.000Z'),
            created_by: toBin(rootId),
          })
          .execute();
      }
      for (const k of WEEK) {
        await trx
          .insertInto('organization_system_settings')
          .values({
            id: toBin(freshUuid()),
            key: 'production.egg_grade_product_codes',
            value: JSON.stringify([GRADE_CODE]),
            scope_type: 'GLOBAL',
            valid_from: new Date(on(k, '08:59')),
            is_client_visible: 1,
            reason: 'Test P7-13 (semaine hors ligne)',
            created_by: toBin(rootId),
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
          created_by: toBin(rootId),
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
            fifoRankAt: new Date(on(9, '05:00')),
            createdBy: rootId,
          },
        );
      chickLot = await supplierLot(chickId, 'PC');
      pulletLot = await supplierLot(pulletId, 'PUL');
      const opening = await virtualLocationId(trx, 'V_OPENING');
      for (const [productId, lotId, quantity, cost] of [
        [chickId, chickLot, 1000, 450],
        [pulletId, pulletLot, 400, 3_000],
        [feedId, undefined, 1000, 300],
      ] as const) {
        await recordStockMove(
          trx,
          { idGenerator },
          {
            productId,
            ...(lotId !== undefined ? { lotId } : {}),
            quantityBase: quantity,
            fromLocationId: opening,
            toLocationId: storeId,
            moveType: 'OPENING_BALANCE',
            declaredUnitCostXaf: cost,
            occurredAt: new Date(on(9, '05:00')),
            sourceDocType: 'INVENTORY_COUNT',
            sourceDocId: freshUuid(),
            createdBy: rootId,
            allowNegative: false,
          },
        );
      }
    });

    // Toute mortalité validée (AV-048), sans photo pour ce test, sur la semaine.
    const policyId = freshUuid();
    await online(policyAdmin, 'approvals.policy.set', 'CONTROL_POLICY', policyId, on(9, '00:00'), {
      code: `MORTALITY_${policyId.slice(-8)}`,
      operationType: 'MORTALITY',
      validFrom: on(9, '00:00'),
      validTo: new Date(NOW.getTime() + 10 * 60_000).toISOString(),
      requiresApproval: true,
      requiresPhoto: false,
      approverPermission: 'production.mortality.approve',
      approverScope: 'ALL',
      condition: { relativePct: 0, absoluteHeads: 0 },
    });

    // J-8, en ligne : lots créés et mis en place.
    broilerLot = freshUuid();
    layerLot = freshUuid();
    for (const [id, lotType, productId, source, sourceLot, quantity] of [
      [broilerLot, 'POULET_CHAIR', broilerId, chickId, chickLot, 1000],
      [layerLot, 'PONDEUSE', layerId, pulletId, pulletLot, 400],
    ] as const) {
      await online(
        productionManager,
        'production.lot.create',
        'PRODUCTION_LOT',
        id,
        on(8, '06:00'),
        {
          lotType,
          productId,
          mainLocationId: buildingId,
        },
      );
      await online(
        farmManager,
        'production.lot.record_entry',
        'LOT_ENTRY',
        freshUuid(),
        on(8, '07:00'),
        {
          productionLotId: id,
          sourceKind: 'INTERNAL_STOCK',
          sourceProductId: source,
          sourceLocationId: storeId,
          sourceStockLotId: sourceLot,
          quantity,
        },
      );
    }

    device = new VirtualDevice(
      services,
      { authenticatedUserId: farmManager.userId, authenticatedDeviceId: farmManager.deviceId },
      clock,
    );
    await device.pullAll('production', NOW);
    await device.pullAll('stock', NOW);

    // La semaine hors ligne : chaque jour, mortalité, aliment, collecte ; pesées J-7 et J-1 ;
    // observation « RAS » J-4.
    const commands: RawCommandEnvelope[] = [];
    for (const k of WEEK) {
      if (k === 7 || k === 1) {
        commands.push(
          offline('production.weighing.record', 'LOT_WEIGHING', on(k, '07:30'), {
            productionLotId: broilerLot,
            locationId: buildingId,
            sampleSize: 20,
            avgWeightG: k === 7 ? 120 : 480,
          }),
        );
      }
      commands.push(
        offline('production.mortality.record', 'STOCK_LOSS', on(k, '08:00'), {
          productionLotId: broilerLot,
          quantity: DEATHS[k],
        }),
        offline('production.input.record', 'CONSUMPTION', on(k, '08:30'), {
          productionLotId: broilerLot,
          locationId: storeId,
          productId: feedId,
          quantityBase: 40,
          unitCode: 'KG',
          quantity: 40,
          costType: 'ALIMENT',
        }),
        offline('production.egg_collection.record', 'EGG_COLLECTION', on(k, '09:00'), {
          productionLotId: layerLot,
          storageLocationId: storeId,
          collected: 380,
          broken: 4,
          nonconforming: 6,
          hatching: 0,
          grades: [{ productId: gradeId, quantity: 370 }],
        }),
      );
      if (k === 4) {
        commands.push(
          offline('production.observation.record', 'LOT_OBSERVATION', on(k, '18:00'), {
            productionLotId: broilerLot,
            observationType: 'AUTRE',
            text: 'RAS',
          }),
        );
      }
    }
    batch = commands;
    firstPush = await device.pushUntilSettled(batch);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('l’appareil avait les lots de sa ferme avant de partir', () => {
    const lots = local('PRODUCTION_LOT').map((lot) => lot.id);
    expect(lots).toEqual(expect.arrayContaining([broilerLot, layerLot]));
  });

  it('la file d’une semaine est appliquée en un lot ; le rejeu est idempotent', async () => {
    expect(batch).toHaveLength(24);
    expect(firstPush.results.map((r) => r.status)).toEqual(batch.map(() => 'APPLIED'));
    const replay = await device.pushUntilSettled(batch);
    expect(replay.results.map((r) => r.status)).toEqual(batch.map(() => 'APPLIED'));
    const collections = await db
      .selectFrom('production_egg_collections')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('production_lot_id', '=', toBin(layerLot))
      .executeTakeFirstOrThrow();
    expect(Number(collections.n)).toBe(7);
    const losses = await db
      .selectFrom('inventory_loss_declarations')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('production_lot_id', '=', toBin(broilerLot))
      .executeTakeFirstOrThrow();
    expect(Number(losses.n)).toBe(7);
  });

  it('chaque saisie est à sa date métier ; mortalité en attente de validation', async () => {
    const lot = (await getProductionLot(db, broilerLot))!;
    const days = await productionLotDaily(db, lot, day(7), day(1));
    expect(days.map((d) => d.day)).toEqual(WEEK.map((k) => day(k)));
    for (const [index, k] of WEEK.entries()) {
      const d = days[index]!;
      expect(d.deaths).toEqual({ counted: 0, pending: DEATHS[k] });
      expect(d.consumptions).toEqual([
        expect.objectContaining({ productId: feedId, costType: 'ALIMENT', quantityBase: 40 }),
      ]);
    }
    expect(days[0]!.weighings).toEqual([{ avgWeightG: 120, sampleSize: 20 }]);
    expect(days[6]!.weighings).toEqual([{ avgWeightG: 480, sampleSize: 20 }]);
    expect(days[3]!.observations).toEqual([
      { observationType: 'AUTRE', severity: 'INFO', text: 'RAS' },
    ]);
    expect(lot.mortality).toMatchObject({ countedQuantity: 0, pendingQuantity: 17 });
    expect(lot.headcount.rearing).toBe(983);

    const layers = (await getProductionLot(db, layerLot))!;
    const layerDays = await productionLotDaily(db, layers, day(7), day(1));
    expect(layerDays.map((d) => d.eggs?.collected)).toEqual(WEEK.map(() => 380));
    expect(layers.indicators).toMatchObject({ eggsCollected: 7 * 380, layingRate: 0.95 });
  });

  it('validations en ligne par le Responsable production ; l’appareil reçoit les statuts ; indicateurs de la semaine', async () => {
    const pending = await db
      .selectFrom('inventory_loss_declarations')
      .select(['id', 'approval_request_id'])
      .where('production_lot_id', '=', toBin(broilerLot))
      .where('status', '=', 'PENDING_APPROVAL')
      .execute();
    expect(pending).toHaveLength(7);
    for (const loss of pending) {
      const requestId = fromBin(loss.approval_request_id!);
      await online(
        productionManager,
        'approvals.request.approve',
        'APPROVAL_REQUEST',
        requestId,
        NOW.toISOString(),
        { requestId },
      );
    }

    await device.pullAll('production', NOW);
    const losses = local('LOT_LOSS').filter((loss) => loss.production_lot_id === broilerLot);
    expect(losses).toHaveLength(7);
    expect(losses.every((loss) => loss.status === 'APPROVED')).toBe(true);
    expect(local('EGG_COLLECTION').filter((c) => c.production_lot_id === layerLot)).toHaveLength(7);
    expect(local('LOT_CONSUMPTION').filter((c) => c.production_lot_id === broilerLot)).toHaveLength(
      7,
    );
    expect(local('LOT_WEIGHING').filter((w) => w.production_lot_id === broilerLot)).toHaveLength(2);

    const lot = (await getProductionLot(db, broilerLot))!;
    expect(lot.mortality).toMatchObject({ countedQuantity: 17, pendingQuantity: 0 });
    expect(lot.headcount).toEqual({ unsold: 983, rearing: 983 });
    expect(lot.indicators.mortalityRate).toBe(0.017);
    // GMQ : (480 − 120) g en 6 jours.
    expect(lot.indicators.averageDailyGainG).toBeCloseTo(60, 1);
    expect(lot.indicators.feedConversionRatio).toBeGreaterThan(0);
  });
});
