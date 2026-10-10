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
  sales: '/ventes',
  salePattern: '/ventes/:saleId',
  sale: (saleId: string) => `/ventes/${saleId}`,
  newOrder: '/commandes/nouvelle',
  orders: '/commandes',
  orderPattern: '/commandes/:orderId',
  order: (orderId: string) => `/commandes/${orderId}`,
  deliverPattern: '/commandes/:orderId/livrer',
  deliver: (orderId: string) => `/commandes/${orderId}/livrer`,
  collect: '/encaisser',
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
  SCREENS.flatMap((screen) => screen.actionCodes.map((code) => [code, screen.path] as const)),
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
