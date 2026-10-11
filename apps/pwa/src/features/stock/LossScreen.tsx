/**
 * ECR-STK-04 « DÉCLARER UNE PERTE » (tous les détenteurs de stock). Emplacement, produit, quantité
 * dans l'unité choisie, catégorie, motif (liste `LOSS`, éventuellement vide sur une base neuve),
 * commentaire si la catégorie ou le motif l'exige, lot facultatif. Commande `inventory.loss.declare`
 * (agrégat `STOCK_LOSS`), utilisable hors ligne ; le numéro `PRT-…` revient avec la réponse. Selon la
 * politique de contrôle, la perte est enregistrée ou part en validation (la quantité est alors mise de
 * côté). La photo justificative n'est pas encore proposée par l'appareil (besoin S-16).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { idGenerator } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatQuantity } from '../sales/format.js';
import { useSalesReferences } from '../sales/references.js';
import { saleUnitsOf } from '../sales/sale-form.js';
import { localAvailable, physicalLeft, stockKey } from '../sales/stock.js';
import { submitCommand } from '../sales/submit.js';
import {
  checkLoss,
  DEVICE_LOSS_CATEGORIES,
  lossPayload,
  lossReasons,
  MAX_LOSS_COMMENT_LENGTH,
  type LossCategory,
  type LossDraft,
} from './loss.js';
import { stockLocations } from './stock-view.js';

const EMPTY: LossDraft = {
  productId: '',
  unitCode: '',
  quantityText: '',
  category: '',
  reasonCodeId: '',
  lotId: '',
  comment: '',
};

export function LossScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
  const online = useOnline();
  const [locationChoice, setLocationChoice] = useState<string | null>(null);
  const [draft, setDraft] = useState<LossDraft>(EMPTY);
  const [submitted, setSubmitted] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.loss')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  if (submitted) {
    return (
      <section className="sale">
        <h1>{t('nav.screens.loss')}</h1>
        <CommandResult commandId={submitted} messages="loss.result">
          <button
            type="button"
            onClick={() => {
              setDraft(EMPTY);
              setSubmitted(undefined);
            }}
          >
            {t('loss.another')}
          </button>
        </CommandResult>
      </section>
    );
  }

  const locations = stockLocations(refs);
  const location = locations.find((candidate) => candidate.id === locationChoice) ?? locations[0];
  if (!location) {
    return (
      <section className="sale">
        <h1>{t('nav.screens.loss')}</h1>
        <p className="home-muted">{t('stock.no_location')}</p>
      </section>
    );
  }

  const update = (patch: Partial<LossDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const products = refs.products
    .filter((product) => refs.stock.has(stockKey(location.id, product.id)))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const product = products.find((candidate) => candidate.id === draft.productId);
  const units = product ? saleUnitsOf(product, refs) : [];
  const unitCode = draft.unitCode || product?.base_unit_code || '';
  const unit = units.find((candidate) => candidate.unitCode === unitCode);
  const reasons = lossReasons(refs.reasonCodes, draft.category);
  const effective = { ...draft, unitCode };
  const check = checkLoss(effective, unit, reasons);
  const balance = product ? refs.stock.get(stockKey(location.id, product.id)) : undefined;
  const available = product
    ? localAvailable(
        balance,
        location.custody_mode,
        refs.pending.get(stockKey(location.id, product.id)) ?? 0,
      )
    : 0;
  const lots = (balance?.lots ?? []).filter((lot) => lot.lot_id && Number(lot.qty_on_hand) > 0);
  // Incubateur, éclosoir : le lot d'incubation se désigne (une perte au plus ancien fausserait le
  // bilan d'un autre lot, BR-INC-003) ; présélectionné s'il est seul.
  const lotRequired =
    (location.location_type === 'INCUBATOR' || location.location_type === 'HATCHER') &&
    lots.length > 0;
  const lotId =
    lotRequired && !draft.lotId && lots.length === 1 ? (lots[0]?.lot_id ?? '') : draft.lotId;
  const chosenLot = lots.find((lot) => lot.lot_id === lotId);
  // Contrôle sur le physique (et le lot choisi), comme le serveur ; les quotas n'y entrent pas.
  const physical = product
    ? physicalLeft(balance, refs.pending.get(stockKey(location.id, product.id)) ?? 0)
    : 0;
  const overAvailable =
    check.quantityBase !== null &&
    (check.quantityBase > physical ||
      (chosenLot !== undefined && check.quantityBase > Number(chosenLot.qty_on_hand)));
  // En ligne, le serveur refuserait la perte (INSUFFICIENT_STOCK) ; hors ligne, fait accompli.
  const ready =
    check.issues.length === 0 &&
    !(lotRequired && !chosenLot) &&
    !(online && overAvailable) &&
    !busy;

  const submit = async () => {
    if (!ready || !draft.category || check.quantity === null || check.quantityBase === null) return;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: 'inventory.loss.declare',
        aggregateType: 'STOCK_LOSS',
        aggregateId: idGenerator.newId(),
        payload: lossPayload({ ...effective, lotId, category: draft.category }, location.id, {
          ...check,
          quantity: check.quantity,
          quantityBase: check.quantityBase,
        }),
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
      <h1>{t('nav.screens.loss')}</h1>
      {!online ? (
        <p className="home-banner" role="status">
          {t('loss.offline_banner')}
        </p>
      ) : null}
      <div className="field">
        <label htmlFor="loss-location">{t('stock.location_label')}</label>
        <select
          id="loss-location"
          className="text-input"
          value={location.id}
          onChange={(event) => {
            setLocationChoice(event.target.value);
            update({ productId: '', unitCode: '', lotId: '' });
          }}
        >
          {locations.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="loss-product">{t('loss.product_label')}</label>
        <select
          id="loss-product"
          className="text-input"
          value={draft.productId}
          onChange={(event) => update({ productId: event.target.value, unitCode: '', lotId: '' })}
        >
          <option value="">{t('loss.product_placeholder')}</option>
          {products.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
        {product ? (
          <p className="home-muted">
            {t('sales.product_available', {
              quantity: formatQuantity(available),
              unit: product.base_unit_code,
            })}
          </p>
        ) : null}
      </div>
      <div className="line-fields">
        <div className="field">
          <label htmlFor="loss-quantity">{t('sales.quantity_label')}</label>
          <input
            id="loss-quantity"
            className="text-input"
            inputMode="decimal"
            value={draft.quantityText}
            onChange={(event) => update({ quantityText: event.target.value })}
          />
        </div>
        {units.length > 1 ? (
          <div className="field">
            <label htmlFor="loss-unit">{t('sales.unit_label')}</label>
            <select
              id="loss-unit"
              className="text-input"
              value={unitCode}
              onChange={(event) => update({ unitCode: event.target.value })}
            >
              {units.map((candidate) => (
                <option key={candidate.unitCode} value={candidate.unitCode}>
                  {candidate.unitCode}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <p className="line-unit">{unitCode}</p>
        )}
      </div>
      {lots.length > 0 ? (
        <div className="field">
          <label htmlFor="loss-lot">{t('loss.lot_label')}</label>
          <select
            id="loss-lot"
            className="text-input"
            value={lotId}
            aria-required={lotRequired || undefined}
            onChange={(event) => update({ lotId: event.target.value })}
          >
            <option value="">{lotRequired ? t('loss.lot_choose') : t('loss.lot_fifo')}</option>
            {lots.map((lot) => (
              <option key={lot.lot_id} value={lot.lot_id ?? ''}>
                {lot.lot_code ?? lot.lot_id} · {formatQuantity(Number(lot.qty_on_hand))}
              </option>
            ))}
          </select>
          {lotRequired && !chosenLot ? (
            <p className="home-muted">{t('loss.lot_required_incubation')}</p>
          ) : null}
        </div>
      ) : null}
      <fieldset className="choice-group">
        <legend>{t('loss.category_label')}</legend>
        {DEVICE_LOSS_CATEGORIES.map((category) => (
          <label key={category} className="choice">
            <input
              type="radio"
              name="loss-category"
              value={category}
              checked={draft.category === category}
              onChange={() => update({ category: category as LossCategory, reasonCodeId: '' })}
            />
            {t(`loss.categories.${category}`)}
          </label>
        ))}
      </fieldset>
      {reasons.length > 0 ? (
        <div className="field">
          <label htmlFor="loss-reason">{t('loss.reason_label')}</label>
          <select
            id="loss-reason"
            className="text-input"
            value={draft.reasonCodeId}
            onChange={(event) => update({ reasonCodeId: event.target.value })}
          >
            <option value="">{t('loss.reason_placeholder')}</option>
            {reasons.map((reason) => (
              <option key={reason.id} value={reason.id}>
                {reason.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="field">
        <label htmlFor="loss-comment">{t('loss.comment_label')}</label>
        <textarea
          id="loss-comment"
          className="text-input"
          rows={2}
          maxLength={MAX_LOSS_COMMENT_LENGTH}
          value={draft.comment}
          onChange={(event) => update({ comment: event.target.value })}
        />
      </div>
      {overAvailable ? (
        online ? (
          <p className="error-message" role="alert">
            {t('loss.over_online')}
          </p>
        ) : (
          <p className="text-warn">{t('loss.over_offline')}</p>
        )
      ) : null}
      {draft.productId || draft.quantityText || draft.category
        ? check.issues.map((issue) => (
            <p key={issue} className="error-message">
              {t(`loss.issue.${issue}`)}
            </p>
          ))
        : null}
      <p className="home-muted">{t('loss.photo_hint')}</p>
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
        {busy ? t('sales.submitting') : t('loss.submit')}
      </button>
    </section>
  );
}
