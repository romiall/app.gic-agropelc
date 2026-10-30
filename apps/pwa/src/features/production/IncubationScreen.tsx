/**
 * ECR-PRD-06 « Incubation » (responsable de ferme, responsable de production ; action `INCUBATIONS` ;
 * hors ligne). Lots d'incubation en cours avec leurs compteurs et leur échéancier, étapes du jour
 * (mirage, transfert vers l'éclosoir, éclosion) et démarrage d'un lot. Bilans contrôlés par le
 * domaine partagé ; une étape sur un lot démarré ici attend son démarrage.
 *
 * Refonte (ADR-049, lot L6) : rubriques en contrôle segmenté, situation d'un lot en pastille, étapes en
 * boutons teintés, formulaire d'une étape sous la carte du lot, démarrage dans la barre d'action collée.
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActionBar,
  Badge,
  Banner,
  Button,
  EmptyState,
  Field,
  Input,
  List,
  ListRow,
  PageHeader,
  Section,
  Segmented,
  SkeletonRows,
  Textarea,
  type BadgeTone,
} from '../../components/ui/index.js';
import { clock } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatBusinessDay } from '../home/format-home.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatQuantity } from '../sales/format.js';
import { useSalesReferences, type SalesReferences } from '../sales/references.js';
import { submitCommand } from '../sales/submit.js';
import {
  batchViews,
  candlingError,
  chickProducts,
  eggSources,
  eggsRemaining,
  hatchers,
  hatchError,
  hatchingEggProduct,
  incubationFarms,
  incubationSpecies,
  incubators,
  MAX_CANCEL_COMMENT,
  normalizeSpecies,
  parseEggCount,
  stepDependsOn,
  type BatchView,
} from './incubation.js';
import { SelectField } from './SelectField.js';
import './production.css';

type Send = (input: Parameters<typeof submitCommand>[0]) => Promise<boolean>;
type Panel = 'CANDLING' | 'TRANSFER' | 'HATCH' | 'CANCEL' | null;

/** Ton de la pastille de situation d'un lot d'incubation. */
const BATCH_TONE: Readonly<Record<string, BadgeTone>> = {
  INCUBATING: 'info',
  IN_HATCHER: 'brand',
  CLOSED: 'ok',
  CANCELLED: 'bad',
};

function NumberField({
  label,
  value,
  onChange,
  errorId,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Anomalie affichée qui porte sur ce champ (reliée et annoncée). */
  readonly errorId?: string | undefined;
}) {
  return (
    <Field label={label}>
      {(control) => (
        <Input
          {...control}
          inputMode="numeric"
          value={value}
          aria-invalid={errorId ? true : undefined}
          aria-describedby={errorId}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
}

const EMPTY_COUNTS = {
  infertile: '',
  earlyDead: '',
  unhatched: '',
  hatchedViable: '',
  hatchedNonviable: '',
};

function BatchCard({
  batch,
  refs,
  send,
  blocked,
  online,
  userId,
}: {
  readonly batch: BatchView;
  readonly refs: SalesReferences;
  readonly send: Send;
  readonly blocked: boolean;
  readonly online: boolean;
  readonly userId: string;
}) {
  const { t } = useTranslation();
  const [panel, setPanel] = useState<Panel>(null);
  const [counts, setCounts] = useState(EMPTY_COUNTS);
  const [hatcherId, setHatcherId] = useState('');
  const [outputId, setOutputId] = useState('');
  const [comment, setComment] = useState('');
  const ids = {
    candlingError: useId(),
    hatchError: useId(),
    hold: useId(),
    cancelOffline: useId(),
    cancelPanelReason: useId(),
  };
  const products = new Map(refs.products.map((product) => [product.id, product]));
  const locationNames = new Map(refs.locations.map((location) => [location.id, location.name]));
  // Restant affiché (jeu `production`) et restant contrôlé (borné par le stock réel du lot).
  const shownRemaining = eggsRemaining(batch.counters);
  const remaining = eggsRemaining(batch.checkCounters);
  // Éclosion suspendue : étape d'un autre utilisateur en attente, stock épuisé alors que le jeu
  // annonce des œufs (données périmées), ou perte en attente (en ligne, le serveur refuserait).
  const hatchHold = batch.otherAuthorWaiting
    ? 'incubation.other_author_waiting'
    : batch.allLost
      ? 'incubation.all_lost'
      : batch.stockStale
        ? 'incubation.stock_stale'
        : online && batch.pendingLoss
          ? 'incubation.pending_loss_hold'
          : null;
  const hatcherList = hatchers(refs.locations, batch.siteId);
  const outputs = refs.locations
    .filter(
      (location) =>
        location.site_id === batch.siteId && !location.is_virtual && location.status === 'ACTIVE',
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const parsed = {
    infertile: parseEggCount(counts.infertile),
    earlyDead: parseEggCount(counts.earlyDead),
    unhatched: parseEggCount(counts.unhatched),
    hatchedViable: parseEggCount(counts.hatchedViable),
    hatchedNonviable: parseEggCount(counts.hatchedNonviable),
  };
  const candling =
    parsed.infertile !== null && parsed.earlyDead !== null
      ? { infertile: parsed.infertile, earlyDead: parsed.earlyDead }
      : null;
  const hatch =
    parsed.unhatched !== null && parsed.hatchedViable !== null && parsed.hatchedNonviable !== null
      ? {
          unhatched: parsed.unhatched,
          hatchedViable: parsed.hatchedViable,
          hatchedNonviable: parsed.hatchedNonviable,
        }
      : null;
  const candlingIssue = candling ? candlingError(batch, candling) : null;
  const candlingProblem = !candling
    ? t('incubation.count_invalid')
    : candlingIssue
      ? t('incubation.candling_over', {
          counted: formatQuantity(candlingIssue.counted),
          remaining: formatQuantity(candlingIssue.remaining),
        })
      : null;
  const hatchIssue = hatch ? hatchError(batch, hatch) : null;
  const hatchProblem = !hatch
    ? t('incubation.count_invalid')
    : hatchIssue
      ? t('incubation.hatch_unbalanced', {
          counted: formatQuantity(hatchIssue.counted),
          remaining: formatQuantity(hatchIssue.remaining),
        })
      : null;
  // Saisie remise à zéro à chaque ouverture et après un envoi (pas de second mirage à un clic).
  const open = (next: Panel) => {
    setCounts(EMPTY_COUNTS);
    setHatcherId('');
    setOutputId('');
    setComment('');
    setPanel(next);
  };
  const step = (commandType: string, payload: Record<string, unknown>) =>
    void send({
      authorUserId: userId,
      commandType,
      aggregateType: 'INCUBATION_EVENT',
      dependsOn: stepDependsOn(batch),
      payload: { batchId: batch.id, ...payload },
    }).then((ok) => {
      if (ok) open(null);
    });
  const candlingShown = Boolean((counts.infertile || counts.earlyDead) && candlingProblem);
  const hatchShown = Boolean(
    (counts.unhatched || counts.hatchedViable || counts.hatchedNonviable) && hatchProblem,
  );
  const set = (key: keyof typeof counts) => (value: string) =>
    setCounts((current) => ({ ...current, [key]: value }));
  const label = batch.batchCode ?? t('incubation.pending_batch');

  return (
    <li className="line-card prd-batch" aria-label={label}>
      <div className="line-head">
        <strong>{label}</strong>
        <Badge tone={BATCH_TONE[batch.status] ?? 'muted'}>
          {t(`incubation.status.${batch.status}`, { defaultValue: batch.status })}
        </Badge>
      </div>
      <p className="prd-note">
        {[
          products.get(batch.chickProductId)?.name,
          locationNames.get(batch.hatcherLocationId ?? batch.incubatorLocationId),
          batch.pendingSteps > 0 ? t('incubation.pending_steps') : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      <p className="prd-counters">
        {t('incubation.counters', {
          set: formatQuantity(batch.counters.eggsSet),
          removed: formatQuantity(batch.counters.infertile + batch.counters.earlyDead),
          lost: formatQuantity(batch.counters.accidentalLoss),
          remaining: formatQuantity(shownRemaining),
        })}
      </p>
      {batch.stockGap > 0 && !batch.stockStale ? (
        <p className="prd-note is-warn">
          {t('incubation.stock_gap', { gap: formatQuantity(batch.stockGap) })}
        </p>
      ) : null}
      {batch.pendingLoss ? (
        <p className="prd-note is-warn">{t('incubation.pending_loss')}</p>
      ) : null}
      {hatchHold ? (
        <p id={ids.hold} className="prd-note is-warn" role="status">
          {t(hatchHold)}
        </p>
      ) : null}
      {batch.expectedHatchDate ? (
        <p className="prd-note">
          {t('incubation.schedule', {
            candling: batch.expectedCandlingDate
              ? formatBusinessDay(batch.expectedCandlingDate)
              : '—',
            transfer: batch.expectedTransferDate
              ? formatBusinessDay(batch.expectedTransferDate)
              : '—',
            hatch: formatBusinessDay(batch.expectedHatchDate),
          })}
        </p>
      ) : null}

      {panel === null && (batch.status === 'INCUBATING' || batch.status === 'IN_HATCHER') ? (
        <div className="prd-actions">
          {batch.status === 'INCUBATING' ? (
            <>
              <Button
                variant="tonal"
                disabled={blocked || batch.allLost}
                aria-describedby={batch.allLost ? ids.hold : undefined}
                onClick={() => open('CANDLING')}
              >
                {t('incubation.candling')}
              </Button>
              <Button
                variant="tonal"
                disabled={blocked || batch.allLost}
                aria-describedby={batch.allLost ? ids.hold : undefined}
                onClick={() => open('TRANSFER')}
              >
                {t('incubation.transfer')}
              </Button>
            </>
          ) : (
            <Button
              variant="tonal"
              disabled={blocked || hatchHold !== null}
              onClick={() => open('HATCH')}
            >
              {t('incubation.hatch')}
            </Button>
          )}
          {batch.allLost ? (
            <>
              <Button
                variant="outline"
                disabled={blocked || !online}
                aria-describedby={!online ? ids.cancelOffline : undefined}
                onClick={() => open('CANCEL')}
              >
                {t('incubation.cancel_open')}
              </Button>
              {!online ? (
                <p id={ids.cancelOffline} className="prd-note">
                  {t('incubation.cancel_online_only')}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {panel === 'CANCEL' ? (
        <div className="prd-panel">
          <p className="prd-note">{t('incubation.cancel_hint')}</p>
          <div className="prd-form">
            <Field label={t('incubation.cancel_comment_label')}>
              {(control) => (
                <Textarea
                  {...control}
                  rows={2}
                  maxLength={MAX_CANCEL_COMMENT}
                  aria-required="true"
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                />
              )}
            </Field>
            {!online || !batch.allLost ? (
              <p id={ids.cancelPanelReason} className="prd-note is-warn" role="status">
                {!online ? t('incubation.cancel_online_only') : t('incubation.cancel_no_longer')}
              </p>
            ) : null}
          </div>
          <div className="prd-actions">
            <Button
              disabled={blocked || !online || !batch.allLost || comment.trim() === ''}
              aria-describedby={!online || !batch.allLost ? ids.cancelPanelReason : undefined}
              onClick={() => step('production.incubation.cancel', { comment: comment.trim() })}
            >
              {t('incubation.save_cancel')}
            </Button>
            <Button variant="ghost" onClick={() => setPanel(null)}>
              {t('price_rules.cancel')}
            </Button>
          </div>
        </div>
      ) : null}

      {panel === 'CANDLING' ? (
        <div className="prd-panel">
          <div className="prd-pair">
            <NumberField
              label={t('incubation.infertile_label')}
              value={counts.infertile}
              onChange={set('infertile')}
              errorId={candlingShown ? ids.candlingError : undefined}
            />
            <NumberField
              label={t('incubation.early_dead_label')}
              value={counts.earlyDead}
              onChange={set('earlyDead')}
              errorId={candlingShown ? ids.candlingError : undefined}
            />
          </div>
          {candlingShown ? (
            <p id={ids.candlingError} className="prd-note is-bad" role="alert">
              {candlingProblem}
            </p>
          ) : null}
          <div className="prd-actions">
            <Button
              disabled={
                blocked ||
                candlingProblem !== null ||
                !candling ||
                candling.infertile + candling.earlyDead === 0
              }
              onClick={() => candling && step('production.incubation.record_candling', candling)}
            >
              {t('incubation.save_candling')}
            </Button>
            <Button variant="ghost" onClick={() => setPanel(null)}>
              {t('price_rules.cancel')}
            </Button>
          </div>
        </div>
      ) : null}

      {panel === 'TRANSFER' ? (
        <div className="prd-panel">
          {hatcherList.length === 0 ? (
            <Banner tone="bad">{t('incubation.no_hatcher')}</Banner>
          ) : (
            <SelectField
              label={t('incubation.hatcher_label')}
              value={hatcherId}
              onChange={setHatcherId}
              options={hatcherList.map((location) => ({
                value: location.id,
                label: location.name,
              }))}
              placeholder={t('lot_setup.choose')}
            />
          )}
          <p className="prd-note">
            {t('incubation.transfer_hint', { remaining: formatQuantity(remaining) })}
          </p>
          <div className="prd-actions">
            <Button
              disabled={blocked || !hatcherId}
              onClick={() =>
                step('production.incubation.transfer_to_hatcher', { hatcherLocationId: hatcherId })
              }
            >
              {t('incubation.save_transfer')}
            </Button>
            <Button variant="ghost" onClick={() => setPanel(null)}>
              {t('price_rules.cancel')}
            </Button>
          </div>
        </div>
      ) : null}

      {panel === 'HATCH' ? (
        <div className="prd-panel">
          <div className="prd-form">
            <div className="prd-grid">
              <NumberField
                label={t('incubation.viable_label')}
                value={counts.hatchedViable}
                onChange={set('hatchedViable')}
                errorId={hatchShown ? ids.hatchError : undefined}
              />
              <NumberField
                label={t('incubation.nonviable_label')}
                value={counts.hatchedNonviable}
                onChange={set('hatchedNonviable')}
                errorId={hatchShown ? ids.hatchError : undefined}
              />
              <NumberField
                label={t('incubation.unhatched_label')}
                value={counts.unhatched}
                onChange={set('unhatched')}
                errorId={hatchShown ? ids.hatchError : undefined}
              />
            </div>
            <SelectField
              label={t('incubation.output_label')}
              value={outputId}
              onChange={setOutputId}
              options={outputs.map((location) => ({ value: location.id, label: location.name }))}
              placeholder={t('incubation.output_default', {
                name: locationNames.get(batch.hatcherLocationId ?? batch.incubatorLocationId) ?? '',
              })}
            />
            <p className="prd-note">
              {t('incubation.hatch_hint', { remaining: formatQuantity(remaining) })}
            </p>
            {hatchShown ? (
              <p id={ids.hatchError} className="prd-note is-bad" role="alert">
                {hatchProblem}
              </p>
            ) : null}
          </div>
          <div className="prd-actions">
            <Button
              disabled={blocked || hatchHold !== null || hatchProblem !== null || !hatch}
              aria-describedby={hatchHold ? ids.hold : undefined}
              onClick={() =>
                hatch &&
                step('production.incubation.record_hatch', {
                  ...hatch,
                  ...(outputId ? { outputLocationId: outputId } : {}),
                })
              }
            >
              {t('incubation.save_hatch')}
            </Button>
            <Button variant="ghost" onClick={() => setPanel(null)}>
              {t('price_rules.cancel')}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function StartBatch({
  refs,
  send,
  blocked,
  online,
  userId,
  onStarted,
}: {
  readonly refs: SalesReferences;
  readonly send: Send;
  readonly blocked: boolean;
  readonly online: boolean;
  readonly userId: string;
  readonly onStarted: () => void;
}) {
  const { t } = useTranslation();
  const now = clock.now();
  const farms = incubationFarms(refs, userId);
  const configuredSpecies = incubationSpecies(refs.settings, now);
  const configuredEgg = hatchingEggProduct(refs.products, refs.settings, now);
  const [siteChoice, setSiteChoice] = useState('');
  const [species, setSpecies] = useState('');
  const [eggProductChoice, setEggProductChoice] = useState('');
  const [chickProductId, setChickProductId] = useState('');
  const [incubatorChoice, setIncubatorChoice] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [sourceLotId, setSourceLotId] = useState('');
  const [eggSource, setEggSource] = useState<'INTERNAL' | 'PURCHASED'>('INTERNAL');
  const [eggsText, setEggsText] = useState('');
  const speciesListId = useId();
  const siteId = siteChoice || farms[0]?.id || '';
  const incubatorList = siteId ? incubators(refs.locations, siteId) : [];
  const incubatorId = incubatorList.some((l) => l.id === incubatorChoice)
    ? incubatorChoice
    : (incubatorList[0]?.id ?? '');
  const eggCandidates = configuredEgg
    ? [configuredEgg]
    : refs.products
        .filter((product) => product.stock_family !== 'BIOLOGIQUE' && product.status === 'ACTIVE')
        .filter((product) => siteId && eggSources(refs, siteId, product.id).length > 0)
        .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const eggProductId = configuredEgg?.id ?? eggProductChoice;
  const sources = siteId && eggProductId ? eggSources(refs, siteId, eggProductId) : [];
  const source = sources.find((candidate) => candidate.locationId === sourceId);
  const chicks = chickProducts(refs.products);
  // Saisie libre (durées non servies, S-07) : code en majuscules, comme les clés paramétrées.
  const effectiveSpecies =
    configuredSpecies.length > 0
      ? configuredSpecies.includes(species)
        ? species
        : ''
      : normalizeSpecies(species);
  const knownSpecies = [...new Set(refs.incubationBatches.map((batch) => batch.species))].sort();
  const eggs = parseEggCount(eggsText);
  // Lot désigné revalidé contre la source du moment : la charge utile envoie ce qui s'affiche.
  const lotId = source?.lots.some((lot) => lot.lotId === sourceLotId) ? sourceLotId : '';
  const available = source
    ? (source.lots.find((lot) => lot.lotId === lotId)?.quantity ?? source.quantity)
    : null;
  const over = eggs !== null && available !== null && eggs > available;
  // Lot désigné : des sorties sans lot en attente peuvent le toucher (le plus ancien d'abord).
  const chosenLot = source?.lots.find((lot) => lot.lotId === lotId);
  const lotRisk = !over && eggs !== null && chosenLot !== undefined && eggs > chosenLot.cautious;
  const locationNames = new Map(refs.locations.map((location) => [location.id, location.name]));
  const ready =
    siteId !== '' &&
    effectiveSpecies !== '' &&
    eggProductId !== '' &&
    chickProductId !== '' &&
    incubatorId !== '' &&
    source !== undefined &&
    (source.fifo || lotId !== '') &&
    eggs !== null &&
    eggs > 0 &&
    !(online && over) &&
    !blocked;

  const submit = () => {
    if (!ready || !source || eggs === null) return;
    void send({
      authorUserId: userId,
      commandType: 'production.incubation.start',
      aggregateType: 'INCUBATION_BATCH',
      payload: {
        species: effectiveSpecies,
        eggProductId,
        chickProductId,
        incubatorLocationId: incubatorId,
        eggSource,
        eggsSet: eggs,
        sourceLocationId: source.locationId,
        ...(lotId ? { sourceStockLotId: lotId } : {}),
      },
    }).then((ok) => {
      if (ok) {
        setEggsText('');
        onStarted();
      }
    });
  };

  if (farms.length === 0) return <p className="prd-note">{t('incubation.no_incubator')}</p>;

  const eggsError =
    eggsText && (eggs === null || eggs === 0)
      ? t('incubation.count_invalid')
      : over && online
        ? t('incubation.over_online')
        : undefined;

  return (
    <>
      <div className="prd-form">
        <SelectField
          label={t('lot_setup.farm_label')}
          value={siteId}
          onChange={setSiteChoice}
          options={farms.map((farm) => ({ value: farm.id, label: farm.name }))}
        />
        {configuredSpecies.length > 0 ? (
          <SelectField
            label={t('incubation.species_label')}
            value={effectiveSpecies}
            onChange={setSpecies}
            options={configuredSpecies.map((value) => ({ value, label: value }))}
            placeholder={t('lot_setup.choose')}
          />
        ) : (
          <>
            <Field label={t('incubation.species_label')}>
              {(control) => (
                <>
                  <Input
                    {...control}
                    maxLength={20}
                    autoCapitalize="characters"
                    placeholder="POULE"
                    list={speciesListId}
                    value={species}
                    onChange={(event) => setSpecies(event.target.value)}
                  />
                  <datalist id={speciesListId}>
                    {knownSpecies.map((value) => (
                      <option key={value} value={value} />
                    ))}
                  </datalist>
                </>
              )}
            </Field>
            <p className="prd-note is-warn">{t('incubation.species_not_configured')}</p>
          </>
        )}
        {configuredEgg ? (
          <p className="prd-note">{t('incubation.egg_product', { name: configuredEgg.name })}</p>
        ) : (
          <SelectField
            label={t('incubation.egg_label')}
            value={eggProductChoice}
            onChange={setEggProductChoice}
            options={eggCandidates.map((product) => ({ value: product.id, label: product.name }))}
            placeholder={t('lot_setup.choose')}
          />
        )}
        <SelectField
          label={t('incubation.chick_label')}
          value={chickProductId}
          onChange={setChickProductId}
          options={chicks.map((product) => ({ value: product.id, label: product.name }))}
          placeholder={t('lot_setup.choose')}
        />
        <SelectField
          label={t('incubation.incubator_label')}
          value={incubatorId}
          onChange={setIncubatorChoice}
          options={incubatorList.map((location) => ({ value: location.id, label: location.name }))}
        />
        {eggProductId && sources.length === 0 ? (
          <Banner tone="bad">{t('incubation.no_eggs')}</Banner>
        ) : null}
        {sources.length > 0 ? (
          <SelectField
            label={t('incubation.source_label')}
            value={source ? source.locationId : ''}
            onChange={(value) => {
              setSourceId(value);
              setSourceLotId('');
            }}
            options={sources.map((candidate) => ({
              value: candidate.locationId,
              label: t('incubation.source', {
                place: locationNames.get(candidate.locationId) ?? '',
                quantity: formatQuantity(candidate.quantity),
              }),
            }))}
            placeholder={t('lot_setup.choose')}
          />
        ) : null}
        {source && source.lots.length > 0 ? (
          <>
            <SelectField
              label={t('incubation.egg_lot_label')}
              value={lotId}
              onChange={setSourceLotId}
              options={source.lots.map((lot) => ({
                value: lot.lotId,
                label: `${lot.lotCode} (${formatQuantity(lot.quantity)})`,
              }))}
              placeholder={source.fifo ? t('lot_setup.fifo') : t('lot_setup.choose')}
            />
            {!source.fifo ? <p className="prd-note">{t('incubation.egg_lot_required')}</p> : null}
          </>
        ) : null}
        <div className="field">
          <span className="field-label">{t('incubation.egg_source_label')}</span>
          <Segmented
            label={t('incubation.egg_source_label')}
            value={eggSource}
            onChange={setEggSource}
            options={(['INTERNAL', 'PURCHASED'] as const).map((value) => ({
              value,
              label: t(`incubation.egg_source.${value}`),
            }))}
          />
        </div>
        <Field label={t('incubation.eggs_label')} error={eggsError}>
          {(control) => (
            <Input
              {...control}
              inputMode="numeric"
              value={eggsText}
              onChange={(event) => setEggsText(event.target.value)}
            />
          )}
        </Field>
        {over && !online ? (
          <p className="prd-note is-warn">{t('incubation.over_offline')}</p>
        ) : null}
        {lotRisk ? <p className="prd-note is-warn">{t('lot_setup.lot_fifo_risk')}</p> : null}
      </div>
      <ActionBar>
        <Button size="lg" className="submit-sale" disabled={!ready} onClick={submit}>
          {t('incubation.start')}
        </Button>
      </ActionBar>
    </>
  );
}

export function IncubationScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
  const online = useOnline();
  const [section, setSection] = useState<'BATCHES' | 'START'>('BATCHES');
  const [last, setLast] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <PageHeader title={t('nav.screens.incubation')} />
        <SkeletonRows />
      </section>
    );
  }

  const settling =
    last !== undefined && !refs.outbox.some((command) => command.command_id === last);
  const blocked = busy || settling;
  const batches = batchViews(refs, userId);
  const open = batches.filter(
    (batch) => batch.status === 'INCUBATING' || batch.status === 'IN_HATCHER',
  );
  const done = batches.filter((batch) => batch.status === 'CLOSED' || batch.status === 'CANCELLED');

  const send: Send = async (input) => {
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

  return (
    <section className="sale">
      <PageHeader title={t('nav.screens.incubation')} />
      {!online ? (
        <Banner tone="warn" role="status">
          {t('incubation.offline_banner')}
        </Banner>
      ) : null}
      {last ? <CommandResult commandId={last} messages="incubation.result" /> : null}
      {saveError ? <Banner tone="bad">{t('sales.error_local_save')}</Banner> : null}
      <Segmented
        label={t('incubation.section_label')}
        className="prd-narrow"
        value={section}
        onChange={setSection}
        options={(['BATCHES', 'START'] as const).map((value) => ({
          value,
          label: t(`incubation.section.${value}`),
        }))}
      />
      {section === 'BATCHES' ? (
        <section className="sale-block" aria-label={t('incubation.section.BATCHES')}>
          {open.length === 0 ? (
            <EmptyState icon="leaf" title={t('incubation.none')} />
          ) : (
            <ul className="prd-batches">
              {open.map((batch) => (
                <BatchCard
                  key={batch.id}
                  batch={batch}
                  refs={refs}
                  send={send}
                  blocked={blocked}
                  online={online}
                  userId={userId}
                />
              ))}
            </ul>
          )}
          {done.length > 0 ? (
            <Section title={t('incubation.done_title')}>
              <List>
                {done.map((batch) => (
                  <ListRow
                    key={batch.id}
                    title={batch.batchCode ?? t('incubation.pending_batch')}
                    badge={
                      <Badge tone={BATCH_TONE[batch.status] ?? 'muted'}>
                        {t(`incubation.status.${batch.status}`, { defaultValue: batch.status })}
                      </Badge>
                    }
                  />
                ))}
              </List>
            </Section>
          ) : null}
        </section>
      ) : (
        <section className="sale-block prd-narrow" aria-label={t('incubation.section.START')}>
          <StartBatch
            refs={refs}
            send={send}
            blocked={blocked}
            online={online}
            userId={userId}
            onStarted={() => setSection('BATCHES')}
          />
        </section>
      )}
    </section>
  );
}
