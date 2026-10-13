import { describe, expect, it } from 'vitest';
import type { OutboxCommand } from '../../storage/db.js';
import type { CashAccountData, CashSessionData } from '../sales/types.js';
import {
  cashOpenPlan,
  cashPaymentBlocked,
  cashSessionCoverage,
  deviceCash,
  foreignClose,
  indicativeBalanceXaf,
  indicativeSessionExpectedXaf,
  openSession,
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

const cashOf = (outbox: OutboxCommand[], sessions: CashSessionData[] = [], extra = {}) =>
  deviceCash({
    cashAccountId: ACCOUNT,
    sessions,
    outbox,
    cashPulledAt: PULLED,
    userId: USER,
    ...extra,
  });

const openCmd = (overrides: Partial<OutboxCommand> = {}, counted = 0) =>
  command('finance.cash_session.open', { cashAccountId: ACCOUNT, countedXaf: counted }, overrides);

const closeCmd = (aggregate: string, counted: number, overrides: Partial<OutboxCommand> = {}) =>
  command(
    'finance.cash_session.close',
    { countedXaf: counted },
    { aggregate_id: aggregate, ...overrides },
  );

describe('Caisse vue par l’appareil (ECR-DIS-02)', () => {
  it('sessions : jeu `cash`, saisies en attente, heure retenue par le serveur, alias même après le tirage', () => {
    const otherAccount = command('finance.cash_session.open', {
      cashAccountId: 'autre-caisse',
      countedXaf: 1,
    });
    // Ouverture hors ligne fusionnée par le serveur dans la session servie : pas de double.
    const merged = openCmd(
      {
        status: 'SYNCED_WITH_WARNING',
        synced_at: '2026-10-10T09:30:00.000Z',
        server_refs: { cashSessionId: 'session-serveur', mergedInto: 'session-serveur' },
      },
      5_000,
    );
    // Clôture saisie sur l'agrégat de l'appareil : elle vise la session retenue.
    const close = closeCmd(merged.aggregate_id, 31_000);
    const cash = cashOf(
      [otherAccount, merged, close],
      // Session d'une autre caisse du site : ignorée.
      [session(), session({ id: 'autre-session', cash_account_id: 'autre-caisse' })],
    );
    expect(cash.sessions).toEqual([
      expect.objectContaining({
        id: 'session-serveur',
        known: true,
        state: 'CLOSING',
        closeCommandId: close.command_id,
        closeOnDevice: true,
        closingCountedXaf: 31_000,
      }),
    ]);
    // Ouverture fusionnée déjà tirée : la clôture en attente vise encore la session retenue.
    const pulledMerge = { ...merged, synced_at: '2026-10-10T07:30:00.000Z' };
    expect(cashOf([pulledMerge, close], [session()]).sessions[0]?.state).toBe('CLOSING');

    // Ouverture de l'appareil encore sans réponse, puis acceptée avant le tirage (heure décalée par le
    // serveur, AV-168).
    const open = openCmd();
    expect(cashOf([open]).sessions).toEqual([
      expect.objectContaining({
        id: open.aggregate_id,
        known: false,
        state: 'OPEN',
        openCommandId: open.command_id,
        openedAt: open.occurred_at,
      }),
    ]);
    const accepted = {
      ...open,
      status: 'SYNCED' as const,
      synced_at: '2026-10-10T09:10:00.000Z',
      server_refs: { cashSessionId: open.aggregate_id, openedAt: '2026-10-10T09:05:00.000Z' },
    };
    expect(cashOf([accepted]).sessions[0]).toMatchObject({
      openCommandId: null,
      openedAt: '2026-10-10T09:05:00.000Z',
    });
    // Ouverture refusée, ou déjà relue : rien.
    expect(cashOf([{ ...open, status: 'REJECTED' }]).sessions).toEqual([]);
    expect(
      deviceCash({
        cashAccountId: ACCOUNT,
        sessions: [],
        outbox: [accepted],
        cashPulledAt: '2026-10-10T10:00:00.000Z',
        userId: USER,
      }).sessions,
    ).toEqual([]);
    // Session servie à valider ; clôture acceptée validée d'office : statut gardé.
    expect(
      cashOf([], [session({ status: 'PENDING_VALIDATION', closed_at: '2026-10-10T18:00:00Z' })])
        .sessions[0],
    ).toMatchObject({ state: 'CLOSED', closedStatus: 'PENDING_VALIDATION' });
    const validated = closeCmd('session-serveur', 20_000, {
      status: 'SYNCED',
      synced_at: '2026-10-10T09:30:00.000Z',
      server_refs: { cashSessionId: 'session-serveur', status: 'VALIDATED' },
    });
    expect(cashOf([validated], [session()]).sessions[0]).toMatchObject({
      state: 'CLOSED',
      closedStatus: 'VALIDATED',
    });
  });

  it('ouvertures rattachées : fusion du serveur ou prévue hors ligne (limite du jour) n’ouvrent aucune caisse', () => {
    // Fusionnée par le serveur dans une session absente du jeu (validée) : aucune caisse ouverte.
    const merged = openCmd({
      status: 'SYNCED_WITH_WARNING',
      synced_at: '2026-10-10T09:30:00.000Z',
      server_refs: { cashSessionId: 'session-validee', mergedInto: 'session-validee' },
    });
    const cash = cashOf([merged]);
    expect(openSession(cash)).toBeUndefined();
    expect(cash.attached).toEqual([
      { commandId: merged.command_id, openedAt: merged.occurred_at, reason: 'MERGED' },
    ]);
    // Hors ligne, la session du jour déjà close et la limite à 1 : le serveur la rattachera.
    const closedToday = session({
      status: 'PENDING_VALIDATION',
      closed_at: '2026-10-10T08:00:00.000Z',
    });
    const pending = openCmd();
    const willMerge = cashOf([pending], [closedToday], { maxSessionsPerDay: 1 });
    expect(openSession(willMerge)).toBeUndefined();
    expect(willMerge.attached[0]).toMatchObject({ reason: 'WILL_MERGE' });
    // Deux sessions permises : l'ouverture crée bien une caisse.
    expect(openSession(cashOf([pending], [closedToday], { maxSessionsPerDay: 2 }))?.id).toBe(
      pending.aggregate_id,
    );
    // Une clôture saisie sur l'agrégat d'une ouverture rattachée n'est qu'un constat.
    const close = closeCmd(pending.aggregate_id, 1);
    expect(
      cashOf([pending, close], [closedToday], { maxSessionsPerDay: 1 }).sessions.map(
        (view) => view.state,
      ),
    ).toEqual(['CLOSED']);
  });

  it('tablette partagée : ouverture d’un autre utilisateur hors des sessions, clôture d’un autre utilisateur', () => {
    const other = openCmd({ author_user_id: 'autre-vendeur' });
    const cash = cashOf([other]);
    expect(cash.sessions).toEqual([]);
    expect(cash.foreignOpenings.map((view) => view.id)).toEqual([other.aggregate_id]);
    // Envoyée par son auteur : connue du serveur, elle redevient la caisse ouverte.
    const sent = { ...other, status: 'SYNCED' as const, synced_at: '2026-10-10T09:10:00.000Z' };
    expect(openSession(cashOf([sent]))?.id).toBe(other.aggregate_id);
    // Clôture d'un autre utilisateur pas encore envoyée : la session reste ouverte au serveur.
    const close = closeCmd('session-serveur', 1, { author_user_id: 'autre-vendeur' });
    const closing = cashOf([close], [session()]);
    expect(openSession(closing)).toBeUndefined();
    expect(foreignClose(closing, USER)?.id).toBe('session-serveur');
    expect(
      foreignClose(cashOf([{ ...close, author_user_id: USER }], [session()]), USER),
    ).toBeUndefined();
  });

  it('sessions ouvertes par l’appareil puis validées (sorties du jeu) : comptées dans la limite du jour', () => {
    const open = openCmd({
      status: 'SYNCED',
      synced_at: '2026-10-10T07:00:00.000Z',
      server_refs: { cashSessionId: 'agg-session', openedAt: '2026-10-10T06:00:00.000Z' },
      aggregate_id: 'agg-session',
      occurred_at: '2026-10-10T06:00:00.000Z',
    });
    const close = closeCmd('agg-session', 20_000, {
      status: 'SYNCED',
      synced_at: '2026-10-10T07:30:00.000Z',
      occurred_at: '2026-10-10T07:20:00.000Z',
      server_refs: { cashSessionId: 'agg-session', status: 'VALIDATED' },
    });
    const cash = cashOf([open, close]);
    expect(cash.sessions).toEqual([]);
    expect(cash.leftDataset).toEqual([
      {
        id: 'agg-session',
        openedAt: new Date('2026-10-10T06:00:00.000Z'),
        closedAt: new Date('2026-10-10T07:20:00.000Z'),
        status: 'VALIDATED',
      },
    ]);
    const at = new Date('2026-10-10T09:00:00.000Z');
    expect(
      cashOpenPlan({ cash, userId: USER, openedAt: at, online: true, maxSessionsPerDay: 1 }),
    ).toMatchObject({ kind: 'REJECT', code: 'CASH_SESSION_DAILY_LIMIT' });
    expect(
      cashOpenPlan({ cash, userId: USER, openedAt: at, online: false, maxSessionsPerDay: 1 }),
    ).toMatchObject({ kind: 'MERGE', reason: 'DAILY_LIMIT_REACHED' });
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

  it('remises connues : annulation en entrée sur la source, réception en entrée sur la destination', () => {
    const served = [
      {
        id: 'r-servie',
        from_account_id: ACCOUNT,
        to_account_id: 'centrale',
        amount_sent_xaf: 5_000,
      },
      {
        id: 'r-entrante',
        from_account_id: 'centrale',
        to_account_id: ACCOUNT,
        amount_sent_xaf: 9_000,
      },
      { id: 'r-ailleurs', from_account_id: 'autre', to_account_id: 'centrale', amount_sent_xaf: 7 },
    ];
    const outbox = [
      // Remise servie (déjà dans le solde) annulée : le montant revient à la source.
      command('finance.cash_transfer.cancel', { reason: 'Erreur' }, { aggregate_id: 'r-servie' }),
      // Envoi de l'appareil annulé avant d'être relu : la sortie et le retour s'annulent.
      command(
        'finance.cash_transfer.send',
        { fromAccountId: ACCOUNT, toAccountId: 'centrale', amountXaf: 4_000 },
        { aggregate_id: 'r-locale' },
      ),
      command('finance.cash_transfer.cancel', { reason: 'Erreur' }, { aggregate_id: 'r-locale' }),
      // Remise reçue sur cette caisse : le montant compté entre.
      command(
        'finance.cash_transfer.receive',
        { receivedXaf: 8_500 },
        { aggregate_id: 'r-entrante' },
      ),
      // Envoi refusé puis annulé : ni la sortie ni le retour ne comptent.
      command(
        'finance.cash_transfer.send',
        { fromAccountId: ACCOUNT, toAccountId: 'centrale', amountXaf: 600 },
        { aggregate_id: 'r-refusee', status: 'REJECTED' },
      ),
      command('finance.cash_transfer.cancel', { reason: 'x' }, { aggregate_id: 'r-refusee' }),
      // Autres caisses, remise inconnue : sans effet.
      command('finance.cash_transfer.cancel', { reason: 'x' }, { aggregate_id: 'r-ailleurs' }),
      command('finance.cash_transfer.receive', { receivedXaf: 7 }, { aggregate_id: 'r-ailleurs' }),
      command('finance.cash_transfer.cancel', { reason: 'x' }, { aggregate_id: 'inconnue' }),
    ];
    const input = { account, outbox, cashPulledAt: PULLED, locations, paymentMethods };
    expect(pendingCashMovements({ ...input, transfers: served })).toEqual({
      netXaf: 13_500,
      count: 4,
    });
    // Sans les remises servies : l'envoi seul (comportement des écrans qui ne les passent pas).
    expect(pendingCashMovements(input)).toEqual({ netXaf: -4_000, count: 1 });
  });

  it('caisse personnelle : espèces de son détenteur encaissées hors point de vente', () => {
    const personal: CashAccountData = {
      ...account,
      id: 'perso',
      account_type: 'CAISSE_UTILISATEUR',
      site_id: null,
      holder_user_id: USER,
    };
    const outbox = [
      // Stock mobile ou magasin (hors POS) : la caisse personnelle de l'auteur.
      sale('mobile', [{ methodCode: 'ESPECES', amountXaf: 30_000 }]),
      sale('magasin', [{ methodCode: 'ESPECES', amountXaf: 2_000 }]),
      // Au PDV : la caisse du PDV, pas celle-ci ; mobile money : pas une caisse.
      sale('pdv', [{ methodCode: 'ESPECES', amountXaf: 9_000 }]),
      sale('mobile', [{ methodCode: 'OM', amountXaf: 9_000 }]),
      // Autre auteur (tablette partagée) : sa propre caisse.
      sale('mobile', [{ methodCode: 'ESPECES', amountXaf: 9_000 }], { author_user_id: 'autre' }),
      // Encaissement désignant un autre compte : pas celui-ci.
      sale('mobile', [{ methodCode: 'ESPECES', amountXaf: 9_000, cashAccountId: 'autre-compte' }]),
      command('sales.order.place', {
        fulfilmentLocationId: 'mobile',
        advancePayments: [{ methodCode: 'ESPECES', amountXaf: 500 }],
      }),
      // Hors vente : site absent ou non point de vente, oui ; site d'un PDV, non.
      command('sales.payment.record', { methodCode: 'ESPECES', amountXaf: 100 }),
      command('sales.payment.record', { siteId: 'ferme', methodCode: 'ESPECES', amountXaf: 10 }),
      command('sales.payment.record', { siteId: SITE, methodCode: 'ESPECES', amountXaf: 7 }),
    ];
    const siteTypes = new Map([
      [SITE, 'POINT_DE_VENTE'],
      ['ferme', 'FERME'],
    ]);
    expect(
      pendingCashMovements({
        account: personal,
        outbox,
        cashPulledAt: PULLED,
        locations,
        paymentMethods,
        siteTypes,
      }),
    ).toEqual({ netXaf: 32_610, count: 5 });
    // La caisse du PDV garde sa règle : la vente au PDV et l'encaissement sur son site.
    expect(
      pendingCashMovements({
        account,
        outbox,
        cashPulledAt: PULLED,
        locations,
        paymentMethods,
        siteTypes,
      }),
    ).toEqual({ netXaf: 9_007, count: 2 });
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
      closeOnDevice: false,
      closeAuthorId: null,
      closedAt: null,
      closingCountedXaf: null,
      closedStatus: null,
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

  it('solde indicatif avant une ouverture : le compté d’une clôture encore en vol, puis l’attente qui suit', () => {
    // Session servie ouverte, solde servi 35 000 ; clôture hors ligne à 18:00 en comptant 30 000 : le
    // registre vaudra 30 000 (écart posé), l'écart de la veille n'est pas montré une seconde fois.
    const close = closeCmd('session-serveur', 30_000, { occurred_at: '2026-10-10T18:00:00.000Z' });
    const before = sale('pdv', [{ methodCode: 'ESPECES', amountXaf: 1_000 }], {
      occurred_at: '2026-10-10T17:00:00.000Z',
    });
    const after = sale('pdv', [{ methodCode: 'ESPECES', amountXaf: 500 }], {
      occurred_at: '2026-10-10T19:00:00.000Z',
    });
    const outbox = [before, close, after];
    const last = cashOf(outbox, [session()]).sessions.at(-1);
    const input = { account, outbox, cashPulledAt: PULLED, locations, paymentMethods, last };
    expect(indicativeBalanceXaf(input)).toEqual({ expectedXaf: 30_500, pendingCount: 1 });
    // Clôture déjà relue (session servie à valider) : solde servi, attente datée après la clôture.
    const served = session({
      status: 'PENDING_VALIDATION',
      closed_at: '2026-10-10T18:00:00.000Z',
      closing_counted_xaf: 30_000,
    });
    expect(
      indicativeBalanceXaf({
        ...input,
        outbox: [before, after],
        last: cashOf([], [served]).sessions.at(-1),
      }),
    ).toEqual({ expectedXaf: 35_500, pendingCount: 1 });
    // Aucune session : solde servi et toute l'attente.
    expect(indicativeBalanceXaf({ ...input, outbox: [before, after], last: undefined })).toEqual({
      expectedXaf: 36_500,
      pendingCount: 2,
    });
  });

  it('encaissement en espèces au PDV : caisse ouverte exigée, bloqué en ligne seulement (BR-DIS-005, AV-233)', () => {
    const coverage = (overrides: Partial<Parameters<typeof cashSessionCoverage>[0]> = {}) =>
      cashSessionCoverage({
        atPointOfSale: true,
        accounts: [account],
        sessions: [],
        outbox: [],
        cashPulledAt: PULLED,
        siteId: SITE,
        userId: USER,
        ...overrides,
      });
    // Pas au point de vente : rien à exiger.
    expect(coverage({ atPointOfSale: false })).toBe('NONE');
    expect(coverage({ siteId: null })).toBe('NONE');
    // Au point de vente, caisse non servie à l'appareil (rôle sans lecture de la caisse) : inconnue.
    expect(coverage({ siteId: 'site-dla' })).toBe('UNKNOWN');
    expect(coverage({ accounts: [{ ...account, status: 'INACTIVE' }] })).toBe('UNKNOWN');
    expect(coverage()).toBe('MISSING');
    expect(coverage({ sessions: [session()] })).toBe('COVERED');
    expect(
      coverage({
        sessions: [session({ status: 'PENDING_VALIDATION', closed_at: '2026-10-10T08:00:00Z' })],
      }),
    ).toBe('MISSING');
    // Ouverture de l'utilisateur encore sur l'appareil : elle part avant l'encaissement.
    const ownOpen = openCmd();
    expect(coverage({ outbox: [ownOpen] })).toBe('COVERED');
    // Ouverture d'un autre utilisateur pas encore envoyée : inconnue du serveur.
    expect(coverage({ outbox: [{ ...ownOpen, author_user_id: 'autre-vendeur' }] })).toBe('MISSING');
    // Clôture d'un autre utilisateur pas encore envoyée : la session reste ouverte au serveur.
    expect(
      coverage({
        sessions: [session()],
        outbox: [closeCmd('session-serveur', 1, { author_user_id: 'autre-vendeur' })],
      }),
    ).toBe('COVERED');
    // Clôture de l'utilisateur : partie avant l'encaissement, plus de caisse ouverte.
    expect(coverage({ sessions: [session()], outbox: [closeCmd('session-serveur', 1)] })).toBe(
      'MISSING',
    );

    expect(cashPaymentBlocked('MISSING', true)).toBe(true);
    expect(cashPaymentBlocked('MISSING', false)).toBe(false);
    expect(cashPaymentBlocked('UNKNOWN', true)).toBe(false);
    expect(cashPaymentBlocked('NONE', true)).toBe(false);
    expect(cashPaymentBlocked('COVERED', true)).toBe(false);
  });

  it('ouverture : règle partagée avec le serveur, refus en ligne, fusion hors ligne', () => {
    const at = new Date('2026-10-10T09:00:00.000Z');
    const plan = (cash: ReturnType<typeof cashOf>, online: boolean, max: unknown) =>
      cashOpenPlan({ cash, userId: USER, openedAt: at, online, maxSessionsPerDay: max });
    const open = cashOf([], [session()]);
    expect(plan(open, true, 1)).toMatchObject({
      kind: 'REJECT',
      code: 'CASH_SESSION_ALREADY_OPEN',
    });
    expect(plan(open, false, 1)).toMatchObject({ kind: 'MERGE', reason: 'OPEN_SESSION_EXISTS' });
    // Session du jour close : la limite du jour (paramètre, 1 à défaut) décide.
    const closed = cashOf(
      [],
      [session({ status: 'PENDING_VALIDATION', closed_at: '2026-10-10T08:00:00.000Z' })],
    );
    expect(plan(closed, true, undefined)).toMatchObject({
      kind: 'REJECT',
      code: 'CASH_SESSION_DAILY_LIMIT',
    });
    expect(plan(closed, true, 2)).toMatchObject({ kind: 'CREATE' });
    expect(plan(cashOf([]), true, 1)).toMatchObject({ kind: 'CREATE' });
    // Clôture d'un autre utilisateur pas encore envoyée : ouverte au serveur, refus en ligne.
    const foreignClosing = cashOf(
      [closeCmd('session-serveur', 1, { author_user_id: 'autre-vendeur' })],
      [session({ opened_at: '2026-10-09T06:00:00.000Z' })],
    );
    expect(plan(foreignClosing, true, 2)).toMatchObject({
      kind: 'REJECT',
      code: 'CASH_SESSION_ALREADY_OPEN',
    });
  });
});
