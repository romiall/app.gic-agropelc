/**
 * Registre des écrans de la PWA et navigation par rôle (ECR-ADM-03, UX-01 ; ADR-050).
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
  priceSimulator: '/prix/simulateur',
  stock: '/stock',
  portfolio: '/clients',
  performance: '/objectifs',
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
  /** ECR-CRM-01 : commerciaux et responsable commercial (03-parcours-et-ecrans.md §3). */
  portfolio: ['RESP_COMMERCIAL', 'COMMERCIAL_TERRAIN', 'COMMERCIAL_SEDENTAIRE'],
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
  /** ECR-STK-08 (`inventory.consumption.record`) : magasinier et responsable de ferme. */
  consumptionRecord: ['MAGASINIER', 'RESP_FERME'],
  /** ECR-STK-05 (`inventory.count.perform`) : magasinier, vendeur de PDV, responsable de ferme. */
  countPerform: ['MAGASINIER', 'VENDEUR_PDV', 'RESP_FERME'],
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
    id: 'ECR-STK-08',
    path: ROUTES.consumption,
    labelKey: 'consumption',
    group: 'stock',
    roles: ROLE_SETS.consumptionRecord,
    actionCodes: [],
    offline: true,
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

const ACTION_ROUTES: ReadonlyMap<string, string> = new Map(
  SCREENS.flatMap((screen) =>
    screen.actionCodes.map(
      (code) => [code, `${screen.path}${screen.actionQuery?.[code] ?? ''}`] as const,
    ),
  ),
);

/** Route d'une action de l'accueil : celle du serveur, à défaut celle de l'écran livré. */
export function routeOfAction(action: Pick<HomeAction, 'code' | 'route'>): string | null {
  return action.route ?? ACTION_ROUTES.get(action.code) ?? null;
}

/** Écrans proposés à un utilisateur selon ses rôles, dans l'ordre du registre. */
export function screensForRoles(roles: readonly string[]): ScreenEntry[] {
  const held = new Set(roles);
  return SCREENS.filter(
    (screen) => screen.roles === 'ALL' || screen.roles.some((role) => held.has(role)),
  );
}
