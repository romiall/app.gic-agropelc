/** Aide des pages des clients, du terrain et de l'équipe commerciale (AV-525). */
import { ROLE_SETS, ROUTES } from '../../../app/screens.js';
import type { ScreenHelp } from '../help-types.js';
import { act, go } from './helpers.js';

export const CRM_HELP: readonly ScreenHelp[] = [
  {
    path: ROUTES.portfolio,
    title: 'Mon portefeuille',
    purpose:
      'Vos comptes clients : recherche par nom ou téléphone, filtre par stade, prochaine action prévue en tête. Utilisable hors ligne sur le périmètre téléchargé.',
    actions: [
      act('read', 'Chercher un client', 'Nom, téléphone, stade du pipeline.'),
      act('go', 'Ajouter un prospect', 'Un nouveau contact rencontré.', {
        roles: ROLE_SETS.customerCreate,
        to: ROUTES.newProspect,
      }),
    ],
  },
  {
    path: ROUTES.newProspect,
    title: 'Nouveau prospect',
    purpose:
      'Enregistrer un contact : nom, téléphone ou position, zone et source. Un doublon de téléphone est signalé avant l’envoi ; le compte est aussitôt proposé à la vente.',
    actions: [
      act('create', 'Créer le prospect', 'Peu de champs obligatoires ; possible sans réseau.'),
    ],
    next: [go('Visite', ROUTES.newVisit, 'noter le résultat d’une visite')],
  },
  {
    path: ROUTES.newVisit,
    title: 'Nouvelle visite',
    purpose:
      'Noter une visite : le compte, le résultat (obligatoire), un commentaire et la prochaine action. La position est relevée à l’ouverture.',
    actions: [
      act(
        'create',
        'Enregistrer la visite',
        'Les signalements (hors session, loin du compte) sont annoncés avant l’envoi.',
      ),
    ],
  },
  {
    path: ROUTES.customerPattern,
    title: 'Fiche client',
    roles: ROLE_SETS.customerRead,
    purpose:
      'Un compte client : coordonnées, stade, crédit et encours, ventes des 7 derniers jours, commandes ouvertes, visites et échanges des 90 derniers jours. Raccourcis vers la vente, la commande, la visite et l’encaissement.',
    actions: [
      act(
        'create',
        'Vendre, commander, visiter',
        'Les boutons de l’en-tête ouvrent l’écran voulu avec le client déjà choisi.',
        { roles: ROLE_SETS.saleRecord },
      ),
      act('update', 'Modifier les coordonnées', 'Pour les comptes de votre portefeuille.', {
        roles: ROLE_SETS.customerUpdate,
      }),
      act('create', 'Noter un échange', 'Appel, SMS, courriel ou autre ; non modifiable ensuite.', {
        roles: ROLE_SETS.interactionRecord,
      }),
      act('go', 'Encaisser', 'Quand le client a un encours.', {
        roles: ROLE_SETS.paymentRecord,
        to: ROUTES.collect,
      }),
    ],
  },
  {
    path: ROUTES.interactionPattern,
    title: 'Noter un échange',
    roles: ROLE_SETS.interactionRecord,
    purpose:
      'Garder la trace d’un contact avec un client : canal, sens, résumé et prochaine action. Un échange enregistré ne se modifie plus.',
    actions: [act('create', 'Enregistrer l’échange', 'Possible sans réseau.')],
  },
  {
    path: ROUTES.reassignCustomers,
    title: 'Réaffectation de clients',
    purpose:
      'Confier des comptes clients à un autre commercial actif, avec un motif. Lecture et décision en ligne.',
    actions: [
      act(
        'update',
        'Réaffecter',
        'Filtrez par titulaire, stade ou texte, choisissez les comptes puis le nouveau commercial.',
        { online: true },
      ),
    ],
  },
  {
    path: ROUTES.performance,
    title: 'Mes objectifs',
    purpose:
      'Votre effort et vos objectifs avec leur réalisé. En ligne, le serveur calcule ; hors ligne, une estimation du téléphone couvre les visites, comptes visités, échanges et prospects.',
    actions: [
      act(
        'read',
        'Suivre ma progression',
        'Visites, prospects, chiffre d’affaires et quantités vendues (ces deux derniers en ligne).',
      ),
    ],
  },
  {
    path: ROUTES.targets,
    title: 'Gestion des objectifs',
    purpose:
      'Fixer les objectifs d’un commercial, d’une équipe ou d’un site, avec contrôle de chevauchement, et les annuler. En ligne.',
    actions: [
      act(
        'create',
        'Définir un objectif',
        'La Direction fixe par site, équipe ou commercial ; le responsable commercial pour lui-même et son équipe.',
        { online: true },
      ),
      act('cancel', 'Annuler un objectif', 'Un objectif annulé reste à l’historique.', {
        online: true,
      }),
    ],
  },
  {
    path: ROUTES.service,
    title: 'Prendre service',
    purpose:
      'Pointer votre arrivée sur le terrain (position relevée, zone reconnue) puis votre fin de service. Les visites de la journée se rattachent à la session de travail.',
    actions: [
      act(
        'create',
        'Prendre service',
        'Après des refus répétés (hors zone, position imprécise), une dérogation motivée ouvre une session en attente de validation.',
      ),
      act(
        'update',
        'Terminer le service',
        'La session se ferme ; à défaut, elle est close à 23 h 59.',
      ),
    ],
  },
  {
    path: ROUTES.teamActivity,
    title: 'Présences et activité de l’équipe',
    purpose:
      'Pour une équipe et un jour : prises et fins de service, tentatives refusées, demandes de dérogation en attente, visites et échanges. Lecture en ligne.',
    actions: [act('read', 'Suivre l’équipe', 'Choisissez l’équipe et le jour.', { online: true })],
  },
  {
    path: ROUTES.weeklyReport,
    title: 'Bilan de la semaine',
    purpose:
      'Le commercial rédige son bilan de la semaine (cinq rubriques) avec des chiffres calculés par le serveur, jamais saisis ; le responsable lit les bilans de son équipe et les marque « vus ».',
    actions: [
      act(
        'create',
        'Rédiger mon bilan',
        'Renvoyer le bilan le corrige tant que le responsable ne l’a pas vu.',
        { roles: ['COMMERCIAL_TERRAIN', 'COMMERCIAL_SEDENTAIRE'] },
      ),
      act('validate', 'Marquer un bilan comme vu', 'Avec un commentaire éventuel.', {
        roles: ['RESP_COMMERCIAL', 'DIRECTION'],
      }),
    ],
  },
];
