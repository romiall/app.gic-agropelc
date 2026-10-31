/**
 * ECR-PRX-01 « Catalogue produits, unités, conditionnements » (administrateur ; en ligne). Unités,
 * catégories de produit, produits (création, désactivation, réactivation), conditionnements
 * (immuables, BR-CAT-004) et motifs (référentiel des écrans de perte, visite, rejet, inventaire…).
 * Les listes se lisent sur le serveur (`GET /units`, `/products`, `/reason-codes`) et sur l'appareil
 * (catégories, conditionnements) ; elles sont relues après chaque opération et la dernière liste lue
 * reste affichée pendant une coupure (saisie conservée, envoi bloqué). Un code déjà pris ou encore en
 * attente d'envoi est refusé (la base lèverait une violation d'unicité, S-31) ; l'opération suivante
 * attend la réponse définitive de la précédente, même après un retour sur l'écran.
 * Rubriques en contrôle segmenté ; produits et motifs en colonnes sur ordinateur.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActionBar,
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  DataCell,
  DataList,
  DataRow,
  Field,
  Input,
  List,
  ListRow,
  PageHeader,
  Segmented,
  Select,
  SkeletonRows,
} from '../../components/ui/index.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { CommandResult } from '../sales/CommandResult.js';
import { readPath, useOnlineRead } from '../sales/online-read.js';
import { useSalesReferences, type SalesReferences } from '../sales/references.js';
import {
  lastWaitingCommand,
  phaseOf,
  submitCommand,
  waitingCommands,
  waitingIds,
} from '../sales/submit.js';
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
  reasonUpdatePayload,
  REASON_CATEGORIES,
  SPECIES,
  STOCK_FAMILIES,
  unitPayload,
  type ProductForm,
  type ProductView,
  type ReasonView,
  type UnitView,
} from './catalog.js';
import './catalog.css';

type Section = 'PRODUCTS' | 'UNITS' | 'CATEGORIES' | 'PACKAGING' | 'REASONS';
const SECTIONS: readonly Section[] = ['PRODUCTS', 'UNITS', 'CATEGORIES', 'PACKAGING', 'REASONS'];

const isActiveCategory = (category: ProductCategoryData) =>
  category.is_active === undefined || Boolean(category.is_active);

/**
 * Liste lue en ligne : la dernière liste reçue (`undefined` avant la première), gardée quand une
 * relecture échoue ou que le réseau tombe ; l'échec de la dernière lecture et son nouvel essai.
 */
function useOnlineList<T>(path: string, field: string, online: boolean, reloadKey: string) {
  const read = useOnlineRead<Record<string, T[] | undefined>>(path, readPath, online, reloadKey);
  return {
    items: read.data ? (read.data[field] ?? []) : undefined,
    stale: read.stale,
    failed: read.failed,
    retry: read.retry,
  };
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
        <p key={issue} className="field-error">
          {t(`${prefix}.${issue}`)}
        </p>
      ))}
    </>
  );
}

function UnitsSection({ units, send, blocked, userId, pending }: SectionProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ code: '', name: '', isCount: true });
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
      {units.length > 0 ? (
        <List>
          {units.map((unit) => (
            <ListRow
              key={unit.code}
              title={unit.code}
              subtitle={unit.name}
              badge={
                <Badge tone="muted" plain>
                  {unit.isCount ? t('catalog.count_unit') : t('catalog.measure_unit')}
                </Badge>
              }
            />
          ))}
        </List>
      ) : null}
      <Card padded className="cat-form">
        <h3>{t('catalog.new_unit')}</h3>
        <div className="cat-pair">
          <Field label={t('catalog.code_label')}>
            {(control) => (
              <Input
                {...control}
                maxLength={20}
                value={form.code}
                onChange={(event) =>
                  setForm((current) => ({ ...current, code: event.target.value }))
                }
              />
            )}
          </Field>
          <Field label={t('catalog.name_label')}>
            {(control) => (
              <Input
                {...control}
                maxLength={60}
                value={form.name}
                onChange={(event) =>
                  setForm((current) => ({ ...current, name: event.target.value }))
                }
              />
            )}
          </Field>
        </div>
        <Checkbox
          label={t('catalog.is_count_label')}
          checked={form.isCount}
          onChange={(event) =>
            setForm((current) => ({ ...current, isCount: event.target.checked }))
          }
        />
        {touched ? <Issues issues={issues} prefix="catalog.issue" /> : null}
        <div className="cat-submit">
          <Button disabled={issues.length > 0 || blocked} onClick={submit}>
            {t('catalog.create_unit')}
          </Button>
        </div>
      </Card>
    </>
  );
}

function CategoriesSection({ refs, send, blocked, userId, pending }: SectionProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ code: '', name: '', parentId: '' });
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
        <p className="muted">{t('catalog.none')}</p>
      ) : (
        <List>
          {refs.productCategories.map((category) => (
            <ListRow
              key={category.id}
              title={category.name}
              subtitle={category.code}
              badge={
                category.parent_id ? (
                  <span className="list-sub">{names.get(category.parent_id) ?? ''}</span>
                ) : undefined
              }
            />
          ))}
          {waiting.map((code) => (
            <ListRow
              key={`attente-${code}`}
              title={code}
              badge={
                <Badge tone="warn">
                  {pending.acceptedCategories.includes(code)
                    ? t('catalog.created_pending_pull')
                    : t('catalog.pending')}
                </Badge>
              }
            />
          ))}
        </List>
      )}
      <Card padded className="cat-form">
        <h3>{t('catalog.new_category')}</h3>
        <div className="cat-pair">
          <Field label={t('catalog.code_label')}>
            {(control) => (
              <Input
                {...control}
                maxLength={40}
                value={form.code}
                onChange={(event) =>
                  setForm((current) => ({ ...current, code: event.target.value }))
                }
              />
            )}
          </Field>
          <Field label={t('catalog.name_label')}>
            {(control) => (
              <Input
                {...control}
                maxLength={200}
                value={form.name}
                onChange={(event) =>
                  setForm((current) => ({ ...current, name: event.target.value }))
                }
              />
            )}
          </Field>
        </div>
        <Field label={t('catalog.parent_label')}>
          {(control) => (
            <Select
              {...control}
              value={form.parentId}
              onChange={(event) =>
                setForm((current) => ({ ...current, parentId: event.target.value }))
              }
            >
              <option value="">{t('catalog.no_parent')}</option>
              {refs.productCategories.filter(isActiveCategory).map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {touched ? <Issues issues={issues} prefix="catalog.issue" /> : null}
        <div className="cat-submit">
          <Button disabled={issues.length > 0 || blocked} onClick={submit}>
            {t('catalog.create_category')}
          </Button>
        </div>
      </Card>
    </>
  );
}

function ProductsSection({ refs, units, products, send, blocked, userId, pending }: SectionProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState<ProductForm>(EMPTY_PRODUCT);
  const [creating, setCreating] = useState(false);
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
    <Checkbox
      key={key}
      label={t(`catalog.flag.${key}`)}
      checked={form[key]}
      onChange={(event) => update({ [key]: event.target.checked } as Partial<ProductForm>)}
    />
  );
  const select = (
    label: string,
    value: string,
    options: readonly { readonly value: string; readonly label: string }[],
    onChange: (value: string) => void,
    placeholder?: string,
  ) => (
    <Field label={label}>
      {(control) => (
        <Select {...control} value={value} onChange={(event) => onChange(event.target.value)}>
          {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
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
    <>
      {!creating ? (
        <div className="cat-toolbar">
          <Button icon="plus" onClick={() => setCreating(true)}>
            {t('catalog.new_product')}
          </Button>
        </div>
      ) : (
        <>
          <Card padded className="cat-form">
            <h3>{t('catalog.new_product')}</h3>
            <div className="cat-pair">
              <Field label={t('catalog.code_label')}>
                {(control) => (
                  <Input
                    {...control}
                    maxLength={40}
                    value={form.code}
                    onChange={(event) => update({ code: event.target.value })}
                  />
                )}
              </Field>
              <Field label={t('catalog.name_label')}>
                {(control) => (
                  <Input
                    {...control}
                    maxLength={200}
                    value={form.name}
                    onChange={(event) => update({ name: event.target.value })}
                  />
                )}
              </Field>
            </div>
            <div className="cat-pair">
              {select(
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
                t('catalog.family_label'),
                form.stockFamily,
                STOCK_FAMILIES.map((family) => ({
                  value: family,
                  label: t(`catalog.family.${family}`),
                })),
                (stockFamily) =>
                  // Un produit biologique se suit par lot (lots de production, BR-PRD-001), un
                  // service jamais (BR-CAT-005) : le suivi est réglé avec la famille.
                  update({
                    stockFamily: stockFamily as ProductForm['stockFamily'],
                    ...(stockFamily === 'BIOLOGIQUE'
                      ? { lotTracking: 'REQUIRED' as const }
                      : stockFamily === 'SERVICE'
                        ? { lotTracking: 'NONE' as const }
                        : {}),
                  }),
              )}
            </div>
            <div className="cat-pair">
              {select(
                t('catalog.base_unit_label'),
                form.baseUnitCode,
                units
                  .filter((unit) => unit.isActive)
                  .map((unit) => ({ value: unit.code, label: `${unit.code} — ${unit.name}` })),
                (baseUnitCode) => update({ baseUnitCode }),
                t('catalog.choose'),
              )}
              {select(
                t('catalog.pricing_mode_label'),
                form.pricingMode,
                PRICING_MODES.map((value) => ({
                  value,
                  label: t(`catalog.pricing_mode.${value}`),
                })),
                (pricingMode) => update({ pricingMode: pricingMode as ProductForm['pricingMode'] }),
              )}
            </div>
            <div className="cat-pair">
              {form.stockFamily !== 'SERVICE'
                ? select(
                    t('catalog.lot_label'),
                    form.lotTracking,
                    LOT_TRACKINGS.map((value) => ({ value, label: t(`catalog.lot.${value}`) })),
                    (lotTracking) =>
                      update({ lotTracking: lotTracking as ProductForm['lotTracking'] }),
                  )
                : null}
              {form.stockFamily === 'BIOLOGIQUE'
                ? select(
                    t('catalog.species_label'),
                    form.species,
                    SPECIES.map((value) => ({ value, label: t(`catalog.species.${value}`) })),
                    (species) => update({ species }),
                    t('catalog.choose'),
                  )
                : null}
            </div>
            <fieldset className="cat-flags">
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
            <p className="muted">{t('catalog.immutable_hint')}</p>
            {form.code || form.name ? <Issues issues={issues} prefix="catalog.issue" /> : null}
          </Card>
          <ActionBar>
            <Button variant="outline" onClick={() => setCreating(false)}>
              {t('price_rules.cancel')}
            </Button>
            <Button
              size="lg"
              className="submit-sale"
              disabled={issues.length > 0 || blocked}
              onClick={submit}
            >
              {t('catalog.create_product')}
            </Button>
          </ActionBar>
        </>
      )}
      {products.length === 0 ? (
        <p className="muted">{t('catalog.none')}</p>
      ) : (
        <DataList
          aria-label={t('catalog.section.PRODUCTS')}
          columns={[
            { label: t('catalog.col.product') },
            { label: t('catalog.col.family') },
            { label: t('catalog.col.unit') },
            { label: t('catalog.col.status') },
            { label: '' },
          ]}
          template="minmax(0, 2.4fr) minmax(0, 1.8fr) 6rem 7rem 7rem"
        >
          {products.map((product) => (
            <DataRow key={product.id}>
              <DataCell primary>
                <span className="cat-name">
                  <strong>{product.name}</strong>
                  <small>{product.code}</small>
                </span>
              </DataCell>
              <DataCell>{t(`catalog.family.${product.stockFamily}`)}</DataCell>
              <DataCell>{product.baseUnitCode}</DataCell>
              <DataCell>
                <Badge tone={product.status === 'ACTIVE' ? 'ok' : 'muted'}>
                  {t(`catalog.status.${product.status}`, { defaultValue: product.status })}
                </Badge>
              </DataCell>
              <DataCell actions>
                <Button
                  variant="ghost"
                  size="sm"
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
                </Button>
              </DataCell>
            </DataRow>
          ))}
        </DataList>
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
    <Checkbox
      key={key}
      label={t(`catalog.packaging_flag.${key}`)}
      checked={form[key]}
      onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.checked }))}
    />
  );
  const rows = product ? existing.filter((unit) => unit.product_id === product.id) : [];
  return (
    <>
      <Field label={t('catalog.product_label')}>
        {(control) => (
          <Select
            {...control}
            value={productId}
            onChange={(event) => setProductId(event.target.value)}
          >
            <option value="">{t('catalog.choose')}</option>
            {products.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {product ? (
        <>
          {rows.length > 0 ? (
            <List>
              {rows.map((unit) => (
                <ListRow
                  key={unit.id}
                  title={unit.unit_code}
                  subtitle={t('catalog.factor', {
                    factor: Number(unit.factor_to_base),
                    unit: product.baseUnitCode,
                  })}
                  badge={
                    unit.is_active ? undefined : (
                      <Badge tone="muted">{t('catalog.status.INACTIVE')}</Badge>
                    )
                  }
                />
              ))}
            </List>
          ) : null}
          <Card padded className="cat-form">
            <h3>{t('catalog.new_packaging')}</h3>
            <div className="cat-pair">
              <Field label={t('catalog.unit_label')}>
                {(control) => (
                  <Select
                    {...control}
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
                  </Select>
                )}
              </Field>
              <Field label={t('catalog.factor_label', { unit: product.baseUnitCode })}>
                {(control) => (
                  <Input
                    {...control}
                    inputMode="decimal"
                    value={form.factorText}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, factorText: event.target.value }))
                    }
                  />
                )}
              </Field>
            </div>
            <fieldset className="cat-flags">
              <legend>{t('catalog.packaging_use_label')}</legend>
              {(['isSalesUnit', 'isPurchaseUnit', 'isCountUnit'] as const).map(flag)}
            </fieldset>
            <p className="muted">{t('catalog.packaging_immutable')}</p>
            {touched ? <Issues issues={check.issues} prefix="catalog.issue" /> : null}
            <div className="cat-submit">
              <Button disabled={check.issues.length > 0 || blocked} onClick={submit}>
                {t('catalog.create_packaging')}
              </Button>
            </div>
          </Card>
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
  // MP-11 (AV-248) : libellé et commentaire exigé ajustables, motif désactivable, jamais supprimé.
  const [editing, setEditing] = useState<{
    readonly id: string;
    readonly label: string;
    readonly requiresComment: boolean;
  } | null>(null);
  const toggle = (reason: ReasonView) =>
    void send({
      authorUserId: userId,
      commandType: reason.isActive
        ? 'catalog.reason_code.deactivate'
        : 'catalog.reason_code.reactivate',
      aggregateType: 'REASON_CODE',
      aggregateId: reason.id,
      payload: {},
    });
  const saveEdit = (reason: ReasonView) => {
    if (!editing) return;
    const payload = reasonUpdatePayload(reason, editing);
    if (!payload) return;
    void send({
      authorUserId: userId,
      commandType: 'catalog.reason_code.update',
      aggregateType: 'REASON_CODE',
      aggregateId: reason.id,
      payload,
    }).then((ok) => {
      if (ok) setEditing(null);
    });
  };
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
      <Field label={t('catalog.reason_category_label')}>
        {(control) => (
          <Select
            {...control}
            value={form.category}
            onChange={(event) =>
              setForm((current) => ({ ...current, category: event.target.value }))
            }
          >
            {REASON_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {t(`catalog.reason_category.${category}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {listed.length === 0 ? (
        <p className="muted">{t('catalog.none')}</p>
      ) : (
        <DataList
          aria-label={t('catalog.section.REASONS')}
          columns={[
            { label: t('catalog.col.reason') },
            { label: t('catalog.col.comment') },
            { label: '' },
          ]}
          template="minmax(0, 3fr) 10rem 12rem"
        >
          {listed.map((reason) =>
            editing?.id === reason.id ? (
              <DataRow
                key={reason.id}
                aria-label={t('catalog.edit_reason', { name: reason.label })}
              >
                <DataCell wide>
                  <div className="cat-edit">
                    <Field label={t('catalog.label_label')}>
                      {(control) => (
                        <Input
                          {...control}
                          maxLength={200}
                          value={editing.label}
                          onChange={(event) =>
                            setEditing((current) =>
                              current ? { ...current, label: event.target.value } : current,
                            )
                          }
                        />
                      )}
                    </Field>
                    <Checkbox
                      label={t('catalog.requires_comment_label')}
                      checked={editing.requiresComment}
                      onChange={(event) =>
                        setEditing((current) =>
                          current ? { ...current, requiresComment: event.target.checked } : current,
                        )
                      }
                    />
                    <div className="result-actions">
                      <Button
                        size="sm"
                        disabled={blocked || reasonUpdatePayload(reason, editing) === null}
                        onClick={() => saveEdit(reason)}
                      >
                        {t('catalog.save_reason', { name: reason.code })}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                        {t('price_rules.cancel')}
                      </Button>
                    </div>
                  </div>
                </DataCell>
              </DataRow>
            ) : (
              <DataRow key={reason.id}>
                <DataCell primary>
                  <span className="cat-name">
                    <strong>{reason.label}</strong>
                    <small>
                      {reason.code}
                      {reason.lossCategory
                        ? ` · ${t(`loss.categories.${reason.lossCategory}`, { defaultValue: reason.lossCategory })}`
                        : ''}
                      {reason.isActive ? '' : ` · ${t('catalog.status.INACTIVE')}`}
                    </small>
                  </span>
                </DataCell>
                <DataCell>
                  {reason.requiresComment ? (
                    <Badge tone="info" plain>
                      {t('catalog.requires_comment_short')}
                    </Badge>
                  ) : null}
                </DataCell>
                <DataCell actions>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={blocked}
                    aria-label={t('catalog.edit_reason', { name: reason.label })}
                    onClick={() =>
                      setEditing({
                        id: reason.id,
                        label: reason.label,
                        requiresComment: reason.requiresComment,
                      })
                    }
                  >
                    {t('catalog.edit_short')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={blocked}
                    aria-label={t(reason.isActive ? 'catalog.deactivate' : 'catalog.reactivate', {
                      name: reason.label,
                    })}
                    onClick={() => toggle(reason)}
                  >
                    {t(reason.isActive ? 'catalog.deactivate_short' : 'catalog.reactivate_short')}
                  </Button>
                </DataCell>
              </DataRow>
            ),
          )}
        </DataList>
      )}
      <Card padded className="cat-form">
        <h3>{t('catalog.new_reason')}</h3>
        <div className="cat-pair">
          <Field label={t('catalog.code_label')}>
            {(control) => (
              <Input
                {...control}
                maxLength={40}
                value={form.code}
                onChange={(event) =>
                  setForm((current) => ({ ...current, code: event.target.value }))
                }
              />
            )}
          </Field>
          <Field label={t('catalog.label_label')}>
            {(control) => (
              <Input
                {...control}
                maxLength={200}
                value={form.label}
                onChange={(event) =>
                  setForm((current) => ({ ...current, label: event.target.value }))
                }
              />
            )}
          </Field>
        </div>
        {form.category === 'LOSS' ? (
          <Field label={t('catalog.loss_category_label')}>
            {(control) => (
              <Select
                {...control}
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
              </Select>
            )}
          </Field>
        ) : null}
        <Checkbox
          label={t('catalog.requires_comment_label')}
          checked={form.requiresComment}
          onChange={(event) =>
            setForm((current) => ({ ...current, requiresComment: event.target.checked }))
          }
        />
        {touched ? <Issues issues={issues} prefix="catalog.issue" /> : null}
        <div className="cat-submit">
          <Button disabled={issues.length > 0 || blocked} onClick={submit}>
            {t('catalog.create_reason')}
          </Button>
        </div>
      </Card>
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
  const lastFound = refs?.outbox.find((command) => command.command_id === last);
  // Clé de relecture sur la phase (le statut brut passe par SYNCING à chaque cycle).
  const lastStatus = lastFound ? phaseOf(lastFound) : '';
  // Réponse de la dernière opération, ou d'une opération retrouvée en attente : relecture des listes.
  const pendingOps = waitingCommands(refs?.outbox ?? [], 'catalog.', userId);
  const reloadKey = `${last ?? ''}:${lastStatus}|${waitingIds(refs?.outbox ?? [], 'catalog.', userId)}`;
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
      <section className="sale cat-screen" aria-busy="true">
        <PageHeader title={t('nav.screens.catalog')} />
        <SkeletonRows rows={4} />
      </section>
    );
  }

  const settling =
    last !== undefined && !refs.outbox.some((command) => command.command_id === last);
  // Une opération du catalogue de l'utilisateur encore sans réponse bloque la suivante, même après
  // un retour sur l'écran.
  const waiting = pendingOps.length > 0;
  // Listes périmées (relecture en cours ou en échec) : les actions se déduisent de l'état affiché,
  // elles attendent la relecture.
  const stale = units.stale || products.stale || reasons.stale;
  const blocked = busy || settling || waiting || !online || stale;
  // Retour sur l'écran : la dernière opération encore en attente redevient « la dernière », pour que
  // son résultat (refus compris) reste affiché jusqu'à la réponse.
  const adopt = last ? undefined : lastWaitingCommand(refs.outbox, 'catalog.', userId);
  if (adopt) setLast(adopt.command_id);

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
    <section className="sale cat-screen">
      <PageHeader title={t('nav.screens.catalog')} />
      {!online ? <Banner tone="bad">{t('catalog.online_only')}</Banner> : null}
      {last ? <CommandResult commandId={last} messages="catalog.result" /> : null}
      <Segmented
        label={t('catalog.section_label')}
        value={section}
        onChange={setSection}
        options={SECTIONS.map((value) => ({ value, label: t(`catalog.section.${value}`) }))}
        className="cat-sections"
      />
      {saveError ? <Banner tone="bad">{t('sales.error_local_save')}</Banner> : null}
      {online && failed ? (
        <Banner
          tone="bad"
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                units.retry();
                products.retry();
                reasons.retry();
              }}
            >
              {t('ledger.retry')}
            </Button>
          }
        >
          {t('catalog.unavailable')}
        </Banner>
      ) : null}
      {online && !loaded && !failed ? <SkeletonRows rows={4} /> : null}
      {online && loaded && stale && !failed ? (
        <p className="muted" role="status">
          {t('catalog.refreshing')}
        </p>
      ) : null}
      {props ? (
        <section className="cat-panel" aria-label={t(`catalog.section.${section}`)}>
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
