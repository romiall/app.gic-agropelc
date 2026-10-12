/**
 * Ventes récentes (accès à ECR-VEN-05) : les ventes des 7 derniers jours connues de l'appareil, dont
 * celles saisies sur l'appareil et pas encore acceptées par le serveur, la plus récente d'abord.
 * Utilisable hors ligne.
 */
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { businessDayOf } from '@gic/domain';
import { clock } from '../../platform/composition.js';
import { ROUTES } from '../../app/screens.js';
import { formatMoment } from '../home/format-home.js';
import { formatMoney } from './format.js';
import { recentSales, saleStatusTone } from './recent-sales.js';
import { rootCustomerId, useSalesReferences } from './references.js';

export function SalesListScreen() {
  const { t } = useTranslation();
  const refs = useSalesReferences();

  if (!refs) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.sales')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const today = businessDayOf(clock.now());
  const customers = new Map(refs.customers.map((customer) => [customer.id, customer]));
  const sales = recentSales(refs);

  return (
    <section className="sale">
      <div className="screen-head">
        <h1>{t('nav.screens.sales')}</h1>
        <Link to={ROUTES.newSale} className="action action-primary action-compact">
          <span className="action-label">{t('nav.screens.new_sale')}</span>
        </Link>
      </div>
      <p className="home-muted">{t('sales.list.window_hint')}</p>
      {sales.length === 0 ? (
        <p className="home-muted">{t('sales.list.empty')}</p>
      ) : (
        <ul className="doc-list">
          {sales.map((sale) => {
            const customerName = sale.customerId
              ? (customers.get(rootCustomerId(refs.customerAlias, sale.customerId))?.display_name ??
                t('sales.list.unknown_customer'))
              : t('sales.list.anonymous');
            const doc = sale.docNumber ?? t('sales.pending_number');
            return (
              <li key={sale.id}>
                <Link
                  to={ROUTES.sale(sale.id)}
                  aria-label={t('sales.list.open', { doc })}
                  className="doc-row"
                >
                  <span className="doc-main">
                    <strong>{doc}</strong>
                    <small>
                      {formatMoment(sale.occurredAt, today)} · {customerName}
                    </small>
                  </span>
                  <span className="doc-side">
                    <strong>{formatMoney(sale.netTotalXaf)}</strong>
                    <span className={`badge badge-${saleStatusTone(sale.status)}`}>
                      {sale.status === 'CONFIRMED' && sale.paymentStatus
                        ? t(`sales.payment_status.${sale.paymentStatus}`)
                        : t(`sales.status.${sale.status}`)}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
