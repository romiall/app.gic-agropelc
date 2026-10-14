import { describe, expect, it } from 'vitest';
import type { OutboxCommand } from '../../storage/db.js';
import { duesFromRecentSales, pendingPaymentsOf } from './collect.js';
import type { SaleData } from './types.js';

const alias = new Map([['absorbe', 'conserve']]);

describe('Encaissement d’un compte conservé après fusion (BR-CRM-007)', () => {
  it('ventes dues et encaissements en attente du compte absorbé rattachés au compte conservé', () => {
    const sale = {
      id: 'v1',
      doc_number: 'VTE-1',
      customer_id: 'absorbe',
      status: 'CONFIRMED',
      balance_due_xaf: 5000,
      due_date: null,
      occurred_at: '2026-10-09T10:00:00.000Z',
    } as unknown as SaleData;
    expect(duesFromRecentSales([sale], 'conserve')).toEqual([]);
    expect(duesFromRecentSales([sale], 'conserve', alias).map((due) => due.saleId)).toEqual(['v1']);
    const payment = {
      command_id: 'p1',
      command_type: 'sales.payment.record',
      status: 'LOCAL_ONLY',
      occurred_at: '2026-10-10T08:00:00.000Z',
      payload: { customerId: 'absorbe', amountXaf: 2000 },
    } as unknown as OutboxCommand;
    expect(pendingPaymentsOf([payment], 'conserve', alias)).toEqual([
      { commandId: 'p1', amountXaf: 2000, occurredAt: '2026-10-10T08:00:00.000Z', targets: null },
    ]);
  });

  it('encaissement ciblé en attente : ses affectations aux ventes, pas celles aux commandes', () => {
    const payment = {
      command_id: 'p2',
      command_type: 'sales.payment.record',
      status: 'PENDING_SYNC',
      occurred_at: '2026-10-10T08:00:00.000Z',
      payload: {
        customerId: 'conserve',
        amountXaf: 3000,
        allocations: [
          { saleId: 'v1', amountXaf: 1000 },
          { orderId: 'c1', amountXaf: 2000 },
        ],
      },
    } as unknown as OutboxCommand;
    expect(pendingPaymentsOf([payment], 'conserve')[0]?.targets).toEqual([
      { saleId: 'v1', amountXaf: 1000 },
    ]);
  });
});
