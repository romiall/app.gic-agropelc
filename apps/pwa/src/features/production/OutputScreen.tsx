/**
 * ECR-PRD-07 « SORTIE VERS COMMERCIALISATION » (responsable de ferme, responsable de production ;
 * D07, BR-PRD-010). Têtes d'un lot actif ou en vente expédiées d'un bâtiment vers un magasin, un PDV
 * ou un emplacement mobile : expédition directe `inventory.transfer.dispatch` (agrégat
 * `STOCK_TRANSFER`), utilisable hors ligne, à recevoir par le destinataire (ECR-STK-03). Le
 * responsable de production déclare en ligne le lot prêt à la vente depuis l'élevage, ou l'y ramène
 * (`production.lot.set_status`).
 */
import { useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { holdsAnyRole, ROUTES } from '../../app/screens.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatQuantity } from '../sales/format.js';
import { useSalesReferences } from '../sales/references.js';
import { submitCommand } from '../sales/submit.js';
import {
  isDailyLot,
  locationHeadcount,
  parseCount,
  rearingHeadcount,
  rearingLocations,
} from './daily.js';
import {
  commercialDestinations,
  MAX_CARRIER_NAME,
  MAX_OUTPUT_NOTES,
  outputPayload,
} from './output.js';

const LOT_MANAGERS: readonly string[] = ['RESP_PRODUCTION'];

export function OutputScreen() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const navigation = useRememberedNavigation(userId);
  const refs = useSalesReferences();
  const online = useOnline();
  const [lotChoice, setLotChoice] = useState<string | null>(searchParams.get('lot'));
  const [sourceChoice, setSourceChoice] = useState<string | null>(null);
  const [destinationId, setDestinationId] = useState('');
  const [quantityText, setQuantityText] = useState('');
  const [carrierName, setCarrierName] = useState('');
  const [notes, setNotes] = useState('');
  const [last, setLast] = useState<{ commandId: string; kind: 'DISPATCH' | 'STATUS' }>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const ids = {
    lot: useId(),
    source: useId(),
    destination: useId(),
    quantity: useId(),
    carrier: useId(),
    notes: useId(),
  };

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.production_output')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const lots = refs.productionLots
    .filter(isDailyLot)
    .sort((a, b) => a.lot_code.localeCompare(b.lot_code, 'fr'));
  const lot = lots.find((candidate) => candidate.id === lotChoice) ?? lots[0];
  const sources = lot ? rearingLocations(refs.locations, lot) : [];
  const source =
    sources.find((candidate) => candidate.id === sourceChoice) ??
    sources.find((candidate) => candidate.id === lot?.main_location_id) ??
    sources[0];
  const destinations = commercialDestinations(refs.locations);
  const destination = destinations.find((candidate) => candidate.id === destinationId);
  const product = lot
    ? refs.products.find((candidate) => candidate.id === lot.product_id)
    : undefined;
  const unit = product?.base_unit_code ?? '';
  const heads = lot && source ? locationHeadcount(refs, lot, source.id) : null;
  const lotHeads = lot ? rearingHeadcount(refs, lot) : null;
  const quantity = parseCount(quantityText);
  const over = quantity !== null && heads !== null && quantity > heads;
  const manager = holdsAnyRole(navigation ? navigation.roles : [], LOT_MANAGERS);
  const settling =
    last !== undefined && !refs.outbox.some((command) => command.command_id === last.commandId);
  const blocked = busy || settling;
  const ready =
    lot !== undefined &&
    product !== undefined &&
    source !== undefined &&
    destination !== undefined &&
    quantity !== null &&
    !(online && over) &&
    !blocked;

  const send = async (kind: 'DISPATCH' | 'STATUS', input: Parameters<typeof submitCommand>[0]) => {
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand(input);
      setLast({ commandId: command.command_id, kind });
      return true;
    } catch {
      setSaveError(true);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const dispatch = () => {
    if (!ready || !lot || !source || !destination || quantity === null) return;
    void send('DISPATCH', {
      authorUserId: userId,
      commandType: 'inventory.transfer.dispatch',
      aggregateType: 'STOCK_TRANSFER',
      payload: outputPayload({
        lot,
        unitCode: unit,
        fromLocationId: source.id,
        toLocationId: destination.id,
        quantity,
        carrierName,
        notes,
      }),
    }).then((ok) => {
      if (ok) {
        setQuantityText('');
        setCarrierName('');
        setNotes('');
      }
    });
  };

  const setStatus = (status: 'SELLING' | 'ACTIVE') => {
    if (!lot || blocked || !online) return;
    void send('STATUS', {
      authorUserId: userId,
      commandType: 'production.lot.set_status',
      aggregateType: 'PRODUCTION_LOT',
      aggregateId: lot.id,
      payload: { status },
    });
  };

  return (
    <section className="sale">
      {lot ? (
        <Link to={ROUTES.dailyEntry(lot.id)} className="back-link">
          {t('output.back', { code: lot.lot_code })}
        </Link>
      ) : null}
      <h1>{t('nav.screens.production_output')}</h1>
      {!online ? (
        <p className="home-banner" role="status">
          {t('output.offline_banner')}
        </p>
      ) : null}
      {last ? (
        <CommandResult
          commandId={last.commandId}
          messages={last.kind === 'DISPATCH' ? 'output.result' : 'output.status_result'}
        />
      ) : null}
      {!lot ? (
        <p className="home-muted">{t('output.no_lot')}</p>
      ) : (
        <>
          <div className="field">
            <label htmlFor={ids.lot}>{t('output.lot_label')}</label>
            <select
              id={ids.lot}
              className="text-input"
              value={lot.id}
              onChange={(event) => {
                setLotChoice(event.target.value);
                setSourceChoice(null);
              }}
            >
              {lots.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.lot_code}
                </option>
              ))}
            </select>
            <p className="home-muted">
              {t(`output.lot_status.${lot.status}`, { defaultValue: lot.status })} ·{' '}
              {lotHeads === null
                ? t('production.headcount_unknown')
                : t('production.headcount', { heads: formatQuantity(lotHeads) })}
            </p>
          </div>

          {manager ? (
            <section className="sale-block" aria-labelledby="output-status-title">
              <h2 id="output-status-title">{t('output.status_title')}</h2>
              <p className="home-muted">{t('output.status_hint')}</p>
              {!online ? (
                <p className="text-warn">{t('output.status_online_only')}</p>
              ) : lot.status === 'SELLING' ? (
                <button
                  type="button"
                  className="secondary"
                  disabled={blocked}
                  onClick={() => setStatus('ACTIVE')}
                >
                  {t('output.back_to_rearing')}
                </button>
              ) : (
                <button
                  type="button"
                  className="secondary"
                  disabled={blocked || lotHeads === 0}
                  onClick={() => setStatus('SELLING')}
                >
                  {t('output.ready_to_sell')}
                </button>
              )}
            </section>
          ) : null}

          <section className="sale-block" aria-labelledby="output-dispatch-title">
            <h2 id="output-dispatch-title">{t('output.dispatch_title')}</h2>
            {sources.length === 0 ? (
              <p className="alert alert-error">{t('production.no_rearing_location')}</p>
            ) : (
              <div className="field">
                <label htmlFor={ids.source}>{t('output.source_label')}</label>
                <select
                  id={ids.source}
                  className="text-input"
                  value={source?.id ?? ''}
                  onChange={(event) => setSourceChoice(event.target.value)}
                >
                  {sources.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
                {heads !== null ? (
                  <p className="home-muted">
                    {t('production.location_headcount', { heads: formatQuantity(heads) })}
                  </p>
                ) : null}
              </div>
            )}
            <div className="field">
              <label htmlFor={ids.destination}>{t('output.destination_label')}</label>
              {destinations.length === 0 ? (
                <p className="alert alert-error">{t('output.no_destination')}</p>
              ) : (
                <select
                  id={ids.destination}
                  className="text-input"
                  value={destinationId}
                  onChange={(event) => setDestinationId(event.target.value)}
                >
                  <option value="">{t('output.destination_placeholder')}</option>
                  {destinations.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="field">
              <label htmlFor={ids.quantity}>{t('output.quantity_label', { unit })}</label>
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
                  {t('output.over_online')}
                </p>
              ) : (
                <p className="text-warn">{t('output.over_offline')}</p>
              )
            ) : null}
            <div className="field">
              <label htmlFor={ids.carrier}>{t('output.carrier_label')}</label>
              <input
                id={ids.carrier}
                className="text-input"
                maxLength={MAX_CARRIER_NAME}
                value={carrierName}
                onChange={(event) => setCarrierName(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor={ids.notes}>{t('output.notes_label')}</label>
              <textarea
                id={ids.notes}
                className="text-input"
                rows={2}
                maxLength={MAX_OUTPUT_NOTES}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </div>
            <p className="home-muted">{t('output.receive_hint')}</p>
            {saveError ? (
              <p className="alert alert-error" role="alert">
                {t('sales.error_local_save')}
              </p>
            ) : null}
            <button
              type="button"
              className="btn-block submit-sale"
              disabled={!ready}
              onClick={dispatch}
            >
              {busy ? t('sales.submitting') : t('output.submit')}
            </button>
          </section>
        </>
      )}
    </section>
  );
}
