import { describe, expect, it } from 'vitest';
import {
  ROLE_SETS,
  ROUTES,
  routeOfAction,
  routeOfSignal,
  SCREENS,
  screensForRoles,
} from './screens.js';

describe('app/screens — registre et navigation par rôle', () => {
  it('une route fournie par le serveur l’emporte ; à défaut, celle de l’écran livré', () => {
    expect(routeOfAction({ code: 'SYNC_STATUS', route: null })).toBe(ROUTES.sync);
    expect(routeOfAction({ code: 'SYNC_STATUS', route: '/autre' })).toBe('/autre');
  });

  it('signal : route du serveur, à défaut celle de l’écran qui déclare ce signal (MP-06, MP-09)', () => {
    expect(routeOfSignal({ code: 'DEVICES_PENDING', action: { route: null } })).toBe(
      ROUTES.devices,
    );
    expect(routeOfSignal({ code: 'SERVICE_NOT_STARTED', action: { route: null } })).toBe(
      ROUTES.service,
    );
    expect(routeOfSignal({ code: 'DEVICES_PENDING', action: { route: '/autre' } })).toBe('/autre');
    expect(routeOfSignal({ code: 'STOCK_OUT', action: { route: null } })).toBeNull();
    expect(routeOfSignal({ code: 'STOCK_OUT', action: null })).toBeNull();
    // MP-09 (AV-255) : ventes du jour signalées, liste filtrée.
    expect(routeOfSignal({ code: 'SALES_FLAGGED', action: { route: null } })).toBe(
      `${ROUTES.sales}?anomalies=1`,
    );
    expect(routeOfAction({ code: 'DEVICES', route: null }, 'ADMIN')).toBe(ROUTES.devices);
    // MP-07 : file de validation, filtrée par type depuis les actions des responsables.
    expect(routeOfSignal({ code: 'APPROVALS_PENDING', action: { route: null } })).toBe(
      ROUTES.approvals,
    );
    expect(routeOfAction({ code: 'VALIDATIONS', route: null }, 'DIRECTION')).toBe(ROUTES.approvals);
    expect(routeOfAction({ code: 'MORTALITY', route: null }, 'RESP_PRODUCTION')).toBe(
      `${ROUTES.approvals}?types=MORTALITY,ANIMAL_COUNT_ADJUSTMENT`,
    );
    expect(routeOfAction({ code: 'DISCOUNTS', route: null }, 'RESP_COMMERCIAL')).toBe(
      `${ROUTES.approvals}?types=PRICE_OVERRIDE`,
    );
    expect(routeOfAction({ code: 'VALIDATIONS', route: null }, 'ADMIN')).toBeNull();
    // P8E-03 (AV-298) : « + Dépense » des rôles de terrain ; « Dépenses et fournisseurs » de la
    // Finance mène au suivi ; jamais pour l'Admin (sans `finance.expense.record`).
    expect(routeOfAction({ code: 'NEW_EXPENSE', route: null }, 'VENDEUR_PDV')).toBe(
      ROUTES.expenses,
    );
    expect(routeOfAction({ code: 'EXPENSES', route: null }, 'FINANCE')).toBe(
      `${ROUTES.expenses}?vue=suivi`,
    );
    expect(routeOfAction({ code: 'NEW_EXPENSE', route: null }, 'ADMIN')).toBeNull();
    // Droits des dépenses (01-rbac.md §5.5) : payer, la Finance seule ; annuler la dépense d'un autre,
    // les approbateurs (Direction, Finance, Resp. production) ; saisir, dix rôles, jamais l'Admin.
    expect([...ROLE_SETS.expensePay]).toEqual(['FINANCE']);
    // Paiement fournisseur au-delà du seuil : décidé par la Direction seule (01-rbac.md §5.5).
    expect([...ROLE_SETS.supplierPaymentApprove]).toEqual(['DIRECTION']);
    expect([...ROLE_SETS.expenseApprove].sort()).toEqual(
      ['DIRECTION', 'FINANCE', 'RESP_PRODUCTION'].sort(),
    );
    expect(ROLE_SETS.expenseRecord).toHaveLength(10);
    expect(ROLE_SETS.expenseRecord).not.toContain('ADMIN');
    expect([...ROLE_SETS.expenseFollow].sort()).toEqual(
      [
        'DIRECTION',
        'FINANCE',
        'RESP_ACHATS',
        'RESP_COMMERCIAL',
        'RESP_FERME',
        'RESP_PRODUCTION',
        'VENDEUR_PDV',
      ].sort(),
    );
    // MP-08 : comptes et réinitialisation, pour l'Admin.
    expect(routeOfAction({ code: 'USERS', route: null }, 'ADMIN')).toBe(ROUTES.users);
    expect(routeOfAction({ code: 'USERS', route: null }, 'DIRECTION')).toBeNull();
    // Un code de signal ne mène qu'à un seul écran.
    const codes = SCREENS.flatMap((screen) => screen.signalCodes ?? []);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('une action sans écran livré reste sans route (affichée « Bientôt »)', () => {
    expect(routeOfAction({ code: 'CONTROL_TOWER', route: null })).toBeNull();
  });

  it('la route dépend du rôle de la section : RECEIPTS mène à la saisie pour la ferme seulement', () => {
    expect(routeOfAction({ code: 'RECEIPTS', route: null }, 'RESP_FERME')).toBe(
      ROUTES.purchaseReceipts,
    );
    expect(routeOfAction({ code: 'RECEIPTS', route: null }, 'RESP_ACHATS')).toBeNull();
    for (const screen of SCREENS) {
      if (screen.roles === 'ALL') continue;
      for (const code of screen.actionCodes) {
        for (const role of screen.roles) {
          expect(routeOfAction({ code, route: null }, role)).toBe(
            `${screen.path}${screen.actionQuery?.[code] ?? ''}`,
          );
        }
      }
    }
  });

  it('propose les écrans de tous les rôles de l’utilisateur, et les écrans communs à tous', () => {
    const common = screensForRoles([]).map((screen) => screen.id);
    expect(common).toEqual(expect.arrayContaining(['ECR-ADM-03', 'ECR-SYN-01']));
    for (const screen of SCREENS) {
      if (screen.roles === 'ALL') continue;
      expect(screensForRoles([...screen.roles]).map((s) => s.id)).toContain(screen.id);
      expect(screensForRoles(['ROLE_INCONNU']).map((s) => s.id)).not.toContain(screen.id);
    }
  });

  it('écrans des factures et paiements fournisseurs (P8E-05, P8E-06) : lecteurs des dettes, saisie de la Finance', () => {
    for (const [id, path] of [
      ['ECR-FIN-03', '/finance/factures'],
      ['ECR-FIN-04', '/finance/paiements'],
    ] as const) {
      expect(SCREENS.find((screen) => screen.id === id)).toMatchObject({
        path,
        group: 'finance',
        roles: ROLE_SETS.payableRead,
        offline: false,
      });
    }
    expect(ROUTES.supplierPayments).toBe('/finance/paiements');
    expect([...ROLE_SETS.payableRead]).toEqual(['DIRECTION', 'RESP_ACHATS', 'FINANCE']);
    expect([...ROLE_SETS.supplierPaymentRecord]).toEqual(['FINANCE']);
    expect([...ROLE_SETS.supplierPaymentApprove]).toEqual(['DIRECTION']);
    expect(screensForRoles(['RESP_ACHATS']).map((screen) => screen.id)).toEqual(
      expect.arrayContaining(['ECR-FIN-03', 'ECR-FIN-04']),
    );
    expect(screensForRoles(['VENDEUR_PDV']).map((screen) => screen.id)).not.toContain('ECR-FIN-04');
  });

  it('chaque code d’action ne mène qu’à un seul écran, et chaque chemin est unique', () => {
    const codes = SCREENS.flatMap((screen) => screen.actionCodes);
    expect(new Set(codes).size).toBe(codes.length);
    const paths = SCREENS.map((screen) => screen.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
