/**
 * P9-07 : alerte `CASH_MISMATCH` de bout en bout — la tâche `finance.cash.reconcile_daily` publie un
 * événement `CashMismatchDetected` par compte (et par jour métier) au lieu de lever, le consommateur
 * `communication.alerts` en fait une alerte CRITICAL à résolution manuelle, dédupliquée par (compte, jour).
 * Les cinq vérifications sont simulées (leur logique est éprouvée ailleurs) ; le consommateur, la base et
 * les événements sont réels, en transaction annulée.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixedClock, Uuidv7Generator } from '@gic/domain';

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
import { handleAlertEvent } from '../src/modules/communication/application/events/alerts-consumer.js';
import { toDomainEvent } from '../src/platform/events/domain-event.js';
import { compositeSubjectId } from '../src/platform/events/detection-events.js';
import { fromBin } from '../src/platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../src/platform/unit-of-work.js';
import { verifyCashLedger } from '../src/modules/finance/application/public/cash-accounts.js';
import { verifyCashTransfers } from '../src/modules/finance/application/public/cash-transfer-query.js';
import { verifyCashSessions } from '../src/modules/finance/application/public/cash-session-verification.js';
import {
  verifyExpenses,
  verifySupplierLedger,
} from '../src/modules/finance/application/public/operations-verification.js';
import { rolledBack } from './communication-test-kit.js';
import { closeTestDb, freshUuid } from './helpers.js';

// Jour propre à l'exécution (base partagée) : aucune alerte ouverte d'un autre test ne porte cette clé.
const OFFSET_DAYS = Math.floor(Math.random() * 3000);
const DAY_MS = 86_400_000;
const at = (extraDays = 0) =>
  new Date(Date.UTC(2041, 0, 1, 2, 30) + (OFFSET_DAYS + extraDays) * DAY_MS);

afterAll(closeTestDb);

const CLEAN = {
  ledger: { ok: true, accountsChecked: 1, mismatches: [] },
  transfers: { ok: true, transfersChecked: 0, mismatches: [] },
  sessions: { ok: true, sessionsChecked: 0, breaches: [] },
  expenses: { ok: true, checked: 0, breaches: [] },
  suppliers: { ok: true, checked: 0, breaches: [] },
};

function stub(overrides: Partial<typeof CLEAN> = {}) {
  const all = { ...CLEAN, ...overrides };
  vi.mocked(verifyCashLedger).mockResolvedValue(all.ledger as never);
  vi.mocked(verifyCashTransfers).mockResolvedValue(all.transfers as never);
  vi.mocked(verifyCashSessions).mockResolvedValue(all.sessions as never);
  vi.mocked(verifyExpenses).mockResolvedValue(all.expenses as never);
  vi.mocked(verifySupplierLedger).mockResolvedValue(all.suppliers as never);
}

async function runJobAndConsume(uow: UnitOfWork, now: Date): Promise<number> {
  const clock = new FixedClock(now);
  const idGenerator = new Uuidv7Generator(clock);
  const registry = new JobHandlerRegistry();
  new CashLedgerReconciliationJob(clock, idGenerator, registry).onModuleInit();
  const before = await uow
    .selectFrom('platform_domain_events')
    .select((eb) => eb.fn.max<number>('seq').as('last'))
    .executeTakeFirstOrThrow();
  await registry.resolve(CASH_LEDGER_RECONCILIATION_JOB_TYPE)!(uow, {});
  const rows = await uow
    .selectFrom('platform_domain_events')
    .selectAll()
    .where('event_type', '=', 'CashMismatchDetected')
    .where('seq', '>', Number(before.last ?? 0))
    .orderBy('seq')
    .execute();
  for (const row of rows) await handleAlertEvent(uow, toDomainEvent(row), { idGenerator });
  return rows.length;
}

const alertsOf = (uow: UnitOfWork, dedupKey: string) =>
  uow
    .selectFrom('communication_alerts')
    .select(['status', 'severity', 'occurrences', 'alert_type', 'dedup_key'])
    .where('dedup_key', '=', dedupKey)
    .execute();

describe('P9-07 : CASH_MISMATCH', () => {
  beforeEach(() => vi.clearAllMocks());

  it('un écart de solde ouvre une alerte CRITICAL par compte et par jour ; le rejeu du jour compte une occurrence', () =>
    rolledBack(async (uow) => {
      const account = freshUuid();
      const day = at().toISOString().slice(0, 10);
      stub({
        ledger: {
          ok: false,
          accountsChecked: 1,
          mismatches: [{ cashAccountId: account, projectedXaf: 120_000, ledgerXaf: 118_500 }],
        } as never,
      });
      expect(await runJobAndConsume(uow, at())).toBe(1);
      const key = `CASH_MISMATCH:CASH_RECONCILIATION:${account}:${day}`;
      expect(await alertsOf(uow, key)).toEqual([
        expect.objectContaining({
          status: 'OPEN',
          severity: 'CRITICAL',
          occurrences: 1,
          alert_type: 'CASH_MISMATCH',
        }),
      ]);

      // Le message nomme le compte et la rubrique en écart ; le sujet est celui que l'éditeur a calculé.
      const [detail] = await uow
        .selectFrom('communication_alerts')
        .select(['message', 'subject_id'])
        .where('dedup_key', '=', key)
        .execute();
      expect(detail!.message).toContain(account);
      expect(detail!.message).toContain('Solde et registre');
      expect(fromBin(detail!.subject_id)).toBe(
        compositeSubjectId('CASH_MISMATCH', { cash_account_id: account, business_day: day }),
      );

      // Même jour, nouvelle exécution : la même alerte, une occurrence de plus (INV-NOT-01).
      expect(await runJobAndConsume(uow, new Date(at().getTime() + 3_600_000))).toBe(1);
      expect(await alertsOf(uow, key)).toEqual([
        expect.objectContaining({ status: 'OPEN', occurrences: 2 }),
      ]);

      // Le lendemain : l'écart non corrigé est un nouveau constat, donc une alerte propre à ce jour.
      expect(await runJobAndConsume(uow, at(1))).toBe(1);
      const nextDay = at(1).toISOString().slice(0, 10);
      expect(
        await alertsOf(uow, `CASH_MISMATCH:CASH_RECONCILIATION:${account}:${nextDay}`),
      ).toHaveLength(1);
    }));

  it('tout sain : aucun événement ; écart sans compte (dépense) : une alerte sous la clé NONE', () =>
    rolledBack(async (uow) => {
      stub();
      expect(await runJobAndConsume(uow, at(2))).toBe(0);

      stub({
        expenses: {
          ok: false,
          checked: 1,
          breaches: [{ ref: 'DEP-9', invariant: 'EXPENSE_COST', detail: 'coût net absent' }],
        } as never,
      });
      expect(await runJobAndConsume(uow, at(2))).toBe(1);
      const day = at(2).toISOString().slice(0, 10);
      expect(await alertsOf(uow, `CASH_MISMATCH:CASH_RECONCILIATION:none:${day}`)).toEqual([
        expect.objectContaining({ status: 'OPEN', severity: 'CRITICAL', occurrences: 1 }),
      ]);
    }));
});
