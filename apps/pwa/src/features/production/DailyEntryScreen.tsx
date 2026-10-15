/**
 * ECR-PRD-02 « SAISIE DU JOUR » d'un lot (responsable de ferme ; WF-J4). Mortalité, aliment et
 * intrants, pesée, observation : chaque saisie est une commande distincte, utilisable hors ligne, et
 * apparaît aussitôt dans le journal du jour. La collecte d'œufs a son propre écran. Les mortalités
 * partent en validation selon la politique `MORTALITY` ; la photo n'est pas encore jointe (S-16).
 */
import { useId, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { businessDayOf } from '@gic/domain';
import { ROUTES } from '../../app/screens.js';
import { clock, idGenerator } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatClockTime, formatMoment } from '../home/format-home.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatQuantity, formatQuantityUnit, unitLabel } from '../sales/format.js';
import { useSalesReferences, type SalesReferences } from '../sales/references.js';
import { saleUnitsOf } from '../sales/sale-form.js';
import { physicalLeft, stockKey } from '../sales/stock.js';
import { submitCommand } from '../sales/submit.js';
import { photoAttachment } from '../attachments/attachments.js';
import type { PreparedPhoto } from '../attachments/photo.js';
import { PhotoField } from '../attachments/PhotoField.js';
import { AttachPhoto } from '../attachments/PhotoViews.js';
import type { ProductionLotData } from '../sales/types.js';
import { checkTransferLine, type TransferLineDraft } from '../stock/transfer.js';
import {
  consumableProducts,
  farmLocations,
  INPUT_COST_TYPES,
  inputPayload,
  isDailyLot,
  laysEggs,
  locationHeadcount,
  MAX_DAILY_COMMENT,
  MAX_OBSERVATION_TEXT,
  mortalityPayload,
  OBSERVATION_SEVERITIES,
  OBSERVATION_TYPES,
  observationPayload,
  parseCount,
  parsePositive,
  rearingHeadcount,
  rearingLocations,
  todayJournal,
  weighingPayload,
} from './daily.js';

/**
 * Mortalités du lot qui attendent la décision, quel que soit leur jour : leur photo se joint ici
 * après coup — l'approbation l'attend (AV-107 ; revue de MP-10 : le seul journal du jour la rendait
 * impossible dès le lendemain). Celles encore sur l'appareil y figurent aussi.
 */
function mortalitiesAwaitingApproval(
  refs: SalesReferences,
  lotId: string,
): { readonly id: string; readonly at: string; readonly heads: number }[] {
  const known = new Set<string>();
  const list: { id: string; at: string; heads: number }[] = [];
  for (const loss of refs.lotLosses) {
    if (loss.production_lot_id !== lotId || loss.category !== 'MORTALITE') continue;
    known.add(loss.id);
    if (loss.status !== 'PENDING_APPROVAL') continue;
    list.push({ id: loss.id, at: loss.occurred_at, heads: loss.quantity_base ?? 0 });
  }
  for (const command of refs.outbox) {
    if (command.command_type !== 'production.mortality.record') continue;
    if (known.has(command.aggregate_id)) continue;
    if (command.status === 'REJECTED' || command.status === 'CONFLICT') continue;
    const payload = command.payload as { productionLotId?: string; quantity?: number };
    if (payload.productionLotId !== lotId) continue;
    list.push({ id: command.aggregate_id, at: command.occurred_at, heads: payload.quantity ?? 0 });
  }
  return list.sort((a, b) => b.at.localeCompare(a.at));
}

type EntryKind = 'MORTALITY' | 'INPUT' | 'WEIGHING' | 'OBSERVATION';
const KINDS: readonly EntryKind[] = ['MORTALITY', 'INPUT', 'WEIGHING', 'OBSERVATION'];

interface FormProps {
  readonly refs: SalesReferences;
  readonly lot: ProductionLotData;
  readonly online: boolean;
  readonly send: (kind: EntryKind, input: Parameters<typeof submitCommand>[0]) => Promise<boolean>;
  readonly blocked: boolean;
  readonly userId: string;
}

function MortalityForm({ refs, lot, online, send, blocked, userId }: FormProps) {
  const { t } = useTranslation();
  const locations = rearingLocations(refs.locations, lot);
  const [locationChoice, setLocationChoice] = useState<string | null>(null);
  const [quantityText, setQuantityText] = useState('');
  const [reasonId, setReasonId] = useState('');
  const [comment, setComment] = useState('');
  const [photo, setPhoto] = useState<PreparedPhoto | null>(null);
  const [preparing, setPreparing] = useState(false);
  // Nouvelle saisie : le champ photo repart à neuf (message d'erreur compris).
  const [photoField, setPhotoField] = useState(0);
  const ids = { location: useId(), quantity: useId(), reason: useId(), comment: useId() };
  const location =
    locations.find((candidate) => candidate.id === locationChoice) ??
    locations.find((candidate) => candidate.id === lot.main_location_id) ??
    locations[0];
  const quantity = parseCount(quantityText);
  // Le serveur contrôle le solde de l'emplacement choisi, pas l'effectif du lot entier.
  const heads = location ? locationHeadcount(refs, lot, location.id) : null;
  const over = quantity !== null && heads !== null && quantity > heads;
  const reasons = refs.reasonCodes.filter(
    (reason) =>
      reason.category === 'LOSS' &&
      (reason.loss_category === null || reason.loss_category === 'MORTALITE'),
  );
  const commentRequired =
    reasons.find((reason) => reason.id === reasonId)?.requires_comment === true;
  const commentMissing = commentRequired && comment.trim() === '';
  const ready =
    location !== undefined &&
    quantity !== null &&
    !commentMissing &&
    !(online && over) &&
    !preparing &&
    !blocked;

  const submit = () => {
    if (!ready || !location || quantity === null) return;
    void send('MORTALITY', {
      authorUserId: userId,
      commandType: 'production.mortality.record',
      aggregateType: 'STOCK_LOSS',
      // Photo rattachée à la déclaration (`STOCK_LOSS`) : l'approbation l'attend (AV-107, ADR-046).
      ...(photo
        ? {
            attachments: [
              photoAttachment(photo, { kind: 'PHOTO', ownerType: 'STOCK_LOSS', cited: false }),
            ],
          }
        : {}),
      payload: mortalityPayload({
        lotId: lot.id,
        locationId: location.id,
        quantity,
        reasonCodeId: reasonId,
        comment,
      }),
    }).then((ok) => {
      if (ok) {
        setQuantityText('');
        setReasonId('');
        setComment('');
        setPhoto(null);
        setPhotoField((value) => value + 1);
      }
    });
  };

  return (
    <>
      {locations.length === 0 ? (
        <p className="alert alert-error">{t('production.no_rearing_location')}</p>
      ) : (
        <div className="field">
          <label htmlFor={ids.location}>{t('production.rearing_location_label')}</label>
          <select
            id={ids.location}
            className="text-input"
            value={location?.id ?? ''}
            onChange={(event) => setLocationChoice(event.target.value)}
          >
            {locations.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
          {heads !== null ? (
            <p className="home-muted">
              {t('production.location_headcount', { heads: formatQuantityUnit(heads, 'TETE') })}
            </p>
          ) : null}
        </div>
      )}
      <div className="field">
        <label htmlFor={ids.quantity}>{t('production.deaths_label')}</label>
        <input
          id={ids.quantity}
          className="text-input"
          inputMode="numeric"
          value={quantityText}
          onChange={(event) => setQuantityText(event.target.value)}
        />
        {quantityText && quantity === null ? (
          <p className="error-message">{t('production.count_invalid')}</p>
        ) : null}
      </div>
      {over ? (
        online ? (
          <p className="error-message" role="alert">
            {t('production.deaths_over_online')}
          </p>
        ) : (
          <p className="text-warn">{t('production.deaths_over_offline')}</p>
        )
      ) : null}
      <div className="field">
        <label htmlFor={ids.reason}>{t('production.cause_label')}</label>
        <select
          id={ids.reason}
          className="text-input"
          value={reasonId}
          onChange={(event) => setReasonId(event.target.value)}
        >
          <option value="">{t('production.cause_placeholder')}</option>
          {reasons.map((reason) => (
            <option key={reason.id} value={reason.id}>
              {reason.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={ids.comment}>
          {commentRequired ? t('production.comment_required_label') : t('production.comment_label')}
        </label>
        <textarea
          id={ids.comment}
          className="text-input"
          rows={2}
          maxLength={MAX_DAILY_COMMENT}
          value={comment}
          aria-required={commentRequired}
          aria-invalid={commentMissing}
          aria-describedby={commentMissing ? `${ids.comment}-error` : undefined}
          onChange={(event) => setComment(event.target.value)}
        />
        {commentMissing ? (
          <p id={`${ids.comment}-error`} className="error-message">
            {t('production.comment_required')}
          </p>
        ) : null}
      </div>
      <PhotoField
        key={photoField}
        label={t('photo.mortality_label')}
        hint={t('photo.mortality_hint')}
        value={photo}
        onChange={setPhoto}
        onBusyChange={setPreparing}
      />
      <button type="button" className="btn-block submit-sale" disabled={!ready} onClick={submit}>
        {t('production.submit.MORTALITY')}
      </button>
    </>
  );
}

function InputForm({ refs, lot, online, send, blocked, userId }: FormProps) {
  const { t } = useTranslation();
  const locations = farmLocations(refs.locations, lot);
  const products = consumableProducts(refs.products);
  const [locationChoice, setLocationChoice] = useState<string | null>(null);
  const [line, setLine] = useState<TransferLineDraft>(() => ({
    key: idGenerator.newId(),
    productId: '',
    unitCode: '',
    quantityText: '',
  }));
  const [costType, setCostType] = useState<(typeof INPUT_COST_TYPES)[number]>('ALIMENT');
  const ids = {
    location: useId(),
    product: useId(),
    quantity: useId(),
    unit: useId(),
    cost: useId(),
  };
  const location = locations.find((candidate) => candidate.id === locationChoice) ?? locations[0];
  const product = products.find((candidate) => candidate.id === line.productId);
  const units = product ? saleUnitsOf(product, refs) : [];
  const unitCode = line.unitCode || product?.base_unit_code || '';
  const check = checkTransferLine(
    { ...line, unitCode },
    units.find((unit) => unit.unitCode === unitCode),
  );
  const left =
    product && location
      ? physicalLeft(
          refs.stock.get(stockKey(location.id, product.id)),
          refs.pending.get(stockKey(location.id, product.id)) ?? 0,
        )
      : 0;
  const over = check.quantityBase !== null && check.quantityBase > left;
  const ready = location !== undefined && check.issue === null && !(online && over) && !blocked;

  const submit = () => {
    if (!ready || !location || check.quantity === null || check.quantityBase === null) return;
    void send('INPUT', {
      authorUserId: userId,
      commandType: 'production.input.record',
      aggregateType: 'CONSUMPTION',
      payload: inputPayload({
        lotId: lot.id,
        locationId: location.id,
        line: { ...check, quantity: check.quantity, quantityBase: check.quantityBase },
        costType,
      }),
    }).then((ok) => {
      if (ok) setLine((current) => ({ ...current, quantityText: '' }));
    });
  };

  return (
    <>
      <div className="field">
        <label htmlFor={ids.location}>{t('production.input_location_label')}</label>
        <select
          id={ids.location}
          className="text-input"
          value={location?.id ?? ''}
          onChange={(event) => setLocationChoice(event.target.value)}
        >
          {locations.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={ids.product}>{t('production.input_product_label')}</label>
        {products.length === 0 ? (
          <p className="alert alert-error">{t('production.no_consumable')}</p>
        ) : (
          <select
            id={ids.product}
            className="text-input"
            value={line.productId}
            onChange={(event) =>
              setLine((current) => ({ ...current, productId: event.target.value, unitCode: '' }))
            }
          >
            <option value="">{t('loss.product_placeholder')}</option>
            {products.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        )}
        {product ? (
          <p className="home-muted">
            {t('sales.product_available', {
              quantity: formatQuantity(left),
              unit: unitLabel(product.base_unit_code, left, refs.units),
            })}
          </p>
        ) : null}
      </div>
      <div className="line-fields">
        <div className="field">
          <label htmlFor={ids.quantity}>{t('sales.quantity_label')}</label>
          <input
            id={ids.quantity}
            className="text-input"
            inputMode="decimal"
            value={line.quantityText}
            onChange={(event) =>
              setLine((current) => ({ ...current, quantityText: event.target.value }))
            }
          />
        </div>
        {units.length > 1 ? (
          <div className="field">
            <label htmlFor={ids.unit}>{t('sales.unit_label')}</label>
            <select
              id={ids.unit}
              className="text-input"
              value={unitCode}
              onChange={(event) =>
                setLine((current) => ({ ...current, unitCode: event.target.value }))
              }
            >
              {units.map((unit) => (
                <option key={unit.unitCode} value={unit.unitCode}>
                  {unitLabel(unit.unitCode)}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
      {line.quantityText && check.issue === 'QUANTITY_INVALID' ? (
        <p className="error-message">{t('loss.issue.QUANTITY_INVALID')}</p>
      ) : null}
      <div className="field">
        <label htmlFor={ids.cost}>{t('consumption.cost_label')}</label>
        <select
          id={ids.cost}
          className="text-input"
          value={costType}
          onChange={(event) => setCostType(event.target.value as (typeof INPUT_COST_TYPES)[number])}
        >
          {INPUT_COST_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(`consumption.cost.${type}`)}
            </option>
          ))}
        </select>
      </div>
      {over ? (
        online ? (
          <p className="error-message" role="alert">
            {t('consumption.over_online')}
          </p>
        ) : (
          <p className="text-warn">{t('consumption.over_offline')}</p>
        )
      ) : null}
      <button type="button" className="btn-block submit-sale" disabled={!ready} onClick={submit}>
        {t('production.submit.INPUT')}
      </button>
    </>
  );
}

function WeighingForm({ refs, lot, send, blocked, userId }: FormProps) {
  const { t } = useTranslation();
  const locations = rearingLocations(refs.locations, lot);
  const [locationId, setLocationId] = useState('');
  const [sampleText, setSampleText] = useState('');
  const [weightText, setWeightText] = useState('');
  const [totalText, setTotalText] = useState('');
  const ids = { location: useId(), sample: useId(), weight: useId(), total: useId() };
  const sample = parseCount(sampleText);
  const weight = parsePositive(weightText, 1_000_000, 1);
  const total = totalText.trim() === '' ? null : parsePositive(totalText, 1_000_000_000, 3);
  const totalInvalid = totalText.trim() !== '' && total === null;
  const ready = sample !== null && weight !== null && !totalInvalid && !blocked;

  const submit = () => {
    if (!ready || sample === null || weight === null) return;
    void send('WEIGHING', {
      authorUserId: userId,
      commandType: 'production.weighing.record',
      aggregateType: 'LOT_WEIGHING',
      payload: weighingPayload({
        lotId: lot.id,
        locationId,
        sampleSize: sample,
        avgWeightG: weight,
        totalWeightKg: total,
      }),
    }).then((ok) => {
      if (ok) {
        setSampleText('');
        setWeightText('');
        setTotalText('');
      }
    });
  };

  return (
    <>
      {locations.length > 0 ? (
        <div className="field">
          <label htmlFor={ids.location}>{t('production.weighing_location_label')}</label>
          <select
            id={ids.location}
            className="text-input"
            value={locationId}
            onChange={(event) => setLocationId(event.target.value)}
          >
            <option value="">{t('production.whole_lot')}</option>
            {locations.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="line-fields">
        <div className="field">
          <label htmlFor={ids.sample}>{t('production.sample_label')}</label>
          <input
            id={ids.sample}
            className="text-input"
            inputMode="numeric"
            value={sampleText}
            onChange={(event) => setSampleText(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={ids.weight}>{t('production.avg_weight_label')}</label>
          <input
            id={ids.weight}
            className="text-input"
            inputMode="decimal"
            value={weightText}
            onChange={(event) => setWeightText(event.target.value)}
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor={ids.total}>{t('production.total_weight_label')}</label>
        <input
          id={ids.total}
          className="text-input"
          inputMode="decimal"
          value={totalText}
          onChange={(event) => setTotalText(event.target.value)}
        />
      </div>
      {(sampleText && sample === null) || (weightText && weight === null) || totalInvalid ? (
        <p className="error-message">{t('production.weighing_invalid')}</p>
      ) : null}
      <button type="button" className="btn-block submit-sale" disabled={!ready} onClick={submit}>
        {t('production.submit.WEIGHING')}
      </button>
    </>
  );
}

function ObservationForm({ lot, send, blocked, userId }: FormProps) {
  const { t } = useTranslation();
  const [type, setType] = useState<(typeof OBSERVATION_TYPES)[number]>('SANITAIRE');
  const [severity, setSeverity] = useState<(typeof OBSERVATION_SEVERITIES)[number]>('INFO');
  const [text, setText] = useState('');
  const ids = { type: useId(), severity: useId(), text: useId() };
  const ready = text.trim() !== '' && !blocked;

  const submit = () => {
    if (!ready) return;
    void send('OBSERVATION', {
      authorUserId: userId,
      commandType: 'production.observation.record',
      aggregateType: 'LOT_OBSERVATION',
      payload: observationPayload({ lotId: lot.id, type, severity, text }),
    }).then((ok) => {
      if (ok) setText('');
    });
  };

  return (
    <>
      <div className="line-fields">
        <div className="field">
          <label htmlFor={ids.type}>{t('production.observation_type_label')}</label>
          <select
            id={ids.type}
            className="text-input"
            value={type}
            onChange={(event) => setType(event.target.value as (typeof OBSERVATION_TYPES)[number])}
          >
            {OBSERVATION_TYPES.map((value) => (
              <option key={value} value={value}>
                {t(`production.observation_type.${value}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.severity}>{t('production.severity_label')}</label>
          <select
            id={ids.severity}
            className="text-input"
            value={severity}
            onChange={(event) =>
              setSeverity(event.target.value as (typeof OBSERVATION_SEVERITIES)[number])
            }
          >
            {OBSERVATION_SEVERITIES.map((value) => (
              <option key={value} value={value}>
                {t(`production.severity.${value}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor={ids.text}>{t('production.observation_text_label')}</label>
        <textarea
          id={ids.text}
          className="text-input"
          rows={3}
          maxLength={MAX_OBSERVATION_TEXT}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </div>
      <button type="button" className="btn-block submit-sale" disabled={!ready} onClick={submit}>
        {t('production.submit.OBSERVATION')}
      </button>
    </>
  );
}

export function DailyEntryScreen() {
  const { t } = useTranslation();
  const { lotId } = useParams();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
  const online = useOnline();
  const [kind, setKind] = useState<EntryKind>('MORTALITY');
  const [last, setLast] = useState<{ commandId: string; kind: EntryKind }>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);

  const back = (
    <Link to={ROUTES.productionLots} className="back-link">
      {t('production.back')}
    </Link>
  );

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.daily_entry')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const lot = refs.productionLots.find((candidate) => candidate.id === lotId);
  if (!lot || !isDailyLot(lot)) {
    return (
      <section className="sale">
        {back}
        <h1>{t('nav.screens.daily_entry')}</h1>
        <p className="alert alert-error">{t('production.lot_not_daily')}</p>
      </section>
    );
  }

  const today = businessDayOf(clock.now());
  const journal = todayJournal(refs, lot.id, today);
  const awaitingPhoto = mortalitiesAwaitingApproval(refs, lot.id);
  const heads = rearingHeadcount(refs, lot);
  const settling =
    last !== undefined && !refs.outbox.some((command) => command.command_id === last.commandId);
  const blocked = busy || settling;

  const send = async (entry: EntryKind, input: Parameters<typeof submitCommand>[0]) => {
    if (blocked) return false;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand(input);
      setLast({ commandId: command.command_id, kind: entry });
      return true;
    } catch {
      setSaveError(true);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const props: FormProps = { refs, lot, online, send, blocked, userId };

  return (
    <section className="sale">
      {back}
      <h1>{t('production.daily_title', { code: lot.lot_code })}</h1>
      <p className="home-muted">
        {t(`production.lot_type.${lot.lot_type}`, { defaultValue: lot.lot_type })} ·{' '}
        {heads === null
          ? t('production.headcount_unknown')
          : t('production.headcount', { heads: formatQuantityUnit(heads, 'TETE') })}
      </p>
      {!online ? (
        <p className="home-banner" role="status">
          {t('production.offline_banner')}
        </p>
      ) : null}
      {last ? (
        <CommandResult commandId={last.commandId} messages={`production.result_${last.kind}`} />
      ) : null}
      {laysEggs(lot) ? (
        <p>
          <Link to={ROUTES.eggCollectionFor(lot.id)}>{t('production.to_egg_collection')}</Link>
        </p>
      ) : null}
      <p>
        <Link to={ROUTES.productionOutputFor(lot.id)}>{t('production.to_output')}</Link>
      </p>
      <p>
        <Link to={ROUTES.lotSheetFor(lot.id)}>{t('production.to_sheet')}</Link>
      </p>
      <fieldset className="choice-group">
        <legend>{t('production.kind_label')}</legend>
        {KINDS.map((value) => (
          <label key={value} className="choice">
            <input
              type="radio"
              name="daily-kind"
              value={value}
              checked={kind === value}
              onChange={() => setKind(value)}
            />
            {t(`production.kind.${value}`)}
          </label>
        ))}
      </fieldset>
      {/* Les quatre formulaires restent montés : changer de nature ne perd pas un brouillon. */}
      {KINDS.map((value) => (
        <section
          key={value}
          className="sale-block"
          aria-label={t(`production.kind.${value}`)}
          hidden={kind !== value}
        >
          {value === 'MORTALITY' ? <MortalityForm {...props} /> : null}
          {value === 'INPUT' ? <InputForm {...props} /> : null}
          {value === 'WEIGHING' ? <WeighingForm {...props} /> : null}
          {value === 'OBSERVATION' ? <ObservationForm {...props} /> : null}
        </section>
      ))}
      {saveError ? (
        <p className="alert alert-error" role="alert">
          {t('sales.error_local_save')}
        </p>
      ) : null}
      {awaitingPhoto.length > 0 ? (
        <section className="sale-block" aria-labelledby="production-photos-title">
          <h2 id="production-photos-title">{t('photo.mortality_awaiting_title')}</h2>
          <p className="home-muted">{t('photo.mortality_awaiting_hint')}</p>
          <ul className="receipt-lines">
            {awaitingPhoto.map((mortality) => (
              <li key={mortality.id}>
                <span>
                  <strong>
                    {t('photo.mortality_awaiting_line', {
                      heads: formatQuantityUnit(mortality.heads, 'TETE'),
                      date: formatMoment(mortality.at, today),
                    })}
                  </strong>
                  <AttachPhoto
                    userId={userId}
                    target={{
                      kind: 'PHOTO',
                      ownerType: 'STOCK_LOSS',
                      cited: false,
                      ownerId: mortality.id,
                    }}
                    label={t('photo.attach_mortality')}
                  />
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="sale-block" aria-labelledby="production-journal-title">
        <h2 id="production-journal-title">{t('production.journal_title')}</h2>
        {journal.length === 0 ? (
          <p className="home-muted">{t('production.journal_empty')}</p>
        ) : (
          <ul className="receipt-lines">
            {journal.map((entry) => (
              <li key={entry.id}>
                <span>
                  <strong>{t(`production.journal.${entry.kind}`, entry.values)}</strong>
                  {entry.kind === 'OBSERVATION' ? <small>{String(entry.values.text)}</small> : null}
                  {entry.values.status === 'PENDING_APPROVAL' ? (
                    <small>{t('production.journal_pending_approval')}</small>
                  ) : null}
                </span>
                <span>
                  {formatClockTime(entry.at)}
                  {entry.pending ? <small>{t('portfolio.pending')}</small> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
