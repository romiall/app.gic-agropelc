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
  MAX_PENDING_AUTHORS,
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

export {
  HOME_TONES,
  HOME_UNITS,
  HOME_SEVERITIES,
  homeToneSchema,
  homeUnitSchema,
  homeKpiSchema,
  homeSeveritySchema,
  homeActionSchema,
  homeSignalSchema,
  homeActivitySchema,
  homeSectionSchema,
  homeResponseSchema,
} from './home.js';
export type {
  HomeTone,
  HomeUnit,
  HomeKpi,
  HomeSeverity,
  HomeAction,
  HomeSignal,
  HomeActivity,
  HomeSection,
  HomeResponse,
} from './home.js';

// Tableau de distribution (P5-20, ADR-035).
export {
  DISTRIBUTION_PERIOD_CODES,
  distributionPeriodCodeSchema,
  distributionReplenishmentSchema,
  distributionProductRowSchema,
  distributionCashSessionSchema,
  distributionDeviceSchema,
  distributionPointOfSaleSchema,
  distributionDashboardResponseSchema,
} from './distribution-dashboard.js';
export type {
  DistributionPeriodCode,
  DistributionProductRow,
  DistributionCashSession,
  DistributionDevice,
  DistributionPointOfSale,
  DistributionDashboardResponse,
} from './distribution-dashboard.js';

// Commandes de la distribution (P5 ; ADR-021, ADR-032, ADR-033).
export {
  cashSessionOpenPayloadSchema,
  cashSessionClosePayloadSchema,
  cashSessionForceClosePayloadSchema,
  cashSessionValidatePayloadSchema,
  cashTransferSendPayloadSchema,
  cashTransferReceivePayloadSchema,
  cashTransferCancelPayloadSchema,
  allocationGrantPayloadSchema,
  allocationIncreasePayloadSchema,
  allocationRevokePayloadSchema,
  allocationReleasePayloadSchema,
} from './distribution-commands.js';
export type {
  CashSessionOpenPayload,
  CashSessionClosePayload,
  CashSessionForceClosePayload,
  CashSessionValidatePayload,
  CashTransferSendPayload,
  CashTransferReceivePayload,
  CashTransferCancelPayload,
  AllocationGrantPayload,
  AllocationIncreasePayload,
  AllocationRevokePayload,
  AllocationReleasePayload,
} from './distribution-commands.js';

// Réception sans document et retour à la source (P5-16 ; BR-STK-024, BR-STK-025).
export {
  BLIND_RECEIPT_MAX_LINES,
  receivedQuantitySchema,
  transferBlindReceivePayloadSchema,
  transferReturnToSourcePayloadSchema,
} from './stock-transfer-commands.js';
export type {
  TransferBlindReceivePayload,
  TransferReturnToSourcePayload,
} from './stock-transfer-commands.js';

// Messages de validation en français (S-37, P5-23).
export { describeIssueFr, describeIssuesFr } from './validation-messages.js';
