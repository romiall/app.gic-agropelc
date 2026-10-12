import { describe, expect, it } from 'vitest';
import type { OutboxCommand } from '../../storage/db.js';
import type { CashAccountData, CashSessionData } from '../sales/types.js';
import {
  cashOpenPlan,
  deviceCashSessions,
  indicativeSessionExpectedXaf,
  pendingCashMovements,
  type CashSessionView,
} from './cash-session.js';

const ACCOUNT = 'caisse-pdv';
const SITE = 'site-yde';
const USER = 'vendeur';
const PULLED = '2026-10-10T08:00:00.000Z';

let seq = 0;
function command(
  type: string,
  payload: object,
  overrides: Partial<OutboxCommand> = {},
): OutboxCommand {
  seq += 1;
  return {
    command_id: `cmd-${seq}`,
    device_seq: seq,
    command_type: type,
    command_version: 1,
    author_user_id: USER,
    aggregate_type: 'CASH_SESSION',
    aggregate_id: `agg-${seq}`,
    base_version: null,
    depends_on: [],
    occurred_at: '2026-10-10T09:00:00.000Z',
    client_created_at: '2026-10-10T09:00:00.000Z',
    captured_offline: true,
    backdated_reason: null,
    attachment_ids: [],
    payload,
    status: 'LOCAL_ONLY',
    attempts: 0,
    next_attempt_at: null,
    last_error: null,
    server_refs: null,
    ...overrides,
  };
}

function session(overrides: Partial<CashSessionData> = {}): CashSessionData {
  return {
    id: 'session-serveur',
    cash_account_id: ACCOUNT,
    site_id: SITE,
    business_date: '2026-10-10',
    status: 'OPEN',
    opened_by: USER,
    opened_at: '2026-10-10T06:00:00.000Z',
    opening_counted_xaf: 20_000,
    opening_expected_xaf: 20_000,
    opening_variance_xaf: 0,
    closed_by: null,
    closed_at: null,
    closing_counted_xaf: null,
    closing_expected_xaf: null,
    variance_xaf: null,
    current_expected_xaf: null,
    current_variance_xaf: null,
    force_closed: false,
    version: 1,
    ...overrides,
  };
}

const account: CashAccountData = {
  id: ACCOUNT,
  code: 'CAISSE-PDV',
  name: 'Caisse du PDV',
  account_type: 'CAISSE_PDV',
  site_id: SITE,
  holder_user_id: null,
  responsible_user_id: USER,
  balance_xaf: 35_000,
  status: 'ACTIVE',
  version: 4,
};

const locations = [
  { id: 'pdv', site_id: SITE, location_type: 'POS' },
  { id: 'magasin', site_id: SITE, location_type: 'STORE' },
  { id: 'pdv-autre', site_id: 'site-dla', location_type: 'POS' },
];
const paymentMethods = [
  { code: 'ESPECES', default_account_type: 'CAISSE_UTILISATEUR' },
  { code: 'OM', default_account_type: 'MOBILE_MONEY' },
];

const sale = (location: string, payments: object[], overrides: Partial<OutboxCommand> = {}) =>
  command('sales.sale.record', { fromLocationId: location, lines: [], payments }, overrides);

describe('Caisse vue par l’appareil (ECR-DIS-02)', () => {
  it('sessions : jeu `cash`, ouvertures et clôtures en attente, alias d’une ouverture fusionnée', () => {
    const otherAccount = command('finance.cash_session.open', {
      cashAccountId: 'autre-caisse',
      countedXaf: 1,
    });
    // Ouverture hors ligne fusionnée par le serveur dans la session servie : pas de double.
    const merged = command(
      'finance.cash_session.open',
      { cashAccountId: ACCOUNT, countedXaf: 5_000 },
      {
        status: 'SYNCED_WITH_WARNING',
        synced_at: '2026-10-10T09:30:00.000Z',
        server_refs: { cashSessionId: 'session-serveur' },
      },
    );
    // Clôture saisie sur l'agrégat de l'appareil : elle vise la session retenue.
    const close = command(
      'finance.cash_session.close',
      { countedXaf: 31_000 },
      { aggregate_id: merged.aggregate_id },
    );
    const views = deviceCashSessions({
      cashAccountId: ACCOUNT,
      // Session d'une autre caisse du site : ignorée.
      sessions: [session(), session({ id: 'autre-session', cash_account_id: 'autre-caisse' })],
      outbox: [otherAccount, merged, close],
      cashPulledAt: PULLED,
    });
    expect(views).toEqual([
      expect.objectContaining({
        id: 'session-serveur',
        known: true,
        state: 'CLOSING',
        closeCommandId: close.command_id,
        closingCountedXaf: 31_000,
      }),
    ]);

    // Ouverture de l'appareil encore sans réponse, puis acceptée avant le tirage.
    const open = command('finance.cash_session.open', { cashAccountId: ACCOUNT, countedXaf: 0 });
    const pending = deviceCashSessions({
      cashAccountId: ACCOUNT,
      sessions: [],
      outbox: [open],
      cashPulledAt: PULLED,
    });
    expect(pending).toEqual([
      expect.objectContaining({
        id: open.aggregate_id,
        known: false,
        state: 'OPEN',
        openCommandId: open.command_id,
        openingCountedXaf: 0,
      }),
    ]);
    const accepted = { ...open, status: 'SYNCED' as const, synced_at: '2026-10-10T09:10:00.000Z' };
    expect(
      deviceCashSessions({
        cashAccountId: ACCOUNT,
        sessions: [],
        outbox: [accepted],
        cashPulledAt: PULLED,
      })[0]?.openCommandId,
    ).toBeNull();
    // Ouverture refusée, ou déjà relue : rien.
    expect(
      deviceCashSessions({
        cashAccountId: ACCOUNT,
        sessions: [],
        outbox: [{ ...open, status: 'REJECTED' }],
        cashPulledAt: PULLED,
      }),
    ).toEqual([]);
    expect(
      deviceCashSessions({
        cashAccountId: ACCOUNT,
        sessions: [],
        outbox: [accepted],
        cashPulledAt: '2026-10-10T10:00:00.000Z',
      }),
    ).toEqual([]);
    // Session close à valider (servie) : close.
    expect(
      deviceCashSessions({
        cashAccountId: ACCOUNT,
        sessions: [session({ status: 'PENDING_VALIDATION', closed_at: '2026-10-10T18:00:00Z' })],
        outbox: [],
        cashPulledAt: PULLED,
      })[0]?.state,
    ).toBe('CLOSED');
  });

  it('mouvements en attente : espèces au PDV en entrée, remises en sortie, à partir de l’ouverture', () => {
    const outbox = [
      // Vente au PDV : seules les espèces entrent dans la caisse.
      sale('pdv', [
        { methodCode: 'ESPECES', amountXaf: 3_000 },
        { methodCode: 'OM', amountXaf: 2_000 },
      ]),
      // Vente au magasin ou dans un autre PDV : pas cette caisse.
      sale('magasin', [{ methodCode: 'ESPECES', amountXaf: 9_000 }]),
      sale('pdv-autre', [{ methodCode: 'ESPECES', amountXaf: 9_000 }]),
      // Acompte en espèces d'une commande servie au PDV, encaissement hors vente sur le site.
      command('sales.order.place', {
        fulfilmentLocationId: 'pdv',
        advancePayments: [{ methodCode: 'ESPECES', amountXaf: 1_500 }],
      }),
      command('sales.payment.record', { siteId: SITE, methodCode: 'ESPECES', amountXaf: 500 }),
      command('sales.payment.record', { siteId: 'site-dla', methodCode: 'ESPECES', amountXaf: 7 }),
      // Remise envoyée depuis la caisse.
      command('finance.cash_transfer.send', { fromAccountId: ACCOUNT, amountXaf: 4_000 }),
      command('finance.cash_transfer.send', { fromAccountId: 'autre', amountXaf: 8 }),
      // Refusée, ou acceptée et déjà relue : hors du calcul.
      sale('pdv', [{ methodCode: 'ESPECES', amountXaf: 100 }], { status: 'REJECTED' }),
      sale('pdv', [{ methodCode: 'ESPECES', amountXaf: 200 }], {
        status: 'SYNCED',
        synced_at: '2026-10-10T07:00:00.000Z',
      }),
      // Avant l'ouverture de la session.
      sale('pdv', [{ methodCode: 'ESPECES', amountXaf: 50 }], {
        occurred_at: '2026-10-10T05:00:00.000Z',
      }),
    ];
    const input = { account, outbox, cashPulledAt: PULLED, locations, paymentMethods };
    expect(pendingCashMovements(input)).toEqual({ netXaf: 1_050, count: 5 });
    expect(pendingCashMovements({ ...input, from: '2026-10-10T06:00:00.000Z' })).toEqual({
      netXaf: 1_000,
      count: 4,
    });
  });

  it('attendu indicatif : solde servi si la session est connue, sinon fonds compté, plus l’attente', () => {
    const outbox = [sale('pdv', [{ methodCode: 'ESPECES', amountXaf: 3_000 }])];
    const base = { account, outbox, cashPulledAt: PULLED, locations, paymentMethods };
    const known: CashSessionView = {
      id: 's',
      cashAccountId: ACCOUNT,
      openedAt: '2026-10-10T06:00:00.000Z',
      openedBy: USER,
      openingCountedXaf: 20_000,
      state: 'OPEN',
      known: true,
      openCommandId: null,
      closeCommandId: null,
      closedAt: null,
      closingCountedXaf: null,
    };
    expect(indicativeSessionExpectedXaf({ ...base, session: known })).toEqual({
      expectedXaf: 38_000,
      pendingCount: 1,
    });
    expect(indicativeSessionExpectedXaf({ ...base, session: { ...known, known: false } })).toEqual({
      expectedXaf: 23_000,
      pendingCount: 1,
    });
    const withoutBalance: CashAccountData = { ...account };
    delete (withoutBalance as { balance_xaf?: number }).balance_xaf;
    expect(
      indicativeSessionExpectedXaf({ ...base, account: withoutBalance, session: known }),
    ).toBeNull();
  });

  it('ouverture : règle partagée avec le serveur, refus en ligne, fusion hors ligne', () => {
    const at = new Date('2026-10-10T09:00:00.000Z');
    const open = deviceCashSessions({
      cashAccountId: ACCOUNT,
      sessions: [session()],
      outbox: [],
      cashPulledAt: PULLED,
    });
    expect(
      cashOpenPlan({ sessions: open, openedAt: at, online: true, maxSessionsPerDay: 1 }),
    ).toMatchObject({ kind: 'REJECT', code: 'CASH_SESSION_ALREADY_OPEN' });
    expect(
      cashOpenPlan({ sessions: open, openedAt: at, online: false, maxSessionsPerDay: 1 }),
    ).toMatchObject({ kind: 'MERGE', reason: 'OPEN_SESSION_EXISTS' });
    // Session du jour close : la limite du jour (paramètre, 1 à défaut) décide.
    const closed = deviceCashSessions({
      cashAccountId: ACCOUNT,
      sessions: [session({ status: 'PENDING_VALIDATION', closed_at: '2026-10-10T08:00:00.000Z' })],
      outbox: [],
      cashPulledAt: PULLED,
    });
    expect(
      cashOpenPlan({ sessions: closed, openedAt: at, online: true, maxSessionsPerDay: undefined }),
    ).toMatchObject({ kind: 'REJECT', code: 'CASH_SESSION_DAILY_LIMIT' });
    expect(
      cashOpenPlan({ sessions: closed, openedAt: at, online: true, maxSessionsPerDay: 2 }),
    ).toMatchObject({ kind: 'CREATE' });
    expect(
      cashOpenPlan({ sessions: [], openedAt: at, online: true, maxSessionsPerDay: 1 }),
    ).toMatchObject({ kind: 'CREATE' });
  });
});
