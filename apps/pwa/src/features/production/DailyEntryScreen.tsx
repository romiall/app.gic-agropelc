/**
 * ECR-PRD-02 « SAISIE DU JOUR » d'un lot (responsable de ferme ; WF-J4). Mortalité, aliment et
 * intrants, pesée, observation : chaque saisie est une commande distincte, utilisable hors ligne, et
 * apparaît aussitôt dans le journal du jour. La collecte d'œufs a son propre écran. Les mortalités
 * partent en validation selon la politique `MORTALITY` ; la photo de la mortalité est jointe à la saisie, ou
 * après coup tant qu'elle attend la décision (AV-107, ADR-046).
 *
 * Refonte (ADR-049, lot L6) : réalisable d'une main sur téléphone — liens vers les écrans voisins en rangée,
 * nature de la saisie en tuiles, champs numériques avec leur unité, bouton d'enregistrement dans la barre
 * d'action collée au-dessus des onglets ; les quatre formulaires restent montés.
 */
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { businessDayOf } from '@gic/domain';
import { ROUTES } from '../../app/screens.js';
import {
  ActionBar,
  Badge,
  Banner,
  Button,
  Field,
  Icon,
  Input,
  LinkButton,
  List,
  ListRow,
  PageHeader,
  Section,
  Segmented,
  Select,
  SkeletonRows,
  Textarea,
  type IconName,
} from '../../components/ui/index.js';
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
import { demandeSuiviLot, lundiDe } from '../pieces/adaptateurs-stock.js';
import { PieceAction } from '../pieces/PieceAction.js';
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
  type JournalKind,
} from './daily.js';
import './production.css';

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

/** Icône de chaque nature de saisie (tuile du choix, ligne du journal). */
const KIND_ICON: Record<EntryKind, IconName> = {
  MORTALITY: 'alert',
  INPUT: 'box',
  WEIGHING: 'chart',
  OBSERVATION: 'clipboard',
};
const JOURNAL_ICON: Record<JournalKind, IconName> = { ...KIND_ICON, EGGS: 'leaf' };

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

  const quantityError =
    quantityText && quantity === null
      ? t('production.count_invalid')
      : over && online
        ? t('production.deaths_over_online')
        : undefined;

  return (
    <>
      <div className="prd-form">
        {locations.length === 0 ? (
          <Banner tone="bad">{t('production.no_rearing_location')}</Banner>
        ) : null}
        <Field
          label={t('production.deaths_label')}
          unit={unitLabel('TETE', 2)}
          error={quantityError}
        >
          {(control) => (
            <Input
              {...control}
              inputMode="numeric"
              value={quantityText}
              onChange={(event) => setQuantityText(event.target.value)}
            />
          )}
        </Field>
        {over && !online ? (
          <p className="prd-note is-warn">{t('production.deaths_over_offline')}</p>
        ) : null}
        {locations.length > 0 ? (
          <Field
            label={t('production.rearing_location_label')}
            hint={
              heads !== null
                ? t('production.location_headcount', { heads: formatQuantityUnit(heads, 'TETE') })
                : undefined
            }
          >
            {(control) => (
              <Select
                {...control}
                value={location?.id ?? ''}
                onChange={(event) => setLocationChoice(event.target.value)}
              >
                {locations.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        <Field label={t('production.cause_label')}>
          {(control) => (
            <Select
              {...control}
              value={reasonId}
              onChange={(event) => setReasonId(event.target.value)}
            >
              <option value="">{t('production.cause_placeholder')}</option>
              {reasons.map((reason) => (
                <option key={reason.id} value={reason.id}>
                  {reason.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label={
            commentRequired ? t('production.comment_required_label') : t('production.comment_label')
          }
          error={commentMissing ? t('production.comment_required') : undefined}
        >
          {(control) => (
            <Textarea
              {...control}
              rows={2}
              maxLength={MAX_DAILY_COMMENT}
              value={comment}
              aria-required={commentRequired}
              onChange={(event) => setComment(event.target.value)}
            />
          )}
        </Field>
        <PhotoField
          key={photoField}
          label={t('photo.mortality_label')}
          hint={t('photo.mortality_hint')}
          value={photo}
          onChange={setPhoto}
          onBusyChange={setPreparing}
        />
      </div>
      <ActionBar>
        <Button size="lg" className="submit-sale" disabled={!ready} onClick={submit}>
          {t('production.submit.MORTALITY')}
        </Button>
      </ActionBar>
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

  const quantityError =
    line.quantityText && check.issue === 'QUANTITY_INVALID'
      ? t('loss.issue.QUANTITY_INVALID')
      : over && online
        ? t('consumption.over_online')
        : undefined;

  return (
    <>
      <div className="prd-form">
        {products.length === 0 ? (
          <Banner tone="bad">{t('production.no_consumable')}</Banner>
        ) : (
          <Field
            label={t('production.input_product_label')}
            hint={
              product
                ? t('sales.product_available', {
                    quantity: formatQuantity(left),
                    unit: unitLabel(product.base_unit_code, left, refs.units),
                  })
                : undefined
            }
          >
            {(control) => (
              <Select
                {...control}
                value={line.productId}
                onChange={(event) =>
                  setLine((current) => ({
                    ...current,
                    productId: event.target.value,
                    unitCode: '',
                  }))
                }
              >
                <option value="">{t('loss.product_placeholder')}</option>
                {products.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <div className={units.length > 1 ? 'prd-pair' : undefined}>
          <Field
            label={t('sales.quantity_label')}
            unit={units.length > 1 || !unitCode ? undefined : unitLabel(unitCode, 2, refs.units)}
            error={quantityError}
          >
            {(control) => (
              <Input
                {...control}
                inputMode="decimal"
                value={line.quantityText}
                onChange={(event) =>
                  setLine((current) => ({ ...current, quantityText: event.target.value }))
                }
              />
            )}
          </Field>
          {units.length > 1 ? (
            <Field label={t('sales.unit_label')}>
              {(control) => (
                <Select
                  {...control}
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
                </Select>
              )}
            </Field>
          ) : null}
        </div>
        {over && !online ? (
          <p className="prd-note is-warn">{t('consumption.over_offline')}</p>
        ) : null}
        <Field label={t('production.input_location_label')}>
          {(control) => (
            <Select
              {...control}
              value={location?.id ?? ''}
              onChange={(event) => setLocationChoice(event.target.value)}
            >
              {locations.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('consumption.cost_label')}>
          {(control) => (
            <Select
              {...control}
              value={costType}
              onChange={(event) =>
                setCostType(event.target.value as (typeof INPUT_COST_TYPES)[number])
              }
            >
              {INPUT_COST_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`consumption.cost.${type}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <ActionBar>
        <Button size="lg" className="submit-sale" disabled={!ready} onClick={submit}>
          {t('production.submit.INPUT')}
        </Button>
      </ActionBar>
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
      <div className="prd-form">
        <div className="prd-pair">
          <Field label={t('production.sample_label')}>
            {(control) => (
              <Input
                {...control}
                inputMode="numeric"
                value={sampleText}
                onChange={(event) => setSampleText(event.target.value)}
              />
            )}
          </Field>
          <Field label={t('production.avg_weight_label')}>
            {(control) => (
              <Input
                {...control}
                inputMode="decimal"
                value={weightText}
                onChange={(event) => setWeightText(event.target.value)}
              />
            )}
          </Field>
        </div>
        {(sampleText && sample === null) || (weightText && weight === null) || totalInvalid ? (
          <p className="prd-note is-bad">{t('production.weighing_invalid')}</p>
        ) : null}
        {locations.length > 0 ? (
          <Field label={t('production.weighing_location_label')}>
            {(control) => (
              <Select
                {...control}
                value={locationId}
                onChange={(event) => setLocationId(event.target.value)}
              >
                <option value="">{t('production.whole_lot')}</option>
                {locations.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        <Field label={t('production.total_weight_label')}>
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              value={totalText}
              onChange={(event) => setTotalText(event.target.value)}
            />
          )}
        </Field>
      </div>
      <ActionBar>
        <Button size="lg" className="submit-sale" disabled={!ready} onClick={submit}>
          {t('production.submit.WEIGHING')}
        </Button>
      </ActionBar>
    </>
  );
}

function ObservationForm({ lot, send, blocked, userId }: FormProps) {
  const { t } = useTranslation();
  const [type, setType] = useState<(typeof OBSERVATION_TYPES)[number]>('SANITAIRE');
  const [severity, setSeverity] = useState<(typeof OBSERVATION_SEVERITIES)[number]>('INFO');
  const [text, setText] = useState('');
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
      <div className="prd-form">
        <Field label={t('production.observation_type_label')}>
          {(control) => (
            <Select
              {...control}
              value={type}
              onChange={(event) =>
                setType(event.target.value as (typeof OBSERVATION_TYPES)[number])
              }
            >
              {OBSERVATION_TYPES.map((value) => (
                <option key={value} value={value}>
                  {t(`production.observation_type.${value}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="field">
          <span className="field-label">{t('production.severity_label')}</span>
          <Segmented
            label={t('production.severity_label')}
            value={severity}
            onChange={setSeverity}
            options={OBSERVATION_SEVERITIES.map((value) => ({
              value,
              label: t(`production.severity.${value}`),
            }))}
          />
        </div>
        <Field label={t('production.observation_text_label')}>
          {(control) => (
            <Textarea
              {...control}
              rows={3}
              maxLength={MAX_OBSERVATION_TEXT}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          )}
        </Field>
      </div>
      <ActionBar>
        <Button size="lg" className="submit-sale" disabled={!ready} onClick={submit}>
          {t('production.submit.OBSERVATION')}
        </Button>
      </ActionBar>
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
  // Le bouton d'enregistrement est au bas de l'écran, le retour de l'opération en haut : une nouvelle
  // saisie ramène le retour sous les yeux (sans bouger s'il y est déjà).
  const result = useRef<HTMLDivElement>(null);
  const lastCommandId = last?.commandId;
  useEffect(() => {
    if (lastCommandId) result.current?.scrollIntoView?.({ block: 'nearest' });
  }, [lastCommandId]);

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <PageHeader title={t('nav.screens.daily_entry')} />
        <SkeletonRows />
      </section>
    );
  }

  const lot = refs.productionLots.find((candidate) => candidate.id === lotId);
  if (!lot || !isDailyLot(lot)) {
    return (
      <section className="sale">
        <PageHeader
          backTo={ROUTES.productionLots}
          backLabel={t('production.back')}
          title={t('nav.screens.daily_entry')}
        />
        <Banner tone="bad">{t('production.lot_not_daily')}</Banner>
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
      <PageHeader
        backTo={ROUTES.productionLots}
        backLabel={t('production.back')}
        title={t('nav.screens.daily_entry')}
        subtitle={
          <>
            <strong className="prd-lot-code">{lot.lot_code}</strong>
            {` · ${t(`production.lot_type.${lot.lot_type}`, { defaultValue: lot.lot_type })} · ${
              heads === null
                ? t('production.headcount_unknown')
                : t('production.headcount', { heads: formatQuantityUnit(heads, 'TETE') })
            }`}
          </>
        }
      />
      <div className="prd-narrow">
        {!online ? (
          <Banner tone="warn" role="status">
            {t('production.offline_banner')}
          </Banner>
        ) : null}
        <div ref={result} className="prd-result">
          {last ? (
            <CommandResult commandId={last.commandId} messages={`production.result_${last.kind}`} />
          ) : null}
        </div>
        <div className="chip-row">
          {laysEggs(lot) ? (
            <LinkButton to={ROUTES.eggCollectionFor(lot.id)} variant="tonal" size="sm" icon="leaf">
              {t('production.to_egg_collection')}
            </LinkButton>
          ) : null}
          <LinkButton
            to={ROUTES.productionOutputFor(lot.id)}
            variant="tonal"
            size="sm"
            icon="truck"
          >
            {t('production.to_output')}
          </LinkButton>
          <LinkButton to={ROUTES.lotSheetFor(lot.id)} variant="tonal" size="sm" icon="file">
            {t('production.to_sheet')}
          </LinkButton>
        </div>
        <Segmented
          label={t('production.kind_label')}
          className="prd-kinds"
          value={kind}
          onChange={setKind}
          options={KINDS.map((value) => ({
            value,
            label: (
              <>
                <Icon name={KIND_ICON[value]} size={20} />
                {t(`production.kind.${value}`)}
              </>
            ),
          }))}
        />
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
        {saveError ? <Banner tone="bad">{t('sales.error_local_save')}</Banner> : null}
        {awaitingPhoto.length > 0 ? (
          <Section title={t('photo.mortality_awaiting_title')} className="prd-after">
            <p className="prd-note">{t('photo.mortality_awaiting_hint')}</p>
            <List>
              {awaitingPhoto.map((mortality) => (
                <li key={mortality.id} className="prd-await">
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
            </List>
          </Section>
        ) : null}
        <Section title={t('production.journal_title')} className="prd-after">
          {journal.length === 0 ? (
            <p className="prd-note">{t('production.journal_empty')}</p>
          ) : (
            <List>
              {journal.map((entry) => (
                <ListRow
                  key={entry.id}
                  icon={JOURNAL_ICON[entry.kind]}
                  iconTone={entry.kind === 'MORTALITY' ? 'warn' : undefined}
                  title={t(`production.journal.${entry.kind}`, entry.values)}
                  subtitle={entry.kind === 'OBSERVATION' ? String(entry.values.text) : undefined}
                  badge={
                    <>
                      <span className="prd-time">{formatClockTime(entry.at)}</span>
                      {entry.values.status === 'PENDING_APPROVAL' ? (
                        <Badge tone="warn">{t('production.journal_pending_approval')}</Badge>
                      ) : null}
                      {entry.pending ? <Badge tone="info">{t('portfolio.pending')}</Badge> : null}
                    </>
                  }
                />
              ))}
            </List>
          )}
        </Section>
      </div>
      <div className="prd-after">
        <PieceAction
          cle={`FL:${lot.id}:${lundiDe(today)}`}
          libelle={t('piece.lot_week')}
          demande={() => demandeSuiviLot(lot, lundiDe(today), refs)}
        />
      </div>
    </section>
  );
}
