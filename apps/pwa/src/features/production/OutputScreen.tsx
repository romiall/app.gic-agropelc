/**
 * ECR-PRD-07 « SORTIE VERS COMMERCIALISATION » (responsable de ferme, responsable de production ;
 * D07, BR-PRD-010). Têtes d'un lot actif ou en vente expédiées d'un bâtiment vers un magasin, un PDV
 * ou un emplacement mobile : expédition directe `inventory.transfer.dispatch` (agrégat
 * `STOCK_TRANSFER`), utilisable hors ligne, à recevoir par le destinataire (ECR-STK-03). Le
 * responsable de production déclare en ligne le lot prêt à la vente depuis l'élevage, ou l'y ramène
 * (`production.lot.set_status`).
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { holdsAnyRole, ROUTES } from '../../app/screens.js';
import {
  ActionBar,
  Banner,
  Button,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Section,
  Select,
  SkeletonRows,
  Textarea,
} from '../../components/ui/index.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatQuantityUnit, unitLabel } from '../sales/format.js';
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
import './production.css';

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

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <PageHeader title={t('nav.screens.production_output')} />
        <SkeletonRows />
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

  const quantityError =
    quantityText && quantity === null
      ? t('production.count_invalid')
      : over && online
        ? t('output.over_online')
        : undefined;

  return (
    <section className="sale">
      <PageHeader
        {...(lot
          ? {
              backTo: ROUTES.dailyEntry(lot.id),
              backLabel: t('output.back', { code: lot.lot_code }),
            }
          : {})}
        title={t('nav.screens.production_output')}
      />
      <div className="prd-narrow">
        {!online ? (
          <Banner tone="warn" role="status">
            {t('output.offline_banner')}
          </Banner>
        ) : null}
        {last ? (
          <CommandResult
            commandId={last.commandId}
            messages={last.kind === 'DISPATCH' ? 'output.result' : 'output.status_result'}
          />
        ) : null}
        {!lot ? (
          <EmptyState icon="truck" title={t('output.no_lot')} />
        ) : (
          <>
            <Field
              label={t('output.lot_label')}
              hint={`${t(`output.lot_status.${lot.status}`, { defaultValue: lot.status })} · ${
                lotHeads === null
                  ? t('production.headcount_unknown')
                  : t('production.headcount', { heads: formatQuantityUnit(lotHeads, 'TETE') })
              }`}
            >
              {(control) => (
                <Select
                  {...control}
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
                </Select>
              )}
            </Field>

            {manager ? (
              <Section title={t('output.status_title')} className="prd-after">
                <p className="prd-note">{t('output.status_hint')}</p>
                {!online ? (
                  <p className="prd-note is-warn">{t('output.status_online_only')}</p>
                ) : lot.status === 'SELLING' ? (
                  <Button
                    variant="tonal"
                    disabled={blocked}
                    onClick={() => setStatus('ACTIVE')}
                    className="prd-self-start"
                  >
                    {t('output.back_to_rearing')}
                  </Button>
                ) : (
                  <Button
                    variant="tonal"
                    disabled={blocked || lotHeads === 0}
                    onClick={() => setStatus('SELLING')}
                    className="prd-self-start"
                  >
                    {t('output.ready_to_sell')}
                  </Button>
                )}
              </Section>
            ) : null}

            <Section title={t('output.dispatch_title')} className="prd-after">
              <div className="prd-form">
                {sources.length === 0 ? (
                  <Banner tone="bad">{t('production.no_rearing_location')}</Banner>
                ) : (
                  <Field
                    label={t('output.source_label')}
                    hint={
                      heads !== null
                        ? t('production.location_headcount', {
                            heads: formatQuantityUnit(heads, 'TETE'),
                          })
                        : undefined
                    }
                  >
                    {(control) => (
                      <Select
                        {...control}
                        value={source?.id ?? ''}
                        onChange={(event) => setSourceChoice(event.target.value)}
                      >
                        {sources.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                )}
                {destinations.length === 0 ? (
                  <Banner tone="bad">{t('output.no_destination')}</Banner>
                ) : (
                  <Field label={t('output.destination_label')}>
                    {(control) => (
                      <Select
                        {...control}
                        value={destinationId}
                        onChange={(event) => setDestinationId(event.target.value)}
                      >
                        <option value="">{t('output.destination_placeholder')}</option>
                        {destinations.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                )}
                <Field
                  label={t('output.quantity_label', { unit: unitLabel(unit) })}
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
                  <p className="prd-note is-warn">{t('output.over_offline')}</p>
                ) : null}
                <Field label={t('output.carrier_label')}>
                  {(control) => (
                    <Input
                      {...control}
                      maxLength={MAX_CARRIER_NAME}
                      value={carrierName}
                      onChange={(event) => setCarrierName(event.target.value)}
                    />
                  )}
                </Field>
                <Field label={t('output.notes_label')}>
                  {(control) => (
                    <Textarea
                      {...control}
                      rows={2}
                      maxLength={MAX_OUTPUT_NOTES}
                      value={notes}
                      onChange={(event) => setNotes(event.target.value)}
                    />
                  )}
                </Field>
                <p className="prd-note">{t('output.receive_hint')}</p>
                {saveError ? <Banner tone="bad">{t('sales.error_local_save')}</Banner> : null}
              </div>
              <ActionBar>
                <Button
                  size="lg"
                  className="submit-sale"
                  disabled={!ready}
                  loading={busy}
                  onClick={dispatch}
                >
                  {busy ? t('sales.submitting') : t('output.submit')}
                </Button>
              </ActionBar>
            </Section>
          </>
        )}
      </div>
    </section>
  );
}
