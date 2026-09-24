// Schémas partagés (appareil + serveur) : enveloppe de commande, protocole de
// synchronisation, catalogue d'erreurs. ADR-021. Portée de P0-03 ; les schémas de
// `payload` propres à chaque type de commande métier sont ajoutés par les modules qui
// les introduisent (P1 à P10), via CommandRegistry.

export {
  SYNC_PROTOCOL_ERROR_CODES,
  isSyncProtocolErrorCode,
  WARNING_CODES,
  warningCodeSchema,
  errorCodeSchema,
  apiErrorSchema,
} from './error-codes.js';
export type { SyncProtocolErrorCode, WarningCode, ApiError } from './error-codes.js';

export {
  commandTypeSchema,
  commandEnvelopeBaseSchema,
  commandEnvelopeSchema,
} from './command-envelope.js';
export type { CommandEnvelopeBase, CommandEnvelope } from './command-envelope.js';

export { CommandRegistry } from './command-registry.js';
export type { RegisteredCommandType, ParsedCommand } from './command-registry.js';

export {
  rawCommandEnvelopeSchema,
  pushRequestSchema,
  SYNC_RESULT_STATUSES,
  syncResultStatusSchema,
  commandResultSchema,
  pushResponseSchema,
  DEVICE_SYNC_STATES,
  deviceSyncStateSchema,
  deviceStateAfterResult,
  pullRequestSchema,
  CHANGE_TYPES,
  changeTypeSchema,
  SCOPE_TYPES,
  scopeTypeSchema,
  changeSchema,
  pullResponseSchema,
} from './sync-protocol.js';
export type {
  RawCommandEnvelope,
  PushRequest,
  SyncResultStatus,
  CommandResult,
  PushResponse,
  DeviceSyncState,
  PullRequest,
  ChangeType,
  ScopeType,
  Change,
  PullResponse,
} from './sync-protocol.js';
