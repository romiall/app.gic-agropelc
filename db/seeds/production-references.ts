/**
 * Référentiels et politiques par défaut de la production (P7-04). Le seed n'insère que les codes
 * absents — jamais de réécriture d'une valeur modifiée depuis par un administrateur.
 *
 * - Politiques de contrôle par défaut (DÉDUIT, décisions du porteur du projet) :
 *   `MORTALITY` — toute mortalité exige photo et validation du Responsable production (AV-048,
 *   seuils à 0 dans `condition`, réglables) ; `ANIMAL_COUNT_ADJUSTMENT` — tout écart
 *   d'inventaire sur des animaux est validé par le Responsable production (AV-108). Sans elles,
 *   une mortalité serait refusée (`CONTROL_POLICY_MISSING`).
 * - Motifs de rendement `PRODUCTION_YIELD` (BR-INC-003, AV-032, AV-114) : sorties de procédé qui
 *   ne sont pas des pertes accidentelles. Libellés DÉDUITS des règles.
 */
export interface ControlPolicySeed {
  readonly code: string;
  readonly operationType: string;
  readonly condition: Record<string, unknown>;
  readonly requiresPhoto: boolean;
  readonly requiresApproval: boolean;
  readonly approverPermission: string;
  readonly approverScope: 'SITE' | 'ZONE' | 'TEAM' | 'ALL';
  readonly ref: string;
}

export const CONTROL_POLICIES: readonly ControlPolicySeed[] = [
  {
    code: 'MORTALITY_DEFAULT',
    operationType: 'MORTALITY',
    condition: { relativePct: 0, absoluteHeads: 0 },
    requiresPhoto: true,
    requiresApproval: true,
    approverPermission: 'production.mortality.approve',
    approverScope: 'ALL',
    ref: 'AV-048',
  },
  {
    code: 'ANIMAL_COUNT_DEFAULT',
    operationType: 'ANIMAL_COUNT_ADJUSTMENT',
    condition: {},
    requiresPhoto: false,
    requiresApproval: true,
    approverPermission: 'production.mortality.approve',
    approverScope: 'ALL',
    ref: 'AV-108',
  },
];

export interface ReasonCodeSeed {
  readonly category: string;
  readonly code: string;
  readonly label: string;
}

export const PRODUCTION_REASON_CODES: readonly ReasonCodeSeed[] = [
  { category: 'PRODUCTION_YIELD', code: 'INFERTILE', label: 'Œuf infertile (mirage)' },
  {
    category: 'PRODUCTION_YIELD',
    code: 'MORTALITE_EMBRYONNAIRE',
    label: 'Mortalité embryonnaire (mirage)',
  },
  { category: 'PRODUCTION_YIELD', code: 'NON_ECLOS', label: 'Œuf non éclos' },
  { category: 'PRODUCTION_YIELD', code: 'POUSSIN_NON_VIABLE', label: 'Poussin non viable' },
  { category: 'PRODUCTION_YIELD', code: 'PERTE_ABATTAGE', label: 'Perte d’abattage (poids)' },
  { category: 'PRODUCTION_YIELD', code: 'SAISIE_SANITAIRE', label: 'Carcasse saisie' },
];
