/**
 * Couche sémantique de l'explorateur (P9 ; D11 §7 et §8 ; BR-ANA-004, 006, 007, 009 ; ADR-064 ; AV-371
 * à AV-375). Le catalogue **déclare** les jeux de faits, leurs dimensions et leurs mesures : l'explorateur
 * n'accepte que ce qui y figure (aucune requête libre). Le compilateur du serveur ne construit son SQL
 * qu'à partir des noms déclarés ici, sur la vue `analytics_f_*` du jeu.
 *
 * Ce fichier ne contient aucune entrée-sortie : les colonnes citées sont celles que les vues de P9-13
 * exposent ; un test de la base vérifie qu'elles existent.
 */
import {
  resolveAnalyticsPeriod,
  type AnalyticsPeriod,
  type AnalyticsPeriodCode,
} from './analytics-period.js';
import { isBusinessDay } from './business-day.js';
import { DomainError } from './errors.js';

/** Version du catalogue, figée dans une vue sauvegardée et dans un export (ADR-067). */
export const ANALYTICS_CATALOG_VERSION = 1;

export type DimensionType = 'date' | 'id' | 'code' | 'text' | 'boolean' | 'number';
export type MeasureAggregate = 'SUM' | 'COUNT' | 'COUNT_DISTINCT' | 'AVG' | 'MAX';
export type MeasureUnit = 'xaf' | 'quantity' | 'count' | 'minutes' | 'kg' | 'pct';
export type ScopeKind = 'SITE' | 'ZONE' | 'PERSON';

export interface DimensionDefinition {
  readonly name: string;
  readonly label: string;
  readonly type: DimensionType;
  /** Colonne de la vue (absent : le nom). */
  readonly column?: string;
}

export interface MeasureDefinition {
  readonly name: string;
  readonly label: string;
  readonly aggregate: MeasureAggregate;
  /** Colonne de la vue sur laquelle porte l'agrégat. */
  readonly column: string;
  readonly unit: MeasureUnit;
  /** Valeur au coût : exige `inventory.valuation.read` (BR-ANA-004, RC-05 ; AV-372). */
  readonly protected?: boolean;
  /** Dimension de date sur laquelle le filtre de période de cette mesure porte (ADR-064 §3). */
  readonly periodDimension?: string;
  /** Faux : ni sommable ni cumulable (comptes distincts, moyennes) — aucun total n'est rendu. */
  readonly additive: boolean;
}

export interface DatasetDefinition {
  readonly code: string;
  readonly label: string;
  readonly view: string;
  /** `FLOW` : faits datés, période obligatoire ; `STATE` : solde à l'instant de la lecture. */
  readonly temporality: 'FLOW' | 'STATE';
  /** Permissions de lecture (toutes requises, portée = intersection ; BR-ANA-004). */
  readonly permissions: readonly string[];
  /** Colonne de date de la période (jeux `FLOW`). */
  readonly periodDimension: string | null;
  /** Colonnes de portée par type d'étendue ; un type absent ne rend aucune ligne (règle fermée). */
  readonly scope: Readonly<Partial<Record<ScopeKind, readonly string[]>>>;
  readonly dimensions: readonly DimensionDefinition[];
  readonly measures: readonly MeasureDefinition[];
  /**
   * Document source d'une ligne (BR-ANA-010, niveau 2) : quand l'exploration regroupe par la dimension du document,
   * chaque ligne porte l'identifiant et la route de lecture du document (P9-21).
   */
  readonly source?: SourceDocumentDefinition;
}

export interface SourceDocumentDefinition {
  /** Dimension (de type `id`) qui porte l'identifiant du document de la ligne. */
  readonly dimension: string;
  /** Nature du document (vente, encaissement, mouvement de stock, perte, session…). */
  readonly type: string;
  /** Route de lecture du document ; `{id}` est remplacé par son identifiant (sinon, route de la liste). */
  readonly route: string;
}

const dim = (
  name: string,
  label: string,
  type: DimensionType,
  column?: string,
): DimensionDefinition =>
  column === undefined ? { name, label, type } : { name, label, type, column };

const sum = (
  name: string,
  label: string,
  column: string,
  unit: MeasureUnit,
  extra: Partial<Pick<MeasureDefinition, 'protected' | 'periodDimension'>> = {},
): MeasureDefinition => ({ name, label, aggregate: 'SUM', column, unit, additive: true, ...extra });

const distinct = (
  name: string,
  label: string,
  column: string,
  extra: Partial<Pick<MeasureDefinition, 'periodDimension'>> = {},
): MeasureDefinition => ({
  name,
  label,
  aggregate: 'COUNT_DISTINCT',
  column,
  unit: 'count',
  additive: false,
  ...extra,
});

const BASE_DATASETS: readonly DatasetDefinition[] = [
  {
    code: 'f_sales_line',
    label: 'Lignes de vente',
    view: 'analytics_f_sales_line',
    temporality: 'FLOW',
    permissions: ['sales.sale.read'],
    periodDimension: 'business_day',
    scope: {
      SITE: ['site_id'],
      ZONE: ['zone_id'],
      PERSON: ['owner_user_id'],
    },
    dimensions: [
      dim('business_day', 'Jour de l’événement', 'date'),
      dim('sale_day', 'Jour de la vente', 'date'),
      dim('event_kind', 'Événement (vente ou annulation)', 'code'),
      dim('product_id', 'Produit', 'id'),
      dim('product_category_id', 'Catégorie de produit', 'id'),
      dim('site_id', 'Site', 'id'),
      dim('pos_id', 'Point de vente', 'id'),
      dim('zone_id', 'Zone', 'id'),
      dim('channel', 'Canal', 'code'),
      dim('customer_id', 'Client', 'id'),
      dim('customer_category_id', 'Catégorie de client', 'id'),
      dim('commercial_user_id', 'Commercial', 'id'),
      dim('seller_user_id', 'Vendeur', 'id'),
      dim('sale_type', 'Type de vente', 'code'),
      dim('payment_status', 'Statut de paiement', 'code'),
    ],
    measures: [
      sum('quantity', 'Quantité', 'quantity_base', 'quantity', { periodDimension: 'business_day' }),
      sum('revenue', "Chiffre d'affaires", 'amount_xaf', 'xaf', {
        periodDimension: 'business_day',
      }),
      sum('discount', 'Remise', 'discount_xaf', 'xaf', { periodDimension: 'business_day' }),
      distinct('sales_count', 'Nombre de ventes', 'counted_sale_id', {
        periodDimension: 'business_day',
      }),
      sum('cost', 'Coût des ventes', 'cost_xaf', 'xaf', {
        protected: true,
        periodDimension: 'business_day',
      }),
      sum('margin', 'Marge brute', 'margin_xaf', 'xaf', {
        protected: true,
        periodDimension: 'business_day',
      }),
      sum('net_by_sale_date', 'Net par date de vente', 'amount_xaf', 'xaf', {
        periodDimension: 'sale_day',
      }),
    ],
  },
  {
    code: 'f_orders',
    label: 'Lignes de commande',
    view: 'analytics_f_orders',
    temporality: 'FLOW',
    permissions: ['sales.order.read'],
    periodDimension: 'business_day',
    scope: { SITE: ['site_id'], ZONE: ['zone_id'], PERSON: ['commercial_user_id'] },
    dimensions: [
      dim('business_day', 'Jour de confirmation', 'date'),
      dim('customer_id', 'Client', 'id'),
      dim('commercial_user_id', 'Commercial', 'id'),
      dim('channel', 'Canal', 'code'),
      dim('product_id', 'Produit', 'id'),
      dim('status', 'Statut', 'code'),
      dim('site_id', 'Site', 'id'),
      dim('zone_id', 'Zone', 'id'),
    ],
    measures: [
      distinct('orders_count', 'Commandes', 'order_id'),
      sum('ordered_quantity', 'Quantité commandée', 'ordered_quantity', 'quantity'),
      sum('delivered_quantity', 'Quantité livrée à ce jour', 'delivered_quantity', 'quantity'),
      sum('amount', 'Montant', 'amount_xaf', 'xaf'),
    ],
  },
  {
    code: 'f_payments',
    label: 'Encaissements',
    view: 'analytics_f_payments',
    temporality: 'FLOW',
    permissions: ['sales.payment.read'],
    periodDimension: 'business_day',
    scope: { SITE: ['site_id'], PERSON: ['received_by_user_id'] },
    dimensions: [
      dim('business_day', "Jour de l'événement", 'date'),
      dim('event_kind', 'Événement (encaissement ou annulation)', 'code'),
      dim('payment_method', 'Moyen de paiement', 'code'),
      dim('cash_account_id', 'Compte', 'id'),
      dim('site_id', 'Site', 'id'),
      dim('received_by_user_id', 'Receveur', 'id'),
      dim('customer_id', 'Client', 'id'),
    ],
    measures: [sum('amount', 'Montant encaissé', 'amount_xaf', 'xaf')],
  },
  {
    code: 'f_stock_moves',
    label: 'Mouvements de stock',
    view: 'analytics_f_stock_moves',
    temporality: 'FLOW',
    permissions: ['inventory.ledger.read'],
    periodDimension: 'business_day',
    scope: {
      SITE: ['from_site_id', 'to_site_id'],
      PERSON: ['from_custodian_user_id', 'to_custodian_user_id'],
    },
    dimensions: [
      dim('business_day', 'Jour', 'date'),
      dim('product_id', 'Produit', 'id'),
      dim('from_location_id', 'Emplacement source', 'id'),
      dim('to_location_id', 'Emplacement destination', 'id'),
      dim('move_type', 'Type de mouvement', 'code'),
      dim('is_reversal', 'Contre-écriture', 'boolean'),
      dim('source_doc_type', 'Document source', 'code'),
      dim('reason_code', 'Motif', 'code'),
      dim('stock_lot_id', 'Lot de stock', 'id'),
      dim('from_site_id', 'Site source', 'id'),
      dim('to_site_id', 'Site destination', 'id'),
    ],
    measures: [
      sum('quantity', 'Quantité', 'quantity_base', 'quantity'),
      sum('value', 'Valeur', 'value_xaf', 'xaf', { protected: true }),
    ],
  },
  {
    code: 'f_stock_balance',
    label: 'Soldes de stock',
    view: 'analytics_f_stock_balance',
    temporality: 'STATE',
    permissions: ['inventory.stock.read'],
    periodDimension: null,
    scope: { SITE: ['site_id'], PERSON: ['custodian_user_id'] },
    dimensions: [
      dim('location_id', 'Emplacement', 'id'),
      dim('product_id', 'Produit', 'id'),
      dim('stock_lot_id', 'Lot de stock', 'id'),
      dim('family', 'Famille', 'code'),
      dim('location_type', "Type d'emplacement", 'code'),
      dim('site_id', 'Site', 'id'),
    ],
    measures: [
      sum('balance', 'Solde', 'balance_base', 'quantity'),
      sum('allocated', 'Alloué', 'allocated_base', 'quantity'),
      sum('available', 'Disponible', 'available_base', 'quantity'),
      sum('value', 'Valeur', 'value_xaf', 'xaf', { protected: true }),
    ],
  },
  {
    code: 'f_losses',
    label: 'Pertes déclarées',
    view: 'analytics_f_losses',
    temporality: 'FLOW',
    permissions: ['inventory.loss.read'],
    periodDimension: 'business_day',
    scope: { SITE: ['site_id'], PERSON: ['declared_by'] },
    dimensions: [
      dim('business_day', 'Jour', 'date'),
      dim('category', 'Catégorie', 'code'),
      dim('reason_code', 'Motif', 'code'),
      dim('product_id', 'Produit', 'id'),
      dim('stock_lot_id', 'Lot de stock', 'id'),
      dim('production_lot_id', 'Lot de production', 'id'),
      dim('location_id', 'Emplacement', 'id'),
      dim('declared_by', 'Déclarant', 'id'),
      dim('status', 'Statut', 'code'),
      dim('site_id', 'Site', 'id'),
    ],
    measures: [
      sum('quantity', 'Quantité constatée', 'quantity_base', 'quantity'),
      sum('value', 'Valeur constatée', 'value_xaf', 'xaf', { protected: true }),
      sum(
        'pending_quantity',
        'Quantité en attente de validation',
        'pending_quantity_base',
        'quantity',
      ),
      sum('pending_value', 'Valeur en attente de validation', 'pending_value_xaf', 'xaf', {
        protected: true,
      }),
    ],
  },
  {
    code: 'f_prospecting',
    label: 'Activité commerciale (comptes, visites, conversions)',
    view: 'analytics_f_prospecting',
    temporality: 'FLOW',
    permissions: ['crm.customer.read', 'crm.visit.read'],
    periodDimension: 'business_day',
    scope: { ZONE: ['zone_id'], PERSON: ['user_id'] },
    dimensions: [
      dim('business_day', 'Jour', 'date'),
      dim('event_kind', 'Événement (création, visite, conversion)', 'code'),
      dim('user_id', 'Utilisateur', 'id'),
      dim('zone_id', 'Zone', 'id'),
      dim('source', 'Source', 'code'),
      dim('stage', 'Stade', 'code'),
      dim('result', 'Résultat', 'code'),
    ],
    measures: [
      distinct('accounts_created', 'Comptes créés', 'created_customer_id'),
      distinct('prospects_visited', 'Prospects visités', 'visited_prospect_id'),
      distinct('visits', 'Visites', 'visit_id'),
      distinct('contacts_collected', 'Contacts collectés', 'contact_customer_id'),
      distinct('conversions', 'Nouveaux clients', 'converted_customer_id'),
    ],
  },
  {
    code: 'f_attendance',
    label: 'Présences (sessions de travail)',
    view: 'analytics_f_attendance',
    temporality: 'FLOW',
    permissions: ['fieldwork.session.read'],
    periodDimension: 'business_day',
    // La session ne porte pas de site mais la zone déclarée au pointage : portée par la zone et par la personne
    // (règle fermée pour le site, AV-374).
    scope: { ZONE: ['zone_id'], PERSON: ['user_id'] },
    dimensions: [
      dim('business_day', 'Jour', 'date'),
      dim('user_id', 'Utilisateur', 'id'),
      dim('zone_id', 'Zone déclarée', 'id'),
      dim('status', 'Statut', 'code'),
      dim('override', 'Dérogation', 'boolean'),
    ],
    measures: [
      distinct('presence_days', 'Jours de présence', 'accepted_day_key'),
      sum('sessions', 'Sessions (dérogations comprises)', 'session_count', 'count'),
      sum(
        'duration_minutes',
        'Durée (minutes, dérogations comprises)',
        'duration_minutes',
        'minutes',
      ),
    ],
  },
  {
    code: 'f_production_daily',
    label: 'Production du jour par lot',
    view: 'analytics_f_production_daily',
    temporality: 'FLOW',
    permissions: ['production.lot.read'],
    periodDimension: 'business_day',
    // Les lectures de production ne jugent que le site du lot : pas de portée par personne (jamais plus large).
    scope: { SITE: ['site_id'] },
    dimensions: [
      dim('business_day', 'Jour', 'date'),
      dim('lot_id', 'Lot', 'id'),
      dim('lot_type', 'Type de lot', 'code'),
      dim('site_id', 'Site', 'id'),
      dim('building_id', 'Bâtiment', 'id'),
    ],
    measures: [
      sum('mortality', 'Mortalité', 'mortality_heads', 'count'),
      sum('feed_consumed', 'Aliment consommé', 'feed_quantity', 'kg'),
      sum('eggs_collected', 'Œufs collectés', 'eggs_collected', 'count'),
      sum('eggs_sellable', 'Œufs commercialisables', 'eggs_sellable', 'count'),
      {
        name: 'average_weight',
        label: 'Poids moyen par pesée',
        aggregate: 'AVG',
        column: 'average_weight_kg',
        unit: 'kg',
        additive: false,
      },
    ],
  },
  {
    code: 'f_costs',
    label: 'Écritures de coût',
    view: 'analytics_f_costs',
    temporality: 'FLOW',
    // Un coût est une valeur : le jeu entier exige le droit de valorisation (AV-372, AV-374).
    permissions: ['inventory.valuation.read'],
    periodDimension: 'business_day',
    // Un coût se lit par le site de son objet (comme les lectures de production) : pas de portée par personne.
    scope: { SITE: ['site_id'] },
    dimensions: [
      dim('business_day', 'Jour', 'date'),
      dim('cost_object_type', "Type d'objet de coût", 'code'),
      dim('cost_object_id', 'Objet de coût', 'id'),
      dim('cost_type', 'Type de coût', 'code'),
      dim('site_id', 'Site', 'id'),
    ],
    measures: [sum('amount', 'Montant', 'amount_xaf', 'xaf', { protected: true })],
  },
  {
    code: 'f_expenses',
    label: 'Dépenses',
    view: 'analytics_f_expenses',
    temporality: 'FLOW',
    permissions: ['finance.expense.read'],
    periodDimension: 'business_day',
    scope: { SITE: ['site_id'], PERSON: ['created_by'] },
    dimensions: [
      dim('business_day', 'Jour', 'date'),
      dim('category_id', 'Catégorie', 'id'),
      dim('cost_object_type', "Type d'objet de coût", 'code'),
      dim('site_id', 'Site', 'id'),
      dim('status', 'Statut', 'code'),
    ],
    measures: [
      sum('amount', 'Dépenses valides', 'amount_xaf', 'xaf'),
      sum('pending', 'En attente de validation', 'pending_xaf', 'xaf'),
      sum('unjustified', 'Payées puis refusées (non justifiées)', 'unjustified_xaf', 'xaf'),
    ],
  },
  {
    code: 'f_cash',
    label: 'Mouvements de trésorerie',
    view: 'analytics_f_cash',
    temporality: 'FLOW',
    permissions: ['finance.cash.read'],
    periodDimension: 'business_day',
    scope: { SITE: ['site_id'], PERSON: ['holder_user_id'] },
    dimensions: [
      dim('business_day', 'Jour', 'date'),
      dim('cash_account_id', 'Compte', 'id'),
      dim('movement_type', 'Type de mouvement', 'code'),
      dim('is_reversal', 'Contre-écriture', 'boolean'),
      dim('site_id', 'Site', 'id'),
    ],
    measures: [
      sum('inflow', 'Entrées', 'inflow_xaf', 'xaf'),
      sum('outflow', 'Sorties', 'outflow_xaf', 'xaf'),
    ],
  },
  {
    code: 'f_purchases',
    label: 'Achats (commandes et réceptions)',
    view: 'analytics_f_purchases',
    temporality: 'FLOW',
    permissions: ['procurement.order.read'],
    periodDimension: 'business_day',
    // Les lectures des bons et des réceptions ne jugent que le site : pas de portée par personne.
    scope: { SITE: ['site_id'] },
    dimensions: [
      dim('business_day', 'Jour', 'date'),
      dim('supplier_id', 'Fournisseur', 'id'),
      dim('product_id', 'Produit', 'id'),
      dim('site_id', 'Site', 'id'),
    ],
    measures: [
      sum('ordered', 'Commandé', 'ordered_quantity', 'quantity'),
      sum('delivered', 'Livré', 'delivered_quantity', 'quantity'),
      sum('rejected', 'Rejeté', 'rejected_quantity', 'quantity'),
      sum('accepted', 'Accepté', 'accepted_quantity', 'quantity'),
      sum('amount', 'Montant commandé', 'amount_xaf', 'xaf', { protected: true }),
    ],
  },
];

/**
 * Document source de chaque jeu dont une ligne détaillée est un document (P9-21 ; ADR-065 §6, AV-378) : la dimension
 * est ajoutée au jeu, à côté de ses dimensions déclarées. Les jeux d'agrégats (soldes, production du jour) n'en ont pas.
 */
const DOCUMENT_SOURCES: Readonly<
  Record<string, SourceDocumentDefinition & { readonly label: string }>
> = {
  f_sales_line: {
    dimension: 'sale_id',
    label: 'Vente (document)',
    type: 'SALE',
    route: '/api/v1/sales/{id}',
  },
  f_orders: {
    dimension: 'order_id',
    label: 'Commande (document)',
    type: 'ORDER',
    route: '/api/v1/orders/{id}',
  },
  f_payments: {
    dimension: 'payment_id',
    label: 'Encaissement (document)',
    type: 'PAYMENT',
    route: '/api/v1/payments/{id}',
  },
  f_stock_moves: {
    dimension: 'move_id',
    label: 'Mouvement de stock (document)',
    type: 'STOCK_MOVE',
    route: '/api/v1/stock-moves',
  },
  f_losses: {
    dimension: 'loss_id',
    label: 'Perte (document)',
    type: 'LOSS',
    route: '/api/v1/losses',
  },
  f_prospecting: {
    dimension: 'visit_id',
    label: 'Visite (document)',
    type: 'VISIT',
    route: '/api/v1/visits',
  },
  f_attendance: {
    dimension: 'session_id',
    label: 'Session de travail (document)',
    type: 'WORK_SESSION',
    route: '/api/v1/work-sessions',
  },
  f_costs: {
    dimension: 'entry_id',
    label: 'Écriture de coût (document)',
    type: 'COST_ENTRY',
    route: '/api/v1/costs',
  },
  f_expenses: {
    dimension: 'expense_id',
    label: 'Dépense (document)',
    type: 'EXPENSE',
    route: '/api/v1/expenses/{id}',
  },
  f_cash: {
    dimension: 'movement_id',
    label: 'Mouvement de trésorerie (document)',
    type: 'CASH_MOVEMENT',
    route: '/api/v1/cash-accounts',
  },
  f_purchases: {
    dimension: 'order_id',
    label: 'Bon de commande (document)',
    type: 'PURCHASE_ORDER',
    route: '/api/v1/purchase-orders/{id}',
  },
};

function withDocumentSource(dataset: DatasetDefinition): DatasetDefinition {
  const source = DOCUMENT_SOURCES[dataset.code];
  if (source === undefined) return dataset;
  return {
    ...dataset,
    dimensions: [...dataset.dimensions, dim(source.dimension, source.label, 'id')],
    source: { dimension: source.dimension, type: source.type, route: source.route },
  };
}

export const ANALYTICS_DATASETS: readonly DatasetDefinition[] =
  BASE_DATASETS.map(withDocumentSource);

const DATASETS_BY_CODE: ReadonlyMap<string, DatasetDefinition> = new Map(
  ANALYTICS_DATASETS.map((dataset) => [dataset.code, dataset]),
);

export function datasetOf(code: string): DatasetDefinition | undefined {
  return DATASETS_BY_CODE.get(code);
}

/**
 * Incohérences internes du catalogue (noms en double, mesure dont la dimension de période n'existe pas,
 * jeu sans permission ou sans colonne de portée) : une liste vide pour un catalogue sain (testé).
 */
export function analyticsCatalogIssues(
  datasets: readonly DatasetDefinition[] = ANALYTICS_DATASETS,
): readonly string[] {
  const issues: string[] = [];
  const codes = new Set<string>();
  for (const dataset of datasets) {
    if (codes.has(dataset.code)) issues.push(`Jeu en double : ${dataset.code}`);
    codes.add(dataset.code);
    if (dataset.permissions.length === 0) issues.push(`${dataset.code} : aucune permission`);
    if (Object.values(dataset.scope).every((columns) => columns === undefined)) {
      issues.push(`${dataset.code} : aucune colonne de portée`);
    }
    const dimensionNames = new Set<string>();
    for (const dimension of dataset.dimensions) {
      if (dimensionNames.has(dimension.name)) {
        issues.push(`${dataset.code} : dimension en double ${dimension.name}`);
      }
      dimensionNames.add(dimension.name);
    }
    if (dataset.temporality === 'FLOW') {
      const period = dataset.dimensions.find((d) => d.name === dataset.periodDimension);
      if (period === undefined || period.type !== 'date') {
        issues.push(`${dataset.code} : dimension de période absente ou non datée`);
      }
    }
    const measureNames = new Set<string>();
    for (const measure of dataset.measures) {
      if (measureNames.has(measure.name)) {
        issues.push(`${dataset.code} : mesure en double ${measure.name}`);
      }
      measureNames.add(measure.name);
      if (dimensionNames.has(measure.name)) {
        issues.push(`${dataset.code} : ${measure.name} est à la fois dimension et mesure`);
      }
      if (measure.periodDimension !== undefined) {
        const period = dataset.dimensions.find((d) => d.name === measure.periodDimension);
        if (period === undefined || period.type !== 'date') {
          issues.push(`${dataset.code}.${measure.name} : dimension de période inconnue`);
        }
      }
    }
  }
  return issues;
}

// --- Validation d'une définition d'exploration ------------------------------------------------------

export const EXPLORATION_FILTER_OPS = [
  'EQ',
  'NE',
  'IN',
  'GTE',
  'LTE',
  'BETWEEN',
  'CONTAINS',
] as const;
export type ExplorationFilterOp = (typeof EXPLORATION_FILTER_OPS)[number];

export interface ExplorationFilter {
  readonly field: string;
  readonly op: ExplorationFilterOp;
  readonly value: unknown;
}

export interface ExplorationSort {
  readonly field: string;
  readonly direction: 'ASC' | 'DESC';
}

export interface ExplorationDefinition {
  readonly dataset: string;
  readonly period?: {
    readonly code: AnalyticsPeriodCode;
    readonly fromDay?: string | undefined;
    readonly toDay?: string | undefined;
  };
  readonly dimensions: readonly string[];
  readonly measures: readonly string[];
  readonly filters: readonly ExplorationFilter[];
  readonly sort: readonly ExplorationSort[];
  readonly limit?: number | undefined;
}

export interface ExplorationContext {
  /** Jour métier courant. */
  readonly today: string;
  /** Le demandeur détient `inventory.valuation.read` (mesures protégées). */
  readonly canReadValuation: boolean;
  /** Durée maximale d'une période détaillée en jours (3 ans, D11 §8). */
  readonly maxDetailDays: number;
  /** Nombre maximal de lignes affichées (BR-ANA-006 : 10 000). */
  readonly maxRows: number;
}

export const EXPLORATION_LIMITS = {
  maxMeasures: 10,
  maxDimensions: 6,
  maxFilters: 20,
  maxSort: 3,
  maxInValues: 100,
} as const;

export type ExplorationErrorCode =
  | 'ANALYTICS_FIELD_UNKNOWN'
  | 'FORBIDDEN_MEASURE'
  | 'PERIOD_TOO_LONG'
  | 'QUERY_LIMIT_EXCEEDED'
  | 'ANALYTICS_MIXED_PERIOD_BASIS'
  | 'ANALYTICS_PERIOD_REQUIRED'
  | 'ANALYTICS_DEFINITION_INVALID';

export interface ResolvedFilter {
  readonly dimension: DimensionDefinition;
  readonly op: ExplorationFilterOp;
  readonly value: string | number | boolean | readonly (string | number)[];
}

export interface ExplorationPlan {
  readonly dataset: DatasetDefinition;
  readonly period: AnalyticsPeriod | null;
  /** Dimension de date sur laquelle porte la période (celle des mesures, sinon celle du jeu). */
  readonly periodDimension: string | null;
  readonly dimensions: readonly DimensionDefinition[];
  readonly measures: readonly MeasureDefinition[];
  readonly filters: readonly ResolvedFilter[];
  readonly sort: readonly ExplorationSort[];
  readonly limit: number;
  /** Aucun total n'est rendu si une mesure n'est pas additive. */
  readonly totalsAllowed: boolean;
  readonly catalogVersion: number;
}

export type ExplorationValidation =
  | { readonly ok: true; readonly plan: ExplorationPlan }
  | {
      readonly ok: false;
      readonly code: ExplorationErrorCode;
      readonly field?: string;
      readonly message: string;
    };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[A-Za-z0-9_.:-]{1,60}$/;

const OPS_BY_TYPE: Readonly<Record<DimensionType, readonly ExplorationFilterOp[]>> = {
  date: ['EQ', 'GTE', 'LTE', 'BETWEEN'],
  id: ['EQ', 'NE', 'IN'],
  code: ['EQ', 'NE', 'IN'],
  text: ['EQ', 'IN', 'CONTAINS'],
  boolean: ['EQ'],
  number: ['EQ', 'GTE', 'LTE', 'BETWEEN'],
};

function fail(
  code: ExplorationErrorCode,
  message: string,
  field?: string,
): Extract<ExplorationValidation, { ok: false }> {
  return field === undefined ? { ok: false, code, message } : { ok: false, code, message, field };
}

function scalarValid(type: DimensionType, value: unknown): value is string | number | boolean {
  switch (type) {
    case 'id':
      return typeof value === 'string' && UUID_RE.test(value);
    case 'code':
      return typeof value === 'string' && CODE_RE.test(value);
    case 'text':
      return typeof value === 'string' && value.length >= 1 && value.length <= 120;
    case 'date':
      // Un jour du calendrier : `2026-02-30` a la bonne forme mais n'existe pas (P9-25, EP-3).
      return typeof value === 'string' && isBusinessDay(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
  }
}

function resolveFilter(
  dataset: DatasetDefinition,
  filter: ExplorationFilter,
): { ok: true; filter: ResolvedFilter } | Extract<ExplorationValidation, { ok: false }> {
  const dimension = dataset.dimensions.find((d) => d.name === filter.field);
  if (dimension === undefined) {
    return fail(
      'ANALYTICS_FIELD_UNKNOWN',
      `Filtre sur un champ inconnu : ${filter.field}.`,
      filter.field,
    );
  }
  if (!OPS_BY_TYPE[dimension.type].includes(filter.op)) {
    return fail(
      'ANALYTICS_DEFINITION_INVALID',
      `Opérateur ${filter.op} non admis sur ${dimension.name} (${dimension.type}).`,
      filter.field,
    );
  }
  const { op, value } = filter;
  if (op === 'IN') {
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.length > EXPLORATION_LIMITS.maxInValues ||
      !value.every((item) => scalarValid(dimension.type, item) && typeof item !== 'boolean')
    ) {
      return fail(
        'ANALYTICS_DEFINITION_INVALID',
        `Valeurs invalides pour ${dimension.name}.`,
        filter.field,
      );
    }
    return { ok: true, filter: { dimension, op, value: value as readonly (string | number)[] } };
  }
  if (op === 'BETWEEN') {
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      !value.every((item) => scalarValid(dimension.type, item) && typeof item !== 'boolean') ||
      (value[0] as string | number) > (value[1] as string | number)
    ) {
      return fail(
        'ANALYTICS_DEFINITION_INVALID',
        `Intervalle invalide pour ${dimension.name}.`,
        filter.field,
      );
    }
    return { ok: true, filter: { dimension, op, value: value as readonly (string | number)[] } };
  }
  if (!scalarValid(dimension.type, value)) {
    return fail(
      'ANALYTICS_DEFINITION_INVALID',
      `Valeur invalide pour ${dimension.name}.`,
      filter.field,
    );
  }
  return { ok: true, filter: { dimension, op, value } };
}

/**
 * Valide une définition d'exploration contre le catalogue et rend le plan normalisé que le compilateur
 * exécute. N'accepte que des jeux, dimensions, mesures et filtres déclarés (BR-ANA-006). Ne dit rien des
 * droits de lecture du jeu ni de l'étendue des lignes : ce sont des contrôles du serveur (ADR-064 §4).
 */
export function validateExploration(
  definition: ExplorationDefinition,
  context: ExplorationContext,
  datasets: readonly DatasetDefinition[] = ANALYTICS_DATASETS,
): ExplorationValidation {
  const dataset = datasets.find((d) => d.code === definition.dataset);
  if (dataset === undefined) {
    return fail(
      'ANALYTICS_FIELD_UNKNOWN',
      `Jeu de faits inconnu : ${definition.dataset}.`,
      'dataset',
    );
  }

  if (definition.measures.length === 0) {
    return fail('ANALYTICS_DEFINITION_INVALID', 'Au moins une mesure est exigée.', 'measures');
  }
  if (definition.measures.length > EXPLORATION_LIMITS.maxMeasures) {
    return fail('ANALYTICS_DEFINITION_INVALID', 'Trop de mesures.', 'measures');
  }
  if (definition.dimensions.length > EXPLORATION_LIMITS.maxDimensions) {
    return fail('ANALYTICS_DEFINITION_INVALID', 'Trop de dimensions.', 'dimensions');
  }
  if (definition.filters.length > EXPLORATION_LIMITS.maxFilters) {
    return fail('ANALYTICS_DEFINITION_INVALID', 'Trop de filtres.', 'filters');
  }
  if (definition.sort.length > EXPLORATION_LIMITS.maxSort) {
    return fail('ANALYTICS_DEFINITION_INVALID', 'Trop de tris.', 'sort');
  }
  if (
    new Set(definition.dimensions).size !== definition.dimensions.length ||
    new Set(definition.measures).size !== definition.measures.length
  ) {
    return fail('ANALYTICS_DEFINITION_INVALID', 'Dimension ou mesure répétée.');
  }

  const dimensions: DimensionDefinition[] = [];
  for (const name of definition.dimensions) {
    const found = dataset.dimensions.find((d) => d.name === name);
    if (found === undefined) {
      return fail('ANALYTICS_FIELD_UNKNOWN', `Dimension inconnue : ${name}.`, name);
    }
    dimensions.push(found);
  }

  const measures: MeasureDefinition[] = [];
  for (const name of definition.measures) {
    const found = dataset.measures.find((m) => m.name === name);
    if (found === undefined) {
      return fail('ANALYTICS_FIELD_UNKNOWN', `Mesure inconnue : ${name}.`, name);
    }
    if (found.protected === true && !context.canReadValuation) {
      return fail(
        'FORBIDDEN_MEASURE',
        `La mesure « ${found.label} » exige le droit de valorisation du stock.`,
        name,
      );
    }
    measures.push(found);
  }

  const filters: ResolvedFilter[] = [];
  for (const raw of definition.filters) {
    const resolved = resolveFilter(dataset, raw);
    if (!resolved.ok) return resolved;
    filters.push(resolved.filter);
  }

  // Colonne de période : toutes les mesures doivent partager la même (ADR-064 §3).
  const bases = new Set(
    measures.map((m) => m.periodDimension ?? dataset.periodDimension).filter((b) => b !== null),
  );
  if (bases.size > 1) {
    return fail(
      'ANALYTICS_MIXED_PERIOD_BASIS',
      'Les mesures demandées portent sur des dates différentes : une requête par date de référence.',
      'measures',
    );
  }
  const periodDimension = bases.size === 1 ? [...bases][0]! : null;

  let period: AnalyticsPeriod | null = null;
  if (dataset.temporality === 'FLOW') {
    if (definition.period === undefined) {
      return fail(
        'ANALYTICS_PERIOD_REQUIRED',
        'Une période est obligatoire pour ce jeu.',
        'period',
      );
    }
    try {
      period = resolveAnalyticsPeriod({
        code: definition.period.code,
        today: context.today,
        fromDay: definition.period.fromDay,
        toDay: definition.period.toDay,
        maxDays: context.maxDetailDays,
      });
    } catch (error) {
      if (error instanceof DomainError && error.code === 'PERIOD_TOO_LONG') {
        return fail('PERIOD_TOO_LONG', error.message, 'period');
      }
      if (error instanceof DomainError) {
        return fail('ANALYTICS_DEFINITION_INVALID', error.message, 'period');
      }
      throw error;
    }
  } else if (definition.period !== undefined) {
    return fail(
      'ANALYTICS_DEFINITION_INVALID',
      'Ce jeu rend l’état à l’instant de la lecture : pas de période.',
      'period',
    );
  }

  const selectable = new Set<string>([...definition.dimensions, ...definition.measures]);
  for (const sort of definition.sort) {
    if (!selectable.has(sort.field)) {
      return fail(
        'ANALYTICS_DEFINITION_INVALID',
        `Tri sur un champ non demandé : ${sort.field}.`,
        sort.field,
      );
    }
  }

  const limit = definition.limit ?? context.maxRows;
  if (!Number.isInteger(limit) || limit < 1) {
    return fail('ANALYTICS_DEFINITION_INVALID', 'Limite de lignes invalide.', 'limit');
  }
  if (limit > context.maxRows) {
    return fail(
      'QUERY_LIMIT_EXCEEDED',
      `Au plus ${context.maxRows} lignes : affinez la requête.`,
      'limit',
    );
  }

  return {
    ok: true,
    plan: {
      dataset,
      period,
      periodDimension,
      dimensions,
      measures,
      filters,
      sort: definition.sort,
      limit,
      totalsAllowed: measures.every((m) => m.additive),
      catalogVersion: ANALYTICS_CATALOG_VERSION,
    },
  };
}
