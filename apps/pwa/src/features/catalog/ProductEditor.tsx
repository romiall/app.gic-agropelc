/**
 * Modification d'un produit et de son coût standard (ECR-PRX-01, AV-516) :
 * - `catalog.product.update` : nom, catégorie et drapeaux d'usage (vendable, achetable, produit, consommable) ;
 *   le code, la famille, l'unité de base, le suivi par lot et l'espèce restent ceux de la création ;
 * - `catalog.product_standard_cost.set` : une nouvelle version datée du coût standard (BR-CAT-011, AV-042), jamais
 *   une modification ; l'historique se lit sur `GET /products/{id}/standard-costs`, réservé au droit de
 *   valorisation (`inventory.valuation.read`) : sans lui, le coût s'écrit sans se relire (RC-05).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Banner, Button, Card, Checkbox, Field, Input, Select } from '../../components/ui/index.js';
import { clock } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { formatDateTime } from '../home/format-home.js';
import { formatMoney } from '../sales/format.js';
import { readPath, useOnlineRead } from '../sales/online-read.js';
import type { submitCommand } from '../sales/submit.js';
import type { ProductCategoryData } from '../sales/types.js';
import {
  checkProductEdit,
  checkStandardCost,
  productEditFormOf,
  productUpdatePayload,
  standardCostPayload,
  standardCostsPath,
  STANDARD_COST_REASON_MAX,
  type ProductEditForm,
  type ProductView,
  type StandardCostView,
} from './catalog.js';

interface ProductEditorProps {
  readonly product: ProductView;
  readonly categories: readonly ProductCategoryData[];
  readonly send: (input: Parameters<typeof submitCommand>[0]) => Promise<boolean>;
  readonly blocked: boolean;
  readonly userId: string;
  /** Change à chaque réponse d'une opération du catalogue : l'historique du coût se relit alors. */
  readonly reloadKey: string;
  readonly onClose: () => void;
}

type FlagKey = 'isSellable' | 'isPurchasable' | 'isProducible' | 'isConsumable';
const FLAGS: readonly FlagKey[] = ['isSellable', 'isPurchasable', 'isProducible', 'isConsumable'];

export function ProductEditor({
  product,
  categories,
  send,
  blocked,
  userId,
  reloadKey,
  onClose,
}: ProductEditorProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState<ProductEditForm>(() => productEditFormOf(product));
  const issues = checkProductEdit(form);
  const payload = productUpdatePayload(product, form);
  const changed = Object.keys(payload).length > 0;
  const update = (patch: Partial<ProductEditForm>) =>
    setForm((current) => ({ ...current, ...patch }));
  // La catégorie actuelle reste choisissable même désactivée (sans quoi le produit perdrait la sienne).
  const categoryOptions = categories.filter(
    (category) => category.id === product.categoryId || category.is_active !== false,
  );

  const save = () =>
    void send({
      authorUserId: userId,
      commandType: 'catalog.product.update',
      aggregateType: 'PRODUCT',
      aggregateId: product.id,
      payload,
    }).then((ok) => {
      if (ok) onClose();
    });

  return (
    <Card
      padded
      className="cat-form"
      role="group"
      aria-label={t('catalog.edit_title', { name: product.name })}
    >
      <h3>{t('catalog.edit_title', { name: product.name })}</h3>
      <div className="cat-pair">
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
        <Field label={t('catalog.category_label')}>
          {(control) => (
            <Select
              {...control}
              value={form.categoryId}
              onChange={(event) => update({ categoryId: event.target.value })}
            >
              {categoryOptions.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <fieldset className="cat-flags">
        <legend>{t('catalog.flags_label')}</legend>
        {FLAGS.map((key) => (
          <Checkbox
            key={key}
            label={t(`catalog.flag.${key}`)}
            checked={form[key]}
            onChange={(event) =>
              update({ [key]: event.target.checked } as Partial<ProductEditForm>)
            }
          />
        ))}
      </fieldset>
      <p className="muted">{t('catalog.edit_immutable_hint')}</p>
      {issues.map((issue) => (
        <p key={issue} className="field-error">
          {t(`catalog.issue.${issue}`)}
        </p>
      ))}
      <div className="cat-submit">
        <Button disabled={issues.length > 0 || !changed || blocked} onClick={save}>
          {t('catalog.edit_save', { name: product.name })}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t('price_rules.cancel')}
        </Button>
      </div>
      <StandardCostPanel
        product={product}
        send={send}
        blocked={blocked}
        userId={userId}
        reloadKey={reloadKey}
      />
    </Card>
  );
}

interface StandardCostPanelProps {
  readonly product: ProductView;
  readonly send: ProductEditorProps['send'];
  readonly blocked: boolean;
  readonly userId: string;
  readonly reloadKey: string;
}

function StandardCostPanel({ product, send, blocked, userId, reloadKey }: StandardCostPanelProps) {
  const { t } = useTranslation();
  const online = useOnline();
  const [costText, setCostText] = useState('');
  const [reason, setReason] = useState('');
  // L'historique se relit à la RÉPONSE de la commande (le parent change `reloadKey` à chaque changement de phase de la
  // dernière opération), pas à son enfilage : relu trop tôt, il montrerait encore l'ancien coût « en vigueur » et
  // l'utilisateur, croyant l'envoi perdu, ressaisirait.
  const read = useOnlineRead<{ costs: StandardCostView[] }>(
    online ? standardCostsPath(product.id) : null,
    readPath,
    online,
    reloadKey,
  );
  const issues = checkStandardCost(costText, reason);
  const now = clock.now();
  const costs = read.data?.costs;
  // Le coût en vigueur : la version la plus récente déjà datée (une version datée d'avance n'agit pas encore).
  const current = costs?.find((cost) => new Date(cost.validFrom) <= now);

  const save = () =>
    void send({
      authorUserId: userId,
      commandType: 'catalog.product_standard_cost.set',
      aggregateType: 'PRODUCT_STANDARD_COST',
      payload: standardCostPayload(product.id, costText, reason),
    }).then((ok) => {
      if (ok) {
        setCostText('');
        setReason('');
      }
    });

  return (
    <section className="cat-costs" aria-label={t('catalog.cost_title')}>
      <h4>{t('catalog.cost_title')}</h4>
      <p className="muted">{t('catalog.cost_hint')}</p>
      {read.denied ? <p className="muted">{t('catalog.cost_denied')}</p> : null}
      {read.failed && !read.denied ? (
        <Banner
          tone="bad"
          action={
            <Button variant="outline" size="sm" onClick={read.retry}>
              {t('ledger.retry')}
            </Button>
          }
        >
          {t('catalog.cost_unavailable')}
        </Banner>
      ) : null}
      {costs && costs.length === 0 ? <p className="muted">{t('catalog.cost_none')}</p> : null}
      {costs && costs.length > 0 ? (
        <ul aria-label={t('catalog.cost_history')}>
          {costs.map((cost) => (
            <li key={cost.id}>
              <strong>{t('catalog.cost_value', { amount: formatMoney(cost.unitCostXaf) })}</strong>
              {' · '}
              {t('catalog.cost_since', { date: formatDateTime(cost.validFrom) })}
              {cost.id === current?.id ? ` · ${t('catalog.cost_current')}` : ''}
              {cost.reason ? ` · ${cost.reason}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="cat-pair">
        <Field label={t('catalog.cost_label', { unit: product.baseUnitCode })}>
          {(control) => (
            <Input
              {...control}
              inputMode="numeric"
              value={costText}
              onChange={(event) => setCostText(event.target.value)}
            />
          )}
        </Field>
        <Field label={t('catalog.cost_reason_label')}>
          {(control) => (
            <Input
              {...control}
              maxLength={STANDARD_COST_REASON_MAX}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>
      </div>
      {costText !== '' && issues.includes('COST_INVALID') ? (
        <p className="field-error">{t('catalog.issue.COST_INVALID')}</p>
      ) : null}
      <div className="cat-submit">
        <Button variant="outline" disabled={issues.length > 0 || blocked || !online} onClick={save}>
          {t('catalog.cost_save')}
        </Button>
      </div>
    </section>
  );
}
