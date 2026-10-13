/**
 * Écran des remises de fonds (UC-FIN-07, hors inventaire des écrans : AV-311). Hors ligne : remettre
 * des fonds d'une caisse vers une destination admise (`finance.cash_transfer.send`, agrégat
 * `CASH_TRANSFER` dont l'identifiant est choisi par l'appareil), annuler une remise qu'on a envoyée et
 * qui n'est pas reçue (`.cancel`, motif obligatoire), recevoir une remise arrivée sur l'une de ses
 * caisses (`.receive`, montant reçu ; un écart part en validation de la Finance, sans second
 * mouvement : ADR-032 §7). Le solde de la caisse source est indicatif (AV-312).
 */
import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { clock, idGenerator } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatDateTime } from '../home/format-home.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatMoney } from '../sales/format.js';
import { useSalesReferences } from '../sales/references.js';
import { parseXaf } from '../sales/sale-form.js';
import { submitCommand } from '../sales/submit.js';
import { pendingCashMovements } from './cash-session.js';
import {
  cancelPayload,
  canCancel,
  deviceTransfers,
  MAX_CANCEL_REASON,
  MAX_CARRIER_NAME,
  MAX_TRANSFER_COMMENT,
  mySentTransfers,
  overIndicativeBalance,
  ownAccounts,
  receivePayload,
  sendPayload,
  sourceAccounts,
  targetsFor,
  toReceive,
  transferPairs,
  type TransferView,
} from './transfers.js';

type Kind = 'send' | 'cancel' | 'receive';

export function CashTransfersScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
  const online = useOnline();
  const [sourceChoice, setSourceChoice] = useState<string | null>(null);
  const [targetChoice, setTargetChoice] = useState('');
  const [amountText, setAmountText] = useState('');
  const [carrierText, setCarrierText] = useState('');
  const [commentText, setCommentText] = useState('');
  const [editing, setEditing] = useState<{ id: string; kind: 'cancel' | 'receive' } | null>(null);
  const [editText, setEditText] = useState('');
  const [editComment, setEditComment] = useState('');
  const [last, setLast] = useState<{ commandId: string; kind: Kind }>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const ids = {
    source: useId(),
    target: useId(),
    amount: useId(),
    amountIssue: useId(),
    carrier: useId(),
    comment: useId(),
    edit: useId(),
    editIssue: useId(),
    editComment: useId(),
    preview: useId(),
  };

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.cash_transfers')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const now = clock.now();
  const pairs = transferPairs(refs.settings, now);
  const views = deviceTransfers({
    transfers: refs.cashTransfers,
    outbox: refs.outbox,
    cashPulledAt: refs.cashPulledAt,
  });
  const names = new Map<string, string>([
    ...refs.cashTransferTargets.map((target) => [target.id, target.name] as const),
    ...refs.cashAccounts.map((account) => [account.id, account.name] as const),
  ]);
  const nameOf = (accountId: string) => names.get(accountId) ?? t('cash_transfer.unknown_account');
  const labelOf = (view: TransferView) => view.docNumber ?? t('cash_transfer.unnumbered');
  const own = new Set(ownAccounts(refs.cashAccounts, userId).map((account) => account.id));
  const incoming = toReceive(views, refs.cashAccounts, userId);
  // Réceptions en cours ou écarts en attente de la Finance sur l'une de ses caisses : pour mémoire.
  const receivedPending = views.filter(
    (view) =>
      view.sentBy !== userId &&
      own.has(view.toAccountId) &&
      (view.receiving !== null || view.status === 'DISCREPANCY_PENDING'),
  );
  const sent = mySentTransfers(views, userId);
  const sources = sourceAccounts(refs.cashAccounts, refs.cashTransferTargets, pairs, userId);
  const source = sources.find((candidate) => candidate.id === sourceChoice) ?? sources[0];
  const targets = source ? targetsFor(source, refs.cashTransferTargets, pairs) : [];
  const target = targets.find((candidate) => candidate.id === targetChoice);
  const amount = parseXaf(amountText);
  const amountValid = amount !== null && amount > 0;
  const amountIssue = amountText.trim() !== '' && !amountValid;
  const movements = source
    ? pendingCashMovements({
        account: source,
        outbox: refs.outbox,
        cashPulledAt: refs.cashPulledAt,
        locations: refs.locations,
        paymentMethods: refs.paymentMethods,
        transfers: refs.cashTransfers,
      })
    : null;
  const balance =
    source && source.balance_xaf !== undefined && movements
      ? source.balance_xaf + movements.netXaf
      : null;
  const over =
    source !== undefined && amountValid && overIndicativeBalance(source, balance, amount ?? 0);

  const submit = async (kind: Kind, input: Parameters<typeof submitCommand>[0]) => {
    if (busy) return false;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand(input);
      setLast({ commandId: command.command_id, kind });
      return true;
    } catch {
      setSaveError(true);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!source || !target || !amountValid || amount === null) return;
    const done = await submit('send', {
      authorUserId: userId,
      commandType: 'finance.cash_transfer.send',
      aggregateType: 'CASH_TRANSFER',
      aggregateId: idGenerator.newId(),
      payload: sendPayload({
        fromAccountId: source.id,
        toAccountId: target.id,
        amountXaf: amount,
        carrierName: carrierText,
        comment: commentText,
      }),
    });
    if (done) {
      setTargetChoice('');
      setAmountText('');
      setCarrierText('');
      setCommentText('');
    }
  };

  const closeEdit = () => {
    setEditing(null);
    setEditText('');
    setEditComment('');
  };

  const cancel = async (view: TransferView) => {
    if (!canCancel(view, userId) || editText.trim() === '') return;
    const done = await submit('cancel', {
      authorUserId: userId,
      commandType: 'finance.cash_transfer.cancel',
      aggregateType: 'CASH_TRANSFER',
      aggregateId: view.id,
      // Envoi encore sur l'appareil : l'annulation part après lui.
      ...(view.sendCommandId && view.sendWaiting ? { dependsOn: [view.sendCommandId] } : {}),
      payload: cancelPayload(editText),
    });
    if (done) closeEdit();
  };

  const receive = async (view: TransferView, receivedXaf: number) => {
    const done = await submit('receive', {
      authorUserId: userId,
      commandType: 'finance.cash_transfer.receive',
      aggregateType: 'CASH_TRANSFER',
      aggregateId: view.id,
      payload: receivePayload({ receivedXaf, comment: editComment }),
    });
    if (done) closeEdit();
  };

  const stateText = (view: TransferView) => {
    if (view.cancelling) return t(`cash_transfer.cancelling_${view.cancelling}`);
    if (view.receiving) return t(`cash_transfer.receiving_${view.receiving}`);
    if (view.status === null) {
      return t(view.sendWaiting ? 'cash_transfer.state_waiting' : 'cash_transfer.state_unpulled');
    }
    return t(
      view.status === 'DISCREPANCY_PENDING'
        ? 'cash_transfer.state_discrepancy'
        : 'cash_transfer.state_in_transit',
    );
  };

  const card = (view: TransferView, actions: ReactNode) => (
    <li key={view.id} className="line-card" aria-label={labelOf(view)}>
      <p>
        <strong>{labelOf(view)}</strong> · {formatMoney(view.amountSentXaf)}
      </p>
      <p className="home-muted">
        {t('cash_transfer.route', {
          from: nameOf(view.fromAccountId),
          to: nameOf(view.toAccountId),
        })}
      </p>
      <p className="home-muted">
        {t('cash_transfer.sent_at', { date: formatDateTime(view.sentAt) })}
        {view.carrierName ? ` · ${t('cash_transfer.carrier', { name: view.carrierName })}` : ''}
      </p>
      <p className={view.status === 'DISCREPANCY_PENDING' ? 'text-warn' : 'home-muted'}>
        {stateText(view)}
      </p>
      {actions}
    </li>
  );

  const receiveForm = (view: TransferView) => {
    const received = parseXaf(editText);
    const issue = editText.trim() !== '' && received === null;
    const gap = received === null ? null : received - view.amountSentXaf;
    return (
      <div className="field">
        <label htmlFor={ids.edit}>{t('cash_transfer.received_label')}</label>
        <input
          id={ids.edit}
          className="text-input"
          inputMode="numeric"
          autoComplete="off"
          value={editText}
          aria-invalid={issue}
          aria-describedby={issue ? ids.editIssue : gap !== null ? ids.preview : undefined}
          onChange={(event) => setEditText(event.target.value)}
        />
        {issue ? (
          <p id={ids.editIssue} className="error-message">
            {t('cash_transfer.received_invalid')}
          </p>
        ) : gap === null ? null : (
          <p id={ids.preview} className={gap === 0 ? 'home-muted' : 'text-warn'} role="status">
            {received === 0
              ? t('cash_transfer.lost')
              : gap === 0
                ? t('cash_transfer.match')
                : t('cash_transfer.discrepancy', {
                    amount: `${gap > 0 ? '+' : ''}${formatMoney(gap)}`,
                  })}
          </p>
        )}
        <label htmlFor={ids.editComment}>{t('cash_transfer.comment_label')}</label>
        <textarea
          id={ids.editComment}
          className="text-input"
          rows={2}
          maxLength={MAX_TRANSFER_COMMENT}
          value={editComment}
          onChange={(event) => setEditComment(event.target.value)}
        />
        <div className="result-actions">
          <button
            type="button"
            disabled={busy || received === null}
            onClick={() => (received === null ? undefined : void receive(view, received))}
          >
            {t('cash_transfer.receive_submit', { amount: formatMoney(received ?? 0) })}
          </button>
          <button type="button" className="secondary" onClick={closeEdit}>
            {t('cash_transfer.close_form')}
          </button>
        </div>
      </div>
    );
  };

  const cancelForm = (view: TransferView) => (
    <div className="field">
      <label htmlFor={ids.edit}>{t('cash_transfer.reason_label')}</label>
      <textarea
        id={ids.edit}
        className="text-input"
        rows={2}
        maxLength={MAX_CANCEL_REASON}
        value={editText}
        onChange={(event) => setEditText(event.target.value)}
      />
      <div className="result-actions">
        <button
          type="button"
          disabled={busy || editText.trim() === ''}
          onClick={() => void cancel(view)}
        >
          {t('cash_transfer.cancel_submit')}
        </button>
        <button type="button" className="secondary" onClick={closeEdit}>
          {t('cash_transfer.close_form')}
        </button>
      </div>
    </div>
  );

  const open = (id: string, kind: 'cancel' | 'receive') => {
    setEditing({ id, kind });
    setEditText('');
    setEditComment('');
  };

  return (
    <section className="sale">
      <h1>{t('nav.screens.cash_transfers')}</h1>
      {!online ? (
        <p className="home-banner" role="status">
          {t('cash_transfer.offline_banner')}
        </p>
      ) : null}
      {last ? (
        <CommandResult commandId={last.commandId} messages={`cash_transfer.${last.kind}_result`} />
      ) : null}
      {saveError ? (
        <p className="alert alert-error" role="alert">
          {t('sales.error_local_save')}
        </p>
      ) : null}

      {incoming.length > 0 || receivedPending.length > 0 ? (
        <section className="sale-block" aria-labelledby="transfers-incoming-title">
          <h2 id="transfers-incoming-title">{t('cash_transfer.incoming_title')}</h2>
          <ul className="line-list">
            {incoming.map((view) =>
              card(
                view,
                editing?.id === view.id && editing.kind === 'receive' ? (
                  receiveForm(view)
                ) : (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => open(view.id, 'receive')}
                  >
                    {t('cash_transfer.receive_open', { label: labelOf(view) })}
                  </button>
                ),
              ),
            )}
            {receivedPending.map((view) => card(view, null))}
          </ul>
        </section>
      ) : null}

      <section className="sale-block" aria-labelledby="transfers-sent-title">
        <h2 id="transfers-sent-title">{t('cash_transfer.sent_title')}</h2>
        {sent.length === 0 ? (
          <p className="home-muted">{t('cash_transfer.sent_empty')}</p>
        ) : (
          <ul className="line-list">
            {sent.map((view) =>
              card(
                view,
                !canCancel(view, userId) ? null : editing?.id === view.id &&
                  editing.kind === 'cancel' ? (
                  cancelForm(view)
                ) : (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => open(view.id, 'cancel')}
                  >
                    {t('cash_transfer.cancel_open', { label: labelOf(view) })}
                  </button>
                ),
              ),
            )}
          </ul>
        )}
      </section>

      <section className="sale-block" aria-labelledby="transfers-new-title">
        <h2 id="transfers-new-title">{t('cash_transfer.new_title')}</h2>
        {!source ? (
          <p className="home-muted">{t('cash_transfer.no_source')}</p>
        ) : (
          <>
            {sources.length > 1 ? (
              <div className="field">
                <label htmlFor={ids.source}>{t('cash_transfer.source_label')}</label>
                <select
                  id={ids.source}
                  className="text-input"
                  value={source.id}
                  onChange={(event) => {
                    setSourceChoice(event.target.value);
                    setTargetChoice('');
                  }}
                >
                  {sources.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <p className="picked-title">{source.name}</p>
            )}
            <p className="home-muted">
              {balance === null
                ? t('cash_transfer.balance_unknown')
                : t('cash_transfer.balance', { amount: formatMoney(balance) })}
            </p>
            <div className="field">
              <label htmlFor={ids.target}>{t('cash_transfer.target_label')}</label>
              <select
                id={ids.target}
                className="text-input"
                value={target?.id ?? ''}
                onChange={(event) => setTargetChoice(event.target.value)}
              >
                <option value="">{t('cash_transfer.target_placeholder')}</option>
                {targets.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={ids.amount}>{t('cash_transfer.amount_label')}</label>
              <input
                id={ids.amount}
                className="text-input"
                inputMode="numeric"
                autoComplete="off"
                value={amountText}
                aria-invalid={amountIssue}
                aria-describedby={amountIssue ? ids.amountIssue : undefined}
                onChange={(event) => setAmountText(event.target.value)}
              />
              {amountIssue ? (
                <p id={ids.amountIssue} className="error-message">
                  {t('cash_transfer.amount_invalid')}
                </p>
              ) : over ? (
                <p className="text-warn" role="status">
                  {t('cash_transfer.over_balance')}
                </p>
              ) : null}
            </div>
            <div className="field">
              <label htmlFor={ids.carrier}>{t('cash_transfer.carrier_label')}</label>
              <input
                id={ids.carrier}
                className="text-input"
                maxLength={MAX_CARRIER_NAME}
                value={carrierText}
                onChange={(event) => setCarrierText(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor={ids.comment}>{t('cash_transfer.comment_label')}</label>
              <textarea
                id={ids.comment}
                className="text-input"
                rows={2}
                maxLength={MAX_TRANSFER_COMMENT}
                value={commentText}
                onChange={(event) => setCommentText(event.target.value)}
              />
            </div>
            <button
              type="button"
              className="btn-block submit-sale"
              disabled={busy || !target || !amountValid}
              onClick={() => void send()}
            >
              {busy ? t('sales.submitting') : t('cash_transfer.send_submit')}
            </button>
          </>
        )}
      </section>
    </section>
  );
}
