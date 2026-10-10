/**
 * ECR-VEN-05 « Détail d'une vente (reçu, annulation) ». Le reçu se compose sur l'appareil, à partir
 * de la vente servie par le serveur ou, tant qu'elle n'est pas confirmée, de la vente saisie sur
 * l'appareil (numéro officiel en attente). L'annulation passe par l'outbox (`sales.sale.cancel`) :
 * immédiate pour le vendeur dans le délai `sales.direct_cancel_minutes` (BR-VEN-028, défaut 15 min,
 * et session de caisse encore ouverte au PDV, P5-14), sinon transformée par le serveur en demande
 * soumise à validation. Le motif est choisi dans la liste `CANCELLATION` (UX-06).
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { businessDayOf, withinCancellationWindow } from '@gic/domain';
import { clock } from '../../platform/composition.js';
import { holdsAnyRole, ROLE_SETS, ROUTES } from '../../app/screens.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatBusinessDay, formatClockTime } from '../home/format-home.js';
import { CommandResult } from './CommandResult.js';
import { formatMoney, formatQuantity } from './format.js';
import { recentSales, saleStatusTone, type SaleView } from './recent-sales.js';
import { useSalesReferences, type SalesReferences } from './references.js';
import { settingValue } from './stock.js';
import { MAX_COMMENT_LENGTH } from './sale-form.js';
import { submitCommand } from './submit.js';

const DEFAULT_CANCEL_MINUTES = 15;

type Treatment = 'REFUND' | 'CUSTOMER_CREDIT';

function CancelSaleForm({
  sale,
  refs,
  userId,
  onDone,
  onClose,
}: {
  readonly sale: SaleView;
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

  const now = clock.now();
  const configured = Number(
    settingValue(refs.settings, 'sales.direct_cancel_minutes', sale.siteId, now),
  );
  const minutes =
    Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_CANCEL_MINUTES;
  const direct =
    sale.sellerUserId === userId &&
    withinCancellationWindow({
      saleOccurredAt: new Date(sale.occurredAt),
      cancelAt: now,
      windowMinutes: minutes,
    });
  const reasons = refs.reasonCodes.filter((reason) => reason.category === 'CANCELLATION');
  const reason = reasons.find((candidate) => candidate.id === reasonId);
  const needsTreatment = sale.customerId !== null && sale.amountPaidXaf > 0;
  const errors: string[] = [];
  if (!reason && !comment.trim()) errors.push(t('sales.cancel.comment_required'));
  if (reason?.requires_comment && !comment.trim()) errors.push(t('sales.cancel.comment_required'));
  if (needsTreatment && treatment === null) errors.push(t('sales.cancel.treatment_required'));

  const submit = async () => {
    if (errors.length > 0 || busy) return;
    setBusy(true);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: 'sales.sale.cancel',
        aggregateType: 'SALE_CANCELLATION',
        // Vente encore dans l'outbox : l'annulation attend son application (FIFO de l'appareil).
        ...(sale.commandId ? { dependsOn: [sale.commandId] } : {}),
        payload: {
          saleId: sale.id,
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
    <section className="sale-block cancel-form" aria-labelledby="cancel-title">
      <h2 id="cancel-title">{t('sales.cancel.title')}</h2>
      <p className="home-muted">
        {t(direct ? 'sales.cancel.direct_hint' : 'sales.cancel.request_hint', { minutes })}
      </p>
      {reasons.length > 0 ? (
        <div className="field">
          <label htmlFor="cancel-reason">{t('sales.cancel.reason_label')}</label>
          <select
            id="cancel-reason"
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
        <label htmlFor="cancel-comment">{t('sales.cancel.comment_label')}</label>
        <textarea
          id="cancel-comment"
          className="text-input"
          rows={2}
          maxLength={MAX_COMMENT_LENGTH}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
        />
      </div>
      {needsTreatment ? (
        <fieldset className="choice-group">
          <legend>
            {t('sales.cancel.treatment_legend', { amount: formatMoney(sale.amountPaidXaf) })}
          </legend>
          {(['CUSTOMER_CREDIT', 'REFUND'] as const).map((option) => (
            <label key={option} className="choice">
              <input
                type="radio"
                name="cancel-treatment"
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
          {t('sales.cancel.submit')}
        </button>
        <button type="button" className="secondary" onClick={onClose}>
          {t('sales.cancel.close')}
        </button>
      </div>
    </section>
  );
}

export function SaleDetailScreen() {
  const { t } = useTranslation();
  const { saleId } = useParams();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
  const navigation = useRememberedNavigation(userId);
  const [cancelling, setCancelling] = useState(false);
  const [cancelCommandId, setCancelCommandId] = useState<string>();

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const sale = recentSales(refs).find((candidate) => candidate.id === saleId);
  const back = (
    <Link to={ROUTES.sales} className="back-link">
      {t('sales.detail.back')}
    </Link>
  );
  if (!sale) {
    return (
      <section className="sale">
        {back}
        <p className="alert alert-error">{t('sales.detail.not_found')}</p>
      </section>
    );
  }

  const customer = sale.customerId
    ? refs.customers.find((candidate) => candidate.id === sale.customerId)
    : undefined;
  const location = refs.locations.find((candidate) => candidate.id === sale.fromLocationId);
  const doc = sale.docNumber ?? t('sales.pending_number');
  const cancellable =
    (sale.status === 'CONFIRMED' || sale.status === 'PENDING') &&
    !sale.cancellationPending &&
    !cancelCommandId;

  return (
    <section className="sale">
      {back}
      <article className="receipt" aria-labelledby="receipt-title">
        <header className="receipt-head">
          <h1 id="receipt-title">
            {t('sales.detail.receipt_title')} {doc}
          </h1>
          <span className={`badge badge-${saleStatusTone(sale.status)}`}>
            {t(`sales.status.${sale.status}`)}
          </span>
        </header>
        <p className="receipt-meta">
          {t('sales.detail.date', {
            date: formatBusinessDay(businessDayOf(new Date(sale.occurredAt))),
            time: formatClockTime(sale.occurredAt),
          })}
          {location ? ` · ${location.name}` : ''}
        </p>
        <p className="receipt-meta">
          {customer?.display_name ?? t('sales.list.anonymous')}
          {sale.sellerUserId === userId ? ` · ${t('sales.detail.seller_you')}` : ''}
          {sale.capturedOffline ? ` · ${t('sales.detail.offline_captured')}` : ''}
        </p>
        <ul className="receipt-lines">
          {sale.lines.map((line, index) => (
            <li key={`${line.productId}-${index}`}>
              <span>
                <strong>{line.productName}</strong>
                <small>
                  {t('sales.detail.line', {
                    quantity: formatQuantity(line.quantity),
                    unit: line.unitCode,
                    price: formatMoney(line.unitPriceXaf),
                  })}
                  {line.discountXaf > 0
                    ? ` · ${t('sales.detail.discount', { amount: formatMoney(line.discountXaf) })}`
                    : ''}
                  {line.cancelledXaf > 0
                    ? ` · ${t('sales.detail.cancelled_part', { amount: formatMoney(line.cancelledXaf) })}`
                    : ''}
                </small>
              </span>
              <span>{formatMoney(line.lineTotalXaf)}</span>
            </li>
          ))}
        </ul>
        <dl className="receipt-totals">
          <dt>{t('sales.detail.total')}</dt>
          <dd>{formatMoney(sale.netTotalXaf)}</dd>
          <dt>{t('sales.detail.paid')}</dt>
          <dd>{formatMoney(sale.amountPaidXaf)}</dd>
          <dt>{t('sales.detail.balance')}</dt>
          <dd>{formatMoney(sale.balanceDueXaf)}</dd>
        </dl>
      </article>

      {sale.rejection ? (
        <p className="alert alert-error" role="alert">
          {t('sales.detail.rejection', { reason: sale.rejection })}
        </p>
      ) : null}
      {sale.cancellationPending ? (
        <p className="home-banner">{t('sales.detail.cancellation_pending')}</p>
      ) : null}
      {sale.flags.length > 0 ? (
        <p className="text-warn">{t('sales.detail.flag_hint', { flags: sale.flags.join(', ') })}</p>
      ) : null}

      <div className="result-actions no-print">
        <button type="button" className="secondary" onClick={() => window.print()}>
          {t('sales.detail.print')}
        </button>
        {sale.customerId &&
        customer &&
        sale.balanceDueXaf > 0 &&
        sale.status === 'CONFIRMED' &&
        holdsAnyRole(navigation?.roles ?? [], ROLE_SETS.paymentRecord) ? (
          <Link to={ROUTES.collectFor(sale.customerId)} className="action action-compact">
            <span className="action-label">{t('sales.detail.collect')}</span>
          </Link>
        ) : null}
        {cancellable && !cancelling ? (
          <button type="button" className="secondary" onClick={() => setCancelling(true)}>
            {t('sales.cancel.open')}
          </button>
        ) : null}
      </div>

      {cancelCommandId ? (
        <CommandResult commandId={cancelCommandId} messages="sales.cancel.result" />
      ) : cancelling ? (
        <CancelSaleForm
          sale={sale}
          refs={refs}
          userId={userId}
          onDone={(commandId) => {
            setCancelCommandId(commandId);
            setCancelling(false);
          }}
          onClose={() => setCancelling(false)}
        />
      ) : null}
    </section>
  );
}
