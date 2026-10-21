/**
 * Port du résolveur d'audience des notes de direction (P9-11 ; ADR-073 §3, §4 ; BR-NOT-006 ; AV-476).
 *
 * `communication` ne lit ni les affectations de rôle ni la géographie : il exprime son besoin par ce port, comme
 * pour les destinataires d'alerte (`recipients/recipient-resolver.ts`, besoin B1). L'adaptateur
 * (`communication-api/identity-note-audience-resolver.ts`) charge la géographie et les affectations ; **la règle
 * qui décide qui est touché est celle du domaine** (`note-audience.ts`), la même pour la publication, l'accusé et
 * la lecture : elles ne peuvent pas diverger.
 *
 * Tout est jugé à l'instant `at` passé (RC-01) ; un utilisateur inactif, ou sans affectation active, n'est jamais
 * touché.
 */
import type { NoteAudienceEntry } from '@gic/domain';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';

/** Jeton d'injection de l'adaptateur (`communication-api/`, module global). */
export const NOTE_AUDIENCE_RESOLVER = Symbol('NOTE_AUDIENCE_RESOLVER');

export interface NoteAudienceResolver {
  /**
   * Lignes dont la référence n'existe pas : rôle inconnu ou inactif, site, zone ou utilisateur inconnu. Une
   * faute de frappe donnerait sinon une note qui ne touche personne.
   */
  unknownReferences(
    uow: UnitOfWork,
    entries: readonly NoteAudienceEntry[],
  ): Promise<readonly NoteAudienceEntry[]>;

  /** Utilisateurs touchés à `at` (actifs et affectés), triés : la résolution faite à la publication. */
  usersInAudienceAt(
    uow: UnitOfWork,
    entries: readonly NoteAudienceEntry[],
    at: Date,
  ): Promise<readonly string[]>;

  /** L'utilisateur est-il touché à `at` ? */
  includesUserAt(
    uow: UnitOfWork,
    userId: string,
    entries: readonly NoteAudienceEntry[],
    at: Date,
  ): Promise<boolean>;
}
