/**
 * `finance.cash.reconcile_daily` (P4-03, étendu en P5-22 et P8-12 ; P9-07 : l'écart est publié, plus
 * levé) : dans une seule transaction, donc sur un même instantané —
 * - INV-FIN-02 : solde projeté de chaque compte = Σ `IN` − Σ `OUT` du registre (`verifyCashLedger`) ;
 * - remises de fonds ↔ registre (`verifyCashTransfers`, P5-15) ;
 * - sessions de caisse : INV-FIN-05, 06, 11, BR-DIS-006 (`verifyCashSessions`, lectures sans verrou) ;
 * - dépenses et documents fournisseurs : INV-FIN-07 et 08 (P8-12).
 *
 * **Un écart ne fait plus échouer la tâche** (ADR-071 §3) : une tâche qui lève voit ses écritures
 * annulées par le point de sauvegarde du `JobRunner`, donc l'événement ne partirait jamais. La tâche
 * publie un événement `CashMismatchDetected` **par compte et par jour métier** (les sections sans compte
 * partagent la clé `NONE`), journalise le détail, puis se termine en succès : l'alerte `CASH_MISMATCH`
 * (CRITICAL, résolution manuelle) est le signal. Une vraie exception (lecture impossible) lève toujours.
 * La correction n'est jamais automatique : `rebuildCashBalances` reste une procédure de maintenance
 * déclenchée après analyse, et le registre, les sessions et les ajustements sont immuables.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { businessDayOf, type Clock, type IdGenerator } from '@gic/domain';
import { CLOCK } from '../../../../platform/clock.provider.js';
import { ID_GENERATOR } from '../../../../platform/id-generator.provider.js';
import {
  compositeSubjectId,
  publishDetectionEvent,
} from '../../../../platform/events/detection-events.js';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../../../platform/jobs/job-handler-registry.provider.js';
import { fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { verifyCashLedger } from '../public/cash-accounts.js';
import { verifyCashSessions } from '../public/cash-session-verification.js';
import { verifyCashTransfers } from '../public/cash-transfer-query.js';
import { verifyExpenses, verifySupplierLedger } from '../public/operations-verification.js';

export const CASH_LEDGER_RECONCILIATION_JOB_TYPE = 'finance.cash.reconcile_daily';

/** Nombre d'écarts détaillés par section dans le message et la charge utile (le reste est compté). */
const DETAILED_MISMATCHES = 5;
/** Clé de compte des écarts qui ne se rattachent à aucun compte (dépenses, documents fournisseurs). */
export const NO_ACCOUNT_KEY = 'NONE';

export type MismatchSection = 'LEDGER' | 'TRANSFERS' | 'SESSIONS' | 'EXPENSES' | 'SUPPLIERS';

const SECTION_LABELS: Readonly<Record<MismatchSection, string>> = {
  LEDGER: 'Solde et registre',
  TRANSFERS: 'Remises de fonds',
  SESSIONS: 'Sessions de caisse',
  EXPENSES: 'Dépenses',
  SUPPLIERS: 'Fournisseurs',
};

interface AccountMismatches {
  readonly accountKey: string;
  readonly sections: Set<MismatchSection>;
  readonly lines: string[];
  projectedXaf: number | null;
  ledgerXaf: number | null;
}

@Injectable()
export class CashLedgerReconciliationJob implements OnModuleInit {
  private readonly logger = new Logger(CashLedgerReconciliationJob.name);

  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ID_GENERATOR) private readonly idGenerator: IdGenerator,
    @Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(CASH_LEDGER_RECONCILIATION_JOB_TYPE, async (uow) => {
      const now = this.clock.now();
      const today = businessDayOf(now);
      const ledger = await verifyCashLedger(uow);
      const transfers = await verifyCashTransfers(uow);
      const sessions = await verifyCashSessions(uow);
      // P8-12 : dépenses et fournisseurs (INV-FIN-07, INV-FIN-08).
      const expenses = await verifyExpenses(uow);
      const suppliers = await verifySupplierLedger(uow);
      if (ledger.ok && transfers.ok && sessions.ok && expenses.ok && suppliers.ok) {
        this.logger.log(
          `Trésorerie réconciliée : ${ledger.accountsChecked} compte(s), ${transfers.transfersChecked} remise(s), ` +
            `${sessions.sessionsChecked} session(s), ${expenses.checked} dépense(s), ${suppliers.checked} document(s) fournisseur, aucun écart.`,
        );
        return;
      }

      const byAccount = new Map<string, AccountMismatches>();
      const bucket = (accountKey: string, section: MismatchSection, line: string) => {
        let entry = byAccount.get(accountKey);
        if (entry === undefined) {
          entry = {
            accountKey,
            sections: new Set(),
            lines: [],
            projectedXaf: null,
            ledgerXaf: null,
          };
          byAccount.set(accountKey, entry);
        }
        entry.sections.add(section);
        entry.lines.push(line);
        return entry;
      };
      const sectionsText: string[] = [];
      if (!ledger.ok) {
        sectionsText.push(
          `${ledger.mismatches.length} compte(s) en écart` +
            detail(
              ledger.mismatches.map(
                (m) =>
                  `compte ${m.cashAccountId} : solde ${m.projectedXaf} ≠ registre ${m.ledgerXaf}`,
              ),
            ),
        );
        for (const m of ledger.mismatches) {
          const entry = bucket(
            m.cashAccountId,
            'LEDGER',
            `solde ${m.projectedXaf} ≠ registre ${m.ledgerXaf}`,
          );
          entry.projectedXaf = m.projectedXaf;
          entry.ledgerXaf = m.ledgerXaf;
        }
      }
      if (!transfers.ok) {
        sectionsText.push(
          `${transfers.mismatches.length} remise(s) incohérente(s)` +
            detail(transfers.mismatches.map((m) => `${m.docNumber} ${m.issue} : ${m.detail}`)),
        );
        for (const m of transfers.mismatches) {
          bucket(m.fromAccountId, 'TRANSFERS', `${m.docNumber} ${m.issue} : ${m.detail}`);
        }
      }
      if (!sessions.ok) {
        sectionsText.push(
          `${sessions.breaches.length} rupture(s) de session de caisse` +
            detail(
              sessions.breaches.map(
                (b) => `session ${b.sessionId} ${b.invariant} ${b.issue} : ${b.detail}`,
              ),
            ),
        );
        for (const b of sessions.breaches) {
          bucket(
            b.cashAccountId,
            'SESSIONS',
            `session ${b.sessionId} ${b.invariant} ${b.issue} : ${b.detail}`,
          );
        }
      }
      for (const [label, section, check] of [
        ['dépense(s)', 'EXPENSES', expenses],
        ['document(s) fournisseur', 'SUPPLIERS', suppliers],
      ] as const) {
        if (!check.ok) {
          sectionsText.push(
            `${check.breaches.length} ${label} en écart` +
              detail(check.breaches.map((b) => `${b.ref} ${b.invariant} : ${b.detail}`)),
          );
          for (const b of check.breaches) {
            bucket(NO_ACCOUNT_KEY, section, `${b.ref} ${b.invariant} : ${b.detail}`);
          }
        }
      }
      const message = `CASH_MISMATCH : ${sectionsText.join(' ; ')}.`;
      this.logger.error(message);

      // Site et code de chaque compte en écart (les écarts sans compte n'ont ni site ni code).
      const accountIds = [...byAccount.keys()].filter((key) => key !== NO_ACCOUNT_KEY);
      const accounts = new Map<string, { siteId: string | null; code: string }>();
      if (accountIds.length > 0) {
        const rows = await uow
          .selectFrom('finance_cash_accounts')
          .select(['id', 'site_id', 'code'])
          .where('id', 'in', accountIds.map(toBin))
          .execute();
        for (const row of rows) {
          accounts.set(row.id.toString('hex'), {
            siteId: fromBinOrNull(row.site_id),
            code: row.code,
          });
        }
      }
      for (const entry of byAccount.values()) {
        const account =
          entry.accountKey === NO_ACCOUNT_KEY
            ? undefined
            : accounts.get(toBin(entry.accountKey).toString('hex'));
        const siteId = account?.siteId ?? null;
        const payload: Record<string, unknown> = {
          cash_account_id: entry.accountKey,
          // Libellés du message : le compte (code) et les rubriques en écart, lisibles par la Finance.
          account_label:
            entry.accountKey === NO_ACCOUNT_KEY
              ? 'Sans compte (dépenses, fournisseurs)'
              : (account?.code ?? entry.accountKey),
          sections_label: [...entry.sections].map((section) => SECTION_LABELS[section]).join(', '),
          business_day: today,
          sections: [...entry.sections],
          breaches: entry.lines.length,
          details: entry.lines.slice(0, DETAILED_MISMATCHES),
          site_id: siteId,
          ...(entry.projectedXaf !== null && entry.ledgerXaf !== null
            ? {
                difference_xaf: entry.projectedXaf - entry.ledgerXaf,
                projected_xaf: entry.projectedXaf,
                ledger_xaf: entry.ledgerXaf,
              }
            : {}),
        };
        await publishDetectionEvent(uow, this.idGenerator, {
          eventType: 'CashMismatchDetected',
          producerModule: 'finance',
          aggregateType: 'CASH_RECONCILIATION',
          aggregateId: compositeSubjectId('CASH_MISMATCH', payload),
          occurredAt: now,
          payload,
        });
      }
    });
  }
}

function detail(lines: readonly string[]): string {
  if (lines.length === 0) return '';
  const shown = lines.slice(0, DETAILED_MISMATCHES).join(' | ');
  const rest = lines.length - DETAILED_MISMATCHES;
  return ` — ${shown}${rest > 0 ? ` | et ${rest} autre(s)` : ''}`;
}
