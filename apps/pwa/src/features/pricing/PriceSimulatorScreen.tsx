/**
 * ECR-PRX-03 « Simulateur de prix » (responsable commercial, direction) : pour un produit, une
 * quantité, une date, un site, une zone, une catégorie de client et un canal, le prix catalogue que
 * la vente appliquerait, la règle retenue et les autres règles applicables dans l'ordre du départage.
 * Aucune écriture ; calcul sur l'appareil avec les règles téléchargées (partiel hors ligne, S-08).
 * Disposition : produit, quantité et date, puis le résultat, puis les affinages (site, zone,
 * catégorie, canal) ; sur ordinateur, le résultat reste à droite des saisies.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { businessDayOf, type PriceRule } from '@gic/domain';
import {
  Banner,
  Card,
  Field,
  Input,
  List,
  ListRow,
  PageHeader,
  Select,
  SkeletonRows,
} from '../../components/ui/index.js';
import { clock } from '../../platform/composition.js';
import { formatBusinessDay } from '../home/format-home.js';
import { formatMoney, formatQuantity, unitLabel } from '../sales/format.js';
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
import './pricing.css';

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

  if (!refs) {
    return (
      <section className="sale pr-screen" aria-busy="true">
        <PageHeader title={t('nav.screens.price_simulator')} />
        <SkeletonRows rows={3} />
      </section>
    );
  }

  const products = refs.products
    .filter((product) => product.is_sellable && product.status === 'ACTIVE')
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const product = products.find((candidate) => candidate.id === productId);
  const pricingUnit = product
    ? product.pricing_mode === 'PER_WEIGHT'
      ? 'KG'
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
    label: string,
    value: string,
    onChange: (value: string) => void,
    options: readonly { readonly value: string; readonly label: string }[],
    placeholder: string,
  ) => (
    <Field label={label}>
      {(control) => (
        <Select {...control} value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">{placeholder}</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );

  return (
    <section className="sale pr-screen">
      <PageHeader title={t('nav.screens.price_simulator')} subtitle={t('price_sim.hint')} />
      {pricesMayBeStale(refs.lastSyncAt, now) ? (
        <Banner tone="warn" role="status">
          {t('sales.stale_prices')}
        </Banner>
      ) : null}
      <div className="pr-sim">
        <div className="pr-sim-form pr-sim-main">
          {select(
            t('price_sim.product_label'),
            productId,
            setProductId,
            products.map((candidate) => ({ value: candidate.id, label: candidate.name })),
            t('loss.product_placeholder'),
          )}
          <div className="pr-pair">
            <Field label={t('price_sim.quantity_label', { unit: unitLabel(pricingUnit) || '—' })}>
              {(control) => (
                <Input
                  {...control}
                  inputMode="decimal"
                  value={quantityText}
                  onChange={(event) => setQuantityText(event.target.value)}
                />
              )}
            </Field>
            <Field label={t('price_sim.day_label')}>
              {(control) => (
                <Input
                  {...control}
                  type="date"
                  value={day}
                  onChange={(event) => setDay(event.target.value)}
                />
              )}
            </Field>
          </div>
          {product && quantityText && quantity === null ? (
            <p className="field-error">
              {simQuantityTooLarge(quantityText)
                ? t('price_sim.quantity_too_large', { max: formatQuantity(MAX_QUANTITY) })
                : t('loss.issue.QUANTITY_INVALID')}
            </p>
          ) : null}
        </div>

        {product && quantity !== null && at ? (
          <Card
            as="section"
            padded
            className="pr-result"
            aria-labelledby="price-sim-result"
            role="status"
          >
            <h2 id="price-sim-result">{t('price_sim.result_title')}</h2>
            <p className="muted">{instant?.now ? t('price_sim.at_now') : t('price_sim.at_noon')}</p>
            {winner ? (
              <>
                <p className="pr-result-price">
                  {t('price_sim.price', {
                    price: formatMoney(winner.unitPriceXaf),
                    unit: unitLabel(pricingUnit),
                  })}
                </p>
                {total !== null ? (
                  <p className="pr-result-total">
                    {t('price_sim.total', {
                      quantity: formatQuantity(quantity),
                      unit: unitLabel(pricingUnit, quantity),
                      total: formatMoney(total),
                    })}
                  </p>
                ) : (
                  <Banner tone="warn" role="status">
                    {t('price_sim.total_too_large')}
                  </Banner>
                )}
                <p className="muted">
                  {t('price_sim.rule', {
                    scope: describe(winner),
                    from: formatBusinessDay(businessDayOf(winner.validFrom)),
                  })}
                </p>
                {others.length > 0 ? (
                  <div className="pr-others">
                    <h3>{t('price_sim.others_title')}</h3>
                    <List>
                      {others.map((rule) => (
                        <ListRow
                          key={rule.id}
                          title={describe(rule)}
                          value={formatMoney(rule.unitPriceXaf)}
                        />
                      ))}
                    </List>
                  </div>
                ) : null}
              </>
            ) : (
              <Banner tone="warn" role="status">
                {t('price_sim.none')}
              </Banner>
            )}
          </Card>
        ) : null}

        <div className="pr-sim-form pr-sim-context">
          {select(
            t('price_sim.site_label'),
            siteId,
            setSiteId,
            sites.map((site) => ({ value: site.id, label: site.name })),
            t('price_sim.any'),
          )}
          {select(
            t('price_sim.zone_label'),
            zoneId,
            setZoneId,
            zones.map((zone) => ({ value: zone.id, label: zone.name })),
            t('price_sim.any'),
          )}
          {select(
            t('price_sim.category_label'),
            categoryId,
            setCategoryId,
            refs.customerCategories.map((category) => ({
              value: category.id,
              label: category.name,
            })),
            t('price_sim.any'),
          )}
          {select(
            t('price_sim.channel_label'),
            channelCode,
            setChannelCode,
            SIM_CHANNELS.map((code) => ({ value: code, label: t(`price_sim.channel.${code}`) })),
            t('price_sim.any'),
          )}
        </div>
      </div>
    </section>
  );
}
