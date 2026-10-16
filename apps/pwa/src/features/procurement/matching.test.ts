import { describe, expect, it } from 'vitest';
import {
  hasGap,
  lineGaps,
  matchingListPaths,
  orderIndicators,
  orderInvoicesPath,
  receiptsPath,
  sortOrders,
  sortReceipts,
  type MatchingOrder,
  type MatchingOrderLine,
  type ReceiptItem,
} from './matching.js';

const SUPPLIER = '01900000-0000-7000-8000-0000000006a1';

const line = (overrides: Partial<MatchingOrderLine> = {}): MatchingOrderLine => ({
  id: 'l1',
  lineNo: 1,
  productId: 'p1',
  unitCode: 'SAC',
  orderedQtyBase: 100,
  deliveredQtyBase: 0,
  rejectedQtyBase: 0,
  quarantinedQtyBase: 0,
  acceptedQtyBase: 0,
  closedQtyBase: 0,
  excessQtyBase: 0,
  invoicedQtyBase: 0,
  remainingQtyBase: 100,
  unitPriceXaf: 1_000,
  lineTotalXaf: 100_000,
  status: 'OPEN',
  ...overrides,
});

const order = (overrides: Partial<MatchingOrder> = {}): MatchingOrder => ({
  id: 'o1',
  docNumber: 'BC-2026-000001',
  siteId: 's',
  supplierId: SUPPLIER,
  expectedDeliveryDate: '2026-10-05',
  status: 'PARTIALLY_RECEIVED',
  totalXaf: 100_000,
  sentAt: null,
  closedReason: null,
  occurredAt: '2026-10-01T08:00:00.000Z',
  lines: [line()],
  ...overrides,
});

describe('rapprochement des bons (ECR-APP-05, P8E-07)', () => {
  it('lectures : un chemin par statut du groupe, fournisseur facultatif ; réceptions et factures du bon', () => {
    expect(matchingListPaths('OPEN', '')).toEqual([
      '/api/v1/purchase-orders?status=SENT&limit=200',
      '/api/v1/purchase-orders?status=PARTIALLY_RECEIVED&limit=200',
    ]);
    expect(matchingListPaths('CLOSED', SUPPLIER)).toEqual([
      `/api/v1/purchase-orders?status=CLOSED&limit=200&supplier_id=${SUPPLIER}`,
    ]);
    expect(receiptsPath('o1')).toBe('/api/v1/receipts?purchase_order_id=o1&limit=200');
    expect(orderInvoicesPath('o1')).toBe(
      '/api/v1/supplier-invoices?purchase_order_id=o1&limit=200',
    );
  });

  it('tris : le plus récent d’abord, départagé par l’identifiant', () => {
    expect(
      sortOrders([
        order({ id: 'a', occurredAt: '2026-10-01T08:00:00.000Z' }),
        order({ id: 'c', occurredAt: '2026-10-02T08:00:00.000Z' }),
        order({ id: 'b', occurredAt: '2026-10-01T08:00:00.000Z' }),
      ]).map((item) => item.id),
    ).toEqual(['c', 'b', 'a']);
    const receipt = (id: string, occurredAt: string) =>
      ({ id, occurredAt, lines: [] }) as unknown as ReceiptItem;
    expect(
      sortReceipts([
        receipt('r1', '2026-10-01T08:00:00.000Z'),
        receipt('r2', '2026-10-03T08:00:00.000Z'),
      ]).map((item) => item.id),
    ).toEqual(['r2', 'r1']);
  });

  it('écarts d’une ligne (AT-023 puis AT-025) ; ligne annulée ignorée ; millièmes', () => {
    // 100 commandés, 98 livrés, 3 rejetés, 95 acceptés, 98 facturés (écart approuvé).
    expect(
      lineGaps(
        line({
          deliveredQtyBase: 98,
          rejectedQtyBase: 3,
          acceptedQtyBase: 95,
          remainingQtyBase: 5,
          invoicedQtyBase: 98,
        }),
      ),
    ).toEqual(['REMAINING', 'REJECTED', 'OVER_INVOICED']);
    expect(
      lineGaps(line({ remainingQtyBase: 0, quarantinedQtyBase: 4, excessQtyBase: 2 })),
    ).toEqual(['QUARANTINED', 'EXCESS']);
    expect(lineGaps(line({ status: 'CANCELLED', rejectedQtyBase: 3 }))).toEqual([]);
    // Facturé égal à l'accepté au millième : pas d'écart.
    expect(
      lineGaps(line({ remainingQtyBase: 0, acceptedQtyBase: 12.5, invoicedQtyBase: 12.5004 })),
    ).toEqual([]);
    expect(
      lineGaps(line({ remainingQtyBase: 0, acceptedQtyBase: 12.5, invoicedQtyBase: 12.501 })),
    ).toEqual(['OVER_INVOICED']);
  });

  it('indicateurs d’un bon : reliquat, rejet, quarantaine, excédent, facturé au-delà, date prévue dépassée', () => {
    const late = orderIndicators(
      order({
        lines: [
          line({ rejectedQtyBase: 3, remainingQtyBase: 5 }),
          line({ id: 'l2', remainingQtyBase: 0, invoicedQtyBase: 1 }),
          line({ id: 'l3', status: 'CANCELLED', remainingQtyBase: 9, quarantinedQtyBase: 1 }),
        ],
      }),
      '2026-10-10',
    );
    expect(late).toEqual({
      remainingLines: 1,
      rejected: true,
      quarantined: false,
      excess: false,
      overInvoiced: true,
      overdueDays: 5,
    });
    expect(hasGap(late)).toBe(true);
    // Le jour même : pas encore en retard ; sans date prévue : jamais.
    expect(orderIndicators(order(), '2026-10-05').overdueDays).toBeNull();
    expect(
      orderIndicators(order({ expectedDeliveryDate: null }), '2026-10-10').overdueDays,
    ).toBeNull();
    // Envoyé et attendu : en retard aussi ; reçu ou clôturé : plus rien n'est attendu.
    expect(orderIndicators(order({ status: 'SENT' }), '2026-10-06').overdueDays).toBe(1);
    expect(orderIndicators(order({ status: 'RECEIVED' }), '2026-10-10').overdueDays).toBeNull();
    // Sans reliquat : rien n'est attendu.
    expect(
      orderIndicators(order({ lines: [line({ remainingQtyBase: 0 })] }), '2026-10-10').overdueDays,
    ).toBeNull();
    // Reliquat seul, dans les temps : pas un écart à examiner.
    const onTime = orderIndicators(order({ expectedDeliveryDate: '2026-10-20' }), '2026-10-10');
    expect(onTime.remainingLines).toBe(1);
    expect(hasGap(onTime)).toBe(false);
    expect(
      hasGap(
        orderIndicators(
          order({ status: 'RECEIVED', lines: [line({ remainingQtyBase: 0, excessQtyBase: 1 })] }),
          '2026-10-10',
        ),
      ),
    ).toBe(true);
    expect(
      hasGap(
        orderIndicators(
          order({
            status: 'RECEIVED',
            lines: [line({ remainingQtyBase: 0, quarantinedQtyBase: 1 })],
          }),
          '2026-10-10',
        ),
      ),
    ).toBe(true);
  });

  it('revue de P8E-07 : bon lu deux fois dédoublonné ; un seul écart suffit ; date prévue mal formée', () => {
    // Bon passé de SENT à PARTIALLY_RECEIVED entre deux lectures : une seule carte, la dernière lue.
    expect(
      sortOrders([
        order({ id: 'o1', status: 'SENT' }),
        order({ id: 'o2', occurredAt: '2026-10-03T08:00:00.000Z' }),
        order({ id: 'o1', status: 'PARTIALLY_RECEIVED' }),
      ]).map((item) => [item.id, item.status]),
    ).toEqual([
      ['o2', 'PARTIALLY_RECEIVED'],
      ['o1', 'PARTIALLY_RECEIVED'],
    ]);
    const only = (lines: MatchingOrderLine[], overrides: Partial<MatchingOrder> = {}) =>
      hasGap(
        orderIndicators(
          order({ status: 'RECEIVED', expectedDeliveryDate: null, lines, ...overrides }),
          '2026-10-10',
        ),
      );
    expect(only([line({ remainingQtyBase: 0 })])).toBe(false);
    expect(only([line({ remainingQtyBase: 0, rejectedQtyBase: 1 })])).toBe(true);
    expect(only([line({ remainingQtyBase: 0, invoicedQtyBase: 1 })])).toBe(true);
    expect(
      only([line({ remainingQtyBase: 5 })], { status: 'SENT', expectedDeliveryDate: '2026-10-09' }),
    ).toBe(true);
    // Date prévue qui n'est pas un jour : aucun retard calculé.
    expect(
      orderIndicators(order({ expectedDeliveryDate: '2026-10-05T00:00:00Z' }), '2026-10-10')
        .overdueDays,
    ).toBeNull();
    // Réceptions à date égale : départagées par l'identifiant.
    const receipt = (id: string) =>
      ({ id, occurredAt: '2026-10-01T08:00:00.000Z', lines: [] }) as unknown as ReceiptItem;
    expect(sortReceipts([receipt('a'), receipt('b')]).map((item) => item.id)).toEqual(['b', 'a']);
  });
});
