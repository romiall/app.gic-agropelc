/** Aide des pages des achats (AV-525) : demandes, fournisseurs, bons de commande, réceptions, rapprochement. */
import { ROLE_SETS, ROUTES } from '../../../app/screens.js';
import type { ScreenHelp } from '../help-types.js';
import { act, go } from './helpers.js';

export const PROCUREMENT_HELP: readonly ScreenHelp[] = [
  {
    path: ROUTES.purchaseRequests,
    title: 'Demandes d’achat',
    purpose:
      'Exprimer un besoin (aliment, médicaments, matériel) et suivre la réponse du responsable des achats. Une demande acceptée devient un bon de commande.',
    actions: [
      act(
        'create',
        'Faire une demande d’achat',
        'Site demandeur, produits, quantités et justification. Possible sans réseau.',
      ),
      act(
        'read',
        'Suivre mes demandes',
        'État de chaque demande : soumise, approuvée, refusée, annulée.',
      ),
      act(
        'validate',
        'Instruire les demandes',
        'Les demandes à décider arrivent dans la file Validations.',
        {
          roles: ['RESP_ACHATS'],
          to: ROUTES.approvals,
        },
      ),
    ],
    next: [
      go('Bons de commande', ROUTES.purchaseOrders, 'ce que le responsable des achats en fait'),
    ],
  },
  {
    path: ROUTES.suppliers,
    title: 'Fournisseurs',
    purpose:
      'La fiche des fournisseurs : coordonnées, produits fournis, état actif ou non. Lecture et écriture en ligne.',
    actions: [
      act('create', 'Ajouter un fournisseur', 'Nom, contact, produits habituels.', {
        online: true,
      }),
      act('update', 'Modifier une fiche', 'Mettre à jour les coordonnées ou les produits.', {
        online: true,
      }),
      act(
        'cancel',
        'Désactiver ou réactiver',
        'Un fournisseur désactivé n’apparaît plus dans les nouveaux bons de commande ; son historique reste.',
        { online: true },
      ),
    ],
  },
  {
    path: ROUTES.purchaseOrders,
    title: 'Bons de commande',
    purpose:
      'Commander auprès d’un fournisseur ce que les demandes ont approuvé, suivre les livraisons et le reliquat. Un bon au-dessus du seuil est validé par la Direction.',
    actions: [
      act(
        'create',
        'Créer un bon de commande',
        'Fournisseur, site de livraison, lignes (produit, quantité, prix).',
        { online: true },
      ),
      act(
        'update',
        'Modifier et soumettre',
        'Un bon se modifie tant qu’il n’est pas envoyé ; il se soumet à validation si besoin.',
        { online: true },
      ),
      act('update', 'Marquer comme envoyé', 'Une fois transmis au fournisseur.', { online: true }),
      act(
        'cancel',
        'Annuler ou clore le reliquat',
        'Annuler un bon, ou clore ce qui n’a pas été livré.',
        { online: true },
      ),
    ],
    next: [
      go('Réceptions', ROUTES.purchaseReceipts, 'à la livraison, le magasinier réceptionne'),
      go('Rapprochement', ROUTES.orderMatching, 'commandé, livré, facturé, payé'),
    ],
  },
  {
    path: ROUTES.purchaseReceipts,
    title: 'Réceptions d’achat',
    purpose:
      'Faire entrer en stock ce qu’un fournisseur a livré : les bons de commande attendus sur votre site, ou une livraison sans bon de commande (animaux, aliment achetés au comptant).',
    before: [
      'Pour réceptionner un bon de commande, il doit avoir été envoyé au fournisseur et être destiné à votre site.',
      'Pour les animaux d’un lot : la réception sans bon de commande est le chemin le plus court (voir ci-dessous).',
    ],
    actions: [
      act(
        'create',
        'Réceptionner un bon de commande',
        'Touchez le bon : pour chaque ligne, quantités livrée, rejetée et acceptée ; photo du bon de livraison.',
        {
          to: ROUTES.purchaseReceipts,
        },
      ),
      act(
        'create',
        'Réceptionner sans bon de commande',
        'Fournisseur, produits et prix unitaire (obligatoire) ; pour un produit suivi par lot, le code du lot fournisseur. Revue ensuite par les Achats.',
        {
          to: ROUTES.purchaseReceiptFree,
        },
      ),
    ],
    next: [
      go('Nouveau lot', ROUTES.lotSetup, 'pour faire entrer des animaux réceptionnés dans un lot'),
      go('Stock', ROUTES.stock, 'pour voir l’entrée en stock'),
    ],
  },
  {
    path: ROUTES.purchaseReceiptPattern,
    title: 'Réception d’un bon de commande',
    roles: ROLE_SETS.purchaseReceipt,
    purpose:
      'Compter la livraison ligne par ligne : ce qui est livré, rejeté, accepté. Les quantités acceptées entrent en stock ; le reliquat reste dû par le fournisseur.',
    actions: [
      act(
        'create',
        'Enregistrer la réception',
        'Quantités par ligne ; le bon de livraison se photographie et se joint.',
      ),
    ],
    next: [go('Stock', ROUTES.stock, 'pour voir l’entrée en stock')],
  },
  {
    path: ROUTES.purchaseReceiptFree,
    title: 'Réception sans bon de commande',
    roles: ROLE_SETS.purchaseReceipt,
    purpose:
      'Enregistrer un achat comptant livré sans bon de commande : poussins, porcelets, aliment. Le prix unitaire est obligatoire (il fonde le coût du lot) ; un produit suivi par lot demande le code de lot du fournisseur.',
    before: [
      'Le fournisseur et les produits achetables sont au catalogue ; sinon demandez au responsable des achats et à l’administrateur de les créer.',
    ],
    actions: [
      act(
        'create',
        'Enregistrer la réception',
        'Fournisseur, produits, quantités, prix unitaires, emplacement de réception.',
      ),
    ],
    next: [
      go('Nouveau lot', ROUTES.lotSetup, 'pour faire entrer les animaux réceptionnés dans un lot'),
    ],
  },
  {
    path: ROUTES.orderMatching,
    title: 'Rapprochement commande, réception, facture',
    purpose:
      'Pour chaque bon de commande : commandé, livré, accepté, facturé, payé. L’outil pour repérer ce qui manque ou ce qui est facturé en trop.',
    actions: [
      act(
        'read',
        'Suivre un bon de commande de bout en bout',
        'Les écarts entre quantités et montants sont signalés.',
        { online: true },
      ),
    ],
    next: [
      go('Factures fournisseurs', ROUTES.supplierInvoices, 'pour traiter un écart de facture'),
    ],
  },
];
