/**
 * `inventory.ledger.reconcile_daily` (P2-07 ; stratégie stock §3.1, INV-STK-01 et INV-STK-03 :
 * « un job quotidien compare la projection au registre et lève `LEDGER_MISMATCH` »). Même
 * patron que `audit.chain.verify_daily` (P0-07) : un écart fait échouer la tâche (`JobRunner`
 * marque l'échec, `last_error` rempli) ; l'alerte réelle `LEDGER_MISMATCH` (catalogue d'alertes,
 * module `communication`) n'existe pas encore — hors périmètre P2, comme l'alerte de rupture de
 * chaîne d'audit en P0-07. La correction n'est jamais automatique : `rebuildStockBalances` reste
 * une procédure de maintenance déclenchée par un responsable après analyse de l'écart.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  JOB_HANDLER_REGISTRY,
  type JobHandlerRegistry,
} from '../../../../platform/jobs/job-handler-registry.provider.js';
import { verifyStockLedger } from '../public/ledger-reconciliation.js';

export const LEDGER_RECONCILIATION_JOB_TYPE = 'inventory.ledger.reconcile_daily';

/** Nombre d'écarts détaillés dans le message d'échec (le reste est compté, jamais tu). */
const DETAILED_MISMATCHES = 5;

@Injectable()
export class LedgerReconciliationJob implements OnModuleInit {
  private readonly logger = new Logger(LedgerReconciliationJob.name);

  constructor(@Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry) {}

  onModuleInit(): void {
    this.registry.register(LEDGER_RECONCILIATION_JOB_TYPE, async (uow) => {
      const result = await verifyStockLedger(uow);
      if (!result.ok) {
        const details = result.mismatches
          .slice(0, DETAILED_MISMATCHES)
          .map(
            (m) =>
              `emplacement ${m.locationId} produit ${m.productId} lot ${m.lotId ?? '-'} : ` +
              `projection ${m.projectedQty} ≠ registre ${m.ledgerQty}`,
          )
          .join(' ; ');
        throw new Error(
          `LEDGER_MISMATCH : ${result.mismatches.length} solde(s) en écart, ` +
            `${result.conservationBreaches.length} produit(s) hors conservation, ` +
            `${result.toDeliverBreaches.length} solde(s) « à livrer » négatif(s), ` +
            `${result.settlementBreaches.length} vente(s) au règlement incohérent` +
            (details ? ` — ${details}` : '') +
            '.',
        );
      }
      this.logger.log(
        `Registre de stock réconcilié : ${result.balancesChecked} solde(s), aucun écart.`,
      );
    });
  }
}
