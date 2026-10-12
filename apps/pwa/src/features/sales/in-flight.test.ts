import { describe, expect, it } from 'vitest';
import type { OutboxCommand } from '../../storage/db.js';
import { localOutstanding } from './credit.js';
import { deliveringByLine, openOrders } from './open-orders.js';
import { stillInFlight } from './pending.js';
import type { SalesOrderData } from './types.js';

function command(
  type: string,
  payload: unknown,
  status: OutboxCommand['status'] = 'PENDING_SYNC',
  extra: Partial<OutboxCommand> = {},
): OutboxCommand {
  return {
    command_id: `c-${type}-${status}`,
    device_seq: 1,
    command_type: type,
    command_version: 1,
    author_user_id: 'u',
    aggregate_type: 'X',
    aggregate_id: 'agg-1',
    base_version: null,
    depends_on: [],
    occurred_at: '2026-10-10T09:00:00.000Z',
    client_created_at: '2026-10-10T09:00:00.000Z',
    captured_offline: false,
    backdated_reason: null,
    attachment_ids: [],
    payload,
    status,
    attempts: 0,
    next_attempt_at: null,
    last_error: null,
    server_refs: null,
    ...extra,
  };
}

const ACCEPTED_AT = '2026-10-10T09:00:00.000Z';

describe('opérations en vol jusqu’au tirage du jeu qui les porte (ADR-037 §3)', () => {
  it('en attente : en vol ; acceptée : en vol tant que le jeu n’est pas retiré après ; refusée : non', () => {
    expect(stillInFlight({ status: 'LOCAL_ONLY', synced_at: null }, undefined)).toBe(true);
    const accepted = { status: 'SYNCED' as const, synced_at: ACCEPTED_AT };
    expect(stillInFlight(accepted, undefined)).toBe(true);
    expect(stillInFlight(accepted, '2026-10-10T08:00:00.000Z')).toBe(true);
    expect(stillInFlight(accepted, '2026-10-10T09:00:01.000Z')).toBe(false);
    expect(stillInFlight({ status: 'REJECTED', synced_at: null }, undefined)).toBe(false);
  });

  it('livraison acceptée : encore déduite du « à livrer » tant que `orders` n’est pas retiré', () => {
    const fulfil = command(
      'sales.order.fulfil',
      { orderId: 'o1', lines: [{ orderLineId: 'l1', quantityBase: 2 }] },
      'SYNCED',
      { synced_at: ACCEPTED_AT },
    );
    expect(deliveringByLine([fulfil], undefined).get('l1')).toBe(2);
    expect(deliveringByLine([fulfil], '2026-10-10T09:00:05.000Z').get('l1')).toBeUndefined();
  });

  it('commande acceptée mais pas encore retéléchargée : toujours listée ; refusée : rien n’attend du stock', () => {
    const base = {
      orders: new Map<string, SalesOrderData>(),
      products: [],
      locations: [],
    };
    const place = command(
      'sales.order.place',
      {
        customerId: 'c',
        fulfilmentLocationId: 'loc',
        lines: [{ productId: 'p', quantity: 2, unitCode: 'U', quantityBase: 2, unitPriceXaf: 100 }],
      },
      'SYNCED',
      { synced_at: ACCEPTED_AT, server_refs: { docNumber: 'CMD-1' } },
    );
    const listed = openOrders({ ...base, outbox: [place], ordersPulledAt: undefined });
    expect(listed.map((order) => [order.docNumber, order.status])).toEqual([
      ['CMD-1', 'CONFIRMED'],
    ]);
    expect(
      openOrders({ ...base, outbox: [place], ordersPulledAt: '2026-10-10T09:00:09.000Z' }),
    ).toEqual([]);
    const refused = { ...place, status: 'REJECTED' as const, synced_at: null };
    expect(
      openOrders({ ...base, outbox: [refused], ordersPulledAt: undefined })[0]?.lines[0]
        ?.pendingBase,
    ).toBe(0);
  });

  it('encours local : ventes à crédit et commandes en attente l’augmentent, encaissements le diminuent', () => {
    const customer = { id: 'c', outstanding_xaf: 1000 };
    const outbox = [
      command('sales.sale.record', {
        customerId: 'c',
        lines: [{ quantityBase: 3, unitPriceXaf: 500 }],
        payments: [{ amountXaf: 500 }],
      }),
      command('sales.order.place', {
        customerId: 'c',
        lines: [{ quantityBase: 2, unitPriceXaf: 1000 }],
        advancePayments: [{ amountXaf: 1500 }],
      }),
      command('sales.payment.record', { customerId: 'c', amountXaf: 700 }),
      command('sales.payment.record', { customerId: 'autre', amountXaf: 9999 }),
    ];
    // 1000 + (1500 − 500) + (2000 − 1500) − 700
    expect(localOutstanding(customer, outbox, undefined)).toBe(1800);
  });
});
