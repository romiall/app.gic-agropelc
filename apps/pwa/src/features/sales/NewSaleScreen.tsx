/**
 * ECR-VEN-01 « + NOUVELLE VENTE » (vente rapide, encaissement intégré ; WF-J1 étape 7, WF-J2
 * étape 4). Un seul écran (UX-02) : emplacement prérempli, client (de passage par défaut), articles
 * au prix catalogue résolu sur l'appareil, encaissement prérempli au total. Utilisable hors ligne :
 * la vente est enregistrée dans l'outbox et envoyée au retour du réseau (UX-05).
 *
 * Hors ligne, la vente est bloquée localement au-delà de ce que l'appareil peut vendre (BR-VEN-018,
 * AV-025 ; `decideLocalConsumption`) : stock local pour une garde exclusive, quota d'appareil pour un
 * emplacement partagé. En ligne, le serveur décide (stock, prix à jour, crédit, session de caisse).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { creditCheck, xaf } from '@gic/domain';
import { clock, idGenerator } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { CommandResult } from './CommandResult.js';
import { CustomerPicker } from './CustomerPicker.js';
import { formatMoney } from './format.js';
import { deduceChannel } from './pricing.js';
import { ProductPicker } from './ProductPicker.js';
import { useSalesReferences, type SalesReferences } from './references.js';
import {
  computeLine,
  linePayload,
  parseXaf,
  paymentPayload,
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
import { submitCommand } from './submit.js';
import type { LocationData, ProductData } from './types.js';

const DEFAULT_METHOD = 'ESPECES';

function availableAt(refs: SalesReferences, location: LocationData, productId: string): number {
  const key = stockKey(location.id, productId);
  return localAvailable(refs.stock.get(key), location.custody_mode, refs.pending.get(key) ?? 0);
}

export function NewSaleScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const navigation = useRememberedNavigation(userId);
  const refs = useSalesReferences();
  const online = useOnline();

  const [locationChoice, setLocationChoice] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [picking, setPicking] = useState(false);
  const [methodChoice, setMethodChoice] = useState<string | null>(null);
  /** `null` : montant encaissé = total (préremplissage). */
  const [amountText, setAmountText] = useState<string | null>(null);
  const [reference, setReference] = useState('');
  const [submittedId, setSubmittedId] = useState<string>();
  const [busy, setBusy] = useState(false);

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
    setMethodChoice(null);
    setAmountText(null);
    setReference('');
    setSubmittedId(undefined);
  };

  if (submittedId) {
    return (
      <section className="sale">
        <h1>{t('nav.screens.new_sale')}</h1>
        <CommandResult commandId={submittedId} messages="sales.result">
          <button type="button" onClick={reset}>
            {t('sales.new_sale')}
          </button>
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
  const site = location.site_id ? refs.sites.get(location.site_id) : undefined;
  const customer = customerId
    ? refs.customers.find((candidate) => candidate.id === customerId)
    : undefined;
  const context: PricingContext = {
    at: now,
    siteId: site?.id,
    siteZoneId: site?.zone_id,
    customerCategoryId: customer?.category_id,
    channelCode: deduceChannel({
      locationType: location.location_type,
      roles: navigation?.roles ?? [],
      hasOpenSession: false,
    }),
  };
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

  // Blocage local hors ligne (AV-025) : par produit, toutes lignes confondues.
  const blocks: string[] = [];
  if (!online) {
    const overAllowed =
      settingValue(refs.settings, 'sales.offline_over_allocation_allowed', site?.id, now) === true;
    for (const [productId, requested] of requestedByProduct(computed)) {
      if (requested <= 0) continue;
      const decision = offlineSaleDecision({
        location,
        requested,
        available: availableAt(refs, location, productId),
        now,
        overAllocationAllowed: overAllowed,
      });
      if (!decision.allowed) {
        blocks.push(`${productsById.get(productId)?.name ?? ''} : ${decision.messageFr}`);
      }
    }
  }

  const methods = refs.paymentMethods;
  const method =
    methods.find((candidate) => candidate.code === methodChoice) ??
    methods.find((candidate) => candidate.code === DEFAULT_METHOD) ??
    methods[0];
  const amount = amountText === null ? total : parseXaf(amountText);
  const paymentErrors: string[] = [];
  if (amount === null) paymentErrors.push(t('sales.error_amount_invalid'));
  else {
    if (amount > total) paymentErrors.push(t('sales.error_payment_exceeds'));
    if (!customer && amount < total) paymentErrors.push(t('sales.error_anonymous_full'));
    if (method?.requires_reference && amount > 0 && !reference.trim()) {
      paymentErrors.push(t('sales.error_reference_required'));
    }
  }
  const warnings: string[] = [];
  if (customer && amount !== null && amount < total) {
    const credit = creditCheck({
      creditAllowed: customer.credit_allowed,
      creditLimitXaf: customer.credit_limit_xaf === null ? null : xaf(customer.credit_limit_xaf),
      outstandingXaf: xaf(Math.max(0, customer.outstanding_xaf)),
      newCreditXaf: xaf(total - amount),
    });
    if (credit.outcome === 'NOT_ALLOWED') warnings.push(t('sales.warning_credit_not_allowed'));
    if (credit.outcome === 'EXCEEDS_LIMIT') {
      warnings.push(t('sales.warning_credit_limit', { amount: formatMoney(credit.exceedsByXaf) }));
    }
  }

  const ready =
    computed.length > 0 &&
    computed.every((line) => line.issue === null) &&
    paymentErrors.length === 0 &&
    blocks.length === 0 &&
    (amount === 0 || method !== undefined) &&
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
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: 'sales.sale.record',
        aggregateType: 'SALE',
        payload: {
          fromLocationId: location.id,
          ...(customer ? { customerId: customer.id } : {}),
          channelCode: context.channelCode,
          lines: computed.map(linePayload),
          ...(amount > 0 && method
            ? {
                payments: [
                  paymentPayload({ methodCode: method.code, amountXaf: amount, reference }),
                ],
              }
            : {}),
        },
      });
      setSubmittedId(command.command_id);
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

      <div className="field">
        <label htmlFor="sale-location">{t('sales.location_label')}</label>
        {locations.length > 1 ? (
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
        ) : (
          <p id="sale-location" className="picked-title">
            {location.name}
          </p>
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
          <strong data-testid="sale-total">{formatMoney(total)}</strong>
        </p>
        {methods.length > 0 ? (
          <div className="field">
            <label htmlFor="sale-method">{t('sales.method_label')}</label>
            <select
              id="sale-method"
              className="text-input"
              value={method?.code ?? ''}
              onChange={(event) => setMethodChoice(event.target.value)}
            >
              {methods.map((candidate) => (
                <option key={candidate.code} value={candidate.code}>
                  {candidate.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="field">
          <label htmlFor="sale-amount">{t('sales.amount_label')}</label>
          <input
            id="sale-amount"
            className="text-input"
            inputMode="numeric"
            value={amountText ?? String(total)}
            onChange={(event) => setAmountText(event.target.value)}
          />
        </div>
        {method?.requires_reference ? (
          <div className="field">
            <label htmlFor="sale-reference">{t('sales.reference_label')}</label>
            <input
              id="sale-reference"
              className="text-input"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              autoComplete="off"
            />
          </div>
        ) : null}
        {amount !== null && amount <= total ? (
          <p className="home-muted">
            {amount === total
              ? t('sales.fully_paid')
              : t('sales.balance_due', { amount: formatMoney(total - amount) })}
          </p>
        ) : null}
      </section>

      {[...paymentErrors, ...blocks].map((message) => (
        <p key={message} className="error-message" role="alert">
          {message}
        </p>
      ))}
      {warnings.map((message) => (
        <p key={message} className="text-warn">
          {message}
        </p>
      ))}

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
