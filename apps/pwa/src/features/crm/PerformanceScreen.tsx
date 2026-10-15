/**
 * ECR-CRM-05 « Mes objectifs et performances » (commerciaux ; WF-J1, étapes 3 et 8). En ligne :
 * effort et objectifs avec leur réalisé, calculés par le serveur. Hors ligne, ou serveur sans réponse
 * (annoncé comme tel, avec « Réessayer ») : estimation de l'appareil pour les visites, comptes visités,
 * échanges et prospects créés ; le chiffre d'affaires, les quantités vendues et les nouveaux clients
 * se lisent en ligne.
 */
import { Fragment, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { businessDayOf } from '@gic/domain';
import { clock } from '../../platform/composition.js';
import { useOnline } from '../../platform/useOnline.js';
import { getDb } from '../../storage/db.js';
import { authorizedRequest } from '../../sync/api-client.js';
import { useAuth } from '../auth/AuthContext.js';
import { formatBusinessDay } from '../home/format-home.js';
import { formatMoney, formatQuantity, formatQuantityUnit } from '../sales/format.js';
import { useSalesReferences } from '../sales/references.js';
import {
  attainment,
  localEffort,
  localTargets,
  periodOf,
  type Effort,
  type Period,
  type PeriodKind,
  type ServerPerformance,
  type TargetView,
} from './performance.js';

const PERIODS: readonly PeriodKind[] = ['MONTH', 'TODAY'];
const EFFORT_KEYS: readonly (keyof Effort)[] = [
  'visits',
  'customersVisited',
  'interactions',
  'prospectsCreated',
  'newCustomers',
];

type ServerState =
  | { readonly status: 'OFFLINE' }
  | { readonly status: 'LOADING' }
  | { readonly status: 'ERROR' }
  | { readonly status: 'OK'; readonly data: ServerPerformance };

/** Performance lue en ligne pour la période, et relance de la lecture après une erreur du serveur. */
function useServerPerformance(
  period: Period,
  online: boolean,
): { readonly server: ServerState; readonly retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; data: ServerPerformance | null }>();
  const key = `${period.from}:${period.to}:${attempt}`;
  useEffect(() => {
    if (!online) return;
    let cancelled = false;
    void authorizedRequest<ServerPerformance>(
      getDb(),
      `/api/v1/performance/commercial?from=${period.from}&to=${period.to}`,
      { method: 'GET' },
    ).then((result) => {
      if (!cancelled) setState({ key, data: result.ok ? result.data : null });
    });
    return () => {
      cancelled = true;
    };
  }, [key, online, period.from, period.to]);
  const retry = () => setAttempt((current) => current + 1);
  if (!online) return { server: { status: 'OFFLINE' }, retry };
  if (state?.key !== key) return { server: { status: 'LOADING' }, retry };
  return {
    server: state.data ? { status: 'OK', data: state.data } : { status: 'ERROR' },
    retry,
  };
}

export function PerformanceScreen() {
  const { t } = useTranslation();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const refs = useSalesReferences();
  const online = useOnline();
  const [kind, setKind] = useState<PeriodKind>('MONTH');
  const today = businessDayOf(clock.now());
  const period = periodOf(kind, today);
  const { server: serverState, retry } = useServerPerformance(period, online);
  const server = serverState.status === 'OK' ? serverState.data : null;

  if (!refs || !userId) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.performance')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const estimate = localEffort(refs, userId, period);
  const effort: Effort = server ? server.effort : estimate;
  const targets: readonly TargetView[] = server
    ? server.targets
    : localTargets(refs.targets, userId, period, estimate);
  const products = new Map(refs.products.map((product) => [product.id, product]));
  const valueOf = (metric: string, value: number, productId: string | null): string => {
    if (metric === 'CA') return formatMoney(value);
    if (metric === 'QTE_PRODUIT') {
      const unit = productId ? (products.get(productId)?.base_unit_code ?? '') : '';
      return formatQuantityUnit(value, unit, refs.units);
    }
    return formatQuantity(value);
  };

  return (
    <section className="sale">
      <h1>{t('nav.screens.performance')}</h1>
      <fieldset className="choice-group">
        <legend>{t('performance.period_label')}</legend>
        {PERIODS.map((value) => (
          <label key={value} className="choice">
            <input
              type="radio"
              name="performance-period"
              value={value}
              checked={kind === value}
              onChange={() => setKind(value)}
            />
            {t(`performance.period.${value}`)}
          </label>
        ))}
      </fieldset>
      <p className="home-muted" role="status">
        {server
          ? t('performance.source_server', {
              from: formatBusinessDay(period.from),
              to: formatBusinessDay(period.to),
            })
          : serverState.status === 'LOADING'
            ? t('performance.loading')
            : serverState.status === 'ERROR'
              ? t('performance.source_error')
              : t('performance.source_device')}
      </p>
      {serverState.status === 'ERROR' ? (
        <button type="button" className="secondary" onClick={retry}>
          {t('performance.retry')}
        </button>
      ) : null}

      <section className="sale-block" aria-labelledby="performance-effort-title">
        <h2 id="performance-effort-title">{t('performance.effort_title')}</h2>
        <dl className="receipt-totals">
          {EFFORT_KEYS.map((key) => {
            const value = effort[key];
            return (
              <Fragment key={key}>
                <dt>{t(`performance.effort.${key}`)}</dt>
                <dd>{value === null ? t('performance.online_only') : formatQuantity(value)}</dd>
              </Fragment>
            );
          })}
        </dl>
      </section>

      <section className="sale-block" aria-labelledby="performance-targets-title">
        <h2 id="performance-targets-title">{t('performance.targets_title')}</h2>
        {targets.length === 0 ? (
          <p className="home-muted">{t('performance.no_target')}</p>
        ) : (
          <ul className="receipt-lines">
            {targets.map((target) => {
              const rate = attainment(target);
              const product = target.productId ? products.get(target.productId) : undefined;
              return (
                <li key={target.id}>
                  <span>
                    <strong>
                      {t(`performance.metric.${target.metric}`, { defaultValue: target.metric })}
                      {product ? ` · ${product.name}` : ''}
                    </strong>
                    <small>
                      {t('performance.target_period', {
                        from: formatBusinessDay(target.periodStart),
                        to: formatBusinessDay(target.periodEnd),
                      })}
                    </small>
                  </span>
                  <span>
                    {target.realized === null
                      ? t('performance.realized_online', {
                          target: valueOf(target.metric, target.targetValue, target.productId),
                        })
                      : t('performance.realized', {
                          realized: valueOf(target.metric, target.realized, target.productId),
                          target: valueOf(target.metric, target.targetValue, target.productId),
                        })}
                    {rate !== null ? <small>{t('performance.rate', { rate })}</small> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </section>
  );
}
