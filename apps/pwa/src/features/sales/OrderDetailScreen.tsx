/**
 * Détail d'une commande ouverte (ECR-VEN-03) : progression de chaque ligne (commandé, vendu, livré,
 * en attente de stock, à livrer), et les suites possibles, toutes par l'outbox :
 * - livrer (ECR-VEN-04) ce qui est vendu et pas encore livré ;
 * - vendre le disponible pour la part en attente (`sales.order.confirm_remaining`, AV-127) ;
 * - annuler la commande non livrée (`sales.order.cancel`) ou, après une livraison partielle,
 *   clôturer le reste (`sales.order.close_remaining`), avec un motif `CANCELLATION` ou un
 *   commentaire et, si un acompte ou un paiement est libéré, son sort (AV-146).
 * Les actions proposées suivent les rôles de l'utilisateur (`ROLE_SETS`) ; le serveur décide.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { holdsAnyRole, ROLE_SETS, ROUTES } from '../../app/screens.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatBusinessDay } from '../home/format-home.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { CommandResult } from './CommandResult.js';
import { formatMoney, formatQuantity } from './format.js';
import {
  hasPendingStock,
  hasSomethingToDeliver,
  openOrders,
  orderStatusTone,
  type OrderView,
} from './open-orders.js';
import { useSalesReferences, type SalesReferences } from './references.js';
import { submitCommand } from './submit.js';

type Treatment = 'REFUND' | 'CUSTOMER_CREDIT';

function RetireOrderForm({
  order,
  refs,
  userId,
  onDone,
  onClose,
}: {
  readonly order: OrderView;
  readonly refs: SalesReferences;
  readonly userId: string;
  readonly onDone: (commandId: string) => void;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const [reasonId, setReasonId] = useState('');
  const [comment, setComment] = useState('');
  const [treatment, setTreatment] = useState<Treatment | null>(null);
  const [busy, setBusy] = useState(false);
  const closing = order.status === 'PARTIALLY_FULFILLED';
  const reasons = refs.reasonCodes.filter((reason) => reason.category === 'CANCELLATION');
  const reason = reasons.find((candidate) => candidate.id === reasonId);
  const needsTreatment = order.advancePaidXaf > 0;
  const errors: string[] = [];
  if ((!reason || reason.requires_comment) && !comment.trim()) {
    errors.push(t('sales.cancel.comment_required'));
  }
  if (needsTreatment && treatment === null) errors.push(t('sales.cancel.treatment_required'));

  const submit = async () => {
    if (errors.length > 0 || busy) return;
    setBusy(true);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: closing ? 'sales.order.close_remaining' : 'sales.order.cancel',
        aggregateType: 'SALES_ORDER',
        aggregateId: order.id,
        payload: {
          ...(reason ? { reasonCodeId: reason.id } : {}),
          ...(comment.trim() ? { comment: comment.trim() } : {}),
          ...(needsTreatment && treatment ? { paymentTreatment: treatment } : {}),
        },
      });
      onDone(command.command_id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sale-block cancel-form" aria-labelledby="retire-title">
      <h2 id="retire-title">
        {t(closing ? 'orders.retire.title_close' : 'orders.retire.title_cancel')}
      </h2>
      <p className="home-muted">
        {t(closing ? 'orders.retire.hint_close' : 'orders.retire.hint_cancel')}
      </p>
      {reasons.length > 0 ? (
        <div className="field">
          <label htmlFor="retire-reason">{t('sales.cancel.reason_label')}</label>
          <select
            id="retire-reason"
            className="text-input"
            value={reasonId}
            onChange={(event) => setReasonId(event.target.value)}
          >
            <option value="">{t('sales.cancel.reason_placeholder')}</option>
            {reasons.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="field">
        <label htmlFor="retire-comment">{t('sales.cancel.comment_label')}</label>
        <textarea
          id="retire-comment"
          className="text-input"
          rows={2}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
      </div>
      {needsTreatment ? (
        <fieldset className="choice-group">
          <legend>{t('orders.retire.treatment_legend')}</legend>
          {(['CUSTOMER_CREDIT', 'REFUND'] as const).map((option) => (
            <label key={option} className="choice">
              <input
                type="radio"
                name="retire-treatment"
                value={option}
                checked={treatment === option}
                onChange={() => setTreatment(option)}
              />
              {t(`sales.cancel.treatment_${option}`)}
            </label>
          ))}
        </fieldset>
      ) : null}
      {errors.map((message) => (
        <p key={message} className="error-message">
          {message}
        </p>
      ))}
      <div className="result-actions">
        <button type="button" onClick={() => void submit()} disabled={errors.length > 0 || busy}>
          {t('orders.retire.submit')}
        </button>
        <button type="button" className="secondary" onClick={onClose}>
          {t('orders.retire.close')}
        </button>
      </div>
    </section>
  );
}

export function OrderDetailScreen() {
  const { t } = useTranslation();
  const { orderId } = useParams();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const navigation = useRememberedNavigation(userId);
  const refs = useSalesReferences();
  const [retiring, setRetiring] = useState(false);
  const [resultId, setResultId] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const order = openOrders(refs).find((candidate) => candidate.id === orderId);
  const back = (
    <Link to={ROUTES.orders} className="back-link">
      {t('orders.detail.back')}
    </Link>
  );
  if (!order) {
    return (
      <section className="sale">
        {back}
        <p className="alert alert-error">{t('orders.detail.not_found')}</p>
      </section>
    );
  }

  const roles = navigation?.roles ?? [];
  const customer = refs.customers.find((candidate) => candidate.id === order.customerId);
  const location = refs.locations.find((candidate) => candidate.id === order.fulfilmentLocationId);
  const doc = order.docNumber ?? t('sales.pending_number');
  const confirmed = order.status === 'CONFIRMED' || order.status === 'PARTIALLY_FULFILLED';
  const canDeliver =
    confirmed && hasSomethingToDeliver(order) && holdsAnyRole(roles, ROLE_SETS.orderFulfil);
  const canConfirm =
    confirmed && hasPendingStock(order) && holdsAnyRole(roles, ROLE_SETS.orderCreate);
  const canRetire = confirmed && holdsAnyRole(roles, ROLE_SETS.orderCancel);

  const confirmRemaining = async () => {
    setBusy(true);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: 'sales.order.confirm_remaining',
        aggregateType: 'SALES_ORDER',
        aggregateId: order.id,
        payload: {},
      });
      setResultId(command.command_id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sale">
      {back}
      <header className="receipt-head">
        <h1>{t('orders.detail.title', { doc })}</h1>
        <span className={`badge badge-${orderStatusTone(order.status)}`}>
          {t(`orders.status.${order.status}`)}
        </span>
      </header>
      <p className="receipt-meta">
        {customer?.display_name ?? ''}
        {location ? ` · ${t('orders.detail.prepared_at', { location: location.name })}` : ''}
      </p>
      {order.requestedDeliveryDate ? (
        <p className="receipt-meta">
          {t('orders.list.delivery_on', { date: formatBusinessDay(order.requestedDeliveryDate) })}
        </p>
      ) : null}
      {order.deliveryAddress ? <p className="receipt-meta">{order.deliveryAddress}</p> : null}

      <ul className="line-list order-lines">
        {order.lines.map((line, index) => (
          <li key={line.id ?? `${line.productId}-${index}`} className="line-card">
            <div className="line-head">
              <strong>{line.productName}</strong>
              <span>{formatMoney(line.lineTotalXaf)}</span>
            </div>
            <dl className="progress-grid">
              <dt>{t('orders.detail.ordered')}</dt>
              <dd>{formatQuantity(line.orderedBase)}</dd>
              <dt>{t('orders.detail.sold')}</dt>
              <dd>{formatQuantity(line.soldBase)}</dd>
              <dt>{t('orders.detail.delivered')}</dt>
              <dd>{formatQuantity(line.deliveredBase)}</dd>
              <dt>{t('orders.detail.pending')}</dt>
              <dd className={line.pendingBase > 0 ? 'text-warn' : undefined}>
                {formatQuantity(line.pendingBase)}
              </dd>
              <dt>{t('orders.detail.to_deliver')}</dt>
              <dd>{formatQuantity(line.toDeliverBase)}</dd>
            </dl>
            {line.deliveringBase > 0 ? (
              <p className="home-muted">
                {t('orders.detail.delivering', { quantity: formatQuantity(line.deliveringBase) })}
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      <dl className="receipt-totals">
        <dt>{t('orders.detail.total_estimated')}</dt>
        <dd>{formatMoney(order.totalEstimatedXaf)}</dd>
        <dt>{t('orders.detail.advance_paid')}</dt>
        <dd>{formatMoney(order.advancePaidXaf)}</dd>
      </dl>

      {order.rejection ? (
        <p className="alert alert-error" role="alert">
          {t('orders.detail.rejection', { reason: order.rejection })}
        </p>
      ) : null}

      {resultId ? (
        <CommandResult commandId={resultId} messages="orders.confirm_result" />
      ) : retiring ? (
        <RetireOrderForm
          order={order}
          refs={refs}
          userId={userId}
          onDone={(commandId) => {
            setResultId(commandId);
            setRetiring(false);
          }}
          onClose={() => setRetiring(false)}
        />
      ) : (
        <div className="result-actions order-actions">
          {canDeliver ? (
            <Link to={ROUTES.deliver(order.id)} className="action action-primary action-compact">
              <span className="action-label">{t('orders.detail.deliver')}</span>
            </Link>
          ) : null}
          {canConfirm ? (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void confirmRemaining()}
            >
              {t('orders.detail.confirm_remaining')}
            </button>
          ) : null}
          {canRetire ? (
            <button type="button" className="secondary" onClick={() => setRetiring(true)}>
              {t(
                order.status === 'PARTIALLY_FULFILLED'
                  ? 'orders.detail.close_remaining'
                  : 'orders.detail.retire',
              )}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
