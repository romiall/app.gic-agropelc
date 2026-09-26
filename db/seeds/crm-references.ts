/**
 * Référentiels CRM initiaux (P3-02) : valeurs par défaut documentées des AV, configurables
 * ensuite (`crm.pipeline.configure`). Le seed n'insère que les codes absents — jamais de
 * réécriture d'un libellé ou d'un ordre modifié depuis par un administrateur.
 *
 * - Étapes de pipeline : AV-011 (OUVERT) — « valeurs initiales NOUVEAU, CONTACTE, INTERESSE,
 *   NEGOCIATION » ; terminaux `CLIENT` et `PERDU` = stades système (`CUSTOMER`, `LOST`), pas des
 *   étapes (SM-CUSTOMER). La première étape active (ordre croissant) est l'étape d'entrée.
 * - Sources de prospect : AV-018 (OUVERT) ; `KOMMO` est une source système (BR-CRM-023 : un
 *   compte venu de Kommo porte cette source), non désactivable.
 * Libellés français : DÉDUITS des codes (aucune source ne les fixe).
 */
export interface CrmReferenceSeed {
  readonly code: string;
  readonly label: string;
  readonly sortOrder: number;
  readonly isSystem: boolean;
}

export const PIPELINE_STEPS: readonly CrmReferenceSeed[] = [
  { code: 'NOUVEAU', label: 'Nouveau', sortOrder: 10, isSystem: false },
  { code: 'CONTACTE', label: 'Contacté', sortOrder: 20, isSystem: false },
  { code: 'INTERESSE', label: 'Intéressé', sortOrder: 30, isSystem: false },
  { code: 'NEGOCIATION', label: 'Négociation', sortOrder: 40, isSystem: false },
];

export const LEAD_SOURCES: readonly CrmReferenceSeed[] = [
  { code: 'PROSPECTION_TERRAIN', label: 'Prospection terrain', sortOrder: 10, isSystem: false },
  { code: 'RECOMMANDATION', label: 'Recommandation', sortOrder: 20, isSystem: false },
  { code: 'KOMMO', label: 'Kommo', sortOrder: 30, isSystem: true },
  { code: 'RESEAU_SOCIAL', label: 'Réseau social', sortOrder: 40, isSystem: false },
  { code: 'VISITE_SPONTANEE', label: 'Visite spontanée', sortOrder: 50, isSystem: false },
  { code: 'AUTRE', label: 'Autre', sortOrder: 60, isSystem: false },
];
