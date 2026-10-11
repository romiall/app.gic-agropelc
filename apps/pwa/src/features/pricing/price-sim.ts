/**
 * ECR-PRX-03 « Simulateur de prix » (« quel prix pour ce contexte ? », D10) : logique pure. Le même
 * moteur que la vente (`resolvePrice`, ADR-021) sur les règles détenues par l'appareil ; la règle
 * retenue est suivie des autres règles applicables, dans l'ordre du départage, pour expliquer le
 * résultat. Partiel hors ligne : une règle retirée n'est pas toujours retirée de l'appareil (S-08).
 */
import {
  businessDayOf,
  DomainError,
  lineAmountXaf,
  quantityFromDecimal,
  resolvePrice,
  xaf,
  type PriceRule,
} from '@gic/domain';
import { activeCampaignIds, zonePathOf } from '../sales/pricing.js';
import { MAX_QUANTITY } from '../sales/sale-form.js';
import type { CampaignData, ZoneData } from '../sales/types.js';

/** Canaux de vente connus (non servis à l'appareil, S-07). */
export const SIM_CHANNELS = ['POINT_DE_VENTE', 'TERRAIN', 'SEDENTAIRE', 'DIRECT'] as const;
export const MAX_EXPLAINED_RULES = 5;

export interface SimContext {
  readonly productId: string;
  readonly at: Date;
  readonly siteId: string;
  readonly zoneId: string;
  readonly customerCategoryId: string;
  readonly channelCode: string;
  readonly quantity: number;
}

/** Règles applicables au contexte, la retenue en tête puis les suivantes dans l'ordre du départage. */
export function applicableRules(
  context: SimContext,
  rules: readonly PriceRule[],
  zones: ReadonlyMap<string, ZoneData>,
  campaigns: readonly CampaignData[],
  limit = MAX_EXPLAINED_RULES,
): PriceRule[] {
  const ctx = {
    productId: context.productId,
    at: context.at,
    ...(context.siteId ? { siteId: context.siteId } : {}),
    zonePath: zonePathOf(context.zoneId || null, zones),
    ...(context.customerCategoryId ? { customerCategoryId: context.customerCategoryId } : {}),
    ...(context.channelCode ? { channelCode: context.channelCode } : {}),
    quantity: context.quantity,
    activeCampaignIds: activeCampaignIds(campaigns, context.at),
  };
  const ordered: PriceRule[] = [];
  let remaining = rules.filter((rule) => rule.productId === context.productId);
  while (ordered.length < limit) {
    const result = resolvePrice(ctx, remaining);
    if (!result.found) break;
    ordered.push(result.resolution.rule);
    const winnerId = result.resolution.rule.id;
    remaining = remaining.filter((rule) => rule.id !== winnerId);
  }
  return ordered;
}

/** Quantité de tarification saisie (> 0, 3 décimales au plus, bornée) ; `null` si invalide. */
export function parseSimQuantity(text: string): number | null {
  const normalized = text.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,3})?$/.test(normalized)) return null;
  const value = Number(normalized);
  return value > 0 && value <= MAX_QUANTITY ? value : null;
}

/** Montant de la ligne simulée (même calcul que la vente) ; `null` s'il dépasse ce que gère le domaine. */
export function simTotal(quantity: number, unitPriceXaf: number): number | null {
  try {
    return lineAmountXaf(quantityFromDecimal(quantity), xaf(unitPriceXaf));
  } catch (error) {
    if (error instanceof DomainError) return null;
    throw error;
  }
}

/**
 * Instant simulé : maintenant pour le jour courant (le prix que la vente appliquerait à l'instant,
 * une règle prenant effet en cours de journée comprise), midi à Douala pour un autre jour.
 */
export function simInstant(
  day: string,
  now: Date,
): { readonly at: Date; readonly now: boolean } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  if (day === businessDayOf(now)) return { at: now, now: true };
  const at = new Date(`${day}T12:00:00+01:00`);
  return Number.isNaN(at.getTime()) ? null : { at, now: false };
}
