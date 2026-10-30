/**
 * Suivi des dépenses (ECR-FIN-02, vue en ligne ; ADR-047 §2, AV-298) : dépenses que l'utilisateur lit
 * (`GET /expenses`, `finance.expense.read` dans sa portée), par groupe de statuts ; payer une dépense
 * à payer (`finance.expense.pay`, Finance), annuler une dépense non payée (`finance.expense.cancel` :
 * l'auteur, ou un approbateur) ; justificatif lu sur le serveur. La décision d'une dépense en
 * validation se prend dans la file des validations (ECR-ADM-08).
 */
import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { holdsAnyRole, ROLE_SETS, ROUTES } from '../../app/screens.js';
import {
  Banner,
  Button,
  EmptyState,
  Field,
  LinkButton,
  Select,
  SkeletonRows,
} from '../../components/ui/index.js';
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
import './finance.css';

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

/**
 * `fixedGroup` : groupe imposé, sans choix (trésorerie : « dépenses à payer », P8E-04, AV-300).
 */
export function ExpenseFollowUp({
  userId,
  fixedGroup,
}: {
  readonly userId: string;
  readonly fixedGroup?: ExpenseFollowGroup;
}) {
  const { t } = useTranslation();
  const refs = useSalesReferences();
  const online = useOnline();
  const navigation = useRememberedNavigation(userId);
  const roles = navigation?.roles ?? [];
  const mayPay = holdsAnyRole(roles, ROLE_SETS.expensePay);
  const isApprover = holdsAnyRole(roles, ROLE_SETS.expenseApprove);
  const [chosenGroup, setGroup] = useState<ExpenseFollowGroup>('TO_PAY');
  const group = fixedGroup ?? chosenGroup;
  const [open, setOpen] = useState<{ id: string; kind: Kind } | null>(null);
  const [accountChoice, setAccountChoice] = useState('');
  const [reason, setReason] = useState('');
  const [last, setLast] = useState<{ commandId: string; kind: Kind }>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
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

  if (!refs) return <SkeletonRows rows={3} />;
  if (!online) return <EmptyState icon="offline" title={t('expense.follow_online_only')} />;

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
    <Button variant="ghost" onClick={() => setOpen(null)}>
      {t('expense.close_form')}
    </Button>
  );

  const payForm = (item: ExpenseItem) => {
    const accountId = accountChoice || (payAccounts.length === 1 ? payAccounts[0]!.id : '');
    if (accountsUnknown) {
      return (
        <div className="fin-decision">
          <p className="home-muted">{t('expense.pay_accounts_failed')}</p>
          <div className="result-actions">
            <Button variant="outline" onClick={read.retry}>
              {t('ledger.retry')}
            </Button>
            {closeButton}
          </div>
        </div>
      );
    }
    return payAccounts.length === 0 ? (
      <div className="fin-decision">
        <p className="home-muted">{t('expense.pay_no_account')}</p>
        <div className="result-actions">{closeButton}</div>
      </div>
    ) : (
      <div className="fin-decision">
        <Field label={t('expense.pay_account_label')}>
          {(control) => (
            <select
              {...control}
              ref={(element) => {
                firstField.current = element;
              }}
              className="select"
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
          )}
        </Field>
        <div className="result-actions">
          <Button disabled={blocked || !accountId} onClick={() => pay(item)}>
            {t('expense.pay_submit', { amount: formatMoney(item.amountXaf) })}
          </Button>
          {closeButton}
        </div>
      </div>
    );
  };

  const cancelForm = (item: ExpenseItem) => (
    <div className="fin-decision">
      <Field label={t('expense.cancel_reason_label')}>
        {(control) => (
          <textarea
            {...control}
            ref={(element) => {
              firstField.current = element;
            }}
            className="textarea"
            rows={2}
            maxLength={MAX_EXPENSE_CANCEL_REASON}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        )}
      </Field>
      <div className="result-actions">
        <Button disabled={blocked || reason.trim() === ''} onClick={() => cancel(item)}>
          {t('expense.cancel_submit')}
        </Button>
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
      <li key={item.id} className="line-card fin-card" aria-label={item.docNumber}>
        <div className="fin-card-head">
          <strong>{item.docNumber}</strong>
          <strong className="fin-amount">{formatMoney(item.amountXaf)}</strong>
        </div>
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
        <p>
          <span className={`fin-status ${followStateTone(item.status)}`}>
            {t(`expense.status.${item.status}`, { defaultValue: item.status })}
          </span>
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
                    : attachment.uploadStatus === 'MISSING'
                      ? 'expense.receipt_missing'
                      : 'expense.receipt_refused',
                )}
              </p>
            ),
          )
        )}
        {/* Décision réservée aux approbateurs (`finance.expense.approve`) : la file des autres est vide. */}
        {isApprover &&
        (item.status === 'PENDING_APPROVAL' || item.status === 'PAID_PENDING_APPROVAL') ? (
          <div className="result-actions">
            <LinkButton
              to={`${ROUTES.approvals}?types=EXPENSE`}
              variant="tonal"
              size="sm"
              icon="check-circle"
            >
              {t('expense.decide_link')}
            </LinkButton>
          </div>
        ) : null}
        {open?.id === item.id && open.kind === 'pay' ? (
          payForm(item)
        ) : open?.id === item.id && open.kind === 'cancel' ? (
          cancelForm(item)
        ) : payable || cancellable ? (
          <div className="result-actions">
            {payable ? (
              <Button
                variant="tonal"
                size="sm"
                ref={opener('pay', item.id)}
                disabled={blocked}
                onClick={() => toggle(item.id, 'pay')}
              >
                {t('expense.pay_open', { doc: item.docNumber })}
              </Button>
            ) : null}
            {cancellable ? (
              <Button
                variant="outline"
                size="sm"
                ref={opener('cancel', item.id)}
                disabled={blocked}
                onClick={() => toggle(item.id, 'cancel')}
              >
                {t('expense.cancel_open', { label: item.docNumber })}
              </Button>
            ) : null}
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <>
      <div hidden={fixedGroup !== undefined}>
        <Field
          label={t('expense.group_label')}
          hint={
            group !== 'TO_PAY' && group !== 'TO_DECIDE'
              ? t('expense.closed_window', { days: EXPENSE_FOLLOW_CLOSED_DAYS })
              : undefined
          }
        >
          {(control) => (
            <Select
              {...control}
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
            </Select>
          )}
        </Field>
      </div>
      {last ? (
        <CommandResult commandId={last.commandId} messages={`expense.${last.kind}_result`} />
      ) : null}
      {saveError ? (
        <Banner tone="bad" role="alert">
          {t(saveError)}
        </Banner>
      ) : null}
      {read.failed ? (
        // Relecture en échec : annoncée avec « Réessayer », la liste d'avant restant affichée comme
        // périmée (ses actions restent bloquées jusqu'à une relecture).
        <Banner
          tone="bad"
          role="alert"
          action={
            read.denied ? undefined : (
              <Button variant="outline" size="sm" onClick={read.retry}>
                {t('ledger.retry')}
              </Button>
            )
          }
        >
          {read.denied
            ? t('expense.follow_denied')
            : t(data ? 'expense.follow_failed_stale' : 'expense.follow_unavailable')}
        </Banner>
      ) : null}
      {!data ? (
        read.failed ? null : (
          <SkeletonRows rows={3} />
        )
      ) : (
        <section className="section" aria-label={t(`expense.group.${group}`)}>
          {read.stale && !read.failed ? (
            <p className="home-muted" role="status">
              {t('expense.refreshing')}
            </p>
          ) : null}
          {data.items.length === 0 ? (
            <EmptyState
              icon="receipt"
              title={t(fixedGroup === 'TO_PAY' ? 'expense.none_to_pay' : 'expense.follow_empty')}
            />
          ) : (
            <ul className="line-list">{data.items.map((item) => card(item))}</ul>
          )}
          {data.more ? <p className="home-muted">{t('expense.truncated')}</p> : null}
        </section>
      )}
    </>
  );
}

/** Ton de la situation d'une dépense suivie : le refus alerte, l'attente avertit, le payé rassure. */
function followStateTone(status: string): string {
  switch (status) {
    case 'REJECTED':
    case 'PAID_REJECTED':
      return 'is-bad';
    case 'PENDING_APPROVAL':
    case 'PAID_PENDING_APPROVAL':
      return 'is-warn';
    case 'PAID':
      return 'is-ok';
    case 'CANCELLED':
      return 'is-muted';
    default:
      return 'is-info';
  }
}
