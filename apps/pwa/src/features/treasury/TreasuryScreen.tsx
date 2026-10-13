/**
 * ECR-FIN-05 « Trésorerie » (Finance ; Direction : AV-241). En ligne seulement (`ONLINE_ONLY` sinon) :
 * sessions de caisse à valider (détail des flux, validation motivée, `finance.cash_session.validate`),
 * écarts de remise à décider (imputation et motif, `approvals.request.approve` sur la demande
 * `CASH_TRANSFER_DISCREPANCY`, AV-174), remises en transit (réception par la Finance), comptes et leurs
 * mouvements. Les ajustements tardifs des sessions déjà validées ne sont pas listés (S-51).
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import type { CashTransferImputation } from '@gic/domain';
import { holdsAnyRole, ROLE_SETS } from '../../app/screens.js';
import { clock } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { getDb } from '../../storage/db.js';
import { useAuth } from '../auth/AuthContext.js';
import { TransferReceiveForm } from '../cash/TransferReceiveForm.js';
import { discrepancyPolicyState, receivePayload } from '../cash/transfers.js';
import { formatBusinessDay, formatClockTime, formatDateTime } from '../home/format-home.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatMoney } from '../sales/format.js';
import { readPages, readPath, useOnlineRead, type ReadResult } from '../sales/online-read.js';
import { useSalesReferences } from '../sales/references.js';
import {
  isBlockingWait,
  lastWaitingCommand,
  phaseOf,
  saveErrorKey,
  submitCommand,
  waitingIds,
} from '../sales/submit.js';
import { AccountMovements } from './AccountMovements.js';
import { SessionDetail } from './SessionDetail.js';
import {
  decisionPayload,
  imputationOptions,
  MAX_DECISION_COMMENT,
  MAX_DECISION_REASON,
  transferDecisionBlock,
  userLabel,
  validatePayload,
  type CashAccountItem,
  type CashAccountsResponse,
  type CashSessionItem,
  type CashTransferItem,
} from './treasury.js';

const MANAGED_COMMANDS = new Set([
  'finance.cash_session.validate',
  'approvals.request.approve',
  'finance.cash_transfer.receive',
]);

type Kind = 'validate' | 'decide' | 'receive';

const KINDS: Readonly<Record<string, Kind>> = {
  'finance.cash_session.validate': 'validate',
  'approvals.request.approve': 'decide',
  'finance.cash_transfer.receive': 'receive',
};

/** Taille d'une page des listes (`CASH_LIST_MAX_LIMIT`) et pages lues au plus (liste partielle au-delà). */
const PAGE_LIMIT = 200;
const MAX_PAGES = 5;

interface TreasuryRead {
  readonly accounts: readonly CashAccountItem[];
  readonly sessions: readonly CashSessionItem[];
  readonly sessionsMore: boolean;
  readonly discrepancies: readonly CashTransferItem[];
  readonly discrepanciesMore: boolean;
  readonly inTransit: readonly CashTransferItem[];
  readonly inTransitMore: boolean;
}

async function readTreasury(): Promise<ReadResult<TreasuryRead>> {
  const accounts = await readPath<CashAccountsResponse>('/api/v1/cash-accounts');
  if (!accounts.ok) return accounts;
  const sessions = await readPages<CashSessionItem>(
    [`/api/v1/cash-sessions?status=PENDING_VALIDATION&limit=${PAGE_LIMIT}`],
    'cash_sessions',
    MAX_PAGES,
  );
  if (!sessions.ok) return sessions;
  const discrepancies = await readPages<CashTransferItem>(
    [`/api/v1/cash-transfers?status=DISCREPANCY_PENDING&limit=${PAGE_LIMIT}`],
    'cash_transfers',
    MAX_PAGES,
  );
  if (!discrepancies.ok) return discrepancies;
  const inTransit = await readPages<CashTransferItem>(
    [`/api/v1/cash-transfers?status=SENT&limit=${PAGE_LIMIT}`],
    'cash_transfers',
    MAX_PAGES,
  );
  if (!inTransit.ok) return inTransit;
  return {
    ok: true,
    data: {
      accounts: accounts.data.cash_accounts,
      sessions: sessions.data.items,
      sessionsMore: sessions.data.more,
      discrepancies: discrepancies.data.items,
      discrepanciesMore: discrepancies.data.more,
      inTransit: inTransit.data.items,
      inTransitMore: inTransit.data.more,
    },
  };
}

export function TreasuryScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
  const navigation = useRememberedNavigation(userId);
  const online = useOnline();
  const [open, setOpen] = useState<{
    id: string;
    kind: 'session' | 'decide' | 'receive' | 'account';
  } | null>(null);
  const [option, setOption] = useState<CashTransferImputation | ''>('');
  const [reason, setReason] = useState('');
  const [comment, setComment] = useState('');
  const [last, setLast] = useState<{ commandId: string; kind: Kind }>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const ids = { option: useId(), reason: useId(), comment: useId() };
  // Commandes gérées lues dans la base locale : les décisions (`approvals.`) ne sont pas dans les
  // référentiels de vente.
  const managed =
    useLiveQuery(
      () =>
        getDb()
          .outbox.orderBy('device_seq')
          .filter((command) => MANAGED_COMMANDS.has(command.command_type))
          .toArray(),
      [],
    ) ?? [];
  const lastCommand = managed.find((command) => command.command_id === last?.commandId);
  // Focus porté sur le premier champ d'un formulaire ouvert, rendu au bouton qui l'a ouvert.
  const openers = useRef(new Map<string, HTMLButtonElement | null>());
  const optionRef = useRef<HTMLSelectElement>(null);
  const lastOpened = useRef<string | null>(null);
  useEffect(() => {
    if (open) {
      lastOpened.current = `${open.kind}:${open.id}`;
      if (open.kind === 'decide') optionRef.current?.focus();
    } else if (lastOpened.current) {
      openers.current.get(lastOpened.current)?.focus();
      lastOpened.current = null;
    }
  }, [open]);
  const opener = (kind: string, id: string) => (element: HTMLButtonElement | null) => {
    openers.current.set(`${kind}:${id}`, element);
  };
  const reloadKey = `${last?.commandId ?? ''}:${lastCommand ? phaseOf(lastCommand) : ''}|${[
    'finance.',
    'approvals.',
  ]
    .map((prefix) => waitingIds(managed, prefix, userId))
    .join('|')}`;
  const read = useOnlineRead<TreasuryRead>(
    online ? 'treasury' : null,
    () => readTreasury(),
    online,
    reloadKey,
  );

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.treasury')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }
  if (!online) {
    return (
      <section className="sale">
        <h1>{t('nav.screens.treasury')}</h1>
        <p className="home-muted">{t('treasury.online_only')}</p>
      </section>
    );
  }

  // Retour sur l'écran avec une opération en attente : son résultat est annoncé.
  const adopt = last
    ? undefined
    : (lastWaitingCommand(managed, 'finance.', userId) ??
      lastWaitingCommand(managed, 'approvals.', userId));
  if (adopt)
    setLast({ commandId: adopt.command_id, kind: KINDS[adopt.command_type] ?? 'validate' });

  const data = read.data;
  const you = t('treasury.you');
  const who = (id: string | null) => userLabel(id, userId, you);
  const names = new Map((data?.accounts ?? []).map((account) => [account.id, account.name]));
  const nameOf = (id: string) => names.get(id) ?? `…${id.slice(-4)}`;
  const waiting = managed.some(
    (command) => command.author_user_id === userId && isBlockingWait(command, refs.outbox),
  );
  const blocked = busy || waiting || read.stale || !data;
  // Réception par la Finance : `finance.cash_transfer.record` (la Direction ne l'a pas).
  const mayReceive = holdsAnyRole(navigation?.roles ?? [], ROLE_SETS.cashTransferRecord);
  const policy = discrepancyPolicyState(refs.controlPolicies, clock.now());

  const toggle = (id: string, kind: 'session' | 'decide' | 'receive' | 'account') => {
    setOpen((current) => (current?.id === id && current.kind === kind ? null : { id, kind }));
    setOption('');
    setReason('');
    setComment('');
  };

  const send = async (kind: Kind, input: Parameters<typeof submitCommand>[0]) => {
    if (blocked) return;
    setBusy(true);
    setSaveError(null);
    try {
      const command = await submitCommand(input);
      setLast({ commandId: command.command_id, kind });
      setOpen(null);
    } catch (error) {
      setSaveError(saveErrorKey(error));
    } finally {
      setBusy(false);
    }
  };

  const validate = (sessionId: string, text: string) =>
    void send('validate', {
      authorUserId: userId,
      commandType: 'finance.cash_session.validate',
      aggregateType: 'CASH_SESSION',
      aggregateId: sessionId,
      payload: validatePayload(text),
    });

  const decide = (transfer: CashTransferItem) => {
    if (!option || reason.trim() === '' || transfer.approvalRequestId === null) return;
    void send('decide', {
      authorUserId: userId,
      commandType: 'approvals.request.approve',
      aggregateType: 'APPROVAL_REQUEST',
      aggregateId: transfer.approvalRequestId,
      payload: decisionPayload({
        requestId: transfer.approvalRequestId,
        option,
        reason,
        comment,
      }),
    });
  };

  const receive = (transfer: CashTransferItem, receivedXaf: number, text: string) =>
    void send('receive', {
      authorUserId: userId,
      commandType: 'finance.cash_transfer.receive',
      aggregateType: 'CASH_TRANSFER',
      aggregateId: transfer.id,
      payload: receivePayload({ receivedXaf, comment: text }),
    });

  const transferLines = (transfer: CashTransferItem) => (
    <>
      <p>
        <strong>{transfer.docNumber}</strong> · {formatMoney(transfer.amountSentXaf)}
      </p>
      <p className="home-muted">
        {t('cash_transfer.route', {
          from: nameOf(transfer.fromAccountId),
          to: nameOf(transfer.toAccountId),
        })}
      </p>
      <p className="home-muted">
        {t('treasury.transfer_people', {
          date: formatDateTime(transfer.sentAt),
          sender: who(transfer.sentBy),
          carrier:
            transfer.carrierName ?? (transfer.carrierUserId ? who(transfer.carrierUserId) : '—'),
        })}
      </p>
    </>
  );

  return (
    <section className="sale">
      <h1>{t('nav.screens.treasury')}</h1>
      {last ? (
        <CommandResult commandId={last.commandId} messages={`treasury.${last.kind}_result`} />
      ) : null}
      {saveError ? (
        <p className="alert alert-error" role="alert">
          {t(saveError)}
        </p>
      ) : null}
      {read.failed && !read.denied ? (
        // Relecture en échec : annoncée avec « Réessayer », la liste d'avant restant affichée comme
        // périmée (les actions y restent bloquées).
        <div className="alert alert-error" role="alert">
          <p>{t(data ? 'treasury.failed_stale' : 'treasury.failed')}</p>
          <button type="button" className="secondary" onClick={read.retry}>
            {t('distribution.retry')}
          </button>
        </div>
      ) : null}
      {read.denied ? (
        <p className="alert alert-error" role="alert">
          {t('treasury.denied')}
        </p>
      ) : !data ? (
        read.failed ? null : (
          <p className="home-muted" aria-busy="true">
            {t('sales.loading')}
          </p>
        )
      ) : (
        <>
          {read.stale && !read.failed ? (
            <p className="home-muted" role="status">
              {t('treasury.refreshing')}
            </p>
          ) : null}
          <section className="sale-block" aria-labelledby="treasury-sessions-title">
            <h2 id="treasury-sessions-title">{t('treasury.sessions_title')}</h2>
            {data.sessionsMore ? (
              <p className="text-warn" role="status">
                {t('treasury.partial', { count: data.sessions.length })}
              </p>
            ) : null}
            {data.sessions.length === 0 ? (
              <p className="home-muted">{t('treasury.sessions_empty')}</p>
            ) : (
              <ul className="line-list">
                {data.sessions.map((session) => {
                  // Le compte, le jour et les heures : deux sessions d'un même jour se distinguent.
                  const label = t('treasury.session_label', {
                    account: nameOf(session.cashAccountId),
                    date: session.businessDate
                      ? formatBusinessDay(session.businessDate)
                      : formatDateTime(session.openedAt),
                    from: formatClockTime(session.openedAt),
                    to: session.closedAt ? formatClockTime(session.closedAt) : '…',
                  });
                  const expanded = open?.id === session.id && open.kind === 'session';
                  return (
                    <li key={session.id} className="line-card" aria-label={label}>
                      <p>
                        <strong>{label}</strong>
                      </p>
                      <p className="home-muted">
                        {t('treasury.session_people', {
                          opened: who(session.openedBy),
                          openedAt: formatDateTime(session.openedAt),
                          closed: who(session.closedBy),
                          closedAt: session.closedAt ? formatDateTime(session.closedAt) : '',
                        })}
                      </p>
                      {session.openingVarianceXaf !== 0 ? (
                        <p className="text-warn">
                          {t('treasury.opening_variance', {
                            amount: formatMoney(session.openingVarianceXaf),
                          })}
                        </p>
                      ) : null}
                      <p className={(session.varianceXaf ?? 0) !== 0 ? 'text-warn' : 'home-muted'}>
                        {t('treasury.closing_variance', {
                          amount: formatMoney(session.varianceXaf ?? 0),
                          counted: formatMoney(session.closingCountedXaf ?? 0),
                          expected: formatMoney(session.closingExpectedXaf ?? 0),
                        })}
                      </p>
                      {session.forceClosed ? (
                        <p className="text-warn">{t('treasury.force_closed')}</p>
                      ) : null}
                      {session.clockSuspect ? (
                        <p className="text-warn">{t('treasury.clock_suspect')}</p>
                      ) : null}
                      <button
                        type="button"
                        className="secondary"
                        ref={opener('session', session.id)}
                        aria-expanded={expanded}
                        onClick={() => toggle(session.id, 'session')}
                      >
                        {t(expanded ? 'treasury.session_close' : 'treasury.session_open', {
                          label,
                        })}
                      </button>
                      {expanded ? (
                        <SessionDetail
                          sessionId={session.id}
                          userId={userId}
                          online={online}
                          reloadKey={reloadKey}
                          blocked={blocked}
                          onValidate={validate}
                          onRefresh={read.retry}
                        />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="home-muted">{t('treasury.adjustments_hint')}</p>
          </section>

          <section className="sale-block" aria-labelledby="treasury-discrepancies-title">
            <h2 id="treasury-discrepancies-title">{t('treasury.discrepancies_title')}</h2>
            {data.discrepanciesMore ? (
              <p className="text-warn" role="status">
                {t('treasury.partial', { count: data.discrepancies.length })}
              </p>
            ) : null}
            {data.discrepancies.length === 0 ? (
              <p className="home-muted">{t('treasury.discrepancies_empty')}</p>
            ) : (
              <ul className="line-list">
                {data.discrepancies.map((transfer) => {
                  const block = transferDecisionBlock(transfer, userId);
                  const expanded = open?.id === transfer.id && open.kind === 'decide';
                  return (
                    <li key={transfer.id} className="line-card" aria-label={transfer.docNumber}>
                      {transferLines(transfer)}
                      <p className="text-warn">
                        {t('treasury.discrepancy_line', {
                          received: formatMoney(transfer.amountReceivedXaf ?? 0),
                          receiver: who(transfer.receivedBy),
                          gap: `${(transfer.discrepancyXaf ?? 0) > 0 ? '+' : ''}${formatMoney(
                            transfer.discrepancyXaf ?? 0,
                          )}`,
                        })}
                      </p>
                      {block ? (
                        <p className="home-muted">{t(`treasury.decision_block.${block}`)}</p>
                      ) : expanded ? (
                        <div className="field">
                          <label htmlFor={ids.option}>{t('treasury.imputation_label')}</label>
                          <select
                            id={ids.option}
                            ref={optionRef}
                            className="text-input"
                            value={option}
                            onChange={(event) =>
                              setOption(event.target.value as CashTransferImputation | '')
                            }
                          >
                            <option value="">{t('treasury.imputation_placeholder')}</option>
                            {imputationOptions(transfer).map((choice) => (
                              <option
                                key={choice.option}
                                value={choice.option}
                                disabled={choice.disabled}
                              >
                                {t(`treasury.imputation.${choice.option}`)}
                              </option>
                            ))}
                          </select>
                          <label htmlFor={ids.reason}>{t('treasury.decision_reason')}</label>
                          <textarea
                            id={ids.reason}
                            className="text-input"
                            rows={2}
                            maxLength={MAX_DECISION_REASON}
                            value={reason}
                            onChange={(event) => setReason(event.target.value)}
                          />
                          <label htmlFor={ids.comment}>{t('treasury.decision_comment')}</label>
                          <textarea
                            id={ids.comment}
                            className="text-input"
                            rows={2}
                            maxLength={MAX_DECISION_COMMENT}
                            value={comment}
                            onChange={(event) => setComment(event.target.value)}
                          />
                          <div className="result-actions">
                            <button
                              type="button"
                              disabled={blocked || !option || reason.trim() === ''}
                              onClick={() => decide(transfer)}
                            >
                              {t('treasury.decide_submit')}
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => toggle(transfer.id, 'decide')}
                            >
                              {t('cash_transfer.close_form')}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="secondary"
                          ref={opener('decide', transfer.id)}
                          disabled={blocked}
                          onClick={() => toggle(transfer.id, 'decide')}
                        >
                          {t('treasury.decide_open', { doc: transfer.docNumber })}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="sale-block" aria-labelledby="treasury-transit-title">
            <h2 id="treasury-transit-title">{t('treasury.transit_title')}</h2>
            {data.inTransitMore ? (
              <p className="text-warn" role="status">
                {t('treasury.partial', { count: data.inTransit.length })}
              </p>
            ) : null}
            {data.inTransit.length === 0 ? (
              <p className="home-muted">{t('treasury.transit_empty')}</p>
            ) : (
              <ul className="line-list">
                {data.inTransit.map((transfer) => {
                  const expanded = open?.id === transfer.id && open.kind === 'receive';
                  const receivable = mayReceive && transfer.sentBy !== userId;
                  return (
                    <li key={transfer.id} className="line-card" aria-label={transfer.docNumber}>
                      {transferLines(transfer)}
                      {!receivable ? null : expanded ? (
                        <TransferReceiveForm
                          sentXaf={transfer.amountSentXaf}
                          policy={policy}
                          busy={blocked}
                          onSubmit={(received, text) => receive(transfer, received, text)}
                          onClose={() => setOpen(null)}
                        />
                      ) : (
                        <button
                          type="button"
                          className="secondary"
                          ref={opener('receive', transfer.id)}
                          disabled={blocked}
                          onClick={() => toggle(transfer.id, 'receive')}
                        >
                          {t('cash_transfer.receive_open', { label: transfer.docNumber })}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="sale-block" aria-labelledby="treasury-accounts-title">
            <h2 id="treasury-accounts-title">{t('treasury.accounts_title')}</h2>
            {data.accounts.length === 0 ? (
              <p className="home-muted">{t('treasury.accounts_empty')}</p>
            ) : (
              <ul className="line-list">
                {data.accounts.map((account) => {
                  const expanded = open?.id === account.id && open.kind === 'account';
                  return (
                    <li key={account.id} className="line-card" aria-label={account.name}>
                      <p>
                        <strong>{account.name}</strong> ·{' '}
                        {t(`treasury.account_type.${account.accountType}`, {
                          defaultValue: account.accountType,
                        })}
                        {account.status !== 'ACTIVE' ? ` · ${t('treasury.inactive')}` : ''}
                      </p>
                      <p>{t('treasury.balance', { amount: formatMoney(account.balanceXaf) })}</p>
                      <button
                        type="button"
                        className="secondary"
                        ref={opener('account', account.id)}
                        aria-expanded={expanded}
                        onClick={() => toggle(account.id, 'account')}
                      >
                        {t(expanded ? 'treasury.movements_close' : 'treasury.movements_open', {
                          name: account.name,
                        })}
                      </button>
                      {expanded ? (
                        <AccountMovements
                          accountId={account.id}
                          online={online}
                          reloadKey={reloadKey}
                        />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </section>
  );
}
