import { describe, expect, it } from 'vitest';
import type { OutboxCommand } from '../../storage/db.js';
import {
  duesFromReceivables,
  duesFromRecentSales,
  pendingPaymentsOf,
  type ReceivableLine,
} from './collect.js';
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

  it('créances lues en ligne : celles du compte absorbé reviennent au compte conservé, chaque vente une seule fois', () => {
    const line = (saleId: string, customerId: string, balanceDueXaf: number): ReceivableLine => ({
      saleId,
      docNumber: saleId.toUpperCase(),
      customerId,
      occurredAt: '2026-10-01T08:00:00.000Z',
      dueDate: '2026-10-31',
      balanceDueXaf,
    });
    // Le serveur rend, pour le compte conservé, ses ventes et celles de ses comptes absorbés (S-22).
    const lines = [
      line('v1', 'conserve', 5000),
      line('v2', 'absorbe', 3000),
      line('autre', 'tiers', 9000),
    ];
    const accounts = ['conserve', 'absorbe'];
    expect(duesFromReceivables(lines, 'conserve', accounts).map((due) => due.saleId)).toEqual([
      'v1',
      'v2',
    ]);
    // Une vente rendue deux fois (réponses additionnées, serveur qui la répète) n'est comptée qu'une fois.
    const twice = duesFromReceivables(
      [...lines, line('v2', 'absorbe', 3000)],
      'conserve',
      accounts,
    );
    expect(twice.map((due) => due.saleId)).toEqual(['v1', 'v2']);
    expect(twice.reduce((sum, due) => sum + due.balanceXaf, 0)).toBe(8000);
    // Une vente soldée n'est pas une créance.
    expect(duesFromReceivables([line('v3', 'conserve', 0)], 'conserve', accounts)).toEqual([]);
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
