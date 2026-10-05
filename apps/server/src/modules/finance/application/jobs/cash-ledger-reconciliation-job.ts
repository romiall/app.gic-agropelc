/**
 * `finance.cash.reconcile_daily` (P4-03 ; INV-FIN-02 : « solde d'un compte = Σ `IN` − Σ `OUT` ;
 * la projection est exacte »). Même patron que `inventory.ledger.reconcile_daily` : un écart fait
 * échouer la tâche (`JobRunner` marque l'échec, `last_error` rempli) ; l'alerte réelle
 * `CASH_MISMATCH` n'existe pas encore (alertes : P9). La correction n'est jamais automatique :
 * `rebuildCashBalances` reste une procédure de maintenance déclenchée après analyse.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../../../platform/jobs/job-handler-registry.provider.js';
import { verifyCashLedger } from '../public/cash-accounts.js';

export const CASH_LEDGER_RECONCILIATION_JOB_TYPE = 'finance.cash.reconcile_daily';

/** Nombre d'écarts détaillés dans le message d'échec (le reste est compté, jamais tu). */
const DETAILED_MISMATCHES = 5;

@Injectable()
export class CashLedgerReconciliationJob implements OnModuleInit {
  private readonly logger = new Logger(CashLedgerReconciliationJob.name);

  constructor(@Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry) {}

  onModuleInit(): void {
    this.registry.register(CASH_LEDGER_RECONCILIATION_JOB_TYPE, async (uow) => {
      const result = await verifyCashLedger(uow);
      if (!result.ok) {
        const details = result.mismatches
          .slice(0, DETAILED_MISMATCHES)
          .map(
            (m) => `compte ${m.cashAccountId} : solde ${m.projectedXaf} ≠ registre ${m.ledgerXaf}`,
          )
          .join(' ; ');
        throw new Error(
          `CASH_MISMATCH : ${result.mismatches.length} compte(s) en écart` +
            (details ? ` — ${details}` : '') +
            '.',
        );
      }
      this.logger.log(
        `Registre de trésorerie réconcilié : ${result.accountsChecked} compte(s), aucun écart.`,
      );
    });
  }
}
