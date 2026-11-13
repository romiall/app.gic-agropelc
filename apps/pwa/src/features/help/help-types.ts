/**
 * Aide contextuelle et guide de l'application (AV-525, ADR-058). Le contenu est un module de données
 * typé : chaque écran dit à quoi il sert, ce que l'on y peut faire (et qui le peut), ce qu'il faut avoir
 * fait avant et où aller ensuite. La même donnée alimente le panneau « Aide » de chaque page, le guide de
 * l'application (`/aide`) et le guide écrit de `docs/11-guide-utilisateur/` (un essai garde les trois
 * d'accord, et un autre garde le contenu d'accord avec le registre des écrans).
 */

/** Nature d'une action, pour la repérer d'un coup d'œil (créer, consulter, corriger…). */
export type HelpKind = 'create' | 'read' | 'update' | 'cancel' | 'validate' | 'export' | 'go';

export interface HelpAction {
  /** Ce que l'on peut faire, court (« Créer un lot »). */
  readonly label: string;
  /** En une ou deux phrases : ce que cela fait, ce que cela suppose. */
  readonly what: string;
  /** Rôles qui peuvent le faire ; à défaut, ceux de l'écran. */
  readonly roles?: readonly string[];
  /** Écran où l'action se fait, quand ce n'est pas celui-ci. */
  readonly to?: string;
  readonly kind?: HelpKind;
  /** Demande le réseau (le serveur doit contrôler l'opération). */
  readonly online?: boolean;
}

export interface HelpLink {
  readonly label: string;
  readonly to: string;
  /** Pourquoi y aller (« pour faire entrer les animaux »). */
  readonly why: string;
}

export interface ScreenHelp {
  /** Motif de route de l'écran (`/production/lots/:lotId`), tel que le routeur le déclare. */
  readonly path: string;
  /** Titre de la page. */
  readonly title: string;
  /**
   * Rôles de l'écran quand il n'a pas d'entrée propre dans le registre (écran de détail) ; sinon ceux du
   * registre (`SCREENS`).
   */
  readonly roles?: readonly string[] | 'ALL';
  /** À quoi sert la page, en une ou deux phrases. */
  readonly purpose: string;
  /** Ce qu'il faut avoir fait avant (préalables) ; pourquoi la page peut paraître vide. */
  readonly before?: readonly string[];
  readonly actions: readonly HelpAction[];
  /** Étapes suivantes du parcours. */
  readonly next?: readonly HelpLink[];
}

/** Une étape d'un parcours : où aller, qui le fait, ce qu'il y fait. */
export interface JourneyStep {
  readonly to: string;
  /** Rôles qui font cette étape ; à défaut, ceux de l'écran. */
  readonly roles?: readonly string[];
  readonly label: string;
  readonly what: string;
}

export interface Journey {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  /** Rôles pour qui le parcours est écrit (celui qui l'accomplit de bout en bout). */
  readonly roles: readonly string[];
  readonly steps: readonly JourneyStep[];
}

export interface FaqItem {
  readonly question: string;
  readonly answer: string;
}

/** Libellé d'un rôle, tel que l'accueil le donne. */
export const ROLE_LABELS: Readonly<Record<string, string>> = {
  DIRECTION: 'Direction',
  ADMIN: 'Administrateur',
  RESP_COMMERCIAL: 'Responsable commercial',
  COMMERCIAL_TERRAIN: 'Commercial terrain',
  COMMERCIAL_SEDENTAIRE: 'Commercial sédentaire',
  VENDEUR_PDV: 'Vendeur de point de vente',
  RESP_PRODUCTION: 'Responsable production',
  RESP_FERME: 'Responsable de ferme',
  MAGASINIER: 'Magasinier',
  RESP_ACHATS: 'Responsable achats',
  FINANCE: 'Finance',
  SUPERVISION: 'Supervision consultative',
};

export const roleLabel = (code: string): string => ROLE_LABELS[code] ?? code;
