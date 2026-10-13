/**
 * ECR-VEN-01 « + NOUVELLE VENTE » (vente rapide, encaissement intégré ; WF-J1 étape 7, WF-J2
 * étape 4). Un seul écran (UX-02) : emplacement prérempli, client (de passage par défaut), articles
 * au prix catalogue résolu sur l'appareil, encaissement prérempli au total. Utilisable hors ligne :
 * la vente est enregistrée dans l'outbox et envoyée au retour du réseau (UX-05).
 *
 * Hors ligne (serveur injoignable, ADR-037), la vente est bloquée localement au-delà de ce que
 * l'appareil peut vendre (BR-VEN-018, AV-025 ; `decideLocalConsumption`) : stock local pour une garde
 * exclusive (et l'appareil désigné pour une garde d'appareil), quota d'appareil pour un emplacement
 * partagé ; une ligne de service n'a pas d'effet de stock (BR-VEN-031). En ligne, le serveur décide
 * (stock, prix à jour, crédit, session de caisse).
 *
 * Prix : zone de la vente (BR-VEN-022), canal déduit comme le serveur (BR-VEN-021) ; seuls les rôles
 * qui ont `sales.price.override` peuvent modifier un prix.
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
import { formatMoney, formatQuantity } from './format.js';
import { formatDateTime } from '../home/format-home.js';
import {
  EMPTY_PAYMENT,
  paymentIssues,
  paymentPayload,
  type PaymentFieldsValue,
} from './payment.js';
import { PaymentFields } from './PaymentFields.js';
import { deduceChannel, openWorkSession, saleZoneId } from './pricing.js';
import { ProductPicker } from './ProductPicker.js';
import { useSalesReferences, type SalesReferences } from './references.js';
import {
  computeLine,
  linePayload,
  parseXaf,
  pricesMayBeStale,
  requestedByProduct,
  saleUnitsOf,
  sellingLocations,
  stockKey,
  totalOf,
  type DraftLine,
  type PricingContext,
} from './sale-form.js';
import { SaleLineEditor } from './SaleLineEditor.js';
import { localAvailable, offlineSaleDecision, settingValue } from './stock.js';
import { deviceQuota } from './quota.js';
import { submitCommand } from './submit.js';
import type { LocationData, ProductData } from './types.js';
import { cashPaymentBlocked, cashSessionCoverage } from '../cash/cash-session.js';
import { CashSessionPrompt } from '../cash/CashSessionPrompt.js';
import { CASH_METHOD_ACCOUNT_TYPE } from './payment.js';

const DEFAULT_METHOD = 'ESPECES';

function availableAt(refs: SalesReferences, location: LocationData, productId: string): number {
  const key = stockKey(location.id, productId);
  return localAvailable(refs.stock.get(key), location.custody_mode, refs.pending.get(key) ?? 0);
}

export function NewSaleScreen() {
  const { t } = useTranslation();
  const { state, deviceId } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const navigation = useRememberedNavigation(userId);
  const refs = useSalesReferences();
  const online = useOnline();

  const [locationChoice, setLocationChoice] = useState<string | null>(null);
  // Client déjà choisi depuis sa fiche (ECR-CRM-03).
  const [searchParams] = useSearchParams();
  const [customerId, setCustomerId] = useState<string | null>(searchParams.get('client'));
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [picking, setPicking] = useState(false);
  const [payment, setPayment] = useState<PaymentFieldsValue>(EMPTY_PAYMENT);
  const [submitted, setSubmitted] = useState<{ commandId: string; saleId: string }>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.new_sale')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const reset = () => {
    setCustomerId(null);
    setLines([]);
    setPayment(EMPTY_PAYMENT);
    setSubmitted(undefined);
    setSaveError(false);
  };

  if (submitted) {
    return (
      <section className="sale">
        <h1>{t('nav.screens.new_sale')}</h1>
        <CommandResult commandId={submitted.commandId} messages="sales.result">
          <button type="button" onClick={reset}>
            {t('sales.new_sale')}
          </button>
          <Link to={ROUTES.sale(submitted.saleId)} className="action action-compact">
            <span className="action-label">{t('sales.view_sale')}</span>
          </Link>
        </CommandResult>
      </section>
    );
  }

  const locations = sellingLocations(refs, userId);
  const location = locations.find((candidate) => candidate.id === locationChoice) ?? locations[0];
  if (!location) {
    return (
      <section className="sale">
        <h1>{t('nav.screens.new_sale')}</h1>
        <p className="alert alert-error">{t('sales.no_location')}</p>
      </section>
    );
  }

  const now = clock.now();
  const roles = navigation ? navigation.roles : null;
  const site = location.site_id ? refs.sites.get(location.site_id) : undefined;
  const customer = customerId
    ? refs.customers.find((candidate) => candidate.id === customerId)
    : undefined;
  const session = openWorkSession(refs.workSessions, userId, now);
  const context: PricingContext = {
    at: now,
    siteId: site?.id,
    zoneId: saleZoneId({
      locationType: location.location_type,
      siteZoneId: site?.zone_id,
      customerZoneId: customer?.zone_id,
      sessionZoneId: session?.declared_zone_id,
    }),
    customerCategoryId: customer?.category_id,
    channelCode: deduceChannel({
      locationType: location.location_type,
      roles,
      hasOpenSession: session !== undefined,
    }),
  };
  const canOverride = holdsAnyRole(roles ?? [], ROLE_SETS.priceOverride);
  const productsById = new Map(refs.products.map((product) => [product.id, product]));
  const sellable = refs.products.filter(
    (product) => product.is_sellable && product.status === 'ACTIVE',
  );
  const computed = lines.flatMap((draft) => {
    const product = productsById.get(draft.productId);
    return product ? [computeLine(draft, product, refs, context)] : [];
  });
  const total = totalOf(computed);
  const overrideReasons = refs.reasonCodes.filter((reason) => reason.category === 'PRICE_OVERRIDE');

  // Quotas de l'utilisateur sur cet appareil (emplacement partagé) : reste et échéance affichés.
  const requested = requestedByProduct(computed);
  const quotas = new Map(
    location.custody_mode === 'EXCLUSIVE_USER' || location.custody_mode === 'EXCLUSIVE_DEVICE'
      ? []
      : [...requested.keys()].flatMap((productId) => {
          const quota = deviceQuota(refs, {
            userId,
            deviceId,
            locationId: location.id,
            productId,
          });
          return quota ? [[productId, quota] as const] : [];
        }),
  );
  // Blocage local hors ligne (AV-025) : par produit, toutes lignes confondues, hors services.
  const blocks: string[] = [];
  // Dépassement autorisé par le site (`sales.offline_over_allocation_allowed`) : la vente part et le
  // serveur le signale.
  const signalled: string[] = [];
  if (!online) {
    if (
      requested.size > 0 &&
      location.custody_mode === 'EXCLUSIVE_DEVICE' &&
      location.designated_device_id !== deviceId
    ) {
      blocks.push(t('sales.custody_device_mismatch'));
    } else {
      const overAllowed =
        settingValue(refs.settings, 'sales.offline_over_allocation_allowed', site?.id, now) ===
        true;
      for (const [productId, quantity] of requested) {
        if (quantity <= 0) continue;
        const decision = offlineSaleDecision({
          location,
          requested: quantity,
          available: availableAt(refs, location, productId),
          quota: quotas.get(productId) ?? null,
          now,
          overAllocationAllowed: overAllowed,
        });
        if (!decision.allowed) {
          const product = productsById.get(productId);
          blocks.push(
            t(`sales.quota_block_message.${decision.code}`, {
              product: product?.name ?? '',
              available: formatQuantity(Math.max(0, decision.available)),
              requested: formatQuantity(quantity),
              unit: product?.base_unit_code ?? '',
            }),
          );
        } else if (decision.signalled) {
          signalled.push(
            t('sales.quota_signalled', {
              product: productsById.get(productId)?.name ?? '',
              code: t(`sales.quota_block.${decision.signalled}`),
            }),
          );
        }
      }
    }
  }

  const methods = refs.paymentMethods;
  const method =
    methods.find((candidate) => candidate.code === payment.methodCode) ??
    methods.find((candidate) => candidate.code === DEFAULT_METHOD) ??
    methods[0];
  const amount = payment.amountText === null ? (total ?? 0) : parseXaf(payment.amountText);
  // Vente au PDV (emplacement `POS`) : un encaissement en espèces exige une caisse ouverte
  // (BR-DIS-005, AV-305).
  const cashSession = cashSessionCoverage({
    atPointOfSale: location.location_type === 'POS',
    accounts: refs.cashAccounts,
    sessions: refs.cashSessions,
    outbox: refs.outbox,
    cashPulledAt: refs.cashPulledAt,
    siteId: location.site_id,
    userId,
    maxSessionsPerDay: settingValue(
      refs.settings,
      'finance.cash_sessions_per_day_max',
      location.site_id,
      now,
    ),
  });
  const paymentErrors: string[] = [];
  if (total === null) paymentErrors.push(t('sales.error_total_invalid'));
  else if (amount === null) paymentErrors.push(t('sales.error_amount_invalid'));
  else {
    if (amount > total) paymentErrors.push(t('sales.error_payment_exceeds'));
    if (!customer && amount < total) paymentErrors.push(t('sales.error_anonymous_full'));
    if (amount > 0) {
      for (const issue of paymentIssues(
        { method, amountXaf: amount, reference: payment.reference, accountId: payment.accountId },
        refs.cashAccounts,
      )) {
        paymentErrors.push(t(`sales.payment_issue.${issue}`));
      }
      if (
        method?.default_account_type === CASH_METHOD_ACCOUNT_TYPE &&
        cashPaymentBlocked(cashSession, online)
      ) {
        paymentErrors.push(t('cash.prompt.blocked'));
      }
    }
  }
  const warnings: string[] = [];
  if (customer && total !== null && amount !== null && amount < total) {
    const credit = creditCheck({
      creditAllowed: customer.credit_allowed,
      creditLimitXaf: customer.credit_limit_xaf === null ? null : xaf(customer.credit_limit_xaf),
      // Encours téléchargé corrigé des opérations de l'appareil pas encore retéléchargées.
      outstandingXaf: xaf(
        localOutstanding(customer, refs.outbox, refs.customersPulledAt, refs.customerAlias),
      ),
      newCreditXaf: xaf(total - amount),
    });
    if (credit.outcome === 'NOT_ALLOWED') warnings.push(t('sales.warning_credit_not_allowed'));
    if (credit.outcome === 'EXCEEDS_LIMIT') {
      warnings.push(t('sales.warning_credit_limit', { amount: formatMoney(credit.exceedsByXaf) }));
    }
  }

  // Client choisi qui n'est plus sur l'appareil (prospect refusé…) : jamais vendu en client de passage
  // sans le dire.
  const customerMissing = customerId !== null && customer === undefined;
  const ready =
    !customerMissing &&
    computed.length > 0 &&
    computed.every((line) => line.issue === null) &&
    paymentErrors.length === 0 &&
    blocks.length === 0 &&
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

  const submit = async () => {
    if (!ready || amount === null) return;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: 'sales.sale.record',
        aggregateType: 'SALE',
        // Client créé sur l'appareil : l'opération attend sa création (FIFO de l'appareil).
        ...(customer?.pending_command_id ? { dependsOn: [customer.pending_command_id] } : {}),
        payload: {
          fromLocationId: location.id,
          ...(customer ? { customerId: customer.id } : {}),
          ...(context.channelCode ? { channelCode: context.channelCode } : {}),
          lines: computed.map(linePayload),
          ...(amount > 0 && method
            ? {
                payments: [
                  paymentPayload(
                    {
                      method,
                      amountXaf: amount,
                      reference: payment.reference,
                      accountId: payment.accountId,
                    },
                    refs.cashAccounts,
                  ),
                ],
              }
            : {}),
        },
      });
      setSubmitted({ commandId: command.command_id, saleId: command.aggregate_id });
    } catch {
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sale">
      <h1>{t('nav.screens.new_sale')}</h1>
      {!online ? (
        <p className="home-banner" role="status">
          {t('sales.offline_banner')}
        </p>
      ) : null}
      {pricesMayBeStale(refs.lastSyncAt, now) ? (
        <p className="home-banner">{t('sales.stale_prices')}</p>
      ) : null}
      {cashSession === 'MISSING' || cashSession === 'UNKNOWN' ? (
        <CashSessionPrompt coverage={cashSession} online={online} userId={userId} />
      ) : null}

      <div className="field">
        {locations.length > 1 ? (
          <>
            <label htmlFor="sale-location">{t('sales.location_label')}</label>
            <select
              id="sale-location"
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
          </>
        ) : (
          <>
            <span className="field-label">{t('sales.location_label')}</span>
            <p className="picked-title">{location.name}</p>
          </>
        )}
      </div>

      <section className="sale-block" aria-labelledby="sale-customer-title">
        <h2 id="sale-customer-title">{t('sales.customer_title')}</h2>
        <CustomerPicker
          customers={refs.customers}
          value={customerId}
          onChange={setCustomerId}
          allowAnonymous
        />
        {customerMissing ? (
          <div className="alert alert-error" role="alert">
            <p>{t('sales.customer_missing')}</p>
            <button type="button" className="secondary" onClick={() => setCustomerId(null)}>
              {t('sales.customer_missing_anonymous')}
            </button>
          </div>
        ) : null}
      </section>

      <section className="sale-block" aria-labelledby="sale-lines-title">
        <h2 id="sale-lines-title">{t('sales.lines_title')}</h2>
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
            products={sellable}
            availableOf={(productId) => availableAt(refs, location, productId)}
            onPick={addProduct}
            onClose={() => setPicking(false)}
          />
        ) : (
          <button type="button" className="secondary btn-block" onClick={() => setPicking(true)}>
            {t('sales.add_product')}
          </button>
        )}
      </section>

      <section className="sale-block" aria-labelledby="sale-payment-title">
        <h2 id="sale-payment-title">{t('sales.payment_title')}</h2>
        <p className="total-line">
          <span>{t('sales.total')}</span>
          <strong data-testid="sale-total">{formatMoney(total ?? 0)}</strong>
        </p>
        <PaymentFields
          methods={methods}
          accounts={refs.cashAccounts}
          method={method}
          value={payment}
          amountLabel={t('sales.amount_label')}
          amountPlaceholder={String(total ?? 0)}
          onChange={setPayment}
        />
        {total !== null && amount !== null && amount <= total ? (
          <p className="home-muted">
            {amount === total
              ? t('sales.fully_paid')
              : t('sales.balance_due', { amount: formatMoney(total - amount) })}
          </p>
        ) : null}
      </section>

      {quotas.size > 0 ? (
        <section className="sale-block" aria-labelledby="sale-quota-title">
          <h2 id="sale-quota-title">{t('sales.quota_title')}</h2>
          {[...quotas].map(([productId, quota]) => {
            const product = productsById.get(productId);
            const values = {
              product: product?.name ?? '',
              remaining: formatQuantity(Math.max(0, quota.remaining)),
              unit: product?.base_unit_code ?? '',
              until: quota.validUntil ? formatDateTime(quota.validUntil.toISOString()) : '',
            };
            return (
              <p key={productId} className="home-muted">
                {quota.validUntil && quota.validUntil.getTime() <= now.getTime()
                  ? t('sales.quota_expired', values)
                  : quota.validUntil
                    ? t('sales.quota_line_until', values)
                    : t('sales.quota_line', values)}
              </p>
            );
          })}
        </section>
      ) : null}
      {[...paymentErrors, ...blocks].map((message) => (
        <p key={message} className="error-message" role="alert">
          {message}
        </p>
      ))}
      {signalled.map((message) => (
        <p key={message} className="text-warn" role="status">
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
        {busy ? t('sales.submitting') : t('sales.submit_sale')}
      </button>
    </section>
  );
}
