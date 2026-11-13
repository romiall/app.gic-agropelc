/** Aide des pages du stock (AV-525) : soldes, transferts, réceptions, pertes, inventaires, consommations, registre, quotas. */
import { ROLE_SETS, ROUTES } from '../../../app/screens.js';
import type { ScreenHelp } from '../help-types.js';
import { act, go } from './helpers.js';

export const STOCK_HELP: readonly ScreenHelp[] = [
  {
    path: ROUTES.stock,
    title: 'Stock par emplacement',
    purpose:
      'Les soldes de ce que vous détenez : produits, quantités et valeur par emplacement (magasin, bâtiment, point de vente, stock mobile), avec le disponible net des quotas des autres appareils. Une pastille signale les produits sous leur seuil.',
    before: [
      'Vous ne voyez que les emplacements de votre périmètre : votre site (magasinier, responsable de ferme, vendeur), tous les sites (Direction, Administrateur, Responsable de production).',
      'Les soldes se téléchargent à la connexion et se mettent à jour à chaque synchronisation ; hors ligne, ils montrent le dernier état connu plus vos propres opérations en attente.',
    ],
    actions: [
      act(
        'read',
        'Consulter les soldes',
        'Recherche par produit ; filtre « sous le seuil » (alertes de stock).',
      ),
      act('go', 'Transférer', 'Envoyer du stock vers un autre emplacement.', {
        roles: ROLE_SETS.transferDispatch,
        to: ROUTES.transfer,
      }),
      act('go', 'Recevoir un transfert', 'Accepter ce qui vous est envoyé.', {
        roles: ROLE_SETS.transferReceive,
        to: ROUTES.receive,
      }),
      act('go', 'Déclarer une perte', 'Casse, péremption, vol, mortalité hors lot…', {
        roles: ROLE_SETS.lossDeclare,
        to: ROUTES.loss,
      }),
      act(
        'go',
        'Faire un inventaire',
        'Compter physiquement et laisser le système calculer l’écart.',
        {
          roles: ROLE_SETS.countPerform,
          to: ROUTES.count,
        },
      ),
      act(
        'go',
        'Régler les seuils d’alerte',
        'Le minimum sous lequel un produit est signalé, et la cible du réapprovisionnement.',
        {
          roles: ROLE_SETS.thresholdManage,
          to: ROUTES.thresholds,
        },
      ),
      act('go', 'Enregistrer une consommation', 'Intrants et emballages utilisés hors lot.', {
        roles: ROLE_SETS.consumptionRecord,
        to: ROUTES.consumption,
      }),
      act(
        'read',
        'Voir le registre des mouvements',
        'Chaque entrée et sortie, pour expliquer un écart.',
        {
          roles: ROLE_SETS.stockLedger,
          to: ROUTES.stockLedger,
          online: true,
        },
      ),
    ],
    next: [
      go(
        'Réceptions d’achat',
        ROUTES.purchaseReceipts,
        'pour faire entrer de la marchandise achetée',
      ),
    ],
  },
  {
    path: ROUTES.transfer,
    title: 'Transferts',
    purpose:
      'Préparer et expédier du stock d’un emplacement vers un autre (magasin, point de vente, commercial, ferme), répondre aux demandes de réapprovisionnement, et déplacer du stock à l’intérieur d’un site.',
    before: [
      'Du stock disponible à l’emplacement d’origine ; un destinataire déclaré (point de vente, commercial, autre magasin).',
    ],
    actions: [
      act(
        'create',
        'Expédier un transfert',
        'Choisissez l’origine, la destination et les lignes (produit, quantité) : la marchandise passe « en transit » jusqu’à la réception.',
      ),
      act(
        'update',
        'Répondre à une demande',
        'Expédier ou refuser (avec motif) une demande de réapprovisionnement d’un point de vente.',
      ),
      act(
        'update',
        'Déplacer dans le site',
        'Mouvement interne entre deux emplacements du même site, sans transit.',
      ),
      act(
        'cancel',
        'Annuler un transfert',
        'Tant qu’il n’est pas reçu : le serveur refuse l’annulation une fois la réception saisie.',
      ),
    ],
    next: [go('Réceptions', ROUTES.receive, 'ce que le destinataire accepte à l’arrivée')],
  },
  {
    path: ROUTES.transferPattern,
    title: 'Détail d’un transfert',
    roles: ROLE_SETS.transferDispatch,
    purpose:
      'Les lignes, l’état (demandé, en transit, reçu, refusé) et les actions possibles sur un transfert.',
    actions: [
      act(
        'read',
        'Consulter le transfert',
        'Origine, destination, lignes, quantités envoyées et reçues.',
      ),
      act('update', 'Expédier ou refuser', 'Pour une demande reçue d’un point de vente.'),
      act(
        'cancel',
        'Annuler',
        'Tant que le destinataire ne l’a pas reçu : le serveur refuse l’annulation une fois la réception saisie.',
      ),
    ],
  },
  {
    path: ROUTES.receive,
    title: 'Réceptions de transfert',
    purpose:
      'Les transferts qui vous sont destinés : vérifier ce qui arrive, accepter ou signaler un écart.',
    actions: [
      act(
        'read',
        'Voir les transferts attendus',
        'En transit vers vous, du plus ancien au plus récent.',
      ),
      act(
        'create',
        'Recevoir',
        'Comptez à l’arrivée : la quantité reçue entre en stock ; un écart est annoncé et part en validation.',
      ),
      act(
        'create',
        'Recevoir sans document',
        'Marchandise arrivée sans transfert saisi : à rapprocher ensuite du transfert d’origine.',
        {
          to: ROUTES.blindReceipt,
        },
      ),
    ],
  },
  {
    path: ROUTES.receivePattern,
    title: 'Réception d’un transfert',
    roles: ROLE_SETS.transferReceive,
    purpose: 'Compter ce qui est arrivé, ligne par ligne, et enregistrer la réception.',
    actions: [
      act(
        'create',
        'Enregistrer la réception',
        'Quantité reçue par ligne ; un écart avec l’envoi est signalé et validé par un responsable.',
      ),
    ],
    next: [go('Stock', ROUTES.stock, 'pour voir l’entrée en stock')],
  },
  {
    path: ROUTES.blindReceipt,
    title: 'Réception sans document',
    roles: ROLE_SETS.transferReceive,
    purpose:
      'Enregistrer une marchandise arrivée sans transfert saisi. Elle reste à rapprocher du transfert d’origine ; sans rapprochement dans les 48 h, une alerte le signale.',
    actions: [
      act(
        'create',
        'Enregistrer la réception sans document',
        'Produit, quantité, provenance déclarée : entrée en stock immédiate, rapprochement ensuite.',
      ),
    ],
  },
  {
    path: ROUTES.loss,
    title: 'Déclarer une perte',
    purpose:
      'Sortir du stock une marchandise perdue (casse, péremption, vol, mortalité hors lot…) avec sa cause et, au besoin, une photo. Selon la politique, la perte attend la validation d’un responsable.',
    before: [
      'Pour la mortalité d’un lot de production, utilisez plutôt la saisie du jour du lot : la perte y est rattachée au lot.',
    ],
    actions: [
      act(
        'create',
        'Déclarer une perte',
        'Emplacement, produit, quantité, motif ; photo facultative. En ligne, le serveur refuse au-delà du disponible.',
      ),
    ],
    next: [go('Validations', ROUTES.approvals, 'pour suivre la décision du responsable')],
  },
  {
    path: ROUTES.count,
    title: 'Inventaire',
    purpose:
      'Compter physiquement un emplacement : le système calcule l’écart avec le stock théorique. Le comptage se fait sans réseau ; la validation des écarts se fait en ligne, par un responsable.',
    actions: [
      act('create', 'Ouvrir un inventaire', 'Choisissez l’emplacement à compter.'),
      act(
        'update',
        'Saisir les quantités comptées',
        'Ligne par ligne ; l’écart estimé s’affiche, l’écart réel est calculé par le serveur.',
      ),
      act(
        'validate',
        'Soumettre le comptage',
        'Les écarts partent en validation ; une fois décidés, ils ajustent le stock.',
      ),
      act('cancel', 'Annuler l’inventaire', 'Avant sa soumission, sans effet sur le stock.'),
    ],
    next: [go('Validations', ROUTES.approvals, 'où le responsable décide des écarts')],
  },
  {
    path: ROUTES.consumption,
    title: 'Consommation d’intrants',
    purpose:
      'Enregistrer ce qui a été consommé hors lot de production (aliment, médicament, emballage) : le stock baisse et le coût est imputé. Pour la consommation d’un lot, utilisez plutôt sa saisie du jour.',
    actions: [
      act(
        'create',
        'Enregistrer une consommation',
        'Emplacement, produit consommable, quantité et nature du coût.',
      ),
    ],
  },
  {
    path: ROUTES.stockLedger,
    title: 'Registre des mouvements',
    purpose:
      'Chaque entrée et chaque sortie de stock, datée et rattachée à son document : l’outil pour expliquer un écart. Lecture en ligne.',
    actions: [
      act(
        'read',
        'Chercher des mouvements',
        'Par période, emplacement, produit ou type d’opération.',
        { online: true },
      ),
      act('export', 'Exporter en CSV', 'La période affichée, pour la traiter dans un tableur.', {
        online: true,
      }),
    ],
  },
  {
    path: ROUTES.thresholds,
    title: 'Seuils d’alerte',
    purpose:
      'Pour chaque produit d’un emplacement : le minimum sous lequel il est signalé en alerte de stock, et la cible vers laquelle le réapprovisionnement le ramène. Chaque réglage crée une nouvelle version ; l’ancienne reste à l’historique.',
    before: ['L’emplacement doit déjà avoir du stock pour que ses produits soient proposés.'],
    actions: [
      act(
        'create',
        'Fixer un seuil',
        'Choisissez l’emplacement et le produit, puis le minimum et la cible (la cible au moins égale au minimum).',
      ),
      act(
        'update',
        'Modifier un seuil',
        'Le nouveau réglage remplace l’ancien, qui reste à l’historique ; les alertes se recalculent.',
      ),
    ],
    next: [go('Stock', ROUTES.stock, 'voir les produits sous leur seuil')],
  },
  {
    path: ROUTES.allocations,
    title: 'Quotas',
    purpose:
      'Accorder du stock d’un emplacement à un détenteur (point de vente, commercial) : le détenteur vend dans la limite de son quota, même sans réseau.',
    actions: [
      act('create', 'Accorder un quota', 'Produit, quantité, détenteur, échéance éventuelle.', {
        online: true,
      }),
      act('update', 'Augmenter un quota', 'Ajoute de la quantité à un quota existant.', {
        online: true,
      }),
      act('cancel', 'Révoquer ou libérer', 'Le non-vendu retourne au stock de l’emplacement.', {
        online: true,
      }),
    ],
  },
];
