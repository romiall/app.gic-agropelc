/**
 * ECR-VEN-03 « Commandes (à confirmer, à livrer, livrées) » — hors ligne : partiel. Les commandes
 * ouvertes viennent de l'appareil (jeu `orders` et commandes saisies en attente) ; les commandes
 * livrées ou closes, que le jeu ne sert plus (`SCOPE_EXIT`), se lisent en ligne seulement
 * (`GET /api/v1/orders`), à la demande.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { businessDayOf } from '@gic/domain';
import { ROUTES } from '../../app/screens.js';
import { clock } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { formatBusinessDay, formatMoment } from '../home/format-home.js';
import { formatMoney } from './format.js';
import {
  hasPendingStock,
  hasSomethingToDeliver,
  openOrders,
  orderStatusTone,
} from './open-orders.js';
import { useSalesReferences } from './references.js';

type Filter = 'all' | 'to_deliver' | 'waiting_stock';

interface ClosedOrder {
  readonly id: string;
  readonly docNumber: string;
  readonly status: string;
  readonly customerId: string;
  readonly totalEstimatedXaf: number;
  readonly occurredAt: string;
}

type ClosedState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'loaded'; readonly orders: readonly ClosedOrder[] };

const CLOSED_STATUSES = ['FULFILLED', 'CLOSED'] as const;
const CLOSED_LIMIT = 20;

async function loadClosedOrders(): Promise<readonly ClosedOrder[] | null> {
  const pages = await Promise.all(
    CLOSED_STATUSES.map((status) =>
      authorizedRequest<{ orders?: ClosedOrder[] }>(
        getDb(),
        `/api/v1/orders?status=${status}&limit=${CLOSED_LIMIT}`,
        { method: 'GET' },
      ),
    ),
  );
  if (pages.some((page) => !page.ok)) return null;
  return pages
    .flatMap((page) => (page.ok ? (page.data.orders ?? []) : []))
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, CLOSED_LIMIT);
}

export function OrdersScreen() {
  const { t } = useTranslation();
  const refs = useSalesReferences();
  const online = useOnline();
  const [filter, setFilter] = useState<Filter>('all');
  const [closed, setClosed] = useState<ClosedState>({ kind: 'idle' });

  if (!refs) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.orders')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const today = businessDayOf(clock.now());
  const customers = new Map(refs.customers.map((customer) => [customer.id, customer]));
  const all = openOrders(refs);
  const orders = all.filter((order) =>
    filter === 'to_deliver'
      ? hasSomethingToDeliver(order)
      : filter === 'waiting_stock'
        ? hasPendingStock(order)
        : true,
  );

  const loadClosed = async () => {
    setClosed({ kind: 'loading' });
    const result = await loadClosedOrders();
    setClosed(result === null ? { kind: 'error' } : { kind: 'loaded', orders: result });
  };

  return (
    <section className="sale">
      <div className="screen-head">
        <h1>{t('nav.screens.orders')}</h1>
        <Link to={ROUTES.newOrder} className="action action-primary action-compact">
          <span className="action-label">{t('nav.screens.new_order')}</span>
        </Link>
      </div>
      <p className="home-muted">{t('orders.list.hint')}</p>

      <div className="field">
        <label htmlFor="orders-filter">{t('orders.list.filter_label')}</label>
        <select
          id="orders-filter"
          className="text-input"
          value={filter}
          onChange={(event) => setFilter(event.target.value as Filter)}
        >
          <option value="all">{t('orders.list.filter_all')}</option>
          <option value="to_deliver">{t('orders.list.filter_to_deliver')}</option>
          <option value="waiting_stock">{t('orders.list.filter_waiting_stock')}</option>
        </select>
      </div>

      {orders.length === 0 ? (
        <p className="home-muted">{t('orders.list.empty')}</p>
      ) : (
        <ul className="doc-list">
          {orders.map((order) => {
            const doc = order.docNumber ?? t('sales.pending_number');
            const customer = customers.get(order.customerId)?.display_name;
            return (
              <li key={order.id}>
                <Link
                  to={ROUTES.order(order.id)}
                  className="doc-row"
                  aria-label={t('orders.list.open', { doc })}
                >
                  <span className="doc-main">
                    <strong>{doc}</strong>
                    <small>
                      {formatMoment(order.occurredAt, today)}
                      {customer ? ` · ${customer}` : ''}
                    </small>
                    {order.requestedDeliveryDate ? (
                      <small>
                        {t('orders.list.delivery_on', {
                          date: formatBusinessDay(order.requestedDeliveryDate),
                        })}
                      </small>
                    ) : null}
                  </span>
                  <span className="doc-side">
                    <strong>{formatMoney(order.totalEstimatedXaf)}</strong>
                    <span className={`badge badge-${orderStatusTone(order.status)}`}>
                      {t(`orders.status.${order.status}`)}
                    </span>
                    {hasSomethingToDeliver(order) ? (
                      <span className="badge badge-info">{t('orders.list.to_deliver_badge')}</span>
                    ) : null}
                    {hasPendingStock(order) && order.status !== 'PENDING' ? (
                      <span className="badge badge-warn">
                        {t('orders.list.waiting_stock_badge')}
                      </span>
                    ) : null}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <section className="sale-block" aria-labelledby="orders-closed-title">
        <h2 id="orders-closed-title">{t('orders.list.closed_title')}</h2>
        {!online ? (
          <p className="home-muted">{t('orders.list.closed_offline')}</p>
        ) : closed.kind === 'idle' ? (
          <button type="button" className="secondary btn-block" onClick={() => void loadClosed()}>
            {t('orders.list.closed_load')}
          </button>
        ) : closed.kind === 'loading' ? (
          <p className="home-muted" aria-busy="true">
            {t('sales.loading')}
          </p>
        ) : closed.kind === 'error' ? (
          <p className="text-warn">{t('orders.list.closed_error')}</p>
        ) : closed.orders.length === 0 ? (
          <p className="home-muted">{t('orders.list.closed_empty')}</p>
        ) : (
          <ul className="doc-list">
            {closed.orders.map((order) => (
              <li key={order.id} className="doc-row">
                <span className="doc-main">
                  <strong>{order.docNumber}</strong>
                  <small>
                    {formatMoment(order.occurredAt, today)}
                    {customers.get(order.customerId)
                      ? ` · ${customers.get(order.customerId)?.display_name}`
                      : ''}
                  </small>
                </span>
                <span className="doc-side">
                  <strong>{formatMoney(order.totalEstimatedXaf)}</strong>
                  <span className="badge badge-muted">{t(`orders.status.${order.status}`)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
