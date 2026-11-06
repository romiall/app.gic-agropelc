/** Aide des pages de la finance (AV-525) : créances, dépenses, factures et paiements fournisseurs, trésorerie, coûts. */
import { ROLE_SETS, ROUTES } from '../../../app/screens.js';
import type { ScreenHelp } from '../help-types.js';
import { act } from './helpers.js';

export const FINANCE_HELP: readonly ScreenHelp[] = [
  {
    path: ROUTES.receivables,
    title: 'Créances',
    purpose:
      'Ce que les clients doivent : encours du jour (total, échu, à échoir, échu par tranche de retard), par client ou par titulaire, le plus en retard d’abord. Lecture en ligne ; hors ligne, la dernière lecture reste affichée.',
    actions: [
      act(
        'read',
        'Repérer les retards',
        'Filtrez par échéance, tranche ou site ; les ventes d’un groupe se déplient à la demande.',
        { online: true },
      ),
      act(
        'go',
        'Encaisser',
        '« Encaisser » et « Encaisser le reste dû » mènent à l’encaissement du client.',
        { roles: ROLE_SETS.paymentRecord, to: ROUTES.collect },
      ),
    ],
  },
  {
    path: ROUTES.expenses,
    title: 'Dépenses',
    purpose:
      'Saisir une dépense (transport, carburant, frais de la ferme) payée maintenant par une caisse ou à payer par la Finance, avec le justificatif en photo ; suivre les dépenses et les payer ou les annuler.',
    actions: [
      act(
        'create',
        'Saisir une dépense',
        'Catégorie, montant, mode de paiement, justificatif. Possible sans réseau ; la validation éventuelle se fait après coup hors ligne.',
        { roles: ROLE_SETS.expenseRecord },
      ),
      act('read', 'Suivre les dépenses', 'Le suivi (vue « suivi ») se lit en ligne.', {
        roles: ROLE_SETS.expenseFollow,
        online: true,
      }),
      act('validate', 'Payer une dépense à payer', 'Réservé à la Finance, en ligne.', {
        roles: ROLE_SETS.expensePay,
        online: true,
      }),
      act(
        'cancel',
        'Annuler la dépense d’un autre',
        'Pour les rôles qui approuvent les dépenses.',
        { roles: ROLE_SETS.expenseApprove, online: true },
      ),
    ],
  },
  {
    path: ROUTES.supplierInvoices,
    title: 'Factures fournisseurs',
    purpose:
      'Les dettes fournisseurs (dette, échu, avances, retards) et les factures par statut, avec les écarts de rapprochement en clair. Saisir une facture, la contester, l’approuver ou l’annuler.',
    actions: [
      act(
        'create',
        'Saisir une facture',
        'Fournisseur, lignes, photo de la facture ; rapprochée du bon de commande et de la réception.',
        { roles: ROLE_SETS.supplierInvoiceRecord, online: true },
      ),
      act('validate', 'Contester, approuver ou annuler', 'Jamais sa propre facture.', {
        roles: ROLE_SETS.supplierInvoiceApprove,
        online: true,
      }),
      act('read', 'Suivre les dettes', 'Lecture seule pour le responsable des achats.', {
        online: true,
      }),
    ],
  },
  {
    path: ROUTES.supplierPayments,
    title: 'Paiements fournisseurs',
    purpose:
      'Payer les fournisseurs, enregistrer et affecter les avances. Un paiement au-delà du seuil attend la décision de la Direction.',
    actions: [
      act(
        'create',
        'Saisir un paiement',
        'Fournisseur, moyen, compte, référence, factures concernées.',
        { roles: ROLE_SETS.supplierPaymentRecord, online: true },
      ),
      act('update', 'Affecter une avance', 'Imputer une avance à des factures.', {
        roles: ROLE_SETS.supplierPaymentRecord,
        online: true,
      }),
      act('validate', 'Décider d’un paiement', 'Dans la file des validations, pour la Direction.', {
        roles: ROLE_SETS.supplierPaymentApprove,
        to: ROUTES.approvals,
      }),
    ],
  },
  {
    path: ROUTES.treasury,
    title: 'Trésorerie',
    purpose:
      'Sessions de caisse à valider, écarts de remise à clore, remises en transit, dépenses à payer, paiements en attente de la Direction, comptes et leurs mouvements. En ligne.',
    actions: [
      act(
        'validate',
        'Valider une session de caisse',
        'Examinez le détail des flux, puis validez avec un motif.',
        { online: true },
      ),
      act('validate', 'Clore un écart de remise', 'Imputation et motif.', { online: true }),
      act('update', 'Recevoir une remise en transit', 'La Finance reçoit les fonds remis.', {
        online: true,
      }),
      act('read', 'Consulter les comptes', 'Soldes et mouvements de chaque compte.', {
        online: true,
      }),
    ],
  },
  {
    path: ROUTES.costsMargins,
    title: 'Coûts et marges',
    purpose:
      'Lecture seule : vue d’ensemble de la période (ventes et marge brute, encaissé, dépenses, créances, dettes, trésorerie), valeur des pertes, coûts et marges des lots. En ligne.',
    actions: [
      act('read', 'Analyser une période', 'Mois, semaine, jour, année ou dates libres.', {
        online: true,
      }),
      act('read', 'Ouvrir la fiche d’un lot', 'Détail des coûts et de la marge d’un lot.', {
        roles: ROLE_SETS.lotSheet,
        to: ROUTES.lotSheet,
      }),
    ],
  },
];
