/**
 * `pricing.*` (P1-04) à travers le vrai pipeline de commande. Démontre INV-PRX-01/02/03
 * (immuabilité, conflit, jamais de suppression), BR-PRX-007 (remplacement par une nouvelle
 * version), AT-006 (règle à date d'effet future appliquée automatiquement) et AT-007
 * (changement de prix ne réécrit jamais une vente déjà résolue à l'ancien prix).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixedClock, Uuidv7Generator, type Clock, type IdGenerator } from '@gic/domain';
import { CommandPipelineService } from '../src/commands/command-pipeline.service.js';
import { CommandHandlerRegistry } from '../src/platform/sync/command-handler-registry.js';
import { registerReferenceCommands } from '../src/modules/catalog/application/commands/reference-commands.js';
import { registerProductCommands } from '../src/modules/catalog/application/commands/product-commands.js';
import { registerPricingCommands } from '../src/modules/pricing/application/commands/pricing-commands.js';
import { resolvePriceForContext } from '../src/modules/pricing/application/public/index.js';
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

describe('pricing.* (P1-04)', () => {
  let pipeline: CommandPipelineService;
  let clock: Clock;
  let idGenerator: IdGenerator;
  let admin: string;
  let adminDevice: string;
  let productId: string;

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
      await grantTestPermission(trx, role, 'pricing.campaign.manage', admin);
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

  beforeAll(async () => {
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
    productId = freshUuid();
    const productResult = await pipeline.handle(
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
    expect(productResult.status).toBe('APPLIED');
  });

  it('draft puis activate — règle globale immédiatement en vigueur', async () => {
    const ruleId = freshUuid();
    const draftResult = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'pricing.rule.draft',
        aggregate_type: 'PRICE_RULE',
        aggregate_id: ruleId,
        occurred_at: OCCURRED_AT,
        payload: {
          code: `PRIX-${ruleId.slice(-8)}`,
          productId,
          unitPriceXaf: 4500,
          pricingUnitCode: 'TETE',
          validFrom: OCCURRED_AT,
        },
      }),
      ctx(),
    );
    expect(draftResult.status).toBe('APPLIED');

    const activateResult = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'pricing.rule.activate',
        aggregate_type: 'PRICE_RULE',
        aggregate_id: ruleId,
        occurred_at: OCCURRED_AT,
        payload: {},
      }),
      ctx(),
    );
    expect(activateResult.status).toBe('APPLIED');

    const resolved = await resolvePriceForContext(db, {
      productId,
      at: new Date('2026-09-26T10:00:00.000Z'),
      quantity: 2,
    });
    expect(resolved.found).toBe(true);
    if (resolved.found) expect(resolved.resolution.unitPriceXaf).toBe(4500);
  });

  it('activate — conflit avec une règle active existante (même priorité/spécificité/période) -> REJECTED PRICE_RULE_CONFLICT (BR-PRX-006)', async () => {
    const otherProductId = freshUuid();
    const categoryId = freshUuid();
    await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'catalog.product_category.create',
        aggregate_type: 'PRODUCT_CATEGORY',
        aggregate_id: categoryId,
        occurred_at: OCCURRED_AT,
        payload: { code: `CAT2-${categoryId.slice(-8)}`, name: 'Volaille 2' },
      }),
      ctx(),
    );
    await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'catalog.product.create',
        aggregate_type: 'PRODUCT',
        aggregate_id: otherProductId,
        occurred_at: OCCURRED_AT,
        payload: {
          code: `POULET2-${otherProductId.slice(-8)}`,
          name: 'Poulet de chair vif 2',
          categoryId,
          stockFamily: 'BIOLOGIQUE',
          baseUnitCode: 'TETE',
          species: 'POULET_CHAIR',
        },
      }),
      ctx(),
    );

    const rule1Id = freshUuid();
    await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'pricing.rule.draft',
        aggregate_type: 'PRICE_RULE',
        aggregate_id: rule1Id,
        occurred_at: OCCURRED_AT,
        payload: {
          code: `PRIX-A-${rule1Id.slice(-8)}`,
          productId: otherProductId,
          unitPriceXaf: 4000,
          pricingUnitCode: 'TETE',
          validFrom: OCCURRED_AT,
        },
      }),
      ctx(),
    );
    await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'pricing.rule.activate',
        aggregate_type: 'PRICE_RULE',
        aggregate_id: rule1Id,
        occurred_at: OCCURRED_AT,
        payload: {},
      }),
      ctx(),
    );

    const rule2Id = freshUuid();
    await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'pricing.rule.draft',
        aggregate_type: 'PRICE_RULE',
        aggregate_id: rule2Id,
        occurred_at: OCCURRED_AT,
        payload: {
          code: `PRIX-B-${rule2Id.slice(-8)}`,
          productId: otherProductId,
          unitPriceXaf: 4100,
          pricingUnitCode: 'TETE',
          validFrom: OCCURRED_AT,
        },
      }),
      ctx(),
    );
    const conflictResult = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'pricing.rule.activate',
        aggregate_type: 'PRICE_RULE',
        aggregate_id: rule2Id,
        occurred_at: OCCURRED_AT,
        payload: {},
      }),
      ctx(),
    );
    expect(conflictResult.status).toBe('REJECTED');
    expect(conflictResult).toMatchObject({ error: { code: 'PRICE_RULE_CONFLICT' } });
  });

  it("supersede — nouvelle version remplace l'ancienne ; le prix résolu au passé reste inchangé (AT-007)", async () => {
    const categoryId = freshUuid();
    const localProductId = freshUuid();
    await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'catalog.product_category.create',
        aggregate_type: 'PRODUCT_CATEGORY',
        aggregate_id: categoryId,
        occurred_at: OCCURRED_AT,
        payload: { code: `CAT3-${categoryId.slice(-8)}`, name: 'Volaille 3' },
      }),
      ctx(),
    );
    await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'catalog.product.create',
        aggregate_type: 'PRODUCT',
        aggregate_id: localProductId,
        occurred_at: OCCURRED_AT,
        payload: {
          code: `POULET3-${localProductId.slice(-8)}`,
          name: 'Poulet de chair vif 3',
          categoryId,
          stockFamily: 'BIOLOGIQUE',
          baseUnitCode: 'TETE',
          species: 'POULET_CHAIR',
        },
      }),
      ctx(),
    );

    // V1 activée à 09:00 (T0) ; V2 activée plus tard à 11:00 (T1), chacune avec un valid_from
    // égal à sa propre date d'activation (non rétroactif, BR-PRX §8 : ≤ 5 min d'écart).
    const t0 = '2026-09-26T09:00:00.000Z';
    const t1 = '2026-09-26T11:00:00.000Z';

    const ruleV1 = freshUuid();
    await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'pricing.rule.draft',
        aggregate_type: 'PRICE_RULE',
        aggregate_id: ruleV1,
        occurred_at: t0,
        payload: {
          code: `PRIX-V-${ruleV1.slice(-8)}`,
          productId: localProductId,
          unitPriceXaf: 4500,
          pricingUnitCode: 'TETE',
          validFrom: t0,
        },
      }),
      ctx(),
    );
    await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'pricing.rule.activate',
        aggregate_type: 'PRICE_RULE',
        aggregate_id: ruleV1,
        occurred_at: t0,
        payload: {},
      }),
      ctx(),
    );

    // Prix résolu AVANT le remplacement (entre T0 et T1) — reste 4500 pour toujours.
    const pastResolution = await resolvePriceForContext(db, {
      productId: localProductId,
      at: new Date('2026-09-26T10:00:00.000Z'),
      quantity: 1,
    });
    expect(pastResolution.found).toBe(true);
    if (pastResolution.found) expect(pastResolution.resolution.unitPriceXaf).toBe(4500);

    const ruleV2 = freshUuid();
    const supersedeResult = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'pricing.rule.supersede',
        aggregate_type: 'PRICE_RULE',
        aggregate_id: ruleV2,
        occurred_at: t1,
        payload: {
          supersedesRuleId: ruleV1,
          productId: localProductId,
          unitPriceXaf: 4800,
          pricingUnitCode: 'TETE',
          validFrom: t1,
        },
      }),
      ctx(),
    );
    expect(supersedeResult.status).toBe('APPLIED');
    const activateV2 = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'pricing.rule.activate',
        aggregate_type: 'PRICE_RULE',
        aggregate_id: ruleV2,
        occurred_at: t1,
        payload: {},
      }),
      ctx(),
    );
    expect(activateV2.status).toBe('APPLIED');

    // AT-007 : le prix résolu au passé (entre T0 et T1, avant le remplacement) reste 4500, jamais réécrit.
    const pastResolutionAfter = await resolvePriceForContext(db, {
      productId: localProductId,
      at: new Date('2026-09-26T10:00:00.000Z'),
      quantity: 1,
    });
    expect(pastResolutionAfter.found).toBe(true);
    if (pastResolutionAfter.found) expect(pastResolutionAfter.resolution.unitPriceXaf).toBe(4500);

    // Le prix courant (après T1) reflète la nouvelle règle.
    const currentResolution = await resolvePriceForContext(db, {
      productId: localProductId,
      at: new Date('2026-09-26T12:00:00.000Z'),
      quantity: 1,
    });
    expect(currentResolution.found).toBe(true);
    if (currentResolution.found) expect(currentResolution.resolution.unitPriceXaf).toBe(4800);
  });

  it("draft à date d'effet future -> résolution appliquée automatiquement à la date d'effet (AT-006)", async () => {
    const categoryId = freshUuid();
    const localProductId = freshUuid();
    await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'catalog.product_category.create',
        aggregate_type: 'PRODUCT_CATEGORY',
        aggregate_id: categoryId,
        occurred_at: OCCURRED_AT,
        payload: { code: `CAT4-${categoryId.slice(-8)}`, name: 'Volaille 4' },
      }),
      ctx(),
    );
    await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'catalog.product.create',
        aggregate_type: 'PRODUCT',
        aggregate_id: localProductId,
        occurred_at: OCCURRED_AT,
        payload: {
          code: `POULET4-${localProductId.slice(-8)}`,
          name: 'Poulet de chair vif 4',
          categoryId,
          stockFamily: 'BIOLOGIQUE',
          baseUnitCode: 'TETE',
          species: 'POULET_CHAIR',
        },
      }),
      ctx(),
    );

    const futureRuleId = freshUuid();
    await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'pricing.rule.draft',
        aggregate_type: 'PRICE_RULE',
        aggregate_id: futureRuleId,
        occurred_at: OCCURRED_AT,
        payload: {
          code: `PRIX-F-${futureRuleId.slice(-8)}`,
          productId: localProductId,
          unitPriceXaf: 5000,
          pricingUnitCode: 'TETE',
          validFrom: '2026-10-01T00:00:00.000Z', // date d'effet future
        },
      }),
      ctx(),
    );
    const activateResult = await pipeline.handle(
      buildEnvelope(admin, {
        command_type: 'pricing.rule.activate',
        aggregate_type: 'PRICE_RULE',
        aggregate_id: futureRuleId,
        occurred_at: OCCURRED_AT,
        payload: {},
      }),
      ctx(),
    );
    expect(activateResult.status).toBe('APPLIED');

    // Avant la date d'effet : aucune règle ne s'applique.
    const beforeEffect = await resolvePriceForContext(db, {
      productId: localProductId,
      at: new Date('2026-09-27T00:00:00.000Z'),
      quantity: 1,
    });
    expect(beforeEffect.found).toBe(false);

    // À la date d'effet (même hors ligne, simulé ici par un `at` futur) : appliquée automatiquement.
    const atEffect = await resolvePriceForContext(db, {
      productId: localProductId,
      at: new Date('2026-10-02T00:00:00.000Z'),
      quantity: 1,
    });
    expect(atEffect.found).toBe(true);
    if (atEffect.found) expect(atEffect.resolution.unitPriceXaf).toBe(5000);
  });
});
