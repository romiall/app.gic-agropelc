/**
 * ECR-PRD-04 « Nouveau lot / mise en place / entrée » (responsable de production ; D07). Deux
 * rubriques, utilisables hors ligne : création d'un lot (`production.lot.create`) et entrée d'animaux
 * dans un lot planifié, actif ou en vente (`production.lot.record_entry`), y compris un lot créé sur
 * ce téléphone et pas encore envoyé (l'entrée attend sa création). La première entrée démarre le lot.
 */
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { LotEntrySourceKind, ProductionLotType } from '@gic/domain';
import { ROUTES } from '../../app/screens.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatQuantity, formatQuantityUnit } from '../sales/format.js';
import { useSalesReferences, type SalesReferences } from '../sales/references.js';
import { submitCommand } from '../sales/submit.js';
import { rearingLocations } from './daily.js';
import {
  allowedKinds,
  birthParentActive,
  checkEntry,
  checkLotDraft,
  EMPTY_ENTRY,
  entryDependsOn,
  entryLots,
  entryPayload,
  farms,
  lotCreatePayload,
  lotProducts,
  MAX_LOT_NOTES,
  MAX_STRAIN,
  parentCandidates,
  placementReceipts,
  PRODUCTION_LOT_TYPES,
  receiptAvailable,
  receiptProducts,
  sourceLocations,
  sourceLots,
  stockSources,
  type EntryDraft,
  type EntryLot,
  type LotDraft,
} from './lot-setup.js';

type Section = 'CREATE' | 'ENTRY';

interface SectionProps {
  readonly refs: SalesReferences;
  readonly userId: string;
  readonly online: boolean;
  readonly blocked: boolean;
  readonly send: (
    kind: Section,
    input: Parameters<typeof submitCommand>[0],
  ) => Promise<string | null>;
}

const EMPTY_LOT: LotDraft = {
  siteId: '',
  lotType: 'POULET_CHAIR',
  productId: '',
  mainLocationId: '',
  parentLotId: '',
  supplierId: '',
  strain: '',
  plannedStartDate: '',
  plannedEndDate: '',
  notes: '',
};

function Select({
  id,
  label,
  value,
  onChange,
  options,
  placeholder,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly placeholder?: string;
}) {
  return (
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
}

function CreateLot({
  refs,
  userId,
  blocked,
  send,
  onCreated,
}: SectionProps & { readonly onCreated: (lotId: string) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<LotDraft>(EMPTY_LOT);
  const ids = {
    farm: useId(),
    type: useId(),
    product: useId(),
    location: useId(),
    parent: useId(),
    supplier: useId(),
    strain: useId(),
    start: useId(),
    end: useId(),
    notes: useId(),
  };
  const farmList = farms(refs.sites.values());
  const siteId = draft.siteId || farmList[0]?.id || '';
  const products = lotProducts(refs.products, draft.lotType);
  const locations = siteId ? rearingLocations(refs.locations, { site_id: siteId }) : [];
  const parents = siteId ? parentCandidates(refs.productionLots, siteId, draft.lotType) : [];
  const effective: LotDraft = {
    ...draft,
    siteId,
    productId: products.some((product) => product.id === draft.productId) ? draft.productId : '',
    mainLocationId: locations.some((location) => location.id === draft.mainLocationId)
      ? draft.mainLocationId
      : (locations[0]?.id ?? ''),
    parentLotId: parents.some((lot) => lot.id === draft.parentLotId) ? draft.parentLotId : '',
  };
  const issues = checkLotDraft(effective);
  const update = (patch: Partial<LotDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const submit = () => {
    if (issues.length > 0 || blocked) return;
    void send('CREATE', {
      authorUserId: userId,
      commandType: 'production.lot.create',
      aggregateType: 'PRODUCTION_LOT',
      payload: lotCreatePayload(effective),
    }).then((lotId) => {
      if (lotId) {
        setDraft(EMPTY_LOT);
        onCreated(lotId);
      }
    });
  };

  if (farmList.length === 0) {
    return <p className="home-muted">{t('lot_setup.no_farm')}</p>;
  }

  return (
    <>
      <Select
        id={ids.farm}
        label={t('lot_setup.farm_label')}
        value={siteId}
        onChange={(value) => update({ siteId: value, mainLocationId: '', parentLotId: '' })}
        options={farmList.map((site) => ({ value: site.id, label: site.name }))}
      />
      <Select
        id={ids.type}
        label={t('lot_setup.type_label')}
        value={draft.lotType}
        onChange={(value) => update({ lotType: value as ProductionLotType, productId: '' })}
        options={PRODUCTION_LOT_TYPES.map((type) => ({
          value: type,
          label: t(`production.lot_type.${type}`),
        }))}
      />
      {products.length === 0 ? (
        <p className="alert alert-error">{t('lot_setup.no_product')}</p>
      ) : (
        <Select
          id={ids.product}
          label={t('lot_setup.product_label')}
          value={effective.productId}
          onChange={(value) => update({ productId: value })}
          options={products.map((product) => ({ value: product.id, label: product.name }))}
          placeholder={t('lot_setup.choose')}
        />
      )}
      {locations.length === 0 ? (
        <p className="alert alert-error">{t('production.no_rearing_location')}</p>
      ) : (
        <Select
          id={ids.location}
          label={t('lot_setup.location_label')}
          value={effective.mainLocationId}
          onChange={(value) => update({ mainLocationId: value })}
          options={locations.map((location) => ({ value: location.id, label: location.name }))}
        />
      )}
      {parents.length > 0 ? (
        <Select
          id={ids.parent}
          label={t('lot_setup.parent_label')}
          value={effective.parentLotId}
          onChange={(value) => update({ parentLotId: value })}
          options={parents.map((lot) => ({ value: lot.id, label: lot.lot_code }))}
          placeholder={t('lot_setup.no_parent')}
        />
      ) : null}
      <Select
        id={ids.supplier}
        label={t('lot_setup.supplier_label')}
        value={draft.supplierId}
        onChange={(value) => update({ supplierId: value })}
        options={[...refs.suppliers.values()]
          .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
          .map((supplier) => ({ value: supplier.id, label: supplier.name }))}
        placeholder={t('lot_setup.no_supplier')}
      />
      <div className="field">
        <label htmlFor={ids.strain}>{t('lot_setup.strain_label')}</label>
        <input
          id={ids.strain}
          className="text-input"
          maxLength={MAX_STRAIN}
          value={draft.strain}
          onChange={(event) => update({ strain: event.target.value })}
        />
      </div>
      <div className="line-fields">
        <div className="field">
          <label htmlFor={ids.start}>{t('lot_setup.start_label')}</label>
          <input
            id={ids.start}
            type="date"
            className="text-input"
            value={draft.plannedStartDate}
            onChange={(event) => update({ plannedStartDate: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor={ids.end}>{t('lot_setup.end_label')}</label>
          <input
            id={ids.end}
            type="date"
            className="text-input"
            value={draft.plannedEndDate}
            onChange={(event) => update({ plannedEndDate: event.target.value })}
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor={ids.notes}>{t('lot_setup.notes_label')}</label>
        <textarea
          id={ids.notes}
          className="text-input"
          rows={2}
          maxLength={MAX_LOT_NOTES}
          value={draft.notes}
          onChange={(event) => update({ notes: event.target.value })}
        />
      </div>
      {issues
        .filter((issue) => issue === 'DATES_INVALID')
        .map((issue) => (
          <p key={issue} className="error-message">
            {t(`lot_setup.issue.${issue}`)}
          </p>
        ))}
      <button
        type="button"
        className="btn-block submit-sale"
        disabled={issues.length > 0 || blocked}
        onClick={submit}
      >
        {t('lot_setup.create')}
      </button>
    </>
  );
}

function RecordEntry({
  refs,
  userId,
  online,
  blocked,
  send,
  lotChoice,
  setLotChoice,
}: SectionProps & {
  readonly lotChoice: string | null;
  readonly setLotChoice: (lotId: string) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<EntryDraft>(EMPTY_ENTRY);
  const ids = {
    lot: useId(),
    to: useId(),
    stock: useId(),
    stockLot: useId(),
    receipt: useId(),
    receiptProduct: useId(),
    sourceLot: useId(),
    sourceLocation: useId(),
    quantity: useId(),
    stillborn: useId(),
    weight: useId(),
  };
  const lots = entryLots(refs, userId);
  const lot: EntryLot | undefined = lots.find((candidate) => candidate.id === lotChoice) ?? lots[0];
  if (!lot) return <p className="home-muted">{t('lot_setup.no_entry_lot')}</p>;

  const kinds = allowedKinds(lot, refs.productionLots, online);
  const kind: LotEntrySourceKind = kinds.includes(draft.kind)
    ? draft.kind
    : (kinds[0] ?? 'INTERNAL_STOCK');
  const products = new Map(refs.products.map((product) => [product.id, product]));
  const locationNames = new Map(refs.locations.map((location) => [location.id, location.name]));
  const rearing = rearingLocations(refs.locations, { site_id: lot.siteId });
  const stock = kind === 'INTERNAL_STOCK' ? stockSources(refs, lot) : [];
  const receipts = kind === 'PURCHASE' ? placementReceipts(refs, lot) : [];
  const receipt = receipts.find((candidate) => candidate.id === draft.goodsReceiptId);
  const receiptChoices = receipt ? receiptProducts(refs, receipt, lot) : [];
  const fromLots =
    kind === 'TRANSFER' || kind === 'WEANING' ? sourceLots(refs.productionLots, lot, kind) : [];
  const fromLot = fromLots.find((candidate) => candidate.id === draft.sourceProductionLotId);
  const fromLocations = fromLot ? sourceLocations(refs, fromLot) : [];
  const chosenStock = stock.find((s) => `${s.locationId}|${s.productId}` === draft.stockSource);
  // Chaque choix est revalidé contre les listes du moment : la charge utile envoie ce qui s'affiche.
  const effective: EntryDraft = {
    ...draft,
    kind,
    toLocationId: rearing.some((location) => location.id === draft.toLocationId)
      ? draft.toLocationId
      : '',
    stockSource: chosenStock ? draft.stockSource : '',
    sourceStockLotId: chosenStock?.lots.some(
      (stockLot) => stockLot.lotId === draft.sourceStockLotId,
    )
      ? draft.sourceStockLotId
      : '',
    goodsReceiptId: receipt ? receipt.id : '',
    receiptProductId: receiptChoices.includes(draft.receiptProductId) ? draft.receiptProductId : '',
    sourceProductionLotId: fromLot ? fromLot.id : '',
    sourceLocationId: fromLocations.some((entry) => entry.location.id === draft.sourceLocationId)
      ? draft.sourceLocationId
      : '',
  };
  const check = checkEntry(effective, chosenStock?.fifo === false);
  // Têtes disponibles à l'origine : le serveur refuse en ligne au-delà (stock, réception, lot).
  const available =
    kind === 'INTERNAL_STOCK'
      ? (chosenStock?.lots.find((stockLot) => stockLot.lotId === effective.sourceStockLotId)
          ?.quantity ??
        chosenStock?.quantity ??
        null)
      : (kind === 'TRANSFER' || kind === 'WEANING') && fromLot && effective.sourceLocationId
        ? (fromLocations.find((entry) => entry.location.id === effective.sourceLocationId)?.heads ??
          null)
        : kind === 'PURCHASE' && receipt && effective.receiptProductId
          ? receiptAvailable(refs, receipt, effective.receiptProductId)
          : null;
  const parentInactive = kind === 'BIRTH' && !birthParentActive(lot, refs.productionLots);
  const over = check.quantity !== null && available !== null && check.quantity > available;
  // Lot désigné : des sorties sans lot en attente peuvent le toucher (le plus ancien d'abord).
  const designatedLot =
    kind === 'INTERNAL_STOCK'
      ? chosenStock?.lots.find((stockLot) => stockLot.lotId === effective.sourceStockLotId)
      : undefined;
  const lotRisk =
    !over &&
    check.quantity !== null &&
    designatedLot !== undefined &&
    check.quantity > designatedLot.cautious;
  const update = (patch: Partial<EntryDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const ready = check.issues.length === 0 && !(online && over) && !blocked;

  const submit = () => {
    if (!ready) return;
    void send('ENTRY', {
      authorUserId: userId,
      commandType: 'production.lot.record_entry',
      aggregateType: 'LOT_ENTRY',
      dependsOn: entryDependsOn(lot),
      payload: entryPayload(lot, effective, check),
    }).then((commandId) => {
      if (commandId) {
        setDraft((current) => ({
          ...current,
          quantityText: '',
          stillbornText: '',
          avgWeightText: '',
        }));
      }
    });
  };

  const lotLabel = (candidate: EntryLot) =>
    candidate.lotCode
      ? `${candidate.lotCode} · ${t(`production.lot_type.${candidate.lotType}`)}`
      : t('lot_setup.pending_lot', { type: t(`production.lot_type.${candidate.lotType}`) });

  return (
    <>
      <Select
        id={ids.lot}
        label={t('lot_setup.entry_lot_label')}
        value={lot.id}
        onChange={(value) => {
          setLotChoice(value);
          // Destination et origines d'un autre lot ne valent plus pour celui-ci.
          setDraft((current) => ({
            ...current,
            toLocationId: '',
            sourceProductionLotId: '',
            sourceLocationId: '',
          }));
        }}
        options={lots.map((candidate) => ({ value: candidate.id, label: lotLabel(candidate) }))}
      />
      {lot.createCommandId ? <p className="home-muted">{t('lot_setup.pending_lot_hint')}</p> : null}
      <fieldset className="choice-group">
        <legend>{t('lot_setup.kind_label')}</legend>
        {kinds.map((value) => (
          <label key={value} className="choice">
            <input
              type="radio"
              name="entry-kind"
              value={value}
              checked={kind === value}
              onChange={() => update({ kind: value })}
            />
            {t(`lot_setup.kind.${value}`)}
          </label>
        ))}
      </fieldset>

      {kind === 'INTERNAL_STOCK' ? (
        stock.length === 0 ? (
          <p className="alert alert-error">{t('lot_setup.no_stock_source')}</p>
        ) : (
          <>
            <Select
              id={ids.stock}
              label={t('lot_setup.stock_source_label')}
              value={effective.stockSource}
              onChange={(value) => update({ stockSource: value, sourceStockLotId: '' })}
              options={stock.map((source) => ({
                value: `${source.locationId}|${source.productId}`,
                label: t('lot_setup.stock_source', {
                  product: products.get(source.productId)?.name ?? '',
                  place: locationNames.get(source.locationId) ?? '',
                  quantity: formatQuantity(source.quantity),
                }),
              }))}
              placeholder={t('lot_setup.choose')}
            />
            {chosenStock && chosenStock.lots.length > 0 ? (
              <Select
                id={ids.stockLot}
                label={t('lot_setup.stock_lot_label')}
                value={effective.sourceStockLotId}
                onChange={(value) => update({ sourceStockLotId: value })}
                options={chosenStock.lots.map((stockLot) => ({
                  value: stockLot.lotId,
                  label: `${stockLot.lotCode} (${formatQuantity(stockLot.quantity)})`,
                }))}
                placeholder={chosenStock.fifo ? t('lot_setup.fifo') : t('lot_setup.choose')}
              />
            ) : null}
            {chosenStock && !chosenStock.fifo ? (
              <p className="home-muted">{t('lot_setup.stock_lot_required')}</p>
            ) : null}
          </>
        )
      ) : null}

      {kind === 'PURCHASE' ? (
        receipts.length === 0 ? (
          <p className="alert alert-error">{t('lot_setup.no_receipt')}</p>
        ) : (
          <>
            <Select
              id={ids.receipt}
              label={t('lot_setup.receipt_label')}
              value={effective.goodsReceiptId}
              onChange={(value) => update({ goodsReceiptId: value, receiptProductId: '' })}
              options={receipts.map((candidate) => ({
                value: candidate.id,
                label: candidate.doc_number,
              }))}
              placeholder={t('lot_setup.choose')}
            />
            {receipt ? (
              <Select
                id={ids.receiptProduct}
                label={t('lot_setup.receipt_product_label')}
                value={effective.receiptProductId}
                onChange={(value) => update({ receiptProductId: value })}
                options={receiptChoices.map((id) => ({
                  value: id,
                  label: products.get(id)?.name ?? id,
                }))}
                placeholder={t('lot_setup.choose')}
              />
            ) : null}
          </>
        )
      ) : null}

      {kind === 'TRANSFER' || kind === 'WEANING' ? (
        <>
          <Select
            id={ids.sourceLot}
            label={t('lot_setup.source_lot_label')}
            value={effective.sourceProductionLotId}
            onChange={(value) => update({ sourceProductionLotId: value, sourceLocationId: '' })}
            options={fromLots.map((candidate) => ({
              value: candidate.id,
              label: `${candidate.lot_code} · ${t(`production.lot_type.${candidate.lot_type}`)}`,
            }))}
            placeholder={t('lot_setup.choose')}
          />
          {fromLot && fromLocations.length === 0 ? (
            <p className="alert alert-error">{t('lot_setup.no_source_heads')}</p>
          ) : null}
          {fromLot && fromLocations.length > 0 ? (
            <Select
              id={ids.sourceLocation}
              label={t('lot_setup.source_location_label')}
              value={effective.sourceLocationId}
              onChange={(value) => update({ sourceLocationId: value })}
              options={fromLocations.map((entry) => ({
                value: entry.location.id,
                label:
                  entry.heads === null
                    ? entry.location.name
                    : t('lot_setup.source_location', {
                        name: entry.location.name,
                        heads: formatQuantityUnit(entry.heads, 'TETE'),
                      }),
              }))}
              placeholder={t('lot_setup.choose')}
            />
          ) : null}
        </>
      ) : null}

      {rearing.length > 0 ? (
        <Select
          id={ids.to}
          label={t('lot_setup.to_label')}
          value={effective.toLocationId}
          onChange={(value) => update({ toLocationId: value })}
          options={rearing.map((location) => ({ value: location.id, label: location.name }))}
          placeholder={t('lot_setup.main_location', {
            name: locationNames.get(lot.mainLocationId) ?? '',
          })}
        />
      ) : null}
      <div className="line-fields">
        <div className="field">
          <label htmlFor={ids.quantity}>{t('lot_setup.quantity_label')}</label>
          <input
            id={ids.quantity}
            className="text-input"
            inputMode="numeric"
            value={draft.quantityText}
            onChange={(event) => update({ quantityText: event.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor={ids.weight}>{t('lot_setup.weight_label')}</label>
          <input
            id={ids.weight}
            className="text-input"
            inputMode="decimal"
            value={draft.avgWeightText}
            onChange={(event) => update({ avgWeightText: event.target.value })}
          />
        </div>
      </div>
      {parentInactive ? (
        <p className="text-warn">{t('lot_setup.parent_inactive_offline')}</p>
      ) : null}
      {kind === 'BIRTH' ? (
        <div className="field">
          <label htmlFor={ids.stillborn}>{t('lot_setup.stillborn_label')}</label>
          <input
            id={ids.stillborn}
            className="text-input"
            inputMode="numeric"
            value={draft.stillbornText}
            onChange={(event) => update({ stillbornText: event.target.value })}
          />
        </div>
      ) : null}
      {available !== null ? (
        <p className="home-muted">
          {t('lot_setup.available', { quantity: formatQuantity(available) })}
        </p>
      ) : null}
      {check.issues
        .filter(
          (issue) =>
            issue !== 'SOURCE_REQUIRED' && (issue !== 'QUANTITY_INVALID' || draft.quantityText),
        )
        .map((issue) => (
          <p key={issue} className="error-message">
            {t(`lot_setup.issue.${issue}`)}
          </p>
        ))}
      {over ? (
        online ? (
          <p className="error-message" role="alert">
            {t('lot_setup.over_online')}
          </p>
        ) : (
          <p className="text-warn">{t('lot_setup.over_offline')}</p>
        )
      ) : null}
      {lotRisk ? <p className="text-warn">{t('lot_setup.lot_fifo_risk')}</p> : null}
      <button type="button" className="btn-block submit-sale" disabled={!ready} onClick={submit}>
        {t('lot_setup.record_entry')}
      </button>
    </>
  );
}

export function LotSetupScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
  const online = useOnline();
  const [section, setSection] = useState<Section>('CREATE');
  const [lotChoice, setLotChoice] = useState<string | null>(null);
  const [last, setLast] = useState<{ commandId: string; section: Section }>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.lot_setup')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const settling =
    last !== undefined && !refs.outbox.some((command) => command.command_id === last.commandId);
  const blocked = busy || settling;

  /** Enregistre la commande ; renvoie l'identifiant de l'agrégat (le lot créé, l'entrée). */
  const send = async (kind: Section, input: Parameters<typeof submitCommand>[0]) => {
    if (blocked) return null;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand(input);
      setLast({ commandId: command.command_id, section: kind });
      return command.aggregate_id;
    } catch {
      setSaveError(true);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const props: SectionProps = { refs, userId, online, blocked, send };

  return (
    <section className="sale">
      <Link to={ROUTES.productionLots} className="back-link">
        {t('production.back')}
      </Link>
      <h1>{t('nav.screens.lot_setup')}</h1>
      {!online ? (
        <p className="home-banner" role="status">
          {t('lot_setup.offline_banner')}
        </p>
      ) : null}
      {last ? (
        <CommandResult
          commandId={last.commandId}
          messages={
            last.section === 'CREATE' ? 'lot_setup.create_result' : 'lot_setup.entry_result'
          }
        />
      ) : null}
      <fieldset className="choice-group">
        <legend>{t('lot_setup.section_label')}</legend>
        {(['CREATE', 'ENTRY'] as const).map((value) => (
          <label key={value} className="choice">
            <input
              type="radio"
              name="lot-setup-section"
              value={value}
              checked={section === value}
              onChange={() => setSection(value)}
            />
            {t(`lot_setup.section.${value}`)}
          </label>
        ))}
      </fieldset>
      {saveError ? (
        <p className="alert alert-error" role="alert">
          {t('sales.error_local_save')}
        </p>
      ) : null}
      <section className="sale-block" aria-label={t(`lot_setup.section.${section}`)}>
        {section === 'CREATE' ? (
          <CreateLot
            {...props}
            onCreated={(lotId) => {
              setLotChoice(lotId);
              setSection('ENTRY');
            }}
          />
        ) : (
          <RecordEntry {...props} lotChoice={lotChoice} setLotChoice={setLotChoice} />
        )}
      </section>
    </section>
  );
}
