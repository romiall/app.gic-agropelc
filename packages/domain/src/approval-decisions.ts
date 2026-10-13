/**
 * Décision d'une demande de validation selon son type d'opération (MP-07, ECR-ADM-08 ; ADR-018,
 * SM-APPROVAL) : ce que la file de validation propose et ce que la décision exige, partagé par la
 * lecture du serveur (`GET /approvals/inbox`) et l'écran de l'appareil (ADR-021).
 *
 * Les gestionnaires de décision des modules propriétaires restent seuls juges à la commande
 * (`approvals.request.approve` / `.reject`) ; ce catalogue décrit leurs exigences pour ne proposer que
 * des décisions possibles, et un test du serveur vérifie qu'il leur reste fidèle :
 * - acceptation seule, avec un motif : écarts de caisse et de remise (AV-159, AV-174), et imputation de
 *   l'écart d'une remise (AV-153) ; décidés dans la file comme dans la trésorerie (ses façades
 *   `finance.cash_session.validate`, `finance.cash_transfer.close_discrepancy` appellent la même
 *   décision), y compris l'ajustement tardif d'une session déjà validée que la trésorerie ne liste pas
 *   (S-51) ;
 * - issue d'un refus : perte ou mortalité, « erreur de déclaration » (la quantité revient, défaut) ou
 *   « perte non justifiée » (AV-038) ;
 * - sort de l'argent à l'approbation d'une annulation de vente payée (AV-146) ;
 * - référence corrigée facultative d'un encaissement suspect de doublon (AV-135) ;
 * - décision enregistrée sans effet sur l'opération (aucun gestionnaire : validation a posteriori d'une
 *   remise au-delà du plafond, AV-026, ou d'un dépassement d'encours, AV-028) ;
 * - montant au coût (valeur de stock) masqué sans `inventory.valuation.read` (RC-05).
 */
import { CASH_TRANSFER_IMPUTATIONS } from './cash-session.js';

/** Motif d'une décision (commentaire) : 2 000 caractères au plus ; obligatoire au refus. */
export const APPROVAL_COMMENT_MAX = 2000;

/** Valeur d'une donnée de décision (`decisionData`) : 200 caractères au plus. */
export const APPROVAL_DECISION_DATA_MAX = 200;

export interface ApprovalDecisionOptions {
  readonly values: readonly string[];
  /** Sans choix, la décision est refusée par le serveur (ou, au refus, l'issue par défaut s'applique). */
  readonly required: boolean;
  /** Issue appliquée sans choix. */
  readonly defaultValue?: string;
}

export interface ApprovalDecisionSpec {
  /** Refus permis. */
  readonly rejectable: boolean;
  /**
   * Motif obligatoire à l'approbation, remis au module propriétaire comme `decisionData.reason` (et
   * gardé comme commentaire de la décision).
   */
  readonly approveReasonRequired?: boolean;
  /** Choix à l'approbation (`decisionOption`). */
  readonly approveOptions?: ApprovalDecisionOptions;
  /** Choix au refus (`decisionOption`). */
  readonly rejectOptions?: ApprovalDecisionOptions;
  /** Données facultatives ou obligatoires à l'approbation (`decisionData`). */
  readonly approveData?: readonly { readonly key: string; readonly required: boolean }[];
  /** Décision enregistrée sans effet sur l'opération, déjà appliquée (validation a posteriori). */
  readonly recordOnly?: boolean;
  /** Montant de la demande = valeur au coût (RC-05). */
  readonly amountIsCost?: boolean;
}

const LOSS_REJECT: ApprovalDecisionOptions = {
  values: ['ERREUR_DECLARATION', 'PERTE_NON_JUSTIFIEE'],
  required: false,
  defaultValue: 'ERREUR_DECLARATION',
};

const STANDARD: ApprovalDecisionSpec = { rejectable: true };

export const APPROVAL_DECISION_SPECS: Readonly<Record<string, ApprovalDecisionSpec>> = {
  LOSS_DECLARATION: { rejectable: true, rejectOptions: LOSS_REJECT, amountIsCost: true },
  MORTALITY: { rejectable: true, rejectOptions: LOSS_REJECT, amountIsCost: true },
  INVENTORY_ADJUSTMENT: { rejectable: true, amountIsCost: true },
  ANIMAL_COUNT_ADJUSTMENT: { rejectable: true, amountIsCost: true },
  TRANSFER_DISCREPANCY: { rejectable: true, amountIsCost: true },
  SALE_CANCELLATION: {
    rejectable: true,
    approveOptions: { values: ['REFUND', 'CUSTOMER_CREDIT'], required: false },
  },
  PAYMENT_DUPLICATE: {
    rejectable: true,
    approveData: [{ key: 'correctedReference', required: false }],
  },
  PRICE_OVERRIDE: { rejectable: true, recordOnly: true },
  CREDIT_LIMIT_EXCEEDED: { rejectable: true, recordOnly: true },
  CASH_VARIANCE: { rejectable: false, approveReasonRequired: true },
  CASH_TRANSFER_DISCREPANCY: {
    rejectable: false,
    approveReasonRequired: true,
    approveOptions: { values: CASH_TRANSFER_IMPUTATIONS, required: true },
  },
};

/** Règle de décision d'un type ; un type sans règle propre s'approuve ou se refuse simplement. */
export function approvalDecisionSpec(operationType: string): ApprovalDecisionSpec {
  return APPROVAL_DECISION_SPECS[operationType] ?? STANDARD;
}

/**
 * INV-ADM-02, BR-ADM-017 (AV-010) : seule la Direction valide sa propre demande, et seulement avec le
 * marqueur explicite d'auto-validation ; l'Admin n'approuve aucune opération métier (RC-03).
 */
export const SELF_APPROVAL_ROLE = 'DIRECTION';

export function canSelfApprove(roleCodes: readonly string[]): boolean {
  return roleCodes.includes(SELF_APPROVAL_ROLE);
}
