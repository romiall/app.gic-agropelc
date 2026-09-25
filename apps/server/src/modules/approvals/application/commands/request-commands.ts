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
 */
import { z } from 'zod';
import { sql } from 'kysely';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { toBin, fromBin, fromBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import { toDbBool } from '../../../../platform/kysely/bool-column.js';
import {
  evaluateAccess,
  type ResourceLocator,
} from '../../../identity/application/public/index.js';
import { areAttachmentsAvailable } from '../../../attachments/application/public/index.js';
import type { ApprovalDecisionHandlerRegistry } from '../decision-handler-registry.js';

const decisionBasePayloadSchema = z.object({
  requestId: z.string().uuid(),
  decisionOption: z.string().min(1).max(40).optional(),
  selfApproved: z.boolean().optional(),
});
const approvePayloadSchema = decisionBasePayloadSchema.extend({
  comment: z.string().max(2000).optional(),
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
  return async (uow, envelope) => {
    const requestId = toBin(envelope.payload.requestId);
    const row = await uow
      .selectFrom('approvals_approval_requests')
      .selectAll()
      .where('id', '=', requestId)
      .executeTakeFirst();
    if (!row) return notFound();
    if (row.status !== 'PENDING') return notPending();

    const policy = row.policy_id
      ? await uow
          .selectFrom('approvals_control_policies')
          .select(['approver_permission'])
          .where('id', '=', row.policy_id)
          .executeTakeFirst()
      : undefined;
    if (!policy?.approver_permission) {
      // Ne devrait pas survenir (SM-APPROVAL : une demande PENDING vient toujours d'une
      // politique applicable, BR-ADM-016) — garde défensive, pas un cas métier documenté.
      return {
        status: 'REJECTED',
        errorCode: 'POLICY_UNRESOLVED',
        messageFr: 'Politique de contrôle introuvable pour cette demande.',
      };
    }

    // `policy.approver_scope` n'est pas revérifié séparément ici : DÉDUIT, descriptif
    // (documente la portée voulue par la politique pour l'UI/l'audit) plutôt qu'une seconde
    // contrainte à faire respecter — BR-ADM-018 ne décrit qu'un seul mécanisme, exactement
    // celui qu'implémente déjà `evaluateAccess` (portée du grant de l'approbateur ∩ son
    // affectation, RC-04). Aucun ordre total entre SITE/ZONE/TEAM/ALL n'est documenté qui
    // permettrait de comparer une portée de politique à une portée de grant de façon fiable.
    const resource: ResourceLocator = {
      ownerUserId: fromBin(row.requested_by),
      ...(fromBinOrNull(row.site_id) !== null ? { siteId: fromBinOrNull(row.site_id)! } : {}),
      ...(fromBinOrNull(row.zone_id) !== null ? { zoneId: fromBinOrNull(row.zone_id)! } : {}),
    };
    const occurredAt = new Date(envelope.occurred_at);
    const access = await evaluateAccess(uow, {
      userId: envelope.author_user_id,
      permissionCode: policy.approver_permission,
      occurredAt,
      resource,
    });
    if (!access.allowed) {
      return {
        status: 'REJECTED',
        errorCode: 'APPROVER_NOT_ALLOWED',
        messageFr: "Droit d'approbation insuffisant sur le périmètre de cette opération.",
      };
    }

    const isSelfRequest = envelope.author_user_id === fromBin(row.requested_by);
    if (isSelfRequest && envelope.payload.selfApproved !== true) {
      return {
        status: 'REJECTED',
        errorCode: 'SELF_APPROVAL_FORBIDDEN',
        messageFr: "L'approbateur doit être différent du demandeur (BR-ADM-017).",
      };
    }

    if (decision === 'APPROVED') {
      const requiredIds = Array.isArray(row.required_attachment_ids)
        ? row.required_attachment_ids.filter((v): v is string => typeof v === 'string')
        : [];
      if (!(await areAttachmentsAvailable(uow, requiredIds))) {
        return {
          status: 'REJECTED',
          errorCode: 'ATTACHMENT_MISSING',
          messageFr: 'Pièce justificative requise non encore reçue (BR-ADM-020).',
        };
      }
    }

    // ADR-018 : gestionnaire du module propriétaire, appelé dans la transaction de la
    // décision. Aucun gestionnaire enregistré (tout P0, aucun module propriétaire avant
    // P2) : no-op documenté (decision-handler-registry.ts).
    const decisionHandler = decisionRegistry.resolve(row.operation_type);
    if (decisionHandler) {
      await decisionHandler(uow, {
        requestId: fromBin(row.id),
        subjectType: row.subject_type,
        subjectId: fromBin(row.subject_id),
        decision,
        ...(envelope.payload.decisionOption !== undefined
          ? { decisionOption: envelope.payload.decisionOption }
          : {}),
        decidedBy: envelope.author_user_id,
        decidedAt: occurredAt,
      });
    }

    await uow
      .updateTable('approvals_approval_requests')
      .set({
        status: decision,
        decided_by: toBin(envelope.author_user_id),
        decided_at: occurredAt,
        decision_option: envelope.payload.decisionOption ?? null,
        decision_comment: envelope.payload.comment ?? null,
        self_approved: toDbBool(isSelfRequest),
        updated_by: toBin(envelope.author_user_id),
        version: sql`version + 1`,
      })
      .where('id', '=', requestId)
      .execute();

    return { status: 'APPLIED' };
  };
}

const withdraw: CommandHandler<WithdrawPayload> = async (uow, envelope) => {
  const requestId = toBin(envelope.payload.requestId);
  const row = await uow
    .selectFrom('approvals_approval_requests')
    .select(['id', 'status', 'requested_by'])
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

  // ck_approvals_approval_requests_decision : CANCELLED exige decided_by/decided_at NULS
  // (réservés à APPROVED/REJECTED) — seuls updated_by/version tracent ce retrait ([STD-AUDIT]).
  await uow
    .updateTable('approvals_approval_requests')
    .set({
      status: 'CANCELLED',
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('id', '=', requestId)
    .execute();

  return { status: 'APPLIED' };
};

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
    handler: withdraw,
  });
}
