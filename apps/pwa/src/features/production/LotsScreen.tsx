/**
 * ECR-PRD-01 « Lots actifs » (responsable de production, responsable de ferme) : lots de la ferme
 * (jeu `production`) avec type, âge, effectif en élevage et saisies du jour ; chaque lot actif ouvre sa
 * saisie du jour (ECR-PRD-02). Utilisable hors ligne. Les indicateurs (taux de mortalité, gain moyen,
 * indice de consommation) se lisent en ligne.
 */
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { businessDayOf } from '@gic/domain';
import { ROUTES } from '../../app/screens.js';
import { clock } from '../../platform/composition.js';
import { formatQuantityUnit } from '../sales/format.js';
import { useSalesReferences } from '../sales/references.js';
import { ageDays, lotsOfDevice, rearingHeadcount, todayJournal } from './daily.js';

export function LotsScreen() {
  const { t } = useTranslation();
  const refs = useSalesReferences();

  if (!refs) {
    return (
      <section className="sale" aria-busy="true">
        <h1>{t('nav.screens.production_lots')}</h1>
        <p className="home-muted">{t('sales.loading')}</p>
      </section>
    );
  }

  const today = businessDayOf(clock.now());
  const { daily, planned } = lotsOfDevice(refs.productionLots);
  const sites = refs.sites;

  return (
    <section className="sale">
      <h1>{t('nav.screens.production_lots')}</h1>
      {daily.length === 0 ? (
        <p className="home-muted">{t('production.no_lot')}</p>
      ) : (
        <ul className="doc-list">
          {daily.map((lot) => {
            const heads = rearingHeadcount(refs, lot);
            const age = ageDays(lot, today);
            const journal = todayJournal(refs, lot.id, today);
            const deaths = journal
              .filter((entry) => entry.kind === 'MORTALITY')
              .reduce((sum, entry) => sum + Number(entry.values.quantity ?? 0), 0);
            return (
              <li key={lot.id}>
                <Link to={ROUTES.dailyEntry(lot.id)} className="doc-row">
                  <span className="doc-main">
                    <strong>{lot.lot_code}</strong>
                    <small>
                      {[
                        t(`production.lot_type.${lot.lot_type}`, { defaultValue: lot.lot_type }),
                        sites.get(lot.site_id)?.name,
                        age !== null ? t('production.age', { count: age }) : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </small>
                    <small>
                      {t('production.today_summary', {
                        deaths,
                        entries: journal.length,
                      })}
                    </small>
                  </span>
                  <span className="doc-side">
                    <strong>
                      {heads === null
                        ? t('production.headcount_unknown')
                        : t('production.headcount', { heads: formatQuantityUnit(heads, 'TETE') })}
                    </strong>
                    {lot.status === 'SELLING' ? (
                      <span className="badge badge-info">{t('production.status.SELLING')}</span>
                    ) : null}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {planned.length > 0 ? (
        <section className="sale-block" aria-labelledby="production-planned-title">
          <h2 id="production-planned-title">{t('production.planned_title')}</h2>
          <ul className="receipt-lines">
            {planned.map((lot) => (
              <li key={lot.id}>
                <span>
                  <strong>{lot.lot_code}</strong>
                  <small>
                    {t(`production.lot_type.${lot.lot_type}`, { defaultValue: lot.lot_type })}
                  </small>
                </span>
                <span>{t('production.status.PLANNED')}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
