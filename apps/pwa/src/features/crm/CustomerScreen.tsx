/**
 * ECR-CRM-03 « Fiche compte client » (périmètre de l'appareil, utilisable hors ligne) : coordonnées,
 * stade, crédit et encours (corrigé des opérations de l'appareil en attente), ventes des 7 derniers
 * jours, commandes ouvertes, visites et interactions des 90 derniers jours. Raccourcis vers la vente,
 * la commande et l'encaissement, le client déjà choisi. L'historique complet (plus ancien) se lit en
 * ligne par la Finance et les responsables ; il n'est pas repris ici.
 * Disposition : en-tête et actions, puis, sur ordinateur, coordonnées et chiffres à gauche, listes à
 * droite ; sur téléphone, tout s'empile dans le même ordre.
 */
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { businessDayOf } from '@gic/domain';
import {
  AnchorButton,
  BackLink,
  Badge,
  Banner,
  Card,
  List,
  ListRow,
  LinkButton,
  PageHeader,
  Section,
  SkeletonRows,
} from '../../components/ui/index.js';
import { holdsAnyRole, ROLE_SETS, ROUTES } from '../../app/screens.js';
import { clock } from '../../platform/composition.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatBusinessDay, formatMoment } from '../home/format-home.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { localOutstanding } from '../sales/credit.js';
import { formatMoney } from '../sales/format.js';
import { openOrders, orderStatusTone } from '../sales/open-orders.js';
import { recentSales, saleListBadge } from '../sales/recent-sales.js';
import { useSalesReferences } from '../sales/references.js';
import { activityOf } from './portfolio.js';
import { stageTone } from './stage.js';
import './crm.css';

export function CustomerScreen() {
  const { t } = useTranslation();
  const { customerId } = useParams();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const navigation = useRememberedNavigation(userId);
  const refs = useSalesReferences();

  if (!refs) {
    return (
      <section className="sale crm-screen" aria-busy="true">
        <SkeletonRows rows={4} />
      </section>
    );
  }

  const customer = refs.customers.find((candidate) => candidate.id === customerId);
  if (!customer) {
    return (
      <section className="sale crm-screen">
        <BackLink to={ROUTES.portfolio}>{t('customer.back')}</BackLink>
        <Banner tone="bad">{t('customer.not_found')}</Banner>
      </section>
    );
  }

  const roles = navigation ? navigation.roles : [];
  const today = businessDayOf(clock.now());
  const outstanding = localOutstanding(
    customer,
    refs.outbox,
    refs.customersPulledAt,
    refs.customerAlias,
  );
  // Comptes absorbés compris (BR-CRM-007).
  const owns = (id: string | null) =>
    id !== null && (refs.customerAlias.get(id) ?? id) === customer.id;
  const sales = recentSales(refs).filter((sale) => owns(sale.customerId));
  const orders = openOrders(refs).filter((order) => owns(order.customerId));
  const activity = activityOf(refs, customer.id);
  const reasons = new Map(refs.reasonCodes.map((reason) => [reason.id, reason.label]));
  const zone = refs.zones.get(customer.zone_id);
  const creditText = customer.credit_allowed
    ? customer.credit_limit_xaf === null
      ? t('customer.credit_no_limit')
      : t('customer.credit_limit', { amount: formatMoney(customer.credit_limit_xaf) })
    : t('customer.credit_none');
  const hasDetails = Boolean(
    customer.contact_name || customer.phone_primary || customer.address_text || zone,
  );
  // Numéro composable (espaces retirés) : pour « Appeler » et pour le numéro des coordonnées.
  const phoneHref = customer.phone_primary
    ? `tel:${customer.phone_primary.replace(/\s/g, '')}`
    : undefined;

  return (
    <section className="sale crm-screen">
      <PageHeader
        title={customer.display_name}
        backTo={ROUTES.portfolio}
        backLabel={t('customer.back')}
        subtitle={
          <Badge tone={stageTone(customer.stage)}>
            {t(`portfolio.stage.${customer.stage}`, { defaultValue: customer.stage })}
          </Badge>
        }
      />
      {customer.pending_command_id ? (
        <Banner tone="info" role="status">
          {t('customer.pending')}
        </Banner>
      ) : null}

      <div className="chip-row">
        {phoneHref ? (
          <AnchorButton href={phoneHref} variant="tonal" icon="phone">
            {t('customer.call')}
          </AnchorButton>
        ) : null}
        {holdsAnyRole(roles, ROLE_SETS.saleRecord) ? (
          <LinkButton to={ROUTES.newSaleFor(customer.id)} icon="cart">
            {t('customer.sell')}
          </LinkButton>
        ) : null}
        {holdsAnyRole(roles, ROLE_SETS.visitRecord) ? (
          <LinkButton to={ROUTES.newVisitFor(customer.id)} variant="tonal" icon="store">
            {t('customer.visit_action')}
          </LinkButton>
        ) : null}
        {holdsAnyRole(roles, ROLE_SETS.interactionRecord) ? (
          <LinkButton to={ROUTES.interaction(customer.id)} variant="tonal" icon="edit">
            {t('customer.interaction_action')}
          </LinkButton>
        ) : null}
        {holdsAnyRole(roles, ROLE_SETS.orderCreate) ? (
          <LinkButton to={ROUTES.newOrderFor(customer.id)} variant="tonal" icon="clipboard">
            {t('customer.order')}
          </LinkButton>
        ) : null}
        {outstanding > 0 && holdsAnyRole(roles, ROLE_SETS.paymentRecord) ? (
          <LinkButton to={ROUTES.collectFor(customer.id)} variant="tonal" icon="cash">
            {t('customer.collect')}
          </LinkButton>
        ) : null}
      </div>

      <div className="crm-split">
        <div className="crm-side">
          <dl className="crm-tiles">
            <div className={outstanding > 0 ? 'tile is-warn' : 'tile'}>
              <dt className="tile-head">{t('customer.outstanding')}</dt>
              <dd className="tile-value">{formatMoney(outstanding)}</dd>
            </div>
            <div className="tile is-text">
              <dt className="tile-head">{t('customer.credit')}</dt>
              <dd className="tile-value">{creditText}</dd>
            </div>
          </dl>
          {hasDetails ? (
            <Card padded>
              <dl className="crm-details">
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
                      <a href={phoneHref}>{customer.phone_primary}</a>
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
              </dl>
            </Card>
          ) : null}
        </div>

        <div className="crm-main">
          <Section title={t('customer.orders_title')}>
            {orders.length === 0 ? (
              <p className="muted">{t('customer.none')}</p>
            ) : (
              <List>
                {orders.map((order) => (
                  <ListRow
                    key={order.id}
                    to={ROUTES.order(order.id)}
                    title={order.docNumber ?? t('sales.pending_number')}
                    subtitle={formatMoment(order.occurredAt, today)}
                    value={formatMoney(order.totalEstimatedXaf)}
                    badge={
                      <Badge tone={orderStatusTone(order.status)}>
                        {t(`orders.status.${order.status}`)}
                      </Badge>
                    }
                  />
                ))}
              </List>
            )}
          </Section>

          <Section title={t('customer.sales_title')}>
            {sales.length === 0 ? (
              <p className="muted">{t('customer.none')}</p>
            ) : (
              <List>
                {sales.map((sale) => {
                  const badge = saleListBadge(sale);
                  return (
                    <ListRow
                      key={sale.id}
                      to={ROUTES.sale(sale.id)}
                      title={sale.docNumber ?? t('sales.pending_number')}
                      subtitle={formatMoment(sale.occurredAt, today)}
                      value={formatMoney(sale.netTotalXaf)}
                      badge={
                        <>
                          <Badge tone={badge.tone}>{t(badge.labelKey)}</Badge>
                          {sale.balanceDueXaf > 0 &&
                          (sale.status === 'CONFIRMED' || sale.status === 'PENDING') ? (
                            <small className="muted">
                              {t('customer.balance_due', {
                                amount: formatMoney(sale.balanceDueXaf),
                              })}
                            </small>
                          ) : null}
                        </>
                      }
                    />
                  );
                })}
              </List>
            )}
          </Section>

          <Section title={t('customer.activity_title')}>
            {activity.length === 0 ? (
              <p className="muted">{t('customer.none')}</p>
            ) : (
              <List>
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
                  const pending = entry.pending_command_id !== undefined;
                  return (
                    <ListRow
                      key={entry.id}
                      icon={item.kind === 'VISIT' ? 'store' : 'phone'}
                      title={label}
                      subtitle={
                        note || entry.next_action_at ? (
                          <span className="crm-lines">
                            {note ? <span>{note}</span> : null}
                            {entry.next_action_at ? (
                              <span>
                                {t('portfolio.next_action', {
                                  date: formatBusinessDay(entry.next_action_at),
                                  note: entry.next_action_note ?? '',
                                })}
                              </span>
                            ) : null}
                          </span>
                        ) : undefined
                      }
                      badge={
                        <span className="crm-when">
                          <span>{formatMoment(item.at, today)}</span>
                          {pending ? <Badge tone="warn">{t('portfolio.pending')}</Badge> : null}
                        </span>
                      }
                    />
                  );
                })}
              </List>
            )}
          </Section>
        </div>
      </div>
    </section>
  );
}
