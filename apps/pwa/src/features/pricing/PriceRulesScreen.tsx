/**
 * ECR-PRX-02 « Règles tarifaires » (responsable commercial, direction ; en ligne). Règles d'un produit
 * lues sur le serveur (en vigueur, brouillons, historique) ; rédaction d'une règle ou d'une nouvelle
 * version (jamais de modification, BR-PRX-007), activation et fin de validité par la Direction
 * (AV-062), conflit d'activation annoncé par le moteur partagé (BR-PRX-006).
 */
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { holdsAnyRole } from '../../app/screens.js';
import { clock } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatMoment } from '../home/format-home.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatMoney } from '../sales/format.js';
import { useSalesReferences, type SalesReferences } from '../sales/references.js';
import { submitCommand } from '../sales/submit.js';
import type { ProductData } from '../sales/types.js';
import { SIM_CHANNELS } from './price-sim.js';
import {
  checkRule,
  conflictsOf,
  doualaInstant,
  doualaLocal,
  formFrom,
  groupRules,
  ruleDimensions,
  type RuleForm,
  type RuleView,
} from './rules.js';
import { describeScope } from './scope.js';

const DIRECTION = ['DIRECTION'];
const ACTIVATION_TOLERANCE_MS = 5 * 60 * 1000;

/** Règles du produit lues en ligne ; `undefined` pendant la lecture, `null` si indisponible. */
function useProductRules(
  productId: string,
  online: boolean,
  reloadKey: string,
): readonly RuleView[] | null | undefined {
  const [state, setState] = useState<{
    productId: string;
    key: string;
    rules: readonly RuleView[] | null;
  }>();
  const key = `${productId}:${reloadKey}`;
  useEffect(() => {
    if (!productId || !online) return;
    let cancelled = false;
    void authorizedRequest<{ price_rules?: RuleView[] }>(
      getDb(),
      `/api/v1/price-rules?product_id=${encodeURIComponent(productId)}`,
      { method: 'GET' },
    ).then((result) => {
      if (!cancelled) {
        setState({ productId, key, rules: result.ok ? (result.data.price_rules ?? []) : null });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [key, online, productId]);
  if (!productId || !online) return null;
  // Relecture après une opération : la liste précédente du même produit reste affichée.
  return state?.productId === productId ? state.rules : undefined;
}

function emptyForm(product: ProductData): RuleForm {
  return {
    code: '',
    unitPriceText: '',
    pricingUnitCode: product.pricing_mode === 'PER_WEIGHT' ? 'KG' : product.base_unit_code,
    siteId: '',
    zoneId: '',
    customerCategoryId: '',
    channelCode: '',
    minQuantityText: '',
    priorityText: '0',
    validFrom: doualaLocal(new Date(clock.now().getTime() + 10 * 60 * 1000)),
    validTo: '',
    notes: '',
  };
}

interface EditorProps {
  readonly refs: SalesReferences;
  readonly product: ProductData;
  readonly rules: readonly RuleView[];
  readonly superseded: RuleView | null;
  readonly onCancel: () => void;
  readonly onSubmit: (input: Parameters<typeof submitCommand>[0]) => Promise<void>;
  readonly userId: string;
  readonly blocked: boolean;
}

function RuleEditor({
  refs,
  product,
  rules,
  superseded,
  onCancel,
  onSubmit,
  userId,
  blocked,
}: EditorProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState<RuleForm>(() =>
    superseded
      ? formFrom(superseded, new Date(clock.now().getTime() + 10 * 60 * 1000))
      : emptyForm(product),
  );
  const ids = {
    code: useId(),
    price: useId(),
    site: useId(),
    zone: useId(),
    category: useId(),
    channel: useId(),
    min: useId(),
    priority: useId(),
    from: useId(),
    to: useId(),
    notes: useId(),
  };
  const check = checkRule(form, superseded === null);
  const update = (patch: Partial<RuleForm>) => setForm((current) => ({ ...current, ...patch }));
  const candidate: RuleView | null =
    check.issues.length === 0
      ? {
          id: 'candidate',
          code: form.code,
          version: 0,
          productId: product.id,
          unitPriceXaf: check.unitPriceXaf as number,
          pricingUnitCode: form.pricingUnitCode,
          zoneId: form.zoneId || null,
          siteId: form.siteId || null,
          customerCategoryId: form.customerCategoryId || null,
          channelCode: form.channelCode || null,
          minQuantity: check.minQuantity,
          commercialCampaignId: null,
          priority: check.priority,
          specificity: 0,
          validFrom: check.validFrom as string,
          validTo: check.validTo,
          status: 'DRAFT',
        }
      : null;
  const conflicts = candidate
    ? conflictsOf(candidate, rules, refs.zones, superseded?.id ?? null)
    : [];
  const ready = check.issues.length === 0 && !blocked;

  const submit = () => {
    if (!ready) return;
    const dimensions = ruleDimensions(product.id, form, check);
    void onSubmit(
      superseded
        ? {
            authorUserId: userId,
            commandType: 'pricing.rule.supersede',
            aggregateType: 'PRICE_RULE',
            payload: { ...dimensions, supersedesRuleId: superseded.id },
          }
        : {
            authorUserId: userId,
            commandType: 'pricing.rule.draft',
            aggregateType: 'PRICE_RULE',
            payload: { ...dimensions, code: form.code.trim() },
          },
    );
  };

  const select = (
    id: string,
    label: string,
    value: string,
    onChange: (value: string) => void,
    options: readonly { readonly value: string; readonly label: string }[],
  ) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="text-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{t('price_rules.any')}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <section className="sale-block" aria-labelledby="price-rule-editor-title">
      <h2 id="price-rule-editor-title">
        {superseded
          ? t('price_rules.supersede_title', { code: superseded.code, version: superseded.version })
          : t('price_rules.draft_title')}
      </h2>
      {superseded === null ? (
        <div className="field">
          <label htmlFor={ids.code}>{t('price_rules.code_label')}</label>
          <input
            id={ids.code}
            className="text-input"
            maxLength={40}
            value={form.code}
            onChange={(event) => update({ code: event.target.value })}
          />
        </div>
      ) : null}
      <div className="field">
        <label htmlFor={ids.price}>
          {t('price_rules.price_label', { unit: form.pricingUnitCode })}
        </label>
        <input
          id={ids.price}
          className="text-input"
          inputMode="numeric"
          value={form.unitPriceText}
          onChange={(event) => update({ unitPriceText: event.target.value })}
        />
      </div>
      {select(
        ids.site,
        t('price_sim.site_label'),
        form.siteId,
        (siteId) => update({ siteId }),
        [...refs.sites.values()]
          .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
          .map((site) => ({ value: site.id, label: site.name })),
      )}
      {select(
        ids.zone,
        t('price_sim.zone_label'),
        form.zoneId,
        (zoneId) => update({ zoneId }),
        [...refs.zones.values()]
          .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
          .map((zone) => ({ value: zone.id, label: zone.name })),
      )}
      {select(
        ids.category,
        t('price_sim.category_label'),
        form.customerCategoryId,
        (customerCategoryId) => update({ customerCategoryId }),
        refs.customerCategories.map((category) => ({ value: category.id, label: category.name })),
      )}
      {select(
        ids.channel,
        t('price_sim.channel_label'),
        form.channelCode,
        (channelCode) => update({ channelCode }),
        SIM_CHANNELS.map((code) => ({ value: code, label: t(`price_sim.channel.${code}`) })),
      )}
      <div className="line-fields">
        <div className="field">
          <label htmlFor={ids.min}>
            {t('price_rules.min_quantity_label', { unit: form.pricingUnitCode })}
          </label>
          <input
            id={ids.min}
            className="text-input"
            inputMode="decimal"
            value={form.minQuantityText}
            onChange={(event) => update({ minQuantityText: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor={ids.priority}>{t('price_rules.priority_label')}</label>
          <input
            id={ids.priority}
            className="text-input"
            inputMode="numeric"
            value={form.priorityText}
            onChange={(event) => update({ priorityText: event.target.value })}
          />
        </div>
      </div>
      <div className="line-fields">
        <div className="field">
          <label htmlFor={ids.from}>{t('price_rules.valid_from_label')}</label>
          <input
            id={ids.from}
            type="datetime-local"
            className="text-input"
            value={form.validFrom}
            onChange={(event) => update({ validFrom: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor={ids.to}>{t('price_rules.valid_to_label')}</label>
          <input
            id={ids.to}
            type="datetime-local"
            className="text-input"
            value={form.validTo}
            onChange={(event) => update({ validTo: event.target.value })}
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor={ids.notes}>{t('price_rules.notes_label')}</label>
        <input
          id={ids.notes}
          className="text-input"
          maxLength={2000}
          value={form.notes}
          onChange={(event) => update({ notes: event.target.value })}
        />
      </div>
      {check.issues.map((issue) => (
        <p key={issue} className="error-message">
          {t(`price_rules.issue.${issue}`)}
        </p>
      ))}
      {conflicts.length > 0 ? (
        <p className="text-warn" role="status">
          {t('price_rules.conflict_warning', { count: conflicts.length })}
        </p>
      ) : null}
      <div className="result-actions">
        <button type="button" className="btn-block submit-sale" disabled={!ready} onClick={submit}>
          {superseded ? t('price_rules.submit_supersede') : t('price_rules.submit_draft')}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          {t('price_rules.cancel')}
        </button>
      </div>
    </section>
  );
}

export function PriceRulesScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const navigation = useRememberedNavigation(userId);
  const refs = useSalesReferences();
  const online = useOnline();
  const [productId, setProductId] = useState('');
  const [editing, setEditing] = useState<{ superseded: RuleView | null } | null>(null);
  const [ending, setEnding] = useState<{ ruleId: string; value: string } | null>(null);
  const [last, setLast] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const productSelectId = useId();
  const endId = useId();
  const lastStatus = refs?.outbox.find((command) => command.command_id === last)?.status ?? '';
  const rules = useProductRules(productId, online, `${last ?? ''}:${lastStatus}`);

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.price_rules')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const now = clock.now();
  const roles = navigation ? navigation.roles : [];
  const director = holdsAnyRole(roles, DIRECTION);
  const products = refs.products
    .filter((product) => product.is_sellable && product.status === 'ACTIVE')
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const product = products.find((candidate) => candidate.id === productId);
  const settling =
    last !== undefined && !refs.outbox.some((command) => command.command_id === last);
  const blocked = busy || settling;
  const grouped = rules ? groupRules(rules, now) : null;

  const send = async (input: Parameters<typeof submitCommand>[0]) => {
    if (blocked) return;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand(input);
      setLast(command.command_id);
      setEditing(null);
      setEnding(null);
    } catch {
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  };

  const activate = (rule: RuleView) =>
    void send({
      authorUserId: userId,
      commandType: 'pricing.rule.activate',
      aggregateType: 'PRICE_RULE',
      aggregateId: rule.id,
      payload: {},
    });

  const describe = (rule: RuleView) => describeScope(rule, refs, rule.pricingUnitCode, t);
  const period = (rule: RuleView) =>
    rule.validTo
      ? t('price_rules.period_bounded', {
          from: formatMoment(rule.validFrom, ''),
          to: formatMoment(rule.validTo, ''),
        })
      : t('price_rules.period_open', { from: formatMoment(rule.validFrom, '') });

  const ruleRow = (rule: RuleView, actions: ReactNode) => (
    <li key={rule.id} className="line-card" aria-label={`${rule.code} v${rule.version}`}>
      <div className="line-head">
        <strong>
          {t('price_rules.price', {
            price: formatMoney(rule.unitPriceXaf),
            unit: rule.pricingUnitCode,
          })}
        </strong>
        <span className="badge badge-info">
          {rule.code} v{rule.version}
        </span>
      </div>
      <p className="home-muted">{describe(rule)}</p>
      <p className="home-muted">{period(rule)}</p>
      {actions}
    </li>
  );

  return (
    <section className="sale">
      <h1>{t('nav.screens.price_rules')}</h1>
      {!online ? (
        <p className="alert alert-error" role="alert">
          {t('price_rules.online_only')}
        </p>
      ) : null}
      {last ? <CommandResult commandId={last} messages="price_rules.result" /> : null}
      <div className="field">
        <label htmlFor={productSelectId}>{t('price_sim.product_label')}</label>
        <select
          id={productSelectId}
          className="text-input"
          value={productId}
          onChange={(event) => {
            setProductId(event.target.value);
            setEditing(null);
            setEnding(null);
          }}
        >
          <option value="">{t('loss.product_placeholder')}</option>
          {products.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </div>
      {saveError ? (
        <p className="alert alert-error" role="alert">
          {t('sales.error_local_save')}
        </p>
      ) : null}
      {product && online && rules === undefined ? (
        <p className="home-muted">{t('price_rules.loading')}</p>
      ) : null}
      {product && online && rules === null ? (
        <p className="alert alert-error">{t('price_rules.unavailable')}</p>
      ) : null}
      {product && rules && grouped && editing ? (
        <RuleEditor
          refs={refs}
          product={product}
          rules={rules}
          superseded={editing.superseded}
          onCancel={() => setEditing(null)}
          onSubmit={send}
          userId={userId}
          blocked={blocked || !online}
        />
      ) : null}
      {product && rules && grouped && !editing ? (
        <>
          <button
            type="button"
            className="btn-block"
            disabled={!online || blocked}
            onClick={() => setEditing({ superseded: null })}
          >
            {t('price_rules.new_rule')}
          </button>
          <section className="sale-block" aria-labelledby="price-rules-active-title">
            <h2 id="price-rules-active-title">{t('price_rules.active_title')}</h2>
            {grouped.active.length === 0 ? (
              <p className="home-muted">{t('price_rules.none')}</p>
            ) : (
              <ul className="line-list">
                {grouped.active.map((rule) =>
                  ruleRow(
                    rule,
                    <div className="result-actions">
                      <button
                        type="button"
                        className="secondary"
                        disabled={!online || blocked}
                        onClick={() => setEditing({ superseded: rule })}
                      >
                        {t('price_rules.supersede')}
                      </button>
                      {director ? (
                        ending?.ruleId === rule.id ? (
                          <div className="field">
                            <label htmlFor={endId}>{t('price_rules.end_label')}</label>
                            <input
                              id={endId}
                              type="datetime-local"
                              className="text-input"
                              value={ending.value}
                              onChange={(event) =>
                                setEnding({ ruleId: rule.id, value: event.target.value })
                              }
                            />
                            <button
                              type="button"
                              className="secondary"
                              disabled={
                                !online ||
                                blocked ||
                                !doualaInstant(ending.value) ||
                                (rule.validTo !== null &&
                                  (doualaInstant(ending.value) as string) >= rule.validTo)
                              }
                              onClick={() =>
                                void send({
                                  authorUserId: userId,
                                  commandType: 'pricing.rule.end',
                                  aggregateType: 'PRICE_RULE',
                                  aggregateId: rule.id,
                                  payload: { validTo: doualaInstant(ending.value) as string },
                                })
                              }
                            >
                              {t('price_rules.end_confirm')}
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="secondary"
                            disabled={!online || blocked}
                            onClick={() => setEnding({ ruleId: rule.id, value: doualaLocal(now) })}
                          >
                            {t('price_rules.end')}
                          </button>
                        )
                      ) : null}
                    </div>,
                  ),
                )}
              </ul>
            )}
          </section>
          <section className="sale-block" aria-labelledby="price-rules-drafts-title">
            <h2 id="price-rules-drafts-title">{t('price_rules.drafts_title')}</h2>
            {grouped.drafts.length === 0 ? (
              <p className="home-muted">{t('price_rules.none')}</p>
            ) : (
              <ul className="line-list">
                {grouped.drafts.map((rule) => {
                  const conflicts = conflictsOf(rule, rules, refs.zones, null);
                  const retroactive =
                    new Date(rule.validFrom).getTime() < now.getTime() - ACTIVATION_TOLERANCE_MS;
                  return ruleRow(
                    rule,
                    <>
                      {conflicts.length > 0 ? (
                        <p className="text-warn">
                          {t('price_rules.conflict_warning', { count: conflicts.length })}
                        </p>
                      ) : null}
                      {retroactive ? (
                        <p className="text-warn">{t('price_rules.retroactive')}</p>
                      ) : null}
                      {director ? (
                        <button
                          type="button"
                          className="secondary"
                          disabled={!online || blocked || conflicts.length > 0 || retroactive}
                          onClick={() => activate(rule)}
                        >
                          {t('price_rules.activate')}
                        </button>
                      ) : (
                        <p className="home-muted">{t('price_rules.activation_by_direction')}</p>
                      )}
                    </>,
                  );
                })}
              </ul>
            )}
          </section>
          {grouped.history.length > 0 ? (
            <section className="sale-block" aria-labelledby="price-rules-history-title">
              <h2 id="price-rules-history-title">{t('price_rules.history_title')}</h2>
              <ul className="line-list">{grouped.history.map((rule) => ruleRow(rule, null))}</ul>
            </section>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
