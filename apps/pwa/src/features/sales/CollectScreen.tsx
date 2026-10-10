/**
 * ECR-VEN-06 « ENCAISSER (règlement de créances d'un client) ». Client, montant reçu, moyen,
 * référence et compte de réception (bloc d'encaissement commun) ; l'affectation est automatique
 * (BR-FIN-004 : échéance la plus ancienne d'abord, le reste en avoir du client) et l'écran en montre
 * l'aperçu. Commande `sales.payment.record` (agrégat `CUSTOMER_PAYMENT`), utilisable hors ligne : le
 * serveur affecte au moment de l'application. En ligne, les créances viennent de
 * `GET /api/v1/receivables` ; hors ligne, des ventes récentes de l'appareil.
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { clock } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatBusinessDay, formatMoment } from '../home/format-home.js';
import { businessDayOf } from '@gic/domain';
import {
  duesFromReceivables,
  duesFromRecentSales,
  pendingPaymentsOf,
  previewAllocation,
  type ReceivableLine,
} from './collect.js';
import { CommandResult } from './CommandResult.js';
import { CustomerPicker } from './CustomerPicker.js';
import { formatMoney } from './format.js';
import { paymentIssues, paymentPayload } from './payment.js';
import { EMPTY_PAYMENT, PaymentFields, type PaymentFieldsValue } from './PaymentFields.js';
import { useSalesReferences } from './references.js';
import { parseXaf } from './sale-form.js';
import { submitCommand } from './submit.js';

const DEFAULT_METHOD = 'ESPECES';

interface ReceivablesState {
  readonly customerId: string;
  readonly lines: readonly ReceivableLine[] | null;
}

/** Créances du client lues en ligne ; `undefined` tant que la lecture n'a pas abouti. */
function useOnlineReceivables(
  customerId: string | null,
  online: boolean,
): readonly ReceivableLine[] | null | undefined {
  const [state, setState] = useState<ReceivablesState>();
  useEffect(() => {
    if (!customerId || !online) return;
    let cancelled = false;
    void authorizedRequest<{ receivables?: ReceivableLine[] }>(
      getDb(),
      `/api/v1/receivables?customer_id=${encodeURIComponent(customerId)}`,
      { method: 'GET' },
    ).then((result) => {
      if (cancelled) return;
      setState({ customerId, lines: result.ok ? (result.data.receivables ?? []) : null });
    });
    return () => {
      cancelled = true;
    };
  }, [customerId, online]);
  if (!customerId || !online) return null;
  return state?.customerId === customerId ? state.lines : undefined;
}

export function CollectScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
  const online = useOnline();
  const [searchParams] = useSearchParams();
  const [customerId, setCustomerId] = useState<string | null>(searchParams.get('client'));
  const [payment, setPayment] = useState<PaymentFieldsValue>(EMPTY_PAYMENT);
  const [submitted, setSubmitted] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const receivables = useOnlineReceivables(customerId, online);

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.collect')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  if (submitted) {
    return (
      <section className="sale">
        <h1>{t('nav.screens.collect')}</h1>
        <CommandResult commandId={submitted} messages="collect.result">
          <button
            type="button"
            onClick={() => {
              setPayment(EMPTY_PAYMENT);
              setSubmitted(undefined);
            }}
          >
            {t('collect.new_payment')}
          </button>
        </CommandResult>
      </section>
    );
  }

  const customer = customerId
    ? refs.customers.find((candidate) => candidate.id === customerId)
    : undefined;
  const fromServer = Array.isArray(receivables);
  const dues = customer
    ? fromServer
      ? duesFromReceivables(receivables, customer.id)
      : duesFromRecentSales(refs.sales, customer.id)
    : [];
  const pending = customer ? pendingPaymentsOf(refs.outbox, customer.id) : [];
  const methods = refs.paymentMethods;
  const method =
    methods.find((candidate) => candidate.code === payment.methodCode) ??
    methods.find((candidate) => candidate.code === DEFAULT_METHOD) ??
    methods[0];
  const amount = parseXaf(payment.amountText ?? '');
  const issues = customer
    ? paymentIssues(
        { method, amountXaf: amount, reference: payment.reference, accountId: payment.accountId },
        refs.cashAccounts,
      )
    : [];
  const preview = amount !== null && amount > 0 ? previewAllocation(amount, dues) : null;
  const ready = customer !== undefined && method !== undefined && issues.length === 0 && !busy;
  const today = businessDayOf(clock.now());

  const submit = async () => {
    if (!ready || !customer || !method || amount === null) return;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: 'sales.payment.record',
        aggregateType: 'CUSTOMER_PAYMENT',
        payload: {
          customerId: customer.id,
          ...paymentPayload(
            {
              method,
              amountXaf: amount,
              reference: payment.reference,
              accountId: payment.accountId,
            },
            refs.cashAccounts,
          ),
        },
      });
      setSubmitted(command.command_id);
    } catch {
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sale">
      <h1>{t('nav.screens.collect')}</h1>
      {!online ? (
        <p className="home-banner" role="status">
          {t('collect.offline_banner')}
        </p>
      ) : null}

      <section className="sale-block" aria-labelledby="collect-customer-title">
        <h2 id="collect-customer-title">{t('sales.customer_title')}</h2>
        <CustomerPicker
          customers={refs.customers}
          value={customerId}
          onChange={(id) => {
            setCustomerId(id);
            setPayment(EMPTY_PAYMENT);
          }}
          allowAnonymous={false}
        />
        {customer ? (
          <p className="total-line">
            <span>
              {t('collect.outstanding', { amount: formatMoney(customer.outstanding_xaf) })}
            </span>
          </p>
        ) : (
          <p className="home-muted">{t('collect.customer_required')}</p>
        )}
      </section>

      {customer ? (
        <>
          <section className="sale-block" aria-labelledby="collect-dues-title">
            <h2 id="collect-dues-title">{t('collect.dues_title')}</h2>
            <p className="home-muted">
              {receivables === undefined
                ? t('collect.dues_loading')
                : fromServer
                  ? t('collect.dues_online')
                  : t('collect.dues_offline')}
            </p>
            {dues.length === 0 ? (
              <p className="home-muted">{t('collect.dues_none')}</p>
            ) : (
              <ul className="doc-list">
                {dues.map((due) => {
                  const allocated = preview?.lines.find((line) => line.due.saleId === due.saleId);
                  return (
                    <li key={due.saleId} className="doc-row">
                      <span className="doc-main">
                        <strong>
                          {due.dueDate
                            ? t('collect.due_line', {
                                doc: due.docNumber,
                                date: formatBusinessDay(due.dueDate),
                              })
                            : t('collect.due_line_no_date', { doc: due.docNumber })}
                        </strong>
                        <small>{formatMoment(due.occurredAt, today)}</small>
                      </span>
                      <span className="doc-side">
                        <strong>{formatMoney(due.balanceXaf)}</strong>
                        {allocated ? (
                          <span className="badge badge-ok">
                            − {formatMoney(allocated.amountXaf)}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {preview && preview.creditXaf > 0 ? (
              <p className="text-warn">
                {t('collect.preview_credit', { amount: formatMoney(preview.creditXaf) })}
              </p>
            ) : null}
          </section>

          {pending.length > 0 ? (
            <section className="sale-block" aria-labelledby="collect-pending-title">
              <h2 id="collect-pending-title">{t('collect.pending_title')}</h2>
              <ul className="doc-list">
                {pending.map((entry) => (
                  <li key={entry.commandId} className="doc-row">
                    <span className="doc-main">
                      <small>{formatMoment(entry.occurredAt, today)}</small>
                    </span>
                    <span className="doc-side">
                      <strong>{formatMoney(entry.amountXaf)}</strong>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="sale-block" aria-labelledby="collect-payment-title">
            <h2 id="collect-payment-title">{t('sales.payment_title')}</h2>
            <PaymentFields
              methods={methods}
              accounts={refs.cashAccounts}
              method={method}
              value={payment}
              amountLabel={t('collect.amount_label')}
              amountPlaceholder=""
              onChange={setPayment}
            />
          </section>

          {payment.amountText !== null && payment.amountText !== ''
            ? issues.map((issue) => (
                <p key={issue} className="error-message" role="alert">
                  {t(`sales.payment_issue.${issue}`)}
                </p>
              ))
            : null}
          {saveError ? (
            <p className="alert alert-error" role="alert">
              {t('sales.error_local_save')}
            </p>
          ) : null}

          <button
            type="button"
            className="btn-block submit-sale"
            disabled={!ready}
            onClick={() => void submit()}
          >
            {busy ? t('sales.submitting') : t('collect.submit')}
          </button>
        </>
      ) : null}
    </section>
  );
}
