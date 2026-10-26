/**
 * `inventory.threshold.set` (P2-04) à travers le vrai pipeline de commande. Démontre le
 * versionnement par désactivation (jamais d'UPDATE sur un seuil existant, même patron que
 * `approvals.policy.set`), l'idempotence du rejeu, et la validation du payload.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerThresholdCommands } from '../src/modules/inventory/application/commands/threshold-commands.js';
import { fromBin, toBin } from '../src/platform/kysely/uuid-columns.js';
import { recordStockMove } from '../src/modules/inventory/application/public/record-move.js';
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

const OCCURRED_AT = '2026-10-01T09:00:00.000Z';

function buildEnvelope(
  authorUserId: string,
  overrides: {
    readonly command_id?: string;
    readonly command_type: string;
    readonly aggregate_type: string;
    readonly aggregate_id: string;
    readonly payload: unknown;
    readonly occurred_at?: string;
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
  const productId = freshUuid();
  await db
    .insertInto('catalog_products')
    .values({
      id: toBin(productId),
      code: `PRD-${productId.slice(-8)}`,
      name: 'Produit de test seuil',
      category_id: toBin(categoryId),
      stock_family: 'MARCHANDISE',
      base_unit_code: 'TETE',
      lot_tracking: 'NONE',
      created_by: toBin(admin),
    })
    .execute();
  return productId;
}

describe('inventory.threshold.set (P2-04)', () => {
  let clock: Clock;
  let idGenerator: IdGenerator;
  let pipeline: CommandPipelineService;
  let admin: string;
  let adminDevice: string;
  let storeA: string;

  beforeAll(async () => {
    clock = new FixedClock(new Date(OCCURRED_AT));
    idGenerator = new Uuidv7Generator(clock);
    const registry = new CommandHandlerRegistry();
    registerThresholdCommands(registry, idGenerator);
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
      await grantTestPermission(trx, adminRole, 'inventory.threshold.manage', admin);
      await assignTestRole(trx, admin, adminRole, admin);
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  const ctx = () => ({
    authenticatedUserId: admin,
    authenticatedDeviceId: adminDevice,
    transport: 'ONLINE_API' as const,
  });

  it('set initial -> seuil actif inséré', async () => {
    const productId = await insertProduct(admin);
    const thresholdId = freshUuid();
    const result = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.threshold.set',
        aggregate_type: 'STOCK_THRESHOLD',
        aggregate_id: thresholdId,
        payload: { locationId: storeA, productId, minQtyBase: 10, targetQtyBase: 30 },
      }),
      ctx(),
    );
    expect(result.status).toBe('APPLIED');

    const row = await db
      .selectFrom('inventory_stock_thresholds')
      .select(['is_active', 'min_qty_base', 'target_qty_base'])
      .where('id', '=', toBin(thresholdId))
      .executeTakeFirstOrThrow();
    expect(row.is_active).toBe(1);
    expect(Number(row.min_qty_base)).toBe(10);
    expect(Number(row.target_qty_base)).toBe(30);
  });

  it('set sur la même paire (location, produit) -> désactive l’ancien, insère le nouveau actif', async () => {
    const productId = await insertProduct(admin);
    const firstId = freshUuid();
    await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.threshold.set',
        aggregate_type: 'STOCK_THRESHOLD',
        aggregate_id: firstId,
        payload: { locationId: storeA, productId, minQtyBase: 5, targetQtyBase: 15 },
      }),
      ctx(),
    );

    const secondId = freshUuid();
    const secondResult = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.threshold.set',
        aggregate_type: 'STOCK_THRESHOLD',
        aggregate_id: secondId,
        payload: { locationId: storeA, productId, minQtyBase: 8, targetQtyBase: 20 },
      }),
      ctx(),
    );
    expect(secondResult.status).toBe('APPLIED');

    const firstRow = await db
      .selectFrom('inventory_stock_thresholds')
      .select(['is_active'])
      .where('id', '=', toBin(firstId))
      .executeTakeFirstOrThrow();
    expect(firstRow.is_active).toBe(0);

    const secondRow = await db
      .selectFrom('inventory_stock_thresholds')
      .select(['is_active', 'min_qty_base', 'target_qty_base'])
      .where('id', '=', toBin(secondId))
      .executeTakeFirstOrThrow();
    expect(secondRow.is_active).toBe(1);
    expect(Number(secondRow.min_qty_base)).toBe(8);
    expect(Number(secondRow.target_qty_base)).toBe(20);

    // Un seul seuil actif pour cette paire (active_key, contrainte UNIQUE).
    const activeCount = await db
      .selectFrom('inventory_stock_thresholds')
      .select(({ fn }) => fn.countAll().as('c'))
      .where('location_id', '=', toBin(storeA))
      .where('product_id', '=', toBin(productId))
      .where('is_active', '=', 1)
      .executeTakeFirstOrThrow();
    expect(Number(activeCount.c)).toBe(1);
  });

  it('rejeu idempotent (même aggregate_id) -> APPLIED sans double effet', async () => {
    const productId = await insertProduct(admin);
    const thresholdId = freshUuid();
    const payload = { locationId: storeA, productId, minQtyBase: 3, targetQtyBase: 9 };

    const first = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.threshold.set',
        aggregate_type: 'STOCK_THRESHOLD',
        aggregate_id: thresholdId,
        payload,
      }),
      ctx(),
    );
    expect(first.status).toBe('APPLIED');

    const replay = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.threshold.set',
        aggregate_type: 'STOCK_THRESHOLD',
        aggregate_id: thresholdId,
        payload,
      }),
      ctx(),
    );
    expect(replay.status).toBe('APPLIED');

    const rows = await db
      .selectFrom('inventory_stock_thresholds')
      .select(['id'])
      .where('location_id', '=', toBin(storeA))
      .where('product_id', '=', toBin(productId))
      .execute();
    expect(rows).toHaveLength(1); // le rejeu n'a rien recréé/désactivé.
  });

  it('targetQtyBase < minQtyBase -> REJECTED VALIDATION_ERROR', async () => {
    const productId = await insertProduct(admin);
    const result = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'inventory.threshold.set',
        aggregate_type: 'STOCK_THRESHOLD',
        aggregate_id: freshUuid(),
        payload: { locationId: storeA, productId, minQtyBase: 20, targetQtyBase: 5 },
      }),
      ctx(),
    );
    expect(result.status).toBe('REJECTED');
    expect(result.status === 'REJECTED' && result.error.code).toMatch(/^VALIDATION_ERROR/);
  });

  it('P9-08 (AV-355) : premier seuil sur stock vide, minimum relevé puis abaissé, rejeu — un événement par franchissement', async () => {
    const site = await db
      .selectFrom('organization_locations')
      .select('site_id')
      .where('id', '=', toBin(storeA))
      .executeTakeFirstOrThrow();
    const store = await db
      .transaction()
      .execute((trx) =>
        insertTestLocation(trx, admin, fromBin(site.site_id!), { locationType: 'STORE' }),
      );
    const productId = await insertProduct(admin);
    const opening = await db
      .selectFrom('organization_locations')
      .select('id')
      .where('location_type', '=', 'V_OPENING')
      .executeTakeFirstOrThrow();

    const setThreshold = async (
      thresholdId: string,
      minQtyBase: number,
      targetQtyBase: number,
      occurredAt: string,
    ) => {
      const result = await pipeline.handle(
        buildEnvelope(admin, {
          command_type: 'inventory.threshold.set',
          aggregate_type: 'STOCK_THRESHOLD',
          aggregate_id: thresholdId,
          payload: { locationId: store, productId, minQtyBase, targetQtyBase },
          occurred_at: occurredAt,
        }),
        ctx(),
      );
      expect(result.status).toBe('APPLIED');
    };
    const breaches = async () =>
      (
        await db
          .selectFrom('platform_domain_events')
          .select('payload')
          .where('event_type', '=', 'StockThresholdBreached')
          .orderBy('seq', 'desc')
          .limit(500)
          .execute()
      )
        .map((row) => row.payload as Record<string, unknown>)
        .filter(
          (payload) => payload['location_id'] === store && payload['product_id'] === productId,
        )
        .reverse();

    // Stock vide : le premier seuil est aussitôt en rupture.
    await setThreshold(freshUuid(), 10, 30, '2026-09-28T09:00:00.000Z');
    expect((await breaches()).map((p) => [p['level'], p['breached']])).toEqual([['OUT', true]]);

    await db.transaction().execute((trx) =>
      recordStockMove(
        trx,
        { idGenerator },
        {
          productId,
          quantityBase: 12,
          fromLocationId: fromBin(opening.id),
          toLocationId: store,
          moveType: 'OPENING_BALANCE',
          declaredUnitCostXaf: 300,
          occurredAt: new Date(OCCURRED_AT),
          sourceDocType: 'INVENTORY_COUNT',
          sourceDocId: freshUuid(),
          createdBy: admin,
          allowNegative: false,
        },
      ),
    );
    // L'entrée met fin à la rupture signalée à la pose ; minimum 10 ≤ 12 : correct.
    expect((await breaches()).map((p) => [p['level'], p['breached']])).toEqual([
      ['OUT', true],
      ['OUT', false],
    ]);

    // Relevé à 20 : 12 < 20, stock bas ; le jour métier est celui de la commande.
    const raised = freshUuid();
    await setThreshold(raised, 20, 60, '2026-09-30T09:00:00.000Z');
    await setThreshold(raised, 20, 60, '2026-09-30T09:00:00.000Z'); // rejeu : rien de plus
    const afterRaise = await breaches();
    expect(afterRaise).toHaveLength(3);
    expect(afterRaise[2]).toMatchObject({
      level: 'LOW',
      breached: true,
      available: 12,
      threshold: 20,
      target: 60,
      business_day: '2026-09-30',
    });

    // Abaissé à 5 : 12 ≥ 5, fin du niveau bas.
    await setThreshold(freshUuid(), 5, 15, '2026-09-30T10:00:00.000Z');
    const afterLower = await breaches();
    expect(afterLower).toHaveLength(4);
    expect(afterLower[3]).toMatchObject({ level: 'LOW', breached: false, threshold: 5 });
  });
});
