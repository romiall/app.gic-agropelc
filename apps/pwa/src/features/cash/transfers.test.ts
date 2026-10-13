import { describe, expect, it } from 'vitest';
import type { OutboxCommand } from '../../storage/db.js';
import type {
  CashAccountData,
  CashTransferData,
  CashTransferTargetData,
  SettingData,
} from '../sales/types.js';
import {
  cancelPayload,
  canCancel,
  deviceTransfers,
  mySentTransfers,
  overIndicativeBalance,
  ownAccounts,
  receivePayload,
  sendPayload,
  sourceAccounts,
  targetsFor,
  toReceive,
  transferPairs,
} from './transfers.js';

const ME = 'moi';
const OTHER = 'autre';
const PULLED = '2026-10-10T08:00:00.000Z';

let seq = 0;
function command(
  type: string,
  aggregateId: string,
  payload: object,
  overrides: Partial<OutboxCommand> = {},
) {
  seq += 1;
  return {
    command_id: `cmd-${seq}`,
    device_seq: seq,
    command_type: type,
    command_version: 1,
    author_user_id: ME,
    aggregate_type: 'CASH_TRANSFER',
    aggregate_id: aggregateId,
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
  } as OutboxCommand;
}

function transfer(overrides: Partial<CashTransferData> = {}): CashTransferData {
  return {
    id: 'r1',
    doc_number: 'RMF-YDE-2026-000001',
    local_ref: null,
    from_account_id: 'pdv',
    to_account_id: 'centrale',
    amount_sent_xaf: 150_000,
    amount_received_xaf: null,
    status: 'SENT',
    sent_by: ME,
    sent_at: '2026-10-10T07:00:00.000Z',
    carrier_user_id: null,
    carrier_name: 'Paul',
    received_at: null,
    version: 1,
    ...overrides,
  };
}

function account(overrides: Partial<CashAccountData> = {}): CashAccountData {
  return {
    id: 'pdv',
    code: 'CAISSE-PDV',
    name: 'Caisse du PDV',
    account_type: 'CAISSE_PDV',
    site_id: 'site',
    holder_user_id: null,
    responsible_user_id: OTHER,
    balance_xaf: 20_000,
    status: 'ACTIVE',
    version: 1,
    ...overrides,
  };
}

const targets: CashTransferTargetData[] = [
  {
    id: 'centrale',
    code: 'CC',
    name: 'Caisse centrale',
    account_type: 'CAISSE_CENTRALE',
    site_id: null,
  },
  { id: 'banque', code: 'BQ', name: 'Banque', account_type: 'BANQUE', site_id: null },
  { id: 'momo', code: 'MM', name: 'Mobile money', account_type: 'MOBILE_MONEY', site_id: null },
  {
    id: 'pdv',
    code: 'CAISSE-PDV',
    name: 'Caisse du PDV',
    account_type: 'CAISSE_PDV',
    site_id: 'site',
  },
];

describe('Remises de fonds vues par l’appareil (UC-FIN-07)', () => {
  it('remises servies et envois de l’appareil pas encore relus ; annulations et réceptions en cours', () => {
    const outbox = [
      command('finance.cash_transfer.send', 'r-locale', {
        fromAccountId: 'pdv',
        toAccountId: 'centrale',
        amountXaf: 4_000,
        carrierName: 'Awa',
      }),
      // Acceptée, pas encore relue : toujours montrée, en attente du numéro.
      command(
        'finance.cash_transfer.send',
        'r-acceptee',
        { fromAccountId: 'pdv', toAccountId: 'banque', amountXaf: 1_000 },
        { status: 'SYNCED', synced_at: '2026-10-10T09:30:00.000Z' },
      ),
      // Relue (le tirage l'inclut) ou refusée : absente.
      command(
        'finance.cash_transfer.send',
        'r-relue',
        { fromAccountId: 'pdv', toAccountId: 'banque', amountXaf: 1 },
        { status: 'SYNCED', synced_at: '2026-10-10T07:30:00.000Z' },
      ),
      command(
        'finance.cash_transfer.send',
        'r-refusee',
        { fromAccountId: 'pdv', toAccountId: 'banque', amountXaf: 2 },
        { status: 'REJECTED' },
      ),
      command('finance.cash_transfer.cancel', 'r1', { reason: 'Erreur' }),
      command(
        'finance.cash_transfer.receive',
        'r2',
        { receivedXaf: 9_000 },
        { status: 'SYNCED', synced_at: '2026-10-10T09:00:00.000Z' },
      ),
    ];
    const views = deviceTransfers({
      transfers: [
        transfer(),
        transfer({ id: 'r2', sent_by: OTHER, from_account_id: 'centrale', to_account_id: 'pdv' }),
      ],
      outbox,
      cashPulledAt: PULLED,
    });
    // Du plus récent au plus ancien (même heure : par identifiant).
    expect(views.map((view) => [view.id, view.status, view.cancelling, view.receiving])).toEqual([
      ['r-acceptee', null, null, null],
      ['r-locale', null, null, null],
      ['r1', 'SENT', 'WAITING', null],
      ['r2', 'SENT', null, 'SENT'],
    ]);
    const local = views[1]!;
    expect(local).toMatchObject({
      docNumber: null,
      amountSentXaf: 4_000,
      carrierName: 'Awa',
      sentBy: ME,
      sendWaiting: true,
      sendCommandId: outbox[0]!.command_id,
    });
    expect(views[0]).toMatchObject({ sendWaiting: false, docNumber: null });
    // Les miennes : servies ou saisies ; annulables seulement sans autre opération en cours.
    expect(mySentTransfers(views, ME).map((view) => view.id)).toEqual([
      'r-acceptee',
      'r-locale',
      'r1',
    ]);
    expect(canCancel(local, ME)).toBe(true);
    expect(canCancel(views[2]!, ME)).toBe(false);
    expect(canCancel(local, OTHER)).toBe(false);
    expect(canCancel({ ...views[2]!, cancelling: null, status: 'DISCREPANCY_PENDING' }, ME)).toBe(
      false,
    );
  });

  it('remises à recevoir : en transit vers l’une de mes caisses, envoyées par un autre', () => {
    const accounts = [
      account(),
      account({ id: 'perso', account_type: 'CAISSE_UTILISATEUR', holder_user_id: ME }),
      account({ id: 'perso-autre', account_type: 'CAISSE_UTILISATEUR', holder_user_id: OTHER }),
      account({ id: 'inactive', status: 'INACTIVE' }),
    ];
    const views = deviceTransfers({
      transfers: [
        transfer({ id: 'a', sent_by: OTHER, to_account_id: 'pdv' }),
        transfer({ id: 'b', sent_by: OTHER, to_account_id: 'perso' }),
        // Envoyée par moi : jamais reçue par moi (`CASH_TRANSFER_SELF_RECEIVE`).
        transfer({ id: 'c', sent_by: ME, to_account_id: 'pdv' }),
        // Caisse personnelle d'un autre, caisse inactive, compte non servi.
        transfer({ id: 'd', sent_by: OTHER, to_account_id: 'perso-autre' }),
        transfer({ id: 'e', sent_by: OTHER, to_account_id: 'inactive' }),
        transfer({ id: 'f', sent_by: OTHER, to_account_id: 'centrale' }),
        // Déjà en écart : plus à recevoir.
        transfer({ id: 'g', sent_by: OTHER, to_account_id: 'pdv', status: 'DISCREPANCY_PENDING' }),
      ],
      outbox: [command('finance.cash_transfer.receive', 'b', { receivedXaf: 1 })],
      cashPulledAt: PULLED,
    });
    expect(toReceive(views, accounts, ME).map((view) => view.id)).toEqual(['a']);
  });

  it('caisses et destinations : paires admises, paramètre du site, jamais la caisse d’un autre', () => {
    const accounts = [
      account(),
      account({
        id: 'perso',
        name: 'Ma caisse',
        account_type: 'CAISSE_UTILISATEUR',
        holder_user_id: ME,
      }),
      account({ id: 'perso-autre', account_type: 'CAISSE_UTILISATEUR', holder_user_id: OTHER }),
      account({ id: 'momo-compte', name: 'Momo', account_type: 'MOBILE_MONEY' }),
      account({ id: 'fermee', status: 'INACTIVE' }),
    ];
    expect(ownAccounts(accounts, ME).map((item) => item.id)).toEqual([
      'pdv',
      'perso',
      'momo-compte',
    ]);
    const pairs = transferPairs([], new Date('2026-10-10T09:00:00.000Z'));
    // Défaut d'AV-158 : le PDV remet à la caisse centrale ou à la banque, jamais à lui-même.
    expect(targetsFor(account(), targets, pairs).map((item) => item.id)).toEqual([
      'banque',
      'centrale',
    ]);
    expect(sourceAccounts(accounts, targets, pairs, ME).map((item) => item.id)).toEqual([
      'pdv',
      'perso',
      'momo-compte',
    ]);
    // Paramètre publié : le PDV ne remet plus qu'à la banque ; la caisse personnelle à rien.
    const setting: SettingData = {
      id: 's',
      key: 'finance.cash_transfer_allowed_pairs',
      value: { CAISSE_PDV: ['BANQUE'] },
      scope_type: 'GLOBAL',
      scope_id: null,
      valid_from: '2026-01-01T00:00:00.000Z',
    } as SettingData;
    const narrowed = transferPairs([setting], new Date('2026-10-10T09:00:00.000Z'));
    expect(targetsFor(account(), targets, narrowed).map((item) => item.id)).toEqual(['banque']);
    // Une paire d'un type vers lui-même n'admet jamais la caisse source elle-même.
    const sameType = transferPairs(
      [{ ...setting, value: { CAISSE_PDV: ['CAISSE_PDV', 'BANQUE'] } }],
      new Date('2026-10-10T09:00:00.000Z'),
    );
    expect(targetsFor(account(), targets, sameType).map((item) => item.id)).toEqual(['banque']);
    expect(sourceAccounts(accounts, targets, narrowed, ME).map((item) => item.id)).toEqual(['pdv']);
  });

  it('solde indicatif dépassé signalé pour une caisse physique ; charges utiles', () => {
    expect(overIndicativeBalance(account(), 20_000, 20_001)).toBe(true);
    expect(overIndicativeBalance(account(), 20_000, 20_000)).toBe(false);
    expect(overIndicativeBalance(account({ account_type: 'BANQUE' }), 20_000, 50_000)).toBe(false);
    expect(overIndicativeBalance(account(), null, 50_000)).toBe(false);
    expect(
      sendPayload({
        fromAccountId: 'pdv',
        toAccountId: 'centrale',
        amountXaf: 173_000,
        carrierName: '  Paul ',
        comment: ' ',
      }),
    ).toEqual({
      fromAccountId: 'pdv',
      toAccountId: 'centrale',
      amountXaf: 173_000,
      carrierName: 'Paul',
    });
    expect(receivePayload({ receivedXaf: 0, comment: ' Perdue ' })).toEqual({
      receivedXaf: 0,
      comment: 'Perdue',
    });
    expect(cancelPayload('  Erreur de montant ')).toEqual({ reason: 'Erreur de montant' });
  });
});
