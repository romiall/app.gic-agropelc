import { describe, expect, it } from 'vitest';
import type { OutboxCommand } from '../../storage/db.js';
import {
  DELIVERY_ON_CREDIT_ALLOWED_SETTING,
  DELIVERY_REQUIRES_FULL_PAYMENT_SETTING,
  deliveryOnCreditAllowed,
  deliveryPaymentRequired,
  deliveryPaymentView,
  unpaidOfOrder,
} from './delivery-payment.js';
import type { SaleData, SettingData } from './types.js';

const NOW = new Date('2026-11-04T10:00:00.000Z');
const SITE = 'site-yde';
const ORDER = 'commande-1';
const CUSTOMER = 'client-1';

let seq = 0;
const setting = (
  value: unknown,
  scope: { type: 'SITE' | 'GLOBAL'; id: string | null },
  validFrom = '2026-11-01T00:00:00.000Z',
): SettingData => ({
  id: `s-${seq++}`,
  key: DELIVERY_REQUIRES_FULL_PAYMENT_SETTING,
  value,
  scope_type: scope.type,
  scope_id: scope.id,
  valid_from: validFrom,
});
const GLOBAL = { type: 'GLOBAL', id: null } as const;
const site = (id: string) => ({ type: 'SITE', id }) as const;

const sale = (overrides: Partial<SaleData>): SaleData =>
  ({
    id: `vente-${seq++}`,
    doc_number: 'VTE-2026-000001',
    sale_type: 'ORDER',
    order_id: ORDER,
    status: 'CONFIRMED',
    customer_id: CUSTOMER,
    balance_due_xaf: 3000,
    due_date: '2026-12-04',
    occurred_at: '2026-11-04T08:00:00.000Z',
    ...overrides,
  }) as SaleData;

const payment = (payload: object, overrides: Partial<OutboxCommand> = {}): OutboxCommand =>
  ({
    command_id: `cmd-${seq++}`,
    device_seq: seq,
    command_type: 'sales.payment.record',
    command_version: 1,
    author_user_id: 'u',
    aggregate_type: 'CUSTOMER_PAYMENT',
    aggregate_id: `agg-${seq}`,
    base_version: null,
    depends_on: [],
    occurred_at: '2026-11-04T09:00:00.000Z',
    client_created_at: '2026-11-04T09:00:00.000Z',
    captured_offline: false,
    backdated_reason: null,
    attachment_ids: [],
    payload,
    status: 'PENDING_SYNC',
    attempts: 0,
    next_attempt_at: null,
    last_error: null,
    server_refs: null,
    ...overrides,
  }) as OutboxCommand;

describe('paiement avant livraison, vu par l’appareil (AV-511)', () => {
  it('exigé par défaut : seule une valeur explicitement fausse lève l’exigence, comme au serveur', () => {
    expect(deliveryPaymentRequired([], SITE, NOW)).toBe(true);
    expect(deliveryPaymentRequired([setting(true, GLOBAL)], SITE, NOW)).toBe(true);
    // Mal formé : l'exigence demeure.
    expect(deliveryPaymentRequired([setting('false', GLOBAL)], SITE, NOW)).toBe(true);
    expect(deliveryPaymentRequired([setting(0, GLOBAL)], SITE, NOW)).toBe(true);
    // Faux : levée, au global ou pour le site seulement.
    expect(deliveryPaymentRequired([setting(false, GLOBAL)], SITE, NOW)).toBe(false);
    expect(deliveryPaymentRequired([setting(false, site(SITE))], SITE, NOW)).toBe(false);
    expect(deliveryPaymentRequired([setting(false, site(SITE))], 'site-dla', NOW)).toBe(true);
    // Le réglage du site l'emporte sur le global ; une version à venir n'est pas encore en vigueur.
    expect(
      deliveryPaymentRequired([setting(false, GLOBAL), setting(true, site(SITE))], SITE, NOW),
    ).toBe(true);
    expect(
      deliveryPaymentRequired([setting(false, GLOBAL, '2026-12-01T00:00:00.000Z')], SITE, NOW),
    ).toBe(true);
  });

  it('reste dû d’une commande : ventes confirmées de la commande, soldes positifs seulement', () => {
    const sales = [
      sale({ id: 'v1', doc_number: 'VTE-1', balance_due_xaf: 3000 }),
      sale({ id: 'v2', doc_number: 'VTE-2', balance_due_xaf: 0 }),
      // Autre commande, vente directe, vente en demande d'annulation : jamais comptées.
      sale({ id: 'v3', doc_number: 'VTE-3', order_id: 'autre' }),
      sale({ id: 'v4', doc_number: 'VTE-4', order_id: null, sale_type: 'DIRECT' }),
      sale({ id: 'v5', doc_number: 'VTE-5', status: 'CANCELLATION_REQUESTED' }),
    ];
    const dues = unpaidOfOrder({
      sales,
      outbox: [],
      orderId: ORDER,
      customerId: CUSTOMER,
      alias: new Map(),
    });
    expect(dues.map((due) => [due.saleId, due.balanceXaf])).toEqual([['v1', 3000]]);
    expect(
      unpaidOfOrder({
        sales: [],
        outbox: [],
        orderId: ORDER,
        customerId: CUSTOMER,
        alias: new Map(),
      }),
    ).toEqual([]);
  });

  it('un encaissement du client saisi sur l’appareil et pas encore envoyé est retranché', () => {
    const sales = [sale({ id: 'v1', balance_due_xaf: 3000 })];
    const base = { sales, orderId: ORDER, customerId: CUSTOMER, alias: new Map() };
    // Ciblé sur la vente, en entier : plus rien d'impayé de connu.
    expect(
      unpaidOfOrder({
        ...base,
        outbox: [
          payment({
            customerId: CUSTOMER,
            amountXaf: 3000,
            allocations: [{ saleId: 'v1', amountXaf: 3000 }],
          }),
        ],
      }),
    ).toEqual([]);
    // En partie : le reste demeure.
    const partial = unpaidOfOrder({
      ...base,
      outbox: [
        payment({
          customerId: CUSTOMER,
          amountXaf: 1000,
          allocations: [{ saleId: 'v1', amountXaf: 1000 }],
        }),
      ],
    });
    expect(partial.map((due) => due.balanceXaf)).toEqual([2000]);
    // Affectation automatique : appliquée aux ventes de la commande.
    expect(
      unpaidOfOrder({
        ...base,
        outbox: [payment({ customerId: CUSTOMER, amountXaf: 3000 })],
      }),
    ).toEqual([]);
    // Encaissement d'un autre client, ou déjà envoyé et accepté : ne compte pas ici.
    expect(
      unpaidOfOrder({
        ...base,
        outbox: [
          payment({ customerId: 'autre', amountXaf: 3000 }),
          payment({ customerId: CUSTOMER, amountXaf: 3000 }, { status: 'SYNCED' }),
        ],
      }).map((due) => due.balanceXaf),
    ).toEqual([3000]);
  });

  it('compte absorbé : l’encaissement du compte conservé règle la vente du compte absorbé', () => {
    const sales = [sale({ id: 'v1', customer_id: 'absorbe', balance_due_xaf: 3000 })];
    const alias = new Map([['absorbe', CUSTOMER]]);
    expect(
      unpaidOfOrder({
        sales,
        outbox: [
          payment({
            customerId: CUSTOMER,
            amountXaf: 3000,
            allocations: [{ saleId: 'v1', amountXaf: 3000 }],
          }),
        ],
        orderId: ORDER,
        customerId: 'absorbe',
        alias,
      }),
    ).toEqual([]);
  });
});

describe('livraison à crédit, vue par l’appareil (AV-512)', () => {
  const creditSetting = (
    value: unknown,
    scope: { type: 'SITE' | 'GLOBAL'; id: string | null },
  ) => ({
    ...setting(value, scope),
    key: DELIVERY_ON_CREDIT_ALLOWED_SETTING,
  });

  it('livrer à crédit est permis par défaut : seule une valeur explicitement fausse l’interdit', () => {
    expect(deliveryOnCreditAllowed([], SITE, NOW)).toBe(true);
    expect(deliveryOnCreditAllowed([creditSetting(true, GLOBAL)], SITE, NOW)).toBe(true);
    expect(deliveryOnCreditAllowed([creditSetting('false', GLOBAL)], SITE, NOW)).toBe(true);
    expect(deliveryOnCreditAllowed([creditSetting(false, GLOBAL)], SITE, NOW)).toBe(false);
    expect(deliveryOnCreditAllowed([creditSetting(false, site(SITE))], SITE, NOW)).toBe(false);
    expect(deliveryOnCreditAllowed([creditSetting(false, site(SITE))], 'site-dla', NOW)).toBe(true);
    // Le réglage du paiement exigé est un autre réglage : il n'interdit pas le crédit à lui seul.
    expect(deliveryOnCreditAllowed([setting(false, GLOBAL)], SITE, NOW)).toBe(true);
  });

  const view = (overrides: Partial<Parameters<typeof deliveryPaymentView>[0]> = {}) =>
    deliveryPaymentView({
      required: true,
      onCreditAllowed: true,
      unpaidXaf: 3_000,
      customer: { credit_allowed: true, credit_limit_xaf: 50_000 },
      outstandingXaf: 12_000,
      ...overrides,
    });

  it('rien d’impayé de connu, ou exigence levée : rien à dire', () => {
    expect(view({ unpaidXaf: 0 })).toEqual({ kind: 'NONE' });
    expect(view({ required: false })).toEqual({ kind: 'NONE' });
  });

  it('client sans crédit, client inconnu, ou crédit interdit par le paramètre : il paie d’abord', () => {
    expect(view({ customer: { credit_allowed: false, credit_limit_xaf: null } })).toEqual({
      kind: 'PAY_FIRST',
      amountXaf: 3_000,
      noCredit: true,
    });
    expect(view({ customer: undefined })).toMatchObject({ kind: 'PAY_FIRST', noCredit: true });
    // Crédit interdit pour tous : le client autorisé paie d'abord, sans que ce soit faute de droit au crédit.
    expect(view({ onCreditAllowed: false })).toEqual({
      kind: 'PAY_FIRST',
      amountXaf: 3_000,
      noCredit: false,
    });
  });

  it('client autorisé : à crédit si son reste à encaisser tient dans son plafond, sinon le serveur peut refuser', () => {
    expect(view()).toEqual({ kind: 'ON_CREDIT', amountXaf: 3_000, limitXaf: 50_000 });
    // Pile le plafond : accordé (≤).
    expect(view({ outstandingXaf: 50_000 })).toMatchObject({ kind: 'ON_CREDIT' });
    expect(view({ outstandingXaf: 50_001 })).toEqual({
      kind: 'CREDIT_OVER',
      amountXaf: 3_000,
      limitXaf: 50_000,
      outstandingXaf: 50_001,
    });
    // Autorisé sans plafond défini : tout crédit dépasse (BR-VEN-025).
    expect(view({ customer: { credit_allowed: true, credit_limit_xaf: null } })).toEqual({
      kind: 'CREDIT_OVER',
      amountXaf: 3_000,
      limitXaf: null,
      outstandingXaf: 12_000,
    });
  });
});
