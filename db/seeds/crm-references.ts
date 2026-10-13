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
 * - Motifs de départ (AV-248, tranché le 13/10/2026) : résultats de visite, perte d'un prospect,
 *   annulation ; `COMMANDE_PRISE` est un code figé (KPI-COM-12), `AUTRE` exige un commentaire.
 * - Catégories de clients (AV-017, tranché le 13/10/2026) : les cinq valeurs initiales.
 * Libellés français : DÉDUITS des codes (aucune source ne les fixe), ajustables au catalogue.
 */
import type { ReasonCodeSeed } from './production-references.js';
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

export const CRM_REASON_CODES: readonly ReasonCodeSeed[] = [
  { category: 'VISIT_OUTCOME', code: 'COMMANDE_PRISE', label: 'Commande prise' },
  { category: 'VISIT_OUTCOME', code: 'VENTE_REALISEE', label: 'Vente réalisée sur place' },
  { category: 'VISIT_OUTCOME', code: 'A_RELANCER', label: 'À relancer' },
  { category: 'VISIT_OUTCOME', code: 'PAS_INTERESSE', label: 'Pas intéressé' },
  { category: 'VISIT_OUTCOME', code: 'ABSENT', label: 'Client absent' },
  { category: 'VISIT_OUTCOME', code: 'AUTRE', label: 'Autre', requiresComment: true },
  { category: 'PROSPECT_LOST', code: 'PRIX_TROP_ELEVE', label: 'Prix trop élevé' },
  { category: 'PROSPECT_LOST', code: 'CONCURRENT', label: 'Parti chez un concurrent' },
  { category: 'PROSPECT_LOST', code: 'PAS_DE_BESOIN', label: 'Pas de besoin' },
  { category: 'PROSPECT_LOST', code: 'INJOIGNABLE', label: 'Injoignable' },
  { category: 'PROSPECT_LOST', code: 'HORS_ZONE', label: 'Hors zone' },
  { category: 'PROSPECT_LOST', code: 'AUTRE', label: 'Autre', requiresComment: true },
  { category: 'CANCELLATION', code: 'ERREUR_SAISIE', label: 'Erreur de saisie' },
  { category: 'CANCELLATION', code: 'DOUBLON', label: 'Doublon' },
  { category: 'CANCELLATION', code: 'DEMANDE_CLIENT', label: 'Demande du client' },
  { category: 'CANCELLATION', code: 'AUTRE', label: 'Autre', requiresComment: true },
];

export interface CustomerCategorySeed {
  readonly code: string;
  readonly name: string;
}

export const CUSTOMER_CATEGORIES: readonly CustomerCategorySeed[] = [
  { code: 'PARTICULIER', name: 'Particulier' },
  { code: 'REVENDEUR', name: 'Revendeur' },
  { code: 'RESTAURATION_HOTELLERIE', name: 'Restauration et hôtellerie' },
  { code: 'GROSSISTE', name: 'Grossiste' },
  { code: 'INSTITUTION', name: 'Institution' },
];
