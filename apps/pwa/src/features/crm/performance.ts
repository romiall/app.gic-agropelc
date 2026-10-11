/**
 * ECR-CRM-05 « Mes objectifs et performances » : logique pure. En ligne, les chiffres viennent du
 * serveur (`GET /performance/commercial`, BR-VEN-020 pour le chiffre d'affaires). Hors ligne,
 * l'appareil estime l'effort à partir de ce qu'il détient (visites et échanges des 90 derniers jours,
 * comptes acquis, saisies en attente) ; le chiffre d'affaires et les quantités vendues ne se lisent
 * qu'en ligne.
 */
import { businessDayEndUtc, businessDayStartUtc } from '@gic/domain';
import type { SalesReferences } from '../sales/references.js';
import type { SalesTargetData } from '../sales/types.js';

export type PeriodKind = 'MONTH' | 'TODAY';

export interface Period {
  readonly from: string;
  readonly to: string;
}

/** Mois en cours (du 1er à aujourd'hui) ou jour métier courant. */
export function periodOf(kind: PeriodKind, today: string): Period {
  return kind === 'TODAY'
    ? { from: today, to: today }
    : { from: `${today.slice(0, 8)}01`, to: today };
}

export interface Effort {
  readonly prospectsCreated: number | null;
  readonly visits: number | null;
  readonly customersVisited: number | null;
  readonly interactions: number | null;
  readonly newCustomers: number | null;
}

/** Réponse de `GET /performance/commercial` (champs utiles à l'écran). */
export interface ServerPerformance {
  readonly effort: {
    readonly prospectsCreated: number;
    readonly visits: number;
    readonly customersVisited: number;
    readonly prospectsVisited: number;
    readonly interactions: number;
    readonly newCustomers: number;
  };
  readonly targets: readonly {
    readonly id: string;
    readonly metric: string;
    readonly productId: string | null;
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly targetValue: number;
    readonly realized: number | null;
  }[];
}

const inPeriod = (iso: string | null | undefined, period: Period): boolean => {
  if (!iso) return false;
  const at = new Date(iso).getTime();
  return (
    at >= businessDayStartUtc(period.from).getTime() && at < businessDayEndUtc(period.to).getTime()
  );
};

/** Effort estimé par l'appareil ; `null` pour ce qu'il ne peut pas savoir. */
export function localEffort(
  refs: Pick<SalesReferences, 'visits' | 'interactions' | 'customers' | 'outbox'>,
  userId: string,
  period: Period,
): Effort {
  const visits = refs.visits.filter(
    (visit) => visit.user_id === userId && inPeriod(visit.occurred_at, period),
  );
  const created = new Set(
    refs.customers
      .filter(
        (customer) =>
          customer.acquired_by_user_id === userId && inPeriod(customer.acquired_at, period),
      )
      .map((customer) => customer.id),
  );
  // Prospects créés sur l'appareil et pas encore retéléchargés.
  for (const command of refs.outbox) {
    if (
      command.command_type === 'crm.customer.create' &&
      command.author_user_id === userId &&
      command.status !== 'REJECTED' &&
      inPeriod(command.occurred_at, period)
    ) {
      created.add(command.aggregate_id);
    }
  }
  return {
    prospectsCreated: created.size,
    visits: visits.length,
    customersVisited: new Set(visits.map((visit) => visit.customer_id)).size,
    interactions: refs.interactions.filter(
      (interaction) => interaction.user_id === userId && inPeriod(interaction.occurred_at, period),
    ).length,
    newCustomers: null,
  };
}

export interface TargetView {
  readonly id: string;
  readonly metric: string;
  readonly productId: string | null;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly targetValue: number;
  readonly realized: number | null;
}

const LOCAL_METRICS: Readonly<Record<string, keyof Effort>> = {
  VISITES: 'visits',
  PROSPECTS_CREES: 'prospectsCreated',
};

/** Objectifs individuels actifs qui recouvrent la période, réalisés estimés sur l'appareil. */
export function localTargets(
  targets: readonly SalesTargetData[],
  userId: string,
  period: Period,
  effort: Effort,
): TargetView[] {
  return targets
    .filter(
      (target) =>
        target.status === 'ACTIVE' &&
        target.target_type === 'USER' &&
        target.user_id === userId &&
        target.period_start <= period.to &&
        target.period_end >= period.from,
    )
    .map((target) => {
      const key = LOCAL_METRICS[target.metric];
      return {
        id: target.id,
        metric: target.metric,
        productId: target.product_id,
        periodStart: target.period_start,
        periodEnd: target.period_end,
        targetValue: Number(target.target_value),
        realized: key ? effort[key] : null,
      };
    })
    .sort((a, b) => a.metric.localeCompare(b.metric));
}

/** Taux d'atteinte arrondi (en %), ou `null` si le réalisé est inconnu ou l'objectif nul. */
export function attainment(target: Pick<TargetView, 'targetValue' | 'realized'>): number | null {
  if (target.realized === null || target.targetValue <= 0) return null;
  return Math.round((target.realized / target.targetValue) * 100);
}
