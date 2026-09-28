/**
 * P7-07 — collectes d'œufs, à travers le vrai pipeline (SM-EGG-COLLECTION) :
 * - AT-028 : 1 850 collectés = 25 cassés + 15 non conformes + 1 690 commercialisables (par
 *   calibre, AV-046) + 120 à couver ; seuls les commercialisables et les œufs à couver entrent
 *   en stock, au coût standard, dans le lot de stock propre de la collecte (AV-100), avec une
 *   péremption (AV-122) ; le lot de pondeuses est crédité (AV-098) ;
 * - plusieurs collectes par jour (AV-110) ; refus de bilan, de calibre, de type de lot,
 *   d'emplacement, de date et de portée ;
 * - annulation : contre-passation, crédit repris, lot de stock clos ; œufs sortis : refus en
 *   ligne (`STOCK_UNAVAILABLE`), `STOCK_NEGATIVE` hors ligne ;
 * - hors ligne, un calibre sorti de la liste est accepté ; sans coût standard, l'entrée se fait
 *   au CMUP courant (AV-124).
 *
 * Les paramètres de calibres insérés ici gardent des codes stables d'une exécution à l'autre
 * (pas de fin de validité sur les paramètres système) : leur valeur ne varie pas.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { FixedClock, Uuidv7Generator, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { DocumentSequenceService } from '../src/platform/document-sequences/document-sequence.service.js';
import { registerLotCommands } from '../src/modules/production/application/commands/lot-commands.js';
import { registerEggCollectionCommands } from '../src/modules/production/application/commands/egg-collection-commands.js';
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

const DAY = '2026-10-22';
const at = (hhmmss: string) => `${DAY}T${hhmmss}.000Z`;
const NOW = at('20:00:00');
let deviceSeq = 0;

/** Codes stables d'une exécution à l'autre : le paramètre des calibres garde la même valeur. */
const GRADE_CODES = ['TEST-OEUF-GROS', 'TEST-OEUF-MOYEN'] as const;
const HATCHING_CODE = 'TEST-OEUF-COUVER';

interface Actor {
  readonly userId: string;
  readonly deviceId: string;
}

describe('P7-07 : collectes d’œufs', () => {
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let farmManager: Actor;
  let otherFarmManager: Actor;
  let productionManager: Actor;
  let buildingId: string;
  let eggStoreId: string;
  let otherStoreId: string;
  let layerLotId: string;
  let broilerLotId: string;
  let bigId: string;
  let mediumId: string;
  let hatchingId: string;
  let unlistedEggId: string;

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

  const collection = (extra: Record<string, unknown> = {}) => ({
    productionLotId: layerLotId,
    storageLocationId: eggStoreId,
    collected: 1850,
    broken: 25,
    nonconforming: 15,
    hatching: 120,
    grades: [
      { productId: bigId, quantity: 1000 },
      { productId: mediumId, quantity: 690 },
    ],
    ...extra,
  });

  async function collect(
    payload: unknown,
    actor: Actor = farmManager,
    time = at('09:00:00'),
  ): Promise<{ readonly id: string; readonly result: Result }> {
    const id = freshUuid();
    const result = await run(
      actor,
      'production.egg_collection.record',
      'EGG_COLLECTION',
      id,
      time,
      payload,
    );
    return { id, result };
  }

  async function lotNet(lotId: string): Promise<number> {
    return (await costObjectBalance(db, { costObjectType: 'PRODUCTION_LOT', costObjectId: lotId }))
      .netXaf;
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
    registerEggCollectionCommands(registry, idGenerator, sequences);
    pipeline = new CommandPipelineService(db, registry, clock, idGenerator);

    const roles = { rfe: await roleId('RESP_FERME'), rpr: await roleId('RESP_PRODUCTION') };
    let pulletId = '';
    let pulletLotId = '';
    let layerId = '';
    let chickenId = '';
    await db.transaction().execute(async (trx) => {
      const adminId = await insertTestUser(trx);
      const zoneId = await insertTestZone(trx, adminId);
      const farmId = await insertTestSite(trx, adminId, zoneId, { siteType: 'FERME' });
      const otherFarmId = await insertTestSite(trx, adminId, zoneId, { siteType: 'FERME' });
      buildingId = await insertTestLocation(trx, adminId, farmId, { locationType: 'BUILDING' });
      eggStoreId = await insertTestLocation(trx, adminId, farmId);
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
          name: 'Ponte',
          created_by: toBin(adminId),
        })
        .execute();
      const product = async (values: {
        readonly code: string;
        readonly name: string;
        readonly family: string;
        readonly species?: string;
        readonly unit: string;
        readonly standardCost?: number;
      }): Promise<string> => {
        const existing = await trx
          .selectFrom('catalog_products')
          .select('id')
          .where('code', '=', values.code)
          .executeTakeFirst();
        if (existing) return fromBin(existing.id);
        const id = freshUuid();
        await trx
          .insertInto('catalog_products')
          .values({
            id: toBin(id),
            code: values.code,
            name: values.name,
            category_id: toBin(categoryId),
            stock_family: values.family,
            species: values.species ?? null,
            base_unit_code: values.unit,
            lot_tracking: 'REQUIRED',
            expiry_tracking: values.family === 'BIOLOGIQUE' ? 0 : 1,
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
      const egg = { family: 'PRODUCTION_COMMERCIALISABLE', unit: 'OEUF' };
      bigId = await product({ ...egg, code: GRADE_CODES[0], name: 'Œuf gros', standardCost: 90 });
      mediumId = await product({
        ...egg,
        code: GRADE_CODES[1],
        name: 'Œuf moyen',
        standardCost: 75,
      });
      hatchingId = await product({
        ...egg,
        code: HATCHING_CODE,
        name: 'Œuf à couver',
        standardCost: 110,
      });
      unlistedEggId = await product({
        ...egg,
        code: `OEUF-${categoryId.slice(-8)}`,
        name: 'Œuf extra',
      });
      layerId = await product({
        code: `PON-${categoryId.slice(-8)}`,
        name: 'Poule pondeuse',
        family: 'BIOLOGIQUE',
        species: 'PONDEUSE',
        unit: 'TETE',
      });
      pulletId = await product({
        code: `PUL-${categoryId.slice(-8)}`,
        name: 'Poulette prête à pondre',
        family: 'BIOLOGIQUE',
        species: 'PONDEUSE',
        unit: 'TETE',
      });
      chickenId = await product({
        code: `CHA-${categoryId.slice(-8)}`,
        name: 'Poulet de chair vif',
        family: 'BIOLOGIQUE',
        species: 'POULET_CHAIR',
        unit: 'TETE',
      });
      for (const [key, value] of [
        ['production.egg_grade_product_codes', [...GRADE_CODES]],
        ['production.hatching_egg_product_code', HATCHING_CODE],
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
            reason: 'Test P7-07',
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
          name: 'Accouveur',
          supplied_categories: JSON.stringify([]),
          status: 'ACTIVE',
          created_by: toBin(adminId),
        })
        .execute();
      pulletLotId = await ensureSupplierLot(
        trx,
        { idGenerator },
        {
          productId: pulletId,
          supplierId,
          supplierLotRef: `PL-${supplierId.slice(-6)}`,
          fallbackCode: `F:PL-${supplierId.slice(-6)}`,
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
          productId: pulletId,
          lotId: pulletLotId,
          quantityBase: 500,
          fromLocationId: await virtualLocationId(trx, 'V_OPENING'),
          toLocationId: eggStoreId,
          moveType: 'OPENING_BALANCE',
          declaredUnitCostXaf: 3000,
          occurredAt: new Date(at('05:00:00')),
          sourceDocType: 'INVENTORY_COUNT',
          sourceDocId: freshUuid(),
          createdBy: adminId,
          allowNegative: false,
        },
      );
    });

    layerLotId = freshUuid();
    broilerLotId = freshUuid();
    for (const [id, lotType, productId] of [
      [layerLotId, 'PONDEUSE', layerId],
      [broilerLotId, 'POULET_CHAIR', chickenId],
    ] as const) {
      const created = await run(
        productionManager,
        'production.lot.create',
        'PRODUCTION_LOT',
        id,
        at('06:00:00'),
        {
          lotType,
          productId,
          mainLocationId: buildingId,
        },
      );
      expect(created.status, JSON.stringify(created)).toBe('APPLIED');
    }
    const placed = await run(
      farmManager,
      'production.lot.record_entry',
      'LOT_ENTRY',
      freshUuid(),
      at('06:30:00'),
      {
        productionLotId: layerLotId,
        sourceKind: 'INTERNAL_STOCK',
        sourceProductId: pulletId,
        sourceLocationId: eggStoreId,
        sourceStockLotId: pulletLotId,
        quantity: 500,
      },
    );
    expect(placed.status, JSON.stringify(placed)).toBe('APPLIED');
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('AT-028 : bilan, calibres au coût standard, lot de stock propre avec péremption, crédit du lot', async () => {
    // Calculs par différence : aucun test ne dépend de l'ordre d'exécution (revue P7).
    const before = await lotNet(layerLotId);
    const { id, result } = await collect(collection());
    expect(result).toMatchObject({
      status: 'APPLIED',
      server_refs: { docNumber: expect.stringMatching(/^COL-.+-2026-\d{6}$/) },
    });
    const row = await db
      .selectFrom('production_egg_collections')
      .selectAll()
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      collected_qty: 1850,
      broken_qty: 25,
      nonconforming_qty: 15,
      marketable_qty: 1690,
      hatching_qty: 120,
      standard_value_xaf: 154_950, // 1 000 × 90 + 690 × 75 + 120 × 110
      status: 'RECORDED',
    });
    expect(fromBin(row.hatching_product_id!)).toBe(hatchingId);
    const lines = await db
      .selectFrom('production_egg_collection_lines')
      .select(['product_id', 'quantity', 'unit_cost_xaf'])
      .where('collection_id', '=', toBin(id))
      .execute();
    expect(
      lines.map((line) => [fromBin(line.product_id), line.quantity, line.unit_cost_xaf]).sort(),
    ).toEqual(
      [
        [bigId, 1000, 90],
        [mediumId, 690, 75],
      ].sort(),
    );
    const stockLot = await db
      .selectFrom('inventory_stock_lots')
      .selectAll()
      .where('id', '=', row.stock_lot_id)
      .executeTakeFirstOrThrow();
    expect(stockLot).toMatchObject({
      origin_type: 'COLLECTION',
      lot_code: row.doc_number,
      status: 'OPEN',
    });
    expect(fromBin(stockLot.origin_id!)).toBe(id);
    const moves = await db
      .selectFrom('inventory_stock_moves')
      .select(['product_id', 'quantity', 'value_xaf', 'lot_id'])
      .where('source_doc_type', '=', 'EGG_COLLECTION')
      .where('source_doc_id', '=', toBin(id))
      .execute();
    expect(moves).toHaveLength(3);
    expect(
      moves.every(
        (move) => move.lot_id !== null && fromBin(move.lot_id) === fromBin(row.stock_lot_id),
      ),
    ).toBe(true);
    expect(moves.reduce((sum, move) => sum + Number(move.value_xaf), 0)).toBe(154_950);
    expect(await lotNet(layerLotId)).toBe(before - 154_950);

    // AV-110 : seconde collecte du jour.
    const second = await collect(
      collection({
        collected: 100,
        broken: 0,
        nonconforming: 0,
        hatching: 0,
        grades: [{ productId: bigId, quantity: 100 }],
      }),
      farmManager,
      at('16:00:00'),
    );
    expect(second.result.status, JSON.stringify(second.result)).toBe('APPLIED');
    expect(await lotNet(layerLotId)).toBe(before - 154_950 - 9_000);
  });

  it('péremption du lot de stock : date de collecte + 28 jours (AV-122)', async () => {
    const { id } = await collect(
      collection({
        collected: 30,
        broken: 0,
        nonconforming: 0,
        hatching: 0,
        grades: [{ productId: mediumId, quantity: 30 }],
        collectionDate: '2026-10-21',
      }),
    );
    const row = await db
      .selectFrom('production_egg_collections as c')
      .innerJoin('inventory_stock_lots as l', 'l.id', 'c.stock_lot_id')
      .select([sql<string>`DATE_FORMAT(l.expiry_date, '%Y-%m-%d')`.as('expiry'), 'l.product_id'])
      .where('c.id', '=', toBin(id))
      .executeTakeFirstOrThrow();
    // Date lue en SQL : indépendante du fuseau de la machine de test.
    expect(row.expiry).toBe('2026-11-18');
    // Un seul produit : le lot de stock le porte.
    expect(fromBin(row.product_id!)).toBe(mediumId);
  });

  it('refus : bilan, calibre non paramétré, lot non pondeur, emplacement, date, portée', async () => {
    expect(code((await collect(collection({ collected: 1851 }))).result)).toBe(
      'EGG_BALANCE_INVALID',
    );
    expect(
      code(
        (
          await collect(
            collection({
              grades: [
                { productId: unlistedEggId, quantity: 1000 },
                { productId: mediumId, quantity: 690 },
              ],
            }),
          )
        ).result,
      ),
    ).toBe('EGG_GRADE_INVALID');
    expect(code((await collect(collection({ productionLotId: broilerLotId }))).result)).toBe(
      'LOT_NOT_LAYING',
    );
    expect(code((await collect(collection({ storageLocationId: otherStoreId }))).result)).toBe(
      'SITE_MISMATCH',
    );
    expect(code((await collect(collection({ collectionDate: '2026-10-23' }))).result)).toBe(
      'COLLECTION_DATE_INVALID',
    );
    expect(code((await collect(collection(), otherFarmManager)).result)).toBe('FORBIDDEN_SCOPE');
  });

  it('annulation : contre-passation et crédit repris ; œufs sortis → STOCK_UNAVAILABLE en ligne, STOCK_NEGATIVE hors ligne', async () => {
    const small = await collect(
      collection({
        collected: 60,
        broken: 0,
        nonconforming: 0,
        hatching: 0,
        grades: [{ productId: bigId, quantity: 60 }],
      }),
    );
    expect(small.result.status).toBe('APPLIED');
    const before = await lotNet(layerLotId);
    const cancel = (id: string, options: { readonly offline?: boolean } = {}) =>
      run(
        farmManager,
        'production.egg_collection.cancel',
        'EGG_COLLECTION',
        id,
        at('17:00:00'),
        { comment: 'Double saisie' },
        options,
      );
    expect(code(await cancel(small.id))).toBe('APPLIED');
    expect(await lotNet(layerLotId)).toBe(before + 5_400);
    const cancelled = await db
      .selectFrom('production_egg_collections as c')
      .innerJoin('inventory_stock_lots as l', 'l.id', 'c.stock_lot_id')
      .select(['c.status', 'l.status as lot_status'])
      .where('c.id', '=', toBin(small.id))
      .executeTakeFirstOrThrow();
    expect(cancelled).toEqual({ status: 'CANCELLED', lot_status: 'CLOSED' });
    expect(code(await cancel(small.id))).toBe('APPLIED');

    // Dix œufs sortis (perte) : l'annulation en ligne est refusée, appliquée hors ligne.
    const sold = await collect(
      collection({
        collected: 50,
        broken: 0,
        nonconforming: 0,
        hatching: 0,
        grades: [{ productId: bigId, quantity: 50 }],
      }),
    );
    const collectionLot = await db
      .selectFrom('production_egg_collections')
      .select('stock_lot_id')
      .where('id', '=', toBin(sold.id))
      .executeTakeFirstOrThrow();
    await db.transaction().execute(async (trx) => {
      await recordStockMove(
        trx,
        { idGenerator },
        {
          productId: bigId,
          lotId: fromBin(collectionLot.stock_lot_id),
          quantityBase: 10,
          fromLocationId: eggStoreId,
          toLocationId: await virtualLocationId(trx, 'V_LOSS'),
          moveType: 'LOSS',
          occurredAt: new Date(at('16:30:00')),
          sourceDocType: 'LOSS',
          sourceDocId: freshUuid(),
          createdBy: farmManager.userId,
          allowNegative: false,
        },
      );
    });
    expect(code(await cancel(sold.id))).toBe('STOCK_UNAVAILABLE');
    expect(await cancel(sold.id, { offline: true })).toMatchObject({
      status: 'APPLIED_WITH_WARNINGS',
      warnings: ['STOCK_NEGATIVE'],
    });
  });

  it('hors ligne : calibre hors liste accepté ; sans coût standard, entrée au CMUP courant (AV-124)', async () => {
    const before = await lotNet(layerLotId);
    const id = freshUuid();
    const result = await run(
      farmManager,
      'production.egg_collection.record',
      'EGG_COLLECTION',
      id,
      at('18:00:00'),
      collection({
        collected: 12,
        broken: 0,
        nonconforming: 0,
        hatching: 0,
        grades: [{ productId: unlistedEggId, quantity: 12 }],
      }),
      { offline: true },
    );
    expect(result.status, JSON.stringify(result)).toBe('APPLIED');
    const row = await db
      .selectFrom('production_egg_collections')
      .select(['standard_value_xaf', 'marketable_qty'])
      .where('id', '=', toBin(id))
      .executeTakeFirstOrThrow();
    // Produit jamais entré en stock : CMUP nul, aucun crédit du lot producteur.
    expect(row).toEqual({ standard_value_xaf: 0, marketable_qty: 12 });
    expect(await lotNet(layerLotId)).toBe(before);
  });
});
