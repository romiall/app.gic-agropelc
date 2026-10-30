/**
 * ECR-STK-01 « Stock par emplacement » : soldes de l'emplacement choisi, disponible pour cet appareil,
 * opérations de l'appareil en attente, lots en solde et alertes de seuil (BR-STK-051, sur le solde
 * physique). Les quotas ne sont pas affichés : `qty_allocated` n'est pas encore tenu par le serveur
 * et le reste du quota propre de l'appareil n'est pas servi (S-05). Utilisable hors ligne, dans le périmètre téléchargé (jeu `stock`).
 * L'action « Alertes de stock » du magasinier ouvre l'écran filtré sur les produits sous le seuil.
 * Les opérations du stock (transférer, recevoir, déclarer une perte, inventaire, consommation, registre,
 * quotas) sont à portée de main en tête d'écran, selon le rôle (tout reste proposé si les rôles de
 * l'appareil sont inconnus).
 */
import { useId, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { businessDayOf } from '@gic/domain';
import {
  Badge,
  DataCell,
  DataList,
  DataRow,
  EmptyState,
  LinkButton,
  PageHeader,
  type IconName,
} from '../../components/ui/index.js';
import { holdsAnyRole, ROUTES, SCREENS } from '../../app/screens.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatBusinessDay } from '../home/format-home.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { formatQuantity, formatQuantityUnit, unitLabel } from '../sales/format.js';
import { useSalesReferences } from '../sales/references.js';
import { needsAttention, stockLocations, stockRows } from './stock-view.js';

/** Icône de chaque opération du domaine « stock » (clé du libellé dans `nav.screens`). */
const ACTION_ICONS: Readonly<Record<string, IconName>> = {
  transfer: 'truck',
  receive: 'box',
  loss: 'alert',
  count: 'clipboard',
  stock_ledger: 'file',
  consumption: 'leaf',
  allocations: 'sliders',
  replenish: 'store',
};

const COLUMNS = 'minmax(0, 2.2fr) minmax(7rem, 1fr) minmax(7rem, 1fr) minmax(8rem, 1fr)';

export function StockScreen() {
  const { t } = useTranslation();
  const refs = useSalesReferences();
  const online = useOnline();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const navigation = useRememberedNavigation(userId);
  const [searchParams] = useSearchParams();
  const [locationChoice, setLocationChoice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [alertsOnly, setAlertsOnly] = useState(searchParams.get('alertes') === '1');
  const [openLots, setOpenLots] = useState<string | null>(null);
  const searchId = useId();

  if (!refs) {
    return (
      <section className="sale" aria-busy="true">
        <PageHeader title={t('nav.screens.stock')} />
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const locations = stockLocations(refs);
  const location = locations.find((candidate) => candidate.id === locationChoice) ?? locations[0];
  if (!location) {
    return (
      <section className="sale">
        <PageHeader title={t('nav.screens.stock')} />
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
  // Les écrans du domaine « stock » proposés au rôle ; hors ligne, ceux qui s'utilisent sans réseau.
  // Pendant la lecture des rôles mémorisés, rien n'est proposé (pas de rangée qui change aussitôt).
  const held = navigation?.roles ?? [];
  const actions =
    navigation === undefined
      ? []
      : SCREENS.filter(
          (screen) =>
            screen.group === 'stock' &&
            screen.path !== ROUTES.stock &&
            (online || screen.offline) &&
            (screen.roles === 'ALL' || holdsAnyRole(held, screen.roles)),
        );

  return (
    <section className="sale">
      <PageHeader
        title={t('nav.screens.stock')}
        subtitle={t(`stock.custody.${location.custody_mode ?? 'SHARED'}`)}
      />
      {actions.length > 0 ? (
        <nav className="chip-row" aria-label={t('stock.actions_title')}>
          {actions.map((screen) => (
            <LinkButton
              key={screen.id}
              to={screen.path}
              variant="tonal"
              icon={ACTION_ICONS[screen.labelKey]}
            >
              {t(`nav.screens.${screen.labelKey}`)}
            </LinkButton>
          ))}
        </nav>
      ) : null}
      <div className="filter-bar">
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
        <EmptyState icon="box" title={t(alertsOnly ? 'stock.no_alert' : 'stock.empty')} />
      ) : (
        <DataList
          aria-label={t('stock.list_label')}
          template={COLUMNS}
          columns={[
            { label: t('stock.col_product') },
            { label: t('stock.on_hand'), numeric: true },
            { label: t('stock.available'), numeric: true },
            { label: t('stock.col_state') },
          ]}
        >
          {rows.map((row) => {
            const unit = row.product.base_unit_code;
            const state = row.threshold?.state ?? 'OK';
            return (
              <DataRow key={row.product.id} aria-label={row.product.name}>
                <DataCell primary>{row.product.name}</DataCell>
                <DataCell label={t('stock.on_hand')} numeric>
                  {formatQuantityUnit(row.onHand, unit, refs.units)}
                </DataCell>
                <DataCell
                  label={t('stock.available')}
                  numeric
                  className={row.available <= 0 ? 'text-warn' : ''}
                >
                  {formatQuantityUnit(row.available, unit, refs.units)}
                </DataCell>
                {state !== 'OK' ? (
                  <DataCell>
                    <Badge tone={state === 'STOCK_OUT' ? 'bad' : 'warn'}>
                      {t(`stock.state.${state}`)}
                    </Badge>
                  </DataCell>
                ) : null}
                {row.pending > 0 || (row.threshold && state !== 'OK') ? (
                  <DataCell wide>
                    {row.pending > 0 ? (
                      <p className="home-muted">
                        {t('stock.pending', {
                          quantity: formatQuantity(row.pending),
                          unit: unitLabel(unit, row.pending, refs.units),
                        })}
                      </p>
                    ) : null}
                    {row.threshold && state !== 'OK' ? (
                      <p className="home-muted">
                        {t('stock.threshold', {
                          min: formatQuantityUnit(row.threshold.minQty, unit, refs.units),
                          suggested: formatQuantityUnit(
                            row.threshold.suggestedQty,
                            unit,
                            refs.units,
                          ),
                        })}
                      </p>
                    ) : null}
                  </DataCell>
                ) : null}
                {row.lots.length > 1 || row.lots.some((lot) => lot.lot_code) ? (
                  <DataCell wide>
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
                              {formatQuantityUnit(Number(lot.qty_on_hand), unit, refs.units)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </DataCell>
                ) : null}
              </DataRow>
            );
          })}
        </DataList>
      )}
    </section>
  );
}
