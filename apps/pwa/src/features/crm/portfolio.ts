/**
 * Portefeuille de l'appareil (ECR-CRM-01) et activité d'un compte (ECR-CRM-03). Logique pure :
 * comptes du jeu `customers` (et comptes créés sur l'appareil en attente), dernière activité et
 * prochaine action tirées des visites et interactions des 90 derniers jours (jeu `crm_activity`).
 */
import type { SalesReferences } from '../sales/references.js';
import type { CustomerData, InteractionData, VisitData } from '../sales/types.js';

export type StageFilter = 'ALL' | 'PROSPECT' | 'CUSTOMER' | 'LOST';

export interface PortfolioRow {
  readonly customer: CustomerData;
  readonly lastActivityAt: string | null;
  /** Prochaine action prévue (`AAAA-MM-JJ`) la plus proche, s'il y en a. */
  readonly nextActionAt: string | null;
  readonly nextActionNote: string | null;
}

export type ActivityItem =
  | { readonly kind: 'VISIT'; readonly at: string; readonly visit: VisitData }
  | { readonly kind: 'INTERACTION'; readonly at: string; readonly interaction: InteractionData };

/** Activité d'un compte, la plus récente d'abord. */
export function activityOf(
  refs: Pick<SalesReferences, 'visits' | 'interactions'>,
  customerId: string,
): ActivityItem[] {
  return [
    ...refs.visits
      .filter((visit) => visit.customer_id === customerId)
      .map((visit) => ({ kind: 'VISIT' as const, at: visit.occurred_at, visit })),
    ...refs.interactions
      .filter((interaction) => interaction.customer_id === customerId)
      .map((interaction) => ({
        kind: 'INTERACTION' as const,
        at: interaction.occurred_at,
        interaction,
      })),
  ].sort((a, b) => b.at.localeCompare(a.at));
}

function matches(customer: CustomerData, text: string): boolean {
  if (!text) return true;
  if (customer.display_name.toLowerCase().includes(text)) return true;
  if (customer.contact_name?.toLowerCase().includes(text)) return true;
  const digits = text.replace(/\D/g, '');
  return (
    digits.length >= 3 &&
    customer.phone_primary !== null &&
    customer.phone_primary.replace(/\D/g, '').includes(digits)
  );
}

/**
 * Comptes filtrés, ceux qui ont une prochaine action d'abord (la plus proche en tête), puis par nom.
 * La prochaine action d'un compte est celle de sa dernière visite ou interaction qui en prévoit une.
 */
export function portfolioRows(
  refs: Pick<SalesReferences, 'customers' | 'visits' | 'interactions'>,
  filter: { readonly stage: StageFilter; readonly query: string },
): PortfolioRow[] {
  const text = filter.query.trim().toLowerCase();
  return refs.customers
    .filter(
      (customer) =>
        customer.stage !== 'MERGED' &&
        (filter.stage === 'ALL' || customer.stage === filter.stage) &&
        matches(customer, text),
    )
    .map((customer) => {
      const activity = activityOf(refs, customer.id);
      const planned = activity
        .map((item) => (item.kind === 'VISIT' ? item.visit : item.interaction))
        .find((item) => item.next_action_at !== null);
      return {
        customer,
        lastActivityAt: activity[0]?.at ?? null,
        nextActionAt: planned?.next_action_at ?? null,
        nextActionNote: planned?.next_action_note ?? null,
      };
    })
    .sort((a, b) => {
      if (a.nextActionAt && b.nextActionAt) {
        return a.nextActionAt.localeCompare(b.nextActionAt);
      }
      if (a.nextActionAt) return -1;
      if (b.nextActionAt) return 1;
      return a.customer.display_name.localeCompare(b.customer.display_name, 'fr');
    });
}
