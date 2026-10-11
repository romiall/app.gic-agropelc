/**
 * ECR-STK-02 « TRANSFÉRER (expédier) » (magasinier, responsable de ferme ; expédition vers un
 * commercial comprise). Demandes reçues à expédier, et expédition directe d'un emplacement de
 * l'appareil vers un autre. Commande `inventory.transfer.dispatch` (agrégat `STOCK_TRANSFER`),
 * utilisable hors ligne ; le numéro `TRF-…` est lu dans le jeu `transfers` au tirage suivant. La
 * marchandise quitte aussitôt le disponible local et part en transit jusqu'à sa réception (ECR-STK-03).
 */
import { useId, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ROUTES } from '../../app/screens.js';
import { idGenerator } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatQuantity } from '../sales/format.js';
import { useSalesReferences, type SalesReferences } from '../sales/references.js';
import { saleUnitsOf } from '../sales/sale-form.js';
import { localAvailable, stockKey } from '../sales/stock.js';
import { submitCommand } from '../sales/submit.js';
import type { LocationData, StockTransferData } from '../sales/types.js';
import { stockLocations } from './stock-view.js';
import {
  checkTransferLine,
  destinations,
  directDispatchPayload,
  MAX_CARRIER_NAME,
  MAX_TRANSFER_NOTES,
  overAvailable,
  parseDispatched,
  requestDispatchPayload,
  requestsToDispatch,
  totalsByProduct,
  type TransferLineDraft,
} from './transfer.js';

function availableAt(refs: SalesReferences, location: LocationData, productId: string): number {
  return localAvailable(
    refs.stock.get(stockKey(location.id, productId)),
    location.custody_mode,
    refs.pending.get(stockKey(location.id, productId)) ?? 0,
  );
}

const newLine = (): TransferLineDraft => ({
  key: idGenerator.newId(),
  productId: '',
  unitCode: '',
  quantityText: '',
});

interface FormProps {
  readonly refs: SalesReferences;
  readonly userId: string;
  readonly online: boolean;
  readonly onDone: (commandId: string) => void;
}

/** Transporteur et note, communs aux deux formes d'expédition. */
function CarrierFields(props: {
  readonly carrier: string;
  readonly notes: string;
  readonly onCarrier: (value: string) => void;
  readonly onNotes: (value: string) => void;
}) {
  const { t } = useTranslation();
  const carrierId = useId();
  const notesId = useId();
  return (
    <>
      <div className="field">
        <label htmlFor={carrierId}>{t('transfer.carrier_label')}</label>
        <input
          id={carrierId}
          className="text-input"
          maxLength={MAX_CARRIER_NAME}
          value={props.carrier}
          onChange={(event) => props.onCarrier(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={notesId}>{t('transfer.notes_label')}</label>
        <textarea
          id={notesId}
          className="text-input"
          rows={2}
          maxLength={MAX_TRANSFER_NOTES}
          value={props.notes}
          onChange={(event) => props.onNotes(event.target.value)}
        />
      </div>
    </>
  );
}

function OverAvailable({ online, names }: { online: boolean; names: readonly string[] }) {
  const { t } = useTranslation();
  if (names.length === 0) return null;
  return online ? (
    <p className="error-message" role="alert">
      {t('transfer.over_online', { products: names.join(', ') })}
    </p>
  ) : (
    <p className="text-warn">{t('transfer.over_offline', { products: names.join(', ') })}</p>
  );
}

function DirectDispatchForm({ refs, userId, online, onDone }: FormProps) {
  const { t } = useTranslation();
  const sources = stockLocations(refs);
  const [sourceChoice, setSourceChoice] = useState<string | null>(null);
  const [destinationId, setDestinationId] = useState('');
  const [lines, setLines] = useState<readonly TransferLineDraft[]>(() => [newLine()]);
  const [carrier, setCarrier] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const sourceSelectId = useId();
  const destinationSelectId = useId();

  const source = sources.find((candidate) => candidate.id === sourceChoice) ?? sources[0];
  if (!source) return <p className="home-muted">{t('stock.no_location')}</p>;

  const targets = destinations(refs.locations, source.id);
  const products = refs.products
    .filter((product) => refs.stock.has(stockKey(source.id, product.id)))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const productNames = new Map(refs.products.map((product) => [product.id, product.name]));
  const checks = lines.map((line) => {
    const product = products.find((candidate) => candidate.id === line.productId);
    const units = product ? saleUnitsOf(product, refs) : [];
    const unitCode = line.unitCode || product?.base_unit_code || '';
    const effective = { ...line, unitCode };
    return {
      check: checkTransferLine(
        effective,
        units.find((unit) => unit.unitCode === unitCode),
      ),
      units,
      product,
    };
  });
  const totals = totalsByProduct(
    checks.map(({ check }) => ({
      productId: check.draft.productId,
      quantityBase: check.quantityBase,
    })),
  );
  const over = overAvailable(totals, (productId) => availableAt(refs, source, productId));
  const ready =
    destinationId !== '' &&
    checks.every(({ check }) => check.issue === null) &&
    !(online && over.length > 0) &&
    !busy;

  const updateLine = (key: string, patch: Partial<TransferLineDraft>) =>
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: 'inventory.transfer.dispatch',
        aggregateType: 'STOCK_TRANSFER',
        payload: directDispatchPayload({
          fromLocationId: source.id,
          toLocationId: destinationId,
          lines: checks.map(({ check }) => check),
          carrierName: carrier,
          notes,
        }),
      });
      onDone(command.command_id);
    } catch {
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sale-block" aria-labelledby="transfer-direct-title">
      <h2 id="transfer-direct-title">{t('transfer.direct_title')}</h2>
      <div className="field">
        <label htmlFor={sourceSelectId}>{t('transfer.source_label')}</label>
        <select
          id={sourceSelectId}
          className="text-input"
          value={source.id}
          onChange={(event) => {
            setSourceChoice(event.target.value);
            setDestinationId('');
            setLines([newLine()]);
          }}
        >
          {sources.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={destinationSelectId}>{t('transfer.destination_label')}</label>
        <select
          id={destinationSelectId}
          className="text-input"
          value={destinationId}
          onChange={(event) => setDestinationId(event.target.value)}
        >
          <option value="">{t('transfer.destination_placeholder')}</option>
          {targets.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </div>

      <ul className="line-list">
        {checks.map(({ check, units, product }, index) => {
          const line = check.draft;
          const label = t('transfer.line_label', { index: index + 1 });
          return (
            <li key={line.key} className="line-card" aria-label={label}>
              <div className="field">
                <label htmlFor={`${line.key}-product`}>{t('loss.product_label')}</label>
                <select
                  id={`${line.key}-product`}
                  className="text-input"
                  value={line.productId}
                  onChange={(event) =>
                    updateLine(line.key, { productId: event.target.value, unitCode: '' })
                  }
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
                      quantity: formatQuantity(availableAt(refs, source, product.id)),
                      unit: product.base_unit_code,
                    })}
                  </p>
                ) : null}
              </div>
              <div className="line-fields">
                <div className="field">
                  <label htmlFor={`${line.key}-quantity`}>{t('sales.quantity_label')}</label>
                  <input
                    id={`${line.key}-quantity`}
                    className="text-input"
                    inputMode="decimal"
                    value={line.quantityText}
                    onChange={(event) => updateLine(line.key, { quantityText: event.target.value })}
                  />
                </div>
                {units.length > 1 ? (
                  <div className="field">
                    <label htmlFor={`${line.key}-unit`}>{t('sales.unit_label')}</label>
                    <select
                      id={`${line.key}-unit`}
                      className="text-input"
                      value={line.unitCode}
                      onChange={(event) => updateLine(line.key, { unitCode: event.target.value })}
                    >
                      {units.map((unit) => (
                        <option key={unit.unitCode} value={unit.unitCode}>
                          {unit.unitCode}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
              </div>
              {line.quantityText && check.issue === 'QUANTITY_INVALID' ? (
                <p className="error-message">{t('loss.issue.QUANTITY_INVALID')}</p>
              ) : null}
              {lines.length > 1 ? (
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    setLines((current) => current.filter((candidate) => candidate.key !== line.key))
                  }
                >
                  {t('transfer.remove_line', { index: index + 1 })}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="secondary"
        onClick={() => setLines((current) => [...current, newLine()])}
      >
        {t('transfer.add_line')}
      </button>
      <CarrierFields carrier={carrier} notes={notes} onCarrier={setCarrier} onNotes={setNotes} />
      <OverAvailable
        online={online}
        names={over.map((productId) => productNames.get(productId) ?? productId)}
      />
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
        {busy ? t('sales.submitting') : t('transfer.submit')}
      </button>
    </section>
  );
}

function RequestDispatchForm({
  refs,
  userId,
  online,
  onDone,
  transfer,
}: FormProps & { readonly transfer: StockTransferData }) {
  const { t } = useTranslation();
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [carrier, setCarrier] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const source = refs.locations.find((location) => location.id === transfer.from_location_id);
  const destination = refs.locations.find((location) => location.id === transfer.to_location_id);
  const productNames = new Map(refs.products.map((product) => [product.id, product]));

  const quantities = new Map<string, number>();
  let invalid = false;
  for (const line of transfer.lines) {
    const text = texts[line.id] ?? formatQuantity(Number(line.requested_qty_base ?? 0));
    const value = parseDispatched(text.replace(/\s/g, ''));
    if (value === null) invalid = true;
    else quantities.set(line.id, value);
  }
  const totals = totalsByProduct(
    transfer.lines.map((line) => ({
      productId: line.product_id,
      quantityBase: quantities.get(line.id) ?? null,
    })),
  );
  const over = source
    ? overAvailable(totals, (productId) => availableAt(refs, source, productId))
    : [];
  const nothing = [...quantities.values()].every((value) => value === 0);
  const ready = !invalid && !nothing && !(online && over.length > 0) && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: 'inventory.transfer.dispatch',
        aggregateType: 'STOCK_TRANSFER',
        aggregateId: transfer.id,
        payload: requestDispatchPayload(transfer, quantities, carrier, notes),
      });
      onDone(command.command_id);
    } catch {
      setSaveError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sale-block" aria-labelledby="transfer-request-title">
      <h2 id="transfer-request-title">
        {t('transfer.request_title', { doc: transfer.doc_number })}
      </h2>
      <p className="home-muted">
        {t('transfer.route', { from: source?.name ?? '', to: destination?.name ?? '' })}
      </p>
      <ul className="line-list">
        {transfer.lines.map((line) => {
          const product = productNames.get(line.product_id);
          const unit = product?.base_unit_code ?? line.unit_code;
          const text = texts[line.id] ?? formatQuantity(Number(line.requested_qty_base ?? 0));
          return (
            <li key={line.id} className="line-card" aria-label={product?.name ?? line.product_id}>
              <div className="line-head">
                <strong>{product?.name ?? line.product_id}</strong>
                <span>
                  {t('transfer.requested', {
                    quantity: formatQuantity(Number(line.requested_qty_base ?? 0)),
                    unit,
                  })}
                </span>
              </div>
              <div className="field">
                <label htmlFor={`dispatch-${line.id}`}>
                  {t('transfer.dispatched_label', { unit })}
                </label>
                <input
                  id={`dispatch-${line.id}`}
                  className="text-input"
                  inputMode="decimal"
                  value={text}
                  onChange={(event) =>
                    setTexts((current) => ({ ...current, [line.id]: event.target.value }))
                  }
                />
              </div>
            </li>
          );
        })}
      </ul>
      {invalid ? <p className="error-message">{t('loss.issue.QUANTITY_INVALID')}</p> : null}
      {nothing && !invalid ? <p className="text-warn">{t('transfer.nothing')}</p> : null}
      <CarrierFields carrier={carrier} notes={notes} onCarrier={setCarrier} onNotes={setNotes} />
      <OverAvailable
        online={online}
        names={over.map((productId) => productNames.get(productId)?.name ?? productId)}
      />
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
        {busy ? t('sales.submitting') : t('transfer.submit_request')}
      </button>
    </section>
  );
}

export function TransferScreen() {
  const { t } = useTranslation();
  const { transferId } = useParams();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
  const online = useOnline();
  // Résultat attaché à la route où l'expédition a été saisie.
  const [submitted, setSubmitted] = useState<{ commandId: string; route: string | undefined }>();

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.transfer')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  if (submitted && submitted.route === transferId) {
    return (
      <section className="sale">
        <h1>{t('nav.screens.transfer')}</h1>
        <CommandResult commandId={submitted.commandId} messages="transfer.result">
          <Link
            to={ROUTES.transfer}
            className="action action-compact"
            onClick={() => setSubmitted(undefined)}
          >
            <span className="action-label">{t('transfer.another')}</span>
          </Link>
        </CommandResult>
      </section>
    );
  }

  const onDone = (commandId: string) => setSubmitted({ commandId, route: transferId });
  const requests = requestsToDispatch(refs);
  const locations = new Map(refs.locations.map((location) => [location.id, location]));

  if (transferId) {
    const entry = requests.find((candidate) => candidate.transfer.id === transferId);
    return (
      <section className="sale">
        <Link to={ROUTES.transfer} className="back-link">
          {t('transfer.back')}
        </Link>
        <h1>{t('nav.screens.transfer')}</h1>
        {!online ? (
          <p className="home-banner" role="status">
            {t('transfer.offline_banner')}
          </p>
        ) : null}
        {!entry ? (
          <p className="alert alert-error">{t('transfer.not_found')}</p>
        ) : entry.dispatching ? (
          <p className="home-muted">{t('transfer.dispatching')}</p>
        ) : (
          <RequestDispatchForm
            refs={refs}
            userId={userId}
            online={online}
            onDone={onDone}
            transfer={entry.transfer}
          />
        )}
      </section>
    );
  }

  return (
    <section className="sale">
      <h1>{t('nav.screens.transfer')}</h1>
      {!online ? (
        <p className="home-banner" role="status">
          {t('transfer.offline_banner')}
        </p>
      ) : null}
      <section className="sale-block" aria-labelledby="transfer-requests-title">
        <h2 id="transfer-requests-title">{t('transfer.requests_title')}</h2>
        {requests.length === 0 ? (
          <p className="home-muted">{t('transfer.no_request')}</p>
        ) : (
          <ul className="doc-list">
            {requests.map(({ transfer, dispatching }) => (
              <li key={transfer.id}>
                <Link
                  to={ROUTES.transferOne(transfer.id)}
                  className="doc-row"
                  aria-label={t('transfer.open_request', { doc: transfer.doc_number })}
                >
                  <span className="doc-main">
                    <strong>{transfer.doc_number}</strong>
                    <small>
                      {t('transfer.route', {
                        from: locations.get(transfer.from_location_id)?.name ?? '',
                        to: locations.get(transfer.to_location_id)?.name ?? '',
                      })}
                    </small>
                  </span>
                  <span className="doc-side">
                    {dispatching ? (
                      <span className="badge badge-warn">{t('transfer.dispatching_badge')}</span>
                    ) : (
                      <span className="badge badge-info">
                        {t('transfer.lines_count', { count: transfer.lines.length })}
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <DirectDispatchForm refs={refs} userId={userId} online={online} onDone={onDone} />
    </section>
  );
}
