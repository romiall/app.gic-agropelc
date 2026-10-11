/**
 * ECR-PRX-02 « Règles tarifaires » (D10-PRX ; SM-PRICE-RULE ; BR-PRX-006, -007, AV-062) : logique
 * pure. Les règles d'un produit se lisent en ligne (`GET /price-rules`, brouillons compris) ; une
 * règle ne se modifie jamais : on en rédige une nouvelle (`pricing.rule.draft`), une nouvelle version
 * d'une règle active (`pricing.rule.supersede`), on l'active (Direction seule, `pricing.rule.activate`)
 * ou on avance sa fin (`pricing.rule.end`). Le conflit d'activation (BR-PRX-006) est annoncé par le
 * moteur partagé (`findConflicts`), le même que le serveur.
 *
 * Gardes reprises du serveur et de la base, dont la violation n'est pas refusée proprement mais
 * renvoyée sans fin (S-29) : code de lignée unique, nouvelle version seulement sur la dernière version
 * active, date d'effet d'une nouvelle version dans la période de la règle remplacée (son activation y
 * fixe la fin de l'ancienne), fin postérieure à la date d'effet et jamais dans le passé (SM-PRICE-RULE),
 * prix, priorité et seuil bornés.
 */
import { businessDayEndUtc, businessDayOf, findConflicts, xaf, type PriceRule } from '@gic/domain';
import { MAX_QUANTITY } from '../sales/sale-form.js';
import type { SiteData, ZoneData } from '../sales/types.js';

/** Règle telle que la renvoie `GET /api/v1/price-rules` (dates en chaîne ISO). */
export interface RuleView {
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
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly status: string;
}

/** Bornes de la colonne `priority` (entier signé 32 bits). */
export const PRIORITY_MIN = -2_147_483_648;
export const PRIORITY_MAX = 2_147_483_647;

export function toDomainRule(rule: RuleView, zones: ReadonlyMap<string, ZoneData>): PriceRule {
  return {
    id: rule.id,
    productId: rule.productId,
    unitPriceXaf: xaf(rule.unitPriceXaf),
    pricingUnitCode: rule.pricingUnitCode,
    zoneId: rule.zoneId,
    zoneDepth: rule.zoneId ? (zones.get(rule.zoneId)?.depth ?? 1) : null,
    siteId: rule.siteId,
    customerCategoryId: rule.customerCategoryId,
    channelCode: rule.channelCode,
    minQuantity: rule.minQuantity,
    commercialCampaignId: rule.commercialCampaignId,
    priority: rule.priority,
    validFrom: new Date(rule.validFrom),
    validTo: rule.validTo ? new Date(rule.validTo) : null,
    status: rule.status as PriceRule['status'],
  };
}

/** Règles en vigueur ou à venir, brouillons, historique (remplacées, terminées, annulées). */
export function groupRules(
  rules: readonly RuleView[],
  now: Date,
): { readonly active: RuleView[]; readonly drafts: RuleView[]; readonly history: RuleView[] } {
  const ended = (rule: RuleView) => rule.validTo !== null && new Date(rule.validTo) <= now;
  const byFrom = (a: RuleView, b: RuleView) => b.validFrom.localeCompare(a.validFrom);
  return {
    active: rules.filter((rule) => rule.status === 'ACTIVE' && !ended(rule)).sort(byFrom),
    drafts: rules.filter((rule) => rule.status === 'DRAFT').sort(byFrom),
    history: rules
      .filter(
        (rule) =>
          (rule.status === 'ACTIVE' && ended(rule)) ||
          ['RETIRED', 'CANCELLED'].includes(rule.status),
      )
      .sort(byFrom),
  };
}

/**
 * Règle remplacée par une nouvelle version : celle de même code et de version précédente (le
 * remplacement reprend le code et incrémente la version, l'unicité `(code, version)` est garantie).
 * `GET /price-rules` ne sert pas `supersedesRuleId` (S-29).
 */
export function predecessorOf(rule: RuleView, rules: readonly RuleView[]): RuleView | null {
  if (rule.version <= 1) return null;
  return (
    rules.find(
      (candidate) => candidate.code === rule.code && candidate.version === rule.version - 1,
    ) ?? null
  );
}

/** Vrai si aucune version plus récente de la lignée n'existe (brouillon compris). */
export function isLatestVersion(rule: RuleView, rules: readonly RuleView[]): boolean {
  return !rules.some(
    (candidate) => candidate.code === rule.code && candidate.version > rule.version,
  );
}

/** Champs saisis (textes) d'une règle. */
export interface RuleForm {
  readonly code: string;
  readonly unitPriceText: string;
  readonly pricingUnitCode: string;
  readonly siteId: string;
  readonly zoneId: string;
  readonly customerCategoryId: string;
  readonly channelCode: string;
  readonly minQuantityText: string;
  readonly priorityText: string;
  /** Campagne commerciale reprise de la règle remplacée (non gérée à l'écran). */
  readonly commercialCampaignId: string;
  /** `AAAA-MM-JJTHH:mm`, heure de Douala. */
  readonly validFrom: string;
  readonly validTo: string;
  readonly notes: string;
}

export type RuleIssue =
  | 'CODE_REQUIRED'
  | 'CODE_TAKEN'
  | 'PRICE_INVALID'
  | 'MIN_QUANTITY_INVALID'
  | 'PRIORITY_INVALID'
  | 'VALID_FROM_INVALID'
  | 'VALID_FROM_PAST'
  | 'VALID_TO_INVALID'
  | 'OUTSIDE_SUPERSEDED'
  | 'SITE_NOT_IN_ZONE';

/** Instant ISO d'une saisie `datetime-local` lue à l'heure de Douala ; `null` si invalide. */
export function doualaInstant(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(`${value}:00+01:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Saisie `datetime-local` (heure de Douala) d'un instant. */
export function doualaLocal(instant: Date): string {
  const shifted = new Date(instant.getTime() + 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 16);
}

/** Instant arrondi à la minute supérieure (une saisie à la minute n'est jamais dans le passé). */
export function ceilMinute(instant: Date): Date {
  return new Date(Math.ceil(instant.getTime() / 60_000) * 60_000);
}

/** Date d'effet proposée : le lendemain à 0 h, heure de Douala. */
export function defaultValidFrom(now: Date): string {
  return doualaLocal(businessDayEndUtc(businessDayOf(now)));
}

/** Date et heure avec l'année, à l'heure de Douala. */
export function formatRuleInstant(iso: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Africa/Douala',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** Vrai si le site appartient à la zone ou à l'une de ses sous-zones. */
export function siteInZone(
  site: Pick<SiteData, 'zone_id'> | undefined,
  zoneId: string,
  zones: ReadonlyMap<string, ZoneData>,
): boolean {
  if (!site) return true;
  const seen = new Set<string>();
  let current: ZoneData | undefined = zones.get(site.zone_id);
  while (current && !seen.has(current.id)) {
    if (current.id === zoneId) return true;
    seen.add(current.id);
    current = current.parent_id ? zones.get(current.parent_id) : undefined;
  }
  return false;
}

export interface RuleCheck {
  readonly issues: readonly RuleIssue[];
  readonly unitPriceXaf: number | null;
  readonly minQuantity: number | null;
  readonly priority: number;
  readonly validFrom: string | null;
  readonly validTo: string | null;
}

export interface RuleContext {
  /** Code exigé (nouvelle lignée) et codes déjà pris. */
  readonly needsCode: boolean;
  readonly takenCodes?: ReadonlySet<string>;
  /** Règle remplacée : la date d'effet doit tomber dans sa période. */
  readonly superseded?: Pick<RuleView, 'validFrom' | 'validTo'> | null;
  readonly sites?: ReadonlyMap<string, SiteData>;
  readonly zones?: ReadonlyMap<string, ZoneData>;
  /**
   * Instant de la saisie : une date d'effet passée rendrait le brouillon inactivable (activation non
   * rétroactive de plus de 5 minutes) et, faute d'annulation (S-29), figerait la lignée.
   */
  readonly now?: Date;
}

export function checkRule(form: RuleForm, context: RuleContext): RuleCheck {
  const issues: RuleIssue[] = [];
  const code = form.code.trim();
  if (context.needsCode && !code) issues.push('CODE_REQUIRED');
  else if (context.needsCode && context.takenCodes?.has(code)) issues.push('CODE_TAKEN');
  const priceText = form.unitPriceText.trim();
  const price = /^\d+$/.test(priceText) ? Number(priceText) : null;
  const priceOk = price !== null && price > 0 && Number.isSafeInteger(price);
  if (!priceOk) issues.push('PRICE_INVALID');
  let minQuantity: number | null = null;
  if (form.minQuantityText.trim()) {
    const normalized = form.minQuantityText.trim().replace(',', '.');
    minQuantity = /^\d+(\.\d{1,3})?$/.test(normalized) ? Number(normalized) : null;
    if (minQuantity === null || minQuantity <= 0 || minQuantity > MAX_QUANTITY) {
      issues.push('MIN_QUANTITY_INVALID');
      minQuantity = null;
    }
  }
  const priorityText = form.priorityText.trim() || '0';
  const priority = /^-?\d+$/.test(priorityText) ? Number(priorityText) : Number.NaN;
  const priorityOk =
    Number.isInteger(priority) && priority >= PRIORITY_MIN && priority <= PRIORITY_MAX;
  if (!priorityOk) issues.push('PRIORITY_INVALID');
  const validFrom = doualaInstant(form.validFrom);
  if (!validFrom) issues.push('VALID_FROM_INVALID');
  else if (context.now && validFrom < ceilMinute(context.now).toISOString()) {
    issues.push('VALID_FROM_PAST');
  }
  let validTo: string | null = null;
  if (form.validTo) {
    validTo = doualaInstant(form.validTo);
    if (!validTo || (validFrom && validTo <= validFrom)) issues.push('VALID_TO_INVALID');
  }
  const superseded = context.superseded;
  if (
    validFrom &&
    superseded &&
    (validFrom <= new Date(superseded.validFrom).toISOString() ||
      (superseded.validTo !== null && validFrom > new Date(superseded.validTo).toISOString()))
  ) {
    issues.push('OUTSIDE_SUPERSEDED');
  }
  if (
    form.siteId &&
    form.zoneId &&
    context.sites &&
    context.zones &&
    !siteInZone(context.sites.get(form.siteId), form.zoneId, context.zones)
  ) {
    issues.push('SITE_NOT_IN_ZONE');
  }
  return {
    issues,
    unitPriceXaf: priceOk ? price : null,
    minQuantity,
    priority: priorityOk ? priority : 0,
    validFrom,
    validTo,
  };
}

/** Dimensions communes à `pricing.rule.draft` et `pricing.rule.supersede` (clés vides omises). */
export function ruleDimensions(productId: string, form: RuleForm, check: RuleCheck) {
  const notes = form.notes.trim();
  return {
    productId,
    unitPriceXaf: check.unitPriceXaf as number,
    pricingUnitCode: form.pricingUnitCode,
    ...(form.zoneId ? { zoneId: form.zoneId } : {}),
    ...(form.siteId ? { siteId: form.siteId } : {}),
    ...(form.customerCategoryId ? { customerCategoryId: form.customerCategoryId } : {}),
    ...(form.channelCode ? { channelCode: form.channelCode } : {}),
    ...(check.minQuantity !== null ? { minQuantity: check.minQuantity } : {}),
    ...(form.commercialCampaignId ? { commercialCampaignId: form.commercialCampaignId } : {}),
    priority: check.priority,
    validFrom: check.validFrom as string,
    ...(check.validTo ? { validTo: check.validTo } : {}),
    ...(notes ? { notes } : {}),
  };
}

/** Règles actives en conflit avec la candidate (BR-PRX-006), la règle remplacée exclue. */
export function conflictsOf(
  candidate: RuleView,
  rules: readonly RuleView[],
  zones: ReadonlyMap<string, ZoneData>,
  supersededId: string | null,
): RuleView[] {
  const active = rules.filter(
    (rule) => rule.status === 'ACTIVE' && rule.id !== candidate.id && rule.id !== supersededId,
  );
  const found = new Set(
    findConflicts(
      toDomainRule(candidate, zones),
      active.map((rule) => toDomainRule(rule, zones)),
    ).map((rule) => rule.id),
  );
  return active.filter((rule) => found.has(rule.id));
}

/** Formulaire prérempli depuis une règle (nouvelle version) : portée, campagne et fin reprises. */
export function formFrom(rule: RuleView, validFrom: Date): RuleForm {
  return {
    code: rule.code,
    unitPriceText: String(rule.unitPriceXaf),
    pricingUnitCode: rule.pricingUnitCode,
    siteId: rule.siteId ?? '',
    zoneId: rule.zoneId ?? '',
    customerCategoryId: rule.customerCategoryId ?? '',
    channelCode: rule.channelCode ?? '',
    minQuantityText: rule.minQuantity === null ? '' : String(rule.minQuantity),
    priorityText: String(rule.priority),
    commercialCampaignId: rule.commercialCampaignId ?? '',
    validFrom: doualaLocal(validFrom),
    // La fin reprise doit suivre la date d'effet proposée (sinon le formulaire s'ouvrirait invalide).
    validTo:
      rule.validTo && new Date(rule.validTo) > validFrom ? doualaLocal(new Date(rule.validTo)) : '',
    notes: '',
  };
}

/**
 * Date d'effet proposée pour une nouvelle version : le lendemain à 0 h, ramenée dans la période de la
 * règle remplacée (après son début, au plus tard à sa fin).
 */
export function supersedeValidFrom(rule: Pick<RuleView, 'validFrom' | 'validTo'>, now: Date): Date {
  const tomorrow = businessDayEndUtc(businessDayOf(now));
  const start = new Date(rule.validFrom);
  let proposed = tomorrow > start ? tomorrow : new Date(start.getTime() + 60_000);
  if (rule.validTo && proposed > new Date(rule.validTo)) proposed = new Date(rule.validTo);
  return proposed;
}

/** Fin minimale admise pour `pricing.rule.end` : maintenant (à la minute supérieure) et après le début. */
export function minimumEnd(rule: Pick<RuleView, 'validFrom'>, now: Date): Date {
  const soon = ceilMinute(now);
  const afterStart = new Date(new Date(rule.validFrom).getTime() + 60_000);
  return soon > afterStart ? soon : afterStart;
}

/** Fin saisie admise : ni passée, ni avant le début, et plus tôt que la fin actuelle. */
export function endAllowed(
  value: string,
  rule: Pick<RuleView, 'validFrom' | 'validTo'>,
  now: Date,
): boolean {
  const instant = doualaInstant(value);
  if (!instant) return false;
  if (instant < minimumEnd(rule, now).toISOString()) return false;
  return rule.validTo === null || instant < new Date(rule.validTo).toISOString();
}
