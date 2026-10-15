/**
 * ECR-STK-08 « Consommation d'intrants hors lot » (magasinier, responsable de ferme ; emballages au
 * PDV). Emplacement, intrant, quantité dans l'unité choisie, nature du coût, lot facultatif. Commande
 * `inventory.consumption.record` (agrégat `STOCK_CONSUMPTION`), utilisable hors ligne ; l'intrant quitte
 * aussitôt le disponible local. Au-delà du physique : bloquée en ligne, signalée hors ligne
 * (BR-STK-018). Les consommations hors lot ne sont pas servies à l'appareil : leur historique se lit en
 * ligne.
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clock, idGenerator } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatQuantity, unitLabel } from '../sales/format.js';
import { useSalesReferences } from '../sales/references.js';
import { saleUnitsOf } from '../sales/sale-form.js';
import { localAvailable, physicalLeft, stockKey } from '../sales/stock.js';
import { submitCommand } from '../sales/submit.js';
import {
  CONSUMPTION_COST_TYPES,
  consumptionPayload,
  type ConsumptionCostType,
} from './consumption.js';
import { offlineExitGuard } from '../sales/quota.js';
import { guardBlocks, guardDescribedBy } from './exit-guard.js';
import { ExitGuardMessages } from './ExitGuardMessages.js';
import { stockLocations } from './stock-view.js';
import { checkTransferLine, type TransferLineDraft } from './transfer.js';

const emptyLine = (): TransferLineDraft => ({
  key: idGenerator.newId(),
  productId: '',
  unitCode: '',
  quantityText: '',
});

export function ConsumptionScreen() {
  const { t } = useTranslation();
  const { state, deviceId } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
  const online = useOnline();
  const [locationChoice, setLocationChoice] = useState<string | null>(null);
  const [line, setLine] = useState<TransferLineDraft>(emptyLine);
  const [lotId, setLotId] = useState('');
  const [costType, setCostType] = useState<ConsumptionCostType | ''>('');
  const [submitted, setSubmitted] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const locationId = useId();
  const productId = useId();
  const quantityId = useId();
  const unitId = useId();
  const lotSelectId = useId();
  const costId = useId();

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.consumption')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  if (submitted) {
    return (
      <section className="sale">
        <h1>{t('nav.screens.consumption')}</h1>
        <CommandResult commandId={submitted} messages="consumption.result">
          <button
            type="button"
            onClick={() => {
              setLine(emptyLine());
              setLotId('');
              setCostType('');
              setSubmitted(undefined);
            }}
          >
            {t('consumption.another')}
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
        <h1>{t('nav.screens.consumption')}</h1>
        <p className="home-muted">{t('stock.no_location')}</p>
      </section>
    );
  }

  // Intrants et emballages consommables seulement (un intrant désactivé garde son solde consommable).
  const products = refs.products
    .filter(
      (product) =>
        (product.is_consumable === true ||
          product.stock_family === 'INTRANT' ||
          product.stock_family === 'EMBALLAGE_CONSOMMABLE') &&
        product.stock_family !== 'BIOLOGIQUE' &&
        product.stock_family !== 'SERVICE' &&
        refs.stock.has(stockKey(location.id, product.id)),
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const product = products.find((candidate) => candidate.id === line.productId);
  const units = product ? saleUnitsOf(product, refs) : [];
  const unitCode = line.unitCode || product?.base_unit_code || '';
  const check = checkTransferLine(
    { ...line, unitCode },
    units.find((unit) => unit.unitCode === unitCode),
  );
  const balance = product ? refs.stock.get(stockKey(location.id, product.id)) : undefined;
  const pending = product ? (refs.pending.get(stockKey(location.id, product.id)) ?? 0) : 0;
  const available = product ? localAvailable(balance, location.custody_mode, pending) : 0;
  const lots = (balance?.lots ?? []).filter((lot) => lot.lot_id && Number(lot.qty_on_hand) > 0);
  const chosenLot = lots.find((lot) => lot.lot_id === lotId);
  const over =
    check.quantityBase !== null &&
    (check.quantityBase > physicalLeft(balance, pending) ||
      (chosenLot !== undefined && check.quantityBase > Number(chosenLot.qty_on_hand)));
  const noSite = !location.site_id;
  // Garde hors ligne (BR-STK-013, AV-231) : au-delà du quota du détenteur ou du solde exclusif, refusée.
  const guard = offlineExitGuard(refs, {
    kind: 'CONSUMPTION',
    location,
    requested: new Map(
      !online && product && check.quantityBase !== null ? [[product.id, check.quantityBase]] : [],
    ),
    userId,
    deviceId,
    now: clock.now(),
  });
  const ready =
    check.issue === null &&
    costType !== '' &&
    !noSite &&
    guard.blocks.length === 0 &&
    !(online && over) &&
    !busy;

  const submit = async () => {
    if (!ready || check.quantity === null || check.quantityBase === null || !location.site_id) {
      return;
    }
    setBusy(true);
    setSaveError(false);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: 'inventory.consumption.record',
        aggregateType: 'STOCK_CONSUMPTION',
        payload: consumptionPayload({
          locationId: location.id,
          siteId: location.site_id,
          line: { ...check, quantity: check.quantity, quantityBase: check.quantityBase },
          lotId,
          costType: costType as ConsumptionCostType,
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
      <h1>{t('nav.screens.consumption')}</h1>
      {!online ? (
        <p className="home-banner" role="status">
          {t('consumption.offline_banner')}
        </p>
      ) : null}
      <div className="field">
        <label htmlFor={locationId}>{t('stock.location_label')}</label>
        <select
          id={locationId}
          className="text-input"
          value={location.id}
          onChange={(event) => {
            setLocationChoice(event.target.value);
            setLine(emptyLine());
            setLotId('');
          }}
        >
          {locations.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </div>
      {noSite ? (
        <p className="alert alert-error" role="alert">
          {t('consumption.no_site')}
        </p>
      ) : null}
      <div className="field">
        <label htmlFor={productId}>{t('consumption.product_label')}</label>
        <select
          id={productId}
          className="text-input"
          value={line.productId}
          onChange={(event) => {
            setLine((current) => ({ ...current, productId: event.target.value, unitCode: '' }));
            setLotId('');
          }}
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
              unit: unitLabel(product.base_unit_code, available, refs.units),
            })}
          </p>
        ) : null}
      </div>
      <div className="line-fields">
        <div className="field">
          <label htmlFor={quantityId}>{t('sales.quantity_label')}</label>
          <input
            id={quantityId}
            className="text-input"
            inputMode="decimal"
            aria-invalid={product && guardBlocks(guard, product.id) ? true : undefined}
            aria-describedby={
              product ? guardDescribedBy(guard, 'consumption', product.id) : undefined
            }
            value={line.quantityText}
            onChange={(event) =>
              setLine((current) => ({ ...current, quantityText: event.target.value }))
            }
          />
        </div>
        {units.length > 1 ? (
          <div className="field">
            <label htmlFor={unitId}>{t('sales.unit_label')}</label>
            <select
              id={unitId}
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
      {lots.length > 0 ? (
        <div className="field">
          <label htmlFor={lotSelectId}>{t('loss.lot_label')}</label>
          <select
            id={lotSelectId}
            className="text-input"
            value={lotId}
            onChange={(event) => setLotId(event.target.value)}
          >
            <option value="">{t('loss.lot_fifo')}</option>
            {lots.map((lot) => (
              <option key={lot.lot_id} value={lot.lot_id ?? ''}>
                {lot.lot_code ?? lot.lot_id} · {formatQuantity(Number(lot.qty_on_hand))}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="field">
        <label htmlFor={costId}>{t('consumption.cost_label')}</label>
        <select
          id={costId}
          className="text-input"
          value={costType}
          onChange={(event) => setCostType(event.target.value as ConsumptionCostType | '')}
        >
          <option value="">{t('consumption.cost_placeholder')}</option>
          {CONSUMPTION_COST_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(`consumption.cost.${type}`)}
            </option>
          ))}
        </select>
      </div>
      <ExitGuardMessages
        guard={guard}
        idPrefix="consumption"
        productName={(productId) =>
          refs.products.find((candidate) => candidate.id === productId)?.name ?? ''
        }
        unitOf={(productId) =>
          refs.products.find((candidate) => candidate.id === productId)?.base_unit_code ?? ''
        }
      />
      {/* Hors ligne, une consommation refusée par la garde n'est pas annoncée « enregistrée ». */}
      {over && (online || guard.blocks.length === 0) ? (
        online ? (
          <p className="error-message" role="alert">
            {t('consumption.over_online')}
          </p>
        ) : (
          <p className="text-warn">{t('consumption.over_offline')}</p>
        )
      ) : null}
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
        {busy ? t('sales.submitting') : t('consumption.submit')}
      </button>
    </section>
  );
}
