/**
 * ECR-PRX-03 « Simulateur de prix » (responsable commercial, direction) : pour un produit, une
 * quantité, une date, un site, une zone, une catégorie de client et un canal, le prix catalogue que
 * la vente appliquerait, la règle retenue et les autres règles applicables dans l'ordre du départage.
 * Aucune écriture ; calcul sur l'appareil avec les règles téléchargées (partiel hors ligne, S-08).
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { businessDayOf, type PriceRule } from '@gic/domain';
import { clock } from '../../platform/composition.js';
import { formatBusinessDay } from '../home/format-home.js';
import { formatMoney, formatQuantity } from '../sales/format.js';
import { useSalesReferences } from '../sales/references.js';
import { MAX_QUANTITY, pricesMayBeStale } from '../sales/sale-form.js';
import {
  applicableRules,
  parseSimQuantity,
  simQuantityTooLarge,
  SIM_CHANNELS,
  simInstant,
  simTotal,
} from './price-sim.js';
import { describeScope } from './scope.js';

export function PriceSimulatorScreen() {
  const { t } = useTranslation();
  const refs = useSalesReferences();
  const [productId, setProductId] = useState('');
  const [quantityText, setQuantityText] = useState('1');
  const [day, setDay] = useState(() => businessDayOf(clock.now()));
  const [siteId, setSiteId] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [channelCode, setChannelCode] = useState('');
  const ids = {
    product: useId(),
    quantity: useId(),
    day: useId(),
    site: useId(),
    zone: useId(),
    category: useId(),
    channel: useId(),
  };

  if (!refs) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.price_simulator')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const products = refs.products
    .filter((product) => product.is_sellable && product.status === 'ACTIVE')
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const product = products.find((candidate) => candidate.id === productId);
  const pricingUnit = product
    ? product.pricing_mode === 'PER_WEIGHT'
      ? 'kg'
      : product.base_unit_code
    : '';
  const sites = [...refs.sites.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const zones = [...refs.zones.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const quantity = parseSimQuantity(quantityText);
  const now = clock.now();
  const instant = simInstant(day, now);
  const at = instant?.at ?? null;
  const rules =
    product && quantity !== null && at
      ? applicableRules(
          {
            productId: product.id,
            at,
            siteId,
            zoneId,
            customerCategoryId: categoryId,
            channelCode,
            quantity,
          },
          refs.priceRules,
          refs.zones,
          refs.campaigns,
        )
      : [];
  const [winner, ...others] = rules;
  const total = winner && quantity !== null ? simTotal(quantity, winner.unitPriceXaf) : null;

  const describe = (rule: PriceRule): string => describeScope(rule, refs, pricingUnit, t);

  const select = (
    id: string,
    label: string,
    value: string,
    onChange: (value: string) => void,
    options: readonly { readonly value: string; readonly label: string }[],
    placeholder: string,
  ) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="text-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <section className="sale">
      <h1>{t('nav.screens.price_simulator')}</h1>
      <p className="home-muted">{t('price_sim.hint')}</p>
      {pricesMayBeStale(refs.lastSyncAt, now) ? (
        <p className="home-banner" role="status">
          {t('sales.stale_prices')}
        </p>
      ) : null}
      {select(
        ids.product,
        t('price_sim.product_label'),
        productId,
        setProductId,
        products.map((candidate) => ({ value: candidate.id, label: candidate.name })),
        t('loss.product_placeholder'),
      )}
      <div className="line-fields">
        <div className="field">
          <label htmlFor={ids.quantity}>
            {t('price_sim.quantity_label', { unit: pricingUnit || '—' })}
          </label>
          <input
            id={ids.quantity}
            className="text-input"
            inputMode="decimal"
            value={quantityText}
            onChange={(event) => setQuantityText(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={ids.day}>{t('price_sim.day_label')}</label>
          <input
            id={ids.day}
            type="date"
            className="text-input"
            value={day}
            onChange={(event) => setDay(event.target.value)}
          />
        </div>
      </div>
      {select(
        ids.site,
        t('price_sim.site_label'),
        siteId,
        setSiteId,
        sites.map((site) => ({ value: site.id, label: site.name })),
        t('price_sim.any'),
      )}
      {select(
        ids.zone,
        t('price_sim.zone_label'),
        zoneId,
        setZoneId,
        zones.map((zone) => ({ value: zone.id, label: zone.name })),
        t('price_sim.any'),
      )}
      {select(
        ids.category,
        t('price_sim.category_label'),
        categoryId,
        setCategoryId,
        refs.customerCategories.map((category) => ({ value: category.id, label: category.name })),
        t('price_sim.any'),
      )}
      {select(
        ids.channel,
        t('price_sim.channel_label'),
        channelCode,
        setChannelCode,
        SIM_CHANNELS.map((code) => ({ value: code, label: t(`price_sim.channel.${code}`) })),
        t('price_sim.any'),
      )}

      {product && quantityText && quantity === null ? (
        <p className="error-message">
          {simQuantityTooLarge(quantityText)
            ? t('price_sim.quantity_too_large', { max: formatQuantity(MAX_QUANTITY) })
            : t('loss.issue.QUANTITY_INVALID')}
        </p>
      ) : null}
      {product && quantity !== null && at ? (
        <section className="sale-block" aria-labelledby="price-sim-result" role="status">
          <h2 id="price-sim-result">{t('price_sim.result_title')}</h2>
          <p className="home-muted">
            {instant?.now ? t('price_sim.at_now') : t('price_sim.at_noon')}
          </p>
          {winner ? (
            <>
              <p>
                <strong>
                  {t('price_sim.price', {
                    price: formatMoney(winner.unitPriceXaf),
                    unit: pricingUnit,
                  })}
                </strong>
              </p>
              {total !== null ? (
                <p>
                  {t('price_sim.total', {
                    quantity: formatQuantity(quantity),
                    unit: pricingUnit,
                    total: formatMoney(total),
                  })}
                </p>
              ) : (
                <p className="text-warn">{t('price_sim.total_too_large')}</p>
              )}
              <p className="home-muted">
                {t('price_sim.rule', {
                  scope: describe(winner),
                  from: formatBusinessDay(businessDayOf(winner.validFrom)),
                })}
              </p>
              {others.length > 0 ? (
                <>
                  <h3>{t('price_sim.others_title')}</h3>
                  <ul className="receipt-lines">
                    {others.map((rule) => (
                      <li key={rule.id}>
                        <span>
                          <small>{describe(rule)}</small>
                        </span>
                        <span>{formatMoney(rule.unitPriceXaf)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </>
          ) : (
            <p className="text-warn">{t('price_sim.none')}</p>
          )}
        </section>
      ) : null}
    </section>
  );
}
