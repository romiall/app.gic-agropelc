/**
 * Registre des indicateurs (P9 ; D11 §7.1 ; BR-ANA-009 ; ADR-065 §1) : un enregistrement par code `KPI-*`
 * avec sa **fonction de référence** — celle que le tableau de bord, l'accueil et l'instantané appellent,
 * et que l'explorateur doit reproduire par sa vue (test d'équivalence, AT-054).
 *
 * `state` dit où en est la fonction : `EXISTING` (livrée avant P9, API publique du module),
 * `TO_CREATE` (fichier nouveau de l'API publique du module propriétaire ; plus aucun depuis P9-15) ou `TO_VERIFY`
 * (existence ou forme à confirmer au moment de la brancher). Un indicateur à créer n'entre pas dans un
 * tableau avant sa fonction de référence et son test.
 */

/** Nature : un flux (somme sur la période), un solde ou un état à un instant, ou un ratio dérivé. */
export type KpiNature = 'FLOW' | 'INSTANT' | 'RATIO';
export type KpiReferenceState = 'EXISTING' | 'TO_CREATE' | 'TO_VERIFY';

export interface KpiDefinition {
  readonly code: string;
  readonly label: string;
  readonly nature: KpiNature;
  /** Module propriétaire de la fonction de référence (API publique). */
  readonly module: string;
  /** Nom de la fonction de référence. */
  readonly reference: string;
  readonly state: KpiReferenceState;
  /** Jeu et mesure de l'explorateur qui reproduisent l'indicateur (absent : pas de vue). */
  readonly explorer?: { readonly dataset: string; readonly measure: string };
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
    module: 'crm',
    reference: 'targetAttainment',
    state: 'TO_VERIFY',
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
    explorer: { dataset: 'f_losses', measure: 'quantity' },
  }),
  kpi({
    code: 'KPI-STK-04',
    label: "Écarts d'inventaire",
    nature: 'FLOW',
    module: 'inventory',
    reference: 'inventoryVarianceSummary',
    state: 'EXISTING',
    explorer: { dataset: 'f_stock_moves', measure: 'quantity' },
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
    label: 'Restant (par PDV)',
    nature: 'INSTANT',
    module: 'inventory',
    reference: 'locationFlows',
    state: 'EXISTING',
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
    explorer: { dataset: 'f_production_daily', measure: 'mortality' },
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
    state: 'TO_VERIFY',
    explorer: { dataset: 'f_production_daily', measure: 'feed_consumed' },
  }),
  kpi({
    code: 'KPI-PRD-05',
    label: 'Poids moyen',
    nature: 'INSTANT',
    module: 'production',
    reference: 'latestWeighing',
    state: 'TO_VERIFY',
    explorer: { dataset: 'f_production_daily', measure: 'average_weight' },
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
    state: 'TO_VERIFY',
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
    state: 'TO_VERIFY',
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
    state: 'TO_VERIFY',
  }),
];

const BY_CODE: ReadonlyMap<string, KpiDefinition> = new Map(KPI_CATALOG.map((k) => [k.code, k]));

export function kpiDefinitionOf(code: string): KpiDefinition | undefined {
  return BY_CODE.get(code);
}

/** Indicateurs dont la fonction de référence reste à écrire (vide depuis P9-15). */
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
