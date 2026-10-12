import { describe, expect, it } from 'vitest';
import type { OutboxCommand } from '../../storage/db.js';
import { EXPECTED_DIRECT_CANCEL, quotaPendingByAuthor } from '../sales/quota.js';
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

function command(overrides: Partial<OutboxCommand>): OutboxCommand {
  return {
    command_id: 'c',
    device_seq: 1,
    command_type: 'sales.sale.record',
    aggregate_id: 'vente',
    author_user_id: 'moi',
    status: 'LOCAL_ONLY',
    occurred_at: '2026-10-10T08:30:00.000Z',
    payload: {},
    ...overrides,
  } as OutboxCommand;
}

const pendingOf = (outbox: readonly OutboxCommand[], allocationsPulledAt?: string) =>
  quotaPendingByAuthor(outbox, allocationsPulledAt, new Map(), new Map(), new Map());

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
    const pending = pendingOf(outbox);
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
            payload: { remainingBase: 32 },
          } as unknown as OutboxCommand,
        ],
      },
      { userId: 'moi', deviceId: 'tel', now: NOW },
    );
    // Le reste montré est celui que la libération déclare, pas le reste servi (40).
    expect(released[0]).toMatchObject({ releasing: true, remaining: 32 });
    expect(canRelease(released[0]!)).toBe(false);
    expect(canRelease({ ...quotas[0]!, revocationPending: true })).toBe(false);
    expect(canRelease(quotas[0]!)).toBe(true);
    expect(releasePayload({ remaining: -2 })).toEqual({ remainingBase: 0 });
    expect(releasePayload({ remaining: 12.3456 })).toEqual({ remainingBase: 12.346 });
  });

  it('quota échu : seules les sorties antérieures à l’échéance le réduisent, comme au serveur', () => {
    const loss = (id: string, occurredAt: string, quantityBase: number) =>
      command({
        command_id: id,
        command_type: 'inventory.loss.declare',
        occurred_at: occurredAt,
        payload: { locationId: 'pdv', productId: 'oeuf', quantityBase },
      });
    const refs = {
      allocations: [allocation({ valid_until: '2026-10-09T22:59:59.999Z' })],
      outbox: [
        // Avant l'échéance : prise sur le quota.
        loss('avant', '2026-10-09T20:00:00.000Z', 3),
        // Après l'échéance (le lendemain matin) : prise sur le stock commun.
        loss('apres', '2026-10-10T06:00:00.000Z', 2),
      ],
      quotaPending: new Map(),
    };
    const [quota] = myQuotas(
      { ...refs, quotaPending: pendingOf(refs.outbox) },
      { userId: 'moi', deviceId: 'tel', now: NOW },
    );
    expect(quota).toMatchObject({ remaining: 37, expired: true });
    expect(releasePayload(quota!)).toEqual({ remainingBase: 37 });
  });

  it('annulation directe d’une vente déjà relue : la quantité revient au quota, plafonnée à l’accordé', () => {
    // Vente de 3 acceptée et ramenée par le tirage des quotas (reste servi : 37 sur 40).
    const sold = command({
      command_id: 'vente-cmd',
      aggregate_id: 'vente',
      status: 'SYNCED',
      synced_at: '2026-10-10T08:31:00.000Z',
      payload: { fromLocationId: 'pdv', lines: [{ productId: 'oeuf', quantityBase: 3 }] },
    });
    const cancel = (overrides: Partial<OutboxCommand>) =>
      command({
        command_id: 'annulation',
        device_seq: 2,
        command_type: 'sales.sale.cancel',
        aggregate_id: 'annulation',
        occurred_at: '2026-10-10T08:45:00.000Z',
        local_flags: [EXPECTED_DIRECT_CANCEL],
        payload: { saleId: 'vente' },
        ...overrides,
      });
    const remainingWith = (outbox: readonly OutboxCommand[], pulledAt: string, served = '37.000') =>
      myQuotas(
        {
          allocations: [allocation({ quantity_remaining: served })],
          outbox,
          quotaPending: pendingOf(outbox, pulledAt),
        },
        { userId: 'moi', deviceId: 'tel', now: NOW },
      )[0]?.remaining;
    const pulled = '2026-10-10T08:40:00.000Z';
    // En attente : le serveur rendra 3 au quota encore actif (ADR-033 §8).
    expect(remainingWith([sold, cancel({})], pulled)).toBe(40);
    // Jamais au-delà de l'accordé : l'appareil ignore la part prise sur le stock libre.
    expect(remainingWith([sold, cancel({})], pulled, '39.000')).toBe(40);
    // Acceptée sans avertissement, pas encore relue : rendue ; relue : le reste servi l'inclut.
    const applied = cancel({ status: 'SYNCED', synced_at: '2026-10-10T08:50:00.000Z' });
    expect(remainingWith([sold, applied], pulled)).toBe(40);
    expect(remainingWith([sold, applied], '2026-10-10T09:00:00.000Z', '40.000')).toBe(40);
    // Devenue une demande (avertissement) : rien n'est rendu.
    const requested = cancel({
      status: 'SYNCED_WITH_WARNING',
      synced_at: '2026-10-10T08:50:00.000Z',
      warnings: ['CANCEL_WINDOW_EXCEEDED'],
    });
    expect(remainingWith([sold, requested], pulled)).toBe(37);
    // Vente d'un autre utilisateur de la tablette : son quota à lui, pas celui-ci.
    expect(remainingWith([{ ...sold, author_user_id: 'autre' }, cancel({})], pulled)).toBe(37);
  });

  it('quota signalé : le serveur le consomme encore, le reste montré est net des ventes en attente', () => {
    const outbox = [
      command({
        payload: { fromLocationId: 'pdv', lines: [{ productId: 'oeuf', quantityBase: 8 }] },
      }),
    ];
    const [quota] = myQuotas(
      {
        allocations: [allocation({ revocation_pending: true })],
        outbox,
        quotaPending: pendingOf(outbox),
      },
      { userId: 'moi', deviceId: 'tel', now: NOW },
    );
    expect(quota).toMatchObject({ remaining: 32, revocationPending: true });
    expect(canRelease(quota!)).toBe(false);
  });
});
