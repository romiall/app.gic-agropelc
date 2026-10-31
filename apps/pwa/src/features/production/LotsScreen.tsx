/**
 * ECR-PRD-01 « Lots actifs » (responsable de production, responsable de ferme) : lots de la ferme
 * (jeu `production`) avec type, âge, effectif en élevage et saisies du jour ; chaque lot actif ouvre sa
 * saisie du jour (ECR-PRD-02). Utilisable hors ligne. Les indicateurs (taux de mortalité, gain moyen,
 * indice de consommation) se lisent en ligne.
 */
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { businessDayOf } from '@gic/domain';
import {
  Badge,
  DataCell,
  DataList,
  EmptyState,
  Icon,
  List,
  ListRow,
  PageHeader,
  Section,
  SkeletonRows,
} from '../../components/ui/index.js';
import { ROUTES } from '../../app/screens.js';
import { clock } from '../../platform/composition.js';
import { formatQuantityUnit } from '../sales/format.js';
import { useSalesReferences } from '../sales/references.js';
import { ageDays, lotsOfDevice, rearingHeadcount, todayJournal } from './daily.js';
import './production.css';

export function LotsScreen() {
  const { t } = useTranslation();
  const refs = useSalesReferences();

  if (!refs) {
    return (
      <section className="sale" aria-busy="true">
        <PageHeader title={t('nav.screens.production_lots')} />
        <SkeletonRows />
      </section>
    );
  }

  const today = businessDayOf(clock.now());
  const { daily, planned } = lotsOfDevice(refs.productionLots);
  const sites = refs.sites;

  return (
    <section className="sale">
      <PageHeader title={t('nav.screens.production_lots')} />
      {daily.length === 0 ? (
        <EmptyState icon="leaf" title={t('production.no_lot')} />
      ) : (
        <DataList
          aria-label={t('nav.screens.production_lots')}
          template="minmax(0, 2fr) minmax(0, 0.8fr) minmax(0, 1fr) minmax(0, 2.8fr) minmax(0, 0.9fr)"
          columns={[
            { label: t('production.col.lot') },
            { label: t('production.col.age') },
            { label: t('production.col.heads'), numeric: true },
            { label: t('production.col.today') },
            { label: t('production.col.status') },
          ]}
        >
          {daily.map((lot) => {
            const heads = rearingHeadcount(refs, lot);
            const age = ageDays(lot, today);
            const journal = todayJournal(refs, lot.id, today);
            const deaths = journal
              .filter((entry) => entry.kind === 'MORTALITY')
              .reduce((sum, entry) => sum + Number(entry.values.quantity ?? 0), 0);
            // Toute la ligne est le lien : le nom accessible porte le code, l'effectif et l'âge.
            return (
              <li key={lot.id}>
                <Link to={ROUTES.dailyEntry(lot.id)} className="data-row prd-link-row">
                  <DataCell primary>
                    <strong>{lot.lot_code}</strong>
                    <span className="prd-sub">
                      {[
                        t(`production.lot_type.${lot.lot_type}`, { defaultValue: lot.lot_type }),
                        sites.get(lot.site_id)?.name,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </DataCell>
                  <DataCell>{age !== null ? t('production.age', { count: age }) : '—'}</DataCell>
                  <DataCell numeric>
                    <span className="prd-heads">
                      {heads === null
                        ? t('production.headcount_unknown')
                        : t('production.headcount', { heads: formatQuantityUnit(heads, 'TETE') })}
                    </span>
                  </DataCell>
                  <DataCell>
                    {t('production.today_summary', {
                      deaths,
                      entries: journal.length,
                    })}
                  </DataCell>
                  <DataCell>
                    {lot.status === 'SELLING' ? (
                      <Badge tone="info">{t('production.status.SELLING')}</Badge>
                    ) : (
                      <Badge tone="ok">{t('production.status.ACTIVE')}</Badge>
                    )}
                  </DataCell>
                  <Icon name="chevron-right" size={18} className="prd-chev" />
                </Link>
              </li>
            );
          })}
        </DataList>
      )}
      {planned.length > 0 ? (
        <Section title={t('production.planned_title')} className="prd-after">
          <List>
            {planned.map((lot) => (
              <ListRow
                key={lot.id}
                title={lot.lot_code}
                subtitle={t(`production.lot_type.${lot.lot_type}`, { defaultValue: lot.lot_type })}
                badge={<Badge tone="muted">{t('production.status.PLANNED')}</Badge>}
              />
            ))}
          </List>
        </Section>
      ) : null}
    </section>
  );
}
