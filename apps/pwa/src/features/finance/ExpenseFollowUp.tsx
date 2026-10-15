/**
 * Suivi des dépenses (ECR-FIN-02, vue en ligne ; ADR-047 §2, AV-298) : dépenses que l'utilisateur lit
 * (`GET /expenses`, `finance.expense.read` dans sa portée), par groupe de statuts ; payer une dépense
 * à payer (`finance.expense.pay`, Finance), annuler une dépense non payée (`finance.expense.cancel` :
 * l'auteur, ou un approbateur) ; justificatif lu sur le serveur. La décision d'une dépense en
 * validation se prend dans la file des validations (ECR-ADM-08).
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { holdsAnyRole, ROLE_SETS, ROUTES } from '../../app/screens.js';
import { clock } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { getDb } from '../../storage/db.js';
import { ServerPhoto } from '../attachments/PhotoViews.js';
import { formatDateTime } from '../home/format-home.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatMoney } from '../sales/format.js';
import {
  readPages,
  readPath,
  useOnlineRead,
  useRefreshOnVisible,
  type ReadResult,
} from '../sales/online-read.js';
import { useSalesReferences } from '../sales/references.js';
import {
  isBlockingWait,
  lastWaitingCommand,
  phaseOf,
  saveErrorKey,
  submitCommand,
  waitingIds,
} from '../sales/submit.js';
import type { CashAccountItem, CashAccountsResponse } from '../treasury/treasury.js';
import {
  expenseCancelPayload,
  expensePaymentState,
  expenseThresholds,
  MAX_EXPENSE_CANCEL_REASON,
  reviewStillPending,
} from './expense.js';
import {
  EXPENSE_FOLLOW_CLOSED_DAYS,
  EXPENSE_FOLLOW_GROUP_ORDER,
  EXPENSE_FOLLOW_MAX_PAGES,
  expenseFollowPaths,
  expensePayAccounts,
  expensePayPayload,
  isExpensePayable,
  mayCancelExpense,
  sortExpenses,
  type ExpenseFollowGroup,
  type ExpenseItem,
} from './expense-follow.js';
import { imputationLabel, reviewReasonsText, shortId, userName } from './expense-format.js';

type Kind = 'pay' | 'cancel';

const MANAGED_COMMANDS = new Set(['finance.expense.pay', 'finance.expense.cancel']);

interface FollowRead {
  readonly items: readonly ExpenseItem[];
  readonly more: boolean;
  /**
   * Comptes d'où payer (Finance, groupe « à payer ») ; `null` si leur lecture a échoué (le paiement
   * attend une relecture), vide sans droit de les lire.
   */
  readonly accounts: readonly CashAccountItem[] | null;
}

async function readFollow(
  group: ExpenseFollowGroup,
  withAccounts: boolean,
): Promise<ReadResult<FollowRead>> {
  const pages = await readPages<ExpenseItem>(
    expenseFollowPaths(group, clock.now()),
    'expenses',
    EXPENSE_FOLLOW_MAX_PAGES,
  );
  if (!pages.ok) return pages;
  let accounts: readonly CashAccountItem[] | null = [];
  if (withAccounts) {
    // Refus de droit : aucun compte ; panne : comptes inconnus, distincts d'une liste vide.
    const read = await readPath<CashAccountsResponse>('/api/v1/cash-accounts');
    accounts = read.ok ? read.data.cash_accounts : read.denied ? [] : null;
  }
  return {
    ok: true,
    data: { items: sortExpenses(pages.data.items), more: pages.data.more, accounts },
  };
}

export function ExpenseFollowUp({ userId }: { readonly userId: string }) {
  const { t } = useTranslation();
  const refs = useSalesReferences();
  const online = useOnline();
  const navigation = useRememberedNavigation(userId);
  const roles = navigation?.roles ?? [];
  const mayPay = holdsAnyRole(roles, ROLE_SETS.expensePay);
  const isApprover = holdsAnyRole(roles, ROLE_SETS.expenseApprove);
  const [group, setGroup] = useState<ExpenseFollowGroup>('TO_PAY');
  const [open, setOpen] = useState<{ id: string; kind: Kind } | null>(null);
  const [accountChoice, setAccountChoice] = useState('');
  const [reason, setReason] = useState('');
  const [last, setLast] = useState<{ commandId: string; kind: Kind }>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const ids = { group: useId(), account: useId(), reason: useId() };
  const firstField = useRef<HTMLSelectElement | HTMLTextAreaElement | null>(null);
  const openers = useRef(new Map<string, HTMLButtonElement | null>());
  const lastOpened = useRef<string | null>(null);
  useEffect(() => {
    if (open) {
      lastOpened.current = `${open.kind}:${open.id}`;
      firstField.current?.focus();
    } else if (lastOpened.current) {
      openers.current.get(lastOpened.current)?.focus();
      lastOpened.current = null;
    }
  }, [open]);
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
  const reloadKey = `${last?.commandId ?? ''}:${lastCommand ? phaseOf(lastCommand) : ''}|${waitingIds(
    managed,
    'finance.expense.',
    userId,
  )}`;
  const withAccounts = mayPay && group === 'TO_PAY';
  // Lecture lancée une fois les rôles connus : les comptes ne sont lus que pour qui paie.
  const read = useOnlineRead<FollowRead>(
    online && navigation !== undefined
      ? `expenses:${group}:${withAccounts ? 'accounts' : ''}`
      : null,
    () => readFollow(group, withAccounts),
    online,
    reloadKey,
  );
  useRefreshOnVisible(read.retry);

  if (!refs) return <p className="home-muted">{t('sales.loading')}</p>;
  if (!online) return <p className="home-muted">{t('expense.follow_online_only')}</p>;

  // Retour sur l'écran avec une opération en attente : son résultat est annoncé.
  const adopt = last ? undefined : lastWaitingCommand(managed, 'finance.expense.', userId);
  if (adopt) {
    setLast({
      commandId: adopt.command_id,
      kind: adopt.command_type === 'finance.expense.pay' ? 'pay' : 'cancel',
    });
  }

  const data = read.data;
  const waiting = managed.some(
    (command) => command.author_user_id === userId && isBlockingWait(command, refs.outbox),
  );
  const blocked = busy || waiting || read.stale || !data;
  const payAccounts = expensePayAccounts(data?.accounts ?? [], userId);
  const accountsUnknown = data !== undefined && data.accounts === null;
  const accountNames = new Map<string, string>([
    ...refs.cashAccounts.map((account) => [account.id, account.name] as const),
    ...(data?.accounts ?? []).map((account) => [account.id, account.name] as const),
  ]);
  const siteOf = (id: string) => refs.sites.get(id)?.name ?? shortId(id);

  const toggle = (id: string, kind: Kind) => {
    setOpen((current) => (current?.id === id && current.kind === kind ? null : { id, kind }));
    setAccountChoice('');
    setReason('');
    setSaveError(null);
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

  const pay = (item: ExpenseItem) => {
    const accountId = accountChoice || (payAccounts.length === 1 ? payAccounts[0]!.id : '');
    if (!accountId) return;
    void send('pay', {
      authorUserId: userId,
      commandType: 'finance.expense.pay',
      aggregateType: 'EXPENSE',
      aggregateId: item.id,
      payload: expensePayPayload(accountId),
    });
  };

  const cancel = (item: ExpenseItem) => {
    if (reason.trim() === '') return;
    void send('cancel', {
      authorUserId: userId,
      commandType: 'finance.expense.cancel',
      aggregateType: 'EXPENSE',
      aggregateId: item.id,
      payload: expenseCancelPayload(reason),
    });
  };

  const closeButton = (
    <button type="button" className="secondary" onClick={() => setOpen(null)}>
      {t('expense.close_form')}
    </button>
  );

  const payForm = (item: ExpenseItem) => {
    const accountId = accountChoice || (payAccounts.length === 1 ? payAccounts[0]!.id : '');
    if (accountsUnknown) {
      return (
        <div className="field">
          <p className="home-muted">{t('expense.pay_accounts_failed')}</p>
          <div className="result-actions">
            <button type="button" className="secondary" onClick={read.retry}>
              {t('ledger.retry')}
            </button>
            {closeButton}
          </div>
        </div>
      );
    }
    return payAccounts.length === 0 ? (
      <div className="field">
        <p className="home-muted">{t('expense.pay_no_account')}</p>
        <div className="result-actions">{closeButton}</div>
      </div>
    ) : (
      <div className="field">
        <label htmlFor={ids.account}>{t('expense.pay_account_label')}</label>
        <select
          id={ids.account}
          ref={(element) => {
            firstField.current = element;
          }}
          className="text-input"
          value={accountId}
          onChange={(event) => setAccountChoice(event.target.value)}
        >
          <option value="">{t('expense.account_placeholder')}</option>
          {payAccounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </select>
        <div className="result-actions">
          <button type="button" disabled={blocked || !accountId} onClick={() => pay(item)}>
            {t('expense.pay_submit', { amount: formatMoney(item.amountXaf) })}
          </button>
          {closeButton}
        </div>
      </div>
    );
  };

  const cancelForm = (item: ExpenseItem) => (
    <div className="field">
      <label htmlFor={ids.reason}>{t('expense.cancel_reason_label')}</label>
      <textarea
        id={ids.reason}
        ref={(element) => {
          firstField.current = element;
        }}
        className="text-input"
        rows={2}
        maxLength={MAX_EXPENSE_CANCEL_REASON}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <div className="result-actions">
        <button
          type="button"
          disabled={blocked || reason.trim() === ''}
          onClick={() => cancel(item)}
        >
          {t('expense.cancel_submit')}
        </button>
        {closeButton}
      </div>
    </div>
  );

  const opener = (kind: Kind, id: string) => (element: HTMLButtonElement | null) => {
    openers.current.set(`${kind}:${id}`, element);
  };

  const card = (item: ExpenseItem) => {
    const payable = mayPay && isExpensePayable(item);
    const cancellable = mayCancelExpense(item, userId, isApprover);
    const attachments = item.attachments ?? [];
    const payment = expensePaymentState(item);
    return (
      <li key={item.id} className="line-card" aria-label={item.docNumber}>
        <p>
          <strong>{item.docNumber}</strong> · {formatMoney(item.amountXaf)}
        </p>
        <p className="home-muted">
          {item.categoryLabel} · {formatDateTime(item.occurredAt)} · {siteOf(item.siteId)}
        </p>
        <p className="home-muted">
          {t('expense.by', { name: userName(t, refs.users, item.createdBy, userId) })}
          {item.capturedOffline ? ` · ${t('expense.captured_offline')}` : ''}
        </p>
        <p>
          {item.description}
          {item.payeeName ? ` · ${t('expense.payee', { name: item.payeeName })}` : ''}
        </p>
        <p className="home-muted">
          {payment === 'PAID_FROM'
            ? `${t('expense.paid_from', {
                account:
                  accountNames.get(item.paidFromAccountId ?? '') ?? t('expense.other_account'),
              })} · `
            : payment === 'TO_PAY'
              ? `${t('expense.not_paid')} · `
              : payment === 'TO_PAY_AFTER_APPROVAL'
                ? `${t('expense.to_pay_after_approval')} · `
                : ''}
          {imputationLabel(
            t,
            {
              type: item.costObjectType,
              id: item.costObjectId,
              speciesGroup: item.speciesGroup,
            },
            refs.productionLots,
            refs.incubationBatches,
          )}
        </p>
        <p
          className={
            item.status === 'REJECTED' || item.status === 'PAID_REJECTED'
              ? 'text-warn'
              : 'home-muted'
          }
        >
          {t(`expense.status.${item.status}`, { defaultValue: item.status })}
        </p>
        {item.reviewReasons.length > 0 ? (
          <p className={reviewStillPending(item.status) ? 'text-warn' : 'home-muted'}>
            {t(
              reviewStillPending(item.status)
                ? 'expense.review_reasons'
                : 'expense.review_reasons_past',
              {
                reasons: reviewReasonsText(t, item.reviewReasons, {
                  cap: formatMoney(
                    expenseThresholds(refs.settings, new Date(item.occurredAt)).posCapXaf,
                  ),
                }),
              },
            )}
          </p>
        ) : null}
        {item.status === 'PAID_REJECTED' && item.responsibilityUserId ? (
          <p className="text-warn">
            {t('expense.charged_to', {
              name: userName(t, refs.users, item.responsibilityUserId, userId),
            })}
          </p>
        ) : null}
        {item.cancelReason ? (
          <p className="home-muted">{t('expense.cancel_reason', { reason: item.cancelReason })}</p>
        ) : null}
        {attachments.length === 0 ? (
          <p className="home-muted">{t('expense.no_receipt')}</p>
        ) : (
          // Seule une pièce reçue se lit ; en cours d'envoi ou refusée, elle est annoncée.
          attachments.map((attachment) =>
            attachment.uploadStatus === 'AVAILABLE' ? (
              <ServerPhoto
                key={attachment.id}
                attachmentId={attachment.id}
                alt={t('expense.receipt_alt', { doc: item.docNumber })}
                label={t('expense.view_receipt', { doc: item.docNumber })}
              />
            ) : (
              <p
                key={attachment.id}
                className={
                  attachment.uploadStatus === 'PENDING_UPLOAD' ? 'home-muted' : 'text-warn'
                }
              >
                {t(
                  attachment.uploadStatus === 'PENDING_UPLOAD'
                    ? 'expense.receipt_uploading'
                    : 'expense.receipt_refused',
                )}
              </p>
            ),
          )
        )}
        {/* Décision réservée aux approbateurs (`finance.expense.approve`) : la file des autres est vide. */}
        {isApprover &&
        (item.status === 'PENDING_APPROVAL' || item.status === 'PAID_PENDING_APPROVAL') ? (
          <Link to={`${ROUTES.approvals}?types=EXPENSE`} className="action action-compact">
            <span className="action-label">{t('expense.decide_link')}</span>
          </Link>
        ) : null}
        {open?.id === item.id && open.kind === 'pay' ? (
          payForm(item)
        ) : open?.id === item.id && open.kind === 'cancel' ? (
          cancelForm(item)
        ) : payable || cancellable ? (
          <div className="result-actions">
            {payable ? (
              <button
                type="button"
                ref={opener('pay', item.id)}
                disabled={blocked}
                onClick={() => toggle(item.id, 'pay')}
              >
                {t('expense.pay_open', { doc: item.docNumber })}
              </button>
            ) : null}
            {cancellable ? (
              <button
                type="button"
                className="secondary"
                ref={opener('cancel', item.id)}
                disabled={blocked}
                onClick={() => toggle(item.id, 'cancel')}
              >
                {t('expense.cancel_open', { label: item.docNumber })}
              </button>
            ) : null}
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <>
      <div className="field">
        <label htmlFor={ids.group}>{t('expense.group_label')}</label>
        <select
          id={ids.group}
          className="text-input"
          value={group}
          onChange={(event) => {
            setGroup(event.target.value as ExpenseFollowGroup);
            setOpen(null);
          }}
        >
          {EXPENSE_FOLLOW_GROUP_ORDER.map((candidate) => (
            <option key={candidate} value={candidate}>
              {t(`expense.group.${candidate}`)}
            </option>
          ))}
        </select>
        {group !== 'TO_PAY' && group !== 'TO_DECIDE' ? (
          <p className="home-muted">
            {t('expense.closed_window', { days: EXPENSE_FOLLOW_CLOSED_DAYS })}
          </p>
        ) : null}
      </div>
      {last ? (
        <CommandResult commandId={last.commandId} messages={`expense.${last.kind}_result`} />
      ) : null}
      {saveError ? (
        <p className="alert alert-error" role="alert">
          {t(saveError)}
        </p>
      ) : null}
      {read.failed ? (
        // Relecture en échec : annoncée avec « Réessayer », la liste d'avant restant affichée comme
        // périmée (ses actions restent bloquées jusqu'à une relecture).
        <div className="alert alert-error" role="alert">
          <p>
            {read.denied
              ? t('expense.follow_denied')
              : t(data ? 'expense.follow_failed_stale' : 'expense.follow_unavailable')}
          </p>
          {read.denied ? null : (
            <button type="button" className="secondary" onClick={read.retry}>
              {t('ledger.retry')}
            </button>
          )}
        </div>
      ) : null}
      {!data ? (
        read.failed ? null : (
          <p className="home-muted" aria-busy="true">
            {t('sales.loading')}
          </p>
        )
      ) : (
        <section className="sale-block" aria-label={t(`expense.group.${group}`)}>
          {read.stale && !read.failed ? (
            <p className="home-muted" role="status">
              {t('expense.refreshing')}
            </p>
          ) : null}
          {data.items.length === 0 ? (
            <p className="home-muted">{t('expense.follow_empty')}</p>
          ) : (
            <ul className="line-list">{data.items.map((item) => card(item))}</ul>
          )}
          {data.more ? <p className="home-muted">{t('expense.truncated')}</p> : null}
        </section>
      )}
    </>
  );
}
