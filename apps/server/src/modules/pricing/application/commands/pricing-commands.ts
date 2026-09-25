/**
 * Règles tarifaires et campagnes commerciales (D10-PRX ; SM-PRICE-RULE ; docs/02-domain-
 * model/04-strategie-pricing.md). Utilise le moteur partagé `@gic/domain::findConflicts`/
 * `specificityOf` pour que la détection de conflit (INV-PRX-02) suive exactement la même
 * logique que la résolution de prix (INV-PRX-04).
 *
 * SM-PRICE-RULE prévoit qu'une règle remplacée devienne `RETIRED` « à échéance (tâche
 * planifiée) » : aucune file de tâches différée pour cela n'existe en P1 (le scheduler de
 * `platform/jobs`, P0-08, n'a pas encore de type de tâche dédié) — la bascule formelle du
 * `status` vers `RETIRED` reste donc différée. Ce n'est pas un problème de correction
 * entre-temps : le moteur partagé (`@gic/domain::resolvePrice`) exige `status = ACTIVE`
 * **et** `valid_from ≤ t < valid_to` (SM-PRICE-RULE), et l'activation du remplaçant fixe déjà
 * `valid_to` de l'ancienne règle à la date d'effet du remplaçant (BR-PRX-007) : la fenêtre de
 * dates suffit à elle seule à l'exclure des candidates après l'échéance, y compris pour un
 * prix résolu au passé alors que l'ancienne règle porte encore `status = ACTIVE`.
 */
import { z } from 'zod';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { toBin, toBinOrNull, fromBin } from '../../../../platform/kysely/uuid-columns.js';
import { findProductForPricing } from '../../../catalog/application/public/index.js';
import { findConflicts, specificityOf, type PriceRule } from '@gic/domain';

function notFound(messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode: 'NOT_FOUND', messageFr };
}

function invalid(errorCode: string, messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode, messageFr };
}

const dimensionsSchema = z.object({
  productId: z.string().uuid(),
  unitPriceXaf: z.number().int().positive(),
  pricingUnitCode: z.string().min(1).max(20),
  zoneId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  customerCategoryId: z.string().uuid().optional(),
  channelCode: z.string().min(1).max(20).optional(),
  minQuantity: z.number().positive().optional(),
  commercialCampaignId: z.string().uuid().optional(),
  priority: z.number().int().optional(),
  validFrom: z.string().datetime(),
  validTo: z.string().datetime().optional(),
  notes: z.string().max(2000).optional(),
});

async function validateDimensions(
  uow: Parameters<CommandHandler>[0],
  payload: z.infer<typeof dimensionsSchema>,
): Promise<{ readonly zoneDepth: number | null } | CommandHandlerOutcome> {
  const product = await findProductForPricing(uow, payload.productId);
  if (!product) return notFound('Produit introuvable.');
  if (product.status !== 'ACTIVE') {
    return invalid('PRODUCT_INACTIVE', 'Le produit est désactivé.');
  }

  const unit = await uow
    .selectFrom('catalog_units')
    .select('code')
    .where('code', '=', payload.pricingUnitCode)
    .executeTakeFirst();
  if (!unit) return notFound("Unité de tarification introuvable.");

  let zoneDepth: number | null = null;
  if (payload.zoneId !== undefined) {
    const zone = await uow
      .selectFrom('organization_zones')
      .select('depth')
      .where('id', '=', toBin(payload.zoneId))
      .executeTakeFirst();
    if (!zone) return notFound('Zone introuvable.');
    zoneDepth = zone.depth;
  }
  if (payload.siteId !== undefined) {
    const site = await uow
      .selectFrom('organization_sites')
      .select('id')
      .where('id', '=', toBin(payload.siteId))
      .executeTakeFirst();
    if (!site) return notFound('Site introuvable.');
  }
  if (payload.customerCategoryId !== undefined) {
    const category = await uow
      .selectFrom('catalog_customer_categories')
      .select('id')
      .where('id', '=', toBin(payload.customerCategoryId))
      .executeTakeFirst();
    if (!category) return notFound('Catégorie de client introuvable.');
  }
  if (payload.channelCode !== undefined) {
    const channel = await uow
      .selectFrom('catalog_sales_channels')
      .select('code')
      .where('code', '=', payload.channelCode)
      .executeTakeFirst();
    if (!channel) return notFound('Canal de vente introuvable.');
  }
  if (payload.commercialCampaignId !== undefined) {
    const campaign = await uow
      .selectFrom('pricing_commercial_campaigns')
      .select('id')
      .where('id', '=', toBin(payload.commercialCampaignId))
      .executeTakeFirst();
    if (!campaign) return notFound('Campagne commerciale introuvable.');
  }
  return { zoneDepth };
}

function computeSpecificity(payload: z.infer<typeof dimensionsSchema>, zoneDepth: number | null): number {
  return specificityOf({
    id: '',
    productId: payload.productId,
    unitPriceXaf: payload.unitPriceXaf as never,
    pricingUnitCode: payload.pricingUnitCode,
    zoneId: payload.zoneId ?? null,
    zoneDepth,
    siteId: payload.siteId ?? null,
    customerCategoryId: payload.customerCategoryId ?? null,
    channelCode: payload.channelCode ?? null,
    minQuantity: payload.minQuantity ?? null,
    commercialCampaignId: payload.commercialCampaignId ?? null,
    priority: payload.priority ?? 0,
    validFrom: new Date(payload.validFrom),
    validTo: payload.validTo ? new Date(payload.validTo) : null,
    status: 'DRAFT',
  });
}

// ---------------------------------------------------------------------------------------
// pricing.rule.draft — nouvelle lignée (version 1).
// ---------------------------------------------------------------------------------------
const draftSchema = dimensionsSchema.extend({ code: z.string().min(1).max(40) });
type DraftPayload = z.infer<typeof draftSchema>;

const draft: CommandHandler<DraftPayload> = async (uow, envelope) => {
  const ruleId = toBin(envelope.aggregate_id);
  const already = await uow
    .selectFrom('pricing_price_rules')
    .select('id')
    .where('id', '=', ruleId)
    .executeTakeFirst();
  if (already) return { status: 'APPLIED' };

  const validated = await validateDimensions(uow, envelope.payload);
  if ('errorCode' in validated || 'status' in validated) return validated as CommandHandlerOutcome;

  const p = envelope.payload;
  await uow
    .insertInto('pricing_price_rules')
    .values({
      id: ruleId,
      code: p.code,
      version: 1,
      supersedes_rule_id: null,
      product_id: toBin(p.productId),
      unit_price_xaf: p.unitPriceXaf,
      pricing_unit_code: p.pricingUnitCode,
      zone_id: toBinOrNull(p.zoneId ?? null),
      site_id: toBinOrNull(p.siteId ?? null),
      customer_category_id: toBinOrNull(p.customerCategoryId ?? null),
      channel_code: p.channelCode ?? null,
      min_quantity: p.minQuantity !== undefined ? String(p.minQuantity) : null,
      commercial_campaign_id: toBinOrNull(p.commercialCampaignId ?? null),
      priority: p.priority ?? 0,
      specificity: computeSpecificity(p, validated.zoneDepth),
      valid_from: new Date(p.validFrom),
      valid_to: p.validTo ? new Date(p.validTo) : null,
      status: 'DRAFT',
      notes: p.notes ?? null,
      created_by: toBin(envelope.author_user_id),
    })
    .execute();
  return { status: 'APPLIED' };
};

// ---------------------------------------------------------------------------------------
// pricing.rule.supersede — nouvelle version dans la lignée d'une règle existante
// (BR-PRX-007 : le remplacement se fait par une nouvelle règle, jamais par modification).
// ---------------------------------------------------------------------------------------
const supersedeSchema = dimensionsSchema.extend({ supersedesRuleId: z.string().uuid() });
type SupersedePayload = z.infer<typeof supersedeSchema>;

const supersede: CommandHandler<SupersedePayload> = async (uow, envelope) => {
  const ruleId = toBin(envelope.aggregate_id);
  const already = await uow
    .selectFrom('pricing_price_rules')
    .select('id')
    .where('id', '=', ruleId)
    .executeTakeFirst();
  if (already) return { status: 'APPLIED' };

  const { supersedesRuleId, ...dimensions } = envelope.payload;
  const previous = await uow
    .selectFrom('pricing_price_rules')
    .select(['id', 'code', 'version', 'status'])
    .where('id', '=', toBin(supersedesRuleId))
    .executeTakeFirst();
  if (!previous) return notFound('Règle à remplacer introuvable.');
  if (previous.status !== 'ACTIVE') {
    return invalid('PRICE_RULE_NOT_ACTIVE', 'Seule une règle active peut être remplacée.');
  }

  const validated = await validateDimensions(uow, dimensions);
  if ('errorCode' in validated || 'status' in validated) return validated as CommandHandlerOutcome;

  await uow
    .insertInto('pricing_price_rules')
    .values({
      id: ruleId,
      code: previous.code,
      version: previous.version + 1,
      supersedes_rule_id: toBin(supersedesRuleId),
      product_id: toBin(dimensions.productId),
      unit_price_xaf: dimensions.unitPriceXaf,
      pricing_unit_code: dimensions.pricingUnitCode,
      zone_id: toBinOrNull(dimensions.zoneId ?? null),
      site_id: toBinOrNull(dimensions.siteId ?? null),
      customer_category_id: toBinOrNull(dimensions.customerCategoryId ?? null),
      channel_code: dimensions.channelCode ?? null,
      min_quantity: dimensions.minQuantity !== undefined ? String(dimensions.minQuantity) : null,
      commercial_campaign_id: toBinOrNull(dimensions.commercialCampaignId ?? null),
      priority: dimensions.priority ?? 0,
      specificity: computeSpecificity(dimensions, validated.zoneDepth),
      valid_from: new Date(dimensions.validFrom),
      valid_to: dimensions.validTo ? new Date(dimensions.validTo) : null,
      status: 'DRAFT',
      notes: dimensions.notes ?? null,
      created_by: toBin(envelope.author_user_id),
    })
    .execute();
  return { status: 'APPLIED' };
};

// ---------------------------------------------------------------------------------------
// pricing.rule.activate (AV-062 : Direction seule, permission pricing.rule.activate).
// ---------------------------------------------------------------------------------------
const activateSchema = z.object({});
type ActivatePayload = z.infer<typeof activateSchema>;

function toDomainRule(row: {
  id: Buffer;
  product_id: Buffer;
  unit_price_xaf: number;
  pricing_unit_code: string;
  zone_id: Buffer | null;
  site_id: Buffer | null;
  customer_category_id: Buffer | null;
  channel_code: string | null;
  min_quantity: string | null;
  commercial_campaign_id: Buffer | null;
  priority: number;
  specificity: number;
  valid_from: Date;
  valid_to: Date | null;
  status: string;
}, zoneDepthByHex: ReadonlyMap<string, number>): PriceRule {
  return {
    id: fromBin(row.id),
    productId: fromBin(row.product_id),
    unitPriceXaf: row.unit_price_xaf as never,
    pricingUnitCode: row.pricing_unit_code,
    zoneId: row.zone_id ? fromBin(row.zone_id) : null,
    zoneDepth: row.zone_id ? (zoneDepthByHex.get(row.zone_id.toString('hex')) ?? null) : null,
    siteId: row.site_id ? fromBin(row.site_id) : null,
    customerCategoryId: row.customer_category_id ? fromBin(row.customer_category_id) : null,
    channelCode: row.channel_code,
    minQuantity: row.min_quantity !== null ? Number(row.min_quantity) : null,
    commercialCampaignId: row.commercial_campaign_id ? fromBin(row.commercial_campaign_id) : null,
    priority: row.priority,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    status: row.status as PriceRule['status'],
  };
}

const activate: CommandHandler<ActivatePayload> = async (uow, envelope) => {
  const ruleId = toBin(envelope.aggregate_id);
  const rule = await uow
    .selectFrom('pricing_price_rules')
    .selectAll()
    .where('id', '=', ruleId)
    .executeTakeFirst();
  if (!rule) return notFound('Règle tarifaire introuvable.');
  if (rule.status !== 'DRAFT') {
    return invalid('PRICE_RULE_NOT_DRAFT', 'Seule une règle en brouillon peut être activée.');
  }

  const now = new Date(envelope.occurred_at);
  const NOT_RETROACTIVE_TOLERANCE_MS = 5 * 60 * 1000; // BR-PRX §8 : valid_from >= maintenant - 5 min.
  if (rule.valid_from.getTime() < now.getTime() - NOT_RETROACTIVE_TOLERANCE_MS) {
    return invalid(
      'PRICE_RULE_PERIOD_INVALID',
      "La date d'effet ne peut être rétroactive de plus de 5 minutes.",
    );
  }

  const activeSiblings = await uow
    .selectFrom('pricing_price_rules')
    .selectAll()
    .where('product_id', '=', rule.product_id)
    .where('status', '=', 'ACTIVE')
    .execute();

  const zoneIds = [rule, ...activeSiblings]
    .map((r) => r.zone_id)
    .filter((id): id is Buffer => id !== null);
  const zoneDepthByHex = new Map<string, number>();
  if (zoneIds.length > 0) {
    const zones = await uow
      .selectFrom('organization_zones')
      .select(['id', 'depth'])
      .where('id', 'in', zoneIds)
      .execute();
    for (const zone of zones) zoneDepthByHex.set(zone.id.toString('hex'), zone.depth);
  }

  const candidate = toDomainRule(rule, zoneDepthByHex);
  const conflicts = findConflicts(
    candidate,
    activeSiblings
      .filter((sibling) => !rule.supersedes_rule_id || !sibling.id.equals(rule.supersedes_rule_id))
      .map((sibling) => toDomainRule(sibling, zoneDepthByHex)),
  );
  if (conflicts.length > 0) {
    return invalid(
      'PRICE_RULE_CONFLICT',
      `Conflit avec ${conflicts.length} règle(s) active(s) du même produit (BR-PRX-006).`,
    );
  }

  await uow
    .updateTable('pricing_price_rules')
    .set({ status: 'ACTIVE', approved_by: toBin(envelope.author_user_id), approved_at: now })
    .where('id', '=', ruleId)
    .execute();

  if (rule.supersedes_rule_id) {
    // `status` reste `ACTIVE` : la fenêtre `valid_from ≤ t < valid_to` suffit déjà à
    // l'exclure des candidates dès l'échéance (SM-PRICE-RULE) ; le passage formel à
    // `RETIRED` reste la tâche planifiée différée (voir commentaire d'en-tête) — y forcer
    // `RETIRED` ici casserait la résolution d'un prix passé encore dans sa fenêtre (t < ce
    // nouveau valid_to), puisque le moteur partagé n'accepte que `status = ACTIVE`.
    await uow
      .updateTable('pricing_price_rules')
      .set({ valid_to: rule.valid_from })
      .where('id', '=', rule.supersedes_rule_id)
      .execute();
  }
  return { status: 'APPLIED' };
};

// ---------------------------------------------------------------------------------------
// pricing.rule.end — avance valid_to sur une règle active (jamais de recul, BR-PRX-007).
// ---------------------------------------------------------------------------------------
const endSchema = z.object({ validTo: z.string().datetime() });
type EndPayload = z.infer<typeof endSchema>;

const end: CommandHandler<EndPayload> = async (uow, envelope) => {
  const ruleId = toBin(envelope.aggregate_id);
  const rule = await uow
    .selectFrom('pricing_price_rules')
    .select(['id', 'status', 'valid_to'])
    .where('id', '=', ruleId)
    .executeTakeFirst();
  if (!rule) return notFound('Règle tarifaire introuvable.');
  if (rule.status !== 'ACTIVE') {
    return invalid('PRICE_RULE_NOT_ACTIVE', 'Seule une règle active peut être terminée.');
  }
  const newValidTo = new Date(envelope.payload.validTo);
  if (rule.valid_to !== null && newValidTo.getTime() >= rule.valid_to.getTime()) {
    return invalid(
      'PRICE_RULE_PERIOD_INVALID',
      'La nouvelle date de fin doit réduire la période en vigueur (BR-PRX-007).',
    );
  }
  await uow.updateTable('pricing_price_rules').set({ valid_to: newValidTo }).where('id', '=', ruleId).execute();
  return { status: 'APPLIED' };
};

// ---------------------------------------------------------------------------------------
// pricing.campaign.create — créée directement ACTIVE (aucune commande d'activation séparée
// documentée pour les campagnes en P1, à la différence des règles ; UC-PRX-05 seul).
// ---------------------------------------------------------------------------------------
const campaignCreateSchema = z.object({
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(200),
  validFrom: z.string().datetime(),
  validTo: z.string().datetime(),
});
type CampaignCreatePayload = z.infer<typeof campaignCreateSchema>;

const campaignCreate: CommandHandler<CampaignCreatePayload> = async (uow, envelope) => {
  const id = toBin(envelope.aggregate_id);
  const already = await uow
    .selectFrom('pricing_commercial_campaigns')
    .select('id')
    .where('id', '=', id)
    .executeTakeFirst();
  if (already) return { status: 'APPLIED' };
  const { code, name, validFrom, validTo } = envelope.payload;
  if (new Date(validTo).getTime() <= new Date(validFrom).getTime()) {
    return invalid('CAMPAIGN_PERIOD_INVALID', 'valid_to doit être postérieure à valid_from.');
  }
  await uow
    .insertInto('pricing_commercial_campaigns')
    .values({
      id,
      code,
      name,
      valid_from: new Date(validFrom),
      valid_to: new Date(validTo),
      status: 'ACTIVE',
      created_by: toBin(envelope.author_user_id),
    })
    .execute();
  return { status: 'APPLIED' };
};

export function registerPricingCommands(registry: CommandHandlerRegistry): void {
  registry.register({
    commandType: 'pricing.rule.draft',
    version: 1,
    payloadSchema: draftSchema,
    permissionCode: 'pricing.rule.draft',
    handler: draft,
  });
  registry.register({
    commandType: 'pricing.rule.supersede',
    version: 1,
    payloadSchema: supersedeSchema,
    permissionCode: 'pricing.rule.draft',
    handler: supersede,
  });
  registry.register({
    commandType: 'pricing.rule.activate',
    version: 1,
    payloadSchema: activateSchema,
    permissionCode: 'pricing.rule.activate',
    handler: activate,
  });
  registry.register({
    commandType: 'pricing.rule.end',
    version: 1,
    payloadSchema: endSchema,
    permissionCode: 'pricing.rule.activate',
    handler: end,
  });
  registry.register({
    commandType: 'pricing.campaign.create',
    version: 1,
    payloadSchema: campaignCreateSchema,
    permissionCode: 'pricing.campaign.manage',
    handler: campaignCreate,
  });
}
