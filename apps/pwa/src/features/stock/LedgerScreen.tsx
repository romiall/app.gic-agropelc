/**
 * ECR-STK-07 « Registre des mouvements et explication d'écart » (responsables, direction ; WF-J3
 * étape 5, WF-J6 étape 2). En ligne seulement : mouvements d'un emplacement sur une période, filtrés
 * par produit, page par page ; pour un produit, solde au début et à la fin, entrées et sorties par
 * type, et l'écart que les mouvements listés n'expliquent pas. Les soldes sont lus une fois la liste
 * complète ; un écart restant (opérations enregistrées pendant la lecture) se relit par
 * « Actualiser » (une image cohérente exacte est un besoin serveur, S-33). Aucune écriture.
 */
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { businessDayOf } from '@gic/domain';
import { clock } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { formatClockTime } from '../home/format-home.js';
import { formatMoney, formatQuantity, formatQuantityUnit, unitLabel } from '../sales/format.js';
import { useSalesReferences } from '../sales/references.js';
import {
  balanceAtPath,
  checkPeriod,
  closingInstant,
  defaultPeriod,
  explainGap,
  movesPath,
  openingInstant,
  quantityOf,
  type BalanceAtLine,
  type MoveView,
  type MovesPage,
} from './ledger.js';
import { stockLocations } from './stock-view.js';

interface Loaded {
  readonly key: string;
  readonly moves: readonly MoveView[];
  readonly next: string | null;
  readonly failed: boolean;
  /** Refus de droit ou emplacement hors de la portée du registre (403, 404). */
  readonly denied: boolean;
}

const REMEMBERED_LOCATION = 'gic.ledger.location';

function rememberedLocation(): string | null {
  try {
    return localStorage.getItem(REMEMBERED_LOCATION);
  } catch {
    return null;
  }
}

function rememberLocation(locationId: string): void {
  try {
    localStorage.setItem(REMEMBERED_LOCATION, locationId);
  } catch {
    // Mémorisation facultative (navigation privée).
  }
}

/** Contrepartie d'un mouvement sans emplacement sur l'appareil (emplacements virtuels, S-32). */
const VIRTUAL_COUNTERPARTS: Readonly<Record<string, string>> = {
  SALE: 'customer',
  CUSTOMER_RETURN: 'customer',
  DELIVERY: 'customer',
  TRANSFER_DISPATCH: 'transit',
  TRANSFER_RECEIPT: 'transit',
  TRANSFER_DISCREPANCY: 'transit',
  LOSS: 'loss',
  LOSS_PENDING: 'loss',
  LOSS_CONFIRMATION: 'loss',
  LOSS_RELEASE: 'loss',
  PURCHASE_RECEIPT: 'supplier',
  SUPPLIER_RETURN: 'supplier',
  OPENING_BALANCE: 'opening',
  INVENTORY_GAIN: 'adjustment',
  INVENTORY_LOSS: 'adjustment',
  CONSUMPTION: 'consumption',
  CONSUMPTION_REVERSAL: 'consumption',
  PRODUCTION_INPUT: 'production',
  PRODUCTION_OUTPUT: 'production',
};

/** Date et heure avec l'année (un registre couvre jusqu'à un an), à l'heure de Douala. */
function formatMoveMoment(iso: string): string {
  const day = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Africa/Douala',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso));
  return `${day} ${formatClockTime(iso)}`;
}

interface Balances {
  readonly key: string;
  readonly opening: number | null;
  readonly closing: number | null;
}

export function LedgerScreen() {
  const { t } = useTranslation();
  const refs = useSalesReferences();
  const online = useOnline();
  const today = businessDayOf(clock.now());
  const [locationChoice, setLocationChoice] = useState<string | null>(null);
  const [productId, setProductId] = useState('');
  const [period, setPeriod] = useState(() => defaultPeriod(today));
  const [loaded, setLoaded] = useState<Loaded>();
  const [balances, setBalances] = useState<Balances>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [refresh, setRefresh] = useState(0);
  // Nouvel essai des seuls soldes (la liste, complète, n'est pas relue).
  const [balancesAttempt, setBalancesAttempt] = useState(0);
  const [remembered] = useState(rememberedLocation);
  const ids = { location: useId(), product: useId(), from: useId(), to: useId() };

  const physical = (refs?.locations ?? [])
    .filter((location) => !location.is_virtual)
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const held = refs ? stockLocations(refs) : [];
  const locationId =
    locationChoice ??
    (remembered && physical.some((location) => location.id === remembered) ? remembered : null) ??
    held[0]?.id ??
    physical[0]?.id ??
    '';
  const issue = checkPeriod(period.from, period.to, today);
  const key = `${locationId}|${productId}|${period.from}|${period.to}|${refresh}`;
  const ready = online && locationId !== '' && issue === null;
  // Les soldes se lisent une fois toutes les pages reçues : moins d'écart dû à des opérations
  // enregistrées entre les deux lectures.
  const completeCount =
    loaded?.key === key && !loaded.failed && loaded.next === null ? loaded.moves.length : -1;
  const balancesKey = `${key}#${completeCount}#${balancesAttempt}`;

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void authorizedRequest<MovesPage>(
      getDb(),
      movesPath({ locationId, productId, from: period.from, to: period.to }),
      { method: 'GET' },
    ).then((result) => {
      if (cancelled) return;
      setLoaded(
        result.ok
          ? {
              key,
              moves: result.data.moves,
              next: result.data.next_cursor,
              failed: false,
              denied: false,
            }
          : {
              key,
              moves: [],
              next: null,
              failed: true,
              denied:
                result.reason === 'HTTP_ERROR' && (result.status === 403 || result.status === 404),
            },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [ready, key, locationId, productId, period.from, period.to]);

  useEffect(() => {
    if (!ready || !productId || completeCount < 0) return;
    let cancelled = false;
    const read = (at: string) =>
      authorizedRequest<{ balances: BalanceAtLine[] }>(
        getDb(),
        balanceAtPath(locationId, productId, at),
        { method: 'GET' },
      ).then((result) => (result.ok ? quantityOf(result.data.balances, productId) : null));
    void Promise.all([read(openingInstant(period.from)), read(closingInstant(period.to))]).then(
      ([opening, closing]) => {
        if (!cancelled) setBalances({ key: balancesKey, opening, closing });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ready, balancesKey, completeCount, locationId, productId, period.from, period.to]);

  if (!refs) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.stock_ledger')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const current = loaded?.key === key ? loaded : undefined;
  const currentBalances = balances?.key === balancesKey ? balances : undefined;
  const products = new Map(refs.products.map((product) => [product.id, product]));
  const locationNames = new Map(refs.locations.map((location) => [location.id, location.name]));
  const productOptions = [...refs.products].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  const unitOf = (id: string) => products.get(id)?.base_unit_code ?? '';
  const counterpartOf = (move: MoveView): string | null => {
    const name = locationNames.get(move.counterpartLocationId);
    if (name) return name;
    if (move.moveType === 'INTERNAL_MOVE') return t('ledger.unknown_place');
    const kind = VIRTUAL_COUNTERPARTS[move.moveType];
    return kind ? t(`ledger.counterpart.${kind}`) : null;
  };
  const complete = current !== undefined && !current.failed && current.next === null;
  const explanation =
    productId &&
    complete &&
    currentBalances?.opening !== null &&
    currentBalances?.opening !== undefined &&
    currentBalances.closing !== null
      ? explainGap(currentBalances.opening, currentBalances.closing, current.moves, productId)
      : null;

  const loadMore = async () => {
    if (!current?.next || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await authorizedRequest<MovesPage>(
        getDb(),
        movesPath({
          locationId,
          productId,
          from: period.from,
          to: period.to,
          cursor: current.next,
        }),
        { method: 'GET' },
      );
      setLoaded((previous) =>
        previous?.key !== key
          ? previous
          : result.ok
            ? {
                key,
                moves: [...previous.moves, ...result.data.moves],
                next: result.data.next_cursor,
                failed: false,
                denied: false,
              }
            : { ...previous, failed: true, denied: false },
      );
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <section className="sale">
      <h1>{t('nav.screens.stock_ledger')}</h1>
      {!online ? (
        <p className="alert alert-error" role="alert">
          {t('ledger.online_only')}
        </p>
      ) : null}
      <div className="field">
        <label htmlFor={ids.location}>{t('ledger.location_label')}</label>
        <select
          id={ids.location}
          className="text-input"
          value={locationId}
          onChange={(event) => {
            setLocationChoice(event.target.value);
            rememberLocation(event.target.value);
          }}
        >
          {physical.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={ids.product}>{t('ledger.product_label')}</label>
        <select
          id={ids.product}
          className="text-input"
          value={productId}
          onChange={(event) => setProductId(event.target.value)}
        >
          <option value="">{t('ledger.all_products')}</option>
          {productOptions.map((product) => (
            <option key={product.id} value={product.id}>
              {product.name}
            </option>
          ))}
        </select>
      </div>
      <div className="line-fields">
        <div className="field">
          <label htmlFor={ids.from}>{t('ledger.from_label')}</label>
          <input
            id={ids.from}
            type="date"
            className="text-input"
            max={today}
            value={period.from}
            onChange={(event) => setPeriod((current) => ({ ...current, from: event.target.value }))}
          />
        </div>
        <div className="field">
          <label htmlFor={ids.to}>{t('ledger.to_label')}</label>
          <input
            id={ids.to}
            type="date"
            className="text-input"
            max={today}
            value={period.to}
            onChange={(event) => setPeriod((current) => ({ ...current, to: event.target.value }))}
          />
        </div>
      </div>
      {issue ? <p className="error-message">{t(`ledger.issue.${issue}`)}</p> : null}

      {productId && ready ? (
        <section className="sale-block" aria-labelledby="ledger-explain-title">
          <h2 id="ledger-explain-title">{t('ledger.explain_title')}</h2>
          {explanation ? (
            <>
              <dl className="receipt-totals">
                <dt>{t('ledger.opening')}</dt>
                <dd>{formatQuantityUnit(explanation.opening, unitOf(productId), refs.units)}</dd>
                <dt>{t('ledger.entries')}</dt>
                <dd>{`+ ${formatQuantityUnit(explanation.entries, unitOf(productId), refs.units)}`}</dd>
                <dt>{t('ledger.exits')}</dt>
                <dd>{`− ${formatQuantityUnit(explanation.exits, unitOf(productId), refs.units)}`}</dd>
                <dt>{t('ledger.closing')}</dt>
                <dd>{formatQuantityUnit(explanation.closing, unitOf(productId), refs.units)}</dd>
              </dl>
              {explanation.byType.length > 0 ? (
                <ul className="receipt-lines">
                  {explanation.byType.map((total) => (
                    <li key={total.moveType}>
                      <span>
                        {t(`ledger.move_type.${total.moveType}`, { defaultValue: total.moveType })}
                      </span>
                      <span>
                        {total.entries > 0 ? `+ ${formatQuantity(total.entries)}` : ''}
                        {total.entries > 0 && total.exits > 0 ? ' / ' : ''}
                        {total.exits > 0 ? `− ${formatQuantity(total.exits)}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {explanation.unexplained === 0 ? (
                <p className="home-calm">{t('ledger.explained')}</p>
              ) : (
                <>
                  <p className="text-warn">
                    {t('ledger.unexplained', {
                      quantity: formatQuantity(explanation.unexplained),
                      unit: unitLabel(unitOf(productId), explanation.unexplained, refs.units),
                    })}
                  </p>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setRefresh((value) => value + 1)}
                  >
                    {t('ledger.refresh')}
                  </button>
                </>
              )}
            </>
          ) : currentBalances &&
            (currentBalances.opening === null || currentBalances.closing === null) ? (
            <div className="alert alert-error" role="alert">
              <p>{t('ledger.balance_unavailable')}</p>
              <button
                type="button"
                className="secondary"
                onClick={() => setBalancesAttempt((value) => value + 1)}
              >
                {t('ledger.retry')}
              </button>
            </div>
          ) : current?.denied ? (
            <p className="home-muted">{t('ledger.out_of_scope')}</p>
          ) : current?.failed ? (
            <p className="home-muted">{t('ledger.explain_unavailable')}</p>
          ) : current && current.next !== null ? (
            <p className="home-muted">{t('ledger.explain_incomplete')}</p>
          ) : (
            <p className="home-muted">{t('sales.loading')}</p>
          )}
        </section>
      ) : null}

      {ready ? (
        <section className="sale-block" aria-labelledby="ledger-moves-title">
          <h2 id="ledger-moves-title">{t('ledger.moves_title')}</h2>
          {current === undefined ? (
            <p className="home-muted">{t('sales.loading')}</p>
          ) : current.denied ? (
            <p className="alert alert-error">{t('ledger.out_of_scope')}</p>
          ) : current.failed && current.moves.length === 0 ? (
            <>
              <p className="alert alert-error">{t('ledger.unavailable')}</p>
              <button
                type="button"
                className="secondary"
                onClick={() => setRefresh((value) => value + 1)}
              >
                {t('ledger.retry')}
              </button>
            </>
          ) : current.moves.length === 0 ? (
            <p className="home-muted">{t('ledger.none')}</p>
          ) : (
            <ul className="receipt-lines">
              {current.moves.map((move) => (
                <li
                  key={move.id}
                  aria-label={t(`ledger.move_type.${move.moveType}`, {
                    defaultValue: move.moveType,
                  })}
                >
                  <span>
                    <strong>
                      {t(`ledger.move_type.${move.moveType}`, { defaultValue: move.moveType })}
                    </strong>
                    <small>
                      {[
                        productId ? null : (products.get(move.productId)?.name ?? ''),
                        counterpartOf(move)
                          ? t(move.direction === 'IN' ? 'ledger.from_place' : 'ledger.to_place', {
                              name: counterpartOf(move),
                            })
                          : null,
                        move.isReversal ? t('ledger.reversal') : null,
                        move.capturedOffline ? t('ledger.offline') : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </small>
                  </span>
                  <span>
                    {`${move.direction === 'IN' ? '+' : '−'} ${formatQuantityUnit(move.quantity, unitOf(move.productId), refs.units)}`}
                    <small>{formatMoveMoment(move.occurredAt)}</small>
                    {move.valueXaf !== null ? <small>{formatMoney(move.valueXaf)}</small> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {current?.failed && current.moves.length > 0 ? (
            <p className="alert alert-error">{t('ledger.unavailable')}</p>
          ) : null}
          {current?.next ? (
            <button
              type="button"
              className="secondary"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {t('ledger.more')}
            </button>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
