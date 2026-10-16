/**
 * Coûts et marges (ECR-FIN-06, P8E-08 ; ADR-044, ADR-047 §6 ; AV-299, AV-303). Logique pure : période
 * (nommée, bornée à aujourd'hui, ou choisie), chemins des quatre lectures (vue d'ensemble, pertes
 * valorisées, lots et leur fiche, écritures de coût d'un lot), formes des réponses. L'appareil ne
 * calcule aucune marge : il montre celles du serveur (BR-ANA-009) ; les axes produit, point de vente et
 * commercial attendent l'explorateur de P9 (AV-299).
 */
import { businessPeriodOf } from '@gic/domain';
import { checkPeriod, type PeriodIssue } from '../stock/ledger.js';

/** Périodes proposées ; `CUSTOM` : du … au … choisis (un an au plus, jamais après aujourd'hui). */
export const COST_PERIODS = ['MONTH', 'WEEK', 'TODAY', 'YEAR', 'CUSTOM'] as const;
export type CostPeriod = (typeof COST_PERIODS)[number];
/** Période par défaut (AV-303) : le mois en cours, à ce jour. */
export const DEFAULT_COST_PERIOD: CostPeriod = 'MONTH';

/** Période nommée en cours, arrêtée à aujourd'hui (la vue d'ensemble ne lit pas l'avenir). */
export function namedPeriod(
  code: Exclude<CostPeriod, 'CUSTOM'>,
  today: string,
): { readonly from: string; readonly to: string } {
  const { fromDay, toDay } = businessPeriodOf(code, today);
  return { from: fromDay, to: toDay > today ? today : toDay };
}

export function periodIssue(from: string, to: string, today: string): PeriodIssue | null {
  return checkPeriod(from, to, today);
}

export const overviewPath = (from: string, to: string) =>
  `/api/v1/finance/overview?from=${from}&to=${to}`;

export const LOSS_GROUPS = ['product', 'lot', 'reason'] as const;
export type LossGroup = (typeof LOSS_GROUPS)[number];

export const lossesPath = (from: string, to: string, group: LossGroup) =>
  `/api/v1/losses/summary?from=${from}&to=${to}&group_by=${group}`;

/** Lots proposés (AV-303) : en cours, en vente, clôturés ; 50 par statut, les plus récents. */
export const LOT_STATUSES = ['ACTIVE', 'SELLING', 'CLOSED'] as const;
export type LotStatusChoice = (typeof LOT_STATUSES)[number];
export const LOT_PAGE_LIMIT = 50;

export const lotsPath = (status: LotStatusChoice) =>
  `/api/v1/production/lots?status=${status}&limit=${LOT_PAGE_LIMIT}`;
export const lotPath = (lotId: string) => `/api/v1/production/lots/${lotId}`;

export const COST_ENTRY_PAGE_LIMIT = 200;
export const COST_ENTRY_MAX_PAGES = 5;
export const costEntriesPath = (lotId: string) =>
  `/api/v1/costs?cost_object_type=PRODUCTION_LOT&cost_object_id=${lotId}&limit=${COST_ENTRY_PAGE_LIMIT}`;

/** Vue d'ensemble (`GET /finance/overview`) : un bloc nul n'est pas lisible avec ces droits. */
export interface FinanceOverview {
  readonly from: string;
  readonly to: string;
  /** Jour de la lecture : créances, dettes et trésorerie sont des soldes à ce jour, pas à `to`. */
  readonly as_of: string;
  readonly revenue: {
    readonly grossRevenueXaf: number;
    readonly cancelledXaf: number;
    readonly netRevenueXaf: number;
    /** Nuls sans droit de valorisation (RC-05). */
    readonly costOfSalesXaf: number | null;
    readonly grossMarginXaf: number | null;
    readonly saleCount: number;
  } | null;
  readonly collected: { readonly amountXaf: number; readonly paymentsCount: number } | null;
  readonly receivables: {
    readonly outstandingXaf: number;
    readonly openCount: number;
    readonly overdueXaf: number;
    readonly overdueCount: number;
    /** Échu seulement, par retard (« 0-30 » : 1 à 30 jours de retard). */
    readonly buckets: Readonly<Record<string, number>>;
  } | null;
  readonly expenses: {
    readonly totalXaf: number;
    readonly count: number;
    readonly byCategory: readonly {
      readonly code: string;
      readonly label: string;
      readonly amountXaf: number;
      readonly count: number;
    }[];
    readonly pendingXaf: number;
    readonly unjustifiedXaf: number;
  } | null;
  readonly payables: {
    readonly balanceXaf: number;
    readonly overdueXaf: number;
    readonly advanceXaf: number;
    readonly netXaf: number;
  } | null;
  readonly cash: {
    readonly totalXaf: number;
    readonly byAccountType: Readonly<Record<string, number>>;
  } | null;
}

/** Ligne des pertes valorisées (`GET /losses/summary`) ; valeurs nulles sans valorisation. */
export interface LossLine {
  readonly productId: string | null;
  readonly productionLotId: string | null;
  readonly category: string | null;
  readonly reasonCodeId: string | null;
  readonly declarations: number;
  readonly quantityBase: number;
  readonly valueXaf: number | null;
  readonly pendingQuantityBase: number;
  readonly pendingValueXaf: number | null;
}

export interface LossSummary {
  readonly from: string;
  readonly to: string;
  readonly group_by: LossGroup;
  readonly lines: readonly LossLine[];
  readonly total_value_xaf: number | null;
}

/** Lot de la liste (`GET /production/lots`). */
export interface LotChoice {
  readonly id: string;
  readonly lotCode: string;
  readonly lotType: string;
  readonly productId: string;
  readonly siteId: string;
  readonly status: string;
  readonly startDate: string | null;
  readonly occurredAt: string;
}

/**
 * Coûts et marges d'un lot (`GET /production/lots/{id}` rend `{ lot }`, production-read.controller ;
 * ADR-044) ; sans droit de valorisation, toutes les clés `…Xaf` sont nulles, `sales` reste présent.
 */
export interface LotMargins {
  readonly id: string;
  readonly lotCode: string;
  readonly productId: string;
  readonly status: string;
  readonly costs: {
    readonly breakdown: readonly { readonly costType: string; readonly netXaf: number | null }[];
    readonly netXaf: number | null;
    readonly remainingXaf: number | null;
    readonly costPerHeadXaf: number | null;
  };
  readonly sales: {
    readonly netRevenueXaf: number | null;
    /** Produits des abattages du lot, compris dans le CA du lot (ADR-044 §1 ; AV-279). */
    readonly slaughterProductsRevenueXaf: number | null;
    readonly costOfSalesXaf: number | null;
    readonly soldQuantity: number;
    /** CA net − coût net du lot. */
    readonly lotMarginXaf: number | null;
    /** CA net − coût figé des ventes. */
    readonly grossMarginXaf: number | null;
  };
}

/** Écriture du registre des coûts (`GET /costs`), en ajout seul. */
export interface CostEntry {
  readonly id: string;
  readonly costType: string;
  readonly direction: 'DEBIT' | 'CREDIT';
  readonly amountXaf: number;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly reversesEntryId: string | null;
  readonly occurredAt: string;
  readonly comment: string | null;
}

/** Écritures de la plus récente à la plus ancienne (le serveur les rend par identifiant). */
export function sortCostEntries(entries: readonly CostEntry[]): CostEntry[] {
  return [...entries].sort(
    (a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id),
  );
}

/** Réponse de la fiche d'un lot. */
export interface LotMarginsResponse {
  readonly lot: LotMargins;
}

/** Codes des lots, lus sur le serveur : les lots clôturés ne sont pas sur l'appareil (pertes par lot). */
export const LOT_CODE_PAGE_LIMIT = 200;
export const LOT_CODE_MAX_PAGES = 2;
export const lotCodePaths = () =>
  LOT_STATUSES.map(
    (status) => `/api/v1/production/lots?status=${status}&limit=${LOT_CODE_PAGE_LIMIT}`,
  );

/** Lot sans vente : aucune tête vendue et aucun chiffre d'affaires (montant masqué compté nul). */
export function lotWithoutSales(sales: LotMargins['sales']): boolean {
  return sales.soldQuantity === 0 && (sales.netRevenueXaf ?? 0) === 0;
}

/** Lots réunis de plusieurs lectures : un lot une fois, le plus récent d'abord. */
export function sortLots(lots: readonly LotChoice[]): LotChoice[] {
  return [...new Map(lots.map((lot) => [lot.id, lot])).values()].sort(
    (a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id),
  );
}
