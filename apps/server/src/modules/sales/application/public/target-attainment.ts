/**
 * Atteinte d'objectif (P9-27 ; KPI-COM-16, AV-462 choix (b), AV-473 et AV-474 ; D11 §7.1 : « valeur réalisée de la
 * métrique ÷ valeur cible », CM §34.3). Le réalisé d'un objectif de commercial est défini **ici, une seule fois** :
 * la route `GET /performance/commercial` et le tableau composent la même fonction (ADR-065 §2).
 *
 * - **Objectifs lus** : objectifs `USER` actifs dont la période couvre le **jour de lecture** (AV-473 (a)), pour les
 *   personnes de l'étendue. Les objectifs `TEAM` et `SITE` ne sont pas lus : le recouvrement entre objectifs de
 *   personne, d'équipe et de site n'est pas fixé (AV-473 (b) et (c)).
 * - **Réalisé** (AV-474 (a)) : cumul du premier jour de l'objectif au jour de lecture (ou à la fin de l'objectif si
 *   elle est antérieure), jours métier inclus. `CA` : ventes attribuées au commercial (BR-VEN-020), nettes des
 *   annulations appliquées dans la fenêtre (BR-FIN-042) ; `QTE_PRODUIT` : quantité nette du produit ; `VISITES`,
 *   `PROSPECTS_CREES` et `NOUVEAUX_CLIENTS` : effort commercial de `crm` (BR-CRM-019).
 * - **Atteinte** = réalisé ÷ cible (4 décimales), **non plafonnée** (120 % possible) ; `null` si la cible n'est pas
 *   positive. Regroupement pour le tableau par `(métrique, produit)` : Σ réalisé ÷ Σ cible.
 *
 * Étendue (`ReadScope`, jamais élargie) : périmètre vide = zéros ; `userIds` = objectifs de ces personnes (la borne
 * de sites n'est pas appliquée à un titulaire, comme AV-465) ; `siteIds` seuls = non résolu (aucun lien personne →
 * site fiable) ; aucun champ = tous les objectifs `USER`. Aucun droit n'est contrôlé ici (le bloc exige
 * `crm.target.read`). Aucune table n'est écrite.
 */
import type { Kysely, Transaction } from 'kysely';
import { businessDayEndUtc, businessDayStartUtc } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { ratio } from '../../../../platform/indicator-window.js';
import { isEmptyScope, type ReadScope } from '../../../../platform/read-scope.js';
import {
  TARGET_LIST_LIMIT,
  commercialEffort,
  listTargets,
  type CommercialEffort,
} from '../../../crm/application/public/index.js';
import { periodProductQuantity, periodRevenue } from './revenue.js';

type Executor = Kysely<DB> | Transaction<DB>;

export type TargetMetric =
  'CA' | 'QTE_PRODUIT' | 'NOUVEAUX_CLIENTS' | 'VISITES' | 'PROSPECTS_CREES';

/** Ordre d'affichage des groupes ; une métrique inconnue passe après (et n'a jamais de réalisé). */
const METRIC_ORDER: readonly TargetMetric[] = [
  'CA',
  'QTE_PRODUIT',
  'NOUVEAUX_CLIENTS',
  'VISITES',
  'PROSPECTS_CREES',
];

/** Métriques d'effort : clé de `CommercialEffort` qui porte leur réalisé. */
const EFFORT_KEYS: Readonly<Record<string, keyof CommercialEffort>> = {
  VISITES: 'visits',
  PROSPECTS_CREES: 'prospectsCreated',
  NOUVEAUX_CLIENTS: 'newCustomers',
};

export interface TargetRealizedInput {
  readonly userId: string;
  /** Valeur de la colonne `metric` ; une métrique inconnue donne `null`. */
  readonly metric: string;
  readonly productId: string | null;
  /** Début inclus. */
  readonly fromUtc: Date;
  /** Fin exclue. */
  readonly toUtc: Date;
}

/** Lectures déjà faites pendant un calcul : une lecture par couple personne × fenêtre. */
interface RealizedMemo {
  readonly effort: Map<string, Promise<CommercialEffort>>;
  readonly revenue: Map<string, Promise<number>>;
}

const windowKey = (input: TargetRealizedInput): string =>
  `${input.userId}|${input.fromUtc.toISOString()}|${input.toUtc.toISOString()}`;

async function realizedOf(
  executor: Executor,
  input: TargetRealizedInput,
  memo: RealizedMemo | null,
): Promise<number | null> {
  const window = {
    fromUtc: input.fromUtc,
    toUtc: input.toUtc,
    commercialUserId: input.userId,
  };
  if (input.metric === 'CA') {
    const key = windowKey(input);
    let revenue = memo?.revenue.get(key);
    if (revenue === undefined) {
      revenue = periodRevenue(executor, window).then((r) => r.netRevenueXaf);
      memo?.revenue.set(key, revenue);
    }
    return revenue;
  }
  if (input.metric === 'QTE_PRODUIT') {
    if (input.productId === null) return null;
    return periodProductQuantity(executor, { ...window, productId: input.productId });
  }
  const effortKey = EFFORT_KEYS[input.metric];
  if (effortKey === undefined) return null;
  const key = windowKey(input);
  let effort = memo?.effort.get(key);
  if (effort === undefined) {
    effort = commercialEffort(executor, {
      userId: input.userId,
      fromUtc: input.fromUtc,
      toUtc: input.toUtc,
    });
    memo?.effort.set(key, effort);
  }
  return (await effort)[effortKey];
}

/** Réalisé d'une métrique d'objectif pour un commercial sur `[fromUtc, toUtc[` ; `null` si non calculable. */
export function targetRealized(
  executor: Executor,
  input: TargetRealizedInput,
): Promise<number | null> {
  return realizedOf(executor, input, null);
}

export interface TargetAttainmentLine {
  readonly targetId: string;
  readonly userId: string;
  readonly metric: string;
  readonly productId: string | null;
  /** `AAAA-MM-JJ`. */
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly targetValue: number;
  readonly realized: number | null;
  /** Ratio à 4 décimales, non plafonné. */
  readonly attainment: number | null;
}

export interface TargetAttainmentGroup {
  readonly metric: string;
  readonly productId: string | null;
  /** Objectifs au réalisé calculable. */
  readonly targets: number;
  readonly targetValue: number;
  readonly realized: number;
  readonly attainment: number | null;
}

export interface TargetAttainment {
  readonly day: string;
  /** `false` : étendue de sites seuls, les objectifs de personnes ne s'y rattachent pas (AV-473). */
  readonly resolved: boolean;
  /** `true` : `TARGET_LIST_LIMIT` objectifs lus, la liste peut être incomplète (échec fermé côté tableau). */
  readonly truncated: boolean;
  /** Objectifs dont le réalisé n'est pas calculable (métrique inconnue, quantité sans produit). */
  readonly unresolvedTargets: number;
  readonly lines: readonly TargetAttainmentLine[];
  /** Ordre : CA, QTE_PRODUIT (par produit), NOUVEAUX_CLIENTS, VISITES, PROSPECTS_CREES. */
  readonly groups: readonly TargetAttainmentGroup[];
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

const emptyAttainment = (day: string, resolved: boolean): TargetAttainment => ({
  day,
  resolved,
  truncated: false,
  unresolvedTargets: 0,
  lines: [],
  groups: [],
});

/**
 * Atteinte des objectifs `USER` actifs au jour de lecture `day` (`AAAA-MM-JJ`) pour l'étendue. `limit` est réservé
 * aux essais (défaut `TARGET_LIST_LIMIT` : borne technique de lecture, pas un seuil métier).
 */
export async function targetAttainment(
  executor: Executor,
  scope: ReadScope,
  input: { readonly day: string; readonly limit?: number },
): Promise<TargetAttainment> {
  const { day } = input;
  if (isEmptyScope(scope)) return emptyAttainment(day, true);
  if (scope.userIds === undefined && scope.siteIds !== undefined) {
    return emptyAttainment(day, false);
  }
  const limit = input.limit ?? TARGET_LIST_LIMIT;
  const targets = await listTargets(executor, {
    targetType: 'USER',
    activeOn: day,
    limit,
    ...(scope.userIds !== undefined ? { userIds: scope.userIds } : {}),
  });
  const memo: RealizedMemo = { effort: new Map(), revenue: new Map() };
  const lines: TargetAttainmentLine[] = [];
  for (const target of targets) {
    if (target.userId === null) continue;
    const lastDay = target.periodEnd < day ? target.periodEnd : day;
    const realized = await realizedOf(
      executor,
      {
        userId: target.userId,
        metric: target.metric,
        productId: target.productId,
        fromUtc: businessDayStartUtc(target.periodStart),
        toUtc: businessDayEndUtc(lastDay),
      },
      memo,
    );
    lines.push({
      targetId: target.id,
      userId: target.userId,
      metric: target.metric,
      productId: target.productId,
      periodStart: target.periodStart,
      periodEnd: target.periodEnd,
      targetValue: target.targetValue,
      realized,
      attainment: realized === null ? null : ratio(realized, target.targetValue),
    });
  }
  const acc = new Map<
    string,
    { metric: string; productId: string | null; targets: number; target: number; realized: number }
  >();
  let unresolvedTargets = 0;
  for (const line of lines) {
    if (line.realized === null) {
      unresolvedTargets += 1;
      continue;
    }
    const key = `${line.metric}|${line.productId ?? ''}`;
    const group = acc.get(key) ?? {
      metric: line.metric,
      productId: line.productId,
      targets: 0,
      target: 0,
      realized: 0,
    };
    group.targets += 1;
    group.target += line.targetValue;
    group.realized += line.realized;
    acc.set(key, group);
  }
  const rank = (metric: string): number => {
    const index = METRIC_ORDER.indexOf(metric as TargetMetric);
    return index === -1 ? METRIC_ORDER.length : index;
  };
  const groups = [...acc.values()]
    .sort(
      (a, b) =>
        rank(a.metric) - rank(b.metric) || (a.productId ?? '').localeCompare(b.productId ?? ''),
    )
    .map((group) => {
      const targetValue = round3(group.target);
      const realized = round3(group.realized);
      return {
        metric: group.metric,
        productId: group.productId,
        targets: group.targets,
        targetValue,
        realized,
        attainment: ratio(realized, targetValue),
      };
    });
  return {
    day,
    resolved: true,
    truncated: targets.length >= limit,
    unresolvedTargets,
    lines,
    groups,
  };
}
