import { describe, expect, it } from 'vitest';
import type { CashAccountItem } from '../treasury/treasury.js';
import {
  expenseFollowPaths,
  expensePayAccounts,
  isExpenseFollowGroup,
  isExpensePayable,
  mayCancelExpense,
  sortExpenses,
  type ExpenseItem,
} from './expense-follow.js';

const USER = '01900000-0000-7000-8000-000000000001';
const OTHER = '01900000-0000-7000-8000-000000000002';

const account = (overrides: Partial<CashAccountItem>): CashAccountItem => ({
  id: 'bank',
  code: 'BANQUE',
  name: 'Banque',
  accountType: 'BANQUE',
  siteId: null,
  holderUserId: null,
  balanceXaf: 1_000_000,
  status: 'ACTIVE',
  ...overrides,
});

describe('suivi des dépenses (ECR-FIN-02, vue en ligne)', () => {
  it('groupes ouverts lus sans période, groupes clos sur les 30 derniers jours métier', () => {
    // 23:30 à Douala le 10 : jour métier du 11 (UTC+1).
    const now = new Date('2026-10-10T23:30:00.000Z');
    expect(expenseFollowPaths('TO_PAY', now)).toEqual([
      '/api/v1/expenses?status=RECORDED&limit=200',
      '/api/v1/expenses?status=APPROVED&limit=200',
    ]);
    expect(expenseFollowPaths('TO_DECIDE', now)).toEqual([
      '/api/v1/expenses?status=PENDING_APPROVAL&limit=200',
      '/api/v1/expenses?status=PAID_PENDING_APPROVAL&limit=200',
    ]);
    expect(expenseFollowPaths('REJECTED', now)).toEqual([
      '/api/v1/expenses?status=REJECTED&limit=200&from=2026-09-12&to=2026-10-11',
      '/api/v1/expenses?status=PAID_REJECTED&limit=200&from=2026-09-12&to=2026-10-11',
    ]);
    expect(isExpenseFollowGroup('PAID')).toBe(true);
    expect(isExpenseFollowGroup('toString')).toBe(false);
    expect(isExpenseFollowGroup(null)).toBe(false);
  });

  it('comptes de paiement : actifs, jamais la caisse personnelle d’un autre, par nom', () => {
    expect(
      expensePayAccounts(
        [
          account({}),
          account({ id: 'central', name: 'Caisse centrale', accountType: 'CAISSE_CENTRALE' }),
          account({ id: 'mine', name: 'Ma caisse', holderUserId: USER }),
          account({ id: 'theirs', name: 'Sa caisse', holderUserId: OTHER }),
          account({ id: 'closed', name: 'Ancienne banque', status: 'INACTIVE' }),
        ],
        USER,
      ).map((entry) => entry.id),
    ).toEqual(['bank', 'central', 'mine']);
  });

  it('payer : enregistrée ou approuvée ; annuler : non payée, par l’auteur ou un approbateur', () => {
    expect(isExpensePayable({ status: 'RECORDED' })).toBe(true);
    expect(isExpensePayable({ status: 'APPROVED' })).toBe(true);
    expect(isExpensePayable({ status: 'PENDING_APPROVAL' })).toBe(false);
    expect(isExpensePayable({ status: 'PAID' })).toBe(false);
    expect(mayCancelExpense({ status: 'RECORDED', createdBy: USER }, USER, false)).toBe(true);
    expect(mayCancelExpense({ status: 'PENDING_APPROVAL', createdBy: OTHER }, USER, true)).toBe(
      true,
    );
    expect(mayCancelExpense({ status: 'APPROVED', createdBy: OTHER }, USER, false)).toBe(false);
    expect(mayCancelExpense({ status: 'PAID', createdBy: USER }, USER, true)).toBe(false);
    expect(mayCancelExpense({ status: 'REJECTED', createdBy: USER }, USER, true)).toBe(false);
  });

  it('dépenses réunies de plusieurs statuts : de la plus récente à la plus ancienne', () => {
    const item = (id: string, occurredAt: string) => ({ id, occurredAt }) as ExpenseItem;
    expect(
      sortExpenses([
        item('a', '2026-10-09T10:00:00.000Z'),
        item('b', '2026-10-10T10:00:00.000Z'),
        item('c', '2026-10-09T10:00:00.000Z'),
      ]).map((entry) => entry.id),
    ).toEqual(['b', 'c', 'a']);
  });
});
