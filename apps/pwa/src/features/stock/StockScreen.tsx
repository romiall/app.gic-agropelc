/**
 * ECR-STK-01 « Stock par emplacement » : soldes de l'emplacement choisi, disponible pour cet appareil,
 * opérations de l'appareil en attente, lots en solde et alertes de seuil (BR-STK-051, sur le solde
 * physique). Les quotas ne sont pas affichés : `qty_allocated` n'est pas encore tenu par le serveur
 * et le reste du quota propre de l'appareil n'est pas servi (S-05). Utilisable hors ligne, dans le périmètre téléchargé (jeu `stock`).
 * L'action « Alertes de stock » du magasinier ouvre l'écran filtré sur les produits sous le seuil.
 */
import { useId, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { businessDayOf } from '@gic/domain';
import { formatBusinessDay } from '../home/format-home.js';
import { formatQuantity } from '../sales/format.js';
import { useSalesReferences } from '../sales/references.js';
import { needsAttention, stockLocations, stockRows } from './stock-view.js';

export function StockScreen() {
  const { t } = useTranslation();
  const refs = useSalesReferences();
  const [searchParams] = useSearchParams();
  const [locationChoice, setLocationChoice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [alertsOnly, setAlertsOnly] = useState(searchParams.get('alertes') === '1');
  const [openLots, setOpenLots] = useState<string | null>(null);
  const searchId = useId();

  if (!refs) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.stock')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const locations = stockLocations(refs);
  const location = locations.find((candidate) => candidate.id === locationChoice) ?? locations[0];
  if (!location) {
    return (
      <section className="sale">
        <h1>{t('nav.screens.stock')}</h1>
        <p className="home-muted">{t('stock.no_location')}</p>
      </section>
    );
  }

  const text = query.trim().toLowerCase();
  const all = stockRows(refs, location);
  const rows = all.filter(
    (row) =>
      (!alertsOnly || needsAttention(row)) &&
      (!text ||
        row.product.name.toLowerCase().includes(text) ||
        row.product.code.toLowerCase().includes(text)),
  );
  const alerts = all.filter(needsAttention).length;

  return (
    <section className="sale">
      <h1>{t('nav.screens.stock')}</h1>
      <div className="field">
        <label htmlFor="stock-location">{t('stock.location_label')}</label>
        <select
          id="stock-location"
          className="text-input"
          value={location.id}
          onChange={(event) => setLocationChoice(event.target.value)}
        >
          {locations.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
        <p className="home-muted">{t(`stock.custody.${location.custody_mode ?? 'SHARED'}`)}</p>
      </div>
      <div className="field">
        <label htmlFor={searchId} className="visually-hidden">
          {t('sales.product_search')}
        </label>
        <input
          id={searchId}
          type="search"
          className="text-input"
          placeholder={t('sales.product_search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <label className="choice">
        <input
          type="checkbox"
          checked={alertsOnly}
          onChange={(event) => setAlertsOnly(event.target.checked)}
        />
        {t('stock.alerts_only', { count: alerts })}
      </label>

      {rows.length === 0 ? (
        <p className="home-muted">{t(alertsOnly ? 'stock.no_alert' : 'stock.empty')}</p>
      ) : (
        <ul className="line-list">
          {rows.map((row) => {
            const unit = row.product.base_unit_code;
            const state = row.threshold?.state ?? 'OK';
            return (
              <li key={row.product.id} className="line-card" aria-label={row.product.name}>
                <div className="line-head">
                  <strong>{row.product.name}</strong>
                  {state !== 'OK' ? (
                    <span className={`badge badge-${state === 'STOCK_OUT' ? 'warn' : 'info'}`}>
                      {t(`stock.state.${state}`)}
                    </span>
                  ) : null}
                </div>
                <dl className="progress-grid stock-grid">
                  <dt>{t('stock.on_hand')}</dt>
                  <dd>
                    {formatQuantity(row.onHand)} {unit}
                  </dd>
                  <dt>{t('stock.available')}</dt>
                  <dd className={row.available <= 0 ? 'text-warn' : undefined}>
                    {formatQuantity(row.available)} {unit}
                  </dd>
                </dl>
                {row.pending > 0 ? (
                  <p className="home-muted">
                    {t('stock.pending', { quantity: formatQuantity(row.pending), unit })}
                  </p>
                ) : null}
                {row.threshold && state !== 'OK' ? (
                  <p className="home-muted">
                    {t('stock.threshold', {
                      min: formatQuantity(row.threshold.minQty),
                      suggested: formatQuantity(row.threshold.suggestedQty),
                      unit,
                    })}
                  </p>
                ) : null}
                {row.lots.length > 1 || row.lots.some((lot) => lot.lot_code) ? (
                  <>
                    <button
                      type="button"
                      className="link-button"
                      aria-expanded={openLots === row.product.id}
                      onClick={() =>
                        setOpenLots((current) =>
                          current === row.product.id ? null : row.product.id,
                        )
                      }
                    >
                      {t('stock.lots', { count: row.lots.length })}
                    </button>
                    {openLots === row.product.id ? (
                      <ul className="receipt-lines">
                        {row.lots.map((lot, index) => (
                          <li key={lot.lot_id ?? `sans-lot-${index}`}>
                            <span>
                              <strong>{lot.lot_code ?? t('stock.no_lot')}</strong>
                              {lot.expiry_date ? (
                                <small>
                                  {t('stock.expiry', {
                                    // Colonne DATE servie comme minuit local du serveur (S-14).
                                    date: formatBusinessDay(
                                      businessDayOf(new Date(lot.expiry_date)),
                                    ),
                                  })}
                                </small>
                              ) : null}
                            </span>
                            <span>
                              {formatQuantity(Number(lot.qty_on_hand))} {unit}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
