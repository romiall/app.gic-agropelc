/** Aide des pages des ventes, des commandes, de l'encaissement, de la caisse et du point de vente (AV-525). */
import { ROLE_SETS, ROUTES } from '../../../app/screens.js';
import type { ScreenHelp } from '../help-types.js';
import { act, go } from './helpers.js';

export const SALES_HELP: readonly ScreenHelp[] = [
  {
    path: ROUTES.newSale,
    title: 'Nouvelle vente',
    purpose:
      'Vendre vite et encaisser sur le même écran : emplacement de départ, client (« client de passage » par défaut), articles au prix du catalogue, encaissement prérempli au total. La vente est enregistrée même sans réseau.',
    before: [
      'Du stock à l’emplacement de vente (ou un quota pour un stock partagé). Hors ligne, la vente est bloquée au-delà de ce que le téléphone connaît du stock.',
      'Un point de vente a besoin d’une caisse ouverte seulement si le paramètre « caisse exigée » est activé pour le site.',
    ],
    actions: [
      act(
        'create',
        'Enregistrer une vente',
        'Articles, quantités, mode d’encaissement (espèces, Mobile Money, banque) ; le reçu se compose aussitôt.',
      ),
      act(
        'update',
        'Accorder une remise',
        'Dans la limite de votre plafond ; au-delà, la vente attend la validation d’un responsable.',
        {
          roles: ROLE_SETS.priceOverride,
        },
      ),
      act(
        'create',
        'Vendre à crédit',
        'Pour un client autorisé au crédit, dans son plafond : la vente crée une créance.',
      ),
    ],
    next: [
      go('Détail de la vente', ROUTES.sales, 'reçu, impression, annulation'),
      go('Encaisser', ROUTES.collect, 'pour régler plus tard une créance'),
    ],
  },
  {
    path: ROUTES.sales,
    title: 'Ventes récentes',
    purpose:
      'Les ventes des 7 derniers jours connues du téléphone, y compris celles pas encore acceptées par le serveur. Le signal « ventes signalées » de l’accueil ouvre cette liste filtrée sur les anomalies.',
    actions: [
      act('read', 'Retrouver une vente', 'La plus récente d’abord ; touchez-la pour son reçu.'),
      act('go', 'Faire une nouvelle vente', 'Ouvre l’écran de vente.', {
        roles: ROLE_SETS.saleRecord,
        to: ROUTES.newSale,
      }),
    ],
  },
  {
    path: ROUTES.salePattern,
    title: 'Détail d’une vente',
    roles: ROLE_SETS.saleRead,
    purpose: 'Le reçu de la vente, imprimable, et son annulation.',
    actions: [
      act(
        'read',
        'Imprimer ou montrer le reçu',
        'Le reçu se compose sur le téléphone ; le numéro officiel arrive avec la synchronisation.',
      ),
      act(
        'cancel',
        'Annuler la vente',
        'Immédiat pour le vendeur dans le délai prévu (15 minutes par défaut) ; sinon la demande part en validation. Un motif est obligatoire.',
        {
          roles: ROLE_SETS.saleRecord,
        },
      ),
    ],
  },
  {
    path: ROUTES.newOrder,
    title: 'Nouvelle commande',
    purpose:
      'Prendre la commande d’un client identifié : emplacement de préparation, articles au prix du catalogue (figé dans la commande), date et adresse de livraison facultatives, acompte facultatif. Une commande ne dépend jamais de l’argent : elle se livre payée.',
    actions: [
      act(
        'create',
        'Passer une commande',
        'À son application, le serveur vend le disponible et laisse le reste en attente de stock.',
      ),
    ],
    next: [go('Commandes', ROUTES.orders, 'suivre les livraisons')],
  },
  {
    path: ROUTES.orders,
    title: 'Commandes',
    purpose:
      'Les commandes à confirmer, à livrer et livrées. Les commandes ouvertes viennent du téléphone ; les commandes livrées ou closes se lisent en ligne.',
    actions: [
      act('read', 'Suivre une commande', 'Touchez-la pour la progression de chaque ligne.'),
      act('go', 'Prendre une nouvelle commande', 'Ouvre l’écran de commande.', {
        roles: ROLE_SETS.orderCreate,
        to: ROUTES.newOrder,
      }),
    ],
  },
  {
    path: ROUTES.orderPattern,
    title: 'Détail d’une commande',
    roles: ROLE_SETS.orderRead,
    purpose:
      'La progression de chaque ligne (commandé, vendu, livré, en attente de stock) et ce qu’on peut en faire.',
    actions: [
      act('update', 'Livrer', 'Remettre au client ce qui est vendu et pas encore livré.', {
        roles: ROLE_SETS.orderFulfil,
      }),
      act(
        'update',
        'Vendre le disponible',
        'Pour la part en attente de stock, quand du stock est arrivé.',
        { roles: ROLE_SETS.orderCreate },
      ),
      act(
        'cancel',
        'Annuler la commande',
        'Tant qu’aucune livraison n’a eu lieu ; un motif est demandé.',
        { roles: ROLE_SETS.orderCancel },
      ),
      act(
        'cancel',
        'Clôturer le reste',
        'Après une livraison partielle : le reliquat est abandonné.',
        { roles: ROLE_SETS.orderCancel },
      ),
    ],
  },
  {
    path: ROUTES.deliverPattern,
    title: 'Livrer une commande',
    roles: ROLE_SETS.orderFulfil,
    purpose:
      'Saisir les quantités remises au client, ligne par ligne, avec le nom de la personne qui reçoit. L’écran avertit du reste dû mais ne bloque pas : le serveur refuse en ligne une livraison non payée (sauf client autorisé au crédit) et la signale hors ligne.',
    actions: [
      act(
        'create',
        'Enregistrer la livraison',
        'Quantités plafonnées à ce qui est vendu et pas encore livré.',
      ),
      act('go', 'Encaisser le reste dû', 'Mène à l’encaissement du client.', {
        roles: ROLE_SETS.paymentRecord,
        to: ROUTES.collect,
      }),
    ],
  },
  {
    path: ROUTES.collect,
    title: 'Encaisser une créance',
    purpose:
      'Enregistrer un règlement reçu d’un client : montant, moyen, référence, compte de réception. L’affectation est automatique : l’échéance la plus ancienne d’abord, le reste en avoir du client.',
    actions: [
      act(
        'create',
        'Encaisser',
        'Possible sans réseau ; l’écran montre l’aperçu de l’affectation avant l’envoi.',
      ),
    ],
    next: [go('Créances', ROUTES.receivables, 'voir ce qui reste dû')],
  },
  {
    path: ROUTES.cash,
    title: 'Caisse du point de vente',
    purpose:
      'Ouvrir la caisse avec le fonds compté, puis la clôturer en comptant l’espèce. Le comptage est à l’aveugle : l’attendu et l’écart s’affichent après l’enregistrement. Un écart part en validation de la Finance.',
    actions: [
      act('create', 'Ouvrir la caisse', 'Comptez le fonds de caisse.'),
      act(
        'update',
        'Clôturer la caisse',
        'Comptez l’espèce ; le serveur calcule l’attendu et l’écart.',
      ),
    ],
    next: [go('Remises de fonds', ROUTES.cashTransfers, 'remettre l’espèce à la Finance')],
  },
  {
    path: ROUTES.cashTransfers,
    title: 'Remises de fonds',
    purpose:
      'Remettre des fonds d’une caisse vers une destination admise, annuler une remise non reçue, ou recevoir une remise arrivée sur l’une de vos caisses. Un écart annoncé à la réception part en validation de la Finance.',
    actions: [
      act('create', 'Envoyer une remise', 'Montant et destination.'),
      act(
        'cancel',
        'Annuler une remise envoyée',
        'Tant qu’elle n’est pas reçue ; motif obligatoire.',
      ),
      act('create', 'Recevoir une remise', 'Montant reçu ; un écart est signalé à la Finance.'),
    ],
  },
  {
    path: ROUTES.posHome,
    title: 'Accueil du point de vente',
    purpose:
      'La journée du point de vente en un coup d’œil : caisse du jour, stock de l’emplacement de vente avec ses seuils, vos quotas et leur libération, ventes du jour, accès aux opérations.',
    actions: [
      act(
        'read',
        'Voir le stock et les ventes du jour',
        'Disponible du téléphone, seuils, ventes connues.',
      ),
      act('update', 'Libérer un quota', 'Rendre au stock ce qui n’est pas vendu.', {
        roles: ROLE_SETS.allocationRelease,
      }),
    ],
    next: [
      go('Nouvelle vente', ROUTES.newSale, 'vendre'),
      go('Demander un réapprovisionnement', ROUTES.replenish, 'quand le stock baisse'),
    ],
  },
  {
    path: ROUTES.replenish,
    title: 'Demande de réapprovisionnement',
    purpose:
      'Demander du stock à la source du point de vente. Les produits sous leur seuil sont suggérés ; rien n’est demandé automatiquement.',
    actions: [
      act(
        'create',
        'Envoyer une demande',
        'Produits et quantités ; le magasinier l’expédie ou la refuse.',
      ),
      act('cancel', 'Annuler ma demande', 'Tant qu’elle n’est pas expédiée.'),
    ],
  },
  {
    path: ROUTES.distribution,
    title: 'Distribution par point de vente',
    purpose:
      'Pour chaque point de vente et la période choisie : envoyé, reçu, vendu, perdu, restant, encaissé et à réapprovisionner, avec la caisse et les appareils. Lecture en ligne.',
    actions: [
      act(
        'read',
        'Comparer les points de vente',
        'Choisissez la période ; les mesures masquées par vos droits ne s’affichent pas.',
        { online: true },
      ),
    ],
  },
];
