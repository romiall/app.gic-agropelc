/**
 * Référentiels catalogue simples (catégories de produit, unités, codes motifs, catégories de
 * client, canaux de vente — D16-CAT UC-CAT-03, UC-CAT-04 ; AV-017, AV-018). Chacun suit le
 * même cycle : créé, puis désactivé/réactivé (`DESACTIVATION`, jamais de suppression
 * physique, INV-GLO-03) — sauf `reason_code`, dont le dictionnaire ne prévoit qu'un `set`
 * (création ; la désactivation n'est pas un cas d'usage séparé documenté, BR-CAT-010).
 *
 * P5-18 (AV-196) : unités, canaux et motifs sont publiés dans le jeu `catalog` (`sync-changes.ts`) ;
 * la désactivation et la réactivation d'une unité ou d'un canal lisent le code dans la charge utile
 * (`code`) — l'`aggregate_id` est un UUIDv7 imposé par le contrat et ne vaut jamais un code.
 *
 * P5-23 (S-31) : un code déjà pris est refusé (`CODE_EXISTS`) au lieu de lever la violation d'unicité
 * (renvoi sans fin) ; une unité ou un canal recréé sous un code existant n'est accepté que s'il est
 * identique (sinon la commande répondait `APPLIED` sans rien changer).
 */
import { z } from 'zod';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import { toDbBool } from '../../../../platform/kysely/bool-column.js';
import { recordChanges } from '../../../../platform/sync/change-feed.js';
import { SYSTEM_SALES_CHANNEL_CODES } from '../public/catalog-query.js';
import {
  codeKeyedReferenceChange,
  reasonCodeChange,
  type CodeKeyedReference,
} from '../sync-changes.js';

function notFound(messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode: 'NOT_FOUND', messageFr };
}

function codeExists(messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode: 'CODE_EXISTS', messageFr };
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
  const codeTaken = await uow
    .selectFrom('catalog_product_categories')
    .select('id')
    .where('code', '=', code)
    .executeTakeFirst();
  if (codeTaken) return codeExists('Une catégorie de produit porte déjà ce code.');
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
    .select(['code', 'name', 'is_count'])
    .where('code', '=', code)
    .executeTakeFirst();
  if (already) {
    // Même unité (rejeu d'une création) : sans effet ; une autre sous ce code : refusée.
    return already.name === name && Boolean(already.is_count) === isCount
      ? { status: 'APPLIED' }
      : codeExists('Une unité porte déjà ce code.');
  }
  await uow
    .insertInto('catalog_units')
    .values({ code, name, is_count: toDbBool(isCount) })
    .execute();
  await recordChanges(uow, [codeKeyedReferenceChange('UNIT', code)]);
  return { status: 'APPLIED' };
};

function registerCodeKeyedSetActive(
  registry: CommandHandlerRegistry,
  table: 'catalog_units' | 'catalog_sales_channels',
  entityType: CodeKeyedReference,
  commandPrefix: string,
  notFoundMessageFr: string,
  systemCodes: readonly string[] = [],
): void {
  // Le code est dans la charge utile (P5-18) : l'agrégat est un UUIDv7 du contrat, jamais un code.
  const codeSchema = z.object({ code: z.string().min(1).max(20) });
  const setActive =
    (active: boolean): CommandHandler<{ code: string }> =>
    async (uow, envelope) => {
      const { code } = envelope.payload;
      // Valeur utilisée par les règles du serveur : jamais désactivée (dictionnaire, `is_system`).
      if (!active && systemCodes.includes(code)) {
        return {
          status: 'REJECTED',
          errorCode: 'SYSTEM_REFERENCE',
          messageFr: 'Valeur système : elle ne peut pas être désactivée.',
        };
      }
      const row = await uow
        .selectFrom(table)
        .select('code')
        .where('code', '=', code)
        .executeTakeFirst();
      if (!row) return notFound(notFoundMessageFr);
      await uow
        .updateTable(table)
        .set({ is_active: toDbBool(active) })
        .where('code', '=', code)
        .execute();
      await recordChanges(uow, [codeKeyedReferenceChange(entityType, code)]);
      return { status: 'APPLIED' };
    };
  registry.register({
    commandType: `${commandPrefix}.deactivate`,
    version: 1,
    payloadSchema: codeSchema,
    permissionCode: 'catalog.reference.manage',
    handler: setActive(false),
  });
  registry.register({
    commandType: `${commandPrefix}.reactivate`,
    version: 1,
    payloadSchema: codeSchema,
    permissionCode: 'catalog.reference.manage',
    handler: setActive(true),
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
  const codeTaken = await uow
    .selectFrom('catalog_reason_codes')
    .select('id')
    .where('category', '=', category)
    .where('code', '=', code)
    .executeTakeFirst();
  if (codeTaken) return codeExists('Un motif de cette catégorie porte déjà ce code.');
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
  await recordChanges(uow, [reasonCodeChange(envelope.aggregate_id, 1)]);
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
  const codeTaken = await uow
    .selectFrom('catalog_customer_categories')
    .select('id')
    .where('code', '=', code)
    .executeTakeFirst();
  if (codeTaken) return codeExists('Une catégorie de client porte déjà ce code.');
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
    .select(['code', 'name'])
    .where('code', '=', code)
    .executeTakeFirst();
  if (already) {
    return already.name === name
      ? { status: 'APPLIED' }
      : codeExists('Un canal de vente porte déjà ce code.');
  }
  await uow.insertInto('catalog_sales_channels').values({ code, name }).execute();
  await recordChanges(uow, [codeKeyedReferenceChange('SALES_CHANNEL', code)]);
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
  registerCodeKeyedSetActive(
    registry,
    'catalog_units',
    'UNIT',
    'catalog.unit',
    'Unité introuvable.',
  );

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
    'SALES_CHANNEL',
    'catalog.sales_channel',
    'Canal de vente introuvable.',
    SYSTEM_SALES_CHANNEL_CODES,
  );
}
