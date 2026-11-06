/**
 * ECR-PRD-01 « Lots actifs » (responsable de production, responsable de ferme, administrateur) : lots de la
 * ferme (jeu `production`) avec type, âge, effectif en élevage et saisies du jour ; chaque lot actif ouvre sa
 * saisie du jour (ECR-PRD-02). Utilisable hors ligne. Les indicateurs (taux de mortalité, gain moyen,
 * indice de consommation) se lisent en ligne, sur la fiche du lot (ECR-PRD-03).
 *
 * AV-526 : l'écran dit quoi faire ensuite. « Nouveau lot » en tête pour ceux qui créent les lots ; un lot
 * planifié ouvre l'entrée des animaux ; l'état vide explique la chaîne (créer le lot, y faire entrer les
 * animaux, saisir la journée) et propose l'étape suivante ; des raccourcis mènent aux écrans voisins
 * (collecte d'œufs, incubations, sortie vers la vente, fiche d'un lot) selon les droits de chacun.
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
  LinkButton,
  List,
  ListRow,
  PageHeader,
  Section,
  SkeletonRows,
} from '../../components/ui/index.js';
import { holdsAnyRole, ROLE_SETS, ROUTES } from '../../app/screens.js';
import { clock } from '../../platform/composition.js';
import { useAuth } from '../auth/AuthContext.js';
import { useRememberedNavigation } from '../navigation/navigation-store.js';
import { formatQuantityUnit } from '../sales/format.js';
import { useSalesReferences } from '../sales/references.js';
import { ageDays, lotsOfDevice, rearingHeadcount, todayJournal } from './daily.js';
import './production.css';

export function LotsScreen() {
  const { t } = useTranslation();
  const refs = useSalesReferences();
  const { state } = useAuth();
  const userId = state.status === 'unlocked' ? state.userId : undefined;
  const navigation = useRememberedNavigation(userId);

  if (!refs) {
    return (
      <section className="sale" aria-busy="true">
        <PageHeader title={t('nav.screens.production_lots')} />
        <SkeletonRows />
      </section>
    );
  }

  // Rôles encore en lecture : rien n'est proposé ; rôles inconnus de l'appareil : proposé (le serveur revérifie).
  const roles = navigation ? navigation.roles : [];
  const known = navigation !== undefined;
  const mayCreate = known && holdsAnyRole(roles, ROLE_SETS.lotSetup);
  const mayReceive = known && holdsAnyRole(roles, ROLE_SETS.purchaseReceipt);
  const today = businessDayOf(clock.now());
  const { daily, planned } = lotsOfDevice(refs.productionLots);
  const sites = refs.sites;
  const shortcuts = [
    {
      show: known && holdsAnyRole(roles, ROLE_SETS.production),
      to: ROUTES.eggCollection,
      icon: 'leaf',
      key: 'eggs',
    },
    {
      show: known && holdsAnyRole(roles, ROLE_SETS.incubation),
      to: ROUTES.incubation,
      icon: 'leaf',
      key: 'incubation',
    },
    {
      show: known && holdsAnyRole(roles, ROLE_SETS.productionOutput),
      to: ROUTES.productionOutput,
      icon: 'truck',
      key: 'output',
    },
    {
      show: known && holdsAnyRole(roles, ROLE_SETS.lotSheet),
      to: ROUTES.lotSheet,
      icon: 'file',
      key: 'sheet',
    },
  ] as const;

  return (
    <section className="sale">
      <PageHeader
        title={t('nav.screens.production_lots')}
        {...(mayCreate
          ? {
              actions: (
                <LinkButton to={ROUTES.lotSetup} icon="plus" size="sm">
                  {t('production.new_lot')}
                </LinkButton>
              ),
            }
          : {})}
      />
      {shortcuts.some((shortcut) => shortcut.show) ? (
        <div className="chip-row prd-wrap">
          {shortcuts
            .filter((shortcut) => shortcut.show)
            .map((shortcut) => (
              <LinkButton
                key={shortcut.key}
                to={shortcut.to}
                variant="tonal"
                size="sm"
                icon={shortcut.icon}
              >
                {t(`production.shortcut.${shortcut.key}`)}
              </LinkButton>
            ))}
        </div>
      ) : null}
      {daily.length === 0 ? (
        <EmptyState
          icon="leaf"
          title={t('production.no_lot')}
          action={
            mayCreate ? (
              <LinkButton to={ROUTES.lotSetup} icon="plus" variant="tonal">
                {planned.length > 0 ? t('production.enter_animals') : t('production.new_lot')}
              </LinkButton>
            ) : undefined
          }
        >
          {t(mayCreate ? 'production.no_lot_howto' : 'production.no_lot_ask')}
        </EmptyState>
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
          <p className="prd-note">
            {t(mayCreate ? 'production.planned_hint' : 'production.planned_hint_readonly')}
          </p>
          <List>
            {planned.map((lot) => (
              <ListRow
                key={lot.id}
                title={lot.lot_code}
                subtitle={[
                  t(`production.lot_type.${lot.lot_type}`, { defaultValue: lot.lot_type }),
                  sites.get(lot.site_id)?.name,
                  mayCreate ? t('production.enter_animals') : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                badge={<Badge tone="muted">{t('production.status.PLANNED')}</Badge>}
                {...(mayCreate ? { to: ROUTES.lotEntryFor(lot.id) } : {})}
              />
            ))}
          </List>
          {mayReceive ? (
            <p className="prd-note">
              <Link to={ROUTES.purchaseReceiptFree}>{t('production.receive_animals')}</Link>
            </p>
          ) : null}
        </Section>
      ) : null}
    </section>
  );
}
