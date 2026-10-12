/**
 * ECR-PRD-06 « Incubation » (responsable de ferme, responsable de production ; action `INCUBATIONS` ;
 * hors ligne). Lots d'incubation en cours avec leurs compteurs et leur échéancier, étapes du jour
 * (mirage, transfert vers l'éclosoir, éclosion) et démarrage d'un lot. Bilans contrôlés par le
 * domaine partagé ; une étape sur un lot démarré ici attend son démarrage.
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
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

type Send = (input: Parameters<typeof submitCommand>[0]) => Promise<boolean>;
type Panel = 'CANDLING' | 'TRANSFER' | 'HATCH' | 'CANCEL' | null;

function NumberField({
  id,
  label,
  value,
  onChange,
  errorId,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Anomalie affichée qui porte sur ce champ (reliée et annoncée). */
  readonly errorId?: string | undefined;
}) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="text-input"
        inputMode="numeric"
        value={value}
        aria-invalid={errorId ? true : undefined}
        aria-describedby={errorId}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
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
    infertile: useId(),
    earlyDead: useId(),
    hatcher: useId(),
    unhatched: useId(),
    viable: useId(),
    nonviable: useId(),
    output: useId(),
    candlingError: useId(),
    hatchError: useId(),
    hold: useId(),
    cancelComment: useId(),
    cancelOffline: useId(),
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
    <li className="line-card" aria-label={label}>
      <div className="line-head">
        <strong>{label}</strong>
        <span className="badge badge-info">
          {t(`incubation.status.${batch.status}`, { defaultValue: batch.status })}
        </span>
      </div>
      <p className="home-muted">
        {[
          products.get(batch.chickProductId)?.name,
          locationNames.get(batch.hatcherLocationId ?? batch.incubatorLocationId),
          batch.pendingSteps > 0 ? t('incubation.pending_steps') : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      <p>
        {t('incubation.counters', {
          set: formatQuantity(batch.counters.eggsSet),
          removed: formatQuantity(batch.counters.infertile + batch.counters.earlyDead),
          lost: formatQuantity(batch.counters.accidentalLoss),
          remaining: formatQuantity(shownRemaining),
        })}
      </p>
      {batch.stockGap > 0 && !batch.stockStale ? (
        <p className="text-warn">
          {t('incubation.stock_gap', { gap: formatQuantity(batch.stockGap) })}
        </p>
      ) : null}
      {batch.pendingLoss ? <p className="text-warn">{t('incubation.pending_loss')}</p> : null}
      {hatchHold ? (
        <p id={ids.hold} className="text-warn" role="status">
          {t(hatchHold)}
        </p>
      ) : null}
      {batch.expectedHatchDate ? (
        <p className="home-muted">
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
        <div className="result-actions">
          {batch.status === 'INCUBATING' ? (
            <>
              <button
                type="button"
                className="secondary"
                disabled={blocked}
                onClick={() => open('CANDLING')}
              >
                {t('incubation.candling')}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={blocked}
                onClick={() => open('TRANSFER')}
              >
                {t('incubation.transfer')}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="secondary"
              disabled={blocked || hatchHold !== null}
              onClick={() => open('HATCH')}
            >
              {t('incubation.hatch')}
            </button>
          )}
          {batch.allLost ? (
            <>
              <button
                type="button"
                className="secondary"
                disabled={blocked || !online}
                aria-describedby={!online ? ids.cancelOffline : undefined}
                onClick={() => open('CANCEL')}
              >
                {t('incubation.cancel_open')}
              </button>
              {!online ? (
                <p id={ids.cancelOffline} className="home-muted">
                  {t('incubation.cancel_online_only')}
                </p>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      {panel === 'CANCEL' ? (
        <div className="sale-block">
          <p className="home-muted">{t('incubation.cancel_hint')}</p>
          <div className="field">
            <label htmlFor={ids.cancelComment}>{t('incubation.cancel_comment_label')}</label>
            <textarea
              id={ids.cancelComment}
              className="text-input"
              rows={2}
              maxLength={MAX_CANCEL_COMMENT}
              aria-required="true"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
            />
          </div>
          <div className="result-actions">
            <button
              type="button"
              className="btn-block submit-sale"
              disabled={blocked || !online || !batch.allLost || comment.trim() === ''}
              onClick={() => step('production.incubation.cancel', { comment: comment.trim() })}
            >
              {t('incubation.save_cancel')}
            </button>
            <button type="button" className="secondary" onClick={() => setPanel(null)}>
              {t('price_rules.cancel')}
            </button>
          </div>
        </div>
      ) : null}

      {panel === 'CANDLING' ? (
        <div className="sale-block">
          <div className="line-fields">
            <NumberField
              id={ids.infertile}
              label={t('incubation.infertile_label')}
              value={counts.infertile}
              onChange={set('infertile')}
              errorId={candlingShown ? ids.candlingError : undefined}
            />
            <NumberField
              id={ids.earlyDead}
              label={t('incubation.early_dead_label')}
              value={counts.earlyDead}
              onChange={set('earlyDead')}
              errorId={candlingShown ? ids.candlingError : undefined}
            />
          </div>
          {candlingShown ? (
            <p id={ids.candlingError} className="error-message" role="alert">
              {candlingProblem}
            </p>
          ) : null}
          <div className="result-actions">
            <button
              type="button"
              className="btn-block submit-sale"
              disabled={
                blocked ||
                candlingProblem !== null ||
                !candling ||
                candling.infertile + candling.earlyDead === 0
              }
              onClick={() => candling && step('production.incubation.record_candling', candling)}
            >
              {t('incubation.save_candling')}
            </button>
            <button type="button" className="secondary" onClick={() => setPanel(null)}>
              {t('price_rules.cancel')}
            </button>
          </div>
        </div>
      ) : null}

      {panel === 'TRANSFER' ? (
        <div className="sale-block">
          {hatcherList.length === 0 ? (
            <p className="alert alert-error">{t('incubation.no_hatcher')}</p>
          ) : (
            <div className="field">
              <label htmlFor={ids.hatcher}>{t('incubation.hatcher_label')}</label>
              <select
                id={ids.hatcher}
                className="text-input"
                value={hatcherId}
                onChange={(event) => setHatcherId(event.target.value)}
              >
                <option value="">{t('lot_setup.choose')}</option>
                {hatcherList.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <p className="home-muted">
            {t('incubation.transfer_hint', { remaining: formatQuantity(remaining) })}
          </p>
          <div className="result-actions">
            <button
              type="button"
              className="btn-block submit-sale"
              disabled={blocked || !hatcherId}
              onClick={() =>
                step('production.incubation.transfer_to_hatcher', { hatcherLocationId: hatcherId })
              }
            >
              {t('incubation.save_transfer')}
            </button>
            <button type="button" className="secondary" onClick={() => setPanel(null)}>
              {t('price_rules.cancel')}
            </button>
          </div>
        </div>
      ) : null}

      {panel === 'HATCH' ? (
        <div className="sale-block">
          <div className="line-fields">
            <NumberField
              id={ids.viable}
              label={t('incubation.viable_label')}
              value={counts.hatchedViable}
              onChange={set('hatchedViable')}
              errorId={hatchShown ? ids.hatchError : undefined}
            />
            <NumberField
              id={ids.nonviable}
              label={t('incubation.nonviable_label')}
              value={counts.hatchedNonviable}
              onChange={set('hatchedNonviable')}
              errorId={hatchShown ? ids.hatchError : undefined}
            />
            <NumberField
              id={ids.unhatched}
              label={t('incubation.unhatched_label')}
              value={counts.unhatched}
              onChange={set('unhatched')}
              errorId={hatchShown ? ids.hatchError : undefined}
            />
          </div>
          <div className="field">
            <label htmlFor={ids.output}>{t('incubation.output_label')}</label>
            <select
              id={ids.output}
              className="text-input"
              value={outputId}
              onChange={(event) => setOutputId(event.target.value)}
            >
              <option value="">
                {t('incubation.output_default', {
                  name:
                    locationNames.get(batch.hatcherLocationId ?? batch.incubatorLocationId) ?? '',
                })}
              </option>
              {outputs.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </div>
          <p className="home-muted">
            {t('incubation.hatch_hint', { remaining: formatQuantity(remaining) })}
          </p>
          {hatchShown ? (
            <p id={ids.hatchError} className="error-message" role="alert">
              {hatchProblem}
            </p>
          ) : null}
          <div className="result-actions">
            <button
              type="button"
              className="btn-block submit-sale"
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
            </button>
            <button type="button" className="secondary" onClick={() => setPanel(null)}>
              {t('price_rules.cancel')}
            </button>
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
  const ids = {
    farm: useId(),
    species: useId(),
    egg: useId(),
    chick: useId(),
    incubator: useId(),
    source: useId(),
    lot: useId(),
    eggs: useId(),
    eggsError: useId(),
    speciesList: useId(),
  };
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

  if (farms.length === 0) return <p className="home-muted">{t('incubation.no_incubator')}</p>;

  return (
    <>
      <div className="field">
        <label htmlFor={ids.farm}>{t('lot_setup.farm_label')}</label>
        <select
          id={ids.farm}
          className="text-input"
          value={siteId}
          onChange={(event) => setSiteChoice(event.target.value)}
        >
          {farms.map((farm) => (
            <option key={farm.id} value={farm.id}>
              {farm.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={ids.species}>{t('incubation.species_label')}</label>
        {configuredSpecies.length > 0 ? (
          <select
            id={ids.species}
            className="text-input"
            value={effectiveSpecies}
            onChange={(event) => setSpecies(event.target.value)}
          >
            <option value="">{t('lot_setup.choose')}</option>
            {configuredSpecies.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        ) : (
          <>
            <input
              id={ids.species}
              className="text-input"
              maxLength={20}
              autoCapitalize="characters"
              placeholder="POULE"
              list={ids.speciesList}
              value={species}
              onChange={(event) => setSpecies(event.target.value)}
            />
            <datalist id={ids.speciesList}>
              {knownSpecies.map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
            <p className="text-warn">{t('incubation.species_not_configured')}</p>
          </>
        )}
      </div>
      {configuredEgg ? (
        <p className="home-muted">{t('incubation.egg_product', { name: configuredEgg.name })}</p>
      ) : (
        <div className="field">
          <label htmlFor={ids.egg}>{t('incubation.egg_label')}</label>
          <select
            id={ids.egg}
            className="text-input"
            value={eggProductChoice}
            onChange={(event) => setEggProductChoice(event.target.value)}
          >
            <option value="">{t('lot_setup.choose')}</option>
            {eggCandidates.map((product) => (
              <option key={product.id} value={product.id}>
                {product.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="field">
        <label htmlFor={ids.chick}>{t('incubation.chick_label')}</label>
        <select
          id={ids.chick}
          className="text-input"
          value={chickProductId}
          onChange={(event) => setChickProductId(event.target.value)}
        >
          <option value="">{t('lot_setup.choose')}</option>
          {chicks.map((product) => (
            <option key={product.id} value={product.id}>
              {product.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={ids.incubator}>{t('incubation.incubator_label')}</label>
        <select
          id={ids.incubator}
          className="text-input"
          value={incubatorId}
          onChange={(event) => setIncubatorChoice(event.target.value)}
        >
          {incubatorList.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
            </option>
          ))}
        </select>
      </div>
      {eggProductId && sources.length === 0 ? (
        <p className="alert alert-error">{t('incubation.no_eggs')}</p>
      ) : null}
      {sources.length > 0 ? (
        <div className="field">
          <label htmlFor={ids.source}>{t('incubation.source_label')}</label>
          <select
            id={ids.source}
            className="text-input"
            value={source ? source.locationId : ''}
            onChange={(event) => {
              setSourceId(event.target.value);
              setSourceLotId('');
            }}
          >
            <option value="">{t('lot_setup.choose')}</option>
            {sources.map((candidate) => (
              <option key={candidate.locationId} value={candidate.locationId}>
                {t('incubation.source', {
                  place: locationNames.get(candidate.locationId) ?? '',
                  quantity: formatQuantity(candidate.quantity),
                })}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {source && source.lots.length > 0 ? (
        <div className="field">
          <label htmlFor={ids.lot}>{t('incubation.egg_lot_label')}</label>
          <select
            id={ids.lot}
            className="text-input"
            value={lotId}
            onChange={(event) => setSourceLotId(event.target.value)}
          >
            <option value="">{source.fifo ? t('lot_setup.fifo') : t('lot_setup.choose')}</option>
            {source.lots.map((lot) => (
              <option key={lot.lotId} value={lot.lotId}>
                {`${lot.lotCode} (${formatQuantity(lot.quantity)})`}
              </option>
            ))}
          </select>
          {!source.fifo ? <p className="home-muted">{t('incubation.egg_lot_required')}</p> : null}
        </div>
      ) : null}
      <fieldset className="choice-group">
        <legend>{t('incubation.egg_source_label')}</legend>
        {(['INTERNAL', 'PURCHASED'] as const).map((value) => (
          <label key={value} className="choice">
            <input
              type="radio"
              name="egg-source"
              value={value}
              checked={eggSource === value}
              onChange={() => setEggSource(value)}
            />
            {t(`incubation.egg_source.${value}`)}
          </label>
        ))}
      </fieldset>
      <div className="field">
        <label htmlFor={ids.eggs}>{t('incubation.eggs_label')}</label>
        <input
          id={ids.eggs}
          className="text-input"
          inputMode="numeric"
          value={eggsText}
          aria-invalid={eggsText && (eggs === null || eggs === 0) ? true : undefined}
          aria-describedby={eggsText && (eggs === null || eggs === 0) ? ids.eggsError : undefined}
          onChange={(event) => setEggsText(event.target.value)}
        />
        {eggsText && (eggs === null || eggs === 0) ? (
          <p id={ids.eggsError} className="error-message" role="alert">
            {t('incubation.count_invalid')}
          </p>
        ) : null}
      </div>
      {over ? (
        online ? (
          <p className="error-message" role="alert">
            {t('incubation.over_online')}
          </p>
        ) : (
          <p className="text-warn">{t('incubation.over_offline')}</p>
        )
      ) : null}
      {lotRisk ? <p className="text-warn">{t('lot_setup.lot_fifo_risk')}</p> : null}
      <button type="button" className="btn-block submit-sale" disabled={!ready} onClick={submit}>
        {t('incubation.start')}
      </button>
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
        <h1>{t('nav.screens.incubation')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
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
      <h1>{t('nav.screens.incubation')}</h1>
      {!online ? (
        <p className="home-banner" role="status">
          {t('incubation.offline_banner')}
        </p>
      ) : null}
      {last ? <CommandResult commandId={last} messages="incubation.result" /> : null}
      {saveError ? (
        <p className="alert alert-error" role="alert">
          {t('sales.error_local_save')}
        </p>
      ) : null}
      <fieldset className="choice-group">
        <legend>{t('incubation.section_label')}</legend>
        {(['BATCHES', 'START'] as const).map((value) => (
          <label key={value} className="choice">
            <input
              type="radio"
              name="incubation-section"
              value={value}
              checked={section === value}
              onChange={() => setSection(value)}
            />
            {t(`incubation.section.${value}`)}
          </label>
        ))}
      </fieldset>
      {section === 'BATCHES' ? (
        <section className="sale-block" aria-label={t('incubation.section.BATCHES')}>
          {open.length === 0 ? (
            <p className="home-muted">{t('incubation.none')}</p>
          ) : (
            <ul className="line-list">
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
            <>
              <h2>{t('incubation.done_title')}</h2>
              <ul className="receipt-lines">
                {done.map((batch) => (
                  <li key={batch.id}>
                    <span>{batch.batchCode ?? t('incubation.pending_batch')}</span>
                    <span>
                      {t(`incubation.status.${batch.status}`, { defaultValue: batch.status })}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : (
        <section className="sale-block" aria-label={t('incubation.section.START')}>
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
