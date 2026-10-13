/**
 * Mouvements d'un compte de trésorerie (ECR-FIN-05 ; `GET /cash-accounts/{id}/movements`) : du plus
 * récent au plus ancien, par pages de 50 ; les plus anciens sont chargés à la demande et rattachés à
 * la première page lue (une relecture repart de la plus récente).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime } from '../home/format-home.js';
import { formatMoney } from '../sales/format.js';
import { readPath, useOnlineRead } from '../sales/online-read.js';
import type { CashMovementItem, CashMovementsPage } from './treasury.js';

/** Taille d'une page de mouvements (défaut du serveur). */
const MOVEMENTS_PAGE = 50;

interface Older {
  /** Première page à laquelle ces pages se rattachent. */
  readonly base: CashMovementsPage;
  readonly items: readonly CashMovementItem[];
  readonly next: string | null;
  readonly loading: boolean;
  readonly failed: boolean;
}

export function AccountMovements({
  accountId,
  online,
  reloadKey,
}: {
  readonly accountId: string;
  readonly online: boolean;
  readonly reloadKey: string;
}) {
  const { t } = useTranslation();
  const path = `/api/v1/cash-accounts/${accountId}/movements?limit=${MOVEMENTS_PAGE}`;
  const read = useOnlineRead<CashMovementsPage>(
    path,
    (key) => readPath<CashMovementsPage>(key),
    online,
    reloadKey,
  );
  const [older, setOlder] = useState<Older | null>(null);
  const first = read.data;
  const extra = older && older.base === first ? older : null;
  const items = [...(first?.movements ?? []), ...(extra?.items ?? [])];
  const next = extra ? extra.next : (first?.next_cursor ?? null);

  const loadMore = async () => {
    if (!first || !next) return;
    const base = first;
    setOlder({ base, items: extra?.items ?? [], next, loading: true, failed: false });
    const result = await readPath<CashMovementsPage>(`${path}&cursor=${encodeURIComponent(next)}`);
    setOlder((current) => {
      if (!current || current.base !== base) return current;
      return result.ok
        ? {
            base,
            items: [...current.items, ...result.data.movements],
            next: result.data.next_cursor,
            loading: false,
            failed: false,
          }
        : { ...current, loading: false, failed: true };
    });
  };

  if (read.failed && !first) {
    return (
      <div className="alert alert-error" role="alert">
        <p>{t('treasury.movements_failed')}</p>
        <button type="button" className="secondary" onClick={read.retry}>
          {t('distribution.retry')}
        </button>
      </div>
    );
  }
  if (!first) {
    return (
      <p className="home-muted" aria-busy="true">
        {t('sales.loading')}
      </p>
    );
  }
  return (
    <div className="sale-block">
      {items.length === 0 ? (
        <p className="home-muted">{t('treasury.movements_empty')}</p>
      ) : (
        <ul className="line-list">
          {items.map((movement) => (
            <li key={movement.id}>
              {t('treasury.movement_line', {
                date: formatDateTime(movement.occurredAt),
                type: t(`treasury.movement_type.${movement.movementType}`, {
                  defaultValue: movement.movementType,
                }),
                amount: `${movement.direction === 'OUT' ? '−' : '+'}${formatMoney(movement.amountXaf)}`,
              })}
              {movement.isReversal ? ` ${t('treasury.reversal')}` : ''}
            </li>
          ))}
        </ul>
      )}
      {extra?.failed ? (
        <p className="alert alert-error" role="alert">
          {t('treasury.movements_failed')}
        </p>
      ) : null}
      {next ? (
        <button
          type="button"
          className="secondary"
          disabled={extra?.loading === true}
          onClick={() => void loadMore()}
        >
          {t('treasury.movements_more')}
        </button>
      ) : null}
    </div>
  );
}
