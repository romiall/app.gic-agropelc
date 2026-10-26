/**
 * Port du résolveur de destinataires (P9-05 ; ADR-072 §2 ; BR-NOT-001, BR-NOT-008 ; besoin B1).
 *
 * `identity` répond « quels rôles a cet utilisateur ? », jamais « quels utilisateurs tiennent ce rôle dans
 * ce périmètre ? ». Le module `communication` exprime donc son besoin par ce port ; l'adaptateur
 * (`communication-api/identity-recipient-resolver.ts`) lit les affectations et les équipes, dans un seul
 * fichier que les fonctions publiques d'`identity` et d'`organization` remplaceront (B1).
 *
 * Tout est jugé à l'instant `at` passé (RC-01) ; un utilisateur inactif n'est jamais renvoyé.
 */
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';

/** Jeton d'injection de l'adaptateur (`communication-api/`, module global). */
export const ALERT_RECIPIENT_RESOLVER = Symbol('ALERT_RECIPIENT_RESOLVER');

/** Où se situe l'objet de l'alerte : le site, la zone (ou celle de son site) et ses propriétaires. */
export interface RecipientPerimeter {
  readonly siteId: string | null;
  readonly zoneId: string | null;
  readonly ownerUserIds: readonly string[];
}

export interface RoleHolder {
  readonly userId: string;
  readonly roleCode: string;
}

export interface AlertRecipientResolver {
  /**
   * Utilisateurs actifs dont une affectation active d'un des rôles couvre le périmètre : `GLOBAL` couvre
   * tout, `SITE` le site, `ZONE` la zone et ses descendantes (la zone d'un site à défaut de zone), `TEAM`
   * l'équipe dont un propriétaire est membre. Même couverture que `evaluateAccess` (RC-04).
   */
  usersHoldingRolesAt(
    uow: UnitOfWork,
    input: {
      readonly roles: readonly string[];
      readonly perimeter: RecipientPerimeter;
      readonly at: Date;
    },
  ): Promise<readonly RoleHolder[]>;

  /**
   * Utilisateurs actifs que `permission` autorise sur le périmètre (approbateurs d'une politique), à
   * l'exclusion des utilisateurs donnés (le demandeur ne s'approuve pas lui-même).
   */
  usersHoldingPermissionAt(
    uow: UnitOfWork,
    input: {
      readonly permission: string;
      readonly perimeter: RecipientPerimeter;
      readonly at: Date;
      readonly excludeUserIds: readonly string[];
    },
  ): Promise<readonly string[]>;

  /** Parmi ces utilisateurs, ceux qui sont actifs et ont une affectation de rôle active à `at`. */
  activeUsersAmong(
    uow: UnitOfWork,
    userIds: readonly string[],
    at: Date,
  ): Promise<readonly string[]>;

  /** Responsables des équipes actives dont ces utilisateurs sont membres à `at` (actifs et affectés eux-mêmes). */
  teamManagersOf(uow: UnitOfWork, userIds: readonly string[], at: Date): Promise<readonly string[]>;
}
