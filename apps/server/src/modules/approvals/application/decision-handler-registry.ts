/**
 * Registre `operation_type → gestionnaire de décision` (ADR-018 : « chaque module enregistre
 * auprès d'approvals un gestionnaire pour ses types d'opération, appelé dans la transaction
 * de la décision »). Même schéma d'inversion de dépendance que `CommandHandlerRegistry`/
 * `JobHandlerRegistry` : un module propriétaire (inventory, procurement…) s'enregistre à son
 * démarrage ; `approvals` n'importe aucun module métier (le graphe l'interdit : `approvals:
 * [identity, organization, attachments]`, jamais l'inverse).
 *
 * Aucun gestionnaire enregistré pour un `operation_type` donné (cas de tout P0, aucun module
 * propriétaire n'existe avant P2) : `request-commands.ts` traite l'absence comme un no-op —
 * la décision s'enregistre normalement, sans transition de document à exécuter. Dès qu'un
 * module s'enregistre pour ce type, ses décisions futures déclenchent sa transition sans
 * changement à `request-commands.ts` (raison d'être de l'inversion de dépendance).
 */
import type { UnitOfWork } from '../../../platform/unit-of-work.js';

export type ApprovalDecisionType = 'APPROVED' | 'REJECTED';

export interface ApprovalDecisionContext {
  readonly requestId: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly decision: ApprovalDecisionType;
  readonly decisionOption?: string;
  readonly decidedBy: string;
  readonly decidedAt: Date;
}

export type ApprovalDecisionHandler = (
  uow: UnitOfWork,
  ctx: ApprovalDecisionContext,
) => Promise<void>;

export class ApprovalDecisionHandlerRegistry {
  private readonly handlers = new Map<string, ApprovalDecisionHandler>();

  register(operationType: string, handler: ApprovalDecisionHandler): void {
    if (this.handlers.has(operationType)) {
      throw new Error(`Gestionnaire de décision déjà enregistré : ${operationType}.`);
    }
    this.handlers.set(operationType, handler);
  }

  resolve(operationType: string): ApprovalDecisionHandler | undefined {
    return this.handlers.get(operationType);
  }
}
