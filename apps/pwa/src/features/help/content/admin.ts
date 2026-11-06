/** Aide des pages d'administration et de supervision (AV-525) : appareils, comptes, organisation, paramètres, audit, validations, synchronisation. */
import { ROUTES } from '../../../app/screens.js';
import type { ScreenHelp } from '../help-types.js';
import { act, go } from './helpers.js';

export const ADMIN_HELP: readonly ScreenHelp[] = [
  {
    path: ROUTES.organization,
    title: 'Organisation',
    purpose:
      'La structure de l’entreprise : sites (fermes, magasins, points de vente), leurs emplacements (bâtiments, cases, magasins, incubateurs), zones et géorepères, équipes, points de vente. Tout ce que les autres écrans proposent (fermes, magasins, destinations) vient d’ici. En ligne.',
    before: [
      'À faire en premier, avant de créer des comptes de terrain : une ferme, ses bâtiments et un magasin d’aliment ; un magasin central ; les points de vente.',
    ],
    actions: [
      act('create', 'Créer un site', 'Nom, type (ferme, magasin, point de vente…), zone.', {
        online: true,
      }),
      act(
        'create',
        'Ajouter un emplacement',
        'Dans la fiche d’un site : bâtiment, case, magasin, incubateur, éclosoir…',
        { online: true },
      ),
      act(
        'update',
        'Modifier, déplacer, fermer',
        'Un site, une zone (déplacement), une équipe (fermeture) se corrigent ; rien ne se supprime.',
        { online: true },
      ),
      act(
        'create',
        'Définir un point de vente',
        'Rattache un site de vente à sa source d’approvisionnement.',
        { online: true },
      ),
    ],
    next: [
      go(
        'Comptes et rôles',
        ROUTES.users,
        'pour affecter un responsable de ferme ou un magasinier à ce site',
      ),
      go('Catalogue', ROUTES.catalog, 'produits que la ferme gère'),
    ],
  },
  {
    path: ROUTES.users,
    title: 'Comptes et rôles',
    purpose:
      'Créer les comptes, leur donner un ou plusieurs rôles sur un périmètre (global ou un site), suspendre, réactiver, désactiver, réinitialiser un mot de passe. En ligne.',
    before: [
      'Un rôle de terrain (responsable de ferme, magasinier, vendeur) s’affecte à un site : créez le site avant.',
    ],
    actions: [
      act(
        'create',
        'Créer un compte',
        'Nom, téléphone, e-mail, mot de passe provisoire (changé à la première connexion) et premier rôle.',
        { online: true },
      ),
      act(
        'update',
        'Ajouter ou retirer un rôle',
        'Sur « Global » ou un site. Un compte peut cumuler plusieurs rôles (administrateur et direction, par exemple).',
        { online: true },
      ),
      act('update', 'Réinitialiser un mot de passe', 'Pour une personne qui l’a oublié.', {
        online: true,
      }),
      act(
        'cancel',
        'Suspendre ou désactiver',
        'Un compte désactivé ne se connecte plus ; son historique reste.',
        { online: true },
      ),
    ],
    next: [
      go(
        'Appareils',
        ROUTES.devices,
        'approuver le téléphone de la personne à sa première connexion',
      ),
    ],
  },
  {
    path: ROUTES.devices,
    title: 'Appareils',
    purpose:
      'Les téléphones et ordinateurs enrôlés : approuver un nouvel appareil, le bloquer, le déclarer perdu ou le rattacher à un site. Un appareil non approuvé ne peut rien envoyer. En ligne.',
    actions: [
      act(
        'validate',
        'Approuver un appareil',
        'Vérifiez le code court affiché sur l’appareil, puis approuvez.',
        { online: true },
      ),
      act(
        'cancel',
        'Bloquer ou déclarer perdu',
        'L’appareil ne peut plus rien envoyer ; ses données peuvent être effacées.',
        { online: true },
      ),
      act('update', 'Rattacher à un site', 'Définit où l’appareil travaille.', { online: true }),
    ],
  },
  {
    path: ROUTES.approvals,
    title: 'Validations',
    purpose:
      'La file des demandes que vous pouvez décider : mortalités, pertes, écarts d’inventaire ou de transfert, remises, annulations, dépenses, demandes d’achat… Chacun ne voit que ce qu’il peut décider. En ligne ; la plus ancienne d’abord.',
    actions: [
      act(
        'validate',
        'Approuver ou refuser',
        'Ouvrez la demande, lisez le motif et les pièces, puis décidez. Un refus appelle une raison.',
        { online: true },
      ),
    ],
    before: [
      'Vous ne pouvez pas valider votre propre demande, sauf la Direction (marquée « auto-validée »).',
    ],
  },
  {
    path: ROUTES.settings,
    title: 'Paramètres et politiques',
    purpose:
      'Deux onglets : les paramètres système (seuils, délais, interrupteurs, par domaine, globaux ou par site) et les politiques de contrôle (photo, commentaire, validation, approbateur, portée). Toute modification crée une nouvelle version et garde l’historique. En ligne.',
    actions: [
      act(
        'update',
        'Modifier un paramètre',
        'La valeur est contrôlée selon ses bornes ; l’historique de la clé reste consultable.',
        { online: true },
      ),
      act(
        'update',
        'Modifier une politique de contrôle',
        'Nouvelle version : photo, commentaire, validation exigés ou non, approbateur.',
        { online: true },
      ),
    ],
  },
  {
    path: ROUTES.audit,
    title: 'Journal d’audit',
    purpose:
      'La trace de tout ce qui a été fait : qui, quand, quoi, avant et après. Recherche par période, type d’objet, acteur et action. Chaque recherche est elle-même inscrite au journal. La Finance ne voit que les objets financiers.',
    actions: [
      act(
        'read',
        'Rechercher dans le journal',
        'Filtrez, puis ouvrez une ligne pour le détail avant/après, le motif, l’appareil et la commande.',
        { online: true },
      ),
    ],
  },
  {
    path: ROUTES.syncMonitor,
    title: 'Supervision de la synchronisation',
    purpose:
      'La fraîcheur de chaque appareil (dernier envoi, dernier téléchargement, dernier contact) et les files d’opérations en attente qu’il a signalées. En ligne.',
    actions: [
      act(
        'read',
        'Repérer un appareil en retard',
        'Filtre « en retard » ; mène à la file des conflits.',
        { online: true },
      ),
    ],
    next: [go('Conflits', ROUTES.syncConflicts, 'traiter les opérations en conflit')],
  },
  {
    path: ROUTES.syncConflicts,
    title: 'Conflits de synchronisation',
    purpose:
      'Les opérations faites hors ligne que le serveur a appliquées avec un signalement ou mises de côté (stock insuffisant, lot clôturé, doublon…). Vous traitez ceux de votre domaine. En ligne.',
    actions: [
      act('validate', 'Clore un conflit', 'Avec un motif : résolu ou écarté.', { online: true }),
    ],
  },
];
