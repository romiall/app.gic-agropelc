/**
 * ECR-PRX-01 « Catalogue produits, unités, conditionnements » (administrateur ; en ligne). Unités,
 * catégories de produit, produits (création, désactivation, réactivation), conditionnements
 * (immuables, BR-CAT-004) et motifs (référentiel des écrans de perte, visite, rejet, inventaire…).
 * Les listes se lisent sur le serveur (`GET /units`, `/products`, `/reason-codes`) et sur l'appareil
 * (catégories, conditionnements) ; elles sont relues après chaque opération et la dernière liste lue
 * reste affichée pendant une coupure (saisie conservée, envoi bloqué). Un code déjà pris ou encore en
 * attente d'envoi est refusé (la base lèverait une violation d'unicité, S-31) ; l'opération suivante
 * attend la réponse définitive de la précédente, même après un retour sur l'écran.
 */
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useOnline } from '../../platform/useOnline.js';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { useAuth } from '../auth/AuthContext.js';
import { CommandResult } from '../sales/CommandResult.js';
import { useSalesReferences, type SalesReferences } from '../sales/references.js';
import { phaseOf, submitCommand } from '../sales/submit.js';
import type { ProductCategoryData } from '../sales/types.js';
import {
  categoryPayload,
  checkCategory,
  checkPackaging,
  checkProduct,
  checkReason,
  checkUnit,
  EMPTY_PRODUCT,
  LOSS_CATEGORIES,
  LOT_TRACKINGS,
  pendingCatalogCodes,
  PRICING_MODES,
  productPayload,
  reasonPayload,
  REASON_CATEGORIES,
  SPECIES,
  STOCK_FAMILIES,
  unitPayload,
  type ProductForm,
  type ProductView,
  type ReasonView,
  type UnitView,
} from './catalog.js';

type Section = 'PRODUCTS' | 'UNITS' | 'CATEGORIES' | 'PACKAGING' | 'REASONS';
const SECTIONS: readonly Section[] = ['PRODUCTS', 'UNITS', 'CATEGORIES', 'PACKAGING', 'REASONS'];

const isActiveCategory = (category: ProductCategoryData) =>
  category.is_active === undefined || Boolean(category.is_active);

/**
 * Liste lue en ligne : la dernière liste reçue (`undefined` avant la première), gardée quand une
 * relecture échoue ou que le réseau tombe, et l'échec de la dernière lecture.
 */
function useOnlineList<T>(
  path: string,
  field: string,
  online: boolean,
  reloadKey: string,
): { readonly items: readonly T[] | undefined; readonly failed: boolean } {
  const [state, setState] = useState<{ items: readonly T[] | undefined; failed: boolean }>({
    items: undefined,
    failed: false,
  });
  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    void authorizedRequest<Record<string, T[] | undefined>>(getDb(), path, { method: 'GET' }).then(
      (result) => {
        if (cancelled) return;
        setState((current) =>
          result.ok
            ? { items: result.data[field] ?? [], failed: false }
            : { items: current.items, failed: true },
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path, field, online, reloadKey]);
  return state;
}

interface SectionProps {
  readonly refs: SalesReferences;
  readonly units: readonly UnitView[];
  readonly products: readonly ProductView[];
  readonly reasons: readonly ReasonView[];
  readonly send: (input: Parameters<typeof submitCommand>[0]) => Promise<boolean>;
  readonly blocked: boolean;
  readonly userId: string;
  /** Codes des créations encore en attente (un doublon serait renvoyé sans fin). */
  readonly pending: ReturnType<typeof pendingCatalogCodes>;
}

function Issues({ issues, prefix }: { issues: readonly string[]; prefix: string }) {
  const { t } = useTranslation();
  return (
    <>
      {issues.map((issue) => (
        <p key={issue} className="error-message">
          {t(`${prefix}.${issue}`)}
        </p>
      ))}
    </>
  );
}

function UnitsSection({ units, send, blocked, userId, pending }: SectionProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ code: '', name: '', isCount: true });
  const ids = { code: useId(), name: useId() };
  const issues = checkUnit(form, [
    ...units,
    ...pending.units.map((code) => ({ code, name: '', isCount: true, isActive: true })),
  ]);
  const touched = form.code !== '' || form.name !== '';
  const submit = () =>
    void send({
      authorUserId: userId,
      commandType: 'catalog.unit.create',
      aggregateType: 'UNIT',
      payload: unitPayload(form),
    }).then((ok) => {
      if (ok) setForm({ code: '', name: '', isCount: true });
    });
  return (
    <>
      <ul className="receipt-lines">
        {units.map((unit) => (
          <li key={unit.code}>
            <span>
              <strong>{unit.code}</strong>
              <small>{unit.name}</small>
            </span>
            <span>{unit.isCount ? t('catalog.count_unit') : t('catalog.measure_unit')}</span>
          </li>
        ))}
      </ul>
      <h3>{t('catalog.new_unit')}</h3>
      <div className="line-fields">
        <div className="field">
          <label htmlFor={ids.code}>{t('catalog.code_label')}</label>
          <input
            id={ids.code}
            className="text-input"
            maxLength={20}
            value={form.code}
            onChange={(event) => setForm((current) => ({ ...current, code: event.target.value }))}
          />
        </div>
        <div className="field">
          <label htmlFor={ids.name}>{t('catalog.name_label')}</label>
          <input
            id={ids.name}
            className="text-input"
            maxLength={60}
            value={form.name}
            onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
          />
        </div>
      </div>
      <label className="choice">
        <input
          type="checkbox"
          checked={form.isCount}
          onChange={(event) =>
            setForm((current) => ({ ...current, isCount: event.target.checked }))
          }
        />
        {t('catalog.is_count_label')}
      </label>
      {touched ? <Issues issues={issues} prefix="catalog.issue" /> : null}
      <button
        type="button"
        className="btn-block"
        disabled={issues.length > 0 || blocked}
        onClick={submit}
      >
        {t('catalog.create_unit')}
      </button>
    </>
  );
}

function CategoriesSection({ refs, send, blocked, userId, pending }: SectionProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ code: '', name: '', parentId: '' });
  const ids = { code: useId(), name: useId(), parent: useId() };
  const known = new Set(refs.productCategories.map((category) => category.code));
  // Catégories créées et pas encore tirées : affichées « en attente », leur code est pris.
  const waiting = pending.categories.filter((code) => !known.has(code));
  const issues = checkCategory(form, [...known, ...waiting]);
  const touched = form.code !== '' || form.name !== '';
  const names = new Map(refs.productCategories.map((category) => [category.id, category.name]));
  const submit = () =>
    void send({
      authorUserId: userId,
      commandType: 'catalog.product_category.create',
      aggregateType: 'PRODUCT_CATEGORY',
      payload: categoryPayload(form),
    }).then((ok) => {
      if (ok) setForm({ code: '', name: '', parentId: '' });
    });
  return (
    <>
      {refs.productCategories.length === 0 && waiting.length === 0 ? (
        <p className="home-muted">{t('catalog.none')}</p>
      ) : (
        <ul className="receipt-lines">
          {refs.productCategories.map((category) => (
            <li key={category.id}>
              <span>
                <strong>{category.name}</strong>
                <small>{category.code}</small>
              </span>
              <span>{category.parent_id ? (names.get(category.parent_id) ?? '') : ''}</span>
            </li>
          ))}
          {waiting.map((code) => (
            <li key={`attente-${code}`}>
              <span>
                <strong>{code}</strong>
              </span>
              <span>{t('catalog.pending')}</span>
            </li>
          ))}
        </ul>
      )}
      <h3>{t('catalog.new_category')}</h3>
      <div className="line-fields">
        <div className="field">
          <label htmlFor={ids.code}>{t('catalog.code_label')}</label>
          <input
            id={ids.code}
            className="text-input"
            maxLength={40}
            value={form.code}
            onChange={(event) => setForm((current) => ({ ...current, code: event.target.value }))}
          />
        </div>
        <div className="field">
          <label htmlFor={ids.name}>{t('catalog.name_label')}</label>
          <input
            id={ids.name}
            className="text-input"
            maxLength={200}
            value={form.name}
            onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor={ids.parent}>{t('catalog.parent_label')}</label>
        <select
          id={ids.parent}
          className="text-input"
          value={form.parentId}
          onChange={(event) => setForm((current) => ({ ...current, parentId: event.target.value }))}
        >
          <option value="">{t('catalog.no_parent')}</option>
          {refs.productCategories.filter(isActiveCategory).map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </div>
      {touched ? <Issues issues={issues} prefix="catalog.issue" /> : null}
      <button
        type="button"
        className="btn-block"
        disabled={issues.length > 0 || blocked}
        onClick={submit}
      >
        {t('catalog.create_category')}
      </button>
    </>
  );
}

function ProductsSection({ refs, units, products, send, blocked, userId, pending }: SectionProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState<ProductForm>(EMPTY_PRODUCT);
  const [creating, setCreating] = useState(false);
  const ids = {
    code: useId(),
    name: useId(),
    category: useId(),
    family: useId(),
    unit: useId(),
    lot: useId(),
    mode: useId(),
    species: useId(),
  };
  const issues = checkProduct(form, [
    ...products,
    ...pending.products.map((code) => ({ code }) as ProductView),
  ]);
  const update = (patch: Partial<ProductForm>) => setForm((current) => ({ ...current, ...patch }));
  const toggle = (product: ProductView) =>
    void send({
      authorUserId: userId,
      commandType:
        product.status === 'ACTIVE' ? 'catalog.product.deactivate' : 'catalog.product.reactivate',
      aggregateType: 'PRODUCT',
      aggregateId: product.id,
      payload: {},
    });
  const submit = () =>
    void send({
      authorUserId: userId,
      commandType: 'catalog.product.create',
      aggregateType: 'PRODUCT',
      payload: productPayload(form),
    }).then((ok) => {
      if (ok) {
        setForm(EMPTY_PRODUCT);
        setCreating(false);
      }
    });
  const flag = (
    key: 'isSellable' | 'isPurchasable' | 'isProducible' | 'isConsumable' | 'expiryTracking',
  ) => (
    <label className="choice" key={key}>
      <input
        type="checkbox"
        checked={form[key]}
        onChange={(event) => update({ [key]: event.target.checked } as Partial<ProductForm>)}
      />
      {t(`catalog.flag.${key}`)}
    </label>
  );
  const select = (
    id: string,
    label: string,
    value: string,
    options: readonly { readonly value: string; readonly label: string }[],
    onChange: (value: string) => void,
    placeholder?: string,
  ) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="text-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <>
      {products.length === 0 ? (
        <p className="home-muted">{t('catalog.none')}</p>
      ) : (
        <ul className="receipt-lines">
          {products.map((product) => (
            <li key={product.id}>
              <span>
                <strong>{product.name}</strong>
                <small>
                  {product.code} · {t(`catalog.family.${product.stockFamily}`)} ·{' '}
                  {product.baseUnitCode}
                </small>
              </span>
              <span>
                {t(`catalog.status.${product.status}`, { defaultValue: product.status })}
                <button
                  type="button"
                  className="link-button"
                  disabled={blocked}
                  aria-label={t(
                    product.status === 'ACTIVE' ? 'catalog.deactivate' : 'catalog.reactivate',
                    { name: product.name },
                  )}
                  onClick={() => toggle(product)}
                >
                  {t(
                    product.status === 'ACTIVE'
                      ? 'catalog.deactivate_short'
                      : 'catalog.reactivate_short',
                  )}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {!creating ? (
        <button type="button" className="btn-block" onClick={() => setCreating(true)}>
          {t('catalog.new_product')}
        </button>
      ) : (
        <>
          <h3>{t('catalog.new_product')}</h3>
          <div className="line-fields">
            <div className="field">
              <label htmlFor={ids.code}>{t('catalog.code_label')}</label>
              <input
                id={ids.code}
                className="text-input"
                maxLength={40}
                value={form.code}
                onChange={(event) => update({ code: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor={ids.name}>{t('catalog.name_label')}</label>
              <input
                id={ids.name}
                className="text-input"
                maxLength={200}
                value={form.name}
                onChange={(event) => update({ name: event.target.value })}
              />
            </div>
          </div>
          {select(
            ids.category,
            t('catalog.category_label'),
            form.categoryId,
            refs.productCategories.filter(isActiveCategory).map((category) => ({
              value: category.id,
              label: category.name,
            })),
            (categoryId) => update({ categoryId }),
            t('catalog.choose'),
          )}
          {select(
            ids.family,
            t('catalog.family_label'),
            form.stockFamily,
            STOCK_FAMILIES.map((family) => ({
              value: family,
              label: t(`catalog.family.${family}`),
            })),
            (stockFamily) =>
              // Un produit biologique se suit par lot (lots de production, BR-PRD-001), un service
              // jamais (BR-CAT-005) : le suivi est réglé avec la famille.
              update({
                stockFamily: stockFamily as ProductForm['stockFamily'],
                ...(stockFamily === 'BIOLOGIQUE'
                  ? { lotTracking: 'REQUIRED' as const }
                  : stockFamily === 'SERVICE'
                    ? { lotTracking: 'NONE' as const }
                    : {}),
              }),
          )}
          {select(
            ids.unit,
            t('catalog.base_unit_label'),
            form.baseUnitCode,
            units
              .filter((unit) => unit.isActive)
              .map((unit) => ({ value: unit.code, label: `${unit.code} — ${unit.name}` })),
            (baseUnitCode) => update({ baseUnitCode }),
            t('catalog.choose'),
          )}
          {form.stockFamily !== 'SERVICE'
            ? select(
                ids.lot,
                t('catalog.lot_label'),
                form.lotTracking,
                LOT_TRACKINGS.map((value) => ({ value, label: t(`catalog.lot.${value}`) })),
                (lotTracking) => update({ lotTracking: lotTracking as ProductForm['lotTracking'] }),
              )
            : null}
          {select(
            ids.mode,
            t('catalog.pricing_mode_label'),
            form.pricingMode,
            PRICING_MODES.map((value) => ({ value, label: t(`catalog.pricing_mode.${value}`) })),
            (pricingMode) => update({ pricingMode: pricingMode as ProductForm['pricingMode'] }),
          )}
          {form.stockFamily === 'BIOLOGIQUE'
            ? select(
                ids.species,
                t('catalog.species_label'),
                form.species,
                SPECIES.map((value) => ({ value, label: t(`catalog.species.${value}`) })),
                (species) => update({ species }),
                t('catalog.choose'),
              )
            : null}
          <fieldset className="choice-group">
            <legend>{t('catalog.flags_label')}</legend>
            {(
              [
                'isSellable',
                'isPurchasable',
                'isProducible',
                'isConsumable',
                'expiryTracking',
              ] as const
            ).map(flag)}
          </fieldset>
          <p className="home-muted">{t('catalog.immutable_hint')}</p>
          {form.code || form.name ? <Issues issues={issues} prefix="catalog.issue" /> : null}
          <div className="result-actions">
            <button
              type="button"
              className="btn-block submit-sale"
              disabled={issues.length > 0 || blocked}
              onClick={submit}
            >
              {t('catalog.create_product')}
            </button>
            <button type="button" className="secondary" onClick={() => setCreating(false)}>
              {t('price_rules.cancel')}
            </button>
          </div>
        </>
      )}
    </>
  );
}

function PackagingSection({ refs, units, products, send, blocked, userId }: SectionProps) {
  const { t } = useTranslation();
  const [productId, setProductId] = useState('');
  const [form, setForm] = useState({
    unitCode: '',
    factorText: '',
    isSalesUnit: true,
    isPurchaseUnit: false,
    isCountUnit: false,
  });
  const ids = { product: useId(), unit: useId(), factor: useId() };
  const product = products.find((candidate) => candidate.id === productId);
  const existing = refs.productUnits;
  const check = checkPackaging(
    { productId, ...form },
    product,
    existing,
    units.find((unit) => unit.code === product?.baseUnitCode)?.isCount ?? false,
  );
  const touched = form.unitCode !== '' || form.factorText !== '';
  const submit = () => {
    if (!product || check.factor === null) return;
    void send({
      authorUserId: userId,
      commandType: 'catalog.product_unit.set',
      aggregateType: 'PRODUCT_UNIT',
      payload: {
        productId: product.id,
        unitCode: form.unitCode,
        factorToBase: check.factor,
        isSalesUnit: form.isSalesUnit,
        isPurchaseUnit: form.isPurchaseUnit,
        isCountUnit: form.isCountUnit,
      },
    }).then((ok) => {
      if (ok) setForm((current) => ({ ...current, unitCode: '', factorText: '' }));
    });
  };
  const flag = (key: 'isSalesUnit' | 'isPurchaseUnit' | 'isCountUnit') => (
    <label className="choice" key={key}>
      <input
        type="checkbox"
        checked={form[key]}
        onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.checked }))}
      />
      {t(`catalog.packaging_flag.${key}`)}
    </label>
  );
  return (
    <>
      <div className="field">
        <label htmlFor={ids.product}>{t('catalog.product_label')}</label>
        <select
          id={ids.product}
          className="text-input"
          value={productId}
          onChange={(event) => setProductId(event.target.value)}
        >
          <option value="">{t('catalog.choose')}</option>
          {products.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </div>
      {product ? (
        <>
          <ul className="receipt-lines">
            {existing
              .filter((unit) => unit.product_id === product.id)
              .map((unit) => (
                <li key={unit.id}>
                  <span>
                    <strong>{unit.unit_code}</strong>
                    <small>
                      {t('catalog.factor', {
                        factor: Number(unit.factor_to_base),
                        unit: product.baseUnitCode,
                      })}
                    </small>
                  </span>
                  <span>{unit.is_active ? '' : t('catalog.status.INACTIVE')}</span>
                </li>
              ))}
          </ul>
          <h3>{t('catalog.new_packaging')}</h3>
          <div className="line-fields">
            <div className="field">
              <label htmlFor={ids.unit}>{t('catalog.unit_label')}</label>
              <select
                id={ids.unit}
                className="text-input"
                value={form.unitCode}
                onChange={(event) =>
                  setForm((current) => ({ ...current, unitCode: event.target.value }))
                }
              >
                <option value="">{t('catalog.choose')}</option>
                {units
                  .filter((unit) => unit.isActive && unit.code !== product.baseUnitCode)
                  .map((unit) => (
                    <option key={unit.code} value={unit.code}>
                      {unit.code} — {unit.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={ids.factor}>
                {t('catalog.factor_label', { unit: product.baseUnitCode })}
              </label>
              <input
                id={ids.factor}
                className="text-input"
                inputMode="decimal"
                value={form.factorText}
                onChange={(event) =>
                  setForm((current) => ({ ...current, factorText: event.target.value }))
                }
              />
            </div>
          </div>
          <fieldset className="choice-group">
            <legend>{t('catalog.packaging_use_label')}</legend>
            {(['isSalesUnit', 'isPurchaseUnit', 'isCountUnit'] as const).map(flag)}
          </fieldset>
          <p className="home-muted">{t('catalog.packaging_immutable')}</p>
          {touched ? <Issues issues={check.issues} prefix="catalog.issue" /> : null}
          <button
            type="button"
            className="btn-block"
            disabled={check.issues.length > 0 || blocked}
            onClick={submit}
          >
            {t('catalog.create_packaging')}
          </button>
        </>
      ) : null}
    </>
  );
}

function ReasonsSection({ reasons, send, blocked, userId, pending }: SectionProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState({
    category: 'VISIT_OUTCOME' as string,
    code: '',
    label: '',
    lossCategory: '',
    requiresComment: false,
  });
  const ids = { category: useId(), code: useId(), label: useId(), loss: useId() };
  const issues = checkReason(form, [
    ...reasons,
    ...pending.reasons.map((reason) => ({
      id: '',
      category: reason.category,
      code: reason.code,
      label: '',
      lossCategory: null,
      requiresComment: false,
      isActive: true,
    })),
  ]);
  const touched = form.code !== '' || form.label !== '';
  const listed = reasons.filter((reason) => reason.category === form.category);
  const submit = () =>
    void send({
      authorUserId: userId,
      commandType: 'catalog.reason_code.set',
      aggregateType: 'REASON_CODE',
      payload: reasonPayload(form),
    }).then((ok) => {
      if (ok) setForm((current) => ({ ...current, code: '', label: '', requiresComment: false }));
    });
  return (
    <>
      <div className="field">
        <label htmlFor={ids.category}>{t('catalog.reason_category_label')}</label>
        <select
          id={ids.category}
          className="text-input"
          value={form.category}
          onChange={(event) => setForm((current) => ({ ...current, category: event.target.value }))}
        >
          {REASON_CATEGORIES.map((category) => (
            <option key={category} value={category}>
              {t(`catalog.reason_category.${category}`)}
            </option>
          ))}
        </select>
      </div>
      {listed.length === 0 ? (
        <p className="home-muted">{t('catalog.none')}</p>
      ) : (
        <ul className="receipt-lines">
          {listed.map((reason) => (
            <li key={reason.id}>
              <span>
                <strong>{reason.label}</strong>
                <small>
                  {reason.code}
                  {reason.lossCategory
                    ? ` · ${t(`loss.categories.${reason.lossCategory}`, { defaultValue: reason.lossCategory })}`
                    : ''}
                </small>
              </span>
              <span>{reason.requiresComment ? t('catalog.requires_comment_short') : ''}</span>
            </li>
          ))}
        </ul>
      )}
      <h3>{t('catalog.new_reason')}</h3>
      <div className="line-fields">
        <div className="field">
          <label htmlFor={ids.code}>{t('catalog.code_label')}</label>
          <input
            id={ids.code}
            className="text-input"
            maxLength={40}
            value={form.code}
            onChange={(event) => setForm((current) => ({ ...current, code: event.target.value }))}
          />
        </div>
        <div className="field">
          <label htmlFor={ids.label}>{t('catalog.label_label')}</label>
          <input
            id={ids.label}
            className="text-input"
            maxLength={200}
            value={form.label}
            onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))}
          />
        </div>
      </div>
      {form.category === 'LOSS' ? (
        <div className="field">
          <label htmlFor={ids.loss}>{t('catalog.loss_category_label')}</label>
          <select
            id={ids.loss}
            className="text-input"
            value={form.lossCategory}
            onChange={(event) =>
              setForm((current) => ({ ...current, lossCategory: event.target.value }))
            }
          >
            <option value="">{t('catalog.any_loss')}</option>
            {LOSS_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {t(`loss.categories.${category}`, { defaultValue: category })}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <label className="choice">
        <input
          type="checkbox"
          checked={form.requiresComment}
          onChange={(event) =>
            setForm((current) => ({ ...current, requiresComment: event.target.checked }))
          }
        />
        {t('catalog.requires_comment_label')}
      </label>
      {touched ? <Issues issues={issues} prefix="catalog.issue" /> : null}
      <button
        type="button"
        className="btn-block"
        disabled={issues.length > 0 || blocked}
        onClick={submit}
      >
        {t('catalog.create_reason')}
      </button>
    </>
  );
}

export function CatalogScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
  const online = useOnline();
  const [section, setSection] = useState<Section>('PRODUCTS');
  const [last, setLast] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const lastStatus = refs?.outbox.find((command) => command.command_id === last)?.status ?? '';
  const reloadKey = `${last ?? ''}:${lastStatus}`;
  const units = useOnlineList<UnitView>('/api/v1/units', 'units', online, reloadKey);
  const products = useOnlineList<ProductView>('/api/v1/products', 'products', online, reloadKey);
  const reasons = useOnlineList<ReasonView>(
    '/api/v1/reason-codes',
    'reason_codes',
    online,
    reloadKey,
  );

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.catalog')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const settling =
    last !== undefined && !refs.outbox.some((command) => command.command_id === last);
  // Une opération du catalogue de l'utilisateur encore sans réponse bloque la suivante, même après
  // un retour sur l'écran.
  const waiting = refs.outbox.some(
    (command) =>
      command.command_type.startsWith('catalog.') &&
      command.author_user_id === userId &&
      phaseOf(command) === 'WAITING',
  );
  const blocked = busy || settling || waiting || !online;
  const pending = pendingCatalogCodes(refs.outbox);
  const send = async (input: Parameters<typeof submitCommand>[0]) => {
    if (blocked) return false;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand(input);
      setLast(command.command_id);
      return true;
    } catch {
      setSaveError(true);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const loaded = units.items && products.items && reasons.items;
  const props: SectionProps | null =
    units.items && products.items && reasons.items
      ? {
          refs,
          units: units.items,
          products: products.items,
          reasons: reasons.items,
          send,
          blocked,
          userId,
          pending,
        }
      : null;
  const failed = units.failed || products.failed || reasons.failed;

  return (
    <section className="sale">
      <h1>{t('nav.screens.catalog')}</h1>
      {!online ? (
        <p className="alert alert-error" role="alert">
          {t('catalog.online_only')}
        </p>
      ) : null}
      {last ? <CommandResult commandId={last} messages="catalog.result" /> : null}
      <fieldset className="choice-group">
        <legend>{t('catalog.section_label')}</legend>
        {SECTIONS.map((value) => (
          <label key={value} className="choice">
            <input
              type="radio"
              name="catalog-section"
              value={value}
              checked={section === value}
              onChange={() => setSection(value)}
            />
            {t(`catalog.section.${value}`)}
          </label>
        ))}
      </fieldset>
      {saveError ? (
        <p className="alert alert-error" role="alert">
          {t('sales.error_local_save')}
        </p>
      ) : null}
      {online && failed ? <p className="alert alert-error">{t('catalog.unavailable')}</p> : null}
      {online && !loaded && !failed ? <p className="home-muted">{t('sales.loading')}</p> : null}
      {props ? (
        <section className="sale-block" aria-label={t(`catalog.section.${section}`)}>
          {section === 'PRODUCTS' ? <ProductsSection {...props} /> : null}
          {section === 'UNITS' ? <UnitsSection {...props} /> : null}
          {section === 'CATEGORIES' ? <CategoriesSection {...props} /> : null}
          {section === 'PACKAGING' ? <PackagingSection {...props} /> : null}
          {section === 'REASONS' ? <ReasonsSection {...props} /> : null}
        </section>
      ) : null}
    </section>
  );
}
