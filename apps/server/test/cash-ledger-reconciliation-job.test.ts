/**
 * `finance.cash.reconcile_daily` (P4-03, étendu en P5-22 et P8-12 ; P9-07 : l'écart est **publié**, la
 * tâche ne lève plus) : comptes (INV-FIN-02), remises de fonds, sessions de caisse (INV-FIN-05, 06, 11),
 * dépenses (INV-FIN-08) et documents fournisseurs (INV-FIN-07) vérifiés ensemble ; un événement
 * `CashMismatchDetected` par compte (les écarts sans compte partagent la clé `NONE`) et par jour métier,
 * au plus cinq détails par événement (le reste compté). Test unitaire : les cinq vérifications sont
 * simulées (aucune altération de la base d'essai partagée ; leur logique est éprouvée par
 * `finance-cash-session-reconciliation.test.ts`, `p5-invariants.test.ts`, `p8-invariants.test.ts` et
 * `p8-lock-order.test.ts`) ; la consommation de l'événement par `communication.alerts` est éprouvée par
 * `finance-cash-mismatch-alert.test.ts`.
 */
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('../src/platform/events/detection-events.js', async (importActual) => ({
  ...((await importActual()) as Record<string, unknown>),
  publishDetectionEvent: vi.fn(),
}));

import { JobHandlerRegistry } from '../src/platform/jobs/job-handler-registry.js';
import {
  CASH_LEDGER_RECONCILIATION_JOB_TYPE,
  CashLedgerReconciliationJob,
  NO_ACCOUNT_KEY,
} from '../src/modules/finance/application/jobs/cash-ledger-reconciliation-job.js';
import { publishDetectionEvent } from '../src/platform/events/detection-events.js';
import { verifyCashLedger } from '../src/modules/finance/application/public/cash-accounts.js';
import { verifyCashTransfers } from '../src/modules/finance/application/public/cash-transfer-query.js';
import { verifyCashSessions } from '../src/modules/finance/application/public/cash-session-verification.js';
import {
  verifyExpenses,
  verifySupplierLedger,
} from '../src/modules/finance/application/public/operations-verification.js';

const NOW = new Date('2026-10-14T07:30:00.000Z');
const ACCOUNT_A = '0192a000-0000-7000-8000-00000000000a';
const ACCOUNT_B = '0192a000-0000-7000-8000-00000000000b';
const SITE_A = '0192a000-0000-7000-8000-0000000000a1';

const CLEAN = {
  ledger: { ok: true, accountsChecked: 4, mismatches: [] },
  transfers: { ok: true, transfersChecked: 2, mismatches: [] },
  sessions: { ok: true, sessionsChecked: 3, breaches: [] },
  expenses: { ok: true, checked: 5, breaches: [] },
  suppliers: { ok: true, checked: 6, breaches: [] },
};

let nextId = 0;
const idGenerator = {
  newId: () => `0192b000-0000-7000-8000-${String(++nextId).padStart(12, '0')}`,
};

function handler() {
  const registry = new JobHandlerRegistry();
  new CashLedgerReconciliationJob(
    { now: () => NOW } as never,
    idGenerator as never,
    registry,
  ).onModuleInit();
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

/** Transaction simulée : seule la lecture du site des comptes en écart est utilisée. */
const uow = {
  selectFrom: () => {
    const chain = {
      select: () => chain,
      where: () => chain,
      execute: async () => [
        {
          id: Buffer.from(ACCOUNT_A.replace(/-/g, ''), 'hex'),
          site_id: Buffer.from(SITE_A.replace(/-/g, ''), 'hex'),
          code: 'CPT-A',
        },
        { id: Buffer.from(ACCOUNT_B.replace(/-/g, ''), 'hex'), site_id: null, code: 'CPT-B' },
      ],
    };
    return chain;
  },
};

const run = () => handler()(uow as never, {} as never);
const published = () => vi.mocked(publishDetectionEvent).mock.calls.map(([, , input]) => input);

describe('CashLedgerReconciliationJob — comptes, remises et sessions (P5-22, P9-07)', () => {
  beforeEach(() => {
    vi.mocked(publishDetectionEvent).mockReset().mockResolvedValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('tout sain : la tâche réussit, compte ce qu’elle a vérifié et ne publie rien', async () => {
    stub();
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await expect(run()).resolves.toBeUndefined();
    expect(log.mock.calls[0]?.[0]).toMatch(
      /4 compte\(s\), 2 remise\(s\), 3 session\(s\), 5 dépense\(s\), 6 document\(s\) fournisseur, aucun écart/,
    );
    expect(published()).toEqual([]);
  });

  it('rupture de session seule : la tâche réussit, journalise le détail et publie un événement pour le compte', async () => {
    stub({
      sessions: {
        ok: false,
        sessionsChecked: 3,
        breaches: [
          {
            sessionId: 'S-1',
            cashAccountId: ACCOUNT_A,
            invariant: 'INV-FIN-11',
            issue: 'POSTED_NOT_COUNTED_MINUS_EXPECTED',
            detail: 'Écarts posés -100 ≠ compté − attendu courant -600.',
          },
        ],
      } as never,
    });
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(run()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[0]).toMatch(
      /^CASH_MISMATCH : 1 rupture\(s\) de session de caisse — session S-1 INV-FIN-11 POSTED_NOT_COUNTED_MINUS_EXPECTED : Écarts posés -100/,
    );
    const events = published();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'CashMismatchDetected',
      producerModule: 'finance',
      aggregateType: 'CASH_RECONCILIATION',
      occurredAt: NOW,
      payload: {
        cash_account_id: ACCOUNT_A,
        business_day: '2026-10-14',
        sections: ['SESSIONS'],
        breaches: 1,
        site_id: SITE_A,
        // Libellés du message d'alerte : le compte par son code, les rubriques en clair.
        account_label: 'CPT-A',
        sections_label: 'Sessions de caisse',
      },
    });
    // Pas d'identité de passe : l'alerte est un fait (EVENT) à résolution manuelle.
    expect(events[0]).not.toHaveProperty('passId');
    expect(events[0]!.payload).not.toHaveProperty('difference_xaf');
  });

  it('un événement par compte ; écart de solde avec différence ; au plus cinq détails, le reste compté', async () => {
    stub({
      ledger: {
        ok: false,
        accountsChecked: 4,
        mismatches: [{ cashAccountId: ACCOUNT_B, projectedXaf: 10, ledgerXaf: 4 }],
      } as never,
      transfers: {
        ok: false,
        transfersChecked: 2,
        mismatches: [
          {
            transferId: 'T',
            docNumber: 'RMF-1',
            fromAccountId: ACCOUNT_B,
            issue: 'UNEXPECTED_MOVEMENT',
            detail: 'x',
          },
        ],
      } as never,
      sessions: {
        ok: false,
        sessionsChecked: 9,
        breaches: Array.from({ length: 7 }, (_, i) => ({
          sessionId: `S-${i}`,
          cashAccountId: ACCOUNT_A,
          invariant: 'INV-FIN-05',
          issue: 'UNTRACKED_VARIANCE_MOVEMENT',
          detail: 'd',
        })),
      } as never,
    });
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await run();
    const message = String(error.mock.calls[0]?.[0]);
    expect(message).toContain(
      '1 compte(s) en écart — compte ' + ACCOUNT_B + ' : solde 10 ≠ registre 4',
    );
    expect(message).toContain('1 remise(s) incohérente(s) — RMF-1 UNEXPECTED_MOVEMENT : x');
    expect(message).toContain('7 rupture(s) de session de caisse');
    expect(message).toContain('session S-4');
    expect(message).not.toContain('session S-5');
    expect(message).toContain('et 2 autre(s)');

    const byAccount = new Map(published().map((e) => [e.payload['cash_account_id'], e.payload]));
    expect(byAccount.size).toBe(2);
    expect(byAccount.get(ACCOUNT_A)).toMatchObject({
      sections: ['SESSIONS'],
      breaches: 7,
      site_id: SITE_A,
    });
    expect((byAccount.get(ACCOUNT_A)!['details'] as string[]).length).toBe(5);
    expect(byAccount.get(ACCOUNT_B)).toMatchObject({
      sections: ['LEDGER', 'TRANSFERS'],
      breaches: 2,
      site_id: null,
      account_label: 'CPT-B',
      sections_label: 'Solde et registre, Remises de fonds',
      projected_xaf: 10,
      ledger_xaf: 4,
      difference_xaf: 6,
    });
    // Sujet composite (compte × jour) : l'identifiant d'agrégat est dérivé, stable et distinct par compte.
    const ids = published().map((e) => e.aggregateId);
    expect(new Set(ids).size).toBe(2);
  });

  it('P8-12 : dépense et document fournisseur en écart, groupés sous la clé NONE, chacun dans sa section', async () => {
    stub({
      expenses: {
        ok: false,
        checked: 5,
        breaches: [
          { ref: 'DEP-1', invariant: 'EXPENSE_COST', detail: 'coût net 0 pour 9000 attendu' },
        ],
      } as never,
      suppliers: {
        ok: false,
        checked: 6,
        breaches: [
          { ref: 'FF-1', invariant: 'INVOICE_PAID', detail: 'payé 1000 ≠ affectations actives 0' },
        ],
      } as never,
    });
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await run();
    const message = String(error.mock.calls[0]?.[0]);
    expect(message).toMatch(/^CASH_MISMATCH : /);
    expect(message).toContain(
      '1 dépense(s) en écart — DEP-1 EXPENSE_COST : coût net 0 pour 9000 attendu',
    );
    expect(message).toContain(
      '1 document(s) fournisseur en écart — FF-1 INVOICE_PAID : payé 1000 ≠ affectations actives 0',
    );
    const events = published();
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      cash_account_id: NO_ACCOUNT_KEY,
      sections: ['EXPENSES', 'SUPPLIERS'],
      breaches: 2,
      site_id: null,
      account_label: 'Sans compte (dépenses, fournisseurs)',
      sections_label: 'Dépenses, Fournisseurs',
    });
  });

  it('une vraie exception de lecture fait toujours échouer la tâche (rien n’est publié)', async () => {
    stub();
    vi.mocked(verifyCashLedger).mockRejectedValue(new Error('lecture impossible'));
    await expect(run()).rejects.toThrow('lecture impossible');
    expect(published()).toEqual([]);
  });
});
