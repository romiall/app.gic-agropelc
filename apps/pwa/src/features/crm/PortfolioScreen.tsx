/**
 * ECR-CRM-01 « Mon portefeuille » (commerciaux, responsable commercial) : comptes de l'appareil
 * (jeu `customers`, périmètre du rôle), recherche par nom ou téléphone, filtre par stade, prochaine
 * action prévue en tête (visites et interactions des 90 derniers jours). Utilisable hors ligne.
 */
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { businessDayOf } from '@gic/domain';
import { ROUTES } from '../../app/screens.js';
import { clock } from '../../platform/composition.js';
import { formatBusinessDay, formatMoment } from '../home/format-home.js';
import { formatMoney } from '../sales/format.js';
import { useSalesReferences } from '../sales/references.js';
import { portfolioRows, type StageFilter } from './portfolio.js';

const STAGES: readonly StageFilter[] = ['ALL', 'PROSPECT', 'CUSTOMER', 'LOST'];

export function PortfolioScreen() {
  const { t } = useTranslation();
  const refs = useSalesReferences();
  const [stage, setStage] = useState<StageFilter>('ALL');
  const [query, setQuery] = useState('');
  const searchId = useId();

  if (!refs) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.portfolio')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const today = businessDayOf(clock.now());
  const rows = portfolioRows(refs, { stage, query });

  return (
    <section className="sale">
      <div className="screen-head">
        <h1>{t('nav.screens.portfolio')}</h1>
        <Link to={ROUTES.newProspect} className="action action-primary action-compact">
          <span className="action-label">{t('nav.screens.new_prospect')}</span>
        </Link>
      </div>
      <div className="field">
        <label htmlFor={searchId} className="visually-hidden">
          {t('sales.customer_search')}
        </label>
        <input
          id={searchId}
          type="search"
          className="text-input"
          placeholder={t('sales.customer_search')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="portfolio-stage">{t('portfolio.stage_label')}</label>
        <select
          id="portfolio-stage"
          className="text-input"
          value={stage}
          onChange={(event) => setStage(event.target.value as StageFilter)}
        >
          {STAGES.map((value) => (
            <option key={value} value={value}>
              {t(`portfolio.stage_filter.${value}`)}
            </option>
          ))}
        </select>
      </div>
      {rows.length === 0 ? (
        <p className="home-muted">{t('portfolio.empty')}</p>
      ) : (
        <ul className="doc-list">
          {rows.map(({ customer, lastActivityAt, nextActionAt, nextActionNote }) => (
            <li key={customer.id}>
              <Link
                to={ROUTES.customer(customer.id)}
                className="doc-row"
                aria-label={t('portfolio.open', { name: customer.display_name })}
              >
                <span className="doc-main">
                  <strong>{customer.display_name}</strong>
                  <small>
                    {[
                      customer.phone_primary,
                      lastActivityAt
                        ? t('portfolio.last_activity', {
                            when: formatMoment(lastActivityAt, today),
                          })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </small>
                  {nextActionAt ? (
                    <small className={nextActionAt <= today ? 'text-warn' : undefined}>
                      {t('portfolio.next_action', {
                        date: formatBusinessDay(nextActionAt),
                        note: nextActionNote ?? '',
                      })}
                    </small>
                  ) : null}
                </span>
                <span className="doc-side">
                  <span className="badge badge-info">
                    {t(`portfolio.stage.${customer.stage}`, { defaultValue: customer.stage })}
                  </span>
                  {customer.pending_command_id ? (
                    <span className="badge badge-warn">{t('portfolio.pending')}</span>
                  ) : null}
                  {customer.outstanding_xaf > 0 ? (
                    <small>{formatMoney(customer.outstanding_xaf)}</small>
                  ) : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
