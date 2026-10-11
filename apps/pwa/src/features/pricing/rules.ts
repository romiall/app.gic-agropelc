/**
 * ECR-PRX-02 « Règles tarifaires » (D10-PRX ; SM-PRICE-RULE ; BR-PRX-006, -007, AV-062) : logique
 * pure. Les règles d'un produit se lisent en ligne (`GET /price-rules`, brouillons compris) ; une
 * règle ne se modifie jamais : on en rédige une nouvelle (`pricing.rule.draft`), une nouvelle version
 * d'une règle active (`pricing.rule.supersede`), on l'active (Direction seule, `pricing.rule.activate`)
 * ou on avance sa fin (`pricing.rule.end`). Le conflit d'activation (BR-PRX-006) est annoncé par le
 * moteur partagé (`findConflicts`), le même que le serveur.
 */
import { findConflicts, xaf, type PriceRule } from '@gic/domain';
import type { ZoneData } from '../sales/types.js';

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
  /** `AAAA-MM-JJTHH:mm`, heure de Douala. */
  readonly validFrom: string;
  readonly validTo: string;
  readonly notes: string;
}

export type RuleIssue =
  | 'CODE_REQUIRED'
  | 'PRICE_INVALID'
  | 'MIN_QUANTITY_INVALID'
  | 'PRIORITY_INVALID'
  | 'VALID_FROM_INVALID'
  | 'VALID_TO_INVALID';

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

export interface RuleCheck {
  readonly issues: readonly RuleIssue[];
  readonly unitPriceXaf: number | null;
  readonly minQuantity: number | null;
  readonly priority: number;
  readonly validFrom: string | null;
  readonly validTo: string | null;
}

export function checkRule(form: RuleForm, needsCode: boolean): RuleCheck {
  const issues: RuleIssue[] = [];
  if (needsCode && !form.code.trim()) issues.push('CODE_REQUIRED');
  const price = /^\d+$/.test(form.unitPriceText.trim()) ? Number(form.unitPriceText.trim()) : null;
  if (price === null || price <= 0) issues.push('PRICE_INVALID');
  let minQuantity: number | null = null;
  if (form.minQuantityText.trim()) {
    const normalized = form.minQuantityText.trim().replace(',', '.');
    minQuantity = /^\d+(\.\d{1,3})?$/.test(normalized) ? Number(normalized) : null;
    if (minQuantity === null || minQuantity <= 0) {
      issues.push('MIN_QUANTITY_INVALID');
      minQuantity = null;
    }
  }
  const priorityText = form.priorityText.trim() || '0';
  const priority = /^-?\d+$/.test(priorityText) ? Number(priorityText) : Number.NaN;
  if (!Number.isInteger(priority)) issues.push('PRIORITY_INVALID');
  const validFrom = doualaInstant(form.validFrom);
  if (!validFrom) issues.push('VALID_FROM_INVALID');
  let validTo: string | null = null;
  if (form.validTo) {
    validTo = doualaInstant(form.validTo);
    if (!validTo || (validFrom && validTo <= validFrom)) issues.push('VALID_TO_INVALID');
  }
  return {
    issues,
    unitPriceXaf: price !== null && price > 0 ? price : null,
    minQuantity,
    priority: Number.isInteger(priority) ? priority : 0,
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

/** Formulaire prérempli depuis une règle (nouvelle version), date d'effet à l'instant donné. */
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
    validFrom: doualaLocal(validFrom),
    validTo: '',
    notes: '',
  };
}
