/** API publique du module `fieldwork` (01-architecture-logicielle.md §3, règle 1) : seul point
 * d'import autorisé depuis un module supérieur (`crm`, `sales`…). */
export { findWorkSession, findWorkSessionAt } from './session-query.js';
export type { WorkSessionRef } from './session-query.js';

export {
  SESSION_REJECTED_LISTENERS,
  SessionRejectedListenerRegistry,
} from '../session-rejection.js';
export type { SessionRejectedListener } from '../session-rejection.js';
