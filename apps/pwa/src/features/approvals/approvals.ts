/**
 * ECR-ADM-08 « File de validation » (MP-07 ; UC-ADM-15 ; SM-APPROVAL ; ADR-018) : logique pure de
 * l'écran.
 *
 * - Liste lue sur `GET /approvals/inbox` : le serveur ne rend que les demandes que le lecteur peut
 *   décider (permission de la politique, dans sa portée, BR-ADM-018), la plus ancienne d'abord ; un
 *   filtre `types` vient des actions de l'accueil (« Valider les mortalités », « Valider les remises »).
 * - Règles de décision par type partagées avec le serveur (`approvalDecisionSpec`, `@gic/domain`) :
 *   refus permis ou non, issue d'un refus, choix ou donnée à l'approbation, décision sans effet ;
 *   écarts de caisse et de remise acceptés seulement, avec un motif (200 caractères au plus, remis au
 *   module comme `decisionData.reason`) et l'imputation d'une remise (AV-159, AV-174).
 * - Commandes `approvals.request.approve` / `.reject` (agrégat `APPROVAL_REQUEST`) ; motif obligatoire
 *   au refus (2 000 caractères au plus) ; auto-validation de la Direction cochée explicitement
 *   (INV-ADM-02) ; approbation impossible tant qu'une pièce attendue n'est pas reçue (BR-ADM-020).
 */
import {
  APPROVAL_COMMENT_MAX,
  APPROVAL_DECISION_DATA_MAX,
  approvalDecisionSpec,
  type ApprovalDecisionSpec,
} from '@gic/domain';

/** Demande renvoyée par `GET /api/v1/approvals/inbox`. */
export interface ApprovalView {
  readonly id: string;
  readonly operationType: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly subjectSummary: string;
  readonly amountXaf: number | null;
  readonly amountMasked: boolean;
  readonly siteId: string | null;
  readonly zoneId: string | null;
  readonly requestedBy: string;
  readonly requestedByName: string | null;
  readonly requestedAt: string;
  readonly attachmentsPending: boolean;
  /** Pièces du document décidé (MP-10, AV-286) ; absentes d'un serveur plus ancien. */
  readonly attachments?: readonly {
    readonly id: string;
    readonly kind: string;
    readonly uploadStatus: string;
  }[];
  readonly selfRequest: boolean;
  /**
   * Choix que le serveur refuserait pour cette demande (MP-11 : porteur d'une remise inconnu) ; absent
   * d'un serveur plus ancien.
   */
  readonly unavailableOptions?: readonly string[];
}

export type ApprovalAction = 'APPROVE' | 'REJECT';

export interface DecisionInput {
  readonly comment: string;
  /** Choix (`decisionOption`) ; chaîne vide : aucun. */
  readonly option: string;
  /** Données de décision saisies (`decisionData`), par clé. */
  readonly data: Readonly<Record<string, string>>;
  /** Auto-validation explicite de la Direction. */
  readonly selfApproved: boolean;
}

export const EMPTY_DECISION: DecisionInput = {
  comment: '',
  option: '',
  data: {},
  selfApproved: false,
};

export { APPROVAL_COMMENT_MAX };

/** Règle de décision de la demande. */
export function specOf(view: ApprovalView): ApprovalDecisionSpec {
  return approvalDecisionSpec(view.operationType);
}

/** Décisions proposées dans la file. */
export function actionsFor(view: ApprovalView): ApprovalAction[] {
  return ['APPROVE', ...(specOf(view).rejectable ? (['REJECT'] as const) : [])];
}

/** Motif exigé pour cette décision : tout refus, et l'acceptation d'un écart (motif du module). */
export function commentRule(view: ApprovalView, action: ApprovalAction): 'REQUIRED' | 'OPTIONAL' {
  return action === 'REJECT' || specOf(view).approveReasonRequired ? 'REQUIRED' : 'OPTIONAL';
}

/** Longueur maximale du motif : celle d'une donnée de décision quand il en devient une. */
export function commentMax(view: ApprovalView, action: ApprovalAction): number {
  return action === 'APPROVE' && specOf(view).approveReasonRequired
    ? APPROVAL_DECISION_DATA_MAX
    : APPROVAL_COMMENT_MAX;
}

/** Choix proposés pour une décision. */
export function optionsFor(view: ApprovalView, action: ApprovalAction) {
  const spec = specOf(view);
  const options = action === 'APPROVE' ? spec.approveOptions : spec.rejectOptions;
  const unavailable = view.unavailableOptions ?? [];
  if (!options || unavailable.length === 0) return options;
  return { ...options, values: options.values.filter((value) => !unavailable.includes(value)) };
}

/** Données proposées pour une décision (à l'approbation seulement). */
export function dataFieldsFor(view: ApprovalView, action: ApprovalAction) {
  return action === 'APPROVE' ? (specOf(view).approveData ?? []) : [];
}

/** Raison qui empêche d'envoyer la décision, ou `null`. */
export function blockReason(
  view: ApprovalView,
  action: ApprovalAction,
  input: DecisionInput,
):
  | 'ATTACHMENT_PENDING'
  | 'COMMENT_REQUIRED'
  | 'TOO_LONG'
  | 'OPTION_REQUIRED'
  | 'SELF_CONFIRM'
  | null {
  const comment = input.comment.trim();
  if (action === 'APPROVE' && view.attachmentsPending) return 'ATTACHMENT_PENDING';
  if (comment.length > commentMax(view, action)) return 'TOO_LONG';
  if (commentRule(view, action) === 'REQUIRED' && comment.length === 0) return 'COMMENT_REQUIRED';
  if (optionsFor(view, action)?.required && input.option === '') return 'OPTION_REQUIRED';
  for (const field of dataFieldsFor(view, action)) {
    const value = (input.data[field.key] ?? '').trim();
    if (value.length > APPROVAL_DECISION_DATA_MAX) return 'TOO_LONG';
    if (field.required && value.length === 0) return 'OPTION_REQUIRED';
  }
  if (view.selfRequest && !input.selfApproved) return 'SELF_CONFIRM';
  return null;
}

/** Commande d'une décision. */
export function commandOf(
  view: ApprovalView,
  action: ApprovalAction,
  input: DecisionInput,
): { readonly commandType: string; readonly payload: Record<string, unknown> } {
  const comment = input.comment.trim();
  const options = optionsFor(view, action);
  const option = options?.values.includes(input.option) ? input.option : '';
  const data: Record<string, string> = {};
  for (const field of dataFieldsFor(view, action)) {
    const value = (input.data[field.key] ?? '').trim();
    if (value) data[field.key] = value;
  }
  if (action === 'APPROVE' && specOf(view).approveReasonRequired && comment) data.reason = comment;
  return {
    commandType: action === 'APPROVE' ? 'approvals.request.approve' : 'approvals.request.reject',
    payload: {
      requestId: view.id,
      ...(comment ? { comment } : {}),
      ...(option ? { decisionOption: option } : {}),
      ...(Object.keys(data).length > 0 ? { decisionData: data } : {}),
      ...(view.selfRequest && input.selfApproved ? { selfApproved: true } : {}),
    },
  };
}

/** Types retenus depuis la requête de l'écran (`?types=A,B`) ; vide : tous. */
export function typesFromQuery(raw: string | null): readonly string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((type) => type.trim())
        .filter((type) => /^[A-Z_]{1,40}$/.test(type)),
    ),
  ];
}

/** Chemin de lecture de la file. */
export function inboxPath(types: readonly string[]): string {
  return `/api/v1/approvals/inbox?limit=200${types.length > 0 ? `&types=${types.join(',')}` : ''}`;
}

/** Ancienneté d'une demande en heures entières (affichage de l'attente). */
export function waitingHours(requestedAt: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(requestedAt).getTime()) / 3_600_000));
}
