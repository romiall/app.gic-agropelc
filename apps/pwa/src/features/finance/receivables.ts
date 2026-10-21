/**
 * Créances (ECR-FIN-01, P8E-09 ; ADR-047 §9 ; AV-304, AV-305). Logique pure : forme de la réponse de
 * `GET /receivables` (sales-read.controller, méthode `receivables`), vues par échéance et par tranche
 * de retard, synthèse d'une sélection (même règle que `summarizeReceivables` du serveur : seul l'échu
 * entre dans les tranches, BR-ANA-009), regroupement par client ou par titulaire, noms lus en ligne.
 * L'appareil ne recalcule ni échéance ni retard : il montre ceux du serveur (BR-FIN-007).
 */
import type { ReceivableLine } from '../sales/collect.js';
import type { CustomerData } from '../sales/types.js';
import type { AgingBucket } from './supplier-invoice.js';

/** Une seule lecture, sans filtre ni pagination (le serveur n'en propose pas, AV-304). */
export const RECEIVABLES_PATH = '/api/v1/receivables';

/**
 * Ligne de `GET /receivables` : `ReceivableLine` du module `sales`, `occurredAt` en chaîne ISO et
 * `resource` ajouté par le contrôleur (sales-read.controller, `withResource`).
 */
export interface ReceivableItem extends ReceivableLine {
  readonly siteId: string;
  readonly commercialUserId: string | null;
  readonly sellerUserId: string;
  readonly zoneId: string;
  readonly netTotalXaf: number;
  readonly amountPaidXaf: number;
  readonly daysOverdue: number;
  readonly overdue: boolean;
  /** Tranche de retard ; « 0-30 » aussi pour une créance non échue (`overdue` faux). */
  readonly bucket: AgingBucket;
  readonly resource: {
    readonly ownerUserId: string;
    readonly siteId: string;
    readonly zoneId: string;
  };
}

/** Synthèse du serveur : `buckets` ne contient que l'échu (Σ tranches = `overdueXaf`). */
export interface ReceivablesSummary {
  readonly totalXaf: number;
  readonly overdueXaf: number;
  readonly count: number;
  readonly buckets: Readonly<Record<AgingBucket, number>>;
}

export interface ReceivablesResponse {
  /** Jour métier de la lecture (Africa/Douala) : les soldes sont ceux du jour. */
  readonly as_of: string;
  readonly summary: ReceivablesSummary;
  readonly receivables: readonly ReceivableItem[];
}

/** Vues proposées : toutes, échues, à échoir, ou une tranche de retard. */
export const RECEIVABLE_VIEWS = [
  'ALL',
  'OVERDUE',
  'NOT_DUE',
  '0-30',
  '31-60',
  '61-90',
  '>90',
] as const;
export type ReceivableView = (typeof RECEIVABLE_VIEWS)[number];

export function matchesView(line: ReceivableItem, view: ReceivableView): boolean {
  if (view === 'ALL') return true;
  if (view === 'OVERDUE') return line.overdue;
  if (view === 'NOT_DUE') return !line.overdue;
  // Une créance non échue porte aussi la tranche « 0-30 » : seule l'échue y est rangée.
  return line.overdue && line.bucket === view;
}

/** Synthèse d'une sélection, à la même règle que le serveur (BR-ANA-009). */
export function summarizeLines(lines: readonly ReceivableItem[]): ReceivablesSummary {
  const buckets: Record<AgingBucket, number> = { '0-30': 0, '31-60': 0, '61-90': 0, '>90': 0 };
  let totalXaf = 0;
  let overdueXaf = 0;
  for (const line of lines) {
    totalXaf += line.balanceDueXaf;
    if (line.overdue) {
      overdueXaf += line.balanceDueXaf;
      buckets[line.bucket] += line.balanceDueXaf;
    }
  }
  return { totalXaf, overdueXaf, count: lines.length, buckets };
}

/** À échoir : le dû qui n'est pas encore en retard. */
export const notDueXaf = (summary: ReceivablesSummary) => summary.totalXaf - summary.overdueXaf;

/** Titulaire d'une créance, comme la portée du serveur : commercial attributaire, à défaut vendeur. */
export const ownerOf = (line: ReceivableItem) => line.commercialUserId ?? line.sellerUserId;

export const RECEIVABLE_GROUPINGS = ['customer', 'owner'] as const;
export type ReceivableGrouping = (typeof RECEIVABLE_GROUPINGS)[number];

/** Clé d'un client sans compte identifié (vente sans client, en principe jamais à crédit). */
export const NO_CUSTOMER = '';

/** Compte conservé d'un client absorbé (BR-CRM-007), en suivant les fusions successives. */
export function canonicalCustomer(id: string, alias: ReadonlyMap<string, string>): string {
  const seen = new Set<string>([id]);
  let current = id;
  for (let next = alias.get(current); next !== undefined; next = alias.get(current)) {
    if (seen.has(next)) break;
    seen.add(next);
    current = next;
  }
  return current;
}

export interface ReceivableGroup {
  readonly key: string;
  /** Créances du groupe, dans l'ordre du serveur (échéance la plus ancienne d'abord). */
  readonly lines: readonly ReceivableItem[];
  readonly balanceXaf: number;
  readonly overdueXaf: number;
  readonly overdueCount: number;
  readonly maxDaysOverdue: number;
  readonly oldestDueDate: string;
}

export function groupReceivables(
  lines: readonly ReceivableItem[],
  keyOf: (line: ReceivableItem) => string,
): ReceivableGroup[] {
  const byKey = new Map<string, ReceivableItem[]>();
  for (const line of lines) {
    const key = keyOf(line);
    const group = byKey.get(key);
    if (group) group.push(line);
    else byKey.set(key, [line]);
  }
  return [...byKey].map(([key, items]) => {
    const summary = summarizeLines(items);
    const overdueCount = items.filter((line) => line.overdue).length;
    return {
      key,
      lines: items,
      balanceXaf: summary.totalXaf,
      overdueXaf: summary.overdueXaf,
      overdueCount,
      // Une créance non échue porte 0 jour de retard (receivableAging) : le maximum est celui de l'échu.
      maxDaysOverdue: Math.max(0, ...items.map((line) => line.daysOverdue)),
      oldestDueDate: items.map((line) => line.dueDate).reduce((a, b) => (b < a ? b : a)),
    };
  });
}

/** Le plus en retard d'abord : échu, puis dû, puis nom, puis clé. */
export function sortGroups(
  groups: readonly ReceivableGroup[],
  nameOf: (key: string) => string,
): ReceivableGroup[] {
  return [...groups].sort(
    (a, b) =>
      b.overdueXaf - a.overdueXaf ||
      b.balanceXaf - a.balanceXaf ||
      nameOf(a.key).localeCompare(nameOf(b.key), 'fr') ||
      a.key.localeCompare(b.key),
  );
}

/**
 * Noms des clients lus en ligne quand l'appareil ne les a pas : la Finance et la Direction ne
 * reçoivent pas le jeu `customers` (S-12). Comptes fusionnés compris (exclus par défaut de la liste).
 */
export const CUSTOMER_NAME_PATHS = [
  '/api/v1/customers?limit=200',
  '/api/v1/customers?stage=MERGED&limit=200',
] as const;
export const CUSTOMER_NAME_MAX_PAGES = 10;

/** Noms des titulaires lus en ligne (`identity.user.read`), pour le regroupement par titulaire. */
export const USER_NAME_PATH = '/api/v1/users?limit=200';
export const USER_NAME_MAX_PAGES = 5;

/** Client de `GET /customers` (CustomerSummary du module `crm`), champs utiles à l'écran. */
export interface RemoteCustomerName {
  readonly id: string;
  readonly displayName: string;
  readonly phonePrimary: string | null;
  readonly mergedIntoId: string | null;
}

/** Compte de `GET /users` (UserSummary du module `identity`), champs utiles à l'écran. */
export interface RemoteUserName {
  readonly id: string;
  readonly fullName: string;
}

export interface CustomerCard {
  readonly name: string;
  readonly phone: string | null;
  /** Client du portefeuille de l'appareil : sa fiche s'ouvre (ECR-CRM-03). */
  readonly onDevice: boolean;
}

export interface CustomerDirectory {
  readonly alias: ReadonlyMap<string, string>;
  readonly cards: ReadonlyMap<string, CustomerCard>;
}

/** Clients de l'appareil d'abord, puis ceux lus en ligne ; fusions des deux sources. */
export function customerDirectory(
  local: readonly CustomerData[],
  localAlias: ReadonlyMap<string, string>,
  remote: readonly RemoteCustomerName[],
): CustomerDirectory {
  const alias = new Map(localAlias);
  const cards = new Map<string, CustomerCard>();
  for (const customer of local) {
    cards.set(customer.id, {
      name: customer.display_name,
      phone: customer.phone_primary,
      onDevice: true,
    });
  }
  for (const customer of remote) {
    if (customer.mergedIntoId && !alias.has(customer.id)) {
      alias.set(customer.id, customer.mergedIntoId);
    }
    if (!cards.has(customer.id)) {
      cards.set(customer.id, {
        name: customer.displayName,
        phone: customer.phonePrimary,
        onDevice: false,
      });
    }
  }
  return { alias, cards };
}

/** Clients des créances inconnus de l'appareil (triés) : leur liste déclenche la lecture en ligne. */
export function customersToName(
  lines: readonly ReceivableItem[],
  local: CustomerDirectory,
): string[] {
  const missing = new Set<string>();
  for (const line of lines) {
    if (line.customerId === null) continue;
    const id = canonicalCustomer(line.customerId, local.alias);
    if (!local.cards.has(id)) missing.add(id);
  }
  return [...missing].sort();
}

/** Lien d'appel d'un numéro (espaces et séparateurs retirés, `+` initial gardé). */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}
