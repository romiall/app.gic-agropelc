import type { Provider } from '@nestjs/common';
import { ApprovalDecisionHandlerRegistry } from './decision-handler-registry.js';

export const APPROVAL_DECISION_HANDLER_REGISTRY = Symbol('APPROVAL_DECISION_HANDLER_REGISTRY');

export const approvalDecisionHandlerRegistryProvider: Provider = {
  provide: APPROVAL_DECISION_HANDLER_REGISTRY,
  useValue: new ApprovalDecisionHandlerRegistry(),
};
