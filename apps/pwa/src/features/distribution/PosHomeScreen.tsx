/**
 * ECR-DIS-01 « Accueil PDV » (vendeur du PDV ; WF-J2). Hors ligne : caisse du jour (ouverte ou non,
 * jamais l'attendu, comptage à l'aveugle AV-304), stock de l'emplacement de vente (disponible de
 * l'appareil, seuil), quotas de l'utilisateur sur ce téléphone avec leur libération
 * (`inventory.allocation.release`, AV-309), ventes du jour connues du téléphone (AV-308) et accès
 * aux opérations du PDV.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { holdsAnyRole, ROLE_SETS, ROUTES } from '../../app/screens.js';
import { clock } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { useAuth } from '../auth/AuthContext.js';
import { deviceCash, foreignClose, openSession, posCashAccounts } from '../cash/cash-session.js';
import { formatDateTime } from '../home/format-home.js';
import { CommandResult } from '../sales/CommandResult.js';
import { formatMoney, formatQuantity } from '../sales/format.js';
import { recentSales } from '../sales/recent-sales.js';
import { useSalesReferences } from '../sales/references.js';
import { settingValue } from '../sales/stock.js';
import { saveErrorKey, submitCommand } from '../sales/submit.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { stockRows } from '../stock/stock-view.js';
import { canRelease, myQuotas, releasePayload, todaySales } from './pos-home.js';
import { pointsOfSaleOf } from './replenish.js';

export function PosHomeScreen() {
  const { t } = useTranslation();
  const { state, deviceId } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
  const navigation = useRememberedNavigation(userId);
  const online = useOnline();
  const [posChoice, setPosChoice] = useState<string | null>(null);
  const [confirmRelease, setConfirmRelease] = useState<string | null>(null);
  const [released, setReleased] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.pos_home')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const points = pointsOfSaleOf(refs);
  // Par défaut, le PDV dont ce téléphone est l'appareil désigné (BR-DIS-003), sinon le premier.
  const pos =
    points.find((candidate) => candidate.siteId === posChoice) ??
    points.find(
      (candidate) =>
        deviceId !== undefined && candidate.salesLocation.designated_device_id === deviceId,
    ) ??
    points[0];
  if (!pos) {
    return (
      <section className="sale">
        <h1>{t('nav.screens.pos_home')}</h1>
        <p className="home-muted">{t('replenish.no_pos')}</p>
      </section>
    );
  }

  const now = clock.now();
  const location = pos.salesLocation;
  // Caisse du PDV : ouverte ou non, jamais l'attendu (comptage à l'aveugle, AV-304).
  const account = posCashAccounts(refs.cashAccounts).find(
    (candidate) => candidate.site_id === pos.siteId,
  );
  const cash = account
    ? deviceCash({
        cashAccountId: account.id,
        sessions: refs.cashSessions,
        outbox: refs.outbox,
        cashPulledAt: refs.cashPulledAt,
        userId,
        maxSessionsPerDay: settingValue(
          refs.settings,
          'finance.cash_sessions_per_day_max',
          pos.siteId,
          now,
        ),
      })
    : undefined;
  const session = cash ? openSession(cash) : undefined;
  // Clôture saisie par un autre utilisateur de la tablette, pas encore envoyée : la session reste
  // ouverte au serveur jusqu'à son envoi, et l'écran de caisse refuse une ouverture (ADR-052).
  const closingElsewhere = cash && !session ? foreignClose(cash, userId) : undefined;
  // Libération : permission `inventory.allocation.release` du détenteur (CTE, VEN).
  const mayRelease = holdsAnyRole(navigation?.roles ?? [], ROLE_SETS.allocationRelease);
  const sales = todaySales(recentSales(refs), location.id, now);
  const rows = stockRows(refs, location);
  const quotas = myQuotas(refs, { userId, deviceId, now }).filter(
    (quota) => quota.allocation.location_id === location.id,
  );
  const products = new Map(refs.products.map((product) => [product.id, product]));
  // Emplacement partagé : hors ligne, seul le quota de l'utilisateur se vend (BR-STK-013) ; le stock
  // montré est le physique, net des sorties en attente de l'appareil. Emplacement confié à un autre
  // téléphone : physique aussi, aucune vente hors ligne de ce téléphone (`CUSTODY_DEVICE_MISMATCH`).
  const shared =
    location.custody_mode !== 'EXCLUSIVE_USER' && location.custody_mode !== 'EXCLUSIVE_DEVICE';
  const otherDevice =
    location.custody_mode === 'EXCLUSIVE_DEVICE' && location.designated_device_id !== deviceId;

  const release = async (quotaId: string) => {
    const quota = quotas.find((candidate) => candidate.allocation.id === quotaId);
    if (!quota || !canRelease(quota) || !mayRelease || busy) return;
    setBusy(true);
    setSaveError(null);
    try {
      const command = await submitCommand({
        authorUserId: userId,
        commandType: 'inventory.allocation.release',
        aggregateType: 'STOCK_ALLOCATION',
        aggregateId: quota.allocation.id,
        payload: releasePayload(quota),
      });
      setReleased(command.command_id);
      setConfirmRelease(null);
    } catch (error) {
      setSaveError(saveErrorKey(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="sale">
      <h1>{t('nav.screens.pos_home')}</h1>
      {points.length > 1 ? (
        <div className="field">
          <label htmlFor="pos-home-site">{t('replenish.pos_label')}</label>
          <select
            id="pos-home-site"
            className="text-input"
            value={pos.siteId}
            onChange={(event) => setPosChoice(event.target.value)}
          >
            {points.map((candidate) => (
              <option key={candidate.siteId} value={candidate.siteId}>
                {candidate.salesLocation.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="picked-title">{location.name}</p>
      )}
      {!online ? (
        <p className="home-banner" role="status">
          {t('pos_home.offline_banner')}
        </p>
      ) : null}

      <section className="sale-block" aria-labelledby="pos-home-cash-title">
        <h2 id="pos-home-cash-title">{t('pos_home.cash_title')}</h2>
        {!account ? (
          <p className="home-muted">{t('pos_home.cash_unknown')}</p>
        ) : closingElsewhere ? (
          <p className="home-muted">{t('pos_home.cash_closing_elsewhere')}</p>
        ) : session ? (
          <p>
            {t('pos_home.cash_open', {
              date: formatDateTime(session.openedAt),
              who: t(session.openedBy === userId ? 'cash.opened_by_you' : 'cash.opened_by_other'),
            })}
          </p>
        ) : (
          <p className="text-warn">{t('pos_home.cash_closed')}</p>
        )}
        {closingElsewhere ? null : (
          <Link to={ROUTES.cash} className="action action-compact">
            <span className="action-label">
              {t(session ? 'pos_home.close_cash' : 'pos_home.open_cash')}
            </span>
          </Link>
        )}
      </section>

      <section className="sale-block" aria-labelledby="pos-home-sales-title">
        <h2 id="pos-home-sales-title">{t('pos_home.sales_title')}</h2>
        <p>
          {t('pos_home.sales_line', {
            count: sales.count,
            net: formatMoney(sales.netXaf),
            paid: formatMoney(sales.paidXaf),
          })}
        </p>
        {sales.pendingCount > 0 ? (
          <p className="home-muted">{t('pos_home.sales_pending', { count: sales.pendingCount })}</p>
        ) : null}
        <p className="home-muted">{t('pos_home.sales_hint')}</p>
      </section>

      <section className="sale-block" aria-labelledby="pos-home-quota-title">
        <h2 id="pos-home-quota-title">{t('pos_home.quota_title')}</h2>
        {released ? (
          <CommandResult commandId={released} messages="pos_home.release_result" />
        ) : null}
        {saveError ? (
          <p className="alert alert-error" role="alert">
            {t(saveError)}
          </p>
        ) : null}
        {quotas.length === 0 ? (
          <p className="home-muted">{t('pos_home.quota_empty')}</p>
        ) : (
          <ul className="line-list">
            {quotas.map((quota) => {
              const product = products.get(quota.allocation.product_id);
              const unit = product?.base_unit_code ?? '';
              const name = product?.name ?? '';
              const remaining = formatQuantity(Math.max(0, quota.remaining));
              const armed = confirmRelease === quota.allocation.id;
              return (
                <li key={quota.allocation.id} className="line-card" aria-label={name}>
                  <p>
                    <strong>{name}</strong>
                  </p>
                  <p>
                    {t(quota.validUntil ? 'pos_home.quota_line_until' : 'pos_home.quota_line', {
                      remaining,
                      unit,
                      until: quota.validUntil ? formatDateTime(quota.validUntil.toISOString()) : '',
                    })}
                  </p>
                  {quota.revocationPending ? (
                    <p className="text-warn">{t('pos_home.quota_revoking')}</p>
                  ) : quota.releasing ? (
                    <p className="home-muted">{t('pos_home.quota_releasing')}</p>
                  ) : quota.expired ? (
                    <p className="text-warn">{t('pos_home.quota_expired')}</p>
                  ) : null}
                  {mayRelease && canRelease(quota) ? (
                    <>
                      {/* Le bouton qui arme reste en place, inactif : un double toucher ne confirme
                          pas d'office ; la confirmation est un autre bouton, avec « Annuler ». */}
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy || armed}
                        onClick={() => setConfirmRelease(quota.allocation.id)}
                      >
                        {t('pos_home.release', { name })}
                      </button>
                      {armed ? (
                        <div className="result-actions">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void release(quota.allocation.id)}
                          >
                            {t('pos_home.release_confirm', { remaining, unit })}
                          </button>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => setConfirmRelease(null)}
                          >
                            {t('pos_home.release_cancel')}
                          </button>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="sale-block" aria-labelledby="pos-home-stock-title">
        <h2 id="pos-home-stock-title">{t('pos_home.stock_title')}</h2>
        {rows.length === 0 ? (
          <p className="home-muted">{t('pos_home.stock_empty')}</p>
        ) : (
          <ul className="line-list">
            {rows.map((row) => (
              <li key={row.product.id} className="line-card" aria-label={row.product.name}>
                <p>
                  <strong>{row.product.name}</strong>
                  {row.threshold && row.threshold.state !== 'OK' ? (
                    <span className="badge badge-warn">
                      {' '}
                      {t(`replenish.state.${row.threshold.state}`)}
                    </span>
                  ) : null}
                </p>
                <p className="home-muted">
                  {otherDevice
                    ? t('pos_home.stock_line_other_device', {
                        physical: formatQuantity(
                          Math.round((row.onHand - row.pending) * 1000) / 1000,
                        ),
                        unit: row.product.base_unit_code,
                      })
                    : shared
                      ? t('pos_home.stock_line_shared', {
                          physical: formatQuantity(
                            Math.round((row.onHand - row.pending) * 1000) / 1000,
                          ),
                          unit: row.product.base_unit_code,
                        })
                      : t('pos_home.stock_line', {
                          available: formatQuantity(row.available),
                          unit: row.product.base_unit_code,
                        })}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <nav className="result-actions" aria-label={t('pos_home.actions_title')}>
        <Link to={ROUTES.newSale} className="action action-compact">
          <span className="action-label">{t('nav.screens.new_sale')}</span>
        </Link>
        <Link to={ROUTES.loss} className="action action-compact">
          <span className="action-label">{t('nav.screens.loss')}</span>
        </Link>
        <Link to={ROUTES.receive} className="action action-compact">
          <span className="action-label">{t('nav.screens.receive')}</span>
        </Link>
        <Link to={ROUTES.replenish} className="action action-compact">
          <span className="action-label">{t('nav.screens.replenish')}</span>
        </Link>
        <Link to={ROUTES.cashTransfers} className="action action-compact">
          <span className="action-label">{t('nav.screens.cash_transfers')}</span>
        </Link>
        {online ? (
          <Link to={ROUTES.distribution} className="action action-compact">
            <span className="action-label">{t('nav.screens.distribution')}</span>
          </Link>
        ) : null}
      </nav>
    </section>
  );
}
