import { describe, expect, it } from 'vitest';
import type { OutboxCommand } from '../../storage/db.js';
import { duesFromRecentSales, pendingPaymentsOf } from './collect.js';
import { stillInFlight } from './pending.js';
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

  it('hors ligne : un encaissement accepté compte encore tant que les ventes ne sont pas relues (MP-11)', () => {
    const accepted = {
      command_id: 'p3',
      command_type: 'sales.payment.record',
      status: 'SYNCED',
      synced_at: '2026-10-10T08:00:05.000Z',
      occurred_at: '2026-10-10T08:00:00.000Z',
      payload: { customerId: 'conserve', amountXaf: 1000 },
    } as unknown as OutboxCommand;
    // Par défaut (créances lues en ligne) : seuls les encaissements en attente.
    expect(pendingPaymentsOf([accepted], 'conserve')).toEqual([]);
    const before = (command: OutboxCommand) => stillInFlight(command, '2026-10-10T08:00:00.000Z');
    const after = (command: OutboxCommand) => stillInFlight(command, '2026-10-10T08:01:00.000Z');
    expect(pendingPaymentsOf([accepted], 'conserve', new Map(), before)).toHaveLength(1);
    expect(pendingPaymentsOf([accepted], 'conserve', new Map(), after)).toEqual([]);
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
