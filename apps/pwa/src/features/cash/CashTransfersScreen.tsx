/**
 * Écran des remises de fonds (ECR-FIN-07, UC-FIN-07 ; AV-239). Hors ligne : remettre
 * des fonds d'une caisse vers une destination admise (`finance.cash_transfer.send`, agrégat
 * `CASH_TRANSFER` dont l'identifiant est choisi par l'appareil), annuler une remise qu'on a envoyée et
 * qui n'est pas reçue (`.cancel`, motif obligatoire), recevoir une remise arrivée sur l'une de ses
 * caisses (`.receive`, montant reçu ; un écart part en validation de la Finance, sans second
 * mouvement : ADR-032 §7). Le solde de la caisse source est indicatif (AV-240).
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ActionBar, Button, PageHeader } from '../../components/ui/index.js';
import { PieceAction } from '../pieces/PieceAction.js';
import { demandeRemiseDeFonds } from '../pieces/adaptateurs-finance.js';
import { clock, idGenerator } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatClockTime, formatDateTime } from '../home/format-home.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatMoney } from '../sales/format.js';
import { useSalesReferences } from '../sales/references.js';
import { parseXaf } from '../sales/sale-form.js';
import { submitCommand } from '../sales/submit.js';
import { TransferReceiveForm } from './TransferReceiveForm.js';
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
  transferSourceBalance,
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
  };
  // Focus porté sur le premier champ d'un formulaire ouvert, rendu au bouton qui l'a ouvert.
  const openers = useRef(new Map<string, HTMLButtonElement | null>());
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const lastOpened = useRef<string | null>(null);
  useEffect(() => {
    if (editing) {
      lastOpened.current = `${editing.kind}:${editing.id}`;
      if (editing.kind === 'cancel') reasonRef.current?.focus();
    } else if (lastOpened.current) {
      openers.current.get(lastOpened.current)?.focus();
      lastOpened.current = null;
    }
  }, [editing]);

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <PageHeader title={t('nav.screens.cash_transfers')} />
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
  // Compte inconnu de l'appareil : une caisse personnelle (les comptes sans détenteur sont tous
  // servis comme destinations de remise, AV-197 ; les noms des autres, S-52).
  const nameOf = (accountId: string) => names.get(accountId) ?? t('cash_transfer.personal_account');
  // Remise sans numéro : nommée par son montant, sa destination et son heure (noms distincts).
  const labelOf = (view: TransferView) =>
    view.docNumber ??
    t('cash_transfer.pending_label', {
      amount: formatMoney(view.amountSentXaf),
      to: nameOf(view.toAccountId),
      time: formatClockTime(view.sentAt),
    });
  const who = (id: string) => (id === userId ? t('cash_transfer.you') : `…${id.slice(-4)}`);
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
  const balance = source
    ? transferSourceBalance({
        account: source,
        userId,
        now,
        sessions: refs.cashSessions,
        outbox: refs.outbox,
        cashPulledAt: refs.cashPulledAt,
        locations: refs.locations,
        paymentMethods: refs.paymentMethods,
        siteTypes: new Map([...refs.sites.values()].map((site) => [site.id, site.site_type])),
        transfers: refs.cashTransfers,
        settings: refs.settings,
      })
    : null;
  const over =
    source !== undefined &&
    amountValid &&
    balance?.kind === 'SHOWN' &&
    overIndicativeBalance(source, balance.xaf, amount ?? 0);

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

  const receive = async (view: TransferView, receivedXaf: number, comment: string) => {
    const done = await submit('receive', {
      authorUserId: userId,
      commandType: 'finance.cash_transfer.receive',
      aggregateType: 'CASH_TRANSFER',
      aggregateId: view.id,
      payload: receivePayload({ receivedXaf, comment }),
    });
    if (done) closeEdit();
  };

  const stateText = (view: TransferView) => {
    if (view.cancelling) return t(`cash_transfer.cancelling_${view.cancelling}`);
    if (view.receiving) {
      // Réception avec un écart (perte comprise) : la remise restera en attente de la Finance.
      const gap = view.receivingXaf === null ? 0 : view.receivingXaf - view.amountSentXaf;
      return gap === 0
        ? t(`cash_transfer.receiving_${view.receiving}`)
        : t(`cash_transfer.receiving_gap_${view.receiving}`, {
            amount: `${gap > 0 ? '+' : ''}${formatMoney(gap)}`,
          });
    }
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
        {t('cash_transfer.sent_at', { date: formatDateTime(view.sentAt), who: who(view.sentBy) })}
        {view.carrierName ? ` · ${t('cash_transfer.carrier', { name: view.carrierName })}` : ''}
      </p>
      <p className={view.status === 'DISCREPANCY_PENDING' ? 'text-warn' : 'home-muted'}>
        {stateText(view)}
      </p>
      {/* Bordereau de remise de fonds (lot PP). */}
      <PieceAction
        cle={`RF:${view.id}`}
        annulee={view.status === 'CANCELLED'}
        demande={() => demandeRemiseDeFonds(view, refs, null)}
      />
      {actions}
    </li>
  );

  const cancelForm = (view: TransferView) => (
    <div className="field">
      <label htmlFor={ids.edit}>{t('cash_transfer.reason_label')}</label>
      <textarea
        id={ids.edit}
        ref={reasonRef}
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
  };

  return (
    <section className="sale">
      <PageHeader title={t('nav.screens.cash_transfers')} />
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
                  <TransferReceiveForm
                    sentXaf={view.amountSentXaf}
                    busy={busy}
                    onSubmit={(received, comment) => void receive(view, received, comment)}
                    onClose={closeEdit}
                  />
                ) : (
                  <button
                    type="button"
                    className="secondary"
                    ref={(element) => {
                      openers.current.set(`receive:${view.id}`, element);
                    }}
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
                    ref={(element) => {
                      openers.current.set(`cancel:${view.id}`, element);
                    }}
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
              {balance?.kind === 'SHOWN'
                ? t('cash_transfer.balance', { amount: formatMoney(balance.xaf) })
                : balance?.kind === 'BLIND'
                  ? t('cash_transfer.balance_blind')
                  : t('cash_transfer.balance_unknown')}
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
            <ActionBar>
              <Button
                size="lg"
                className="submit-sale"
                disabled={!target || !amountValid}
                loading={busy}
                onClick={() => void send()}
              >
                {busy ? t('sales.submitting') : t('cash_transfer.send_submit')}
              </Button>
            </ActionBar>
          </>
        )}
      </section>
    </section>
  );
}
