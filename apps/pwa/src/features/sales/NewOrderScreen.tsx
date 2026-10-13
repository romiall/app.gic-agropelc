/**
 * ECR-VEN-02 « + NOUVELLE COMMANDE » (WF-J1 étape 6). Client identifié obligatoire, emplacement de
 * préparation, articles au prix catalogue (le prix convenu est figé dans la commande, AV-087), date
 * et adresse de livraison facultatives, acompte facultatif (AV-033). La commande est passée
 * directement (`sales.order.place`) : à son application, le serveur vend le disponible et laisse le
 * reste en attente (ADR-028 §4) ; elle n'est jamais refusée faute de stock. Utilisable hors ligne.
 * Pas de remise sur une ligne de commande (`DISCOUNT_NOT_SUPPORTED_ON_ORDER`) ; un produit vendu au
 * poids ne se commande pas (`PRODUCT_NOT_ORDERABLE`).
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { creditCheck, xaf } from '@gic/domain';
import { holdsAnyRole, ROLE_SETS, ROUTES } from '../../app/screens.js';
import { clock, idGenerator } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { CommandResult } from './CommandResult.js';
import { localOutstanding } from './credit.js';
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
import { deduceChannel, openWorkSession } from './pricing.js';
import { ProductPicker } from './ProductPicker.js';
import { useSalesReferences } from './references.js';
import {
  computeLine,
  fulfilmentLocations,
  MAX_ADDRESS_LENGTH,
  linePayload,
  parseXaf,
  pricesMayBeStale,
  saleUnitsOf,
  totalOf,
  type DraftLine,
  type PricingContext,
} from './sale-form.js';
import { SaleLineEditor } from './SaleLineEditor.js';
import { settingValue } from './stock.js';
import { submitCommand } from './submit.js';
import type { ProductData } from './types.js';

const DEFAULT_METHOD = 'ESPECES';

export function NewOrderScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const navigation = useRememberedNavigation(userId);
  const refs = useSalesReferences();
  const online = useOnline();

  // Client déjà choisi depuis sa fiche (ECR-CRM-03).
  const [searchParams] = useSearchParams();
  const [customerId, setCustomerId] = useState<string | null>(searchParams.get('client'));
  const [locationChoice, setLocationChoice] = useState<string | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [picking, setPicking] = useState(false);
  const [deliveryDate, setDeliveryDate] = useState('');
  /** `null` : adresse du client (préremplissage). */
  const [addressText, setAddressText] = useState<string | null>(null);
  const [withAdvance, setWithAdvance] = useState(false);
  const [advancePayment, setAdvancePayment] = useState<PaymentFieldsValue>(EMPTY_PAYMENT);
  const [submitted, setSubmitted] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.new_order')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const reset = () => {
    setCustomerId(null);
    setLocationChoice(null);
    setLines([]);
    setDeliveryDate('');
    setAddressText(null);
    setWithAdvance(false);
    setAdvancePayment(EMPTY_PAYMENT);
    setSubmitted(undefined);
    setSaveError(false);
  };

  if (submitted) {
    return (
      <section className="sale">
        <h1>{t('nav.screens.new_order')}</h1>
        <CommandResult commandId={submitted} messages="orders.result">
          <button type="button" onClick={reset}>
            {t('orders.new_order')}
          </button>
          <Link to={ROUTES.orders} className="action action-compact">
            <span className="action-label">{t('orders.view_orders')}</span>
          </Link>
        </CommandResult>
      </section>
    );
  }

  const now = clock.now();
  const customer = customerId
    ? refs.customers.find((candidate) => candidate.id === customerId)
    : undefined;
  const locations = fulfilmentLocations(refs, userId, customer?.home_site_id);
  const location = locations.find((candidate) => candidate.id === locationChoice) ?? locations[0];
  const site = location?.site_id ? refs.sites.get(location.site_id) : undefined;
  const roles = navigation ? navigation.roles : null;
  const context: PricingContext = {
    at: now,
    siteId: site?.id,
    // Une commande est tarifée dans la zone de son client (`order-commands.ts`).
    zoneId: customer?.zone_id ?? site?.zone_id,
    customerCategoryId: customer?.category_id,
    channelCode: deduceChannel({
      locationType: null,
      roles,
      hasOpenSession: openWorkSession(refs.workSessions, userId, now) !== undefined,
    }),
  };
  const canOverride = holdsAnyRole(roles ?? [], ROLE_SETS.priceOverride);
  const productsById = new Map(refs.products.map((product) => [product.id, product]));
  const orderable = refs.products.filter(
    (product) =>
      product.is_sellable && product.status === 'ACTIVE' && product.pricing_mode === 'PER_UNIT',
  );
  const computed = lines.flatMap((draft) => {
    const product = productsById.get(draft.productId);
    return product ? [computeLine(draft, product, refs, context)] : [];
  });
  const total = totalOf(computed);
  const overrideReasons = refs.reasonCodes.filter((reason) => reason.category === 'PRICE_OVERRIDE');

  const methods = refs.paymentMethods;
  const method =
    methods.find((candidate) => candidate.code === advancePayment.methodCode) ??
    methods.find((candidate) => candidate.code === DEFAULT_METHOD) ??
    methods[0];
  const advance = withAdvance ? parseXaf(advancePayment.amountText ?? '') : 0;
  // Commande servie au PDV (emplacement `POS`) : un acompte en espèces exige une caisse ouverte
  // (BR-DIS-005, AV-305).
  const cashSession = cashSessionCoverage({
    atPointOfSale: location?.location_type === 'POS',
    accounts: refs.cashAccounts,
    sessions: refs.cashSessions,
    outbox: refs.outbox,
    cashPulledAt: refs.cashPulledAt,
    siteId: location?.site_id,
    userId,
    maxSessionsPerDay: settingValue(
      refs.settings,
      'finance.cash_sessions_per_day_max',
      location?.site_id,
      now,
    ),
  });
  const errors: string[] = [];
  if (total === null) errors.push(t('sales.error_total_invalid'));
  if (withAdvance) {
    if (advance === null || advance === 0) errors.push(t('orders.error_advance_invalid'));
    else if (total !== null && advance > total) errors.push(t('orders.error_advance_exceeds'));
    for (const issue of paymentIssues(
      {
        method,
        amountXaf: advance,
        reference: advancePayment.reference,
        accountId: advancePayment.accountId,
      },
      refs.cashAccounts,
    )) {
      if (issue !== 'AMOUNT_INVALID') errors.push(t(`sales.payment_issue.${issue}`));
    }
    if (
      advance !== null &&
      advance > 0 &&
      method?.default_account_type === CASH_METHOD_ACCOUNT_TYPE &&
      cashPaymentBlocked(cashSession, online)
    ) {
      errors.push(t('cash.prompt.blocked'));
    }
  }
  const warnings: string[] = [];
  if (customer && total !== null && advance !== null && total > advance) {
    const credit = creditCheck({
      creditAllowed: customer.credit_allowed,
      creditLimitXaf: customer.credit_limit_xaf === null ? null : xaf(customer.credit_limit_xaf),
      // Encours téléchargé corrigé des opérations de l'appareil pas encore retéléchargées.
      outstandingXaf: xaf(
        localOutstanding(customer, refs.outbox, refs.customersPulledAt, refs.customerAlias),
      ),
      newCreditXaf: xaf(total - advance),
    });
    if (credit.outcome === 'NOT_ALLOWED') warnings.push(t('orders.warning_credit_not_allowed'));
    if (credit.outcome === 'EXCEEDS_LIMIT') {
      warnings.push(t('orders.warning_credit_limit', { amount: formatMoney(credit.exceedsByXaf) }));
    }
  }

  const ready =
    customer !== undefined &&
    location !== undefined &&
    computed.length > 0 &&
    computed.every((line) => line.issue === null) &&
    errors.length === 0 &&
    !busy;

  const addProduct = (product: ProductData) => {
    setLines((current) => [
      ...current,
      {
        key: idGenerator.newId(),
        productId: product.id,
        unitCode: product.base_unit_code,
        quantityText: '1',
        weightText: '',
        priceText: null,
        overrideReasonId: null,
      },
    ]);
    setPicking(false);
  };

  const address = (addressText ?? customer?.address_text ?? '').trim().slice(0, MAX_ADDRESS_LENGTH);

  const submit = async () => {
    if (!ready || !customer || !location || advance === null) return;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: 'sales.order.place',
        aggregateType: 'SALES_ORDER',
        // Client créé sur l'appareil : l'opération attend sa création (FIFO de l'appareil).
        ...(customer?.pending_command_id ? { dependsOn: [customer.pending_command_id] } : {}),
        payload: {
          customerId: customer.id,
          fulfilmentLocationId: location.id,
          ...(context.channelCode ? { channelCode: context.channelCode } : {}),
          ...(deliveryDate ? { requestedDeliveryDate: deliveryDate } : {}),
          ...(address ? { deliveryAddress: address } : {}),
          lines: computed.map(linePayload),
          ...(withAdvance && advance > 0 && method
            ? {
                advancePayments: [
                  paymentPayload(
                    {
                      method,
                      amountXaf: advance,
                      reference: advancePayment.reference,
                      accountId: advancePayment.accountId,
                    },
                    refs.cashAccounts,
                  ),
                ],
              }
            : {}),
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
      <h1>{t('nav.screens.new_order')}</h1>
      {!online ? (
        <p className="home-banner" role="status">
          {t('orders.offline_banner')}
        </p>
      ) : null}
      {pricesMayBeStale(refs.lastSyncAt, now) ? (
        <p className="home-banner">{t('sales.stale_prices')}</p>
      ) : null}
      {withAdvance &&
      method?.default_account_type === CASH_METHOD_ACCOUNT_TYPE &&
      (cashSession === 'MISSING' || cashSession === 'UNKNOWN') ? (
        <CashSessionPrompt coverage={cashSession} online={online} userId={userId} />
      ) : null}

      <section className="sale-block" aria-labelledby="order-customer-title">
        <h2 id="order-customer-title">{t('sales.customer_title')}</h2>
        <CustomerPicker
          customers={refs.customers}
          value={customerId}
          onChange={(id) => {
            setCustomerId(id);
            setLocationChoice(null);
            setAddressText(null);
          }}
          allowAnonymous={false}
        />
        {customer ? null : <p className="home-muted">{t('orders.customer_required')}</p>}
      </section>

      <div className="field">
        <label htmlFor="order-location">{t('orders.fulfilment_label')}</label>
        {locations.length > 0 && location ? (
          <select
            id="order-location"
            className="text-input"
            value={location.id}
            onChange={(event) => setLocationChoice(event.target.value)}
          >
            {locations.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        ) : (
          <p className="alert alert-error">{t('orders.no_fulfilment')}</p>
        )}
        <p className="home-muted">{t('orders.stock_note')}</p>
      </div>

      <section className="sale-block" aria-labelledby="order-lines-title">
        <h2 id="order-lines-title">{t('sales.lines_title')}</h2>
        {computed.length > 0 ? (
          <ul className="line-list">
            {computed.map((line) => (
              <SaleLineEditor
                key={line.draft.key}
                line={line}
                units={saleUnitsOf(line.product, refs)}
                overrideReasons={overrideReasons}
                canOverride={canOverride}
                onChange={(draft) =>
                  setLines((current) =>
                    current.map((candidate) => (candidate.key === draft.key ? draft : candidate)),
                  )
                }
                onRemove={() =>
                  setLines((current) =>
                    current.filter((candidate) => candidate.key !== line.draft.key),
                  )
                }
              />
            ))}
          </ul>
        ) : null}
        {picking ? (
          <ProductPicker
            products={orderable}
            onPick={addProduct}
            onClose={() => setPicking(false)}
          />
        ) : (
          <button type="button" className="secondary btn-block" onClick={() => setPicking(true)}>
            {t('sales.add_product')}
          </button>
        )}
        <p className="home-muted">{t('orders.weight_not_orderable')}</p>
      </section>

      <section className="sale-block" aria-labelledby="order-delivery-title">
        <h2 id="order-delivery-title">{t('orders.delivery_title')}</h2>
        <div className="field">
          <label htmlFor="order-date">{t('orders.delivery_date_label')}</label>
          <input
            id="order-date"
            type="date"
            className="text-input"
            value={deliveryDate}
            onChange={(event) => setDeliveryDate(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="order-address">{t('orders.delivery_address_label')}</label>
          <textarea
            id="order-address"
            className="text-input"
            rows={2}
            maxLength={MAX_ADDRESS_LENGTH}
            value={addressText ?? customer?.address_text ?? ''}
            onChange={(event) => setAddressText(event.target.value)}
          />
        </div>
      </section>

      <section className="sale-block" aria-labelledby="order-advance-title">
        <h2 id="order-advance-title">{t('orders.advance_title')}</h2>
        <p className="total-line">
          <span>{t('orders.total_estimated')}</span>
          <strong data-testid="order-total">{formatMoney(total ?? 0)}</strong>
        </p>
        <label className="choice">
          <input
            type="checkbox"
            checked={withAdvance}
            onChange={(event) => setWithAdvance(event.target.checked)}
          />
          {t('orders.advance_toggle')}
        </label>
        {withAdvance ? (
          <PaymentFields
            methods={methods}
            accounts={refs.cashAccounts}
            method={method}
            value={advancePayment}
            amountLabel={t('orders.advance_amount_label')}
            amountPlaceholder=""
            onChange={setAdvancePayment}
          />
        ) : null}
      </section>

      {errors.map((message) => (
        <p key={message} className="error-message" role="alert">
          {message}
        </p>
      ))}
      {warnings.map((message) => (
        <p key={message} className="text-warn">
          {message}
        </p>
      ))}
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
        {busy ? t('sales.submitting') : t('orders.submit')}
      </button>
    </section>
  );
}
