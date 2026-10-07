/**
 * Catalogue des rôles pour l'accueil (ECR-ADM-03, UX-01 ; ADR-030) : libellé, périmètre de lecture
 * et **actions du jour** (gros boutons d'action en tête de page). Une action n'a de `route` que si
 * l'écran existe dans la PWA ; sinon elle s'affiche « bientôt » et ne mène nulle part : on n'affiche
 * jamais un bouton qui ne fait rien en prétendant le contraire. Le contenu des actions suit
 * `docs/01-functional/04-acteurs-et-roles.md` §2 (« journées et actions principales »).
 */
import type { HomeAction } from '@gic/contracts';

export type ScopeKind = 'ALL' | 'OWN' | 'TEAM' | 'SITES';

export interface RoleDefinition {
  readonly code: string;
  readonly label: string;
  readonly scopeKind: ScopeKind;
  /** Rôles propriétaires de conflits lus par ce rôle ; `ALL` : tous les conflits ouverts. */
  readonly conflictRoles: readonly string[] | 'ALL';
  readonly actions: readonly HomeAction[];
}

const action = (
  code: string,
  label: string,
  options: { readonly primary?: boolean; readonly hint?: string; readonly route?: string } = {},
): HomeAction => ({
  code,
  label,
  hint: options.hint ?? null,
  route: options.route ?? null,
  primary: options.primary ?? false,
});

/** Écran de suivi de la synchronisation, seul écran métier existant en dehors de l'accueil. */
const SYNC_ROUTE = '/synchronisation';

export const ROLE_CATALOG: Readonly<Record<string, RoleDefinition>> = {
  DIRECTION: {
    code: 'DIRECTION',
    label: 'Direction',
    scopeKind: 'ALL',
    conflictRoles: 'ALL',
    actions: [
      action('CONTROL_TOWER', 'Tour de contrôle', {
        primary: true,
        hint: 'Vue globale de l’activité',
      }),
      action('VALIDATIONS', 'Validations', { hint: 'Opérations au-dessus des seuils' }),
      action('PRICES', 'Tarifs', { hint: 'Activer les règles de prix' }),
      action('SYNC_STATUS', 'Synchronisation', { route: SYNC_ROUTE }),
    ],
  },
  ADMIN: {
    code: 'ADMIN',
    label: 'Administrateur',
    scopeKind: 'ALL',
    conflictRoles: 'ALL',
    actions: [
      action('DEVICES', 'Appareils', { primary: true, hint: 'Approuver, bloquer' }),
      action('USERS', 'Utilisateurs et rôles'),
      action('ORGANIZATION', 'Organisation', { hint: 'Sites, emplacements, zones' }),
      action('SETTINGS', 'Paramètres et politiques'),
      action('SYNC_STATUS', 'Synchronisation', { route: SYNC_ROUTE }),
    ],
  },
  FINANCE: {
    code: 'FINANCE',
    label: 'Finance',
    scopeKind: 'ALL',
    conflictRoles: ['FINANCE'],
    actions: [
      action('RECEIVABLES', 'Créances', { primary: true, hint: 'Suivi et relances' }),
      action('PAYMENTS', 'Encaissements'),
      action('CASH_SESSIONS', 'Valider les caisses'),
      action('EXPENSES', 'Dépenses et fournisseurs'),
    ],
  },
  RESP_COMMERCIAL: {
    code: 'RESP_COMMERCIAL',
    label: 'Responsable commercial',
    scopeKind: 'TEAM',
    conflictRoles: ['RESP_COMMERCIAL'],
    actions: [
      action('TEAM', 'Suivre l’équipe', { primary: true, hint: 'Présences, visites, ventes' }),
      action('TARGETS', 'Objectifs'),
      action('REASSIGN', 'Réaffecter un client'),
      action('DISCOUNTS', 'Valider les remises'),
    ],
  },
  COMMERCIAL_TERRAIN: {
    code: 'COMMERCIAL_TERRAIN',
    label: 'Commercial terrain',
    scopeKind: 'OWN',
    conflictRoles: [],
    actions: [
      action('START_SERVICE', 'PRENDRE SERVICE', {
        primary: true,
        hint: 'Pointer votre arrivée sur le terrain',
      }),
      action('NEW_PROSPECT', '+ PROSPECT'),
      action('NEW_VISIT', '+ VISITE'),
      action('NEW_SALE', '+ VENTE'),
      action('NEW_ORDER', '+ COMMANDE'),
    ],
  },
  COMMERCIAL_SEDENTAIRE: {
    code: 'COMMERCIAL_SEDENTAIRE',
    label: 'Commercial sédentaire',
    scopeKind: 'OWN',
    conflictRoles: [],
    actions: [
      action('NEW_ORDER', '+ COMMANDE', { primary: true }),
      action('NEW_SALE', '+ VENTE'),
      action('KOMMO_LEADS', 'Clients Kommo'),
      action('FOLLOW_DELIVERIES', 'Suivre les livraisons'),
    ],
  },
  VENDEUR_PDV: {
    code: 'VENDEUR_PDV',
    label: 'Vendeur de point de vente',
    scopeKind: 'SITES',
    conflictRoles: [],
    actions: [
      action('NEW_SALE', '+ VENTE', { primary: true, hint: 'Enregistrer une vente et encaisser' }),
      action('CASH_OPEN', 'Ouvrir la caisse'),
      action('LOSS', 'Déclarer une perte'),
      action('RECEIVE_TRANSFER', 'Recevoir un transfert'),
      action('CASH_CLOSE', 'Clôturer la caisse'),
    ],
  },
  RESP_PRODUCTION: {
    code: 'RESP_PRODUCTION',
    label: 'Responsable production',
    scopeKind: 'ALL',
    conflictRoles: ['RESP_PRODUCTION'],
    actions: [
      action('LOTS', 'Lots de production', { primary: true }),
      action('MORTALITY', 'Valider les mortalités'),
      action('INCUBATIONS', 'Incubations'),
      action('LOT_COSTS', 'Coûts et marges des lots'),
    ],
  },
  RESP_FERME: {
    code: 'RESP_FERME',
    label: 'Responsable de ferme',
    scopeKind: 'SITES',
    conflictRoles: ['RESP_FERME'],
    actions: [
      action('DAILY_ENTRY', 'SAISIE DU JOUR', {
        primary: true,
        hint: 'Mortalité, intrants, pesées',
      }),
      action('EGG_COLLECTION', 'Collecte d’œufs'),
      action('RECEIPTS', 'Réceptions'),
      action('LOSS', 'Déclarer une perte'),
    ],
  },
  MAGASINIER: {
    code: 'MAGASINIER',
    label: 'Magasinier',
    scopeKind: 'SITES',
    conflictRoles: ['MAGASINIER'],
    actions: [
      action('RECEIVE', 'Réceptionner', { primary: true, hint: 'Livré, rejeté, accepté' }),
      action('TRANSFER', 'Transférer'),
      action('COUNT', 'Inventaire'),
      action('LOSS', 'Déclarer une perte'),
      action('STOCK_ALERTS', 'Alertes de stock'),
    ],
  },
  RESP_ACHATS: {
    code: 'RESP_ACHATS',
    label: 'Responsable achats',
    scopeKind: 'ALL',
    conflictRoles: ['RESP_ACHATS'],
    actions: [
      action('REQUESTS', 'Demandes d’achat', { primary: true }),
      action('ORDERS', 'Bons de commande'),
      action('RECEIPTS', 'Réceptions'),
      action('SUPPLIERS', 'Fournisseurs'),
    ],
  },
};

/** Ordre d'affichage des sections d'un utilisateur multi-rôles (UX-01 : union des rôles). */
export const ROLE_ORDER: readonly string[] = [
  'DIRECTION',
  'FINANCE',
  'RESP_COMMERCIAL',
  'COMMERCIAL_TERRAIN',
  'COMMERCIAL_SEDENTAIRE',
  'VENDEUR_PDV',
  'RESP_PRODUCTION',
  'RESP_FERME',
  'MAGASINIER',
  'RESP_ACHATS',
  'ADMIN',
];
