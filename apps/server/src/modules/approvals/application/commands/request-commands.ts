/**
 * `approvals.request.approve`, `.reject`, `.withdraw` (SM-APPROVAL, 04-workflows/
 * machines-a-etats/06-transverses.md ; D01 §8 pour les codes d'erreur).
 *
 * Permission — la portée réelle (BR-ADM-018 : « permission d'approbation propre au type
 * d'opération, sur un périmètre qui contient l'opération ») vient de la politique **figée
 * sur la demande** (`policy_id` → `control_policies.approver_permission`/`approver_scope`),
 * jamais d'un code statique connu à l'enregistrement — `CommandHandlerRegistry` n'en
 * accepte qu'un par `command_type` (RC-01, filtre existence large : `approvals.request.read`,
 * déjà détenue par quiconque a une raison de voir la file). La vérification précise
 * (RC-04, portée de l'**opération**) se fait ici avec `evaluateAccess` (P0-10), à partir de
 * `site_id`/`zone_id` déjà portés par la demande — aucune dépendance à un module
 * propriétaire (inventory…) pour cela.
 *
 * Auto-approbation (BR-ADM-017, AV-010) : la contrainte `ck_approvals_approval_requests_
 * self_approval` (migration P0-04) est le garde-fou définitif. Ici, `selfApproved` est un
 * indicateur explicite porté par le payload (jamais déduit du rôle de l'auteur — aucune API
 * « cet utilisateur est-il DIRECTION ? » n'existe dans `identity`) : combiné à la détention
 * réelle de la permission d'approbation à la bonne portée (déjà vérifiée juste avant), la
 * décision reste tracée et rejouable — DÉDUIT, paramétrable si une vérification de rôle plus
 * stricte s'avère nécessaire plus tard.
 *
 * Retrait (P5-15) : le module propriétaire d'un type peut enregistrer une **garde de retrait**
 * (`registerWithdrawalGuard`) qui refuse le retrait quand le document ne peut pas rester sans
 * décision — écart d'une remise de fonds, déjà dans les livres (AV-174). Sans garde, le retrait
 * reste libre.
 */
import { z } from 'zod';
import { sql } from 'kysely';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { toBin, fromBin } from '../../../../platform/kysely/uuid-columns.js';
import {
  ApprovalDecisionRefused,
  type ApprovalDecisionHandlerRegistry,
} from '../decision-handler-registry.js';
import { recordRequesterChange } from '../approval-changes.js';
import { decideApprovalRequest } from '../public/decide-approval-request.js';

const decisionBasePayloadSchema = z.object({
  requestId: z.string().uuid(),
  decisionOption: z.string().min(1).max(40).optional(),
  selfApproved: z.boolean().optional(),
});
const approvePayloadSchema = decisionBasePayloadSchema.extend({
  comment: z.string().max(2000).optional(),
  /**
   * Données propres au type d'opération, remises telles quelles au gestionnaire du module
   * propriétaire (ex. référence corrigée d'un encaissement suspect de doublon, AV-135) ; tracées
   * par l'inbox et l'audit de la commande, non stockées sur la demande.
   */
  decisionData: z
    .record(z.string().min(1).max(200))
    .refine((data) => Object.keys(data).length <= 10, 'Dix données au plus.')
    .optional(),
});
const rejectPayloadSchema = decisionBasePayloadSchema.extend({
  // decision_comment "Obligatoire en cas de rejet" (dictionnaire, approvals.approval_requests).
  comment: z.string().min(1).max(2000),
});
const withdrawPayloadSchema = z.object({ requestId: z.string().uuid() });

type DecisionPayload = z.infer<typeof approvePayloadSchema> | z.infer<typeof rejectPayloadSchema>;
type WithdrawPayload = z.infer<typeof withdrawPayloadSchema>;

function notFound(): CommandHandlerOutcome {
  return {
    status: 'REJECTED',
    errorCode: 'NOT_FOUND',
    messageFr: 'Demande de validation introuvable.',
  };
}
function notPending(): CommandHandlerOutcome {
  return {
    status: 'REJECTED',
    errorCode: 'APPROVAL_NOT_PENDING',
    messageFr: "Cette demande n'est plus en attente de décision.",
  };
}

function buildDecisionCommandHandler(
  decision: 'APPROVED' | 'REJECTED',
  decisionRegistry: ApprovalDecisionHandlerRegistry,
): CommandHandler<DecisionPayload> {
  // Cœur partagé avec les commandes en façade d'un module propriétaire (P5-13,
  // `finance.cash_session.validate`) : `decideApprovalRequest`.
  return async (uow, envelope) => {
    // SM-APPROVAL, D01 (UC-ADM-15) : aucune décision hors ligne, elle exige l'état du serveur. Comme les
    // façades (`finance.cash_session.validate`, `.close_discrepancy`) : sans cette garde, une décision
    // saisie hors ligne s'appliquait au renvoi, à la date de l'appareil (revue de P8, B4 ; MP-07).
    if (envelope.captured_offline) {
      return {
        status: 'REJECTED',
        errorCode: 'ONLINE_REQUIRED',
        messageFr:
          'Une décision de validation se prend en ligne : reprenez-la depuis la file de validation.',
      };
    }
    const result = await decideApprovalRequest(uow, decisionRegistry, {
      requestId: envelope.payload.requestId,
      decision,
      decidedBy: envelope.author_user_id,
      decidedAt: new Date(envelope.occurred_at),
      ...(envelope.payload.comment !== undefined ? { comment: envelope.payload.comment } : {}),
      ...(envelope.payload.decisionOption !== undefined
        ? { decisionOption: envelope.payload.decisionOption }
        : {}),
      ...('decisionData' in envelope.payload && envelope.payload.decisionData !== undefined
        ? { decisionData: envelope.payload.decisionData }
        : {}),
      ...(envelope.payload.selfApproved !== undefined
        ? { selfApproved: envelope.payload.selfApproved }
        : {}),
    });
    return result.ok
      ? { status: 'APPLIED' }
      : { status: 'REJECTED', errorCode: result.errorCode, messageFr: result.messageFr };
  };
}

const buildWithdrawHandler =
  (decisionRegistry: ApprovalDecisionHandlerRegistry): CommandHandler<WithdrawPayload> =>
  async (uow, envelope) => {
    const requestId = toBin(envelope.payload.requestId);
    const row = await uow
      .selectFrom('approvals_approval_requests')
      .select(['id', 'status', 'requested_by', 'operation_type', 'subject_type', 'subject_id'])
      .where('id', '=', requestId)
      .executeTakeFirst();
    if (!row) return notFound();
    if (row.status !== 'PENDING') return notPending();
    if (fromBin(row.requested_by) !== envelope.author_user_id) {
      return {
        status: 'REJECTED',
        errorCode: 'FORBIDDEN',
        messageFr: 'Seul le demandeur peut retirer sa demande.',
      };
    }
    // P5-15 : le module propriétaire peut refuser le retrait (garde facultative, ADR-018).
    const guard = decisionRegistry.resolveWithdrawalGuard(row.operation_type);
    if (guard) {
      try {
        await guard(uow, {
          requestId: fromBin(row.id),
          subjectType: row.subject_type,
          subjectId: fromBin(row.subject_id),
          requestedBy: fromBin(row.requested_by),
          withdrawnAt: new Date(envelope.occurred_at),
        });
      } catch (error) {
        if (error instanceof ApprovalDecisionRefused) {
          return { status: 'REJECTED', errorCode: error.code, messageFr: error.messageFr };
        }
        throw error;
      }
    }
    return withdrawRequest(uow, envelope.author_user_id, row);
  };

async function withdrawRequest(
  uow: Parameters<CommandHandler<WithdrawPayload>>[0],
  authorUserId: string,
  row: { readonly id: Buffer; readonly requested_by: Buffer },
): Promise<CommandHandlerOutcome> {
  // ck_approvals_approval_requests_decision : CANCELLED exige decided_by/decided_at NULS
  // (réservés à APPROVED/REJECTED) — seuls updated_by/version tracent ce retrait ([STD-AUDIT]).
  await uow
    .updateTable('approvals_approval_requests')
    .set({
      status: 'CANCELLED',
      updated_by: toBin(authorUserId),
      version: sql`version + 1`,
    })
    .where('id', '=', row.id)
    .execute();
  await recordRequesterChange(uow, fromBin(row.id), fromBin(row.requested_by));

  return { status: 'APPLIED' };
}

export function registerRequestCommands(
  registry: CommandHandlerRegistry,
  decisionRegistry: ApprovalDecisionHandlerRegistry,
): void {
  registry.register({
    commandType: 'approvals.request.approve',
    version: 1,
    payloadSchema: approvePayloadSchema,
    permissionCode: 'approvals.request.read',
    handler: buildDecisionCommandHandler('APPROVED', decisionRegistry),
  });
  registry.register({
    commandType: 'approvals.request.reject',
    version: 1,
    payloadSchema: rejectPayloadSchema,
    permissionCode: 'approvals.request.read',
    handler: buildDecisionCommandHandler('REJECTED', decisionRegistry),
  });
  registry.register({
    commandType: 'approvals.request.withdraw',
    version: 1,
    payloadSchema: withdrawPayloadSchema,
    permissionCode: 'approvals.request.read',
    handler: buildWithdrawHandler(decisionRegistry),
  });
}
