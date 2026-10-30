/**
 * ECR-FIN-02 « Dépenses » (UC-FIN-08 ; ADR-042, ADR-047 §2 ; AV-265 à AV-269, AV-298, AV-301).
 *
 * - Saisie, utilisable hors ligne (`finance.expense.record`, agrégat `EXPENSE` dont l'identifiant est
 *   choisi par l'appareil) : payée maintenant par une caisse, ou à payer par la Finance ; justificatif
 *   (photo du reçu) cité par la dépense ; les règles partagées annoncent avant l'envoi la validation et
 *   les motifs de revue (refus en ligne, validation a posteriori hors ligne, ADR-042 §6).
 * - « Mes dépenses » : celles du jeu `cash` et les saisies pas encore relues ; annulation en ligne
 *   d'une dépense non payée ; justificatif joint après coup à une dépense en validation qui l'attend.
 * - Suivi (`?vue=suivi`, en ligne) : pour les rôles qui lisent les dépenses des autres.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { PieceAction } from '../pieces/PieceAction.js';
import { demandeDecaissementDepense } from '../pieces/adaptateurs-finance.js';
import { useSearchParams } from 'react-router-dom';
import { holdsAnyRole, ROLE_SETS, ROUTES } from '../../app/screens.js';
import {
  ActionBar,
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  LinkButton,
  PageHeader,
  Segmented,
  Select,
  SkeletonRows,
  Textarea,
} from '../../components/ui/index.js';
import { clock, idGenerator } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { photoAttachment } from '../attachments/attachments.js';
import type { PreparedPhoto } from '../attachments/photo.js';
import { PhotoField } from '../attachments/PhotoField.js';
import { useOwnerPhotos } from '../attachments/attachments.js';
import { AttachPhoto, PhotoStatus } from '../attachments/PhotoViews.js';
import { useAuth } from '../auth/AuthContext.js';
import { cashPaymentBlocked, cashSessionCoverage } from '../cash/cash-session.js';
import { CashSessionPrompt } from '../cash/CashSessionPrompt.js';
import { overIndicativeBalance, transferSourceBalance } from '../cash/transfers.js';
import { formatClockTime, formatDateTime } from '../home/format-home.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatMoney } from '../sales/format.js';
import { useSalesReferences, type SalesReferences } from '../sales/references.js';
import { isBlockingWait, saveErrorKey, submitCommand, useOutboxCommand } from '../sales/submit.js';
import {
  canCancelOwnExpense,
  defaultExpenseSite,
  EMPTY_EXPENSE_DRAFT,
  expenseAccounts,
  expenseAmount,
  expenseCancelPayload,
  expenseCategoryChoices,
  expenseImputations,
  expenseIssues,
  expensePayload,
  expensePaymentState,
  expensePolicyAvailable,
  expensePreview,
  expenseSites,
  expenseThresholds,
  imputationState,
  MAX_EXPENSE_CANCEL_REASON,
  MAX_EXPENSE_DESCRIPTION,
  MAX_PAYEE_NAME,
  myExpenses,
  receiptToAttach,
  reviewStillPending,
  type ExpenseDraft,
  type ExpenseImputation,
  type ExpenseView,
} from './expense.js';
import { imputationLabel, reviewReasonsText, shortId } from './expense-format.js';
import { ExpenseFollowUp } from './ExpenseFollowUp.js';
import './finance.css';

export function ExpenseScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const navigation = useRememberedNavigation(userId);
  const [searchParams] = useSearchParams();
  const follow = searchParams.get('vue') === 'suivi';
  // Suivi : rôles qui lisent les dépenses des autres (rôles inconnus de l'appareil : proposé).
  const mayFollow = holdsAnyRole(navigation?.roles ?? [], ROLE_SETS.expenseFollow);
  const showFollow = follow && mayFollow;

  // Navigation mémorisée encore en lecture : la vue dépend des rôles.
  if (!userId || navigation === undefined) {
    return (
      <section className="sale" aria-busy="true">
        <PageHeader title={t('nav.screens.expenses')} />
        <SkeletonRows rows={3} />
      </section>
    );
  }

  return (
    <section className="sale">
      <PageHeader title={t('nav.screens.expenses')} />
      {mayFollow ? (
        <nav className="chip-row" aria-label={t('expense.views_label')}>
          <LinkButton
            to={ROUTES.expenses}
            variant={follow ? 'outline' : 'tonal'}
            size="sm"
            icon="plus"
            aria-current={follow ? undefined : 'page'}
          >
            {t('expense.entry_tab')}
          </LinkButton>
          <LinkButton
            to={`${ROUTES.expenses}?vue=suivi`}
            variant={follow ? 'tonal' : 'outline'}
            size="sm"
            icon="clipboard"
            aria-current={follow ? 'page' : undefined}
          >
            {t('expense.follow_tab')}
          </LinkButton>
        </nav>
      ) : null}
      {/* La saisie reste montée, masquée, pendant le suivi : le brouillon et la photo ne se perdent pas
          en changeant de vue (revue de P8E-10). */}
      <div hidden={showFollow}>
        <ExpenseEntry userId={userId} />
      </div>
      {showFollow ? <ExpenseFollowUp userId={userId} /> : null}
    </section>
  );
}

/** Dépense dont l'argent est sorti (payée tout de suite, ou payée ensuite). */
const PAID_STATUSES = new Set(['PAID', 'PAID_PENDING_APPROVAL', 'PAID_REJECTED']);

function ExpenseEntry({ userId }: { readonly userId: string }) {
  const { t } = useTranslation();
  const refs = useSalesReferences();
  const online = useOnline();
  const [draft, setDraft] = useState<ExpenseDraft>(EMPTY_EXPENSE_DRAFT);
  const [photo, setPhoto] = useState<PreparedPhoto | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [submitted, setSubmitted] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  if (!refs) {
    return <SkeletonRows rows={3} />;
  }

  const reset = () => {
    setDraft(EMPTY_EXPENSE_DRAFT);
    setPhoto(null);
    setSubmitted(undefined);
    setSaveError(null);
  };

  if (submitted) {
    return (
      <>
        <CommandResult commandId={submitted} messages="expense.result">
          <Button variant="tonal" size="sm" onClick={reset}>
            {t('expense.another')}
          </Button>
        </CommandResult>
        <StatusAfterRecord commandId={submitted} />
        <MyExpenses refs={refs} userId={userId} online={online} />
      </>
    );
  }

  const update = (patch: Partial<ExpenseDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const now = clock.now();
  const thresholds = expenseThresholds(refs.settings, now);
  const accounts = expenseAccounts(refs.cashAccounts, userId);
  // Aucune caisse servie à l'appareil : la dépense est à payer par la Finance.
  const paidNow = draft.paidNow && accounts.length > 0;
  const accountId = draft.accountId || (accounts.length === 1 ? accounts[0]!.id : '');
  const account = paidNow ? accounts.find((candidate) => candidate.id === accountId) : undefined;
  const paidFromPos = account?.account_type === 'CAISSE_PDV';
  const categories = expenseCategoryChoices(refs.expenseCategories, paidFromPos);
  const category = categories.find((candidate) => candidate.id === draft.categoryId);
  const sites = expenseSites({
    assignments: refs.roleAssignments,
    userId,
    sites: refs.sites,
    zones: refs.zones,
    now,
  });
  const siteId =
    draft.siteId && sites.some((site) => site.id === draft.siteId)
      ? draft.siteId
      : defaultExpenseSite(sites, account);
  const site = sites.find((candidate) => candidate.id === siteId);
  const imputations = expenseImputations({
    site,
    lots: refs.productionLots,
    batches: refs.incubationBatches,
  });
  const imputation =
    imputations.find((option) => option.key === draft.imputationKey) ?? imputations[0];
  const amount = expenseAmount(draft.amountText);
  const amountIssue = draft.amountText.trim() !== '' && (amount === null || amount <= 0);
  const issues = expenseIssues({
    category,
    amountXaf: amount,
    description: draft.description,
    siteId,
    paidNow,
    account,
  });
  const preview =
    category && amount !== null && amount > 0
      ? expensePreview({
          category,
          amountXaf: amount,
          paidNow,
          paidFromPos,
          thresholds,
          hasPhoto: photo !== null,
          costObject: imputation ? imputationState(imputation) : 'NONE',
          policyAvailable: expensePolicyAvailable(refs.controlPolicies, now),
        })
      : null;
  // En ligne, le serveur refuserait une dépense non conforme : l'envoi est bloqué ici (ADR-042 §6).
  const reviewBlocks = online && preview !== null && preview.reasons.length > 0;
  const coverage =
    paidFromPos && account
      ? cashSessionCoverage({
          atPointOfSale: true,
          accounts: refs.cashAccounts,
          sessions: refs.cashSessions,
          outbox: refs.outbox,
          cashPulledAt: refs.cashPulledAt,
          siteId: account.site_id,
          userId,
        })
      : 'NONE';
  const sessionBlocks = cashPaymentBlocked(coverage, online);
  const balance = account
    ? transferSourceBalance({
        account,
        userId,
        now,
        sessions: refs.cashSessions,
        outbox: refs.outbox,
        cashPulledAt: refs.cashPulledAt,
        locations: refs.locations,
        paymentMethods: refs.paymentMethods,
        siteTypes: new Map([...refs.sites.values()].map((entry) => [entry.id, entry.site_type])),
        transfers: refs.cashTransfers,
        settings: refs.settings,
      })
    : null;
  const over =
    account !== undefined &&
    amount !== null &&
    amount > 0 &&
    balance?.kind === 'SHOWN' &&
    overIndicativeBalance(account, balance.xaf, amount);
  const touched =
    draft.categoryId !== '' || draft.amountText !== '' || draft.description.trim() !== '';
  const ready =
    issues.length === 0 &&
    imputation !== undefined &&
    !reviewBlocks &&
    !sessionBlocks &&
    !preparing &&
    !busy;

  const submit = async () => {
    if (!ready || !category || amount === null || !imputation) return;
    setBusy(true);
    setSaveError(null);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: 'finance.expense.record',
        aggregateType: 'EXPENSE',
        aggregateId: idGenerator.newId(),
        // Justificatif cité par la dépense (ADR-047 §3) : exigé au-delà du seuil.
        ...(photo
          ? {
              attachments: [
                photoAttachment(photo, { kind: 'RECEIPT', ownerType: 'EXPENSE', cited: true }),
              ],
            }
          : {}),
        payload: expensePayload({
          categoryId: category.id,
          amountXaf: amount,
          description: draft.description,
          payeeName: draft.payeeName,
          supplierId: draft.supplierId,
          siteId,
          imputation,
          paidNow,
          accountId,
        }),
      });
      setSubmitted(command.command_id);
    } catch (error) {
      setSaveError(saveErrorKey(error));
    } finally {
      setBusy(false);
    }
  };

  const imputationText = (option: ExpenseImputation) => {
    switch (option.kind) {
      case 'OVERHEAD':
        return t(`expense.imputation.OVERHEAD_${option.speciesGroup}`);
      case 'PRODUCTION_LOT':
      case 'INCUBATION_BATCH':
        return t(`expense.imputation.${option.kind}`, { code: option.code });
      default:
        return t(`expense.imputation.${option.kind}`);
    }
  };

  return (
    <>
      {!online ? (
        <Banner tone="warn" role="status">
          {t('expense.offline_banner')}
        </Banner>
      ) : null}
      <section className="section" aria-labelledby="expense-new-title">
        <div className="section-head">
          <h2 id="expense-new-title">{t('expense.new_title')}</h2>
        </div>
        <Card padded className="fin-form">
          {accounts.length === 0 ? (
            <p className="home-muted">{t('expense.no_account')}</p>
          ) : (
            <div className="field">
              <span className="field-label" aria-hidden="true">
                {t('expense.payment_legend')}
              </span>
              <Segmented
                label={t('expense.payment_legend')}
                name="expense-payment"
                value={paidNow ? 'now' : 'later'}
                options={[
                  { value: 'now', label: t('expense.paid_now') },
                  { value: 'later', label: t('expense.to_pay') },
                ]}
                onChange={(value) => update({ paidNow: value === 'now' })}
              />
            </div>
          )}
          {paidNow ? (
            accounts.length > 1 ? (
              <Field label={t('expense.account_label')}>
                {(control) => (
                  <Select
                    {...control}
                    value={accountId}
                    onChange={(event) => update({ accountId: event.target.value })}
                  >
                    <option value="">{t('expense.account_placeholder')}</option>
                    {accounts.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ) : (
              <div className="field">
                <span className="field-label">{t('expense.account_label')}</span>
                <p className="picked-title">{account?.name}</p>
              </div>
            )
          ) : null}
          {account ? (
            <p className="home-muted">
              {balance?.kind === 'SHOWN'
                ? t('expense.balance', { amount: formatMoney(balance.xaf) })
                : balance?.kind === 'BLIND'
                  ? t('expense.balance_blind')
                  : t('expense.balance_unknown')}
            </p>
          ) : null}
          {paidFromPos && (coverage === 'MISSING' || coverage === 'UNKNOWN') ? (
            <CashSessionPrompt
              coverage={coverage}
              online={online}
              userId={userId}
              subject="expense"
            />
          ) : null}
          {categories.length === 0 ? (
            <p className="home-muted">{t('expense.no_category')}</p>
          ) : (
            <Field label={t('expense.category_label')}>
              {(control) => (
                <Select
                  {...control}
                  value={category?.id ?? ''}
                  onChange={(event) => update({ categoryId: event.target.value })}
                >
                  <option value="">{t('expense.category_placeholder')}</option>
                  {categories.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <Field
            label={t('expense.amount_label')}
            error={amountIssue ? t('expense.issue.AMOUNT') : undefined}
            hint={
              !amountIssue && over ? (
                <span className="text-warn" role="status">
                  {t('expense.over_balance')}
                </span>
              ) : undefined
            }
          >
            {(control) => (
              <Input
                {...control}
                inputMode="numeric"
                autoComplete="off"
                value={draft.amountText}
                onChange={(event) => update({ amountText: event.target.value })}
              />
            )}
          </Field>
          <Field label={t('expense.description_label')}>
            {(control) => (
              <Textarea
                {...control}
                rows={2}
                maxLength={MAX_EXPENSE_DESCRIPTION}
                value={draft.description}
                onChange={(event) => update({ description: event.target.value })}
              />
            )}
          </Field>
          <PhotoField
            label={t('expense.photo_label')}
            hint={t('expense.photo_hint', { threshold: formatMoney(thresholds.photoXaf) })}
            value={photo}
            onChange={setPhoto}
            onBusyChange={setPreparing}
          />
          {sites.length > 1 ? (
            <Field label={t('expense.site_label')}>
              {(control) => (
                <Select
                  {...control}
                  value={siteId}
                  onChange={(event) => update({ siteId: event.target.value, imputationKey: '' })}
                >
                  <option value="">{t('expense.site_placeholder')}</option>
                  {sites.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : site ? (
            <p className="home-muted">{t('expense.site_fixed', { name: site.name })}</p>
          ) : (
            <p className="home-muted">{t('expense.no_site')}</p>
          )}
          {imputations.length > 0 && imputation ? (
            <Field label={t('expense.imputation_label')}>
              {(control) => (
                <Select
                  {...control}
                  value={imputation.key}
                  onChange={(event) => update({ imputationKey: event.target.value })}
                >
                  {imputations.map((option) => (
                    <option key={option.key} value={option.key}>
                      {imputationText(option)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
          <Field label={t('expense.payee_label')}>
            {(control) => (
              <Input
                {...control}
                maxLength={MAX_PAYEE_NAME}
                value={draft.payeeName}
                onChange={(event) => update({ payeeName: event.target.value })}
              />
            )}
          </Field>
          {refs.suppliers.size > 0 ? (
            <Field label={t('expense.supplier_label')}>
              {(control) => (
                <Select
                  {...control}
                  value={draft.supplierId}
                  onChange={(event) => update({ supplierId: event.target.value })}
                >
                  <option value="">{t('expense.supplier_none')}</option>
                  {[...refs.suppliers.values()]
                    .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
                    .map((supplier) => (
                      <option key={supplier.id} value={supplier.id}>
                        {supplier.name}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
          ) : null}
        </Card>
        {preview && preview.reasons.length > 0 ? (
          online ? (
            <Banner tone="bad" role="alert">
              {t('expense.review_online', {
                reasons: reviewReasonsText(t, preview.reasons, {
                  cap: formatMoney(thresholds.posCapXaf),
                }),
              })}
            </Banner>
          ) : (
            <Banner tone="warn" role="status">
              {t(
                reviewStillPending(preview.status)
                  ? 'expense.review_offline'
                  : 'expense.review_offline_flagged',
                {
                  reasons: reviewReasonsText(t, preview.reasons, {
                    cap: formatMoney(thresholds.posCapXaf),
                  }),
                },
              )}
            </Banner>
          )
        ) : preview &&
          (preview.status === 'PENDING_APPROVAL' || preview.status === 'PAID_PENDING_APPROVAL') ? (
          <Banner tone="info" role="status">
            {t('expense.approval_announce', { threshold: formatMoney(thresholds.approvalXaf) })}
          </Banner>
        ) : null}
        {touched
          ? issues
              // Montant illisible : son message est sous le champ ; vide, il rejoint la liste.
              .filter((issue) => issue !== 'AMOUNT' || draft.amountText.trim() === '')
              .map((issue) => (
                <p key={issue} className="error-message">
                  {t(issue === 'AMOUNT' ? 'expense.issue.AMOUNT_EMPTY' : `expense.issue.${issue}`)}
                </p>
              ))
          : null}
        {saveError ? (
          <Banner tone="bad" role="alert">
            {t(saveError)}
          </Banner>
        ) : null}
        <ActionBar>
          <Button
            size="lg"
            className="submit-sale"
            disabled={!ready}
            loading={busy}
            onClick={() => void submit()}
          >
            {busy ? t('sales.submitting') : t('expense.submit')}
          </Button>
        </ActionBar>
      </section>
      <MyExpenses refs={refs} userId={userId} online={online} />
    </>
  );
}

/** Statut annoncé par le serveur à l'acceptation : en attente de validation. */
function StatusAfterRecord({ commandId }: { readonly commandId: string }) {
  const { t } = useTranslation();
  const command = useOutboxCommand(commandId);
  const status = command?.server_refs?.status;
  if (status !== 'PENDING_APPROVAL' && status !== 'PAID_PENDING_APPROVAL') return null;
  return (
    <p className="home-muted" role="status">
      {t(`expense.after.${status}`)}
    </p>
  );
}

function MyExpenses({
  refs,
  userId,
  online,
}: {
  readonly refs: SalesReferences;
  readonly userId: string;
  readonly online: boolean;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [last, setLast] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const openers = useRef(new Map<string, HTMLButtonElement | null>());
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const lastOpened = useRef<string | null>(null);
  // Focus porté sur le motif d'une annulation ouverte, rendu au bouton qui l'a ouverte à la fermeture
  // (au titre de la liste si la dépense n'est plus annulable).
  useEffect(() => {
    if (editing) {
      lastOpened.current = editing;
      reasonRef.current?.focus();
    } else if (lastOpened.current) {
      const opener = openers.current.get(lastOpened.current);
      if (opener?.isConnected) opener.focus();
      else document.getElementById('expense-mine-title')?.focus();
      lastOpened.current = null;
    }
  }, [editing]);

  const views = myExpenses({
    expenses: refs.expenses,
    outbox: refs.outbox,
    cashPulledAt: refs.cashPulledAt,
    approvalRequests: refs.approvalRequests,
    userId,
    servedOwner: refs.dataUserId,
  });
  const categoryOf = (id: string) =>
    refs.expenseCategories.find((category) => category.id === id)?.label ?? shortId(id);
  const accountOf = (id: string) =>
    refs.cashAccounts.find((account) => account.id === id)?.name ?? t('expense.other_account');
  const siteOf = (id: string) => refs.sites.get(id)?.name ?? shortId(id);
  const labelOf = (view: ExpenseView) =>
    view.docNumber ??
    t('expense.pending_label', {
      amount: formatMoney(view.amountXaf),
      time: formatClockTime(view.occurredAt),
    });
  // Annulation en ligne : une autre opération de l'utilisateur sur les dépenses attend sa réponse.
  const waiting = refs.outbox.some(
    (command) =>
      command.command_type === 'finance.expense.cancel' &&
      command.author_user_id === userId &&
      isBlockingWait(command, refs.outbox),
  );

  const close = () => {
    setEditing(null);
    setReason('');
  };

  const cancel = async (view: ExpenseView) => {
    if (!online || busy || reason.trim() === '' || !canCancelOwnExpense(view)) return;
    setBusy(true);
    setSaveError(null);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: 'finance.expense.cancel',
        aggregateType: 'EXPENSE',
        aggregateId: view.id,
        payload: expenseCancelPayload(reason),
      });
      setLast(command.command_id);
      close();
    } catch (error) {
      setSaveError(saveErrorKey(error));
    } finally {
      setBusy(false);
    }
  };

  const paymentText = (view: ExpenseView) => {
    const state = expensePaymentState(view);
    if (state === null) return '';
    const text =
      state === 'PAID_FROM'
        ? t('expense.paid_from', { account: accountOf(view.paidFromAccountId ?? '') })
        : t(state === 'TO_PAY' ? 'expense.not_paid' : 'expense.to_pay_after_approval');
    return `${text} · `;
  };

  const stateText = (view: ExpenseView) => {
    if (view.cancelling) return t(`expense.cancelling_${view.cancelling}`);
    if (view.status === null) {
      return t(view.recordWaiting ? 'expense.state_waiting' : 'expense.state_unpulled');
    }
    return t(`expense.status.${view.status}`, { defaultValue: view.status });
  };

  const card = (view: ExpenseView, actions: ReactNode) => (
    <li key={view.id} className="line-card fin-card" aria-label={labelOf(view)}>
      <div className="fin-card-head">
        <strong>{labelOf(view)}</strong>
        <strong className="fin-amount">{formatMoney(view.amountXaf)}</strong>
      </div>
      <p className="home-muted">
        {categoryOf(view.categoryId)} · {formatDateTime(view.occurredAt)} · {siteOf(view.siteId)}
      </p>
      <p>
        {view.description}
        {view.payeeName ? ` · ${t('expense.payee', { name: view.payeeName })}` : ''}
      </p>
      <p className="home-muted">
        {paymentText(view)}
        {imputationLabel(
          t,
          { type: view.costObjectType, id: view.costObjectId, speciesGroup: view.speciesGroup },
          refs.productionLots,
          refs.incubationBatches,
        )}
      </p>
      <p>
        <span className={`fin-status ${expenseStateTone(view)}`}>{stateText(view)}</span>
      </p>
      {view.reviewReasons.length > 0 ? (
        <p className={reviewStillPending(view.status) ? 'text-warn' : 'home-muted'}>
          {t(
            reviewStillPending(view.status)
              ? 'expense.review_reasons'
              : 'expense.review_reasons_past',
            {
              // Plafond du PDV en vigueur à la date de la dépense.
              reasons: reviewReasonsText(t, view.reviewReasons, {
                cap: formatMoney(
                  expenseThresholds(refs.settings, new Date(view.occurredAt)).posCapXaf,
                ),
              }),
            },
          )}
        </p>
      ) : null}
      {view.rejectionComment ? (
        <p className="home-muted">{t('expense.rejection', { comment: view.rejectionComment })}</p>
      ) : null}
      {view.cancelReason ? (
        <p className="home-muted">{t('expense.cancel_reason', { reason: view.cancelReason })}</p>
      ) : null}
      <ReceiptBlock
        view={view}
        userId={userId}
        label={t('expense.attach_receipt', { label: labelOf(view) })}
      />
      {/* Bon de décaissement (lot PP) : la dépense dans la mise en page de la pièce de caisse,
          seulement une fois payée (une dépense à payer n'a encore rien décaissé). */}
      {view.paidNow || PAID_STATUSES.has(view.status ?? '') ? (
        <PieceAction
          cle={`BD:${view.id}`}
          annulee={view.status === 'CANCELLED'}
          demande={() =>
            demandeDecaissementDepense(
              view,
              refs,
              userId,
              imputationLabel(
                t,
                {
                  type: view.costObjectType,
                  id: view.costObjectId,
                  speciesGroup: view.speciesGroup,
                },
                refs.productionLots,
                refs.incubationBatches,
              ) || null,
            )
          }
        />
      ) : null}
      {actions}
    </li>
  );

  const cancelAction = (view: ExpenseView) => {
    if (!canCancelOwnExpense(view)) return null;
    if (!online) return <p className="home-muted">{t('expense.cancel_online_only')}</p>;
    if (editing === view.id) {
      return (
        <div className="fin-decision">
          <Field label={t('expense.cancel_reason_label')}>
            {(control) => (
              <textarea
                {...control}
                ref={reasonRef}
                className="textarea"
                rows={2}
                maxLength={MAX_EXPENSE_CANCEL_REASON}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            )}
          </Field>
          <div className="result-actions">
            <Button
              disabled={busy || waiting || reason.trim() === ''}
              onClick={() => void cancel(view)}
            >
              {t('expense.cancel_submit')}
            </Button>
            <Button variant="ghost" onClick={close}>
              {t('expense.close_form')}
            </Button>
          </div>
        </div>
      );
    }
    return (
      <div className="result-actions">
        <Button
          variant="outline"
          size="sm"
          ref={(element) => {
            openers.current.set(view.id, element);
          }}
          disabled={busy || waiting}
          onClick={() => {
            setEditing(view.id);
            setReason('');
          }}
        >
          {t('expense.cancel_open', { label: labelOf(view) })}
        </Button>
      </div>
    );
  };

  return (
    <section className="section" aria-labelledby="expense-mine-title">
      <div className="section-head">
        <h2 id="expense-mine-title" tabIndex={-1}>
          {t('expense.mine_title')}
        </h2>
      </div>
      {last ? <CommandResult commandId={last} messages="expense.cancel_result" /> : null}
      {saveError ? (
        <Banner tone="bad" role="alert">
          {t(saveError)}
        </Banner>
      ) : null}
      {views.length === 0 ? (
        <EmptyState icon="receipt" title={t('expense.mine_empty')} />
      ) : (
        <ul className="line-list">{views.map((view) => card(view, cancelAction(view)))}</ul>
      )}
    </section>
  );
}

/** Ton de la situation d'une de ses dépenses : le refus alerte, l'attente avertit, le payé rassure. */
function expenseStateTone(view: ExpenseView): string {
  if (view.cancelling || view.status === null) return 'is-info';
  switch (view.status) {
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

/**
 * Justificatif d'une de ses dépenses : à joindre (dépense en validation qui l'attend) ou à remplacer
 * (photo refusée par le serveur), sinon l'état de ses photos (revue de P8E-03).
 */
function ReceiptBlock({
  view,
  userId,
  label,
}: {
  readonly view: ExpenseView;
  readonly userId: string;
  readonly label: string;
}) {
  const photos = useOwnerPhotos(view.id, userId);
  if (photos === undefined) return null;
  const refused = photos.some((photo) => photo.state === 'REFUSED');
  if (!receiptToAttach(view, refused)) return <PhotoStatus ownerId={view.id} userId={userId} />;
  return (
    <AttachPhoto
      userId={userId}
      target={{ kind: 'RECEIPT', ownerType: 'EXPENSE', cited: false, ownerId: view.id }}
      label={label}
    />
  );
}
