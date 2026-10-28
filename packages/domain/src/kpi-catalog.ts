/**
 * Registre des indicateurs (P9 ; D11 §7.1 ; BR-ANA-009 ; ADR-065 §1) : un enregistrement par code `KPI-*`
 * avec sa **fonction de référence** — celle que le tableau de bord, l'accueil et l'instantané appellent,
 * et que l'explorateur doit reproduire par sa vue (test d'équivalence, AT-054).
 *
 * `state` dit où en est la fonction : `EXISTING` (la fonction est exportée par l'API publique de son module : un
 * essai du serveur le vérifie) ou `TO_CREATE` (fonction de référence à écrire : l'indicateur est défini par D11
 * §7.1 mais aucun tableau, accueil ni instantané ne l'affiche ; il n'y entre qu'avec sa fonction et son essai
 * d'équivalence, AV-462).
 */

import type { ExplorationFilter } from './analytics-catalog.js';

/** Nature : un flux (somme sur la période), un solde ou un état à un instant, ou un ratio dérivé. */
export type KpiNature = 'FLOW' | 'INSTANT' | 'RATIO';
export type KpiReferenceState = 'EXISTING' | 'TO_CREATE';

export interface KpiDefinition {
  readonly code: string;
  readonly label: string;
  readonly nature: KpiNature;
  /** Module propriétaire de la fonction de référence (API publique). */
  readonly module: string;
  /** Nom de la fonction de référence. */
  readonly reference: string;
  readonly state: KpiReferenceState;
  /**
   * Jeu, mesure et filtres de l'explorateur qui reproduisent **exactement** l'indicateur (AT-054) ; absent quand
   * aucune mesure de l'explorateur ne lui est égale (AV-329), le lien d'exploration du tableau restant un détail.
   */
  readonly explorer?: {
    readonly dataset: string;
    readonly measure: string;
    readonly filters?: readonly ExplorationFilter[];
  };
  /** Valeur au coût : masquée ou refusée sans `inventory.valuation.read` (RC-05). */
  readonly protected?: boolean;
}

function kpi(definition: KpiDefinition): KpiDefinition {
  return definition;
}

export const KPI_CATALOG: readonly KpiDefinition[] = [
  // --- Commercial -------------------------------------------------------------------------------------
  kpi({
    code: 'KPI-COM-01',
    label: 'Prospects créés',
    nature: 'FLOW',
    module: 'crm',
    reference: 'portfolioActivity',
    state: 'EXISTING',
    explorer: { dataset: 'f_prospecting', measure: 'accounts_created' },
  }),
  kpi({
    code: 'KPI-COM-02',
    label: 'Prospects visités',
    nature: 'FLOW',
    module: 'crm',
    reference: 'portfolioActivity',
    state: 'EXISTING',
    explorer: { dataset: 'f_prospecting', measure: 'prospects_visited' },
  }),
  kpi({
    code: 'KPI-COM-03',
    label: 'Visites',
    nature: 'FLOW',
    module: 'crm',
    reference: 'portfolioActivity',
    state: 'EXISTING',
    explorer: { dataset: 'f_prospecting', measure: 'visits' },
  }),
  kpi({
    code: 'KPI-COM-04',
    label: 'Contacts collectés',
    nature: 'FLOW',
    module: 'crm',
    reference: 'portfolioActivity',
    state: 'EXISTING',
    explorer: { dataset: 'f_prospecting', measure: 'contacts_collected' },
  }),
  kpi({
    code: 'KPI-COM-05',
    label: 'Nouveaux clients',
    nature: 'FLOW',
    module: 'crm',
    reference: 'portfolioActivity',
    state: 'EXISTING',
    explorer: { dataset: 'f_prospecting', measure: 'conversions' },
  }),
  kpi({
    code: 'KPI-COM-06',
    label: 'Commandes',
    nature: 'FLOW',
    module: 'sales',
    reference: 'ordersActivity',
    state: 'EXISTING',
    explorer: { dataset: 'f_orders', measure: 'orders_count' },
  }),
  kpi({
    code: 'KPI-COM-07',
    label: 'Ventes',
    nature: 'FLOW',
    module: 'sales',
    reference: 'salesActivityByDay',
    state: 'EXISTING',
    explorer: { dataset: 'f_sales_line', measure: 'sales_count' },
  }),
  kpi({
    code: 'KPI-COM-08',
    label: "Chiffre d'affaires",
    nature: 'FLOW',
    module: 'sales',
    reference: 'salesActivityByDay',
    state: 'EXISTING',
    explorer: { dataset: 'f_sales_line', measure: 'revenue' },
  }),
  kpi({
    code: 'KPI-COM-09',
    label: 'Quantité vendue',
    nature: 'FLOW',
    module: 'sales',
    reference: 'salesActivityByDay',
    state: 'EXISTING',
    explorer: { dataset: 'f_sales_line', measure: 'quantity' },
  }),
  kpi({
    code: 'KPI-COM-10',
    label: 'Panier moyen',
    nature: 'RATIO',
    module: 'sales',
    reference: 'sumSalesActivity',
    state: 'EXISTING',
  }),
  kpi({
    code: 'KPI-COM-11',
    label: 'Taux de conversion (cohorte)',
    nature: 'RATIO',
    module: 'crm',
    reference: 'conversionCohort',
    state: 'EXISTING',
  }),
  kpi({
    code: 'KPI-COM-12',
    label: 'Taux visite → commande',
    nature: 'RATIO',
    module: 'crm',
    reference: 'visitToOrderRate',
    state: 'EXISTING',
  }),
  kpi({
    code: 'KPI-COM-13',
    label: 'Clients actifs',
    nature: 'INSTANT',
    module: 'crm',
    reference: 'portfolioHealth',
    state: 'EXISTING',
  }),
  kpi({
    code: 'KPI-COM-14',
    label: 'Clients inactifs',
    nature: 'INSTANT',
    module: 'crm',
    reference: 'portfolioHealth',
    state: 'EXISTING',
  }),
  kpi({
    code: 'KPI-COM-15',
    label: 'Taux de réachat',
    nature: 'RATIO',
    module: 'sales',
    reference: 'repurchaseRate',
    state: 'EXISTING',
  }),
  kpi({
    code: 'KPI-COM-16',
    label: "Atteinte d'objectif",
    nature: 'RATIO',
    // Le réalisé d'une cible compose `crm.listTargets` et `commercialEffort` avec `sales.periodRevenue` et
    // `periodProductQuantity` (crm-read.controller.ts) ; `crm` n'importe pas `sales` (graphe) : la fonction ne peut
    // vivre que dans `sales`. Aucune fonction publique aujourd'hui (EP-5, AV-462).
    module: 'sales',
    reference: 'targetAttainment',
    state: 'TO_CREATE',
  }),
  kpi({
    code: 'KPI-COM-17',
    label: 'Jours de présence',
    nature: 'FLOW',
    module: 'fieldwork',
    reference: 'attendanceDays',
    state: 'EXISTING',
    explorer: { dataset: 'f_attendance', measure: 'presence_days' },
  }),
  kpi({
    code: 'KPI-COM-18',
    label: 'CA du portefeuille acquis',
    nature: 'FLOW',
    module: 'sales',
    reference: 'periodRevenue',
    state: 'EXISTING',
  }),
  // --- Stock ------------------------------------------------------------------------------------------
  kpi({
    code: 'KPI-STK-01',
    label: 'Stock disponible',
    nature: 'INSTANT',
    module: 'inventory',
    reference: 'stockHealth',
    state: 'EXISTING',
    explorer: { dataset: 'f_stock_balance', measure: 'available' },
  }),
  kpi({
    code: 'KPI-STK-02',
    label: 'Valeur du stock',
    nature: 'INSTANT',
    module: 'inventory',
    reference: 'stockHealth',
    state: 'EXISTING',
    explorer: { dataset: 'f_stock_balance', measure: 'value' },
    protected: true,
  }),
  kpi({
    code: 'KPI-STK-03',
    label: 'Pertes',
    nature: 'FLOW',
    module: 'inventory',
    reference: 'lossValueSummary',
    state: 'EXISTING',
    // Nombre de déclarations : l'explorateur ne compte pas les déclarations (AV-329).
  }),
  kpi({
    code: 'KPI-STK-04',
    label: "Écarts d'inventaire",
    nature: 'FLOW',
    module: 'inventory',
    reference: 'inventoryVarianceSummary',
    state: 'EXISTING',
    // Gains moins pertes : les mouvements de l'explorateur ne sont pas signés (AV-329).
    // Valeur nette des écarts d'inventaire : une valeur au coût (AV-372), masquée par le tableau (TB-7).
    protected: true,
  }),
  kpi({
    code: 'KPI-STK-05',
    label: 'Couverture',
    nature: 'RATIO',
    module: 'inventory',
    reference: 'stockCoverage',
    state: 'EXISTING',
  }),
  kpi({
    code: 'KPI-STK-06',
    label: 'Ruptures',
    nature: 'INSTANT',
    module: 'inventory',
    reference: 'stockHealth',
    state: 'EXISTING',
  }),
  // --- Distribution -----------------------------------------------------------------------------------
  kpi({
    code: 'KPI-DIS-01',
    label: 'Envoyé (par PDV)',
    nature: 'FLOW',
    module: 'inventory',
    reference: 'locationFlows',
    state: 'EXISTING',
  }),
  kpi({
    code: 'KPI-DIS-02',
    label: 'Reçu (par PDV)',
    nature: 'FLOW',
    module: 'inventory',
    reference: 'locationFlows',
    state: 'EXISTING',
  }),
  kpi({
    code: 'KPI-DIS-03',
    label: 'Vendu (par PDV)',
    nature: 'FLOW',
    module: 'sales',
    reference: 'soldByLocation',
    state: 'EXISTING',
  }),
  kpi({
    code: 'KPI-DIS-04',
    label: 'Perdu (par PDV)',
    nature: 'FLOW',
    module: 'inventory',
    reference: 'locationFlows',
    state: 'EXISTING',
  }),
  kpi({
    code: 'KPI-DIS-05',
    label: 'Valeur du restant (par PDV)',
    nature: 'INSTANT',
    module: 'inventory',
    reference: 'locationFlows',
    state: 'EXISTING',
    // Le tableau n'expose ce code que sous forme de valeur du restant (xaf), valeur au coût : masquée sans
    // `inventory.valuation.read` (TB-7, y compris à la lecture de l'instantané).
    protected: true,
  }),
  kpi({
    code: 'KPI-DIS-06',
    label: 'Encaissé (par PDV)',
    nature: 'FLOW',
    module: 'sales',
    reference: 'cashedByGroup',
    state: 'EXISTING',
  }),
  kpi({
    code: 'KPI-DIS-07',
    label: 'À réapprovisionner (par PDV)',
    nature: 'INSTANT',
    module: 'inventory',
    reference: 'stockThresholdsOf',
    state: 'EXISTING',
  }),
  kpi({
    code: 'KPI-DIS-QUOTAS',
    label: 'Quotas échus ou en révocation',
    nature: 'INSTANT',
    module: 'inventory',
    reference: 'allocationPositions',
    state: 'EXISTING',
  }),
  // --- Production -------------------------------------------------------------------------------------
  kpi({
    code: 'KPI-PRD-01',
    label: 'Effectif',
    nature: 'INSTANT',
    module: 'production',
    reference: 'productionOverview',
    state: 'EXISTING',
  }),
  kpi({
    code: 'KPI-PRD-02',
    label: 'Mortalité',
    nature: 'FLOW',
    module: 'inventory',
    reference: 'mortalitySummary',
    state: 'EXISTING',
    // Toutes les déclarations de mortalité constatées, lot de production ou non (AV-329).
    explorer: {
      dataset: 'f_losses',
      measure: 'quantity',
      filters: [{ field: 'category', op: 'EQ', value: 'MORTALITE' }],
    },
  }),
  kpi({
    code: 'KPI-PRD-03',
    label: 'Taux de mortalité cumulé',
    nature: 'RATIO',
    module: 'production',
    reference: 'cumulativeMortalityRate',
    state: 'EXISTING',
  }),
  kpi({
    code: 'KPI-PRD-04',
    label: "Consommation d'aliment",
    nature: 'FLOW',
    module: 'production',
    reference: 'feedConsumption',
    state: 'TO_CREATE',
    // Par lot et par jour : `costObjectConsumptionsByDay` (inventory), sans somme sur un périmètre. Lien
    // d'exploration (`feed_consumed`) à confirmer par l'essai d'équivalence (D11 §7.1 cite `f_stock_moves`) ;
    // il n'est posé qu'avec cet essai (EP-5, AV-462).
  }),
  kpi({
    code: 'KPI-PRD-05',
    label: 'Poids moyen',
    nature: 'INSTANT',
    module: 'production',
    reference: 'latestWeighing',
    state: 'TO_CREATE',
    // La fiche du lot liste les pesées ; la mesure `average_weight` de l'explorateur est la moyenne des pesées de
    // la période, non la dernière (AV-329) : pas de lien d'exploration (EP-5, AV-462).
  }),
  kpi({
    code: 'KPI-PRD-06',
    label: 'Œufs collectés, commercialisables, à couver, cassés, non conformes',
    nature: 'FLOW',
    module: 'production',
    reference: 'eggSummary',
    state: 'EXISTING',
    explorer: { dataset: 'f_production_daily', measure: 'eggs_collected' },
  }),
  kpi({
    code: 'KPI-PRD-07',
    label: "Taux d'œufs commercialisables",
    nature: 'RATIO',
    module: 'production',
    reference: 'eggSummary',
    state: 'EXISTING',
  }),
  kpi({
    code: 'KPI-PRD-08',
    label: "Taux d'éclosion",
    nature: 'RATIO',
    module: 'production',
    reference: 'hatchRate',
    state: 'EXISTING',
  }),
  kpi({
    code: 'KPI-PRD-09',
    label: 'Coût par tête',
    nature: 'RATIO',
    module: 'production',
    reference: 'costPerHead',
    state: 'TO_CREATE',
    // Par lot : `getProductionLot().costs.costPerHeadXaf` (coût restant ÷ effectif non vendu, BR-PRD-012) ; aucune
    // fonction publique de ce nom (EP-5, AV-462).
    protected: true,
  }),
  kpi({
    code: 'KPI-PRD-10',
    label: 'Marge du lot',
    nature: 'FLOW',
    module: 'sales',
    reference: 'lotRevenue',
    state: 'EXISTING',
    protected: true,
  }),
  // --- Finance ----------------------------------------------------------------------------------------
  kpi({
    code: 'KPI-FIN-01',
    label: 'Encaissé',
    nature: 'FLOW',
    module: 'sales',
    reference: 'cashedActivity',
    state: 'EXISTING',
    explorer: { dataset: 'f_payments', measure: 'amount' },
  }),
  kpi({
    code: 'KPI-FIN-02',
    label: 'Créances',
    nature: 'INSTANT',
    module: 'sales',
    reference: 'listReceivables',
    state: 'EXISTING',
  }),
  kpi({
    code: 'KPI-FIN-03',
    label: 'Créances en retard',
    nature: 'INSTANT',
    module: 'sales',
    reference: 'listReceivables',
    state: 'EXISTING',
  }),
  kpi({
    code: 'KPI-FIN-04',
    label: 'Dépenses',
    nature: 'FLOW',
    module: 'finance',
    reference: 'expensesSummary',
    state: 'EXISTING',
    explorer: { dataset: 'f_expenses', measure: 'amount' },
  }),
  kpi({
    code: 'KPI-FIN-05',
    label: 'Dettes fournisseurs',
    nature: 'INSTANT',
    module: 'finance',
    reference: 'supplierPayables',
    state: 'EXISTING',
  }),
  kpi({
    code: 'KPI-FIN-06',
    label: 'Trésorerie',
    nature: 'INSTANT',
    module: 'finance',
    reference: 'listCashAccounts',
    state: 'EXISTING',
  }),
  kpi({
    code: 'KPI-FIN-07',
    label: 'Coût des ventes et marge brute',
    nature: 'FLOW',
    module: 'sales',
    reference: 'periodRevenue',
    state: 'EXISTING',
    explorer: { dataset: 'f_sales_line', measure: 'margin' },
    protected: true,
  }),
  kpi({
    code: 'KPI-FIN-08',
    label: 'Valeur des pertes',
    nature: 'FLOW',
    module: 'inventory',
    reference: 'lossValueSummary',
    state: 'EXISTING',
    explorer: { dataset: 'f_losses', measure: 'value' },
    protected: true,
  }),
  kpi({
    code: 'KPI-FIN-CS-PENDING',
    label: 'Sessions de caisse à valider',
    nature: 'INSTANT',
    module: 'finance',
    reference: 'cashSessionsOverview',
    state: 'EXISTING',
  }),
  kpi({
    code: 'KPI-FIN-CS-VAR',
    label: 'Écarts de caisse du jour',
    nature: 'INSTANT',
    module: 'finance',
    reference: 'cashSessionsOverview',
    state: 'EXISTING',
  }),
  kpi({
    code: 'KPI-FIN-TRANSFERS',
    label: 'Remises de fonds en transit ou en écart',
    nature: 'INSTANT',
    module: 'finance',
    reference: 'pendingCashTransfers',
    state: 'EXISTING',
  }),
  // --- Achats -----------------------------------------------------------------------------------------
  kpi({
    code: 'KPI-APP-01',
    label: 'Taux de service fournisseur',
    nature: 'RATIO',
    module: 'procurement',
    reference: 'supplierServiceRate',
    state: 'EXISTING',
    explorer: { dataset: 'f_purchases', measure: 'accepted' },
  }),
  kpi({
    code: 'KPI-APP-02',
    label: 'Taux de rejet',
    nature: 'RATIO',
    module: 'procurement',
    reference: 'receiptRejectRate',
    state: 'EXISTING',
    explorer: { dataset: 'f_purchases', measure: 'rejected' },
  }),
  // --- Exploitation -----------------------------------------------------------------------------------
  kpi({
    code: 'KPI-OPS-01',
    label: 'Fraîcheur de synchronisation',
    nature: 'INSTANT',
    module: 'sync',
    reference: 'deviceFreshness',
    state: 'EXISTING',
  }),
  kpi({
    code: 'KPI-OPS-02',
    label: 'Opérations en attente et conflits ouverts',
    nature: 'INSTANT',
    module: 'sync',
    reference: 'syncBacklog',
    state: 'TO_CREATE',
    // Conflits ouverts : `openConflictSummary` (platform/sync/conflicts.ts) ; opérations en attente : `pending_reported`
    // par appareil (`deviceFreshness`) ; leur somme sous une étendue n'a pas de fonction (EP-5, AV-462).
  }),
];

const BY_CODE: ReadonlyMap<string, KpiDefinition> = new Map(KPI_CATALOG.map((k) => [k.code, k]));

export function kpiDefinitionOf(code: string): KpiDefinition | undefined {
  return BY_CODE.get(code);
}

/**
 * Un indicateur tel que le tableau le rend sans `inventory.valuation.read` (TB-7) : si le registre le marque
 * protégé, valeur, période précédente, variation et lien d'exploration passent à `null` (les champs absents le
 * restent) ; sinon il est rendu tel quel. Règle de `kpi()` des blocs du tableau, appliquée aussi à la lecture d'un
 * instantané calculé quand le droit existait.
 */
export function maskProtectedKpi<T extends { readonly code: string }>(entry: T): T {
  if (BY_CODE.get(entry.code)?.protected !== true) return entry;
  return {
    ...entry,
    value: null,
    ...('previousValue' in entry ? { previousValue: null } : {}),
    ...('variationPct' in entry ? { variationPct: null } : {}),
    ...('explore' in entry ? { explore: null } : {}),
  } as T;
}

/** Indicateurs dont la fonction de référence reste à écrire (cinq depuis la revue de P9-25, AV-462). */
export function kpisToCreate(): readonly KpiDefinition[] {
  return KPI_CATALOG.filter((k) => k.state === 'TO_CREATE');
}

/**
 * La valeur « de la période précédente » n'a de sens que pour un flux (ADR-066 §2) : un solde, un
 * effectif ou une couverture à l'instant ne se comparent pas à un instant passé.
 */
export function kpiHasPreviousPeriod(code: string): boolean {
  return BY_CODE.get(code)?.nature === 'FLOW';
}
