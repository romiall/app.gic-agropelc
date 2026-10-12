import { describe, expect, it } from 'vitest';
import type { OutboxCommand } from '../../storage/db.js';
import type { SaleView } from '../sales/recent-sales.js';
import type { AllocationData } from '../sales/types.js';
import { canRelease, myQuotas, releasePayload, todaySales } from './pos-home.js';

const NOW = new Date('2026-10-10T09:00:00.000Z');

function sale(overrides: Partial<SaleView>): SaleView {
  return {
    id: 's',
    docNumber: null,
    status: 'CONFIRMED',
    paymentStatus: 'PAID',
    occurredAt: '2026-10-10T08:00:00.000Z',
    customerId: null,
    sellerUserId: 'moi',
    fromLocationId: 'pdv',
    siteId: 'site',
    netTotalXaf: 1_000,
    amountPaidXaf: 1_000,
    balanceDueXaf: 0,
    capturedOffline: false,
    flags: [],
    lines: [],
    commandId: null,
    rejection: null,
    cancellationPending: false,
    ...overrides,
  } as SaleView;
}

function allocation(overrides: Partial<AllocationData> = {}): AllocationData {
  return {
    id: 'q1',
    location_id: 'pdv',
    product_id: 'oeuf',
    lot_id: null,
    holder_user_id: 'moi',
    holder_device_id: 'tel',
    quantity_granted: '40.000',
    quantity_remaining: '40.000',
    valid_until: null,
    status: 'ACTIVE',
    revocation_pending: false,
    version: 1,
    ...overrides,
  };
}

describe('Accueil du PDV : ventes du jour et quotas', () => {
  it('ventes du jour : emplacement, jour métier de Douala, annulées et refusées exclues', () => {
    const summary = todaySales(
      [
        sale({ id: 'a', netTotalXaf: 1_000, amountPaidXaf: 600 }),
        sale({ id: 'b', status: 'PENDING', netTotalXaf: 500, amountPaidXaf: 500 }),
        sale({ id: 'c', status: 'CANCELLED' }),
        sale({ id: 'd', status: 'REJECTED' }),
        sale({ id: 'e', fromLocationId: 'magasin' }),
        // 23:30 à Douala la veille (22:30 UTC) : un autre jour métier.
        sale({ id: 'f', occurredAt: '2026-10-09T22:30:00.000Z' }),
      ],
      'pdv',
      NOW,
    );
    expect(summary).toEqual({ count: 2, netXaf: 1_500, paidXaf: 1_100, pendingCount: 1 });
  });

  it('quotas : ceux de l’utilisateur sur cet appareil, reste net du premier consommé, échéance, libération', () => {
    const outbox = [
      {
        command_id: 'v',
        device_seq: 1,
        command_type: 'sales.sale.record',
        author_user_id: 'moi',
        status: 'LOCAL_ONLY',
        occurred_at: '2026-10-10T08:30:00.000Z',
        payload: {
          fromLocationId: 'pdv',
          lines: [{ productId: 'oeuf', quantityBase: 8 }],
          payments: [],
        },
      } as unknown as OutboxCommand,
    ];
    const pending = new Map([['moi', new Map([['pdv:oeuf', 8]])]]);
    const refs = {
      allocations: [
        allocation(),
        // Second quota du même couple (lot indicatif) : reste servi, non consommé en premier.
        allocation({ id: 'q2', quantity_remaining: '10.000' }),
        allocation({ id: 'q3', product_id: 'poulet', valid_until: '2026-10-09T22:59:59.999Z' }),
        allocation({ id: 'autre-tel', holder_device_id: 'autre' }),
        allocation({ id: 'autre-user', holder_user_id: 'autre' }),
      ],
      outbox,
      quotaPending: pending,
    };
    const quotas = myQuotas(refs, { userId: 'moi', deviceId: 'tel', now: NOW });
    expect(quotas.map((q) => [q.allocation.id, q.remaining, q.expired])).toEqual([
      ['q1', 32, false],
      ['q2', 10, false],
      ['q3', 40, true],
    ]);
    expect(myQuotas(refs, { userId: 'moi', deviceId: undefined, now: NOW })).toEqual([]);
    // Libération saisie : marquée, plus libérable ; signal de révocation : pas libérable.
    const released = myQuotas(
      {
        ...refs,
        outbox: [
          ...outbox,
          {
            command_id: 'r',
            device_seq: 2,
            command_type: 'inventory.allocation.release',
            aggregate_id: 'q1',
            status: 'LOCAL_ONLY',
          } as unknown as OutboxCommand,
        ],
      },
      { userId: 'moi', deviceId: 'tel', now: NOW },
    );
    expect(released[0]).toMatchObject({ releasing: true });
    expect(canRelease(released[0]!)).toBe(false);
    expect(canRelease({ ...quotas[0]!, revocationPending: true })).toBe(false);
    expect(canRelease(quotas[0]!)).toBe(true);
    expect(releasePayload({ remaining: -2 })).toEqual({ remainingBase: 0 });
    expect(releasePayload({ remaining: 12.3456 })).toEqual({ remainingBase: 12.346 });
  });
});
