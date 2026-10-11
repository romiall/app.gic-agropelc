/**
 * Portée d'une règle de prix en clair (site, zone, catégorie, canal, seuil, campagne, priorité),
 * pour le simulateur (ECR-PRX-03) et la gestion des règles (ECR-PRX-02).
 */
import type { TFunction } from 'i18next';
import { formatQuantity } from '../sales/format.js';
import type { SalesReferences } from '../sales/references.js';

export interface ScopedRule {
  readonly siteId: string | null;
  readonly zoneId: string | null;
  readonly customerCategoryId: string | null;
  readonly channelCode: string | null;
  readonly minQuantity: number | null;
  readonly commercialCampaignId: string | null;
  readonly priority: number;
}

export function describeScope(
  rule: ScopedRule,
  refs: Pick<SalesReferences, 'sites' | 'zones' | 'customerCategories'>,
  unit: string,
  t: TFunction,
): string {
  const dimensions = [
    rule.siteId
      ? t('price_sim.scope.site', { name: refs.sites.get(rule.siteId)?.name ?? '' })
      : null,
    rule.zoneId
      ? t('price_sim.scope.zone', { name: refs.zones.get(rule.zoneId)?.name ?? '' })
      : null,
    rule.customerCategoryId
      ? t('price_sim.scope.category', {
          name:
            refs.customerCategories.find((category) => category.id === rule.customerCategoryId)
              ?.name ?? '',
        })
      : null,
    rule.channelCode
      ? t('price_sim.scope.channel', {
          name: t(`price_sim.channel.${rule.channelCode}`, { defaultValue: rule.channelCode }),
        })
      : null,
    rule.minQuantity !== null
      ? t('price_sim.scope.min_quantity', { quantity: formatQuantity(rule.minQuantity), unit })
      : null,
    rule.commercialCampaignId ? t('price_sim.scope.campaign') : null,
  ].filter(Boolean);
  // « Règle générale » dès qu'aucune dimension ne la restreint, priorité éventuelle en plus.
  return [
    dimensions.length > 0 ? dimensions.join(' · ') : t('price_sim.scope.general'),
    rule.priority !== 0 ? t('price_sim.scope.priority', { priority: rule.priority }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
