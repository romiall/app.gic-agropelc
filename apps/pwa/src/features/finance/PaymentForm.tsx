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
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const ids = {
    supplier: useId(),
    amount: useId(),
    method: useId(),
    account: useId(),
    reference: useId(),
    comment: useId(),
  };
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
    return (
      <section className="sale-block" aria-labelledby="payment-new-title">
        <h2 id="payment-new-title" ref={titleRef} tabIndex={-1}>
          {t('supplier_payment.new_title')}
        </h2>
        <CommandResult commandId={submitted} messages="supplier_payment.record_result">
          {stillWaiting ? null : (
            <div className="result-actions">
              {/* Refus ou conflit : la saisie est gardée pour être corrigée. */}
              {phase === 'REJECTED' || phase === 'CONFLICT' ? (
                <button
                  type="button"
                  onClick={() => {
                    setSubmitted(undefined);
                    focusNext.current = 'supplier';
                  }}
                >
                  {t('supplier_payment.correct')}
                </button>
              ) : null}
              <button
                type="button"
                className={phase === 'REJECTED' || phase === 'CONFLICT' ? 'secondary' : undefined}
                onClick={() => {
                  setDraft(EMPTY_PAYMENT_DRAFT);
                  setSubmitted(undefined);
                  focusNext.current = 'supplier';
                }}
              >
                {t('supplier_payment.another')}
              </button>
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
    <section className="sale-block" aria-labelledby="payment-new-title">
      <h2 id="payment-new-title" ref={titleRef} tabIndex={-1}>
        {t('supplier_payment.new_title')}
      </h2>
      {online ? null : (
        <p className="text-warn" role="status">
          {t('supplier_payment.form_offline')}
        </p>
      )}
      <div className="field">
        <label htmlFor={ids.supplier}>{t('supplier_payment.supplier_label')}</label>
        <select
          id={ids.supplier}
          ref={supplierRef}
          className="text-input"
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
        {supplierId && pending.failed ? (
          <p className="text-warn" role="status">
            {pending.denied
              ? t('supplier_payment.form_denied')
              : t('supplier_payment.pending_failed')}{' '}
            {pending.denied ? null : (
              <button type="button" className="secondary" onClick={pending.retry}>
                {t('supplier_payment.retry_pending')}
              </button>
            )}
          </p>
        ) : waiting.count > 0 ? (
          <p className="text-warn" role="status">
            {t('supplier_payment.pending_for_supplier', {
              count: waiting.count,
              total: formatMoney(waiting.totalXaf),
            })}
          </p>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor={ids.amount}>{t('supplier_payment.amount_label')}</label>
        <input
          id={ids.amount}
          className="text-input"
          inputMode="numeric"
          value={draft.amountText}
          onChange={(event) => update({ amountText: event.target.value })}
        />
      </div>
      <div className="line-fields">
        <div className="field">
          <label htmlFor={ids.method}>{t('supplier_payment.method_label')}</label>
          <select
            id={ids.method}
            className="text-input"
            value={draft.methodCode}
            onChange={(event) => update({ methodCode: event.target.value, accountId: '' })}
          >
            <option value="">{t('supplier_payment.method_placeholder')}</option>
            {methods.map((candidate) => (
              <option key={candidate.code} value={candidate.code}>
                {candidate.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.account}>{t('supplier_payment.account_label')}</label>
          <select
            id={ids.account}
            className="text-input"
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
          </select>
          {method && methodAccounts.length === 0 && accountsLoaded ? (
            <p className="home-muted">{t('supplier_payment.no_account')}</p>
          ) : null}
          {account?.accountType === 'CAISSE_PDV' ? (
            <p className="home-muted">{t('supplier_payment.pos_session_note')}</p>
          ) : null}
        </div>
      </div>
      <div className="field">
        <label htmlFor={ids.reference}>
          {method?.requires_reference
            ? t('supplier_payment.reference_required')
            : t('supplier_payment.reference_label')}
        </label>
        <input
          id={ids.reference}
          className="text-input"
          maxLength={MAX_PAYMENT_REFERENCE}
          value={draft.reference}
          onChange={(event) => update({ reference: event.target.value })}
        />
      </div>
      {supplierId ? (
        <fieldset className="field">
          <legend>{t('supplier_payment.allocations_legend')}</legend>
          {payables.failed ? (
            <p className="text-warn" role="status">
              {payables.denied
                ? t('supplier_payment.form_denied')
                : t('supplier_payment.payables_failed')}{' '}
              {payables.denied ? null : (
                <button type="button" className="secondary" onClick={payables.retry}>
                  {t('supplier_payment.retry_payables')}
                </button>
              )}
            </p>
          ) : !payables.data ? (
            <p className="home-muted">{t('sales.loading')}</p>
          ) : invoices.length === 0 ? (
            <p className="home-muted">{t('supplier_payment.no_invoice')}</p>
          ) : (
            <>
              <button
                type="button"
                className="secondary"
                disabled={amount === null || amount <= 0}
                onClick={() =>
                  update({
                    allocations: autoAllocation(netOfPlanned(invoices, planned), amount ?? 0),
                  })
                }
              >
                {t('supplier_payment.spread')}
              </button>
              <ul className="line-list">
                {invoices.map((invoice) => {
                  const plannedHere = planned[invoice.invoiceId];
                  return (
                    <li
                      key={invoice.invoiceId}
                      className="line-card"
                      aria-label={invoice.docNumber}
                    >
                      <label htmlFor={`${ids.amount}-${invoice.invoiceId}`}>
                        {t('supplier_payment.allocation_label', {
                          doc: invoice.docNumber,
                          ref: invoice.supplierInvoiceRef,
                          balance: formatMoney(invoice.balanceXaf),
                          due: formatBusinessDate(invoice.dueDate),
                        })}
                      </label>
                      {invoice.overdue ? (
                        <p className="text-warn">
                          {t('supplier_payment.overdue', { count: invoice.daysOverdue })}
                        </p>
                      ) : null}
                      {plannedHere ? (
                        <p className="text-warn">
                          {t('supplier_payment.planned_on_invoice', {
                            amount: formatMoney(plannedHere.amountXaf),
                            docs: plannedHere.docNumbers.join(', '),
                          })}
                        </p>
                      ) : null}
                      <input
                        id={`${ids.amount}-${invoice.invoiceId}`}
                        className="text-input"
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
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </fieldset>
      ) : null}
      <div className="field">
        <label htmlFor={ids.comment}>{t('supplier_payment.comment_label')}</label>
        <textarea
          id={ids.comment}
          className="text-input"
          rows={2}
          maxLength={MAX_PAYMENT_COMMENT}
          value={draft.comment}
          onChange={(event) => update({ comment: event.target.value })}
        />
      </div>
      {preview.planError ? (
        <p className="error-message" role="alert">
          {t(`supplier_payment.plan_error.${preview.planError}`, {
            defaultValue: t('supplier_payment.plan_error.ALLOCATION_INVALID'),
          })}
        </p>
      ) : preview.unallocatedXaf !== null && preview.unallocatedXaf > 0 ? (
        <p className="home-muted" role="status">
          {t('supplier_payment.advance', { amount: formatMoney(preview.unallocatedXaf) })}
        </p>
      ) : null}
      {preview.needsApproval ? (
        <p className="home-banner" role="status">
          {t('supplier_payment.needs_approval', {
            threshold: formatMoney(settings.thresholdXaf),
          })}
        </p>
      ) : null}
      {preview.cashInsufficient ? (
        <p className="text-warn" role="status">
          {t('supplier_payment.cash_insufficient')}
        </p>
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
        <p className="alert alert-error" role="alert">
          {t(saveError)}
        </p>
      ) : null}
      <button
        type="button"
        className="btn-block submit-sale"
        disabled={!ready}
        onClick={() => void submit()}
      >
        {busy ? t('sales.submitting') : t('supplier_payment.submit')}
      </button>
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
