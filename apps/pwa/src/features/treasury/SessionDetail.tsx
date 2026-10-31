/**
 * Détail d'une session de caisse à valider (ECR-FIN-05) : flux de la fenêtre par vendeur et par type
 * (AV-187, lecture composée du serveur), ajustements, écart courant ; validation avec motif
 * (`finance.cash_session.validate`, en ligne seulement) par un valideur admis (AV-155).
 */
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Banner, Button, Field, SkeletonRows, Textarea } from '../../components/ui/index.js';
import { formatDateTime } from '../home/format-home.js';
import { formatMoney } from '../sales/format.js';
import { readPath, useOnlineRead } from '../sales/online-read.js';
import {
  currentVarianceXaf,
  MAX_SESSION_REASON,
  sessionReasonRequired,
  sessionValidationBlock,
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
  onRefresh,
}: {
  readonly sessionId: string;
  readonly userId: string;
  readonly online: boolean;
  readonly reloadKey: string;
  readonly blocked: boolean;
  readonly onValidate: (sessionId: string, reason: string) => void;
  /** Relit la liste des sessions (session déjà validée par un autre). */
  readonly onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const ids = { why: useId(), stale: useId() };
  const read = useOnlineRead<CashSessionDetailResponse>(
    `/api/v1/cash-sessions/${sessionId}`,
    (path) => readPath<CashSessionDetailResponse>(path),
    online,
    reloadKey,
  );
  const detail = read.data;
  if (read.denied) return <Banner tone="bad">{t('treasury.detail_denied')}</Banner>;
  // Relecture en échec : annoncée avec « Réessayer », le détail d'avant restant affiché comme tel.
  const failure = read.failed ? (
    <Banner
      tone="bad"
      role="alert"
      action={
        <Button variant="outline" size="sm" onClick={read.retry}>
          {t('distribution.retry')}
        </Button>
      }
    >
      {t(detail ? 'treasury.detail_failed_stale' : 'treasury.detail_failed')}
    </Banner>
  ) : null;
  if (!detail) {
    if (failure) return failure;
    return <SkeletonRows rows={2} />;
  }
  const session = detail.cash_session;
  const adjustments = detail.adjustments;
  const flows = detail.flows;
  const you = t('treasury.you');
  const block = sessionValidationBlock(session, userId);
  const allowed = block === null;
  const required = sessionReasonRequired(session, adjustments);
  const ready = allowed && !blocked && !read.stale && (!required || reason.trim() !== '');
  return (
    <div className="tre-detail">
      {failure}
      {read.stale && !read.failed ? (
        <p id={ids.stale} className="home-muted" role="status">
          {t('treasury.refreshing')}
        </p>
      ) : null}
      {flows ? (
        <>
          <h3 className="fin-sub">{t('treasury.flows_title')}</h3>
          <p className="home-muted">
            {t(flows.window.to ? 'treasury.window' : 'treasury.window_open', {
              from: formatDateTime(flows.window.from),
              to: flows.window.to ? formatDateTime(flows.window.to) : '',
            })}
          </p>
          {flows.sellers.length === 0 ? (
            <p className="home-muted">{t('treasury.sellers_empty')}</p>
          ) : (
            <ul className="fin-breakdown">
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
            <ul className="fin-breakdown">
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
          <h3 className="fin-sub">{t('treasury.adjustments_title')}</h3>
          <ul className="fin-breakdown">
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
      {block === 'NOT_PENDING' ? (
        <div id={ids.why}>
          <p className="home-muted">{t('treasury.session_not_pending')}</p>
          <Button variant="outline" size="sm" onClick={onRefresh}>
            {t('treasury.refresh_list')}
          </Button>
        </div>
      ) : block === 'INVOLVED' ? (
        <p id={ids.why} className="home-muted">
          {t('treasury.validator_involved')}
        </p>
      ) : (
        <Field label={t(required ? 'treasury.reason_required' : 'treasury.reason_optional')}>
          {(control) => (
            <Textarea
              {...control}
              rows={2}
              maxLength={MAX_SESSION_REASON}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>
      )}
      <Button
        disabled={!ready}
        aria-describedby={!allowed ? ids.why : read.stale ? ids.stale : undefined}
        onClick={() => onValidate(session.id, reason)}
      >
        {t('treasury.validate_submit')}
      </Button>
    </div>
  );
}
