/**
 * P1-06 : projections `/sync/pull` pour les entités catalog/pricing/procurement créées par
 * le pipeline de commande (`entity-projections.ts`). Démontre qu'un appareil recevrait bien
 * ces jeux de données au téléchargement, sans colonne sensible ni fuite d'une règle
 * tarifaire encore en brouillon.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerReferenceCommands } from '../src/modules/catalog/application/commands/reference-commands.js';
import { registerProductCommands } from '../src/modules/catalog/application/commands/product-commands.js';
import { registerPricingCommands } from '../src/modules/pricing/application/commands/pricing-commands.js';
import { registerSupplierCommands } from '../src/modules/procurement/application/commands/supplier-commands.js';
import { resolveEntityProjection } from '../src/sync/entity-projections.js';
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
  registerPricingCommands(registry);
  registerSupplierCommands(registry);
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

describe('projections catalog/pricing/procurement pour /sync/pull (P1-06)', () => {
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
      await grantTestPermission(trx, role, 'pricing.rule.draft', admin);
      await grantTestPermission(trx, role, 'pricing.rule.activate', admin);
      await grantTestPermission(trx, role, 'procurement.supplier.manage', admin);
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

  it('PRODUCT_CATEGORY, PRODUCT, PRICE_RULE (ACTIVE seulement) et SUPPLIER sont projetables', async () => {
    await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'catalog.unit.create',
        aggregate_type: 'UNIT',
        aggregate_id: freshUuid(),
        occurred_at: OCCURRED_AT,
        payload: { code: 'TETE', name: 'Tête', isCount: true },
      }),
      ctx(),
    );

    const categoryId = freshUuid();
    await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'catalog.product_category.create',
        aggregate_type: 'PRODUCT_CATEGORY',
        aggregate_id: categoryId,
        occurred_at: OCCURRED_AT,
        payload: { code: `CAT-${categoryId.slice(-8)}`, name: 'Volaille' },
      }),
      ctx(),
    );
    const categoryProjection = await resolveEntityProjection('PRODUCT_CATEGORY')!(db, categoryId);
    expect(categoryProjection).toMatchObject({ id: categoryId, is_active: true });

    const productId = freshUuid();
    await pipeline.handle(
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
    const productProjection = await resolveEntityProjection('PRODUCT')!(db, productId);
    expect(productProjection).toMatchObject({ id: productId, code: expect.stringContaining('POULET-') });
    // Aucune colonne interne (created_by, updated_at…) ne fuite dans la projection.
    expect(Object.keys(productProjection!).sort()).toEqual(
      [
        'id',
        'code',
        'name',
        'category_id',
        'stock_family',
        'base_unit_code',
        'lot_tracking',
        'expiry_tracking',
        'is_sellable',
        'is_purchasable',
        'is_producible',
        'is_consumable',
        'pricing_mode',
        'species',
        'status',
      ].sort(),
    );

    const draftRuleId = freshUuid();
    await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'pricing.rule.draft',
        aggregate_type: 'PRICE_RULE',
        aggregate_id: draftRuleId,
        occurred_at: OCCURRED_AT,
        payload: {
          code: `PRIX-${draftRuleId.slice(-8)}`,
          productId,
          unitPriceXaf: 4500,
          pricingUnitCode: 'TETE',
          validFrom: OCCURRED_AT,
        },
      }),
      ctx(),
    );
    // Une règle DRAFT n'est jamais projetée (ne sert à rien hors ligne).
    expect(await resolveEntityProjection('PRICE_RULE')!(db, draftRuleId)).toBeUndefined();

    await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'pricing.rule.activate',
        aggregate_type: 'PRICE_RULE',
        aggregate_id: draftRuleId,
        occurred_at: OCCURRED_AT,
        payload: {},
      }),
      ctx(),
    );
    const ruleProjection = await resolveEntityProjection('PRICE_RULE')!(db, draftRuleId);
    expect(ruleProjection).toMatchObject({ id: draftRuleId, unit_price_xaf: 4500, status: 'ACTIVE' });

    const supplierId = freshUuid();
    await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'procurement.supplier.create',
        aggregate_type: 'SUPPLIER',
        aggregate_id: supplierId,
        occurred_at: OCCURRED_AT,
        payload: { code: `FRN-${supplierId.slice(-8)}`, name: 'Provende du Littoral' },
      }),
      ctx(),
    );
    const supplierProjection = await resolveEntityProjection('SUPPLIER')!(db, supplierId);
    // Projection réduite (id, code, name) : ni téléphone ni adresse (dictionnaire §suppliers).
    expect(Object.keys(supplierProjection!).sort()).toEqual(['id', 'code', 'name'].sort());
  });
});
