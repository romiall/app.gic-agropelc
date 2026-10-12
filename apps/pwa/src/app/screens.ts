/**
 * Registre des écrans de la PWA et navigation par rôle (ECR-ADM-03, UX-01 ; ADR-036).
 *
 * L'accueil reçoit du serveur, pour chaque rôle, des actions identifiées par un code
 * (`apps/server/src/home-api/role-catalog.ts`). ADR-030 §8 veut que le serveur renseigne la route
 * d'une action dès que son écran existe ; tant qu'il renvoie `route: null`, l'appareil complète la
 * route à partir de ce registre (`routeOfAction`). Une route fournie par le serveur l'emporte
 * toujours. Le registre ne contient que des écrans livrés : une action sans écran reste « Bientôt ».
 *
 * Les rôles de chaque écran suivent l'inventaire de `03-parcours-et-ecrans.md` §3 ; ils servent à
 * composer le menu, jamais à autoriser : le serveur revérifie chaque permission.
 */
import type { HomeAction } from '@gic/contracts';

export const ROUTES = {
  home: '/',
  menu: '/menu',
  sync: '/synchronisation',
  newSale: '/ventes/nouvelle',
  newSaleFor: (customerId: string) => `/ventes/nouvelle?client=${encodeURIComponent(customerId)}`,
  sales: '/ventes',
  salePattern: '/ventes/:saleId',
  sale: (saleId: string) => `/ventes/${saleId}`,
  newOrder: '/commandes/nouvelle',
  newOrderFor: (customerId: string) =>
    `/commandes/nouvelle?client=${encodeURIComponent(customerId)}`,
  orders: '/commandes',
  orderPattern: '/commandes/:orderId',
  order: (orderId: string) => `/commandes/${orderId}`,
  deliverPattern: '/commandes/:orderId/livrer',
  deliver: (orderId: string) => `/commandes/${orderId}/livrer`,
  collect: '/encaisser',
  service: '/service',
  productionLots: '/production/lots',
  dailyEntryPattern: '/production/lots/:lotId',
  dailyEntry: (lotId: string) => `/production/lots/${lotId}`,
  eggCollection: '/production/collecte',
  eggCollectionFor: (lotId: string) => `/production/collecte?lot=${encodeURIComponent(lotId)}`,
  productionOutput: '/production/sortie',
  lotSetup: '/production/nouveau-lot',
  incubation: '/production/incubation',
  lotSheet: '/production/fiche',
  lotSheetFor: (lotId: string) => `/production/fiche?lot=${encodeURIComponent(lotId)}`,
  productionOutputFor: (lotId: string) => `/production/sortie?lot=${encodeURIComponent(lotId)}`,
  purchaseRequests: '/achats/demandes',
  purchaseReceipts: '/achats/receptions',
  suppliers: '/achats/fournisseurs',
  purchaseOrders: '/achats/bons-de-commande',
  purchaseReceiptPattern: '/achats/receptions/:orderId',
  purchaseReceipt: (orderId: string) => `/achats/receptions/${orderId}`,
  priceSimulator: '/prix/simulateur',
  priceRules: '/prix/regles',
  catalog: '/catalogue',
  stock: '/stock',
  stockLedger: '/stock/registre',
  portfolio: '/clients',
  performance: '/objectifs',
  targets: '/objectifs/gestion',
  newProspect: '/clients/nouveau',
  newVisit: '/clients/visite',
  newVisitFor: (customerId: string) => `/clients/visite?client=${encodeURIComponent(customerId)}`,
  customerPattern: '/clients/:customerId',
  customer: (customerId: string) => `/clients/${customerId}`,
  interactionPattern: '/clients/:customerId/echange',
  interaction: (customerId: string) => `/clients/${customerId}/echange`,
  loss: '/stock/perte',
  receive: '/stock/receptions',
  receivePattern: '/stock/receptions/:transferId',
  blindReceipt: '/stock/receptions/sans-document',
  receiveOne: (transferId: string) => `/stock/receptions/${transferId}`,
  count: '/stock/inventaire',
  consumption: '/stock/consommation',
  transfer: '/stock/transferts',
  transferPattern: '/stock/transferts/:transferId',
  transferOne: (transferId: string) => `/stock/transferts/${transferId}`,
  collectFor: (customerId: string) => `/encaisser?client=${encodeURIComponent(customerId)}`,
  cash: '/caisse',
  replenish: '/pdv/reapprovisionnement',
  distribution: '/pdv/distribution',
} as const;

/** Rôles qui vendent (`sales.sale.record`, 07-security-rbac/01-rbac.md). */
const SELLER_ROLES = [
  'RESP_COMMERCIAL',
  'COMMERCIAL_TERRAIN',
  'COMMERCIAL_SEDENTAIRE',
  'VENDEUR_PDV',
  'RESP_FERME',
];
/** Rôles qui lisent les ventes (`sales.sale.read`). */
const SALE_READER_ROLES = [...SELLER_ROLES, 'DIRECTION', 'FINANCE'];

/**
 * Rôles par permission de vente (07-security-rbac/01-rbac.md) : ils décident des écrans et des
 * actions proposés, jamais de l'autorisation, que le serveur revérifie.
 */
export const ROLE_SETS = {
  saleRecord: SELLER_ROLES,
  saleRead: SALE_READER_ROLES,
  orderRead: [
    'DIRECTION',
    'RESP_COMMERCIAL',
    'COMMERCIAL_TERRAIN',
    'COMMERCIAL_SEDENTAIRE',
    'VENDEUR_PDV',
    'MAGASINIER',
    'FINANCE',
  ],
  /** `sales.price.override` (plafonds RC-06) : le vendeur de PDV n'y a pas droit. */
  priceOverride: [
    'DIRECTION',
    'RESP_COMMERCIAL',
    'COMMERCIAL_TERRAIN',
    'COMMERCIAL_SEDENTAIRE',
    'RESP_FERME',
  ],
  orderCreate: ['RESP_COMMERCIAL', 'COMMERCIAL_TERRAIN', 'COMMERCIAL_SEDENTAIRE'],
  orderCancel: ['DIRECTION', 'RESP_COMMERCIAL', 'COMMERCIAL_TERRAIN', 'COMMERCIAL_SEDENTAIRE'],
  orderFulfil: [
    'RESP_COMMERCIAL',
    'COMMERCIAL_TERRAIN',
    'COMMERCIAL_SEDENTAIRE',
    'VENDEUR_PDV',
    'MAGASINIER',
  ],
  /** `crm.customer.create` (01-rbac.md) : commerciaux, vendeur de PDV, responsable de ferme. */
  customerCreate: [
    'RESP_COMMERCIAL',
    'COMMERCIAL_TERRAIN',
    'COMMERCIAL_SEDENTAIRE',
    'VENDEUR_PDV',
    'RESP_FERME',
  ],
  /** `crm.customer.read` (01-rbac.md) : tous les rôles qui suivent des clients. */
  customerRead: [
    'DIRECTION',
    'RESP_COMMERCIAL',
    'COMMERCIAL_TERRAIN',
    'COMMERCIAL_SEDENTAIRE',
    'VENDEUR_PDV',
    'RESP_FERME',
    'FINANCE',
  ],
  /** ECR-CRM-05 : commerciaux (`crm.target.read`, 03-parcours-et-ecrans.md §3). */
  performance: ['RESP_COMMERCIAL', 'COMMERCIAL_TERRAIN', 'COMMERCIAL_SEDENTAIRE'],
  /** ECR-CRM-07 (`crm.target.manage` : direction ALL, responsable commercial TEAM). */
  targets: ['RESP_COMMERCIAL', 'DIRECTION'],
  /** ECR-CRM-01 : commerciaux et responsable commercial (03-parcours-et-ecrans.md §3). */
  portfolio: ['RESP_COMMERCIAL', 'COMMERCIAL_TERRAIN', 'COMMERCIAL_SEDENTAIRE'],
  /** ECR-PRX-02 : rédaction (`pricing.rule.draft`) ; activation et fin par la Direction (AV-062). */
  priceRules: ['RESP_COMMERCIAL', 'DIRECTION'],
  /** ECR-PRX-01 : `catalog.product.manage`, `catalog.reference.manage` (01-rbac.md) : administrateur. */
  catalog: ['ADMIN'],
  /** ECR-PRX-03 : responsable commercial et direction (03-parcours-et-ecrans.md §3.2). */
  priceSimulator: ['RESP_COMMERCIAL', 'DIRECTION'],
  /** `fieldwork.checkin.perform` (01-rbac.md) : commercial terrain et responsable commercial. */
  fieldwork: ['RESP_COMMERCIAL', 'COMMERCIAL_TERRAIN'],
  /** `crm.interaction.record` (01-rbac.md) : commerciaux et responsable commercial. */
  interactionRecord: ['RESP_COMMERCIAL', 'COMMERCIAL_TERRAIN', 'COMMERCIAL_SEDENTAIRE'],
  /** `crm.visit.record` (01-rbac.md) : commercial terrain et responsable commercial. */
  visitRecord: ['RESP_COMMERCIAL', 'COMMERCIAL_TERRAIN'],
  /** `inventory.loss.declare` : détenteurs de stock. */
  lossDeclare: ['COMMERCIAL_TERRAIN', 'VENDEUR_PDV', 'RESP_PRODUCTION', 'RESP_FERME', 'MAGASINIER'],
  /** ECR-PRD-01 et 02 (`production.daily.record`, jeu `production` des fermes) : production, ferme. */
  production: ['RESP_PRODUCTION', 'RESP_FERME'],
  /**
   * ECR-PRD-07 (`inventory.transfer.dispatch` SITE pour la ferme, ALL pour la production) : responsable
   * de ferme ; le responsable de production y déclare en plus le lot prêt à la vente.
   */
  productionOutput: ['RESP_FERME', 'RESP_PRODUCTION'],
  /**
   * ECR-PRD-04 (`production.lot.manage`, responsable de production seul ; l'entrée relève aussi de
   * `production.daily.record`, mais l'inventaire des écrans réserve l'écran à la production).
   */
  lotSetup: ['RESP_PRODUCTION'],
  /** ECR-PRD-06 (`production.incubation.record` : production ALL, ferme SITE). */
  incubation: ['RESP_FERME', 'RESP_PRODUCTION'],
  /** ECR-PRD-03 : responsable de production et direction (03-parcours-et-ecrans.md). */
  lotSheet: ['RESP_PRODUCTION', 'DIRECTION'],
  /** ECR-APP-02 (`procurement.request.create`, 01-rbac.md) : tous les demandeurs et les achats. */
  purchaseRequest: [
    'DIRECTION',
    'RESP_PRODUCTION',
    'RESP_FERME',
    'MAGASINIER',
    'RESP_ACHATS',
    'FINANCE',
  ],
  /** ECR-APP-04 (`procurement.receipt.record`, BC servis par site) : magasinier, responsable de ferme. */
  purchaseReceipt: ['MAGASINIER', 'RESP_FERME'],
  /** ECR-APP-01 (`procurement.supplier.manage`, 01-rbac.md) : responsable des achats. */
  suppliers: ['RESP_ACHATS'],
  /** ECR-APP-03 (`procurement.order.manage`, 01-rbac.md) : responsable des achats. */
  purchaseOrders: ['RESP_ACHATS'],
  /**
   * ECR-STK-08 (`inventory.consumption.record`, 01-rbac.md) : magasinier, responsable de ferme, et les
   * autres détenteurs de la permission, vendeur de PDV (emballages, UC-STK-10) et responsable de
   * production ; l'inventaire des écrans (03-parcours-et-ecrans.md) ne cite que les deux premiers.
   */
  consumptionRecord: ['MAGASINIER', 'RESP_FERME', 'VENDEUR_PDV', 'RESP_PRODUCTION'],
  /** ECR-STK-05 (`inventory.count.perform`) : magasinier, vendeur de PDV, responsable de ferme. */
  countPerform: ['MAGASINIER', 'VENDEUR_PDV', 'RESP_FERME'],
  /**
   * ECR-STK-07 (`inventory.ledger.read`, 01-rbac.md) : « responsables, direction » de l'inventaire des
   * écrans, magasinier compris (WF-J3 étape 5), et la finance ; pas les vendeurs ni les commerciaux.
   */
  stockLedger: [
    'DIRECTION',
    'RESP_COMMERCIAL',
    'RESP_PRODUCTION',
    'RESP_FERME',
    'MAGASINIER',
    'FINANCE',
  ],
  /** ECR-STK-02 (`inventory.transfer.dispatch`) : magasinier et responsable de ferme. */
  transferDispatch: ['MAGASINIER', 'RESP_FERME'],
  /** `inventory.transfer.receive` : destinataires de transferts. */
  transferReceive: [
    'COMMERCIAL_TERRAIN',
    'VENDEUR_PDV',
    'RESP_PRODUCTION',
    'RESP_FERME',
    'MAGASINIER',
  ],
  /** `inventory.stock.read` : tous les rôles sauf l'administrateur. */
  stockRead: [
    'DIRECTION',
    'RESP_COMMERCIAL',
    'COMMERCIAL_TERRAIN',
    'COMMERCIAL_SEDENTAIRE',
    'VENDEUR_PDV',
    'RESP_PRODUCTION',
    'RESP_FERME',
    'MAGASINIER',
    'RESP_ACHATS',
    'FINANCE',
  ],
  paymentRecord: [
    'RESP_COMMERCIAL',
    'COMMERCIAL_TERRAIN',
    'COMMERCIAL_SEDENTAIRE',
    'VENDEUR_PDV',
    'RESP_FERME',
    'FINANCE',
  ],
  /** `finance.cash_session.operate` (VEN SITE, FIN ALL) : ouverture et clôture de la caisse du PDV. */
  cashSessionOperate: ['VENDEUR_PDV', 'FINANCE'],
  /** ECR-DIS-03 : demande de réapprovisionnement du PDV (`inventory.transfer.request`, VEN SITE). */
  replenishRequest: ['VENDEUR_PDV'],
  /** ECR-DIS-04 : `analytics.dashboard.distribution` (DIR, RCO ZONE, VEN SITE, MAG SITE, FIN). */
  distributionDashboard: ['DIRECTION', 'RESP_COMMERCIAL', 'VENDEUR_PDV', 'MAGASINIER', 'FINANCE'],
} as const satisfies Record<string, readonly string[]>;

/** Rôles inconnus de l'appareil (accueil jamais ouvert en ligne) : l'action reste proposée. */
export function holdsAnyRole(held: readonly string[], allowed: readonly string[]): boolean {
  return held.length === 0 || held.some((role) => allowed.includes(role));
}

export type ScreenGroup = 'general' | 'sales' | 'stock' | 'crm' | 'procurement' | 'production';

export interface ScreenEntry {
  /** Identifiant de l'inventaire des écrans (`ECR-…`), ou code interne pour un écran transverse. */
  readonly id: string;
  readonly path: string;
  /** Clé i18n du libellé (`nav.screens.<labelKey>`). */
  readonly labelKey: string;
  readonly group: ScreenGroup;
  /** Rôles à qui l'écran est proposé ; `ALL` : tout utilisateur. */
  readonly roles: readonly string[] | 'ALL';
  /** Codes d'actions de l'accueil qui mènent à cet écran. */
  readonly actionCodes: readonly string[];
  /** Paramètres ajoutés à la route pour une action donnée (ex. filtre des alertes). */
  readonly actionQuery?: Readonly<Record<string, string>>;
  /** Utilisable sans réseau (colonne « hors ligne » de l'inventaire). */
  readonly offline: boolean;
}

export const SCREENS: readonly ScreenEntry[] = [
  {
    id: 'ECR-ADM-03',
    path: ROUTES.home,
    labelKey: 'home',
    group: 'general',
    roles: 'ALL',
    actionCodes: [],
    offline: false,
  },
  {
    id: 'ECR-SYN-01',
    path: ROUTES.sync,
    labelKey: 'sync',
    group: 'general',
    roles: 'ALL',
    actionCodes: ['SYNC_STATUS'],
    offline: true,
  },
  {
    id: 'ECR-VEN-01',
    path: ROUTES.newSale,
    labelKey: 'new_sale',
    group: 'sales',
    roles: SELLER_ROLES,
    actionCodes: ['NEW_SALE'],
    offline: true,
  },
  {
    id: 'ECR-VEN-02',
    path: ROUTES.newOrder,
    labelKey: 'new_order',
    group: 'sales',
    roles: ROLE_SETS.orderCreate,
    actionCodes: ['NEW_ORDER'],
    offline: true,
  },
  {
    id: 'ECR-VEN-03',
    path: ROUTES.orders,
    labelKey: 'orders',
    group: 'sales',
    roles: ROLE_SETS.orderRead,
    actionCodes: ['FOLLOW_DELIVERIES'],
    offline: true,
  },
  {
    id: 'ECR-VEN-06',
    path: ROUTES.collect,
    labelKey: 'collect',
    group: 'sales',
    roles: ROLE_SETS.paymentRecord,
    // « Encaissements » de la Finance : virements et règlements reçus au siège (01-rbac.md).
    actionCodes: ['PAYMENTS'],
    offline: true,
  },
  {
    id: 'ECR-CRM-01',
    path: ROUTES.portfolio,
    labelKey: 'portfolio',
    group: 'crm',
    roles: ROLE_SETS.portfolio,
    actionCodes: [],
    offline: true,
  },
  {
    id: 'ECR-CRM-05',
    path: ROUTES.performance,
    labelKey: 'performance',
    group: 'crm',
    roles: ROLE_SETS.performance,
    actionCodes: [],
    offline: true,
  },
  {
    id: 'ECR-CRM-02',
    path: ROUTES.newProspect,
    labelKey: 'new_prospect',
    group: 'crm',
    roles: ROLE_SETS.customerCreate,
    actionCodes: ['NEW_PROSPECT'],
    offline: true,
  },
  {
    id: 'ECR-CRM-07',
    path: ROUTES.targets,
    labelKey: 'targets',
    group: 'crm',
    roles: ROLE_SETS.targets,
    actionCodes: ['TARGETS'],
    offline: false,
  },
  {
    id: 'ECR-TER-01',
    path: ROUTES.service,
    labelKey: 'service',
    group: 'crm',
    roles: ROLE_SETS.fieldwork,
    actionCodes: ['START_SERVICE'],
    offline: true,
  },
  {
    id: 'ECR-CRM-04',
    path: ROUTES.newVisit,
    labelKey: 'new_visit',
    group: 'crm',
    roles: ROLE_SETS.visitRecord,
    actionCodes: ['NEW_VISIT'],
    offline: true,
  },
  {
    id: 'ECR-STK-01',
    path: ROUTES.stock,
    labelKey: 'stock',
    group: 'stock',
    roles: ROLE_SETS.stockRead,
    // « Alertes de stock » du magasinier : l'écran s'ouvre sur les produits sous le seuil.
    actionCodes: ['STOCK_ALERTS'],
    actionQuery: { STOCK_ALERTS: '?alertes=1' },
    offline: true,
  },
  {
    id: 'ECR-STK-02',
    path: ROUTES.transfer,
    labelKey: 'transfer',
    group: 'stock',
    roles: ROLE_SETS.transferDispatch,
    actionCodes: ['TRANSFER'],
    offline: true,
  },
  {
    id: 'ECR-STK-03',
    path: ROUTES.receive,
    labelKey: 'receive',
    group: 'stock',
    roles: ROLE_SETS.transferReceive,
    actionCodes: ['RECEIVE_TRANSFER'],
    offline: true,
  },
  {
    id: 'ECR-STK-04',
    path: ROUTES.loss,
    labelKey: 'loss',
    group: 'stock',
    roles: ROLE_SETS.lossDeclare,
    actionCodes: ['LOSS'],
    offline: true,
  },
  {
    id: 'ECR-STK-05',
    path: ROUTES.count,
    labelKey: 'count',
    group: 'stock',
    roles: ROLE_SETS.countPerform,
    actionCodes: ['COUNT'],
    offline: true,
  },
  {
    id: 'ECR-STK-07',
    path: ROUTES.stockLedger,
    labelKey: 'stock_ledger',
    group: 'stock',
    roles: ROLE_SETS.stockLedger,
    actionCodes: [],
    offline: false,
  },
  {
    id: 'ECR-STK-08',
    path: ROUTES.consumption,
    labelKey: 'consumption',
    group: 'stock',
    roles: ROLE_SETS.consumptionRecord,
    actionCodes: [],
    offline: true,
  },
  {
    id: 'ECR-PRX-02',
    path: ROUTES.priceRules,
    labelKey: 'price_rules',
    group: 'sales',
    roles: ROLE_SETS.priceRules,
    // « Tarifs » de la Direction : activer les règles de prix.
    actionCodes: ['PRICES'],
    offline: false,
  },
  {
    id: 'ECR-PRX-03',
    path: ROUTES.priceSimulator,
    labelKey: 'price_simulator',
    group: 'sales',
    roles: ROLE_SETS.priceSimulator,
    actionCodes: [],
    offline: true,
  },
  {
    id: 'ECR-PRX-01',
    path: ROUTES.catalog,
    labelKey: 'catalog',
    group: 'general',
    roles: ROLE_SETS.catalog,
    // Aucune action de l'accueil de l'administrateur n'y mène encore (S-26) : menu seulement.
    actionCodes: [],
    offline: false,
  },
  {
    id: 'ECR-APP-02',
    path: ROUTES.purchaseRequests,
    labelKey: 'purchase_request',
    group: 'procurement',
    roles: ROLE_SETS.purchaseRequest,
    // « Demandes d'achat » du responsable des achats.
    actionCodes: ['REQUESTS'],
    offline: true,
  },
  {
    id: 'ECR-APP-01',
    path: ROUTES.suppliers,
    labelKey: 'suppliers',
    group: 'procurement',
    roles: ROLE_SETS.suppliers,
    actionCodes: ['SUPPLIERS'],
    offline: false,
  },
  {
    id: 'ECR-APP-03',
    path: ROUTES.purchaseOrders,
    labelKey: 'purchase_orders',
    group: 'procurement',
    roles: ROLE_SETS.purchaseOrders,
    actionCodes: ['ORDERS'],
    offline: false,
  },
  {
    id: 'ECR-APP-04',
    path: ROUTES.purchaseReceipts,
    labelKey: 'purchase_receipt',
    group: 'procurement',
    roles: ROLE_SETS.purchaseReceipt,
    // « Réceptionner » du magasinier, « Réceptions » du responsable de ferme.
    actionCodes: ['RECEIVE', 'RECEIPTS'],
    offline: true,
  },
  {
    id: 'ECR-PRD-01',
    path: ROUTES.productionLots,
    labelKey: 'production_lots',
    group: 'production',
    roles: ROLE_SETS.production,
    // « Lots de production » du responsable de production ; « SAISIE DU JOUR » du responsable de
    // ferme, qui choisit le lot dans la liste.
    actionCodes: ['LOTS', 'DAILY_ENTRY'],
    offline: true,
  },
  {
    id: 'ECR-PRD-02',
    path: ROUTES.eggCollection,
    labelKey: 'egg_collection',
    group: 'production',
    roles: ROLE_SETS.production,
    actionCodes: ['EGG_COLLECTION'],
    offline: true,
  },
  {
    id: 'ECR-PRD-03',
    path: ROUTES.lotSheet,
    labelKey: 'lot_sheet',
    group: 'production',
    roles: ROLE_SETS.lotSheet,
    // « Coûts des lots » du responsable de production.
    actionCodes: ['LOT_COSTS'],
    offline: false,
  },
  {
    id: 'ECR-PRD-04',
    path: ROUTES.lotSetup,
    labelKey: 'lot_setup',
    group: 'production',
    roles: ROLE_SETS.lotSetup,
    actionCodes: [],
    offline: true,
  },
  {
    id: 'ECR-PRD-06',
    path: ROUTES.incubation,
    labelKey: 'incubation',
    group: 'production',
    roles: ROLE_SETS.incubation,
    actionCodes: ['INCUBATIONS'],
    offline: true,
  },
  {
    id: 'ECR-PRD-07',
    path: ROUTES.productionOutput,
    labelKey: 'production_output',
    group: 'production',
    roles: ROLE_SETS.productionOutput,
    actionCodes: [],
    offline: true,
  },
  {
    id: 'ECR-DIS-02',
    path: ROUTES.cash,
    labelKey: 'cash_session',
    group: 'sales',
    roles: ROLE_SETS.cashSessionOperate,
    actionCodes: ['CASH_OPEN', 'CASH_CLOSE'],
    offline: true,
  },
  {
    id: 'ECR-DIS-03',
    path: ROUTES.replenish,
    labelKey: 'replenish',
    group: 'stock',
    roles: ROLE_SETS.replenishRequest,
    actionCodes: [],
    offline: true,
  },
  {
    id: 'ECR-DIS-04',
    path: ROUTES.distribution,
    labelKey: 'distribution',
    group: 'sales',
    roles: ROLE_SETS.distributionDashboard,
    actionCodes: [],
    offline: false,
  },
  {
    id: 'ECR-VEN-05',
    path: ROUTES.sales,
    labelKey: 'sales',
    group: 'sales',
    roles: SALE_READER_ROLES,
    actionCodes: [],
    offline: true,
  },
];

export const SCREEN_GROUPS: readonly ScreenGroup[] = [
  'sales',
  'stock',
  'crm',
  'procurement',
  'production',
  'general',
];

/**
 * Route d'une action de l'accueil : celle du serveur, à défaut celle de l'écran livré. Avec le rôle
 * de la section, l'écran doit être proposé à ce rôle : une même action peut porter un sens différent
 * d'un rôle à l'autre (`RECEIPTS` : saisir une réception pour le responsable de ferme, suivre les
 * réceptions pour le responsable des achats, écran non livré) et reste alors « Bientôt ».
 */
export function routeOfAction(
  action: Pick<HomeAction, 'code' | 'route'>,
  role?: string,
): string | null {
  if (action.route) return action.route;
  const screen = SCREENS.find(
    (candidate) =>
      candidate.actionCodes.includes(action.code) &&
      (role === undefined || candidate.roles === 'ALL' || candidate.roles.includes(role)),
  );
  return screen ? `${screen.path}${screen.actionQuery?.[action.code] ?? ''}` : null;
}

/** Écrans proposés à un utilisateur selon ses rôles, dans l'ordre du registre. */
export function screensForRoles(roles: readonly string[]): ScreenEntry[] {
  const held = new Set(roles);
  return SCREENS.filter(
    (screen) => screen.roles === 'ALL' || screen.roles.some((role) => held.has(role)),
  );
}
