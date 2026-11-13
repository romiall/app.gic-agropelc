/** Aide des tableaux de bord et de l'explorateur (AV-525). Lecture seule : ils décrivent, ils n'écrivent rien. */
import { ROUTES } from '../../../app/screens.js';
import type { ScreenHelp } from '../help-types.js';
import { act, go } from './helpers.js';

const dashboard = (
  path: string,
  title: string,
  purpose: string,
  offline: boolean,
  next: ScreenHelp['next'] = [],
): ScreenHelp => ({
  path,
  title,
  purpose,
  actions: [
    act(
      'read',
      'Lire les indicateurs',
      `Choisissez la période ; chaque indicateur peut mener aux opérations qui l’expliquent.${
        offline ? ' Hors ligne, le dernier instantané reste affiché.' : ' En ligne seulement.'
      }`,
      { online: !offline },
    ),
    act(
      'go',
      'Ouvrir l’explorateur',
      'Pour descendre d’un indicateur jusqu’aux opérations sources (selon vos droits).',
      {
        to: ROUTES.analyticsExplorer,
      },
    ),
  ],
  next,
});

export const PILOTAGE_HELP: readonly ScreenHelp[] = [
  dashboard(
    ROUTES.analyticsDirection,
    'Tour de contrôle',
    'La vue d’ensemble de la Direction : production, stock, distribution, ventes, finances, équipes et alertes, lisible en moins de 30 secondes.',
    true,
    [go('Validations', ROUTES.approvals, 'décider ce qui attend la Direction')],
  ),
  dashboard(
    ROUTES.analyticsCommercial,
    'Tableau commercial',
    'Les ventes, les visites, les objectifs et le portefeuille de votre périmètre commercial.',
    true,
  ),
  dashboard(
    ROUTES.analyticsStock,
    'Tableau du stock',
    'Les soldes, les alertes de seuil, les pertes et les mouvements du stock de votre périmètre.',
    true,
    [go('Stock', ROUTES.stock, 'le détail des soldes par emplacement')],
  ),
  dashboard(
    ROUTES.analyticsProduction,
    'Tableau de la production',
    'Les effectifs, la mortalité, les performances des lots et la ponte de votre périmètre.',
    true,
    [go('Lots de production', ROUTES.productionLots, 'agir sur un lot')],
  ),
  dashboard(
    ROUTES.analyticsFinance,
    'Tableau finance et trésorerie',
    'Le chiffre d’affaires, l’encaissé, les créances, les dettes et la trésorerie.',
    false,
  ),
  {
    path: ROUTES.analyticsExplorer,
    title: 'Explorateur',
    purpose:
      'Interroger les jeux de données du catalogue analytique : filtrer, trier, grouper, agréger, descendre jusqu’au document source, enregistrer et partager des vues, demander des exports. En ligne.',
    actions: [
      act(
        'read',
        'Explorer un jeu de données',
        'Choisissez le jeu, les colonnes, les filtres et le regroupement.',
        { online: true },
      ),
      act(
        'create',
        'Enregistrer une vue',
        'Garde vos réglages ; partageable à une équipe selon vos droits.',
        { online: true },
      ),
      act('export', 'Exporter en CSV ou XLSX', 'Chaque export est inscrit au journal d’audit.', {
        online: true,
      }),
    ],
  },
];
