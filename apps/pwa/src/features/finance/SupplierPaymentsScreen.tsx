/**
 * ECR-FIN-04 « Paiements fournisseurs » (UC-FIN-12 ; ADR-043 §6-7, ADR-047 §4 ; AV-055, AV-275 à
 * AV-277, AV-298). En ligne (`ONLINE_REQUIRED`) ; hors ligne, la dernière lecture reste affichée,
 * périmée, et le brouillon d'un paiement est gardé jusqu'au retour du réseau :
 * - paiements par groupe (en attente de la Direction, décaissés, avances à affecter, refusés ou
 *   annulés) et par fournisseur (`GET /supplier-payments`) : moyen, compte, référence, avance,
 *   affectations à la demande (factures nommées) ; affecter une avance (Finance), annuler (l'auteur
 *   d'un paiement en attente, la Direction d'un paiement décaissé) avec un motif ; décision de la
 *   Direction dans la file des validations (`?types=SUPPLIER_PAYMENT`, ADR-047 §5) ;
 * - saisie d'un paiement (Finance, `PaymentForm`).
 * Toute opération sur les paiements relit la liste, les affectations et la saisie.
 * Le Resp. achats lit (AV-298).
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { holdsAnyRole, ROLE_SETS, ROUTES } from '../../app/screens.js';
import { useOnline } from '../../platform/useOnline.js';
import type { OutboxCommand } from '../../storage/db.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatDateTime } from '../home/format-home.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import type { SupplierView } from '../procurement/suppliers.js';
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
  saveErrorKey,
  submitCommand,
} from '../sales/submit.js';
import type {
  CashAccountItem,
  CashAccountsResponse,
  SupplierPaymentItem,
} from '../treasury/treasury.js';
import { familyReloadKey, useCommandFamily } from './command-family.js';
import { userName } from './expense-format.js';
import { PaymentForm } from './PaymentForm.js';
import { pendingPaymentsPath, readPending } from './pending-payments.js';
import {
  INVOICE_MAX_PAGES,
  INVOICE_PAGE_LIMIT,
  type PayablesResponse,
  type SupplierInvoiceItem,
} from './supplier-invoice.js';
import {
  allocatePayload,
  autoAllocation,
  MAX_PAYMENT_REASON,
  netOfPlanned,
  PAYMENT_GROUP_ORDER,
  PAYMENT_MAX_PAGES,
  payableInvoices,
  paymentActions,
  paymentCancelPayload,
  paymentListPaths,
  paymentsOfGroup,
  planPreviewForAllocation,
  plannedByInvoice,
  shownAllocations,
  type PaymentGroup,
  type SupplierPaymentDetail,
} from './supplier-payment.js';

type Kind = 'allocate' | 'cancel';

/** Opérations sur les paiements (affectation, annulation, enregistrement) : elles relisent l'écran. */
const FAMILY = 'finance.supplier_payment.';
const COMMANDS: Readonly<Record<Kind, string>> = {
  allocate: 'finance.supplier_payment.allocate',
  cancel: 'finance.supplier_payment.cancel',
};
const MANAGED = new Set(Object.values(COMMANDS));

interface PaymentsRead {
  readonly items: readonly SupplierPaymentItem[];
  readonly more: boolean;
}

async function readPayments(
  group: PaymentGroup,
  supplierId: string,
): Promise<ReadResult<PaymentsRead>> {
  const pages = await readPages<SupplierPaymentItem>(
    paymentListPaths(group, supplierId),
    'supplier_payments',
    PAYMENT_MAX_PAGES,
  );
  if (!pages.ok) return pages;
  return {
    ok: true,
    data: { items: paymentsOfGroup(group, pages.data.items), more: pages.data.more },
  };
}

export function SupplierPaymentsScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const online = useOnline();
  const navigation = useRememberedNavigation(userId);
  const family = useCommandFamily(FAMILY);
  const reloadKey = familyReloadKey(family, userId);
  const suppliers = useOnlineRead(
    userId ? '/api/v1/suppliers' : null,
    (key) => readPath<{ readonly suppliers: readonly SupplierView[] }>(key),
    online,
    '',
  );
  // Comptes (noms, soldes) relus après chaque paiement, lus par ceux qui en ont le droit (Finance,
  // Direction) : le Resp. achats ne lit que leur nom abrégé (pas de refus journalisé à chaque visite).
  const accounts = useOnlineRead(
    userId && navigation !== undefined && holdsAnyRole(navigation?.roles ?? [], ROLE_SETS.treasury)
      ? '/api/v1/cash-accounts'
      : null,
    (key) => readPath<CashAccountsResponse>(key),
    online,
    reloadKey,
  );

  if (!userId || navigation === undefined) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.supplier_payments')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }
  const roles = navigation?.roles ?? [];
  const supplierList = suppliers.data?.suppliers ?? [];
  const accountList = accounts.data?.cash_accounts ?? [];
  const mayRecord = holdsAnyRole(roles, ROLE_SETS.supplierPaymentRecord);
  return (
    <section className="sale">
      <h1>{t('nav.screens.supplier_payments')}</h1>
      {online ? null : (
        <p className="text-warn" role="status">
          {t('supplier_payment.offline_banner')}
        </p>
      )}
      {suppliers.failed && !suppliers.denied ? (
        <p className="text-warn" role="status">
          {t('supplier_invoice.suppliers_failed')}{' '}
          <button type="button" className="secondary" onClick={suppliers.retry}>
            {t('supplier_invoice.retry_suppliers')}
          </button>
        </p>
      ) : null}
      {/* Sans droit sur les comptes (Resp. achats), leur nom abrégé suffit ; une panne s'annonce. */}
      {accounts.failed && !accounts.denied ? (
        <p className="text-warn" role="status">
          {t('supplier_payment.accounts_failed')}{' '}
          <button type="button" className="secondary" onClick={accounts.retry}>
            {t('supplier_payment.retry_accounts')}
          </button>
        </p>
      ) : null}
      <PaymentList
        userId={userId}
        suppliers={supplierList}
        accounts={accountList}
        online={online}
        rights={{
          mayRecord,
          mayApprove: holdsAnyRole(roles, ROLE_SETS.supplierPaymentApprove),
        }}
        family={family}
        reloadKey={reloadKey}
      />
      {mayRecord ? (
        <PaymentForm
          userId={userId}
          suppliers={supplierList}
          accounts={accountList}
          accountsLoaded={accounts.data !== undefined}
          online={online}
          family={family}
          reloadKey={reloadKey}
        />
      ) : null}
    </section>
  );
}

function PaymentList({
  userId,
  suppliers,
  accounts,
  online,
  rights,
  family,
  reloadKey,
}: {
  readonly userId: string;
  readonly suppliers: readonly SupplierView[];
  readonly accounts: readonly CashAccountItem[];
  readonly online: boolean;
  readonly rights: { readonly mayRecord: boolean; readonly mayApprove: boolean };
  readonly family: readonly OutboxCommand[];
  readonly reloadKey: string;
}) {
  const { t } = useTranslation();
  const refs = useSalesReferences();
  const [group, setGroup] = useState<PaymentGroup>('PENDING');
  const [supplierId, setSupplierId] = useState('');
  const [open, setOpen] = useState<{ id: string; kind: Kind } | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [last, setLast] = useState<{ commandId: string; kind: Kind }>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const ids = { group: useId(), supplier: useId(), reason: useId(), allocation: useId() };
  const firstField = useRef<HTMLElement | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const openers = useRef(new Map<string, HTMLButtonElement | null>());
  const lastOpened = useRef<string | null>(null);
  const focusResult = useRef(false);
  // Premier champ du formulaire ouvert : focus à l'ouverture, ou dès qu'il paraît (l'affectation
  // attend la lecture des factures à payer).
  const pendingFocus = useRef(false);
  const firstFieldRef = (element: HTMLElement | null) => {
    firstField.current = element;
    if (element && pendingFocus.current) {
      pendingFocus.current = false;
      element.focus();
    }
  };
  useEffect(() => {
    if (open) {
      lastOpened.current = `${open.kind}:${open.id}`;
      if (firstField.current) firstField.current.focus();
      else pendingFocus.current = true;
    } else {
      pendingFocus.current = false;
      if (lastOpened.current) {
        openers.current.get(lastOpened.current)?.focus();
        lastOpened.current = null;
      }
    }
  }, [open]);
  // Opération envoyée : les boutons de la fiche sont bloqués, le focus va au résultat annoncé.
  useEffect(() => {
    if (!focusResult.current) return;
    focusResult.current = false;
    resultRef.current?.focus();
  }, [last]);
  const managed = family.filter((command) => MANAGED.has(command.command_type));
  const read = useOnlineRead<PaymentsRead>(
    `payments:${group}:${supplierId}`,
    () => readPayments(group, supplierId),
    online,
    reloadKey,
  );
  useRefreshOnVisible(read.retry);
  // Factures payables du fournisseur du paiement dont on affecte l'avance.
  const allocating =
    open?.kind === 'allocate' ? read.data?.items.find((item) => item.id === open.id) : undefined;
  const payables = useOnlineRead(
    allocating ? `/api/v1/payables?supplier_id=${allocating.supplierId}` : null,
    (key) => readPath<PayablesResponse>(key),
    online,
    reloadKey,
  );
  // Paiements du fournisseur en attente de la Direction : leurs affectations prévues ne sont pas
  // déduites du reste dû par le serveur, l'approbation serait refusée (revue de P8E-10).
  const planning = useOnlineRead(
    allocating ? pendingPaymentsPath(allocating.supplierId) : null,
    readPending,
    online,
    reloadKey,
  );

  // Retour sur l'écran avec une opération en attente : son résultat est annoncé.
  const adopt = last ? undefined : lastWaitingCommand(managed, FAMILY, userId);
  if (adopt) {
    setLast({
      commandId: adopt.command_id,
      kind: adopt.command_type === COMMANDS.allocate ? 'allocate' : 'cancel',
    });
  }

  const data = read.data;
  // Retenue derrière une opération plus ancienne d'un autre écran : jugée sur toute l'outbox.
  const outbox = refs?.outbox ?? family;
  const waiting = managed.some(
    (command) => command.author_user_id === userId && isBlockingWait(command, outbox),
  );
  const blocked = busy || waiting || read.stale || !data;
  const short = (id: string) => `…${id.slice(-4)}`;
  const supplierOf = (id: string) =>
    suppliers.find((supplier) => supplier.id === id)?.name ?? short(id);
  const accountOf = (id: string) =>
    accounts.find((account) => account.id === id)?.name ?? short(id);
  const methodOf = (code: string) =>
    refs?.paymentMethods.find((method) => method.code === code)?.label ?? code;

  const toggle = (item: SupplierPaymentItem, kind: Kind) => {
    setOpen((current) =>
      current?.id === item.id && current.kind === kind ? null : { id: item.id, kind },
    );
    setReason('');
    setAllocations({});
    setSaveError(null);
  };

  const send = async (item: SupplierPaymentItem, kind: Kind) => {
    if (blocked) return;
    setBusy(true);
    setSaveError(null);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: COMMANDS[kind],
        aggregateType: 'SUPPLIER_PAYMENT',
        aggregateId: item.id,
        payload: kind === 'cancel' ? paymentCancelPayload(reason) : allocatePayload(allocations),
      });
      lastOpened.current = null;
      focusResult.current = true;
      setLast({ commandId: command.command_id, kind });
      setOpen(null);
    } catch (error) {
      setSaveError(saveErrorKey(error));
    } finally {
      setBusy(false);
    }
  };

  const allocateForm = (item: SupplierPaymentItem) => {
    const supplierPayables = payables.data?.suppliers.find(
      (entry) => entry.supplierId === item.supplierId,
    );
    const invoices = payableInvoices(supplierPayables?.invoices ?? []);
    const planned = plannedByInvoice(planning.data?.details ?? []);
    const plan = planPreviewForAllocation({
      supplierId: item.supplierId,
      availableXaf: item.unallocatedXaf,
      allocations,
      invoices,
    });
    const close = (
      <button type="button" className="secondary" onClick={() => setOpen(null)}>
        {t('expense.close_form')}
      </button>
    );
    if (payables.failed) {
      return (
        <div className="field">
          <p className="text-warn" role="status">
            {payables.denied
              ? t('supplier_payment.form_denied')
              : t('supplier_payment.payables_failed')}
          </p>
          <div className="result-actions">
            {payables.denied ? null : (
              <button
                type="button"
                className="secondary"
                ref={firstFieldRef}
                onClick={payables.retry}
              >
                {t('supplier_payment.retry_payables')}
              </button>
            )}
            {close}
          </div>
        </div>
      );
    }
    if (!payables.data) {
      return (
        <div className="field">
          <p className="home-muted">{t('sales.loading')}</p>
          {close}
        </div>
      );
    }
    return (
      <fieldset className="field">
        <legend>
          {t('supplier_payment.allocate_legend', {
            doc: item.docNumber,
            amount: formatMoney(item.unallocatedXaf),
          })}
        </legend>
        {invoices.length === 0 ? (
          <p className="home-muted">{t('supplier_payment.no_invoice')}</p>
        ) : (
          <>
            <button
              type="button"
              className="secondary"
              ref={firstFieldRef}
              onClick={() =>
                setAllocations(autoAllocation(netOfPlanned(invoices, planned), item.unallocatedXaf))
              }
            >
              {t('supplier_payment.spread')}
            </button>
            {invoices.map((invoice) => (
              <div key={invoice.invoiceId} className="field">
                <label htmlFor={`${ids.allocation}-${invoice.invoiceId}`}>
                  {t('supplier_payment.allocation_short', {
                    doc: invoice.docNumber,
                    balance: formatMoney(invoice.balanceXaf),
                  })}
                </label>
                <input
                  id={`${ids.allocation}-${invoice.invoiceId}`}
                  className="text-input"
                  inputMode="numeric"
                  value={allocations[invoice.invoiceId] ?? ''}
                  onChange={(event) =>
                    setAllocations((current) => ({
                      ...current,
                      [invoice.invoiceId]: event.target.value,
                    }))
                  }
                />
                {planned[invoice.invoiceId] ? (
                  <p className="text-warn">
                    {t('supplier_payment.planned_on_invoice', {
                      amount: formatMoney(planned[invoice.invoiceId]!.amountXaf),
                      docs: planned[invoice.invoiceId]!.docNumbers.join(', '),
                    })}
                  </p>
                ) : null}
              </div>
            ))}
          </>
        )}
        {planning.failed ? (
          <p className="text-warn" role="status">
            {planning.denied
              ? t('supplier_payment.form_denied')
              : t('supplier_payment.pending_failed')}{' '}
            {planning.denied ? null : (
              <button type="button" className="secondary" onClick={planning.retry}>
                {t('supplier_payment.retry_pending')}
              </button>
            )}
          </p>
        ) : null}
        {plan.error ? (
          <p className="error-message" role="alert">
            {t(`supplier_payment.plan_error.${plan.error}`, {
              defaultValue: t('supplier_payment.plan_error.ALLOCATION_INVALID'),
            })}
          </p>
        ) : null}
        <div className="result-actions">
          <button
            type="button"
            disabled={blocked || payables.stale || !plan.valid}
            onClick={() => void send(item, 'allocate')}
          >
            {t('supplier_payment.allocate_submit')}
          </button>
          {/* Aucune facture à payer : le focus va au seul bouton utile. */}
          {invoices.length === 0 ? (
            <button
              type="button"
              className="secondary"
              ref={firstFieldRef}
              onClick={() => setOpen(null)}
            >
              {t('expense.close_form')}
            </button>
          ) : (
            close
          )}
        </div>
      </fieldset>
    );
  };

  const cancelForm = (item: SupplierPaymentItem) => (
    <div className="field">
      <label htmlFor={ids.reason}>{t('supplier_payment.cancel_reason_label')}</label>
      <textarea
        id={ids.reason}
        ref={firstFieldRef}
        className="text-input"
        rows={2}
        maxLength={MAX_PAYMENT_REASON}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
      <p className="home-muted">
        {t(
          item.status === 'RECORDED'
            ? 'supplier_payment.cancel_recorded_note'
            : 'supplier_payment.cancel_pending_note',
        )}
      </p>
      <div className="result-actions">
        <button
          type="button"
          disabled={blocked || reason.trim() === ''}
          onClick={() => void send(item, 'cancel')}
        >
          {t('supplier_payment.cancel_submit')}
        </button>
        <button type="button" className="secondary" onClick={() => setOpen(null)}>
          {t('expense.close_form')}
        </button>
      </div>
    </div>
  );

  const card = (item: SupplierPaymentItem) => {
    const actions = paymentActions(item, userId, rights);
    return (
      <li key={item.id} className="line-card" aria-label={item.docNumber}>
        <p>
          <strong>{item.docNumber}</strong> · {formatMoney(item.amountXaf)}
        </p>
        <p>{supplierOf(item.supplierId)}</p>
        <p className="home-muted">
          {t('supplier_payment.card_meta', {
            method: methodOf(item.paymentMethodCode),
            account: accountOf(item.fromAccountId),
            date: formatDateTime(item.occurredAt),
            author: userName(t, refs?.users ?? [], item.createdBy, userId),
          })}
          {item.externalReference
            ? ` · ${t('treasury.supplier_payment_reference', { reference: item.externalReference })}`
            : ''}
        </p>
        <p className={item.status === 'PENDING_APPROVAL' ? 'text-warn' : 'home-muted'}>
          {t(`supplier_payment.status.${item.status}`, { defaultValue: item.status })}
          {item.status === 'RECORDED' && item.unallocatedXaf > 0
            ? ` · ${t('supplier_payment.unallocated', { amount: formatMoney(item.unallocatedXaf) })}`
            : ''}
          {item.status === 'REJECTED' && item.decidedAt
            ? ` · ${t('supplier_payment.decided_at', { date: formatDateTime(item.decidedAt) })}`
            : ''}
          {/* Décaissé à la décision de la Direction (AV-276) : sa date n'est pas celle de la saisie. */}
          {item.status === 'RECORDED' && item.disbursedAt && item.disbursedAt !== item.occurredAt
            ? ` · ${t('supplier_payment.disbursed_at', { date: formatDateTime(item.disbursedAt) })}`
            : ''}
        </p>
        {item.cancelReason ? (
          <p className="home-muted">
            {t('supplier_payment.cancel_reason', { reason: item.cancelReason })}
          </p>
        ) : null}
        <button
          type="button"
          className="secondary"
          aria-expanded={shown === item.id}
          onClick={() => setShown((current) => (current === item.id ? null : item.id))}
        >
          {t(
            shown === item.id
              ? 'supplier_payment.allocations_hide'
              : 'supplier_payment.allocations_show',
            { doc: item.docNumber },
          )}
        </button>
        {shown === item.id ? (
          <PaymentAllocations payment={item} online={online} reloadKey={reloadKey} />
        ) : null}
        {open?.id === item.id ? (
          open.kind === 'allocate' ? (
            allocateForm(item)
          ) : (
            cancelForm(item)
          )
        ) : actions.allocate || actions.cancel ? (
          <div className="result-actions">
            {actions.allocate ? (
              <button
                type="button"
                ref={(element) => {
                  openers.current.set(`allocate:${item.id}`, element);
                }}
                disabled={blocked}
                onClick={() => toggle(item, 'allocate')}
              >
                {t('supplier_payment.allocate_open', { doc: item.docNumber })}
              </button>
            ) : null}
            {actions.cancel ? (
              <button
                type="button"
                className="secondary"
                ref={(element) => {
                  openers.current.set(`cancel:${item.id}`, element);
                }}
                disabled={blocked}
                onClick={() => toggle(item, 'cancel')}
              >
                {t('supplier_payment.cancel_open', { doc: item.docNumber })}
              </button>
            ) : null}
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <section className="sale-block" aria-labelledby="payments-title">
      <h2 id="payments-title">{t('supplier_payment.list_title')}</h2>
      <div className="line-fields">
        <div className="field">
          <label htmlFor={ids.group}>{t('supplier_payment.group_label')}</label>
          <select
            id={ids.group}
            className="text-input"
            value={group}
            onChange={(event) => {
              setGroup(event.target.value as PaymentGroup);
              setOpen(null);
            }}
          >
            {PAYMENT_GROUP_ORDER.map((candidate) => (
              <option key={candidate} value={candidate}>
                {t(`supplier_payment.group.${candidate}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.supplier}>{t('supplier_payment.filter_supplier')}</label>
          <select
            id={ids.supplier}
            className="text-input"
            value={supplierId}
            onChange={(event) => {
              setSupplierId(event.target.value);
              setOpen(null);
            }}
          >
            <option value="">{t('supplier_invoice.all_suppliers')}</option>
            {[...suppliers]
              .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
              .map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
          </select>
        </div>
      </div>
      {/* Décision de la Direction dans la file des validations (ADR-047 §5). */}
      {rights.mayApprove && group === 'PENDING' ? (
        <Link to={`${ROUTES.approvals}?types=SUPPLIER_PAYMENT`} className="action action-compact">
          <span className="action-label">{t('supplier_payment.decide_link')}</span>
        </Link>
      ) : null}
      {last ? (
        <div ref={resultRef} tabIndex={-1}>
          <CommandResult
            commandId={last.commandId}
            messages={`supplier_payment.${last.kind}_result`}
          />
        </div>
      ) : null}
      {saveError ? (
        <p className="alert alert-error" role="alert">
          {t(saveError)}
        </p>
      ) : null}
      {read.failed ? (
        <div className="alert alert-error" role="alert">
          <p>
            {read.denied
              ? t('supplier_payment.denied')
              : t(data ? 'supplier_payment.failed_stale' : 'supplier_payment.failed')}
          </p>
          {read.denied ? null : (
            <button type="button" className="secondary" onClick={read.retry}>
              {t('supplier_payment.retry_list')}
            </button>
          )}
        </div>
      ) : null}
      {!data ? (
        read.failed ? null : (
          <p className="home-muted" aria-busy={online}>
            {t(online ? 'sales.loading' : 'supplier_payment.online_only')}
          </p>
        )
      ) : (
        <>
          {read.stale && !read.failed ? (
            <p className="home-muted" role="status">
              {t('expense.refreshing')}
            </p>
          ) : null}
          {data.items.length === 0 ? (
            <p className="home-muted">{t('supplier_payment.empty')}</p>
          ) : (
            <ul className="line-list">{data.items.map((item) => card(item))}</ul>
          )}
          {data.more ? <p className="home-muted">{t('expense.truncated')}</p> : null}
        </>
      )}
    </section>
  );
}

/**
 * Affectations d'un paiement, lues à la demande (`GET /supplier-payments/{id}`) ; factures nommées par
 * celles du fournisseur (`GET /supplier-invoices?supplier_id=`), sinon abrégées.
 */
function PaymentAllocations({
  payment,
  online,
  reloadKey,
}: {
  readonly payment: SupplierPaymentItem;
  readonly online: boolean;
  readonly reloadKey: string;
}) {
  const { t } = useTranslation();
  const read = useOnlineRead(
    `/api/v1/supplier-payments/${payment.id}`,
    (key) => readPath<{ readonly supplier_payment: SupplierPaymentDetail }>(key),
    online,
    reloadKey,
  );
  const invoices = useOnlineRead(
    `/api/v1/supplier-invoices?supplier_id=${payment.supplierId}&limit=${INVOICE_PAGE_LIMIT}`,
    (key) => readPages<SupplierInvoiceItem>([key], 'supplier_invoices', INVOICE_MAX_PAGES),
    online,
    reloadKey,
  );
  if (read.failed) {
    return (
      <p className="text-warn" role="alert">
        {read.denied
          ? t('supplier_payment.allocations_denied')
          : t('supplier_payment.allocations_failed')}{' '}
        {read.denied ? null : (
          <button type="button" className="secondary" onClick={read.retry}>
            {t('supplier_payment.retry_allocations', { doc: payment.docNumber })}
          </button>
        )}
      </p>
    );
  }
  const detail = read.data?.supplier_payment;
  if (!detail) return <p className="home-muted">{t('sales.loading')}</p>;
  const { allocations, emptyKey } = shownAllocations(detail);
  if (allocations.length === 0) {
    return <p className="home-muted">{t(`supplier_payment.${emptyKey}`)}</p>;
  }
  const docOf = (invoiceId: string) =>
    invoices.data?.items.find((invoice) => invoice.id === invoiceId)?.docNumber ??
    `…${invoiceId.slice(-4)}`;
  return (
    <ul className="home-muted">
      {allocations.map((allocation, index) => (
        <li key={`${allocation.invoiceId}-${index}`}>
          {t('supplier_payment.allocation_read', {
            invoice: docOf(allocation.invoiceId),
            amount: formatMoney(allocation.amountXaf),
            status: t(`supplier_invoice.allocation_status.${allocation.status}`, {
              defaultValue: allocation.status,
            }),
          })}
        </li>
      ))}
    </ul>
  );
}
