/**
 * Détail d'une session de caisse à valider (ECR-FIN-05) : flux de la fenêtre par vendeur et par type
 * (AV-187, lecture composée du serveur), ajustements, écart courant ; validation avec motif
 * (`finance.cash_session.validate`, en ligne seulement) par un valideur admis (AV-155).
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../home/format-home.js';
import { formatMoney } from '../sales/format.js';
import { readPath, useOnlineRead } from '../sales/online-read.js';
import {
  canValidateSession,
  currentVarianceXaf,
  MAX_SESSION_REASON,
  sessionReasonRequired,
  userLabel,
  type CashSessionDetailResponse,
} from './treasury.js';

export function SessionDetail({
  sessionId,
  userId,
  online,
  reloadKey,
  blocked,
  onValidate,
}: {
  readonly sessionId: string;
  readonly userId: string;
  readonly online: boolean;
  readonly reloadKey: string;
  readonly blocked: boolean;
  readonly onValidate: (sessionId: string, reason: string) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const ids = { reason: useId(), why: useId() };
  const read = useOnlineRead<CashSessionDetailResponse>(
    `/api/v1/cash-sessions/${sessionId}`,
    (path) => readPath<CashSessionDetailResponse>(path),
    online,
    reloadKey,
  );
  const detail = read.data;
  if (read.denied) return <p className="alert alert-error">{t('treasury.detail_denied')}</p>;
  if (read.failed && !detail) {
    return (
      <div className="alert alert-error" role="alert">
        <p>{t('treasury.detail_failed')}</p>
        <button type="button" className="secondary" onClick={read.retry}>
          {t('distribution.retry')}
        </button>
      </div>
    );
  }
  if (!detail) {
    return (
      <p className="home-muted" aria-busy="true">
        {t('sales.loading')}
      </p>
    );
  }
  const session = detail.cash_session;
  const adjustments = detail.adjustments;
  const flows = detail.flows;
  const you = t('treasury.you');
  const allowed = canValidateSession(session, userId);
  const required = sessionReasonRequired(session, adjustments);
  const ready = allowed && !blocked && !read.stale && (!required || reason.trim() !== '');
  return (
    <div className="sale-block">
      {flows ? (
        <>
          <h3>{t('treasury.flows_title')}</h3>
          <p className="home-muted">
            {t(flows.window.to ? 'treasury.window' : 'treasury.window_open', {
              from: formatDateTime(flows.window.from),
              to: flows.window.to ? formatDateTime(flows.window.to) : '',
            })}
          </p>
          {flows.sellers.length === 0 ? (
            <p className="home-muted">{t('treasury.sellers_empty')}</p>
          ) : (
            <ul className="line-list">
              {flows.sellers.map((seller) => (
                <li key={seller.userId}>
                  {t('treasury.seller_line', {
                    who: userLabel(seller.userId, userId, you),
                    amount: formatMoney(seller.receivedXaf),
                    count: seller.paymentsCount,
                  })}
                </li>
              ))}
            </ul>
          )}
          {flows.unattributedReceivedXaf !== 0 ? (
            <p className="text-warn">
              {t('treasury.unattributed', { amount: formatMoney(flows.unattributedReceivedXaf) })}
            </p>
          ) : null}
          {flows.otherMovements.length > 0 ? (
            <ul className="line-list">
              {flows.otherMovements.map((movement) => (
                <li key={`${movement.movementType}:${movement.direction}`}>
                  {t('treasury.other_line', {
                    type: t(`treasury.movement_type.${movement.movementType}`, {
                      defaultValue: movement.movementType,
                    }),
                    amount: `${movement.direction === 'OUT' ? '−' : '+'}${formatMoney(movement.amountXaf)}`,
                    count: movement.count,
                  })}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="home-muted">
            {t('treasury.net_flows', {
              net: formatMoney(flows.netFlowsXaf),
              expected: formatMoney(flows.expectedNowXaf),
            })}
          </p>
          <p className="home-muted">{t('treasury.sellers_hint')}</p>
        </>
      ) : null}
      {adjustments.length > 0 ? (
        <>
          <h3>{t('treasury.adjustments_title')}</h3>
          <ul className="line-list">
            {adjustments.map((adjustment) => (
              <li key={adjustment.id}>
                {t('treasury.adjustment_line', {
                  cause: t(`treasury.adjustment_cause.${adjustment.cause}`, {
                    defaultValue: adjustment.cause,
                  }),
                  date: formatDateTime(adjustment.appliedAt),
                  delta: `${adjustment.deltaXaf > 0 ? '+' : ''}${formatMoney(adjustment.deltaXaf)}`,
                })}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p>
        <strong>
          {t('treasury.current_variance', {
            amount: formatMoney(currentVarianceXaf(session, adjustments)),
          })}
        </strong>
      </p>
      {!allowed ? (
        <p id={ids.why} className="home-muted">
          {t('treasury.validator_involved')}
        </p>
      ) : (
        <div className="field">
          <label htmlFor={ids.reason}>
            {t(required ? 'treasury.reason_required' : 'treasury.reason_optional')}
          </label>
          <textarea
            id={ids.reason}
            className="text-input"
            rows={2}
            maxLength={MAX_SESSION_REASON}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
      )}
      <button
        type="button"
        disabled={!ready}
        aria-describedby={allowed ? undefined : ids.why}
        onClick={() => onValidate(session.id, reason)}
      >
        {t('treasury.validate_submit')}
      </button>
    </div>
  );
}
