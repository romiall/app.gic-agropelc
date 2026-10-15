/**
 * `catalog.*` (P1-03) à travers le vrai pipeline de commande (même gabarit que
 * `organization-commands.test.ts`, P0-11). Démontre INV-CAT-01 (unité de base immuable),
 * BR-CAT-004 (facteur de conditionnement immuable une fois posé), BR-CAT-006
 * (désactivation/réactivation d'un produit) et BR-CAT-011 (coût standard versionné).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerReferenceCommands } from '../src/modules/catalog/application/commands/reference-commands.js';
import { registerProductCommands } from '../src/modules/catalog/application/commands/product-commands.js';
import {
  listProducts,
  listUnits,
  listReasonCodes,
} from '../src/modules/catalog/application/public/index.js';
import { toBin } from '../src/platform/kysely/uuid-columns.js';
import {
  assignTestRole,
  closeTestDb,
  db,
  freshUuid,
  grantTestPermission,
  insertTestDevice,
  insertTestRole,
  insertTestUser,
} from './helpers.js';

const OCCURRED_AT = '2026-09-26T09:00:00.000Z';

function buildRegistry(): CommandHandlerRegistry {
  const registry = new CommandHandlerRegistry();
  registerReferenceCommands(registry);
  registerProductCommands(registry);
  return registry;
}

interface EnvelopeOverrides {
  readonly command_type: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly occurred_at: string;
  readonly payload: unknown;
}

function buildEnvelope(
  authorUserId: string,
  overrides: EnvelopeOverrides,
): Record<string, unknown> {
  return {
    command_id: freshUuid(),
    device_seq: 1,
    command_version: 1,
    author_user_id: authorUserId,
    base_version: null,
    depends_on: [],
    client_created_at: overrides.occurred_at,
    captured_offline: false,
    backdated_reason: null,
    attachment_ids: [],
    ...overrides,
  };
}

describe('catalog.* (P1-03)', () => {
  let pipeline: CommandPipelineService;
  let clock: Clock;
  let idGenerator: IdGenerator;
  let admin: string;
  let adminDevice: string;

  beforeAll(async () => {
    clock = new FixedClock(new Date('2026-09-26T13:00:00.000Z'));
    idGenerator = new Uuidv7Generator(clock);
    pipeline = new CommandPipelineService(db, buildRegistry(), clock, idGenerator);

    admin = await db.transaction().execute((trx) => insertTestUser(trx));
    adminDevice = await db
      .transaction()
      .execute((trx) => insertTestDevice(trx, admin, { status: 'ACTIVE' }));

    await db.transaction().execute(async (trx) => {
      const role = await insertTestRole(trx, admin);
      await grantTestPermission(trx, role, 'catalog.reference.manage', admin);
      await grantTestPermission(trx, role, 'catalog.product.manage', admin);
      await grantTestPermission(trx, role, 'catalog.product.read', admin);
      await assignTestRole(trx, admin, role, admin);
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

  async function createUnit(code: string, isCount: boolean): Promise<void> {
    // Base partagée : une unité semée par un autre fichier sous un autre libellé serait refusée
    // (`CODE_EXISTS`, P5-23) ; elle sert telle quelle.
    const existing = await db
      .selectFrom('catalog_units')
      .select('code')
      .where('code', '=', code)
      .executeTakeFirst();
    if (existing) return;
    const result = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'catalog.unit.create',
        aggregate_type: 'UNIT',
        aggregate_id: freshUuid(), // aggregate_id reste un UUIDv7 (ADR-002) ; la clé réelle de la table est `code` (payload).
        occurred_at: OCCURRED_AT,
        payload: { code, name: code, isCount },
      }),
      ctx(),
    );
    expect(result.status).toBe('APPLIED');
  }

  async function createCategory(): Promise<string> {
    const id = freshUuid();
    const result = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'catalog.product_category.create',
        aggregate_type: 'PRODUCT_CATEGORY',
        aggregate_id: id,
        occurred_at: OCCURRED_AT,
        payload: { code: `CAT-${id.slice(-8)}`, name: 'Volaille' },
      }),
      ctx(),
    );
    expect(result.status).toBe('APPLIED');
    return id;
  }

  it('unit.create puis product.create -> listProducts/listUnits reflètent la création', async () => {
    await createUnit('TETE', true);
    const categoryId = await createCategory();

    const productId = freshUuid();
    const result = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'catalog.product.create',
        aggregate_type: 'PRODUCT',
        aggregate_id: productId,
        occurred_at: OCCURRED_AT,
        payload: {
          code: `POULET-${productId.slice(-8)}`,
          name: 'Poulet de chair vif',
          categoryId,
          stockFamily: 'BIOLOGIQUE',
          baseUnitCode: 'TETE',
          species: 'POULET_CHAIR',
          isSellable: true,
        },
      }),
      ctx(),
    );
    expect(result.status).toBe('APPLIED');

    const products = await listProducts(db, { status: 'ACTIVE' });
    expect(products.some((p) => p.id === productId)).toBe(true);
    const units = await listUnits(db);
    expect(units.some((u) => u.code === 'TETE')).toBe(true);
  });

  it('product.create — SERVICE avec lot_tracking non NONE -> REJECTED (BR-CAT-005)', async () => {
    const categoryId = await createCategory();
    const productId = freshUuid();
    const result = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'catalog.product.create',
        aggregate_type: 'PRODUCT',
        aggregate_id: productId,
        occurred_at: OCCURRED_AT,
        payload: {
          code: `SVC-${productId.slice(-8)}`,
          name: 'Service',
          categoryId,
          stockFamily: 'SERVICE',
          baseUnitCode: 'TETE',
          lotTracking: 'REQUIRED',
        },
      }),
      ctx(),
    );
    expect(result.status).toBe('REJECTED');
  });

  it('product.deactivate puis reactivate — BR-CAT-006', async () => {
    const categoryId = await createCategory();
    const productId = freshUuid();
    await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'catalog.product.create',
        aggregate_type: 'PRODUCT',
        aggregate_id: productId,
        occurred_at: OCCURRED_AT,
        payload: {
          code: `OEUF-${productId.slice(-8)}`,
          name: 'Œuf de table',
          categoryId,
          stockFamily: 'PRODUCTION_COMMERCIALISABLE',
          baseUnitCode: 'TETE',
        },
      }),
      ctx(),
    );

    const deactivated = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'catalog.product.deactivate',
        aggregate_type: 'PRODUCT',
        aggregate_id: productId,
        occurred_at: OCCURRED_AT,
        payload: {},
      }),
      ctx(),
    );
    expect(deactivated.status).toBe('APPLIED');
    let row = await db
      .selectFrom('catalog_products')
      .select('status')
      .where('id', '=', toBin(productId))
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('INACTIVE');

    const reactivated = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'catalog.product.reactivate',
        aggregate_type: 'PRODUCT',
        aggregate_id: productId,
        occurred_at: OCCURRED_AT,
        payload: {},
      }),
      ctx(),
    );
    expect(reactivated.status).toBe('APPLIED');
    row = await db
      .selectFrom('catalog_products')
      .select('status')
      .where('id', '=', toBin(productId))
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('ACTIVE');
  });

  it('product_unit.set — même (produit, unité) posé deux fois -> REJECTED PRODUCT_UNIT_ALREADY_SET (BR-CAT-004)', async () => {
    await createUnit('SAC', false);
    const categoryId = await createCategory();
    const productId = freshUuid();
    await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'catalog.product.create',
        aggregate_type: 'PRODUCT',
        aggregate_id: productId,
        occurred_at: OCCURRED_AT,
        payload: {
          code: `ALIM-${productId.slice(-8)}`,
          name: 'Aliment ponte',
          categoryId,
          stockFamily: 'INTRANT',
          baseUnitCode: 'TETE',
        },
      }),
      ctx(),
    );

    const first = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'catalog.product_unit.set',
        aggregate_type: 'PRODUCT_UNIT',
        aggregate_id: freshUuid(),
        occurred_at: OCCURRED_AT,
        payload: { productId, unitCode: 'SAC', factorToBase: 50, isPurchaseUnit: true },
      }),
      ctx(),
    );
    expect(first.status).toBe('APPLIED');

    const second = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'catalog.product_unit.set',
        aggregate_type: 'PRODUCT_UNIT',
        aggregate_id: freshUuid(),
        occurred_at: OCCURRED_AT,
        payload: { productId, unitCode: 'SAC', factorToBase: 25 },
      }),
      ctx(),
    );
    expect(second.status).toBe('REJECTED');
    expect(second).toMatchObject({ error: { code: 'PRODUCT_UNIT_ALREADY_SET' } });
  });

  it('product_standard_cost.set — deux versions successives, jamais modifiées (BR-CAT-011)', async () => {
    const categoryId = await createCategory();
    const productId = freshUuid();
    await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'catalog.product.create',
        aggregate_type: 'PRODUCT',
        aggregate_id: productId,
        occurred_at: OCCURRED_AT,
        payload: {
          code: `POUSSIN-${productId.slice(-8)}`,
          name: 'Poussin 1 jour',
          categoryId,
          stockFamily: 'BIOLOGIQUE',
          baseUnitCode: 'TETE',
          species: 'POULET_CHAIR',
        },
      }),
      ctx(),
    );

    const v1 = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'catalog.product_standard_cost.set',
        aggregate_type: 'PRODUCT_STANDARD_COST',
        aggregate_id: freshUuid(),
        occurred_at: OCCURRED_AT,
        payload: { productId, unitCostXaf: 450 },
      }),
      ctx(),
    );
    expect(v1.status).toBe('APPLIED');

    const v2 = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'catalog.product_standard_cost.set',
        aggregate_type: 'PRODUCT_STANDARD_COST',
        aggregate_id: freshUuid(),
        occurred_at: '2026-09-26T12:00:00.000Z',
        payload: { productId, unitCostXaf: 470, reason: 'Hausse aliment' },
      }),
      ctx(),
    );
    expect(v2.status).toBe('APPLIED');

    const versions = await db
      .selectFrom('catalog_product_standard_costs')
      .select(['unit_cost_xaf'])
      .where('product_id', '=', toBin(productId))
      .orderBy('valid_from', 'asc')
      .execute();
    expect(versions.map((v) => v.unit_cost_xaf)).toEqual([450, 470]);
  });

  it('reason_code.set — motif LOSS créé, consultable via listReasonCodes', async () => {
    const code = `CASSE_TRANSPORT_${freshUuid().slice(-8)}`;
    const result = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'catalog.reason_code.set',
        aggregate_type: 'REASON_CODE',
        aggregate_id: freshUuid(),
        occurred_at: OCCURRED_AT,
        payload: { category: 'LOSS', code, label: 'Casse au transport' },
      }),
      ctx(),
    );
    expect(result.status).toBe('APPLIED');
    const reasonCodes = await listReasonCodes(db, { category: 'LOSS' });
    expect(reasonCodes.some((r) => r.code === code)).toBe(true);
  });

  it('reason_code.update, deactivate, reactivate — libellé ajustable, désactivable, jamais supprimé (MP-11, AV-248, BR-CAT-010)', async () => {
    const id = freshUuid();
    const code = `AUTRE_${id.slice(-8)}`;
    const run = (commandType: string, payload: Record<string, unknown>) =>
      pipeline.handle(
        buildEnvelope(admin, {
          command_type: commandType,
          aggregate_type: 'REASON_CODE',
          aggregate_id: id,
          occurred_at: OCCURRED_AT,
          payload,
        }),
        ctx(),
      );
    const row = () =>
      db
        .selectFrom('catalog_reason_codes')
        .select(['code', 'category', 'label', 'requires_comment', 'is_active', 'version'])
        .where('id', '=', toBin(id))
        .executeTakeFirstOrThrow();
    const feed = () =>
      db
        .selectFrom('sync_change_feed')
        .select(['dataset', 'row_version'])
        .where('entity_type', '=', 'REASON_CODE')
        .where('entity_id', '=', toBin(id))
        .where('dataset', '=', 'catalog')
        .orderBy('seq')
        .execute();
    expect(
      (await run('catalog.reason_code.set', { category: 'VISIT_OUTCOME', code, label: 'Autre' }))
        .status,
    ).toBe('APPLIED');

    expect(
      (
        await run('catalog.reason_code.update', {
          label: 'Autre (préciser)',
          requiresComment: true,
        })
      ).status,
    ).toBe('APPLIED');
    expect(await row()).toMatchObject({
      code,
      category: 'VISIT_OUTCOME',
      label: 'Autre (préciser)',
      requires_comment: 1,
      is_active: 1,
      version: 2,
    });
    // Sans effet : acceptée, sans nouvelle version.
    expect((await run('catalog.reason_code.update', { requiresComment: true })).status).toBe(
      'APPLIED',
    );
    expect((await row()).version).toBe(2);
    const empty = await run('catalog.reason_code.update', {});
    expect(empty.status === 'REJECTED' && empty.error.code).toMatch(/^VALIDATION_ERROR/);

    expect((await run('catalog.reason_code.deactivate', {})).status).toBe('APPLIED');
    expect(await row()).toMatchObject({ is_active: 0, version: 3 });
    expect((await run('catalog.reason_code.deactivate', {})).status).toBe('APPLIED');
    expect((await row()).version).toBe(3);
    expect(
      (await listReasonCodes(db, { category: 'VISIT_OUTCOME' })).find((r) => r.code === code),
    ).toMatchObject({ isActive: false });
    expect((await run('catalog.reason_code.reactivate', {})).status).toBe('APPLIED');
    expect(await row()).toMatchObject({ is_active: 1, version: 4 });
    // Chaque nouvelle version est publiée aux appareils (jeu `catalog`).
    expect((await feed()).map((entry) => `${entry.dataset}:${entry.row_version}`)).toEqual([
      'catalog:1',
      'catalog:2',
      'catalog:3',
      'catalog:4',
    ]);

    const unknown = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'catalog.reason_code.deactivate',
        aggregate_type: 'REASON_CODE',
        aggregate_id: freshUuid(),
        occurred_at: OCCURRED_AT,
        payload: {},
      }),
      ctx(),
    );
    expect(unknown.status === 'REJECTED' && unknown.error.code).toBe('NOT_FOUND');
  });
});
