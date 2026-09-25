/**
 * Référentiels catalogue simples (catégories de produit, unités, codes motifs, catégories de
 * client, canaux de vente — D16-CAT UC-CAT-03, UC-CAT-04 ; AV-017, AV-018). Chacun suit le
 * même cycle : créé, puis désactivé/réactivé (`DESACTIVATION`, jamais de suppression
 * physique, INV-GLO-03) — sauf `reason_code`, dont le dictionnaire ne prévoit qu'un `set`
 * (création ; la désactivation n'est pas un cas d'usage séparé documenté, BR-CAT-010).
 */
import { z } from 'zod';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import { toDbBool } from '../../../../platform/kysely/bool-column.js';

function notFound(messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode: 'NOT_FOUND', messageFr };
}

// ---------------------------------------------------------------------------------------
// catalog.product_category.{create,deactivate,reactivate}
// ---------------------------------------------------------------------------------------
const categoryCreateSchema = z.object({
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(200),
  parentId: z.string().uuid().optional(),
});
type CategoryCreatePayload = z.infer<typeof categoryCreateSchema>;

const categoryCreate: CommandHandler<CategoryCreatePayload> = async (uow, envelope) => {
  const id = toBin(envelope.aggregate_id);
  const already = await uow
    .selectFrom('catalog_product_categories')
    .select('id')
    .where('id', '=', id)
    .executeTakeFirst();
  if (already) return { status: 'APPLIED' };

  const { code, name, parentId } = envelope.payload;
  if (parentId !== undefined) {
    const parent = await uow
      .selectFrom('catalog_product_categories')
      .select('id')
      .where('id', '=', toBin(parentId))
      .executeTakeFirst();
    if (!parent) return notFound('Catégorie parente introuvable.');
  }
  await uow
    .insertInto('catalog_product_categories')
    .values({
      id,
      parent_id: toBinOrNull(parentId ?? null),
      code,
      name,
      created_by: toBin(envelope.author_user_id),
    })
    .execute();
  return { status: 'APPLIED' };
};

function registerProductCategorySetActive(registry: CommandHandlerRegistry): void {
  const emptySchema = z.object({});
  const deactivate: CommandHandler<Record<string, never>> = async (uow, envelope) => {
    const id = toBin(envelope.aggregate_id);
    const row = await uow
      .selectFrom('catalog_product_categories')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) return notFound('Catégorie de produit introuvable.');
    await uow
      .updateTable('catalog_product_categories')
      .set({ is_active: toDbBool(false), updated_by: toBin(envelope.author_user_id) })
      .where('id', '=', id)
      .execute();
    return { status: 'APPLIED' };
  };
  const reactivate: CommandHandler<Record<string, never>> = async (uow, envelope) => {
    const id = toBin(envelope.aggregate_id);
    const row = await uow
      .selectFrom('catalog_product_categories')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) return notFound('Catégorie de produit introuvable.');
    await uow
      .updateTable('catalog_product_categories')
      .set({ is_active: toDbBool(true), updated_by: toBin(envelope.author_user_id) })
      .where('id', '=', id)
      .execute();
    return { status: 'APPLIED' };
  };
  registry.register({
    commandType: 'catalog.product_category.deactivate',
    version: 1,
    payloadSchema: emptySchema,
    permissionCode: 'catalog.reference.manage',
    handler: deactivate,
  });
  registry.register({
    commandType: 'catalog.product_category.reactivate',
    version: 1,
    payloadSchema: emptySchema,
    permissionCode: 'catalog.reference.manage',
    handler: reactivate,
  });
}

function registerCustomerCategorySetActive(registry: CommandHandlerRegistry): void {
  const emptySchema = z.object({});
  const deactivate: CommandHandler<Record<string, never>> = async (uow, envelope) => {
    const id = toBin(envelope.aggregate_id);
    const row = await uow
      .selectFrom('catalog_customer_categories')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) return notFound('Catégorie de client introuvable.');
    await uow
      .updateTable('catalog_customer_categories')
      .set({ is_active: toDbBool(false), updated_by: toBin(envelope.author_user_id) })
      .where('id', '=', id)
      .execute();
    return { status: 'APPLIED' };
  };
  const reactivate: CommandHandler<Record<string, never>> = async (uow, envelope) => {
    const id = toBin(envelope.aggregate_id);
    const row = await uow
      .selectFrom('catalog_customer_categories')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) return notFound('Catégorie de client introuvable.');
    await uow
      .updateTable('catalog_customer_categories')
      .set({ is_active: toDbBool(true), updated_by: toBin(envelope.author_user_id) })
      .where('id', '=', id)
      .execute();
    return { status: 'APPLIED' };
  };
  registry.register({
    commandType: 'catalog.customer_category.deactivate',
    version: 1,
    payloadSchema: emptySchema,
    permissionCode: 'catalog.reference.manage',
    handler: deactivate,
  });
  registry.register({
    commandType: 'catalog.customer_category.reactivate',
    version: 1,
    payloadSchema: emptySchema,
    permissionCode: 'catalog.reference.manage',
    handler: reactivate,
  });
}

// ---------------------------------------------------------------------------------------
// catalog.unit.create (code = clé primaire, pas de aggregate_id UUID — voir dictionnaire).
// ---------------------------------------------------------------------------------------
const unitCreateSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(60),
  isCount: z.boolean(),
});
type UnitCreatePayload = z.infer<typeof unitCreateSchema>;

const unitCreate: CommandHandler<UnitCreatePayload> = async (uow, envelope) => {
  const { code, name, isCount } = envelope.payload;
  const already = await uow
    .selectFrom('catalog_units')
    .select('code')
    .where('code', '=', code)
    .executeTakeFirst();
  if (already) return { status: 'APPLIED' };
  await uow
    .insertInto('catalog_units')
    .values({ code, name, is_count: toDbBool(isCount) })
    .execute();
  return { status: 'APPLIED' };
};

function registerCodeKeyedSetActive(
  registry: CommandHandlerRegistry,
  table: 'catalog_units' | 'catalog_sales_channels',
  commandPrefix: string,
  notFoundMessageFr: string,
): void {
  const emptySchema = z.object({});
  const deactivate: CommandHandler<Record<string, never>> = async (uow, envelope) => {
    const code = envelope.aggregate_id;
    const row = await uow
      .selectFrom(table)
      .select('code')
      .where('code', '=', code)
      .executeTakeFirst();
    if (!row) return notFound(notFoundMessageFr);
    await uow
      .updateTable(table)
      .set({ is_active: toDbBool(false) })
      .where('code', '=', code)
      .execute();
    return { status: 'APPLIED' };
  };
  const reactivate: CommandHandler<Record<string, never>> = async (uow, envelope) => {
    const code = envelope.aggregate_id;
    const row = await uow
      .selectFrom(table)
      .select('code')
      .where('code', '=', code)
      .executeTakeFirst();
    if (!row) return notFound(notFoundMessageFr);
    await uow
      .updateTable(table)
      .set({ is_active: toDbBool(true) })
      .where('code', '=', code)
      .execute();
    return { status: 'APPLIED' };
  };
  registry.register({
    commandType: `${commandPrefix}.deactivate`,
    version: 1,
    payloadSchema: emptySchema,
    permissionCode: 'catalog.reference.manage',
    handler: deactivate,
  });
  registry.register({
    commandType: `${commandPrefix}.reactivate`,
    version: 1,
    payloadSchema: emptySchema,
    permissionCode: 'catalog.reference.manage',
    handler: reactivate,
  });
}

// ---------------------------------------------------------------------------------------
// catalog.reason_code.set (BR-CAT-010 : jamais supprimé, seulement désactivable — mais le
// dictionnaire ne documente qu'un `set` en écriture ; is_active reste modifiable via un
// nouvel appel `set` idempotent sur le même id, à défaut d'une commande dédiée non
// spécifiée — traité comme un trou de spécification mineur, pas comblé silencieusement :
// voir AV registre si un besoin réel de désactivation isolée apparaît.)
// ---------------------------------------------------------------------------------------
const reasonCodeCategorySchema = z.enum([
  'LOSS',
  'REJECTION',
  'INVENTORY_ADJUSTMENT',
  'CANCELLATION',
  'PRICE_OVERRIDE',
  'VISIT_OUTCOME',
  'PROSPECT_LOST',
  'CHECKIN_OVERRIDE',
  'PRODUCTION_YIELD',
  'CASH_VARIANCE',
  'TRANSFER_DISCREPANCY',
]);

const reasonCodeSetSchema = z.object({
  category: reasonCodeCategorySchema,
  code: z.string().min(1).max(40),
  label: z.string().min(1).max(200),
  lossCategory: z.string().max(30).optional(),
  requiresComment: z.boolean().optional(),
});
type ReasonCodeSetPayload = z.infer<typeof reasonCodeSetSchema>;

const reasonCodeSet: CommandHandler<ReasonCodeSetPayload> = async (uow, envelope) => {
  const id = toBin(envelope.aggregate_id);
  const already = await uow
    .selectFrom('catalog_reason_codes')
    .select('id')
    .where('id', '=', id)
    .executeTakeFirst();
  if (already) return { status: 'APPLIED' };
  const { category, code, label, lossCategory, requiresComment } = envelope.payload;
  await uow
    .insertInto('catalog_reason_codes')
    .values({
      id,
      category,
      code,
      label,
      loss_category: lossCategory ?? null,
      requires_comment: toDbBool(requiresComment ?? false),
      created_by: toBin(envelope.author_user_id),
    })
    .execute();
  return { status: 'APPLIED' };
};

// ---------------------------------------------------------------------------------------
// catalog.customer_category.create (AV-017)
// ---------------------------------------------------------------------------------------
const customerCategoryCreateSchema = z.object({
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(200),
});
type CustomerCategoryCreatePayload = z.infer<typeof customerCategoryCreateSchema>;

const customerCategoryCreate: CommandHandler<CustomerCategoryCreatePayload> = async (
  uow,
  envelope,
) => {
  const id = toBin(envelope.aggregate_id);
  const already = await uow
    .selectFrom('catalog_customer_categories')
    .select('id')
    .where('id', '=', id)
    .executeTakeFirst();
  if (already) return { status: 'APPLIED' };
  const { code, name } = envelope.payload;
  await uow
    .insertInto('catalog_customer_categories')
    .values({ id, code, name, created_by: toBin(envelope.author_user_id) })
    .execute();
  return { status: 'APPLIED' };
};

// ---------------------------------------------------------------------------------------
// catalog.sales_channel.create (AV-018)
// ---------------------------------------------------------------------------------------
const salesChannelCreateSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(60),
});
type SalesChannelCreatePayload = z.infer<typeof salesChannelCreateSchema>;

const salesChannelCreate: CommandHandler<SalesChannelCreatePayload> = async (uow, envelope) => {
  const { code, name } = envelope.payload;
  const already = await uow
    .selectFrom('catalog_sales_channels')
    .select('code')
    .where('code', '=', code)
    .executeTakeFirst();
  if (already) return { status: 'APPLIED' };
  await uow.insertInto('catalog_sales_channels').values({ code, name }).execute();
  return { status: 'APPLIED' };
};

export function registerReferenceCommands(registry: CommandHandlerRegistry): void {
  registry.register({
    commandType: 'catalog.product_category.create',
    version: 1,
    payloadSchema: categoryCreateSchema,
    permissionCode: 'catalog.reference.manage',
    handler: categoryCreate,
  });
  registerProductCategorySetActive(registry);

  registry.register({
    commandType: 'catalog.unit.create',
    version: 1,
    payloadSchema: unitCreateSchema,
    permissionCode: 'catalog.reference.manage',
    handler: unitCreate,
  });
  registerCodeKeyedSetActive(registry, 'catalog_units', 'catalog.unit', 'Unité introuvable.');

  registry.register({
    commandType: 'catalog.reason_code.set',
    version: 1,
    payloadSchema: reasonCodeSetSchema,
    permissionCode: 'catalog.reference.manage',
    handler: reasonCodeSet,
  });

  registry.register({
    commandType: 'catalog.customer_category.create',
    version: 1,
    payloadSchema: customerCategoryCreateSchema,
    permissionCode: 'catalog.reference.manage',
    handler: customerCategoryCreate,
  });
  registerCustomerCategorySetActive(registry);

  registry.register({
    commandType: 'catalog.sales_channel.create',
    version: 1,
    payloadSchema: salesChannelCreateSchema,
    permissionCode: 'catalog.reference.manage',
    handler: salesChannelCreate,
  });
  registerCodeKeyedSetActive(
    registry,
    'catalog_sales_channels',
    'catalog.sales_channel',
    'Canal de vente introuvable.',
  );
}
