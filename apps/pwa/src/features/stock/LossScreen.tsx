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
import { clock, idGenerator } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatQuantity } from '../sales/format.js';
import { useSalesReferences } from '../sales/references.js';
import { saleUnitsOf } from '../sales/sale-form.js';
import { batchViews } from '../production/incubation.js';
import { localAvailable, physicalLeft, stockKey } from '../sales/stock.js';
import { phaseOf, submitCommand } from '../sales/submit.js';
import {
  checkLoss,
  DEVICE_LOSS_CATEGORIES,
  lossPayload,
  lossReasons,
  MAX_LOSS_COMMENT_LENGTH,
  type LossCategory,
  type LossDraft,
} from './loss.js';
import { offlineExitGuard } from '../sales/quota.js';
import { guardBlocks, guardDescribedBy } from './exit-guard.js';
import { ExitGuardMessages } from './ExitGuardMessages.js';
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
  const { state, deviceId } = useAuth();
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
  const lotHintId = 'loss-lot-hint';
  const lotUnknownId = 'loss-lot-unknown';
  // Incubateur, éclosoir : le lot d'incubation se désigne (une perte au plus ancien fausserait le
  // bilan d'un autre lot, BR-INC-003). Lots proposés : ceux du solde, et ceux des lots d'incubation
  // que l'appareil place sur cet emplacement (transfert vers l'éclosoir en attente compris), même
  // absents du solde téléchargé ; un démarrage pas encore accepté n'a pas de lot de stock (le serveur
  // le crée) : aucun lot n'est alors présélectionné à sa place.
  const incubationPlace =
    location.location_type === 'INCUBATOR' || location.location_type === 'HATCHER';
  const placeBatches =
    incubationPlace && product
      ? batchViews(refs, userId).filter(
          (view) =>
            (view.status === 'INCUBATING' || view.status === 'IN_HATCHER') &&
            view.eggProductId === product.id &&
            (view.status === 'IN_HATCHER' ? view.hatcherLocationId : view.incubatorLocationId) ===
              location.id,
        )
      : [];
  const balanceLots: { lot_id: string; lot_code: string; qty_on_hand: string | null }[] = (
    balance?.lots ?? []
  )
    .filter((lot) => lot.lot_id && Number(lot.qty_on_hand) > 0)
    .map((lot) => ({
      lot_id: lot.lot_id as string,
      lot_code: lot.lot_code ?? (lot.lot_id as string),
      qty_on_hand: lot.qty_on_hand,
    }));
  // Lot de stock d'un lot d'incubation : du jeu téléchargé, ou de la réponse à son démarrage.
  const stockLotOf = (batchId: string): { id: string; code: string } | null => {
    const downloaded = refs.incubationBatches.find((batch) => batch.id === batchId);
    if (downloaded) return { id: downloaded.stock_lot_id, code: downloaded.batch_code ?? '' };
    const start = refs.outbox.find(
      (command) =>
        command.command_type === 'production.incubation.start' && command.aggregate_id === batchId,
    );
    const stockLotId = start?.server_refs?.stockLotId;
    return stockLotId ? { id: stockLotId, code: start?.server_refs?.batchCode ?? '' } : null;
  };
  const inBalance = new Set((balance?.lots ?? []).map((lot) => lot.lot_id));
  const extraLots = placeBatches
    .map((view) => stockLotOf(view.id))
    .filter(
      (stockLot): stockLot is { id: string; code: string } =>
        stockLot !== null && !inBalance.has(stockLot.id),
    )
    .map((stockLot) => ({ lot_id: stockLot.id, lot_code: stockLot.code, qty_on_hand: null }));
  const lots = [...balanceLots, ...extraLots];
  // Démarrages encore sans réponse sur cet incubateur, de tout utilisateur de l'appareil (celui d'un
  // autre ne part qu'à sa reconnexion) : leur lot de stock n'existe pas encore.
  const downloadedBatches = new Set(refs.incubationBatches.map((batch) => batch.id));
  const unknownStarts =
    incubationPlace && product
      ? refs.outbox.filter((command) => {
          if (command.command_type !== 'production.incubation.start') return false;
          if (phaseOf(command) !== 'WAITING' || downloadedBatches.has(command.aggregate_id)) {
            return false;
          }
          const payload = command.payload as {
            readonly incubatorLocationId?: string;
            readonly eggProductId?: string;
          };
          return payload.incubatorLocationId === location.id && payload.eggProductId === product.id;
        }).length
      : 0;
  const lotRequired = incubationPlace && lots.length > 0;
  const lotId =
    lotRequired && !draft.lotId && lots.length === 1 && unknownStarts === 0
      ? (lots[0]?.lot_id ?? '')
      : draft.lotId;
  const chosenLot = lots.find((lot) => lot.lot_id === lotId);
  // Contrôle sur le physique (et le lot choisi), comme le serveur ; les quotas n'y entrent pas.
  const physical = product
    ? physicalLeft(balance, refs.pending.get(stockKey(location.id, product.id)) ?? 0)
    : 0;
  const overAvailable =
    check.quantityBase !== null &&
    (check.quantityBase > physical ||
      (chosenLot !== undefined &&
        chosenLot.qty_on_hand !== null &&
        check.quantityBase > Number(chosenLot.qty_on_hand)));
  // En ligne, le serveur refuserait la perte (INSUFFICIENT_STOCK) ; hors ligne, fait accompli.
  // Garde hors ligne (BR-STK-013, AV-303) : quota du détenteur, appareil désigné ; la perte au-delà
  // est signalée, jamais refusée, sauf emplacement confié à un autre appareil.
  const guard = offlineExitGuard(refs, {
    kind: 'LOSS',
    location,
    requested: new Map(
      !online && product && check.quantityBase !== null ? [[product.id, check.quantityBase]] : [],
    ),
    userId,
    deviceId,
    now: clock.now(),
  });
  const ready =
    check.issues.length === 0 &&
    !(lotRequired && !chosenLot) &&
    guard.blocks.length === 0 &&
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
            aria-invalid={product && guardBlocks(guard, product.id) ? true : undefined}
            aria-describedby={product ? guardDescribedBy(guard, 'loss', product.id) : undefined}
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
            aria-invalid={lotRequired && !chosenLot ? true : undefined}
            aria-describedby={
              [
                lotRequired && !chosenLot ? lotHintId : null,
                unknownStarts > 0 ? lotUnknownId : null,
              ]
                .filter(Boolean)
                .join(' ') || undefined
            }
            onChange={(event) => update({ lotId: event.target.value })}
          >
            <option value="">{lotRequired ? t('loss.lot_choose') : t('loss.lot_fifo')}</option>
            {lots.map((lot) => (
              <option key={lot.lot_id} value={lot.lot_id ?? ''}>
                {lot.lot_code || lot.lot_id} ·{' '}
                {lot.qty_on_hand === null
                  ? t('loss.lot_stock_pending')
                  : formatQuantity(Number(lot.qty_on_hand))}
              </option>
            ))}
          </select>
          {lotRequired && !chosenLot ? (
            <p id={lotHintId} className="home-muted">
              {t('loss.lot_required_incubation')}
            </p>
          ) : null}
        </div>
      ) : null}
      {unknownStarts > 0 ? (
        <p id={lotUnknownId} className="text-warn" role="status">
          {t('loss.lot_unknown_incubation')}
        </p>
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
      <ExitGuardMessages
        guard={guard}
        idPrefix="loss"
        productName={(productId) =>
          refs.products.find((candidate) => candidate.id === productId)?.name ?? ''
        }
        unitOf={(productId) =>
          refs.products.find((candidate) => candidate.id === productId)?.base_unit_code ?? ''
        }
      />
      {/* Hors ligne, une perte que la garde signale déjà n'est pas annoncée deux fois. */}
      {overAvailable && (online || guard.signals.length === 0) ? (
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
