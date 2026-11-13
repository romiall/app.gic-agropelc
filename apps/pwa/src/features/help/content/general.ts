/** Aide des pages transverses (AV-525) : accueil, menu, synchronisation, alertes, notes, catalogue, prix, chargement, pièces papier, présence, guide. */
import { ROUTES } from '../../../app/screens.js';
import type { ScreenHelp } from '../help-types.js';
import { act, go } from './helpers.js';

export const GENERAL_HELP: readonly ScreenHelp[] = [
  {
    path: ROUTES.home,
    title: 'Accueil',
    purpose:
      'Votre page de départ, propre à votre rôle : d’abord ce qui demande une réaction (signaux), puis les actions du jour, les indicateurs et l’activité récente. Quand le compte cumule plusieurs rôles, un sélecteur choisit celui affiché.',
    actions: [
      act(
        'go',
        'Lancer une action du jour',
        'Les gros boutons mènent directement à l’écran voulu.',
      ),
      act(
        'read',
        'Traiter un signal',
        'Un signal (validations en attente, appareils en retard, conflits…) ouvre l’écran qui le règle.',
      ),
      act(
        'read',
        'Changer de rôle affiché',
        'Avec plusieurs rôles, choisissez celui dont vous voulez les actions.',
      ),
    ],
    before: [
      'L’accueil se calcule en ligne : sans réseau, utilisez le menu « Plus », qui reste complet.',
      'Vos actions dépendent de vos rôles : si une fonction manque, ouvrez « Aide » sur la page concernée, elle dit quel rôle la porte.',
    ],
    next: [go('Guide et aide', ROUTES.help, 'comprendre l’application et ses parcours')],
  },
  {
    path: ROUTES.menu,
    title: 'Menu « Plus »',
    roles: 'ALL',
    purpose:
      'Tout ce que votre profil peut ouvrir, par domaine, plus l’apparence (clair, sombre) et la déconnexion. Il reste utilisable hors ligne.',
    actions: [
      act(
        'go',
        'Ouvrir un écran',
        'Les écrans sont groupés par domaine (ventes, stock, production, achats, finance…).',
      ),
      act('update', 'Choisir l’apparence', 'Clair, sombre ou celle de l’appareil.'),
      act('go', 'Se déconnecter', 'Efface la session de cet appareil.'),
    ],
  },
  {
    path: ROUTES.sync,
    title: 'Synchronisation',
    purpose:
      'Les opérations enregistrées sur ce téléphone et leur envoi au serveur : en attente, acceptées, refusées avec la raison. Un bouton lance une synchronisation à la demande.',
    actions: [
      act(
        'read',
        'Voir ce qui attend',
        'Chaque opération avec son état ; une opération refusée montre le motif du serveur en langage métier.',
      ),
      act(
        'update',
        'Synchroniser maintenant',
        'Envoie les opérations en attente et télécharge les nouveautés.',
      ),
    ],
    before: [
      'Rien n’est perdu hors ligne : chaque saisie reste sur le téléphone jusqu’à son envoi.',
    ],
  },
  {
    path: ROUTES.alerts,
    title: 'Alertes et notifications',
    purpose:
      'Les alertes de votre périmètre (stock bas, mortalité élevée, retards, écarts…), vos notifications, et pour la Direction et l’Administrateur les règles d’alerte. La lecture et l’accusé se font aussi hors ligne.',
    actions: [
      act(
        'update',
        'Accuser réception d’une alerte',
        'Indique que vous l’avez vue ; possible hors ligne.',
      ),
      act('validate', 'Résoudre ou écarter une alerte', 'Avec un motif, en ligne.', {
        online: true,
      }),
      act('update', 'Régler les règles d’alerte', 'Seuils et destinataires.', {
        roles: ['DIRECTION', 'ADMIN'],
        online: true,
      }),
    ],
  },
  {
    path: ROUTES.notes,
    title: 'Notes de direction',
    purpose:
      'Les consignes publiées par la Direction à votre attention. Lisez-les et accusez réception.',
    actions: [act('update', 'Accuser réception', 'La Direction suit qui a lu.')],
  },
  {
    path: ROUTES.notesPublish,
    title: 'Publier une note',
    purpose:
      'Rédiger une note de direction, choisir son audience (rôles, sites), la publier, l’archiver et suivre les accusés de réception. Une note publiée ne se modifie plus. En ligne.',
    actions: [
      act('create', 'Rédiger et publier', 'Titre, texte, catégorie, audience.', { online: true }),
      act('cancel', 'Archiver', 'Retire la note des écrans sans l’effacer.', { online: true }),
      act('read', 'Suivre les accusés', 'Qui a lu, qui n’a pas encore lu.', { online: true }),
    ],
  },
  {
    path: ROUTES.help,
    title: 'Guide et aide',
    purpose:
      'Le guide complet de l’application : votre profil, ce que vous pouvez faire, les parcours de bout en bout, les pages par domaine, les questions fréquentes. Chaque page a aussi son aide, le bouton « ? » en haut.',
    actions: [
      act(
        'read',
        'Chercher dans le guide',
        'Tapez un mot : seules les pages et les parcours qui le contiennent restent.',
      ),
      act(
        'read',
        'Suivre un parcours',
        'Par exemple « Démarrer un lot » : les étapes, dans l’ordre, avec le rôle qui fait chacune.',
      ),
    ],
  },
  {
    path: ROUTES.catalog,
    title: 'Catalogue',
    purpose:
      'Les unités, les catégories, les produits (création, modification du nom, de la catégorie et des usages, coût standard daté, désactivation), les conditionnements (immuables) et les motifs utilisés par les écrans de perte, de visite, de rejet, d’inventaire. En ligne.',
    actions: [
      act(
        'create',
        'Créer un produit',
        'Nom, catégorie, unité de base, usages (vendable, achetable, consommable, suivi par lot…).',
        { online: true },
      ),
      act(
        'update',
        'Modifier un produit',
        'Nom, catégorie, drapeaux d’usage ; coût standard daté.',
        { online: true },
      ),
      act(
        'cancel',
        'Désactiver ou réactiver',
        'Un produit désactivé ne se propose plus ; son historique reste.',
        { online: true },
      ),
      act('create', 'Ajouter un motif', 'Pour les listes de motifs des écrans.', { online: true }),
    ],
    before: [
      'Les animaux d’un lot sont des produits « suivis par lot » : créez-les ici (poussin d’un jour, porcelet…) avant de créer le lot.',
    ],
    next: [
      go(
        'Chargement de données',
        ROUTES.dataImport,
        'charger beaucoup de produits d’un coup (fichier CSV)',
      ),
    ],
  },
  {
    path: ROUTES.priceRules,
    title: 'Règles tarifaires',
    purpose:
      'Les règles de prix d’un produit : en vigueur, brouillons, historique. On rédige une règle ou une nouvelle version (jamais de modification d’une version existante), la Direction l’active ou y met fin. En ligne.',
    actions: [
      act(
        'create',
        'Rédiger une règle',
        'Brouillon ou nouvelle version de la dernière règle active.',
        { online: true },
      ),
      act(
        'validate',
        'Activer ou terminer',
        'Réservé à la Direction ; un conflit d’activation est annoncé avant.',
        { roles: ['DIRECTION'], online: true },
      ),
    ],
    next: [go('Simulateur de prix', ROUTES.priceSimulator, 'vérifier quel prix sera appliqué')],
  },
  {
    path: ROUTES.priceSimulator,
    title: 'Simulateur de prix',
    purpose:
      'Pour un produit, une quantité, une date, un site, une zone, une catégorie de client et un canal : le prix que la vente appliquerait, la règle retenue et les autres règles applicables. Aucune écriture.',
    actions: [
      act(
        'read',
        'Simuler un prix',
        'Renseignez le contexte ; le résultat reste à droite sur ordinateur.',
      ),
    ],
  },
  {
    path: ROUTES.dataImport,
    title: 'Chargement de données',
    purpose:
      'Charger des données par fichier CSV : catégories de produit, produits, fournisseurs, clients, stock d’ouverture, comptes de trésorerie, règles de prix, pièces papier de l’historique. Le fichier est contrôlé ligne par ligne sur l’appareil ; rien n’est écrit tant que vous ne chargez pas, et recharger le même fichier ne crée aucun doublon.',
    before: [
      'Les animaux et les produits suivis par lot se chargent par leurs lots, pas par le stock d’ouverture.',
    ],
    actions: [
      act(
        'create',
        'Charger un fichier',
        'Choisissez le type, déposez le CSV, corrigez les lignes en erreur, puis chargez les lignes prêtes.',
      ),
    ],
  },
  {
    path: ROUTES.paperSlipReport,
    title: 'Reporter une pièce papier',
    purpose:
      'Reporter dans l’application une opération déjà faite sur un carnet à souche (panne de batterie, zone blanche) : bon de vente, reçu, bon de dépense, réception, transfert, perte… Les champs exigés suivent la commande réelle. Le registre des carnets suit les numéros utilisés.',
    actions: [
      act(
        'create',
        'Reporter une pièce',
        'Type de pièce, numéro du carnet, puis les champs de l’opération ; envoyée comme toute opération.',
      ),
    ],
  },
  {
    path: ROUTES.presence,
    title: 'Présence du personnel',
    purpose:
      'Reporter la fiche de présence de la semaine (une feuille par site et par semaine : une ligne par personne, des heures ou un code d’absence par jour), lire les feuilles déjà reportées, imprimer la fiche PT. Usage de suivi, ni paie ni discipline.',
    actions: [
      act('create', 'Reporter une feuille', 'Possible sans réseau.'),
      act(
        'cancel',
        'Annuler une feuille',
        'Pour la corriger : annulation motivée puis nouveau report, en ligne.',
        { online: true },
      ),
      act('read', 'Imprimer la fiche PT', 'Dans la mise en page du papier.'),
    ],
  },
];
