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
import { verifyTransferTransit, type TransferTransitBreach } from '../public/transfer-transit.js';

export const LEDGER_RECONCILIATION_JOB_TYPE = 'inventory.ledger.reconcile_daily';

/** Nombre d'écarts détaillés dans le message d'échec (le reste est compté, jamais tu). */
const DETAILED_MISMATCHES = 5;

/** Une rupture d'INV-STK-08 dans le message d'échec : quel transfert, quel produit, quel écart. */
function describeTransitBreach(breach: TransferTransitBreach): string {
  return (
    `transfert ${breach.transferId} produit ${breach.productId ?? '-'} : ${breach.reason}, ` +
    `attendu ${breach.expectedQty} ≠ constaté ${breach.actualQty}`
  );
}

@Injectable()
export class LedgerReconciliationJob implements OnModuleInit {
  private readonly logger = new Logger(LedgerReconciliationJob.name);

  constructor(@Inject(JOB_HANDLER_REGISTRY) private readonly registry: JobHandlerRegistry) {}

  onModuleInit(): void {
    this.registry.register(LEDGER_RECONCILIATION_JOB_TYPE, async (uow) => {
      const result = await verifyStockLedger(uow);
      // INV-STK-08 (P5-16) : transit soldé des transferts clos, réception sans document comprise.
      const transit = await verifyTransferTransit(uow);
      if (!result.ok || !transit.ok) {
        const details = [
          ...result.mismatches
            .slice(0, DETAILED_MISMATCHES)
            .map(
              (m) =>
                `emplacement ${m.locationId} produit ${m.productId} lot ${m.lotId ?? '-'} : ` +
                `projection ${m.projectedQty} ≠ registre ${m.ledgerQty}`,
            ),
          ...transit.breaches.slice(0, DETAILED_MISMATCHES).map(describeTransitBreach),
          // P5-22 : quotas fautifs nommés (INV-STK-19, INV-STK-20), pas seulement comptés.
          ...result.allocationBreaches
            .slice(0, DETAILED_MISMATCHES)
            .map((b) => `quota ${b.allocationId} : ${b.reason} (reste ${b.remaining})`),
          ...result.overcommitBreaches
            .slice(0, DETAILED_MISMATCHES)
            .map(
              (b) =>
                `emplacement ${b.locationId} produit ${b.productId} : quotas ${b.allocatedRemaining} > stock ${b.stockOnHand}`,
            ),
        ].join(' ; ');
        const message =
          `LEDGER_MISMATCH : ${result.mismatches.length} solde(s) en écart, ` +
          `${result.conservationBreaches.length} produit(s) hors conservation, ` +
          `${result.toDeliverBreaches.length} solde(s) « à livrer » négatif(s), ` +
          `${result.settlementBreaches.length} vente(s) au règlement incohérent, ` +
          `${result.allocationBreaches.length} quota(s) au registre incohérent, ` +
          `${result.overcommitBreaches.length} emplacement(s) dont les quotas dépassent le stock sans conflit, ` +
          `${transit.breaches.length} transfert(s) clos au transit non soldé` +
          (details ? ` — ${details}` : '') +
          '.';
        this.logger.error(message);
        throw new Error(message);
      }
      this.logger.log(
        `Registre de stock réconcilié : ${result.balancesChecked} solde(s), ` +
          `${transit.transfersChecked} transfert(s) clos, aucun écart.`,
      );
    });
  }
}
