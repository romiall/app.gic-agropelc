/**
 * `inventory.ledger.reconcile_daily` (P2-07, P5-16) : le message d'échec nomme les ruptures
 * d'INV-STK-08 (quel transfert, quel produit, quel écart) et pas seulement leur nombre. Test unitaire :
 * les deux vérifications sont simulées (aucune altération de la base d'essai partagée, que d'autres
 * fichiers réconcilient en même temps).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/modules/inventory/application/public/ledger-reconciliation.js', () => ({
  verifyStockLedger: vi.fn(),
}));
vi.mock('../src/modules/inventory/application/public/transfer-transit.js', () => ({
  verifyTransferTransit: vi.fn(),
}));

import { JobHandlerRegistry } from '../src/platform/jobs/job-handler-registry.js';
import {
  LEDGER_RECONCILIATION_JOB_TYPE,
  LedgerReconciliationJob,
} from '../src/modules/inventory/application/jobs/ledger-reconciliation-job.js';
import { verifyStockLedger } from '../src/modules/inventory/application/public/ledger-reconciliation.js';
import { verifyTransferTransit } from '../src/modules/inventory/application/public/transfer-transit.js';

const CLEAN_LEDGER = {
  ok: true,
  balancesChecked: 3,
  mismatches: [],
  conservationBreaches: [],
  toDeliverBreaches: [],
  settlementBreaches: [],
  allocationBreaches: [],
  overcommitBreaches: [],
};

function handler() {
  const registry = new JobHandlerRegistry();
  new LedgerReconciliationJob(registry).onModuleInit();
  return registry.resolve(LEDGER_RECONCILIATION_JOB_TYPE)!;
}

describe('LedgerReconciliationJob — INV-STK-08 dans le message d’échec (P5-16)', () => {
  it('une rupture de transit nomme le transfert, le produit, la raison et les quantités', async () => {
    vi.mocked(verifyStockLedger).mockResolvedValue(CLEAN_LEDGER as never);
    vi.mocked(verifyTransferTransit).mockResolvedValue({
      ok: false,
      transfersChecked: 2,
      breaches: [
        {
          transferId: 'T-STUCK',
          productId: 'P-1',
          reason: 'TRANSIT_NOT_SETTLED',
          expectedQty: 0,
          actualQty: 58,
        },
        {
          transferId: 'T-WRONG',
          productId: null,
          reason: 'RETURNED_QTY_MISMATCH',
          expectedQty: 20,
          actualQty: 0,
        },
      ],
    });
    const run = handler();
    const failure = await run({} as never, {}).then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(failure).not.toBeNull();
    expect(failure!.message).toMatch(/LEDGER_MISMATCH/);
    expect(failure!.message).toContain('2 transfert(s) clos au transit non soldé');
    expect(failure!.message).toContain(
      'transfert T-STUCK produit P-1 : TRANSIT_NOT_SETTLED, attendu 0 ≠ constaté 58',
    );
    expect(failure!.message).toContain(
      'transfert T-WRONG produit - : RETURNED_QTY_MISMATCH, attendu 20 ≠ constaté 0',
    );
  });

  it('au-delà de cinq ruptures, le reste est compté sans être détaillé', async () => {
    vi.mocked(verifyStockLedger).mockResolvedValue(CLEAN_LEDGER as never);
    vi.mocked(verifyTransferTransit).mockResolvedValue({
      ok: false,
      transfersChecked: 9,
      breaches: Array.from({ length: 8 }, (_, index) => ({
        transferId: `T-${index}`,
        productId: 'P',
        reason: 'TRANSIT_NOT_SETTLED' as const,
        expectedQty: 0,
        actualQty: 1,
      })),
    });
    const failure = await handler()({} as never, {}).then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(failure!.message).toContain('8 transfert(s) clos au transit non soldé');
    expect(failure!.message).toContain('transfert T-4 ');
    expect(failure!.message).not.toContain('transfert T-5 ');
  });

  it('registre et transit sains : la tâche se termine sans lever', async () => {
    vi.mocked(verifyStockLedger).mockResolvedValue(CLEAN_LEDGER as never);
    vi.mocked(verifyTransferTransit).mockResolvedValue({
      ok: true,
      transfersChecked: 4,
      breaches: [],
    });
    await expect(handler()({} as never, {})).resolves.toBeUndefined();
  });
});
