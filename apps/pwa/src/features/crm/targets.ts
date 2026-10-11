/**
 * ECR-CRM-07 « Gestion des objectifs » (responsable commercial, direction ; en ligne ; UC-CRM-10,
 * BR-CRM-018, AV-016) : logique pure.
 *
 * - Objectifs lus sur `GET /targets` (ceux que la portée de l'utilisateur atteint : la direction voit
 *   tout ; un responsable, les siens et ceux des équipes qu'il dirige, lus par équipe).
 * - Définition (`crm.target.set`, agrégat `SALES_TARGET`) : une seule cible (commercial, équipe ou
 *   site), une métrique (chiffre d'affaires, quantité d'un produit, nouveaux clients, visites,
 *   prospects créés), une période de jours métier, une valeur entière (décimale seulement pour une
 *   quantité de produit). Deux objectifs actifs de même cible, métrique et produit ne se chevauchent
 *   pas (`TARGET_OVERLAP`) : contrôlé ici sur les objectifs lus.
 * - Un objectif ne se modifie pas : on l'annule (`crm.target.cancel`, commentaire facultatif) et on en
 *   définit un nouveau.
 * - Commerciaux et équipes viennent des jeux `user` et `team` de l'appareil, que le serveur ne publie
 *   pas encore (S-28) : tant qu'ils sont vides, seule la cible « site » est proposée.
 */

export const TARGET_METRICS = [
  'CA',
  'QTE_PRODUIT',
  'NOUVEAUX_CLIENTS',
  'VISITES',
  'PROSPECTS_CREES',
] as const;
export type TargetMetric = (typeof TARGET_METRICS)[number];
export type TargetType = 'USER' | 'TEAM' | 'SITE';

/** Objectif renvoyé par `GET /api/v1/targets`. */
export interface TargetView {
  readonly id: string;
  readonly targetType: TargetType;
  readonly userId: string | null;
  readonly teamId: string | null;
  readonly siteId: string | null;
  readonly metric: string;
  readonly productId: string | null;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly targetValue: number;
  readonly status: string;
}

export interface TargetForm {
  readonly targetType: TargetType;
  readonly targetId: string;
  readonly metric: TargetMetric;
  readonly productId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly valueText: string;
}

export type TargetIssue =
  'TARGET_REQUIRED' | 'PRODUCT_REQUIRED' | 'PERIOD_INVALID' | 'VALUE_INVALID' | 'OVERLAP';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TARGET_VALUE = 9_999_999_999_999;

/** Mois métier en cours : du premier au dernier jour. */
export function currentMonth(today: string): { readonly start: string; readonly end: string } {
  const [year, month] = today.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, '0');
  return { start: `${year}-${mm}-01`, end: `${year}-${mm}-${String(last).padStart(2, '0')}` };
}

const targetOf = (target: Pick<TargetView, 'userId' | 'teamId' | 'siteId'>): string | null =>
  target.userId ?? target.teamId ?? target.siteId;

export function parseTargetValue(text: string, metric: TargetMetric): number | null {
  const normalized = text.trim().replace(/\s/g, '').replace(',', '.');
  const pattern = metric === 'QTE_PRODUIT' ? /^\d+(\.\d{1,3})?$/ : /^\d+$/;
  if (!pattern.test(normalized)) return null;
  const value = Number(normalized);
  return value > 0 && value <= MAX_TARGET_VALUE ? value : null;
}

export function checkTarget(form: TargetForm, existing: readonly TargetView[]): TargetIssue[] {
  const issues: TargetIssue[] = [];
  if (!form.targetId) issues.push('TARGET_REQUIRED');
  if (form.metric === 'QTE_PRODUIT' && !form.productId) issues.push('PRODUCT_REQUIRED');
  const periodOk =
    DATE_ONLY.test(form.periodStart) &&
    DATE_ONLY.test(form.periodEnd) &&
    form.periodEnd >= form.periodStart;
  if (!periodOk) issues.push('PERIOD_INVALID');
  if (parseTargetValue(form.valueText, form.metric) === null) issues.push('VALUE_INVALID');
  const productId = form.metric === 'QTE_PRODUIT' ? form.productId : null;
  if (
    periodOk &&
    form.targetId &&
    existing.some(
      (target) =>
        target.status === 'ACTIVE' &&
        target.targetType === form.targetType &&
        targetOf(target) === form.targetId &&
        target.metric === form.metric &&
        (target.productId ?? null) === (productId || null) &&
        target.periodStart <= form.periodEnd &&
        target.periodEnd >= form.periodStart,
    )
  ) {
    issues.push('OVERLAP');
  }
  return issues;
}

export function targetPayload(form: TargetForm) {
  const key =
    form.targetType === 'USER' ? 'userId' : form.targetType === 'TEAM' ? 'teamId' : 'siteId';
  return {
    targetType: form.targetType,
    [key]: form.targetId,
    metric: form.metric,
    ...(form.metric === 'QTE_PRODUIT' ? { productId: form.productId } : {}),
    periodStart: form.periodStart,
    periodEnd: form.periodEnd,
    targetValue: parseTargetValue(form.valueText, form.metric) as number,
  };
}

/** Objectifs lus, sans doublon (plusieurs lectures par équipe), les actifs d'abord, puis par période. */
export function mergeTargets(lists: readonly (readonly TargetView[])[]): TargetView[] {
  const byId = new Map<string, TargetView>();
  for (const list of lists) for (const target of list) byId.set(target.id, target);
  return [...byId.values()].sort(
    (a, b) =>
      Number(b.status === 'ACTIVE') - Number(a.status === 'ACTIVE') ||
      b.periodStart.localeCompare(a.periodStart),
  );
}
