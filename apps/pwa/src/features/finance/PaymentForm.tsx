/**
 * Saisie d'un paiement fournisseur (ECR-FIN-04, P8E-06 ; ADR-043 §6, ADR-047 §4 ; Finance, en ligne) :
 * fournisseur (actif, ou inactif à qui l'on doit encore), factures payables lues dans ses dettes
 * (`GET /payables?supplier_id=`), paiements encore en attente de la Direction pour ce fournisseur et
 * leurs affectations prévues, montant, moyen, compte compatible, référence exigée par le moyen,
 * affectations par facture (« répartir » selon les échéances, net des montants prévus), commentaire.
 * Aperçu par la règle partagée : avance (reste non affecté, AV-275), validation de la Direction
 * au-delà du seuil (rien n'est décaissé avant, BR-FIN-033), caisse insuffisante signalée ; tous
 * indicatifs (seuil et avance non servis à l'appareil), le serveur tranche. Un paiement envoyé sans
 * réponse est repris au retour sur l'écran et bloque la saisie suivante (pas de double décaissement).
 * Hors ligne, le brouillon reste à l'écran, l'envoi attend le réseau.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActionBar,
  Banner,
  Button,
  Card,
  Field,
  Input,
  Select,
  Textarea,
} from '../../components/ui/index.js';
import { clock, idGenerator } from '../../platform/composition.js';
import type { OutboxCommand } from '../../storage/db.js';
import { formatBusinessDate } from '../home/format-home.js';
import type { SupplierView } from '../procurement/suppliers.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatMoney } from '../sales/format.js';
import { readPath, useOnlineRead } from '../sales/online-read.js';
import { useSalesReferences } from '../sales/references.js';
import { parseXaf } from '../sales/sale-form.js';
import {
  isBlockingWait,
  lastWaitingCommand,
  phaseOf,
  saveErrorKey,
  submitCommand,
  useOutboxCommand,
} from '../sales/submit.js';
import type { CashAccountItem } from '../treasury/treasury.js';
import './finance.css';
import type { PayablesResponse } from './supplier-invoice.js';
import { pendingPaymentsPath, readPending } from './pending-payments.js';
import {
  accountsForMethod,
  allocationsOnInvoices,
  autoAllocation,
  EMPTY_PAYMENT_DRAFT,
  MAX_PAYMENT_COMMENT,
  MAX_PAYMENT_REFERENCE,
  netOfPlanned,
  payableInvoices,
  paymentIssues,
  paymentMethodsFor,
  paymentPreview,
  paymentRecordPayload,
  paymentSettings,
  pendingSummary,
  plannedByInvoice,
  type PaymentDraft,
} from './supplier-payment.js';

const RECORD = 'finance.supplier_payment.record';

export function PaymentForm({
  userId,
  suppliers,
  accounts,
  accountsLoaded,
  online,
  family,
  reloadKey,
}: {
  readonly userId: string;
  readonly suppliers: readonly SupplierView[];
  readonly accounts: readonly CashAccountItem[];
  /** Comptes lus : avant, aucun « pas de compte » n'est annoncé (l'écran annonce un échec). */
  readonly accountsLoaded: boolean;
  readonly online: boolean;
  /** Opérations sur les paiements de l'outbox (reprise d'un enregistrement sans réponse). */
  readonly family: readonly OutboxCommand[];
  /** Réponses des opérations sur les paiements (écran) : dettes et attentes relues. */
  readonly reloadKey: string;
}) {
  const { t } = useTranslation();
  const refs = useSalesReferences();
  const [draft, setDraft] = useState<PaymentDraft>(EMPTY_PAYMENT_DRAFT);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<string>();
  const submittedCommand = useOutboxCommand(submitted);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const supplierRef = useRef<HTMLSelectElement>(null);
  const focusNext = useRef<'title' | 'supplier' | null>(null);
  // Focus demandé par une action, posé quand son élément est rendu (voir `InvoiceForm`).
  useEffect(() => {
    const target = focusNext.current;
    const element =
      target === 'title' ? titleRef.current : target === 'supplier' ? supplierRef.current : null;
    if (!element) return;
    focusNext.current = null;
    element.focus();
  });
  const supplierId = draft.supplierId;
  const payables = useOnlineRead(
    supplierId ? `/api/v1/payables?supplier_id=${supplierId}` : null,
    (key) => readPath<PayablesResponse>(key),
    online,
    reloadKey,
  );
  const pending = useOnlineRead(
    supplierId ? pendingPaymentsPath(supplierId) : null,
    readPending,
    online,
    reloadKey,
  );
  const outbox = refs?.outbox ?? family;

  // Paiement envoyé encore sans réponse (retour sur l'écran) : repris, la saisie suivante attend.
  if (!submitted) {
    const waitingRecord = lastWaitingCommand(
      family.filter(
        (command) => command.command_type === RECORD && isBlockingWait(command, outbox),
      ),
      RECORD,
      userId,
    );
    if (waitingRecord) setSubmitted(waitingRecord.command_id);
  }

  if (submitted) {
    const phase = submittedCommand ? phaseOf(submittedCommand) : 'WAITING';
    const stillWaiting = submittedCommand === undefined || isBlockingWait(submittedCommand, outbox);
    const refused = phase === 'REJECTED' || phase === 'CONFLICT';
    return (
      <section className="section" aria-labelledby="payment-new-title">
        <div className="section-head">
          <h2 id="payment-new-title" ref={titleRef} tabIndex={-1}>
            {t('supplier_payment.new_title')}
          </h2>
        </div>
        <CommandResult commandId={submitted} messages="supplier_payment.record_result">
          {stillWaiting ? null : (
            <div className="result-actions">
              {/* Refus ou conflit : la saisie est gardée pour être corrigée. */}
              {refused ? (
                <Button
                  variant="tonal"
                  size="sm"
                  onClick={() => {
                    setSubmitted(undefined);
                    focusNext.current = 'supplier';
                  }}
                >
                  {t('supplier_payment.correct')}
                </Button>
              ) : null}
              <Button
                variant={refused ? 'ghost' : 'tonal'}
                size="sm"
                onClick={() => {
                  setDraft(EMPTY_PAYMENT_DRAFT);
                  setSubmitted(undefined);
                  focusNext.current = 'supplier';
                }}
              >
                {t('supplier_payment.another')}
              </Button>
            </div>
          )}
        </CommandResult>
        <PaymentStatus commandId={submitted} />
      </section>
    );
  }

  const update = (patch: Partial<PaymentDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const settings = paymentSettings(refs?.settings ?? [], clock.now());
  const methods = paymentMethodsFor(refs?.paymentMethods ?? []);
  const method = methods.find((candidate) => candidate.code === draft.methodCode);
  const methodAccounts = accountsForMethod(method, accounts, userId);
  const accountId =
    draft.accountId && methodAccounts.some((account) => account.id === draft.accountId)
      ? draft.accountId
      : methodAccounts.length === 1
        ? methodAccounts[0]!.id
        : '';
  const account = methodAccounts.find((candidate) => candidate.id === accountId);
  const supplierPayables = payables.data?.suppliers.find(
    (entry) => entry.supplierId === supplierId,
  );
  const invoices = payableInvoices(supplierPayables?.invoices ?? []);
  const planned = plannedByInvoice(pending.data?.details ?? []);
  const waiting = pendingSummary(pending.data?.payments ?? []);
  // Une facture sortie des dettes relues (soldée, annulée) n'est plus affectée.
  const effective = {
    ...draft,
    accountId,
    allocations: payables.data
      ? allocationsOnInvoices(draft.allocations, invoices)
      : draft.allocations,
  };
  const issues = paymentIssues({ draft: effective, method, account });
  const preview = paymentPreview({
    draft: effective,
    invoices,
    account,
    thresholdXaf: settings.thresholdXaf,
    advanceAllowed: settings.advanceAllowed,
  });
  const amount = parseXaf(draft.amountText);
  const readFailed = supplierId !== '' && (payables.failed || pending.failed);
  const waitingReads = supplierId !== '' && (payables.stale || pending.stale);
  // La caisse insuffisante n'est qu'un avertissement : le seuil qui décide du décaissement immédiat
  // n'est pas servi à l'appareil (revue de P8E-06).
  const ready =
    online && issues.length === 0 && preview.planError === null && !waitingReads && !busy;
  const touched = supplierId !== '' || draft.amountText !== '';
  // Un fournisseur désactivé à qui l'on doit encore reste payable (le serveur l'accepte) : tous sont
  // proposés, les inactifs après les actifs et signalés comme tels.
  const supplierChoices = [...suppliers].sort(
    (a, b) =>
      Number(a.status !== 'ACTIVE') - Number(b.status !== 'ACTIVE') ||
      a.name.localeCompare(b.name, 'fr'),
  );

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setSaveError(null);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: RECORD,
        aggregateType: 'SUPPLIER_PAYMENT',
        aggregateId: idGenerator.newId(),
        payload: paymentRecordPayload(effective),
      });
      focusNext.current = 'title';
      setSubmitted(command.command_id);
    } catch (error) {
      setSaveError(saveErrorKey(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="section" aria-labelledby="payment-new-title">
      <div className="section-head">
        <h2 id="payment-new-title" ref={titleRef} tabIndex={-1}>
          {t('supplier_payment.new_title')}
        </h2>
      </div>
      {online ? null : (
        <Banner tone="warn" role="status">
          {t('supplier_payment.form_offline')}
        </Banner>
      )}
      <Card padded className="fin-form">
        <Field label={t('supplier_payment.supplier_label')}>
          {(control) => (
            <select
              {...control}
              ref={supplierRef}
              className="select"
              value={supplierId}
              onChange={(event) => update({ supplierId: event.target.value, allocations: {} })}
            >
              <option value="">{t('supplier_payment.supplier_placeholder')}</option>
              {supplierChoices.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.status === 'ACTIVE'
                    ? supplier.name
                    : t('supplier_payment.supplier_inactive', { name: supplier.name })}
                </option>
              ))}
            </select>
          )}
        </Field>
        {supplierId && pending.failed ? (
          <Banner
            tone="warn"
            role="status"
            action={
              pending.denied ? undefined : (
                <Button variant="outline" size="sm" onClick={pending.retry}>
                  {t('supplier_payment.retry_pending')}
                </Button>
              )
            }
          >
            {pending.denied
              ? t('supplier_payment.form_denied')
              : t('supplier_payment.pending_failed')}
          </Banner>
        ) : waiting.count > 0 ? (
          <Banner tone="warn" role="status">
            {t('supplier_payment.pending_for_supplier', {
              count: waiting.count,
              total: formatMoney(waiting.totalXaf),
            })}
          </Banner>
        ) : null}
        <Field label={t('supplier_payment.amount_label')}>
          {(control) => (
            <Input
              {...control}
              inputMode="numeric"
              value={draft.amountText}
              onChange={(event) => update({ amountText: event.target.value })}
            />
          )}
        </Field>
        <div className="fin-fields">
          <Field label={t('supplier_payment.method_label')}>
            {(control) => (
              <Select
                {...control}
                value={draft.methodCode}
                onChange={(event) => update({ methodCode: event.target.value, accountId: '' })}
              >
                <option value="">{t('supplier_payment.method_placeholder')}</option>
                {methods.map((candidate) => (
                  <option key={candidate.code} value={candidate.code}>
                    {candidate.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label={t('supplier_payment.account_label')}
            hint={
              method && methodAccounts.length === 0 && accountsLoaded
                ? t('supplier_payment.no_account')
                : account?.accountType === 'CAISSE_PDV'
                  ? t('supplier_payment.pos_session_note')
                  : undefined
            }
          >
            {(control) => (
              <Select
                {...control}
                value={accountId}
                disabled={!method}
                onChange={(event) => update({ accountId: event.target.value })}
              >
                <option value="">{t('supplier_payment.account_placeholder')}</option>
                {methodAccounts.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {t('supplier_payment.account_option', {
                      name: candidate.name,
                      balance: formatMoney(candidate.balanceXaf),
                    })}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field
          label={
            method?.requires_reference
              ? t('supplier_payment.reference_required')
              : t('supplier_payment.reference_label')
          }
        >
          {(control) => (
            <Input
              {...control}
              maxLength={MAX_PAYMENT_REFERENCE}
              value={draft.reference}
              onChange={(event) => update({ reference: event.target.value })}
            />
          )}
        </Field>
        {supplierId ? (
          <fieldset className="field fin-lines">
            <legend>{t('supplier_payment.allocations_legend')}</legend>
            {payables.failed ? (
              <Banner
                tone="warn"
                role="status"
                action={
                  payables.denied ? undefined : (
                    <Button variant="outline" size="sm" onClick={payables.retry}>
                      {t('supplier_payment.retry_payables')}
                    </Button>
                  )
                }
              >
                {payables.denied
                  ? t('supplier_payment.form_denied')
                  : t('supplier_payment.payables_failed')}
              </Banner>
            ) : !payables.data ? (
              <p className="home-muted">{t('sales.loading')}</p>
            ) : invoices.length === 0 ? (
              <p className="home-muted">{t('supplier_payment.no_invoice')}</p>
            ) : (
              <>
                <Button
                  variant="tonal"
                  size="sm"
                  disabled={amount === null || amount <= 0}
                  onClick={() =>
                    update({
                      allocations: autoAllocation(netOfPlanned(invoices, planned), amount ?? 0),
                    })
                  }
                >
                  {t('supplier_payment.spread')}
                </Button>
                <ul className="line-list">
                  {invoices.map((invoice) => {
                    const plannedHere = planned[invoice.invoiceId];
                    return (
                      <li
                        key={invoice.invoiceId}
                        className="line-card"
                        aria-label={invoice.docNumber}
                      >
                        <Field
                          label={t('supplier_payment.allocation_label', {
                            doc: invoice.docNumber,
                            ref: invoice.supplierInvoiceRef,
                            balance: formatMoney(invoice.balanceXaf),
                            due: formatBusinessDate(invoice.dueDate),
                          })}
                          hint={
                            invoice.overdue || plannedHere ? (
                              <>
                                {invoice.overdue ? (
                                  <span className="text-warn">
                                    {t('supplier_payment.overdue', { count: invoice.daysOverdue })}
                                  </span>
                                ) : null}
                                {plannedHere ? (
                                  <span className="text-warn">
                                    {t('supplier_payment.planned_on_invoice', {
                                      amount: formatMoney(plannedHere.amountXaf),
                                      docs: plannedHere.docNumbers.join(', '),
                                    })}
                                  </span>
                                ) : null}
                              </>
                            ) : undefined
                          }
                        >
                          {(control) => (
                            <Input
                              {...control}
                              inputMode="numeric"
                              value={draft.allocations[invoice.invoiceId] ?? ''}
                              onChange={(event) =>
                                update({
                                  allocations: {
                                    ...draft.allocations,
                                    [invoice.invoiceId]: event.target.value,
                                  },
                                })
                              }
                            />
                          )}
                        </Field>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </fieldset>
        ) : null}
        <Field label={t('supplier_payment.comment_label')}>
          {(control) => (
            <Textarea
              {...control}
              rows={2}
              maxLength={MAX_PAYMENT_COMMENT}
              value={draft.comment}
              onChange={(event) => update({ comment: event.target.value })}
            />
          )}
        </Field>
      </Card>
      {preview.planError ? (
        <Banner tone="bad" role="alert">
          {t(`supplier_payment.plan_error.${preview.planError}`, {
            defaultValue: t('supplier_payment.plan_error.ALLOCATION_INVALID'),
          })}
        </Banner>
      ) : preview.unallocatedXaf !== null && preview.unallocatedXaf > 0 ? (
        <Banner tone="info" role="status">
          {t('supplier_payment.advance', { amount: formatMoney(preview.unallocatedXaf) })}
        </Banner>
      ) : null}
      {preview.needsApproval ? (
        <Banner tone="warn" role="status">
          {t('supplier_payment.needs_approval', {
            threshold: formatMoney(settings.thresholdXaf),
          })}
        </Banner>
      ) : null}
      {preview.cashInsufficient ? (
        <Banner tone="warn" role="status">
          {t('supplier_payment.cash_insufficient')}
        </Banner>
      ) : null}
      {touched
        ? issues.map((issue) => (
            <p key={issue} className="error-message">
              {t(`supplier_payment.issue.${issue}`)}
            </p>
          ))
        : null}
      {online && waitingReads && !readFailed ? (
        <p className="home-muted" role="status">
          {t('supplier_payment.reading')}
        </p>
      ) : null}
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
          {busy ? t('sales.submitting') : t('supplier_payment.submit')}
        </Button>
      </ActionBar>
    </section>
  );
}

/** Statut renvoyé : décaissé, ou en attente de la Direction (rien n'est décaissé avant). */
function PaymentStatus({ commandId }: { readonly commandId: string }) {
  const { t } = useTranslation();
  const command = useOutboxCommand(commandId);
  const status = command?.server_refs?.status;
  if (status !== 'RECORDED' && status !== 'PENDING_APPROVAL') return null;
  return (
    <p className="home-muted" role="status">
      {t(`supplier_payment.after.${status}`)}
    </p>
  );
}
