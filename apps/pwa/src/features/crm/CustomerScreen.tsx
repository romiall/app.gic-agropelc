/**
 * ECR-CRM-03 « Fiche compte client » (périmètre de l'appareil, utilisable hors ligne) : coordonnées,
 * stade, crédit et encours (corrigé des opérations de l'appareil en attente), ventes des 7 derniers
 * jours, commandes ouvertes, visites et interactions des 90 derniers jours. Raccourcis vers la vente,
 * la commande et l'encaissement, le client déjà choisi. L'historique complet (plus ancien) se lit en
 * ligne par la Finance et les responsables ; il n'est pas repris ici.
 */
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { businessDayOf } from '@gic/domain';
import { holdsAnyRole, ROLE_SETS, ROUTES } from '../../app/screens.js';
import { clock } from '../../platform/composition.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatBusinessDay, formatMoment } from '../home/format-home.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { localOutstanding } from '../sales/credit.js';
import { formatMoney } from '../sales/format.js';
import { openOrders } from '../sales/open-orders.js';
import { recentSales } from '../sales/recent-sales.js';
import { useSalesReferences } from '../sales/references.js';
import { activityOf } from './portfolio.js';

export function CustomerScreen() {
  const { t } = useTranslation();
  const { customerId } = useParams();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const navigation = useRememberedNavigation(userId);
  const refs = useSalesReferences();

  if (!refs) {
    return (
      <section className="sale" aria-busy="true">
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const back = (
    <Link to={ROUTES.portfolio} className="back-link">
      {t('customer.back')}
    </Link>
  );
  const customer = refs.customers.find((candidate) => candidate.id === customerId);
  if (!customer) {
    return (
      <section className="sale">
        {back}
        <p className="alert alert-error">{t('customer.not_found')}</p>
      </section>
    );
  }

  const roles = navigation ? navigation.roles : [];
  const today = businessDayOf(clock.now());
  const outstanding = localOutstanding(customer, refs.outbox, refs.customersPulledAt);
  const sales = recentSales(refs).filter((sale) => sale.customerId === customer.id);
  const orders = openOrders(refs).filter((order) => order.customerId === customer.id);
  const activity = activityOf(refs, customer.id);
  const reasons = new Map(refs.reasonCodes.map((reason) => [reason.id, reason.label]));
  const zone = refs.zones.get(customer.zone_id);

  return (
    <section className="sale">
      {back}
      <header className="receipt-head">
        <h1>{customer.display_name}</h1>
        <span className="badge badge-info">
          {t(`portfolio.stage.${customer.stage}`, { defaultValue: customer.stage })}
        </span>
      </header>
      {customer.pending_command_id ? <p className="home-banner">{t('customer.pending')}</p> : null}
      <dl className="receipt-totals">
        {customer.contact_name ? (
          <>
            <dt>{t('customer.contact')}</dt>
            <dd>{customer.contact_name}</dd>
          </>
        ) : null}
        {customer.phone_primary ? (
          <>
            <dt>{t('customer.phone')}</dt>
            <dd>
              <a href={`tel:${customer.phone_primary.replace(/\s/g, '')}`}>
                {customer.phone_primary}
              </a>
            </dd>
          </>
        ) : null}
        {customer.address_text ? (
          <>
            <dt>{t('customer.address')}</dt>
            <dd>{customer.address_text}</dd>
          </>
        ) : null}
        {zone ? (
          <>
            <dt>{t('customer.zone')}</dt>
            <dd>{zone.name}</dd>
          </>
        ) : null}
        <dt>{t('customer.outstanding')}</dt>
        <dd>{formatMoney(outstanding)}</dd>
        <dt>{t('customer.credit')}</dt>
        <dd>
          {customer.credit_allowed
            ? customer.credit_limit_xaf === null
              ? t('customer.credit_no_limit')
              : t('customer.credit_limit', { amount: formatMoney(customer.credit_limit_xaf) })
            : t('customer.credit_none')}
        </dd>
      </dl>

      <div className="result-actions">
        {holdsAnyRole(roles, ROLE_SETS.saleRecord) ? (
          <Link
            to={ROUTES.newSaleFor(customer.id)}
            className="action action-primary action-compact"
          >
            <span className="action-label">{t('customer.sell')}</span>
          </Link>
        ) : null}
        {holdsAnyRole(roles, ROLE_SETS.orderCreate) ? (
          <Link to={ROUTES.newOrderFor(customer.id)} className="action action-compact">
            <span className="action-label">{t('customer.order')}</span>
          </Link>
        ) : null}
        {outstanding > 0 && holdsAnyRole(roles, ROLE_SETS.paymentRecord) ? (
          <Link to={ROUTES.collectFor(customer.id)} className="action action-compact">
            <span className="action-label">{t('customer.collect')}</span>
          </Link>
        ) : null}
      </div>

      <section className="sale-block" aria-labelledby="customer-orders-title">
        <h2 id="customer-orders-title">{t('customer.orders_title')}</h2>
        {orders.length === 0 ? (
          <p className="home-muted">{t('customer.none')}</p>
        ) : (
          <ul className="doc-list">
            {orders.map((order) => (
              <li key={order.id}>
                <Link to={ROUTES.order(order.id)} className="doc-row">
                  <span className="doc-main">
                    <strong>{order.docNumber ?? t('sales.pending_number')}</strong>
                    <small>{formatMoment(order.occurredAt, today)}</small>
                  </span>
                  <span className="doc-side">
                    <strong>{formatMoney(order.totalEstimatedXaf)}</strong>
                    <span className="badge badge-info">{t(`orders.status.${order.status}`)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="sale-block" aria-labelledby="customer-sales-title">
        <h2 id="customer-sales-title">{t('customer.sales_title')}</h2>
        {sales.length === 0 ? (
          <p className="home-muted">{t('customer.none')}</p>
        ) : (
          <ul className="doc-list">
            {sales.map((sale) => (
              <li key={sale.id}>
                <Link to={ROUTES.sale(sale.id)} className="doc-row">
                  <span className="doc-main">
                    <strong>{sale.docNumber ?? t('sales.pending_number')}</strong>
                    <small>{formatMoment(sale.occurredAt, today)}</small>
                  </span>
                  <span className="doc-side">
                    <strong>{formatMoney(sale.netTotalXaf)}</strong>
                    {sale.balanceDueXaf > 0 ? (
                      <small>
                        {t('customer.balance_due', { amount: formatMoney(sale.balanceDueXaf) })}
                      </small>
                    ) : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="sale-block" aria-labelledby="customer-activity-title">
        <h2 id="customer-activity-title">{t('customer.activity_title')}</h2>
        {activity.length === 0 ? (
          <p className="home-muted">{t('customer.none')}</p>
        ) : (
          <ul className="receipt-lines">
            {activity.map((item) => {
              const entry = item.kind === 'VISIT' ? item.visit : item.interaction;
              const label =
                item.kind === 'VISIT'
                  ? t('customer.visit', {
                      outcome: item.visit.outcome_reason_code_id
                        ? (reasons.get(item.visit.outcome_reason_code_id) ?? '')
                        : '',
                    })
                  : t(`customer.channel.${item.interaction.channel}`);
              const note = item.kind === 'VISIT' ? item.visit.notes : item.interaction.summary;
              return (
                <li key={entry.id}>
                  <span>
                    <strong>{label}</strong>
                    {note ? <small>{note}</small> : null}
                    {entry.next_action_at ? (
                      <small>
                        {t('portfolio.next_action', {
                          date: formatBusinessDay(entry.next_action_at),
                          note: entry.next_action_note ?? '',
                        })}
                      </small>
                    ) : null}
                  </span>
                  <span>{formatMoment(item.at, today)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </section>
  );
}
