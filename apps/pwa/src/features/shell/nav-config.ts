/**
 * Navigation de la coquille (ADR-049) : onglets du bas par rôle, barre latérale par domaine, actions
 * rapides du bouton « + ». Tout est calculé sur l'appareil à partir des rôles et des actions du jour
 * mémorisés (`navigation-store`) : la coquille reste utilisable hors ligne. Les destinations organisent
 * la navigation, jamais l'autorisation : le serveur revérifie chaque permission.
 */
import type { IconName } from '../../components/ui/icon-set.js';
import {
  ROUTES,
  SCREEN_GROUPS,
  routeOfAction,
  screensForRoles,
  type ScreenGroup,
} from '../../app/screens.js';
import type { NavigationRecord } from '../../storage/db.js';

/** Ordre des rôles de l'accueil (`apps/server/src/home-api/role-catalog.ts`, `ROLE_ORDER`). */
export const ROLE_ORDER: readonly string[] = [
  'DIRECTION',
  'FINANCE',
  'RESP_COMMERCIAL',
  'COMMERCIAL_TERRAIN',
  'COMMERCIAL_SEDENTAIRE',
  'VENDEUR_PDV',
  'RESP_PRODUCTION',
  'RESP_FERME',
  'MAGASINIER',
  'RESP_ACHATS',
  'ADMIN',
];

export interface TabSpec {
  readonly id: string;
  readonly path: string;
  /** Clé i18n du libellé court : `nav.tabs.<labelKey>`. */
  readonly labelKey: string;
  readonly icon: IconName;
}

const TAB = {
  sales: { id: 'sales', path: ROUTES.sales, labelKey: 'sales', icon: 'cart' },
  stock: { id: 'stock', path: ROUTES.stock, labelKey: 'stock', icon: 'box' },
  customers: { id: 'customers', path: ROUTES.portfolio, labelKey: 'customers', icon: 'users' },
  orders: { id: 'orders', path: ROUTES.orders, labelKey: 'orders', icon: 'receipt' },
  receipts: { id: 'receipts', path: ROUTES.receive, labelKey: 'receipts', icon: 'truck' },
  daily: { id: 'daily', path: ROUTES.productionLots, labelKey: 'daily', icon: 'clipboard' },
  lots: { id: 'lots', path: ROUTES.productionLots, labelKey: 'lots', icon: 'leaf' },
  eggs: { id: 'eggs', path: ROUTES.eggCollection, labelKey: 'eggs', icon: 'leaf' },
  approvals: { id: 'approvals', path: ROUTES.approvals, labelKey: 'approvals', icon: 'shield' },
  treasury: { id: 'treasury', path: ROUTES.treasury, labelKey: 'treasury', icon: 'cash' },
  receivables: {
    id: 'receivables',
    path: ROUTES.receivables,
    labelKey: 'receivables',
    icon: 'chart',
  },
  requests: {
    id: 'requests',
    path: ROUTES.purchaseRequests,
    labelKey: 'requests',
    icon: 'clipboard',
  },
  purchaseOrders: {
    id: 'purchase_orders',
    path: ROUTES.purchaseOrders,
    labelKey: 'purchase_orders',
    icon: 'receipt',
  },
  devices: { id: 'devices', path: ROUTES.devices, labelKey: 'devices', icon: 'phone' },
  users: { id: 'users', path: ROUTES.users, labelKey: 'users', icon: 'users' },
} as const satisfies Record<string, TabSpec>;

/**
 * Deux destinations par rôle (choix du porteur du 30/10/2026, ADR-049), après « Accueil » ; les suivantes
 * d'une liste ne servent que si un écran n'est pas proposé au rôle. Responsable de ferme : la collecte des
 * œufs prend la place du stock dans la barre (choix du porteur du 31/10/2026, lot L6) ; le stock reste dans
 * « Plus ».
 */
const ROLE_TABS: Readonly<Record<string, readonly TabSpec[]>> = {
  DIRECTION: [TAB.approvals, TAB.treasury],
  FINANCE: [TAB.receivables, TAB.treasury],
  RESP_COMMERCIAL: [TAB.customers, TAB.orders],
  COMMERCIAL_TERRAIN: [TAB.customers, TAB.sales],
  COMMERCIAL_SEDENTAIRE: [TAB.orders, TAB.customers],
  VENDEUR_PDV: [TAB.sales, TAB.stock],
  RESP_PRODUCTION: [TAB.lots, TAB.stock],
  RESP_FERME: [TAB.daily, TAB.eggs, TAB.stock],
  MAGASINIER: [TAB.receipts, TAB.stock],
  RESP_ACHATS: [TAB.requests, TAB.purchaseOrders],
  ADMIN: [TAB.devices, TAB.users],
};

/** Rôles sans création rapide : le bouton « + » n'apparaît pas s'ils sont les seuls détenus. */
const NO_QUICK_ACTIONS: readonly string[] = ['ADMIN'];

/**
 * Deux onglets de destination : ceux du premier rôle détenu (ordre de l'accueil), complétés par les
 * suivants si un écran n'est pas proposé. Rôles inconnus (accueil jamais ouvert en ligne) : aucun.
 */
export function tabsForRoles(roles: readonly string[]): readonly TabSpec[] {
  const allowed = new Set(screensForRoles(roles).map((screen) => screen.path));
  const picked: TabSpec[] = [];
  for (const role of ROLE_ORDER) {
    if (!roles.includes(role)) continue;
    for (const tab of ROLE_TABS[role] ?? []) {
      if (!allowed.has(tab.path) || picked.some((other) => other.path === tab.path)) continue;
      picked.push(tab);
      if (picked.length === 2) return picked;
    }
  }
  return picked;
}

/**
 * Onglet actif d'un chemin : « home » à la racine, l'onglet dont le chemin est le plus long préfixe,
 * sinon « more » (écran atteint par « Plus » ou par une action rapide).
 */
export function activeTabId(pathname: string, tabs: readonly TabSpec[]): string {
  if (pathname === ROUTES.home) return 'home';
  let best: TabSpec | undefined;
  for (const tab of tabs) {
    const matches = pathname === tab.path || pathname.startsWith(`${tab.path}/`);
    if (matches && (!best || tab.path.length > best.path.length)) best = tab;
  }
  return best?.id ?? 'more';
}

/** Icône d'une action de l'accueil (par code) ; les codes inconnus prennent une flèche. */
const ACTION_ICON: Readonly<Record<string, IconName>> = {
  NEW_SALE: 'cart',
  NEW_ORDER: 'receipt',
  NEW_VISIT: 'users',
  NEW_PROSPECT: 'user',
  NEW_EXPENSE: 'cash',
  START_SERVICE: 'clock',
  CASH_OPEN: 'cash',
  CASH_CLOSE: 'cash',
  LOSS: 'alert',
  RECEIVE_TRANSFER: 'truck',
  RECEIVE: 'truck',
  RECEIPTS: 'truck',
  TRANSFER: 'truck',
  COUNT: 'clipboard',
  DAILY_ENTRY: 'clipboard',
  EGG_COLLECTION: 'leaf',
  LOTS: 'leaf',
  INCUBATIONS: 'leaf',
  LOT_COSTS: 'chart',
  MORTALITY: 'shield',
  VALIDATIONS: 'shield',
  DISCOUNTS: 'shield',
  PRICES: 'tag',
  SYNC_STATUS: 'sync',
  RECEIVABLES: 'chart',
  PAYMENTS: 'cash',
  CASH_SESSIONS: 'cash',
  EXPENSES: 'receipt',
  SUPPLIER_INVOICES: 'file',
  SUPPLIER_PAYMENTS: 'cash',
  TEAM: 'users',
  TARGETS: 'chart',
  REASSIGN: 'users',
  REQUESTS: 'clipboard',
  ORDERS: 'receipt',
  SUPPLIERS: 'store',
  DEVICES: 'phone',
  USERS: 'users',
  ORGANIZATION: 'store',
  SETTINGS: 'sliders',
  CONTROL_TOWER: 'chart',
  FOLLOW_DELIVERIES: 'truck',
  STOCK_ALERTS: 'alert',
};

export function iconOfAction(code: string): IconName {
  return ACTION_ICON[code] ?? 'arrow-right';
}

export interface QuickAction {
  readonly key: string;
  readonly code: string;
  readonly label: string;
  readonly hint: string | null;
  readonly route: string;
  readonly primary: boolean;
}

export interface QuickActionGroup {
  readonly role: string;
  readonly roleLabel: string;
  readonly actions: readonly QuickAction[];
}

/**
 * Actions du bouton « + » : celles du jour de chaque rôle qui mènent à un écran livré, la principale
 * d'abord, une action commune à deux rôles une seule fois. Sans création rapide pour l'administrateur.
 */
export function quickActions(navigation: NavigationRecord | null | undefined): QuickActionGroup[] {
  if (!navigation) return [];
  const seen = new Set<string>();
  const groups: QuickActionGroup[] = [];
  for (const section of navigation.sections) {
    if (NO_QUICK_ACTIONS.includes(section.role)) continue;
    const actions: QuickAction[] = [];
    for (const action of section.actions) {
      const route = routeOfAction(action, section.role);
      const key = `${action.code}|${route}`;
      if (!route || route === ROUTES.home || seen.has(key)) continue;
      seen.add(key);
      actions.push({
        key,
        code: action.code,
        label: action.label,
        hint: action.hint,
        route,
        primary: action.primary,
      });
    }
    actions.sort((a, b) => Number(b.primary) - Number(a.primary));
    if (actions.length > 0) {
      groups.push({ role: section.role, roleLabel: section.roleLabel, actions });
    }
  }
  return groups;
}

/** Icône d'un écran de la barre latérale : par identifiant, à défaut par domaine. */
const GROUP_ICON: Readonly<Record<ScreenGroup, IconName>> = {
  sales: 'cart',
  stock: 'box',
  crm: 'users',
  procurement: 'truck',
  production: 'leaf',
  finance: 'cash',
  general: 'sliders',
};

const SCREEN_ICON: Readonly<Record<string, IconName>> = {
  'ECR-SYN-01': 'sync',
  'ECR-ADM-05': 'phone',
  'ECR-ADM-08': 'shield',
  'ECR-ADM-04': 'users',
  'ECR-PRX-01': 'tag',
  'ECR-PRX-02': 'tag',
  'ECR-PRX-03': 'tag',
  'ECR-VEN-03': 'receipt',
  'ECR-VEN-06': 'cash',
  'ECR-DIS-01': 'store',
  'ECR-DIS-02': 'cash',
  'ECR-DIS-04': 'chart',
  'ECR-FIN-01': 'chart',
  'ECR-FIN-06': 'chart',
  'ECR-FIN-03': 'file',
  'ECR-CRM-05': 'chart',
  'ECR-CRM-07': 'chart',
  'ECR-TER-01': 'clock',
  'ECR-STK-04': 'alert',
  'ECR-STK-03': 'truck',
  'ECR-STK-02': 'truck',
};

export interface SidebarItem {
  readonly id: string;
  readonly path: string;
  /** Clé i18n du libellé : `nav.screens.<labelKey>`. */
  readonly labelKey: string;
  readonly icon: IconName;
  /** Utilisable sans réseau (colonne « hors ligne » de l'inventaire des écrans). */
  readonly offline: boolean;
}

export interface SidebarGroup {
  readonly group: ScreenGroup;
  readonly items: readonly SidebarItem[];
}

/** Écrans proposés par domaine (sans l'accueil, qui a son entrée propre), dans l'ordre du registre. */
export function sidebarGroups(roles: readonly string[]): SidebarGroup[] {
  const screens = screensForRoles(roles).filter((screen) => screen.path !== ROUTES.home);
  return SCREEN_GROUPS.flatMap((group) => {
    const items = screens
      .filter((screen) => screen.group === group)
      .map((screen) => ({
        id: screen.id,
        path: screen.path,
        labelKey: screen.labelKey,
        icon: SCREEN_ICON[screen.id] ?? GROUP_ICON[group],
        offline: screen.offline,
      }));
    return items.length > 0 ? [{ group, items }] : [];
  });
}

/** Écran de la barre latérale qui correspond au chemin courant : le chemin enregistré le plus long. */
export function activeScreenPath(pathname: string, groups: readonly SidebarGroup[]): string | null {
  let best: string | null = null;
  for (const { items } of groups) {
    for (const item of items) {
      const matches = pathname === item.path || pathname.startsWith(`${item.path}/`);
      if (matches && (best === null || item.path.length > best.length)) best = item.path;
    }
  }
  return best;
}
