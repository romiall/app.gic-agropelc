/**
 * Parcours de bout en bout et questions fréquentes du guide (AV-525). Un parcours dit dans quel ordre faire
 * les choses et quel rôle fait chaque étape : c'est la réponse à « par où commencer ? ». Les parcours suivent
 * les journées types de `docs/01-functional/03-parcours-et-ecrans.md` (WF-J1 à WF-J8) et l'état des écrans.
 */
import { ROLE_SETS, ROUTES } from '../../../app/screens.js';
import type { FaqItem, Journey } from '../help-types.js';

export const JOURNEYS: readonly Journey[] = [
  {
    id: 'setup',
    title: 'Mettre l’application en route',
    goal: 'Déclarer l’entreprise, ses sites, ses produits et ses comptes avant que le terrain ne travaille.',
    roles: ['ADMIN'],
    steps: [
      {
        to: ROUTES.organization,
        label: 'Organisation',
        what: 'Créez la ferme et ses bâtiments ou cases, un magasin d’aliment sur la ferme, le magasin central, les points de vente et les zones.',
      },
      {
        to: ROUTES.catalog,
        label: 'Catalogue',
        what: 'Vérifiez ou créez les produits : poussin d’un jour, aliment, œufs et leurs calibres, poulet de chair vif, porcelet…',
      },
      {
        to: ROUTES.users,
        label: 'Comptes et rôles',
        what: 'Créez les comptes (responsable de production, responsable de ferme, magasinier, vendeurs) et affectez chaque rôle de terrain à son site.',
      },
      {
        to: ROUTES.devices,
        label: 'Appareils',
        what: 'À sa première connexion, chaque personne enrôle son téléphone ; vous le reconnaissez à son code court et vous l’approuvez.',
      },
      {
        to: ROUTES.settings,
        label: 'Paramètres et politiques',
        what: 'Réglez les seuils et les contrôles : validation des mortalités, caisse exigée ou non, délais d’annulation…',
      },
      {
        to: ROUTES.dataImport,
        label: 'Chargement de données',
        what: 'Chargez par fichier CSV les produits, fournisseurs, clients et le stock d’ouverture. Un lot déjà en élevage se reprend par la rubrique « Reprise d’un lot » de Production → Nouveau lot (ou par le chargement « Lots en cours ») ; la Direction valide la reprise.',
      },
    ],
  },
  {
    id: 'lot',
    title: 'Démarrer et conduire un lot d’élevage',
    goal: 'Du premier achat d’animaux à la clôture du lot : poulets de chair, pondeuses, porcs.',
    roles: ['RESP_PRODUCTION', 'ADMIN', 'RESP_FERME'],
    steps: [
      {
        to: ROUTES.purchaseReceiptFree,
        roles: ROLE_SETS.purchaseReceipt,
        label: 'Enregistrer l’achat des animaux',
        what: 'Réception sans bon de commande : le fournisseur, les animaux, l’aliment, le prix unitaire (obligatoire) et le code du lot fournisseur. Les animaux entrent en stock sur la ferme.',
      },
      {
        to: ROUTES.lotSetup,
        roles: ROLE_SETS.lotSetup,
        label: 'Créer le lot',
        what: 'Rubrique « Nouveau lot » : ferme, type de lot, animaux, bâtiment principal. Le lot est planifié.',
      },
      {
        to: ROUTES.lotSetup,
        roles: ROLE_SETS.lotSetup,
        label: 'Faire entrer les animaux',
        what: 'Rubrique « Entrée dans un lot » : origine « réception d’achat » ou « stock de la ferme », nombre de têtes. La première entrée rend le lot actif.',
      },
      {
        to: ROUTES.productionLots,
        label: 'Saisir la journée',
        what: 'Chaque jour, touchez le lot : mortalité, aliment, pesée, observation. Possible sans réseau.',
      },
      {
        to: ROUTES.approvals,
        roles: ['DIRECTION', 'RESP_PRODUCTION', 'RESP_FERME'],
        label: 'Valider les mortalités',
        what: 'Les mortalités que la politique de contrôle soumet à validation attendent la décision d’un responsable, dans Validations. L’Administrateur seul dépose les mortalités mais ne les valide pas.',
      },
      {
        to: ROUTES.productionOutput,
        roles: ROLE_SETS.productionOutput,
        label: 'Envoyer à la vente',
        what: 'Déclarez le lot prêt à la vente puis envoyez les animaux vers un magasin ou un point de vente.',
      },
      {
        to: ROUTES.lotSheet,
        roles: ROLE_SETS.lotSheet,
        label: 'Clôturer le lot',
        what: 'Quand tous les animaux sont partis et que les mortalités sont traitées, clôturez : le coût est figé et la marge se lit sur la fiche.',
      },
    ],
  },
  {
    id: 'eggs',
    title: 'Collecter les œufs et faire éclore',
    goal: 'Une ferme de pondeuses : œufs du jour, œufs à vendre, œufs à couver, poussins.',
    roles: ['RESP_FERME', 'RESP_PRODUCTION', 'ADMIN'],
    steps: [
      {
        to: ROUTES.productionLots,
        label: 'Avoir un lot de pondeuses actif',
        what: 'Voir « Démarrer et conduire un lot » : le type de lot est « Pondeuses » ou « Reproducteurs ».',
      },
      {
        to: ROUTES.eggCollection,
        label: 'Collecter les œufs',
        what: 'Chaque jour : collectés, cassés, non conformes, à couver, et le reste par calibre. Le bilan doit tomber juste.',
      },
      {
        to: ROUTES.incubation,
        label: 'Mettre à couver',
        what: '« Démarrer un lot » : choisissez l’incubateur et les œufs à couver.',
      },
      {
        to: ROUTES.incubation,
        label: 'Mirage, transfert, éclosion',
        what: 'Au jour prévu, enregistrez le mirage, transférez vers l’éclosoir, puis l’éclosion : les poussins entrent en stock.',
      },
      {
        to: ROUTES.lotSetup,
        roles: ROLE_SETS.lotSetup,
        label: 'Mettre les poussins en place',
        what: 'Créez un lot de poulets de chair et faites-y entrer les poussins depuis le stock de la ferme.',
      },
      {
        to: ROUTES.newSale,
        roles: ROLE_SETS.saleRecord,
        label: 'Vendre les œufs commercialisables',
        what: 'Les œufs par calibre sont en stock : vente directe ou transfert vers un point de vente.',
      },
    ],
  },
  {
    id: 'receive',
    title: 'Acheter et réceptionner une livraison',
    goal: 'De la demande d’achat au paiement du fournisseur.',
    roles: ['RESP_ACHATS', 'MAGASINIER', 'RESP_FERME'],
    steps: [
      {
        to: ROUTES.purchaseRequests,
        label: 'Demande d’achat',
        what: 'Le demandeur exprime son besoin (produits, quantités, justification).',
      },
      {
        to: ROUTES.purchaseOrders,
        label: 'Bon de commande',
        what: 'Le responsable des achats commande auprès d’un fournisseur ; la Direction valide au-dessus du seuil.',
      },
      {
        to: ROUTES.purchaseReceipts,
        label: 'Réception',
        what: 'À la livraison, le magasinier compte : livré, rejeté, accepté ; l’accepté entre en stock.',
      },
      {
        to: ROUTES.supplierInvoices,
        label: 'Facture fournisseur',
        what: 'La Finance saisit la facture ; elle est rapprochée du bon de commande et de la réception.',
      },
      {
        to: ROUTES.supplierPayments,
        label: 'Paiement',
        what: 'La Finance paie ; au-delà du seuil, la Direction décide.',
      },
      {
        to: ROUTES.orderMatching,
        label: 'Rapprochement',
        what: 'Commandé, livré, accepté, facturé, payé : repérez les écarts.',
      },
    ],
  },
  {
    id: 'pos',
    title: 'Approvisionner un point de vente et vendre',
    goal: 'La journée d’un point de vente, de l’ouverture de la caisse à la remise des fonds.',
    roles: ['VENDEUR_PDV', 'MAGASINIER'],
    steps: [
      {
        to: ROUTES.cash,
        label: 'Ouvrir la caisse',
        what: 'Comptez le fonds de caisse (si la caisse est exigée pour le site).',
      },
      {
        to: ROUTES.replenish,
        label: 'Demander du stock',
        what: 'Le vendeur demande un réapprovisionnement (produits sous le seuil suggérés).',
      },
      {
        to: ROUTES.transfer,
        roles: ROLE_SETS.transferDispatch,
        label: 'Expédier',
        what: 'Le magasinier expédie ou refuse la demande.',
      },
      {
        to: ROUTES.receive,
        label: 'Recevoir',
        what: 'Le vendeur compte à l’arrivée ; un écart part en validation.',
      },
      { to: ROUTES.newSale, label: 'Vendre', what: 'Vente rapide, encaissement intégré, reçu.' },
      {
        to: ROUTES.cash,
        label: 'Clôturer la caisse',
        what: 'Comptez l’espèce ; le serveur calcule l’écart.',
      },
      {
        to: ROUTES.cashTransfers,
        label: 'Remettre les fonds',
        what: 'Remise de l’espèce à la Finance.',
      },
      {
        to: ROUTES.count,
        label: 'Inventaire',
        what: 'Comptez le stock du point de vente ; les écarts se valident.',
      },
    ],
  },
  {
    id: 'orders',
    title: 'Prendre une commande et la livrer payée',
    goal: 'Du client identifié à l’encaissement.',
    roles: ['RESP_COMMERCIAL', 'COMMERCIAL_TERRAIN', 'COMMERCIAL_SEDENTAIRE'],
    steps: [
      {
        to: ROUTES.newProspect,
        label: 'Ajouter le client',
        what: 'Prospect créé, puis proposé à la vente.',
      },
      {
        to: ROUTES.newOrder,
        label: 'Passer la commande',
        what: 'Articles, date de livraison, acompte facultatif. Aucun contrôle d’argent à la commande.',
      },
      {
        to: ROUTES.orders,
        label: 'Suivre la commande',
        what: 'Vendue, livrée, en attente de stock.',
      },
      {
        to: ROUTES.orders,
        label: 'Livrer',
        what: 'Depuis la commande : quantités remises. Le client paie avant la livraison, sauf client autorisé au crédit.',
      },
      {
        to: ROUTES.collect,
        label: 'Encaisser',
        what: 'Règlement reçu, affecté à la créance la plus ancienne.',
      },
    ],
  },
  {
    id: 'fix',
    title: 'Corriger une erreur',
    goal: 'Rien ne se supprime : on corrige par annulation motivée, et l’historique reste.',
    roles: ['RESP_PRODUCTION', 'RESP_FERME', 'ADMIN', 'MAGASINIER', 'VENDEUR_PDV'],
    steps: [
      {
        to: ROUTES.eggCollection,
        label: 'Collecte d’œufs saisie par erreur',
        what: 'Liste « Collectes récentes » → Annuler (motif obligatoire).',
      },
      {
        to: ROUTES.lotSheet,
        roles: ROLE_SETS.lotSetup,
        label: 'Pesée, entrée d’animaux, lot',
        what: 'Fiche du lot → Entrées ou Pesées → Annuler ; un lot planifié et vide s’annule ; un lot actif se clôture. En ligne.',
      },
      {
        to: ROUTES.sales,
        label: 'Vente',
        what: 'Détail de la vente → Annuler : immédiat dans le délai prévu, sinon soumis à validation.',
      },
      {
        to: ROUTES.orders,
        label: 'Commande',
        what: 'Détail de la commande → Annuler, ou clôturer le reste après une livraison partielle.',
      },
      {
        to: ROUTES.cashTransfers,
        label: 'Remise de fonds',
        what: 'Annuler une remise envoyée et pas encore reçue.',
      },
      { to: ROUTES.count, label: 'Inventaire', what: 'Annuler un comptage avant sa soumission.' },
      {
        to: ROUTES.sync,
        label: 'Opération refusée',
        what: 'L’écran Synchronisation donne la raison du refus en langage métier ; refaites l’opération corrigée.',
      },
    ],
  },
];

export const FAQ: readonly FaqItem[] = [
  {
    question: 'Pourquoi je ne vois pas une page, un bouton ou un lot ?',
    answer:
      'Trois raisons possibles. 1) Votre rôle ne porte pas la fonction : ouvrez « Aide » (le « ? » en haut) sur la page, la section « Réservé à d’autres profils » nomme les rôles qui peuvent. 2) Votre rôle est de terrain, donc rattaché à un site : vous ne voyez que les données de votre site, et un site qui n’existe pas encore n’a rien à montrer (Administration → Organisation). 3) Le téléphone n’a pas encore tout téléchargé : synchronisez.',
  },
  {
    question: 'La liste des lots est vide. Que faire ?',
    answer:
      'Un lot n’est actif qu’une fois des animaux entrés. Dans l’ordre : une ferme et ses bâtiments (Organisation) ; les animaux en stock sur la ferme (Achats → Réceptions → sans bon de commande) ; Production → Nouveau lot ; puis « Entrée dans un lot ». Le guide « Démarrer et conduire un lot » détaille les étapes.',
  },
  {
    question: 'Puis-je travailler sans réseau ?',
    answer:
      'Oui pour la plupart des saisies du terrain (ventes, saisie du jour, collectes, réceptions, pertes, comptages…) : elles restent sur le téléphone et partent au retour du réseau. Les écrans d’administration, de finance, d’analyse, la clôture d’un lot et les annulations se font en ligne. Chaque page le précise dans son aide (« En ligne »).',
  },
  {
    question: 'Comment supprimer une opération ?',
    answer:
      'Rien ne se supprime : on annule, avec un motif, et l’opération reste à l’historique. Voir le parcours « Corriger une erreur ».',
  },
  {
    question: 'Pourquoi les coûts et les marges ne s’affichent-ils pas ?',
    answer:
      'Les montants (coûts, valeurs, marges) sont réservés aux rôles qui voient les valorisations : Direction, Finance, Responsable production et Supervision. Un compte Administrateur seul n’y a pas accès.',
  },
  {
    question: 'Qui valide une mortalité ou une perte ?',
    answer:
      'Selon la politique de contrôle : le responsable de production, le responsable de ferme ou le magasinier de son périmètre, ou la Direction. La demande attend dans Validations. Nul ne valide sa propre demande, sauf la Direction.',
  },
  {
    question: 'Une opération a été refusée. Où voir pourquoi ?',
    answer:
      'Sur l’écran de l’opération juste après l’envoi, et dans Synchronisation : chaque refus donne sa raison en langage métier. Corrigez puis refaites l’opération.',
  },
];
