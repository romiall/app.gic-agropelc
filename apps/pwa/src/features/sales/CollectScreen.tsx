/**
 * ECR-VEN-06 « ENCAISSER (règlement de créances d'un client) ». Client, montant reçu, moyen,
 * référence et compte de réception (bloc d'encaissement commun) ; l'affectation est automatique
 * (BR-FIN-004 : échéance la plus ancienne d'abord, le reste en avoir du client) et l'écran en montre
 * l'aperçu, après les encaissements du client déjà saisis sur l'appareil. Commande
 * `sales.payment.record` (agrégat `CUSTOMER_PAYMENT`), utilisable hors ligne : le serveur affecte au
 * moment de l'application.
 *
 * Créances : en ligne, `GET /api/v1/receivables` (relues après chaque encaissement) ; hors ligne,
 * celles des ventes récentes de l'appareil. Clients : ceux de l'appareil (jeu `customers`), et en
 * ligne une recherche sur `GET /api/v1/customers` pour les rôles qui n'ont pas de portefeuille
 * téléchargé (Finance, besoin S-12). Site : celui du point de vente ou du stock de l'utilisateur ; à
 * défaut, l'utilisateur peut le choisir, sinon le serveur le déduit des créances réglées.
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { businessDayOf } from '@gic/domain';
import { clock } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatBusinessDay, formatMoment } from '../home/format-home.js';
import {
  afterPendingPayments,
  duesFromReceivables,
  duesFromRecentSales,
  pendingPaymentsOf,
  previewAllocation,
  type ReceivableLine,
} from './collect.js';
import { CommandResult } from './CommandResult.js';
import { CustomerPicker } from './CustomerPicker.js';
import { formatMoney } from './format.js';
import {
  CASH_METHOD_ACCOUNT_TYPE,
  EMPTY_PAYMENT,
  paymentIssues,
  paymentPayload,
  type PaymentFieldsValue,
} from './payment.js';
import { cashPaymentBlocked, cashSessionCoverage } from '../cash/cash-session.js';
import { CashSessionPrompt } from '../cash/CashSessionPrompt.js';
import { PaymentFields } from './PaymentFields.js';
import { useSalesReferences } from './references.js';
import { parseXaf, sellingLocations } from './sale-form.js';
import { settingValue } from './stock.js';
import { submitCommand } from './submit.js';
import type { CustomerData } from './types.js';

const DEFAULT_METHOD = 'ESPECES';
const REMOTE_SEARCH_MIN_LENGTH = 2;
const REMOTE_SEARCH_LIMIT = 20;

interface ReceivablesState {
  readonly key: string;
  readonly lines: readonly ReceivableLine[] | null;
}

/** Créances du client lues en ligne ; `undefined` tant que la lecture n'a pas abouti. */
function useOnlineReceivables(
  customerId: string | null,
  online: boolean,
  reloadKey: number,
): readonly ReceivableLine[] | null | undefined {
  const [state, setState] = useState<ReceivablesState>();
  const key = `${customerId ?? ''}:${reloadKey}`;
  useEffect(() => {
    if (!customerId || !online) return;
    let cancelled = false;
    void authorizedRequest<{ receivables?: ReceivableLine[] }>(
      getDb(),
      `/api/v1/receivables?customer_id=${encodeURIComponent(customerId)}`,
      { method: 'GET' },
    ).then((result) => {
      if (!cancelled) setState({ key, lines: result.ok ? (result.data.receivables ?? []) : null });
    });
    return () => {
      cancelled = true;
    };
  }, [customerId, online, key]);
  if (!customerId || !online) return null;
  return state?.key === key ? state.lines : undefined;
}

/** Résumé client de `GET /api/v1/customers` (champs utiles à l'écran). */
interface RemoteCustomer {
  readonly id: string;
  readonly stage: string;
  readonly displayName: string;
  readonly contactName: string | null;
  readonly categoryId: string | null;
  readonly phonePrimary: string | null;
  readonly addressText: string | null;
  readonly zoneId: string;
  readonly ownerUserId: string | null;
  readonly homeSiteId: string | null;
  readonly mergedIntoId: string | null;
  readonly creditAllowed: boolean;
  readonly creditLimitXaf: number | null;
  readonly paymentTermsDays: number | null;
  readonly version: number;
}

function toCustomerData(remote: RemoteCustomer): CustomerData {
  return {
    id: remote.id,
    stage: remote.stage,
    display_name: remote.displayName,
    contact_name: remote.contactName,
    category_id: remote.categoryId,
    phone_primary: remote.phonePrimary,
    address_text: remote.addressText,
    zone_id: remote.zoneId,
    owner_user_id: remote.ownerUserId,
    home_site_id: remote.homeSiteId,
    merged_into_id: remote.mergedIntoId,
    credit_allowed: remote.creditAllowed,
    credit_limit_xaf: remote.creditLimitXaf,
    payment_terms_days: remote.paymentTermsDays,
    // L'encours n'est pas dans la lecture : les créances lues en ligne en tiennent lieu.
    outstanding_xaf: 0,
    version: remote.version,
  };
}

/** Recherche en ligne des clients, à partir de 2 caractères. */
function useRemoteCustomers(query: string, online: boolean): readonly CustomerData[] {
  const [found, setFound] = useState<{ query: string; customers: readonly CustomerData[] }>();
  const text = query.trim();
  useEffect(() => {
    if (!online || text.length < REMOTE_SEARCH_MIN_LENGTH) return;
    let cancelled = false;
    void authorizedRequest<{ customers?: RemoteCustomer[] }>(
      getDb(),
      `/api/v1/customers?q=${encodeURIComponent(text)}&limit=${REMOTE_SEARCH_LIMIT}`,
      { method: 'GET' },
    ).then((result) => {
      if (cancelled || !result.ok) return;
      setFound({
        query: text,
        customers: (result.data.customers ?? [])
          .filter((customer) => customer.mergedIntoId === null)
          .map(toCustomerData),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [text, online]);
  return online && found?.query === text ? found.customers : [];
}

export function CollectScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
  const online = useOnline();
  const [searchParams] = useSearchParams();
  const [customerId, setCustomerId] = useState<string | null>(searchParams.get('client'));
  const [query, setQuery] = useState('');
  /** Client trouvé en ligne et choisi (absent du portefeuille de l'appareil). */
  const [remoteSelected, setRemoteSelected] = useState<CustomerData>();
  const [siteChoice, setSiteChoice] = useState('');
  const [payment, setPayment] = useState<PaymentFieldsValue>(EMPTY_PAYMENT);
  const [submitted, setSubmitted] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const receivables = useOnlineReceivables(customerId, online, reloadKey);
  const remoteCustomers = useRemoteCustomers(query, online);

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
              // Relire les créances : l'encaissement accepté les a réduites.
              setReloadKey((key) => key + 1);
            }}
          >
            {t('collect.new_payment')}
          </button>
        </CommandResult>
      </section>
    );
  }

  const localCustomer = customerId
    ? refs.customers.find((candidate) => candidate.id === customerId)
    : undefined;
  const customer =
    localCustomer ?? (remoteSelected?.id === customerId ? remoteSelected : undefined);
  const fromServer = Array.isArray(receivables);
  const allDues = customer
    ? fromServer
      ? duesFromReceivables(receivables, customer.id)
      : duesFromRecentSales(refs.sales, customer.id, refs.customerAlias)
    : [];
  const pending = customer ? pendingPaymentsOf(refs.outbox, customer.id, refs.customerAlias) : [];
  const dues = afterPendingPayments(
    allDues,
    pending.map((entry) => entry.amountXaf),
  );
  const duesTotal = dues.reduce((sum, due) => sum + due.balanceXaf, 0);
  // Site de l'encaissement : celui du point de vente ou du stock de l'utilisateur, sinon son choix.
  const ownSiteId = sellingLocations(refs, userId).find((location) => location.site_id)?.site_id;
  const siteId = ownSiteId ?? (siteChoice || undefined);
  const sites = [...refs.sites.values()]
    .filter((site) => site.status === 'ACTIVE')
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));

  const methods = refs.paymentMethods;
  const method =
    methods.find((candidate) => candidate.code === payment.methodCode) ??
    methods.find((candidate) => candidate.code === DEFAULT_METHOD) ??
    methods[0];
  const amount = parseXaf(payment.amountText ?? '');
  // Encaissement sur le site d'un PDV : en espèces, il exige une caisse ouverte (BR-DIS-005, AV-233 ;
  // DÉDUIT de `cashAccountFor` : site de type `POINT_DE_VENTE`). Site laissé au serveur : celui qu'il
  // retiendra, la vente de la première créance réglée, à défaut le site du client (DÉDUIT de
  // `payment-commands.ts`).
  const firstSaleId =
    amount !== null && amount > 0
      ? previewAllocation(amount, dues).lines[0]?.due.saleId
      : undefined;
  const cashSiteId =
    siteId ??
    (firstSaleId ? refs.sales.find((sale) => sale.id === firstSaleId)?.site_id : undefined) ??
    customer?.home_site_id ??
    undefined;
  const cashSession = cashSessionCoverage({
    atPointOfSale: cashSiteId ? refs.sites.get(cashSiteId)?.site_type === 'POINT_DE_VENTE' : false,
    accounts: refs.cashAccounts,
    sessions: refs.cashSessions,
    outbox: refs.outbox,
    cashPulledAt: refs.cashPulledAt,
    siteId: cashSiteId,
    userId,
    maxSessionsPerDay: settingValue(
      refs.settings,
      'finance.cash_sessions_per_day_max',
      cashSiteId,
      clock.now(),
    ),
  });
  const cashBlocked =
    method?.default_account_type === CASH_METHOD_ACCOUNT_TYPE &&
    amount !== null &&
    amount > 0 &&
    cashPaymentBlocked(cashSession, online);
  const issues = customer
    ? paymentIssues(
        { method, amountXaf: amount, reference: payment.reference, accountId: payment.accountId },
        refs.cashAccounts,
      )
    : [];
  const preview = amount !== null && amount > 0 ? previewAllocation(amount, dues) : null;
  const ready =
    customer !== undefined && method !== undefined && issues.length === 0 && !cashBlocked && !busy;
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
        // Client créé sur l'appareil : l'opération attend sa création (FIFO de l'appareil).
        ...(customer?.pending_command_id ? { dependsOn: [customer.pending_command_id] } : {}),
        payload: {
          customerId: customer.id,
          ...(siteId ? { siteId } : {}),
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
      {method?.default_account_type === CASH_METHOD_ACCOUNT_TYPE &&
      (cashSession === 'MISSING' || cashSession === 'UNKNOWN') ? (
        <CashSessionPrompt coverage={cashSession} online={online} userId={userId} />
      ) : null}

      <section className="sale-block" aria-labelledby="collect-customer-title">
        <h2 id="collect-customer-title">{t('sales.customer_title')}</h2>
        <CustomerPicker
          customers={refs.customers}
          remoteCustomers={remoteCustomers}
          onQueryChange={setQuery}
          value={customerId}
          onChange={(id) => {
            setCustomerId(id);
            setRemoteSelected(remoteCustomers.find((candidate) => candidate.id === id));
            setPayment(EMPTY_PAYMENT);
          }}
          allowAnonymous={false}
        />
        <p className="home-muted">
          {online ? t('collect.remote_search_hint') : t('collect.remote_search_offline')}
        </p>
        {localCustomer ? (
          <p className="total-line">
            <span>
              {t('collect.outstanding', { amount: formatMoney(localCustomer.outstanding_xaf) })}
            </span>
          </p>
        ) : customer === undefined ? (
          <p className="home-muted">{t('collect.customer_required')}</p>
        ) : null}
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
              <>
                <p className="home-muted">
                  {t('collect.dues_total', { amount: formatMoney(duesTotal) })}
                </p>
                {preview ? <h3 className="field-label">{t('collect.preview_title')}</h3> : null}
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
                              {t('collect.allocated', { amount: formatMoney(allocated.amountXaf) })}
                            </span>
                          ) : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </>
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
            {ownSiteId === undefined && sites.length > 0 ? (
              <div className="field">
                <label htmlFor="collect-site">{t('collect.site_label')}</label>
                <select
                  id="collect-site"
                  className="text-input"
                  value={siteChoice}
                  onChange={(event) => setSiteChoice(event.target.value)}
                >
                  <option value="">{t('collect.site_placeholder')}</option>
                  {sites.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
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
          {cashBlocked ? (
            <p className="error-message" role="alert">
              {t('cash.prompt.blocked')}
            </p>
          ) : null}
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
