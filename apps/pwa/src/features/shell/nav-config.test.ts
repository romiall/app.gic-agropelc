import { describe, expect, it } from 'vitest';
import { ROUTES, SCREEN_GROUPS } from '../../app/screens.js';
import type { NavigationRecord } from '../../storage/db.js';
import {
  activeScreenPath,
  activeTabId,
  iconOfAction,
  quickActions,
  sidebarGroups,
  tabsForRoles,
} from './nav-config.js';

const paths = (roles: string[]) => tabsForRoles(roles).map((tab) => tab.path);

describe('tabsForRoles (onglets du bas, ADR-049)', () => {
  it.each([
    ['VENDEUR_PDV', [ROUTES.sales, ROUTES.stock]],
    ['COMMERCIAL_TERRAIN', [ROUTES.portfolio, ROUTES.sales]],
    ['MAGASINIER', [ROUTES.receive, ROUTES.stock]],
    ['RESP_FERME', [ROUTES.productionLots, ROUTES.eggCollection]],
    ['DIRECTION', [ROUTES.approvals, ROUTES.treasury]],
    ['FINANCE', [ROUTES.receivables, ROUTES.treasury]],
    ['RESP_ACHATS', [ROUTES.purchaseRequests, ROUTES.purchaseOrders]],
    ['RESP_COMMERCIAL', [ROUTES.portfolio, ROUTES.orders]],
    ['RESP_PRODUCTION', [ROUTES.productionLots, ROUTES.stock]],
    ['COMMERCIAL_SEDENTAIRE', [ROUTES.orders, ROUTES.portfolio]],
    ['ADMIN', [ROUTES.devices, ROUTES.users]],
  ])('%s : deux destinations', (role, expected) => {
    expect(paths([role])).toEqual(expected);
  });

  it('rôles inconnus (accueil jamais ouvert en ligne) : aucune destination', () => {
    expect(tabsForRoles([])).toEqual([]);
  });

  it('plusieurs rôles : les onglets du premier rôle dans l’ordre de l’accueil', () => {
    expect(paths(['ADMIN', 'VENDEUR_PDV'])).toEqual([ROUTES.sales, ROUTES.stock]);
    expect(paths(['MAGASINIER', 'DIRECTION', 'ADMIN'])).toEqual([
      ROUTES.approvals,
      ROUTES.treasury,
    ]);
  });

  it('nomme les onglets avec des clés i18n courtes et des icônes', () => {
    const tabs = tabsForRoles(['VENDEUR_PDV']);
    expect(tabs.map((tab) => tab.labelKey)).toEqual(['sales', 'stock']);
    expect(tabs.every((tab) => tab.icon.length > 0)).toBe(true);
  });
});

describe('activeTabId', () => {
  const sellerTabs = tabsForRoles(['VENDEUR_PDV']);
  const storeTabs = tabsForRoles(['MAGASINIER']);

  it('la racine est « home », un écran enfant garde l’onglet de son parent', () => {
    expect(activeTabId('/', sellerTabs)).toBe('home');
    expect(activeTabId('/ventes', sellerTabs)).toBe('sales');
    expect(activeTabId('/ventes/nouvelle', sellerTabs)).toBe('sales');
    expect(activeTabId('/stock/registre', sellerTabs)).toBe('stock');
  });

  it('le préfixe le plus long l’emporte (réceptions du magasinier, dans « /stock »)', () => {
    expect(activeTabId('/stock/receptions/abc', storeTabs)).toBe('receipts');
    expect(activeTabId('/stock/transferts', storeTabs)).toBe('stock');
  });

  it('un écran atteint par « Plus » ou par une action rapide active « more »', () => {
    expect(activeTabId('/menu', sellerTabs)).toBe('more');
    expect(activeTabId('/finance/depenses', sellerTabs)).toBe('more');
    expect(activeTabId('/ventes-annulees', sellerTabs)).toBe('more');
  });
});

const record = (
  sections: NavigationRecord['sections'],
  roles = sections.map((section) => section.role),
): NavigationRecord => ({ user_id: 'u1', roles, sections, saved_at: '2026-10-30T10:00:00Z' });

describe('quickActions (bouton « + »)', () => {
  const action = (code: string, label: string, route: string | null, primary = false) => ({
    code,
    label,
    hint: null,
    route,
    primary,
  });

  it('garde les actions qui mènent à un écran, la principale d’abord', () => {
    const groups = quickActions(
      record([
        {
          role: 'VENDEUR_PDV',
          roleLabel: 'Vendeur de point de vente',
          actions: [
            action('LOSS', 'Déclarer une perte', null),
            action('NEW_SALE', '+ VENTE', null, true),
            action('SOON', 'Bientôt', '/'),
            action('CASH_OPEN', 'Ouvrir la caisse', null),
          ],
        },
      ]),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.roleLabel).toBe('Vendeur de point de vente');
    expect(groups[0]?.actions.map((a) => a.code)).toEqual(['NEW_SALE', 'LOSS', 'CASH_OPEN']);
    expect(groups[0]?.actions[0]?.route).toBe(ROUTES.newSale);
  });

  it('une action commune à deux rôles n’apparaît qu’une fois', () => {
    const groups = quickActions(
      record([
        { role: 'VENDEUR_PDV', roleLabel: 'Vendeur', actions: [action('LOSS', 'Perte', null)] },
        { role: 'MAGASINIER', roleLabel: 'Magasinier', actions: [action('LOSS', 'Perte', null)] },
      ]),
    );
    expect(groups.map((group) => group.role)).toEqual(['VENDEUR_PDV']);
  });

  it('sans création rapide pour l’administrateur ; rien sans navigation mémorisée', () => {
    expect(
      quickActions(
        record([
          {
            role: 'ADMIN',
            roleLabel: 'Administrateur',
            actions: [action('DEVICES', 'Appareils', null)],
          },
        ]),
      ),
    ).toEqual([]);
    expect(quickActions(null)).toEqual([]);
    expect(quickActions(undefined)).toEqual([]);
  });
});

describe('sidebarGroups et activeScreenPath (barre latérale)', () => {
  const groups = sidebarGroups(['VENDEUR_PDV']);

  it('regroupe les écrans du rôle par domaine, sans l’accueil, dans l’ordre du registre', () => {
    const order = groups.map((entry) => entry.group);
    expect(order).toEqual(SCREEN_GROUPS.filter((group) => order.includes(group)));
    const everyPath = groups.flatMap((entry) => entry.items.map((item) => item.path));
    expect(everyPath).toContain(ROUTES.newSale);
    expect(everyPath).not.toContain(ROUTES.home);
    expect(everyPath).not.toContain(ROUTES.users);
  });

  it('chaque entrée porte une icône et une clé de libellé', () => {
    for (const { items } of groups) {
      for (const item of items) {
        expect(item.icon.length).toBeGreaterThan(0);
        expect(item.labelKey.length).toBeGreaterThan(0);
      }
    }
  });

  it('l’entrée active est le chemin enregistré le plus long', () => {
    const stock = sidebarGroups(['MAGASINIER']);
    expect(activeScreenPath('/stock/registre', stock)).toBe(ROUTES.stockLedger);
    expect(activeScreenPath('/stock/abc', stock)).toBe(ROUTES.stock);
    expect(activeScreenPath('/inconnu', stock)).toBeNull();
  });
});

describe('iconOfAction', () => {
  it('une icône par code connu, une flèche sinon', () => {
    expect(iconOfAction('NEW_SALE')).toBe('cart');
    expect(iconOfAction('CODE_INCONNU')).toBe('arrow-right');
  });
});
