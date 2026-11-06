/**
 * Aide des pages de la ferme (production) : lots, saisie du jour, collecte d'œufs, incubation, sortie vers la
 * vente, fiche du lot (AV-525). Les rôles viennent de `ROLE_SETS` : un changement de droits d'une page
 * corrige l'aide sans la réécrire.
 */
import { ROLE_SETS, ROUTES } from '../../../app/screens.js';
import type { ScreenHelp } from '../help-types.js';
import { act, go } from './helpers.js';

export const PRODUCTION_HELP: readonly ScreenHelp[] = [
  {
    path: ROUTES.productionLots,
    title: 'Lots de production',
    purpose:
      'Vos lots d’élevage actifs ou en vente, avec l’âge, l’effectif et les saisies du jour. C’est le point de départ de la ferme : de là on crée un lot, on y fait entrer les animaux, on saisit la journée et on suit les fiches.',
    before: [
      'Un lot n’apparaît ici qu’une fois actif, c’est-à-dire dès que des animaux y sont entrés. Un lot créé mais vide reste dans « Lots planifiés », plus bas.',
      'Les animaux doivent d’abord être en stock sur la ferme (achat réceptionné, éclosion interne) ou venir d’un autre lot.',
      'Il faut une ferme avec ses bâtiments et un magasin déclarés dans Administration → Organisation.',
    ],
    actions: [
      act(
        'create',
        'Créer un lot',
        'Choisissez la ferme, le type de lot (poulets de chair, pondeuses, porcs…), les animaux et le bâtiment principal. Le lot est « planifié » tant qu’aucun animal n’y est entré.',
        { roles: ROLE_SETS.lotSetup, to: ROUTES.lotSetup },
      ),
      act(
        'create',
        'Faire entrer les animaux dans un lot',
        'Touchez un lot planifié, ou ouvrez « Nouveau lot » puis « Entrée dans un lot » : stock de la ferme, réception d’achat, autre lot, naissance. La première entrée rend le lot actif.',
        { roles: ROLE_SETS.lotSetup, to: ROUTES.lotSetup },
      ),
      act(
        'update',
        'Saisir la journée d’un lot',
        'Touchez un lot actif : mortalité, aliment et intrants, pesée, observation. Chaque saisie est enregistrée même sans réseau.',
      ),
      act(
        'go',
        'Collecter les œufs',
        'Pour les lots de pondeuses et de reproducteurs : œufs collectés, cassés, commercialisables par calibre et à couver.',
        { to: ROUTES.eggCollection },
      ),
      act(
        'go',
        'Gérer les incubations',
        'Mise en incubateur, mirage, transfert vers l’éclosoir, éclosion.',
        { roles: ROLE_SETS.incubation, to: ROUTES.incubation },
      ),
      act(
        'go',
        'Envoyer un lot à la vente',
        'Déclarer un lot prêt à la vente et envoyer les animaux vers un magasin ou un point de vente.',
        { roles: ROLE_SETS.productionOutput, to: ROUTES.productionOutput },
      ),
      act(
        'read',
        'Consulter la fiche d’un lot',
        'Effectif, mortalité, indicateurs, coûts, ventes et marge, y compris pour un lot clôturé. C’est aussi là que l’on clôture ou annule un lot, et que l’on annule une entrée ou une pesée.',
        { roles: ROLE_SETS.lotSheet, to: ROUTES.lotSheet },
      ),
    ],
    next: [
      go('Nouveau lot', ROUTES.lotSetup, 'quand aucun lot n’est ouvert'),
      go(
        'Enregistrer l’achat des animaux',
        ROUTES.purchaseReceiptFree,
        'quand les animaux ne sont pas encore en stock sur la ferme',
      ),
    ],
  },
  {
    path: ROUTES.lotSetup,
    title: 'Nouveau lot et entrée d’animaux',
    purpose:
      'Deux rubriques : « Nouveau lot » crée le lot, « Entrée dans un lot » y fait entrer les animaux. Un lot est planifié tant qu’aucun animal n’y est entré ; la première entrée le rend actif et ouvre sa saisie du jour.',
    before: [
      'Une ferme avec au moins un bâtiment ou une case, et le produit biologique du lot (par exemple « poussin d’un jour ») au catalogue.',
      'Pour une entrée depuis le stock ou un achat : les animaux doivent avoir été réceptionnés sur la ferme (Achats → Réceptions, ou la réception sans bon de commande).',
    ],
    actions: [
      act(
        'create',
        'Créer un lot',
        'Ferme, type de lot, animaux du lot et bâtiment principal ; le fournisseur, la souche, les dates prévues et une note sont facultatifs. Possible sans réseau, le numéro du lot est donné par le serveur.',
      ),
      act(
        'create',
        'Faire entrer des animaux',
        'Origine : stock de la ferme, réception d’achat, autre lot (transfert), sevrage ou naissance. Le nombre de têtes est obligatoire ; le poids moyen et les mort-nés sont facultatifs.',
      ),
      act(
        'go',
        'Enregistrer l’achat des animaux',
        'Quand le stock de la ferme est vide : réception sans bon de commande (animaux et aliment, prix unitaire obligatoire).',
        { roles: ROLE_SETS.purchaseReceipt, to: ROUTES.purchaseReceiptFree },
      ),
      act(
        'cancel',
        'Annuler une entrée ou un lot',
        'Depuis la fiche du lot, en ligne : une entrée s’annule (les animaux retournent à leur origine) ; un lot planifié et vide s’annule ; un lot actif se clôture.',
        { roles: ROLE_SETS.lotSheet, to: ROUTES.lotSheet, online: true },
      ),
    ],
    next: [
      go('Saisie du jour', ROUTES.productionLots, 'une fois les animaux entrés, le lot est actif'),
    ],
  },
  {
    path: ROUTES.dailyEntryPattern,
    title: 'Saisie du jour',
    roles: ROLE_SETS.production,
    purpose:
      'Les quatre saisies de la journée d’un lot : mortalité, aliment et intrants, pesée, observation. Chaque saisie est une opération à part, enregistrée sur le téléphone puis envoyée ; le journal du jour les rassemble.',
    before: [
      'Le lot doit être actif ou en vente : un lot planifié (aucun animal entré), clôturé ou annulé n’accepte pas de saisie.',
    ],
    actions: [
      act(
        'create',
        'Déclarer une mortalité',
        'Nombre de morts, bâtiment ou case, cause facultative, photo. Selon la politique de contrôle des mortalités, elle attend la validation d’un responsable (Validations) ; la photo se joint aussi après coup.',
      ),
      act(
        'create',
        'Saisir l’aliment ou un intrant consommé',
        'Produit, quantité et nature du coût (aliment, vétérinaire, autre) : le stock baisse et le coût est imputé au lot.',
      ),
      act(
        'create',
        'Enregistrer une pesée',
        'Nombre de sujets pesés et poids moyen : alimente le gain moyen quotidien de la fiche.',
      ),
      act(
        'create',
        'Noter une observation',
        'Un constat daté (sanitaire, comportement, environnement, incident) avec sa gravité.',
      ),
      act(
        'go',
        'Collecte d’œufs, sortie vers la vente, fiche du lot',
        'Les trois liens en haut de page mènent aux écrans voisins du même lot.',
      ),
      act(
        'cancel',
        'Corriger une erreur',
        'Une pesée se corrige depuis la fiche du lot (annulation, en ligne) ; une collecte d’œufs depuis l’écran de collecte ; une mortalité refusée par le validateur revient au lot.',
        { roles: ROLE_SETS.lotSheet, to: ROUTES.lotSheet },
      ),
    ],
    next: [
      go('Fiche du lot', ROUTES.lotSheet, 'effectif, mortalité, indicateurs et coûts'),
      go('Sortie vers la vente', ROUTES.productionOutput, 'quand les animaux sont prêts'),
    ],
  },
  {
    path: ROUTES.eggCollection,
    title: 'Collecte d’œufs',
    purpose:
      'Le relevé d’un lot de pondeuses ou de reproducteurs pour un jour : œufs collectés, cassés, non conformes, à couver, et le reste commercialisable réparti par calibre. Le bilan doit tomber juste avant l’enregistrement ; les œufs commercialisables entrent aussitôt au stock.',
    before: [
      'Un lot de pondeuses ou de reproducteurs actif ; les calibres d’œufs et le produit « œuf à couver » doivent exister au catalogue.',
      'Un emplacement de stockage des œufs (magasin) sur la ferme.',
    ],
    actions: [
      act(
        'create',
        'Enregistrer une collecte',
        'Lot, jour (pas après aujourd’hui), emplacement de stockage, quantités. Possible sans réseau.',
      ),
      act(
        'cancel',
        'Annuler une collecte saisie par erreur',
        'La liste « Collectes récentes » propose « Annuler » : les œufs sortent du stock et du coût du lot. Impossible si ces œufs ont déjà été vendus, transférés ou mis à couver.',
      ),
      act(
        'go',
        'Mettre des œufs à couver',
        'Les œufs « à couver » se mettent en incubateur depuis l’écran des incubations.',
        { roles: ROLE_SETS.incubation, to: ROUTES.incubation },
      ),
    ],
    next: [
      go('Incubations', ROUTES.incubation, 'pour mettre les œufs à couver en incubateur'),
      go('Saisie du jour', ROUTES.productionLots, 'retour au lot'),
    ],
  },
  {
    path: ROUTES.incubation,
    title: 'Incubations',
    purpose:
      'Le suivi des lots d’incubation de la ferme : mise en incubateur, mirage, transfert vers l’éclosoir, éclosion, et perte d’un lot entier. Deux rubriques : « Lots en cours » et « Démarrer un lot ».',
    before: [
      'Des œufs à couver en stock sur la ferme (collecte d’œufs d’un lot de reproducteurs ou œufs achetés).',
      'Un incubateur et, pour le transfert, un éclosoir déclarés comme emplacements de la ferme (Administration → Organisation).',
    ],
    actions: [
      act(
        'create',
        'Démarrer un lot d’incubation',
        'Choisissez l’incubateur et les œufs à mettre à couver ; les dates prévues de mirage, de transfert et d’éclosion se calculent selon l’espèce.',
      ),
      act(
        'create',
        'Enregistrer un mirage',
        'Œufs clairs et morts en début d’incubation : ils quittent l’incubateur et le lot garde ses œufs viables.',
      ),
      act(
        'update',
        'Transférer vers l’éclosoir',
        'Tous les œufs du lot présents à l’incubateur passent à l’éclosoir.',
      ),
      act(
        'create',
        'Enregistrer l’éclosion',
        'Poussins éclos et pertes : les poussins entrent en stock, prêts à être mis en place dans un lot.',
      ),
      act(
        'cancel',
        'Déclarer un lot perdu',
        'Perte totale d’un lot d’incubation (annulation, en ligne).',
        { online: true },
      ),
    ],
    next: [
      go(
        'Nouveau lot',
        ROUTES.lotSetup,
        'pour mettre les poussins éclos en place dans un nouveau lot',
      ),
    ],
  },
  {
    path: ROUTES.productionOutput,
    title: 'Sortie vers la vente',
    purpose:
      'Deux choses : déclarer qu’un lot est prêt à la vente (le lot passe « en vente »), puis envoyer ses animaux vers un magasin ou un point de vente (transfert du bâtiment vers la destination).',
    before: [
      'Un lot actif avec des animaux en élevage. Les destinations (magasin, point de vente) sont déclarées dans Administration → Organisation.',
    ],
    actions: [
      act(
        'update',
        'Déclarer le lot prêt à la vente',
        'Le lot passe de « actif » à « en vente » (et inversement). Réservé à qui gère les lots.',
        { roles: ROLE_SETS.lotSetup },
      ),
      act(
        'create',
        'Envoyer des animaux vers la vente',
        'Bâtiment d’origine, destination, nombre de têtes, transporteur et note. Le destinataire reçoit le transfert sur son téléphone.',
      ),
    ],
    next: [
      go(
        'Fiche du lot',
        ROUTES.lotSheet,
        'pour clôturer le lot quand tous ses animaux sont partis',
      ),
    ],
  },
  {
    path: ROUTES.lotSheet,
    title: 'Fiche d’un lot',
    purpose:
      'Tout ce qu’il faut savoir d’un lot : effectif, mortalité, indicateurs (mortalité, gain moyen quotidien, indice de consommation, ponte), coûts, ventes et marge, entrées et pesées. Elle sert aussi à corriger et à clore : clôture, annulation du lot, d’une entrée ou d’une pesée.',
    before: [
      'En ligne pour les indicateurs, les coûts et les corrections ; hors ligne, seul l’effectif calculé par le téléphone s’affiche.',
      'Les montants (coûts, ventes, marges) ne se voient qu’avec le droit de valorisation (Direction, Finance, Responsable production) ; l’Administrateur seul n’en voit pas.',
    ],
    actions: [
      act(
        'read',
        'Consulter un lot, même clôturé',
        'Le sélecteur propose les lots ouverts puis les lots clôturés (lus en ligne par pages).',
      ),
      act(
        'update',
        'Faire entrer des animaux, saisir la journée, collecter les œufs, envoyer à la vente',
        'Les boutons de « Actions sur le lot » ouvrent l’écran voisin avec le lot déjà choisi.',
        { roles: ROLE_SETS.lotSetup },
      ),
      act(
        'validate',
        'Clôturer le lot',
        'Fige le coût et ferme le lot. Il ne doit plus contenir d’animaux non vendus, de mortalité en attente ni de vente à livrer.',
        { roles: ROLE_SETS.lotSetup, online: true },
      ),
      act(
        'cancel',
        'Annuler un lot planifié',
        'Seul un lot sans aucune entrée s’annule ; il faut un motif.',
        { roles: ROLE_SETS.lotSetup, online: true },
      ),
      act(
        'cancel',
        'Annuler une entrée ou une pesée',
        'Dans les listes « Entrées » et « Pesées » : les animaux d’une entrée retournent à leur origine, une pesée n’est plus comptée ; il faut un motif.',
        { roles: ROLE_SETS.lotSetup, online: true },
      ),
    ],
    next: [go('Lots de production', ROUTES.productionLots, 'retour à la liste des lots')],
  },
];
