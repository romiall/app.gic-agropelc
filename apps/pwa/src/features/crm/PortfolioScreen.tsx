/**
 * ECR-CRM-01 « Mon portefeuille » (commerciaux, responsable commercial) : comptes de l'appareil
 * (jeu `customers`, périmètre du rôle), recherche par nom ou téléphone, filtre par stade, prochaine
 * action prévue en tête (visites et interactions des 90 derniers jours). Utilisable hors ligne.
 * Cartes sur téléphone, colonnes alignées sur ordinateur (liste en colonnes, lignes cliquables).
 */
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { businessDayOf } from '@gic/domain';
import {
  Avatar,
  Badge,
  DataCell,
  DataList,
  EmptyState,
  Icon,
  LinkButton,
  PageHeader,
  Segmented,
  SkeletonRows,
} from '../../components/ui/index.js';
import { ROUTES } from '../../app/screens.js';
import { clock } from '../../platform/composition.js';
import { formatBusinessDay, formatMoment } from '../home/format-home.js';
import { formatMoney } from '../sales/format.js';
import { useSalesReferences } from '../sales/references.js';
import { portfolioRows, type StageFilter } from './portfolio.js';
import { stageTone } from './stage.js';
import './crm.css';

const STAGES: readonly StageFilter[] = ['ALL', 'PROSPECT', 'CUSTOMER', 'LOST'];

export function PortfolioScreen() {
  const { t } = useTranslation();
  const refs = useSalesReferences();
  const [stage, setStage] = useState<StageFilter>('ALL');
  const [query, setQuery] = useState('');
  const searchId = useId();

  if (!refs) {
    return (
      <section className="sale crm-screen" aria-busy="true">
        <PageHeader title={t('nav.screens.portfolio')} />
        <SkeletonRows rows={4} />
      </section>
    );
  }

  const today = businessDayOf(clock.now());
  const rows = portfolioRows(refs, { stage, query });

  return (
    <section className="sale crm-screen">
      <PageHeader
        title={t('nav.screens.portfolio')}
        actions={<LinkButton to={ROUTES.newProspect}>{t('nav.screens.new_prospect')}</LinkButton>}
      />
      <div className="filter-bar">
        <div className="field">
          <label htmlFor={searchId} className="visually-hidden">
            {t('sales.customer_search')}
          </label>
          <div className="crm-search">
            <Icon name="search" size={18} />
            <input
              id={searchId}
              type="search"
              className="input"
              placeholder={t('sales.customer_search')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>
        <Segmented
          label={t('portfolio.stage_label')}
          value={stage}
          onChange={setStage}
          options={STAGES.map((value) => ({
            value,
            label:
              value === 'ALL'
                ? t('portfolio.stage_all_short')
                : t(`portfolio.stage_filter.${value}`),
          }))}
        />
      </div>
      {rows.length === 0 ? (
        <EmptyState icon="users" title={t('portfolio.empty')} />
      ) : (
        <DataList
          aria-label={t('nav.screens.portfolio')}
          columns={[
            { label: t('portfolio.col.customer') },
            { label: t('portfolio.col.stage') },
            { label: t('portfolio.col.next_action') },
            { label: t('portfolio.col.outstanding'), numeric: true },
          ]}
          template="minmax(0, 2.4fr) 9rem minmax(0, 2.4fr) 9rem"
        >
          {rows.map(
            ({ customer, lastActivityAt, nextActionAt, nextActionNote, outstandingXaf }) => {
              const detail = [
                customer.phone_primary,
                lastActivityAt
                  ? t('portfolio.last_activity', { when: formatMoment(lastActivityAt, today) })
                  : null,
              ]
                .filter(Boolean)
                .join(' · ');
              return (
                <li key={customer.id}>
                  <Link to={ROUTES.customer(customer.id)} className="data-row crm-row">
                    <DataCell primary>
                      <span className="crm-who">
                        <Avatar name={customer.display_name} />
                        <span className="crm-who-text">
                          <strong>{customer.display_name}</strong>
                          {detail ? <small>{detail}</small> : null}
                        </span>
                      </span>
                    </DataCell>
                    <DataCell>
                      <span className="crm-badges">
                        <Badge tone={stageTone(customer.stage)}>
                          {t(`portfolio.stage.${customer.stage}`, { defaultValue: customer.stage })}
                        </Badge>
                        {customer.pending_command_id ? (
                          <Badge tone="warn">{t('portfolio.pending')}</Badge>
                        ) : null}
                      </span>
                    </DataCell>
                    <DataCell>
                      {nextActionAt ? (
                        <span className={nextActionAt <= today ? 'crm-next is-due' : 'crm-next'}>
                          <span>
                            {t('portfolio.next_action', {
                              date: formatBusinessDay(nextActionAt),
                              note: nextActionNote ?? '',
                            })}
                          </span>
                          {nextActionAt < today ? (
                            <Badge tone="bad">{t('portfolio.overdue')}</Badge>
                          ) : null}
                        </span>
                      ) : null}
                    </DataCell>
                    <DataCell numeric>
                      {outstandingXaf > 0 ? (
                        <span className="crm-money">
                          <span className="crm-lead">{t('customer.outstanding')}</span>{' '}
                          {formatMoney(outstandingXaf)}
                        </span>
                      ) : null}
                    </DataCell>
                  </Link>
                </li>
              );
            },
          )}
        </DataList>
      )}
    </section>
  );
}
