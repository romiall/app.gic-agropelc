/**
 * `approvals.decideApprovalRequest` (P5-13) : décision d'une demande de validation, appelable dans la
 * transaction d'un autre module. C'est le cœur des commandes `approvals.request.approve` et `.reject`
 * (`request-commands.ts`), extrait pour qu'un module propriétaire puisse offrir une commande en
 * **façade** de la décision (`finance.cash_session.validate` pour `CASH_VARIANCE`, ADR-032 §5) sans
 * dupliquer les contrôles : demande en attente, politique figée sur la demande, droit d'approbation
 * sur le périmètre de l'opération (BR-ADM-018, RC-04), auto-approbation (BR-ADM-017), pièces requises
 * (BR-ADM-020), gestionnaire du module propriétaire (ADR-018), puis statut de la demande.
 *
 * Renvoie le refus (code, message) sans rien écrire, ou `{ ok: true }` une fois la décision écrite.
 * L'appelant décide de la suite (refus de sa commande, rollback éventuel par l'exception du pipeline).
 */
import type { Transaction } from 'kysely';
import { sql } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { toDbBool } from '../../../../platform/kysely/bool-column.js';
import {
  evaluateAccess,
  type ResourceLocator,
} from '../../../identity/application/public/index.js';
import { requiredAttachmentsSatisfied } from '../../../attachments/application/public/index.js';
import {
  ApprovalDecisionRefused,
  type ApprovalDecisionHandlerRegistry,
} from '../decision-handler-registry.js';
import { recordRequesterChange } from '../approval-changes.js';
import { canSelfApproveAt } from './approval-inbox.js';

export interface DecideApprovalRequestInput {
  readonly requestId: string;
  readonly decision: 'APPROVED' | 'REJECTED';
  readonly decidedBy: string;
  readonly decidedAt: Date;
  readonly comment?: string;
  readonly decisionOption?: string;
  readonly decisionData?: Readonly<Record<string, string>>;
  /**
   * Auto-approbation explicite (BR-ADM-017) : jamais déduite du rôle de l'auteur, et permise à la
   * Direction seulement (INV-ADM-02, AV-010 ; MP-07).
   */
  readonly selfApproved?: boolean;
}

export type DecideApprovalRequestResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errorCode: string; readonly messageFr: string };

const refused = (errorCode: string, messageFr: string): DecideApprovalRequestResult => ({
  ok: false,
  errorCode,
  messageFr,
});

export async function decideApprovalRequest(
  uow: Transaction<DB>,
  decisionRegistry: ApprovalDecisionHandlerRegistry,
  input: DecideApprovalRequestInput,
): Promise<DecideApprovalRequestResult> {
  const requestId = toBin(input.requestId);
  const row = await uow
    .selectFrom('approvals_approval_requests')
    .selectAll()
    .where('id', '=', requestId)
    .executeTakeFirst();
  if (!row) return refused('NOT_FOUND', 'Demande de validation introuvable.');
  if (row.status !== 'PENDING') {
    return refused('APPROVAL_NOT_PENDING', "Cette demande n'est plus en attente de décision.");
  }

  const policy = row.policy_id
    ? await uow
        .selectFrom('approvals_control_policies')
        .select(['approver_permission'])
        .where('id', '=', row.policy_id)
        .executeTakeFirst()
    : undefined;
  if (!policy?.approver_permission) {
    // Ne devrait pas survenir (SM-APPROVAL : une demande PENDING vient toujours d'une politique
    // applicable, BR-ADM-016) — garde défensive, pas un cas métier documenté.
    return refused('POLICY_UNRESOLVED', 'Politique de contrôle introuvable pour cette demande.');
  }

  // `policy.approver_scope` n'est pas revérifié séparément : DÉDUIT, descriptif (portée voulue par la
  // politique pour l'UI et l'audit) ; BR-ADM-018 ne décrit qu'un mécanisme, celui d'`evaluateAccess`
  // (portée du grant de l'approbateur ∩ son affectation, RC-04), sur le périmètre porté par la demande.
  const resource: ResourceLocator = {
    ownerUserId: fromBin(row.requested_by),
    ...(fromBinOrNull(row.site_id) !== null ? { siteId: fromBinOrNull(row.site_id)! } : {}),
    ...(fromBinOrNull(row.zone_id) !== null ? { zoneId: fromBinOrNull(row.zone_id)! } : {}),
  };
  const access = await evaluateAccess(uow, {
    userId: input.decidedBy,
    permissionCode: policy.approver_permission,
    occurredAt: input.decidedAt,
    resource,
  });
  if (!access.allowed) {
    return refused(
      'APPROVER_NOT_ALLOWED',
      "Droit d'approbation insuffisant sur le périmètre de cette opération.",
    );
  }

  // INV-ADM-02 : le marqueur ne suffit pas, l'auteur doit relever de la Direction à l'instant de la
  // décision (MP-07 : avant, tout approbateur pouvait valider sa propre demande en le posant).
  const isSelfRequest = input.decidedBy === fromBin(row.requested_by);
  if (
    isSelfRequest &&
    (input.selfApproved !== true ||
      !(await canSelfApproveAt(uow, input.decidedBy, input.decidedAt)))
  ) {
    return refused(
      'SELF_APPROVAL_FORBIDDEN',
      "L'approbateur doit être différent du demandeur ; seule la Direction valide sa propre demande, explicitement (BR-ADM-017).",
    );
  }

  if (input.decision === 'APPROVED') {
    const requiredIds = Array.isArray(row.required_attachment_ids)
      ? row.required_attachment_ids.filter((v): v is string => typeof v === 'string')
      : [];
    // Pièce exigée ou, à défaut, une remplaçante reçue du même document (AV-290, revue de MP-10).
    if (
      !(await requiredAttachmentsSatisfied(uow, {
        requiredIds,
        ownerType: row.subject_type,
        ownerId: fromBin(row.subject_id),
      }))
    ) {
      return refused(
        'ATTACHMENT_MISSING',
        'Pièce justificative requise non encore reçue (BR-ADM-020).',
      );
    }
  }

  // ADR-018 : gestionnaire du module propriétaire, dans la transaction de la décision. Aucun
  // gestionnaire enregistré pour le type : no-op documenté (decision-handler-registry.ts).
  const decisionHandler = decisionRegistry.resolve(row.operation_type);
  if (decisionHandler) {
    try {
      await decisionHandler(uow, {
        requestId: fromBin(row.id),
        subjectType: row.subject_type,
        subjectId: fromBin(row.subject_id),
        decision: input.decision,
        ...(input.decisionOption !== undefined ? { decisionOption: input.decisionOption } : {}),
        ...(input.decisionData !== undefined ? { decisionData: input.decisionData } : {}),
        decidedBy: input.decidedBy,
        decidedAt: input.decidedAt,
        requestedBy: fromBin(row.requested_by),
        subjectSummary: row.subject_summary,
      });
    } catch (error) {
      // Transition impossible pour le module propriétaire : décision refusée, sans effet.
      if (error instanceof ApprovalDecisionRefused) return refused(error.code, error.messageFr);
      throw error;
    }
  }

  await uow
    .updateTable('approvals_approval_requests')
    .set({
      status: input.decision,
      decided_by: toBin(input.decidedBy),
      decided_at: input.decidedAt,
      decision_option: input.decisionOption ?? null,
      decision_comment: input.comment ?? null,
      self_approved: toDbBool(isSelfRequest),
      updated_by: toBin(input.decidedBy),
      version: sql`version + 1`,
    })
    .where('id', '=', requestId)
    .execute();
  await recordRequesterChange(uow, fromBin(row.id), fromBin(row.requested_by));
  return { ok: true };
}
