/**
 * Moteur de résolution de prix (D10-PRX ; docs/02-domain-model/04-strategie-pricing.md),
 * partagé appareil et serveur (BR-PRX-013, ADR-021) : garantit INV-PRX-04 (même contexte,
 * même jeu de règles ⇒ même résultat) par construction, une seule implémentation.
 *
 * Pur, sans entrée-sortie : aucune lecture de base ni d'horloge système ; l'appelant
 * fournit le contexte résolu (`at`, chemin de zone déjà remonté jusqu'à la racine,
 * campagnes actives) et l'ensemble des règles candidates à filtrer.
 */
import type { Xaf } from './money.js';

export type PriceRuleStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED' | 'CANCELLED';

/** Règle tarifaire telle que stockée (pricing.price_rules, dictionnaire §pricing). */
export interface PriceRule {
  readonly id: string;
  readonly productId: string;
  readonly unitPriceXaf: Xaf;
  readonly pricingUnitCode: string;
  readonly zoneId: string | null;
  /** Profondeur de `zoneId` dans la hiérarchie (1 à 4, BR-PRX-005) ; ignorée si `zoneId` est nul. */
  readonly zoneDepth: number | null;
  readonly siteId: string | null;
  readonly customerCategoryId: string | null;
  readonly channelCode: string | null;
  readonly minQuantity: number | null;
  readonly commercialCampaignId: string | null;
  readonly priority: number;
  readonly validFrom: Date;
  readonly validTo: Date | null;
  readonly status: PriceRuleStatus;
}

/** Contexte de résolution (§3 de la stratégie pricing). */
export interface PriceContext {
  readonly productId: string;
  readonly at: Date;
  readonly siteId?: string;
  /** Zone du contexte et tous ses ancêtres (identifiants), dans n'importe quel ordre. */
  readonly zonePath?: readonly string[];
  readonly customerCategoryId?: string;
  readonly channelCode?: string;
  readonly quantity: number;
  readonly activeCampaignIds?: readonly string[];
}

export interface ResolvedPrice {
  readonly rule: PriceRule;
  readonly unitPriceXaf: Xaf;
  readonly specificity: number;
}

export type ResolvePriceResult =
  | { readonly found: true; readonly resolution: ResolvedPrice }
  | { readonly found: false };

/** BR-PRX-005 : Σ des poids des dimensions renseignées. */
export function specificityOf(rule: PriceRule): number {
  let specificity = 0;
  if (rule.siteId !== null) specificity += 32;
  if (rule.customerCategoryId !== null) specificity += 16;
  if (rule.zoneId !== null) specificity += 3 * (rule.zoneDepth ?? 1);
  if (rule.channelCode !== null) specificity += 2;
  if (rule.minQuantity !== null) specificity += 1;
  return specificity;
}

function isCandidate(rule: PriceRule, ctx: PriceContext): boolean {
  if (rule.productId !== ctx.productId) return false;
  if (rule.status !== 'ACTIVE') return false;
  if (rule.validFrom > ctx.at) return false;
  if (rule.validTo !== null && rule.validTo <= ctx.at) return false;
  if (rule.siteId !== null && rule.siteId !== ctx.siteId) return false;
  if (rule.zoneId !== null && !(ctx.zonePath ?? []).includes(rule.zoneId)) return false;
  if (rule.customerCategoryId !== null && rule.customerCategoryId !== ctx.customerCategoryId) {
    return false;
  }
  if (rule.channelCode !== null && rule.channelCode !== ctx.channelCode) return false;
  if (rule.minQuantity !== null && rule.minQuantity > ctx.quantity) return false;
  if (
    rule.commercialCampaignId !== null &&
    !(ctx.activeCampaignIds ?? []).includes(rule.commercialCampaignId)
  ) {
    return false;
  }
  return true;
}

/** BR-PRX-004 : départage déterministe entre candidates. */
function compareCandidates(a: PriceRule, b: PriceRule): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const specificityDiff = specificityOf(b) - specificityOf(a);
  if (specificityDiff !== 0) return specificityDiff;
  const minQtyDiff = (b.minQuantity ?? 0) - (a.minQuantity ?? 0);
  if (minQtyDiff !== 0) return minQtyDiff;
  const validFromDiff = b.validFrom.getTime() - a.validFrom.getTime();
  if (validFromDiff !== 0) return validFromDiff;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0; // id le plus grand gagne (UUIDv7 ⇒ le plus récent)
}

/** §3 de la stratégie pricing : filtre puis départage. `PRICE_NOT_FOUND` si aucune candidate. */
export function resolvePrice(
  ctx: PriceContext,
  rules: readonly PriceRule[],
): ResolvePriceResult {
  const candidates = rules.filter((rule) => isCandidate(rule, ctx));
  if (candidates.length === 0) return { found: false };
  const [winner] = [...candidates].sort(compareCandidates);
  const rule = winner!;
  return {
    found: true,
    resolution: { rule, unitPriceXaf: rule.unitPriceXaf, specificity: specificityOf(rule) },
  };
}

/**
 * BR-PRX-006 / §4 de la stratégie pricing : conflit entre une règle candidate à
 * l'activation et les règles déjà `ACTIVE` du même produit. Toutes les conditions sont
 * requises simultanément : même priorité, même spécificité, périodes qui se chevauchent,
 * chaque dimension égale ou au moins une des deux nulle, **et** même `min_quantity` (exact,
 * pas de règle « ou nul » pour ce champ précis, à la différence des autres dimensions).
 */
export function findConflicts(
  candidate: Pick<
    PriceRule,
    | 'productId'
    | 'priority'
    | 'validFrom'
    | 'validTo'
    | 'zoneId'
    | 'zoneDepth'
    | 'siteId'
    | 'customerCategoryId'
    | 'channelCode'
    | 'minQuantity'
    | 'commercialCampaignId'
  >,
  activeRules: readonly PriceRule[],
): readonly PriceRule[] {
  const candidateSpecificity = specificityOf(candidate as PriceRule);
  const candidateEnd = candidate.validTo ?? null;
  return activeRules.filter((other) => {
    if (other.productId !== candidate.productId) return false;
    if (other.priority !== candidate.priority) return false;
    if (specificityOf(other) !== candidateSpecificity) return false;
    const periodsOverlap =
      other.validFrom < (candidateEnd ?? MAX_DATE) && (other.validTo ?? MAX_DATE) > candidate.validFrom;
    if (!periodsOverlap) return false;
    if (!dimensionCompatible(other.zoneId, candidate.zoneId)) return false;
    if (!dimensionCompatible(other.siteId, candidate.siteId)) return false;
    if (!dimensionCompatible(other.customerCategoryId, candidate.customerCategoryId)) return false;
    if (!dimensionCompatible(other.channelCode, candidate.channelCode)) return false;
    if (!dimensionCompatible(other.commercialCampaignId, candidate.commercialCampaignId)) {
      return false;
    }
    if (other.minQuantity !== candidate.minQuantity) return false;
    return true;
  });
}

const MAX_DATE = new Date(253402300799999); // 9999-12-31T23:59:59.999Z ; borne « pas de fin ».

function dimensionCompatible(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}
