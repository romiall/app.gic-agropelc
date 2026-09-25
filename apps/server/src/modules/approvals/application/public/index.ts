/**
 * API publique du module `approvals` (01-architecture-logicielle.md §3, règle 1) : seul
 * point d'import autorisé depuis un autre module (`inventory`, `procurement`… à partir de
 * P2 — le graphe les y autorise déjà, `.dependency-cruiser.cjs`).
 */
export { requestApproval } from './request-approval.js';
export type { RequestApprovalInput } from './request-approval.js';

export { currentPolicies } from './policy-query.js';
export type { ActiveControlPolicy } from './policy-query.js';

export { APPROVAL_DECISION_HANDLER_REGISTRY } from '../decision-handler-registry.provider.js';
export { ApprovalDecisionHandlerRegistry } from '../decision-handler-registry.js';
export type {
  ApprovalDecisionContext,
  ApprovalDecisionHandler,
  ApprovalDecisionType,
} from '../decision-handler-registry.js';

export { OPERATION_TYPES } from '../commands/operation-types.js';
export type { OperationType } from '../commands/operation-types.js';
