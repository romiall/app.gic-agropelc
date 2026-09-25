/**
 * Lectures de `pricing` : grille tarifaire, campagnes, et résolution de prix (D10-PRX §12 ;
 * phase P1 : `/price-rules`, `/campaigns`, `/prices/resolve`). `resolvePriceForContext`
 * assemble le contexte réel (chemin de zone via la fermeture transitive, campagnes actives à
 * `at`) puis délègue entièrement au moteur partagé `@gic/domain::resolvePrice` — jamais de
 * logique de départage réimplémentée ici (INV-PRX-04).
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { resolvePrice, type PriceContext, type PriceRule, type ResolvePriceResult } from '@gic/domain';

export interface PriceRuleView {
  readonly id: string;
  readonly code: string;
  readonly version: number;
  readonly productId: string;
  readonly unitPriceXaf: number;
  readonly pricingUnitCode: string;
  readonly zoneId: string | null;
  readonly siteId: string | null;
  readonly customerCategoryId: string | null;
  readonly channelCode: string | null;
  readonly minQuantity: number | null;
  readonly commercialCampaignId: string | null;
  readonly priority: number;
  readonly specificity: number;
  readonly validFrom: Date;
  readonly validTo: Date | null;
  readonly status: string;
}

function toView(row: {
  id: Buffer;
  code: string;
  version: number;
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
}): PriceRuleView {
  return {
    id: fromBin(row.id),
    code: row.code,
    version: row.version,
    productId: fromBin(row.product_id),
    unitPriceXaf: row.unit_price_xaf,
    pricingUnitCode: row.pricing_unit_code,
    zoneId: fromBinOrNull(row.zone_id),
    siteId: fromBinOrNull(row.site_id),
    customerCategoryId: fromBinOrNull(row.customer_category_id),
    channelCode: row.channel_code,
    minQuantity: row.min_quantity !== null ? Number(row.min_quantity) : null,
    commercialCampaignId: fromBinOrNull(row.commercial_campaign_id),
    priority: row.priority,
    specificity: row.specificity,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    status: row.status,
  };
}

export async function listPriceRules(
  executor: Kysely<DB> | Transaction<DB>,
  filter: { readonly productId?: string; readonly status?: string } = {},
): Promise<readonly PriceRuleView[]> {
  const rows = await executor
    .selectFrom('pricing_price_rules')
    .selectAll()
    .$if(filter.productId !== undefined, (qb) => qb.where('product_id', '=', toBin(filter.productId!)))
    .$if(filter.status !== undefined, (qb) => qb.where('status', '=', filter.status!))
    .orderBy('code', 'asc')
    .orderBy('version', 'asc')
    .execute();
  return rows.map(toView);
}

export interface CampaignView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly validFrom: Date;
  readonly validTo: Date;
  readonly status: string;
}

export async function listCampaigns(
  executor: Kysely<DB> | Transaction<DB>,
): Promise<readonly CampaignView[]> {
  const rows = await executor
    .selectFrom('pricing_commercial_campaigns')
    .selectAll()
    .orderBy('valid_from', 'desc')
    .execute();
  return rows.map((row) => ({
    id: fromBin(row.id),
    code: row.code,
    name: row.name,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    status: row.status,
  }));
}

export interface ResolvePriceContext {
  readonly productId: string;
  readonly at: Date;
  readonly siteId?: string;
  readonly zoneId?: string;
  readonly customerCategoryId?: string;
  readonly channelCode?: string;
  readonly quantity: number;
}

/** Chemin de zone (elle-même + ancêtres) via la fermeture transitive `organization_zone_ancestors`. */
async function zonePathOf(
  executor: Kysely<DB> | Transaction<DB>,
  zoneId: string | undefined,
): Promise<readonly string[]> {
  if (zoneId === undefined) return [];
  const rows = await executor
    .selectFrom('organization_zone_ancestors')
    .select('ancestor_id')
    .where('zone_id', '=', toBin(zoneId))
    .execute();
  return rows.map((row) => fromBin(row.ancestor_id));
}

async function activeCampaignIdsAt(
  executor: Kysely<DB> | Transaction<DB>,
  at: Date,
): Promise<readonly string[]> {
  const rows = await executor
    .selectFrom('pricing_commercial_campaigns')
    .select('id')
    .where('status', '=', 'ACTIVE')
    .where('valid_from', '<=', at)
    .where('valid_to', '>', at)
    .execute();
  return rows.map((row) => fromBin(row.id));
}

export async function resolvePriceForContext(
  executor: Kysely<DB> | Transaction<DB>,
  ctx: ResolvePriceContext,
): Promise<ResolvePriceResult> {
  const [zonePath, activeCampaignIds, ruleRows] = await Promise.all([
    zonePathOf(executor, ctx.zoneId),
    activeCampaignIdsAt(executor, ctx.at),
    executor
      .selectFrom('pricing_price_rules')
      .selectAll()
      .where('product_id', '=', toBin(ctx.productId))
      .where('status', '=', 'ACTIVE')
      .execute(),
  ]);

  const zoneDepthByHex = new Map<string, number>();
  const zoneIds = ruleRows.map((r) => r.zone_id).filter((id): id is Buffer => id !== null);
  if (zoneIds.length > 0) {
    const zones = await executor
      .selectFrom('organization_zones')
      .select(['id', 'depth'])
      .where('id', 'in', zoneIds)
      .execute();
    for (const zone of zones) zoneDepthByHex.set(zone.id.toString('hex'), zone.depth);
  }

  const rules: PriceRule[] = ruleRows.map((row) => ({
    id: fromBin(row.id),
    productId: fromBin(row.product_id),
    unitPriceXaf: row.unit_price_xaf as never,
    pricingUnitCode: row.pricing_unit_code,
    zoneId: fromBinOrNull(row.zone_id),
    zoneDepth: row.zone_id ? (zoneDepthByHex.get(row.zone_id.toString('hex')) ?? null) : null,
    siteId: fromBinOrNull(row.site_id),
    customerCategoryId: fromBinOrNull(row.customer_category_id),
    channelCode: row.channel_code,
    minQuantity: row.min_quantity !== null ? Number(row.min_quantity) : null,
    commercialCampaignId: fromBinOrNull(row.commercial_campaign_id),
    priority: row.priority,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    status: row.status as PriceRule['status'],
  }));

  const context: PriceContext = {
    productId: ctx.productId,
    at: ctx.at,
    quantity: ctx.quantity,
    zonePath, // inclut déjà la zone elle-même (depth 0, organization_zone_ancestors).
    activeCampaignIds,
    ...(ctx.siteId !== undefined ? { siteId: ctx.siteId } : {}),
    ...(ctx.customerCategoryId !== undefined ? { customerCategoryId: ctx.customerCategoryId } : {}),
    ...(ctx.channelCode !== undefined ? { channelCode: ctx.channelCode } : {}),
  };
  return resolvePrice(context, rules);
}
