/**
 * Produits (catalog.products, D16-CAT UC-CAT-01/02) et leurs conditionnements
 * (catalog.product_units, UC-CAT-03) et coûts standard (catalog.product_standard_costs,
 * BR-CAT-011, AV-042).
 *
 * BR-CAT-008 (« un produit vendable doit avoir au moins une règle tarifaire globale active
 * avant d'être activé à la vente ») n'est **pas** vérifiée ici : `catalog` ne dépend pas de
 * `pricing` (03-graphe-dependances.md — la dépendance va dans l'autre sens, pricing dépend
 * de catalog). `is_sellable` reste un drapeau de confiance côté administrateur en P1 ; la
 * vérification croisée reviendra au module qui active réellement la vente (`sales`, P4) ou à
 * un contrôle applicatif transverse si un besoin plus tôt apparaît — signalé, pas comblé
 * silencieusement (CLAUDE.md règle #2).
 */
import { z } from 'zod';
import { sql } from 'kysely';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';
import { toDbBool } from '../../../../platform/kysely/bool-column.js';

function notFound(messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode: 'NOT_FOUND', messageFr };
}

function invalid(errorCode: string, messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode, messageFr };
}

const stockFamilySchema = z.enum([
  'BIOLOGIQUE',
  'PRODUCTION_COMMERCIALISABLE',
  'INTRANT',
  'MARCHANDISE',
  'EMBALLAGE_CONSOMMABLE',
  'SERVICE',
]);
const lotTrackingSchema = z.enum(['REQUIRED', 'OPTIONAL', 'NONE']);
const pricingModeSchema = z.enum(['PER_UNIT', 'PER_WEIGHT']);
const speciesSchema = z.enum(['POULET_CHAIR', 'PONDEUSE', 'PORC']);

// ---------------------------------------------------------------------------------------
// catalog.product.create
// ---------------------------------------------------------------------------------------
const createPayloadSchema = z
  .object({
    code: z.string().min(1).max(40),
    name: z.string().min(1).max(200),
    categoryId: z.string().uuid(),
    stockFamily: stockFamilySchema,
    baseUnitCode: z.string().min(1).max(20),
    lotTracking: lotTrackingSchema.optional(),
    expiryTracking: z.boolean().optional(),
    isSellable: z.boolean().optional(),
    isPurchasable: z.boolean().optional(),
    isProducible: z.boolean().optional(),
    isConsumable: z.boolean().optional(),
    pricingMode: pricingModeSchema.optional(),
    species: speciesSchema.optional(),
  })
  .superRefine((data, ctx) => {
    // BR-CAT-005 : SERVICE => lot_tracking NONE (aussi imposé en base, CK).
    if (
      data.stockFamily === 'SERVICE' &&
      data.lotTracking !== undefined &&
      data.lotTracking !== 'NONE'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Un produit de famille SERVICE ne peut avoir de suivi par lot (BR-CAT-005).',
      });
    }
    if (data.stockFamily === 'BIOLOGIQUE' && data.species === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Un produit BIOLOGIQUE exige une espèce (species).',
      });
    }
  });
type CreatePayload = z.infer<typeof createPayloadSchema>;

const create: CommandHandler<CreatePayload> = async (uow, envelope) => {
  const productId = toBin(envelope.aggregate_id);
  const already = await uow
    .selectFrom('catalog_products')
    .select('id')
    .where('id', '=', productId)
    .executeTakeFirst();
  if (already) return { status: 'APPLIED' }; // rejeu idempotent

  const {
    code,
    name,
    categoryId,
    stockFamily,
    baseUnitCode,
    lotTracking,
    expiryTracking,
    isSellable,
    isPurchasable,
    isProducible,
    isConsumable,
    pricingMode,
    species,
  } = envelope.payload;

  const category = await uow
    .selectFrom('catalog_product_categories')
    .select('id')
    .where('id', '=', toBin(categoryId))
    .executeTakeFirst();
  if (!category) return notFound('Catégorie de produit introuvable.');

  const unit = await uow
    .selectFrom('catalog_units')
    .select('code')
    .where('code', '=', baseUnitCode)
    .executeTakeFirst();
  if (!unit) return notFound('Unité de base introuvable.');

  await uow
    .insertInto('catalog_products')
    .values({
      id: productId,
      code,
      name,
      category_id: toBin(categoryId),
      stock_family: stockFamily,
      base_unit_code: baseUnitCode,
      lot_tracking: lotTracking ?? 'NONE',
      expiry_tracking: toDbBool(expiryTracking ?? false),
      is_sellable: toDbBool(isSellable ?? false),
      is_purchasable: toDbBool(isPurchasable ?? false),
      is_producible: toDbBool(isProducible ?? false),
      is_consumable: toDbBool(isConsumable ?? false),
      pricing_mode: pricingMode ?? 'PER_UNIT',
      species: species ?? null,
      created_by: toBin(envelope.author_user_id),
    })
    .execute();
  return { status: 'APPLIED' };
};

// ---------------------------------------------------------------------------------------
// catalog.product.update — jamais `base_unit_code` (INV-CAT-01, immuable dès un mouvement ;
// en P1, sans `inventory`, immuable dès la création tout court : un nouveau produit se crée
// en cas d'erreur, D16-CAT §14).
// ---------------------------------------------------------------------------------------
const updatePayloadSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  categoryId: z.string().uuid().optional(),
  isSellable: z.boolean().optional(),
  isPurchasable: z.boolean().optional(),
  isProducible: z.boolean().optional(),
  isConsumable: z.boolean().optional(),
});
type UpdatePayload = z.infer<typeof updatePayloadSchema>;

const update: CommandHandler<UpdatePayload> = async (uow, envelope) => {
  const productId = toBin(envelope.aggregate_id);
  const product = await uow
    .selectFrom('catalog_products')
    .select('id')
    .where('id', '=', productId)
    .executeTakeFirst();
  if (!product) return notFound('Produit introuvable.');

  const { name, categoryId, isSellable, isPurchasable, isProducible, isConsumable } =
    envelope.payload;
  if (categoryId !== undefined) {
    const category = await uow
      .selectFrom('catalog_product_categories')
      .select('id')
      .where('id', '=', toBin(categoryId))
      .executeTakeFirst();
    if (!category) return notFound('Catégorie de produit introuvable.');
  }

  await uow
    .updateTable('catalog_products')
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(categoryId !== undefined ? { category_id: toBin(categoryId) } : {}),
      ...(isSellable !== undefined ? { is_sellable: toDbBool(isSellable) } : {}),
      ...(isPurchasable !== undefined ? { is_purchasable: toDbBool(isPurchasable) } : {}),
      ...(isProducible !== undefined ? { is_producible: toDbBool(isProducible) } : {}),
      ...(isConsumable !== undefined ? { is_consumable: toDbBool(isConsumable) } : {}),
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('id', '=', productId)
    .execute();
  return { status: 'APPLIED' };
};

// ---------------------------------------------------------------------------------------
// catalog.product.{deactivate,reactivate} — BR-CAT-006.
// ---------------------------------------------------------------------------------------
const emptySchema = z.object({});

function setStatus(status: 'ACTIVE' | 'INACTIVE'): CommandHandler<Record<string, never>> {
  return async (uow, envelope) => {
    const productId = toBin(envelope.aggregate_id);
    const product = await uow
      .selectFrom('catalog_products')
      .select('id')
      .where('id', '=', productId)
      .executeTakeFirst();
    if (!product) return notFound('Produit introuvable.');
    await uow
      .updateTable('catalog_products')
      .set({ status, updated_by: toBin(envelope.author_user_id), version: sql`version + 1` })
      .where('id', '=', productId)
      .execute();
    return { status: 'APPLIED' };
  };
}

// ---------------------------------------------------------------------------------------
// catalog.product_unit.set (BR-CAT-004, AV-080).
// ---------------------------------------------------------------------------------------
const productUnitSetSchema = z.object({
  productId: z.string().uuid(),
  unitCode: z.string().min(1).max(20),
  factorToBase: z.number().positive(),
  isSalesUnit: z.boolean().optional(),
  isPurchaseUnit: z.boolean().optional(),
  isCountUnit: z.boolean().optional(),
});
type ProductUnitSetPayload = z.infer<typeof productUnitSetSchema>;

const productUnitSet: CommandHandler<ProductUnitSetPayload> = async (uow, envelope) => {
  const id = toBin(envelope.aggregate_id);
  const already = await uow
    .selectFrom('catalog_product_units')
    .select('id')
    .where('id', '=', id)
    .executeTakeFirst();
  if (already) return { status: 'APPLIED' };

  const { productId, unitCode, factorToBase, isSalesUnit, isPurchaseUnit, isCountUnit } =
    envelope.payload;
  const product = await uow
    .selectFrom('catalog_products')
    .select('id')
    .where('id', '=', toBin(productId))
    .executeTakeFirst();
  if (!product) return notFound('Produit introuvable.');
  const unit = await uow
    .selectFrom('catalog_units')
    .select('code')
    .where('code', '=', unitCode)
    .executeTakeFirst();
  if (!unit) return notFound('Unité introuvable.');

  const existingForPair = await uow
    .selectFrom('catalog_product_units')
    .select('id')
    .where('product_id', '=', toBin(productId))
    .where('unit_code', '=', unitCode)
    .executeTakeFirst();
  if (existingForPair) {
    return invalid(
      'PRODUCT_UNIT_ALREADY_SET',
      'Ce conditionnement existe déjà pour ce produit ; le facteur est immuable une fois utilisé (BR-CAT-004).',
    );
  }

  await uow
    .insertInto('catalog_product_units')
    .values({
      id,
      product_id: toBin(productId),
      unit_code: unitCode,
      factor_to_base: String(factorToBase),
      is_sales_unit: toDbBool(isSalesUnit ?? false),
      is_purchase_unit: toDbBool(isPurchaseUnit ?? false),
      is_count_unit: toDbBool(isCountUnit ?? false),
      created_by: toBin(envelope.author_user_id),
    })
    .execute();
  return { status: 'APPLIED' };
};

// ---------------------------------------------------------------------------------------
// catalog.product_standard_cost.set (BR-CAT-011, AV-042) — VERSIONNEMENT pur.
// ---------------------------------------------------------------------------------------
const standardCostSetSchema = z.object({
  productId: z.string().uuid(),
  unitCostXaf: z.number().int().nonnegative(),
  reason: z.string().max(500).optional(),
});
type StandardCostSetPayload = z.infer<typeof standardCostSetSchema>;

const standardCostSet: CommandHandler<StandardCostSetPayload> = async (uow, envelope) => {
  const id = toBin(envelope.aggregate_id);
  const already = await uow
    .selectFrom('catalog_product_standard_costs')
    .select('id')
    .where('id', '=', id)
    .executeTakeFirst();
  if (already) return { status: 'APPLIED' };

  const { productId, unitCostXaf, reason } = envelope.payload;
  const product = await uow
    .selectFrom('catalog_products')
    .select('id')
    .where('id', '=', toBin(productId))
    .executeTakeFirst();
  if (!product) return notFound('Produit introuvable.');

  await uow
    .insertInto('catalog_product_standard_costs')
    .values({
      id,
      product_id: toBin(productId),
      unit_cost_xaf: unitCostXaf,
      valid_from: new Date(envelope.occurred_at),
      reason: reason ?? null,
      created_by: toBin(envelope.author_user_id),
    })
    .execute();
  return { status: 'APPLIED' };
};

export function registerProductCommands(registry: CommandHandlerRegistry): void {
  registry.register({
    commandType: 'catalog.product.create',
    version: 1,
    payloadSchema: createPayloadSchema,
    permissionCode: 'catalog.product.manage',
    handler: create,
  });
  registry.register({
    commandType: 'catalog.product.update',
    version: 1,
    payloadSchema: updatePayloadSchema,
    permissionCode: 'catalog.product.manage',
    handler: update,
  });
  registry.register({
    commandType: 'catalog.product.deactivate',
    version: 1,
    payloadSchema: emptySchema,
    permissionCode: 'catalog.product.manage',
    handler: setStatus('INACTIVE'),
  });
  registry.register({
    commandType: 'catalog.product.reactivate',
    version: 1,
    payloadSchema: emptySchema,
    permissionCode: 'catalog.product.manage',
    handler: setStatus('ACTIVE'),
  });
  registry.register({
    commandType: 'catalog.product_unit.set',
    version: 1,
    payloadSchema: productUnitSetSchema,
    permissionCode: 'catalog.product.manage',
    handler: productUnitSet,
  });
  registry.register({
    commandType: 'catalog.product_standard_cost.set',
    version: 1,
    payloadSchema: standardCostSetSchema,
    permissionCode: 'catalog.product.manage',
    handler: standardCostSet,
  });
}
