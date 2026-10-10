/**
 * Prix catalogue sur l'appareil : même moteur que le serveur (`resolvePrice`, ADR-021), nourri par
 * les projections téléchargées. Le contexte se reconstruit comme `pricing-query.ts` côté serveur :
 * zone du site et ses ancêtres, campagnes actives à l'instant, quantité de tarification (unité de
 * base, ou poids pour un produit vendu au poids).
 *
 * La projection `PRICE_RULE` ne porte pas la profondeur de sa zone : elle se lit dans la projection
 * `ZONE` (à défaut 1, comme une zone de premier niveau ; besoin S-06 du suivi du fork).
 */
import { resolvePrice, xaf, type PriceRule } from '@gic/domain';
import type { CampaignData, PriceRuleData, ZoneData } from './types.js';

export function toPriceRules(
  rules: readonly PriceRuleData[],
  zones: ReadonlyMap<string, ZoneData>,
): PriceRule[] {
  return rules.map((rule) => ({
    id: rule.id,
    productId: rule.product_id,
    unitPriceXaf: xaf(rule.unit_price_xaf),
    pricingUnitCode: rule.pricing_unit_code,
    zoneId: rule.zone_id,
    zoneDepth: rule.zone_id ? (zones.get(rule.zone_id)?.depth ?? 1) : null,
    siteId: rule.site_id,
    customerCategoryId: rule.customer_category_id,
    channelCode: rule.channel_code,
    minQuantity: rule.min_quantity === null ? null : Number(rule.min_quantity),
    commercialCampaignId: rule.commercial_campaign_id,
    priority: rule.priority,
    validFrom: new Date(rule.valid_from),
    validTo: rule.valid_to === null ? null : new Date(rule.valid_to),
    status: rule.status as PriceRule['status'],
  }));
}

/** Zone et tous ses ancêtres ; s'arrête sur une zone inconnue de l'appareil ou un cycle. */
export function zonePathOf(
  zoneId: string | null | undefined,
  zones: ReadonlyMap<string, ZoneData>,
): string[] {
  const path: string[] = [];
  let current = zoneId ?? null;
  while (current !== null && !path.includes(current)) {
    path.push(current);
    current = zones.get(current)?.parent_id ?? null;
  }
  return path;
}

export function activeCampaignIds(campaigns: readonly CampaignData[], at: Date): string[] {
  return campaigns
    .filter(
      (campaign) =>
        campaign.status === 'ACTIVE' &&
        new Date(campaign.valid_from) <= at &&
        at < new Date(campaign.valid_to),
    )
    .map((campaign) => campaign.id);
}

/**
 * Canal de vente déduit comme le serveur (BR-VEN-021, `deduceChannel` de `sale-commands.ts`) : point
 * de vente pour un emplacement `POS`, terrain pour un stock mobile ou une session de travail ouverte,
 * sédentaire pour ce rôle, direct sinon. L'appareil l'envoie explicitement, pour tarifer la vente
 * avec le même canal que celui que le serveur retiendra.
 */
export function deduceChannel(input: {
  readonly locationType: string | null;
  readonly roles: readonly string[];
  readonly hasOpenSession: boolean;
}): string {
  if (input.locationType === 'POS') return 'POINT_DE_VENTE';
  if (input.locationType === 'MOBILE' || input.hasOpenSession) return 'TERRAIN';
  return input.roles.includes('COMMERCIAL_SEDENTAIRE') ? 'SEDENTAIRE' : 'DIRECT';
}

export interface CatalogPrice {
  readonly unitPriceXaf: number;
  readonly ruleId: string;
}

export interface QuoteInput {
  readonly productId: string;
  readonly at: Date;
  readonly siteId: string | undefined;
  readonly siteZoneId: string | undefined;
  readonly customerCategoryId: string | null | undefined;
  readonly channelCode: string;
  /** Quantité de tarification (unité de base, ou kg pour un produit au poids), décimale. */
  readonly pricingQuantity: number;
}

/** Prix catalogue, ou `null` si aucune règle ne s'applique (la saisie d'un prix devient une dérogation). */
export function quoteCatalogPrice(
  input: QuoteInput,
  rules: readonly PriceRule[],
  zones: ReadonlyMap<string, ZoneData>,
  campaigns: readonly CampaignData[],
): CatalogPrice | null {
  const result = resolvePrice(
    {
      productId: input.productId,
      at: input.at,
      ...(input.siteId ? { siteId: input.siteId } : {}),
      zonePath: zonePathOf(input.siteZoneId, zones),
      ...(input.customerCategoryId ? { customerCategoryId: input.customerCategoryId } : {}),
      channelCode: input.channelCode,
      quantity: input.pricingQuantity,
      activeCampaignIds: activeCampaignIds(campaigns, input.at),
    },
    rules,
  );
  if (!result.found) return null;
  return { unitPriceXaf: result.resolution.unitPriceXaf, ruleId: result.resolution.rule.id };
}
