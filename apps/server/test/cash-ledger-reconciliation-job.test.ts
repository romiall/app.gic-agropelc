/**
 * `finance.cash.reconcile_daily` (P4-03, étendu en P5-22 et P8-12) : comptes (INV-FIN-02), remises de
 * fonds, sessions de caisse (INV-FIN-05, 06, 11), dépenses (INV-FIN-08) et documents fournisseurs
 * (INV-FIN-07) vérifiés ensemble ; le message d'échec nomme chaque rupture, par section, au plus cinq par
 * section (le reste compté). Test unitaire : les cinq vérifications sont simulées (aucune altération de la
 * base d'essai partagée ; leur logique est éprouvée par `finance-cash-session-reconciliation.test.ts`,
 * `p5-invariants.test.ts`, `p8-invariants.test.ts` et `p8-lock-order.test.ts`).
 */
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/modules/finance/application/public/cash-accounts.js', () => ({
  verifyCashLedger: vi.fn(),
}));
vi.mock('../src/modules/finance/application/public/cash-transfer-query.js', () => ({
  verifyCashTransfers: vi.fn(),
}));
vi.mock('../src/modules/finance/application/public/cash-session-verification.js', () => ({
  verifyCashSessions: vi.fn(),
}));
vi.mock('../src/modules/finance/application/public/operations-verification.js', () => ({
  verifyExpenses: vi.fn(),
  verifySupplierLedger: vi.fn(),
}));

import { JobHandlerRegistry } from '../src/platform/jobs/job-handler-registry.js';
import {
  CASH_LEDGER_RECONCILIATION_JOB_TYPE,
  CashLedgerReconciliationJob,
} from '../src/modules/finance/application/jobs/cash-ledger-reconciliation-job.js';
import { verifyCashLedger } from '../src/modules/finance/application/public/cash-accounts.js';
import { verifyCashTransfers } from '../src/modules/finance/application/public/cash-transfer-query.js';
import { verifyCashSessions } from '../src/modules/finance/application/public/cash-session-verification.js';
import {
  verifyExpenses,
  verifySupplierLedger,
} from '../src/modules/finance/application/public/operations-verification.js';

const CLEAN = {
  ledger: { ok: true, accountsChecked: 4, mismatches: [] },
  transfers: { ok: true, transfersChecked: 2, mismatches: [] },
  sessions: { ok: true, sessionsChecked: 3, breaches: [] },
  expenses: { ok: true, checked: 5, breaches: [] },
  suppliers: { ok: true, checked: 6, breaches: [] },
};

function handler() {
  const registry = new JobHandlerRegistry();
  new CashLedgerReconciliationJob(registry).onModuleInit();
  return registry.resolve(CASH_LEDGER_RECONCILIATION_JOB_TYPE)!;
}

function stub(overrides: Partial<typeof CLEAN> = {}) {
  vi.mocked(verifyCashLedger).mockResolvedValue((overrides.ledger ?? CLEAN.ledger) as never);
  vi.mocked(verifyCashTransfers).mockResolvedValue(
    (overrides.transfers ?? CLEAN.transfers) as never,
  );
  vi.mocked(verifyCashSessions).mockResolvedValue((overrides.sessions ?? CLEAN.sessions) as never);
  vi.mocked(verifyExpenses).mockResolvedValue((overrides.expenses ?? CLEAN.expenses) as never);
  vi.mocked(verifySupplierLedger).mockResolvedValue(
    (overrides.suppliers ?? CLEAN.suppliers) as never,
  );
}

const run = () => handler()({} as never, {} as never);

describe('CashLedgerReconciliationJob — comptes, remises et sessions (P5-22)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('tout sain : la tâche réussit et compte ce qu’elle a vérifié', async () => {
    stub();
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await expect(run()).resolves.toBeUndefined();
    expect(log.mock.calls[0]?.[0]).toMatch(
      /4 compte\(s\), 2 remise\(s\), 3 session\(s\), 5 dépense\(s\), 6 document\(s\) fournisseur, aucun écart/,
    );
  });

  it('rupture de session seule : la tâche échoue en la nommant (invariant, anomalie, détail), après journalisation', async () => {
    stub({
      sessions: {
        ok: false,
        sessionsChecked: 3,
        breaches: [
          {
            sessionId: 'S-1',
            cashAccountId: 'A-1',
            invariant: 'INV-FIN-11',
            issue: 'POSTED_NOT_COUNTED_MINUS_EXPECTED',
            detail: 'Écarts posés -100 ≠ compté − attendu courant -600.',
          },
        ],
      } as never,
    });
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(run()).rejects.toThrow(
      /^CASH_MISMATCH : 1 rupture\(s\) de session de caisse — session S-1 INV-FIN-11 POSTED_NOT_COUNTED_MINUS_EXPECTED : Écarts posés -100/,
    );
    expect(error).toHaveBeenCalledOnce();
  });

  it('trois sections en écart à la fois ; au plus cinq détails par section, le reste compté', async () => {
    stub({
      ledger: {
        ok: false,
        accountsChecked: 4,
        mismatches: [{ cashAccountId: 'A-9', projectedXaf: 10, ledgerXaf: 0 }],
      } as never,
      transfers: {
        ok: false,
        transfersChecked: 2,
        mismatches: [
          { transferId: 'T', docNumber: 'RMF-1', issue: 'UNEXPECTED_MOVEMENT', detail: 'x' },
        ],
      } as never,
      sessions: {
        ok: false,
        sessionsChecked: 9,
        breaches: Array.from({ length: 7 }, (_, i) => ({
          sessionId: `S-${i}`,
          cashAccountId: 'A',
          invariant: 'INV-FIN-05',
          issue: 'UNTRACKED_VARIANCE_MOVEMENT',
          detail: 'd',
        })),
      } as never,
    });
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const message = await run().then(
      () => '',
      (e: Error) => e.message,
    );
    expect(message).toContain('1 compte(s) en écart — compte A-9 : solde 10 ≠ registre 0');
    expect(message).toContain('1 remise(s) incohérente(s) — RMF-1 UNEXPECTED_MOVEMENT : x');
    expect(message).toContain('7 rupture(s) de session de caisse');
    expect(message).toContain('session S-4');
    expect(message).not.toContain('session S-5');
    expect(message).toContain('et 2 autre(s)');
  });

  it('P8-12 : dépense et document fournisseur en écart, chacun dans sa section (référence, invariant, détail)', async () => {
    stub({
      expenses: {
        ok: false,
        checked: 5,
        breaches: [{ ref: 'DEP-1', invariant: 'EXPENSE_COST', detail: 'coût net 0 pour 9000 attendu' }],
      } as never,
      suppliers: {
        ok: false,
        checked: 6,
        breaches: [
          { ref: 'FF-1', invariant: 'INVOICE_PAID', detail: 'payé 1000 ≠ affectations actives 0' },
        ],
      } as never,
    });
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const message = await run().then(
      () => '',
      (e: Error) => e.message,
    );
    expect(message).toMatch(/^CASH_MISMATCH : /);
    expect(message).toContain(
      '1 dépense(s) en écart — DEP-1 EXPENSE_COST : coût net 0 pour 9000 attendu',
    );
    expect(message).toContain(
      '1 document(s) fournisseur en écart — FF-1 INVOICE_PAID : payé 1000 ≠ affectations actives 0',
    );
  });
});
