/**
 * `finance.cash.reconcile_daily` (P4-03, étendu en P5-22) : dans une seule transaction, donc sur un même
 * instantané —
 * - INV-FIN-02 : solde projeté de chaque compte = Σ `IN` − Σ `OUT` du registre (`verifyCashLedger`) ;
 * - remises de fonds ↔ registre (`verifyCashTransfers`, P5-15) ;
 * - sessions de caisse : INV-FIN-05, 06, 11, BR-DIS-006 (`verifyCashSessions`, lectures sans verrou).
 * Même patron que `inventory.ledger.reconcile_daily` : un écart fait échouer la tâche (`JobRunner` marque
 * l'échec, `last_error` rempli), après journalisation ; l'alerte réelle `CASH_MISMATCH` n'existe pas encore
 * (alertes : P9). La correction n'est jamais automatique : `rebuildCashBalances` reste une procédure de
 * maintenance déclenchée après analyse, et le registre, les sessions et les ajustements sont immuables.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../../../platform/jobs/job-handler-registry.provider.js';
import { verifyCashLedger } from '../public/cash-accounts.js';
import { verifyCashSessions } from '../public/cash-session-verification.js';
import { verifyCashTransfers } from '../public/cash-transfer-query.js';
import { verifyExpenses, verifySupplierLedger } from '../public/operations-verification.js';

export const CASH_LEDGER_RECONCILIATION_JOB_TYPE = 'finance.cash.reconcile_daily';

/** Nombre d'écarts détaillés par section dans le message d'échec (le reste est compté, jamais tu). */
const DETAILED_MISMATCHES = 5;

@Injectable()
export class CashLedgerReconciliationJob implements OnModuleInit {
  private readonly logger = new Logger(CashLedgerReconciliationJob.name);

  constructor(@Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry) {}

  onModuleInit(): void {
    this.registry.register(CASH_LEDGER_RECONCILIATION_JOB_TYPE, async (uow) => {
      const ledger = await verifyCashLedger(uow);
      const transfers = await verifyCashTransfers(uow);
      const sessions = await verifyCashSessions(uow);
      // P8-12 : dépenses et fournisseurs (INV-FIN-07, INV-FIN-08).
      const expenses = await verifyExpenses(uow);
      const suppliers = await verifySupplierLedger(uow);
      if (!ledger.ok || !transfers.ok || !sessions.ok || !expenses.ok || !suppliers.ok) {
        const sections: string[] = [];
        if (!ledger.ok) {
          sections.push(
            `${ledger.mismatches.length} compte(s) en écart` +
              detail(
                ledger.mismatches.map(
                  (m) =>
                    `compte ${m.cashAccountId} : solde ${m.projectedXaf} ≠ registre ${m.ledgerXaf}`,
                ),
              ),
          );
        }
        if (!transfers.ok) {
          sections.push(
            `${transfers.mismatches.length} remise(s) incohérente(s)` +
              detail(transfers.mismatches.map((m) => `${m.docNumber} ${m.issue} : ${m.detail}`)),
          );
        }
        if (!sessions.ok) {
          sections.push(
            `${sessions.breaches.length} rupture(s) de session de caisse` +
              detail(
                sessions.breaches.map(
                  (b) => `session ${b.sessionId} ${b.invariant} ${b.issue} : ${b.detail}`,
                ),
              ),
          );
        }
        for (const [label, check] of [
          ['dépense(s)', expenses],
          ['document(s) fournisseur', suppliers],
        ] as const) {
          if (!check.ok) {
            sections.push(
              `${check.breaches.length} ${label} en écart` +
                detail(check.breaches.map((b) => `${b.ref} ${b.invariant} : ${b.detail}`)),
            );
          }
        }
        const message = `CASH_MISMATCH : ${sections.join(' ; ')}.`;
        this.logger.error(message);
        throw new Error(message);
      }
      this.logger.log(
        `Trésorerie réconciliée : ${ledger.accountsChecked} compte(s), ${transfers.transfersChecked} remise(s), ` +
          `${sessions.sessionsChecked} session(s), ${expenses.checked} dépense(s), ${suppliers.checked} document(s) fournisseur, aucun écart.`,
      );
    });
  }
}

function detail(lines: readonly string[]): string {
  if (lines.length === 0) return '';
  const shown = lines.slice(0, DETAILED_MISMATCHES).join(' | ');
  const rest = lines.length - DETAILED_MISMATCHES;
  return ` — ${shown}${rest > 0 ? ` | et ${rest} autre(s)` : ''}`;
}
