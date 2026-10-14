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
  cashTransferCloseDiscrepancyPayloadSchema,
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
  CashTransferCloseDiscrepancyPayload,
  AllocationGrantPayload,
  AllocationIncreasePayload,
  AllocationRevokePayload,
  AllocationReleasePayload,
} from './distribution-commands.js';

// Réception sans document et retour à la source (P5-16 ; BR-STK-024, BR-STK-025).
export {
  BLIND_RECEIPT_MAX_LINES,
  positiveQuantitySchema,
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

// Commandes de la finance opérationnelle (P8 ; ADR-042, ADR-043).
export {
  SUPPLIER_INVOICE_MAX_LINES,
  SUPPLIER_PAYMENT_MAX_ALLOCATIONS,
  expenseCategoryCreatePayloadSchema,
  expenseCategoryUpdatePayloadSchema,
  expenseCategoryStatusPayloadSchema,
  expenseRecordPayloadSchema,
  expensePayPayloadSchema,
  expenseCancelPayloadSchema,
  supplierInvoiceRecordPayloadSchema,
  supplierInvoiceDecisionPayloadSchema,
  supplierPaymentRecordPayloadSchema,
  supplierPaymentAllocatePayloadSchema,
  supplierPaymentCancelPayloadSchema,
} from './finance-operations-commands.js';
export type {
  ExpenseCategoryCreatePayload,
  ExpenseCategoryUpdatePayload,
  ExpenseCategoryStatusPayload,
  ExpenseRecordPayload,
  ExpensePayPayload,
  ExpenseCancelPayload,
  SupplierInvoiceRecordPayload,
  SupplierInvoiceDecisionPayload,
  SupplierPaymentRecordPayload,
  SupplierPaymentAllocatePayload,
  SupplierPaymentCancelPayload,
} from './finance-operations-commands.js';

// P9 : commandes et lectures de `communication` et d'`analytics` (ADR-071 à ADR-077).
export {
  COMMUNICATION_COMMAND_TYPES,
  NOTE_AUDIENCE_MAX,
  NOTE_AUDIENCE_TYPES,
  NOTE_CATEGORIES,
  NOTIFICATIONS_READ_MAX,
  alertAcknowledgePayloadSchema,
  alertDismissPayloadSchema,
  alertResolvePayloadSchema,
  alertRuleSetPayloadSchema,
  noteAcknowledgePayloadSchema,
  noteArchivePayloadSchema,
  noteAudienceEntrySchema,
  noteCategorySchema,
  noteDraftSavePayloadSchema,
  notePublishPayloadSchema,
  notificationReadPayloadSchema,
  pushSubscribePayloadSchema,
  pushUnsubscribePayloadSchema,
} from './communication-commands.js';
export type {
  AlertAcknowledgePayload,
  AlertDismissPayload,
  AlertResolvePayload,
  AlertRuleSetPayload,
  NoteAcknowledgePayload,
  NoteArchivePayload,
  NoteAudienceEntry,
  NoteCategory,
  NoteDraftSavePayload,
  NotePublishPayload,
  NotificationReadPayload,
  PushSubscribePayload,
  PushUnsubscribePayload,
} from './communication-commands.js';
export {
  ALERT_VISIBILITY,
  NOTE_STATUSES,
  alertItemSchema,
  alertListResponseSchema,
  alertRuleItemSchema,
  alertRuleListResponseSchema,
  alertSummarySchema,
  noteAcknowledgementsResponseSchema,
  noteItemSchema,
  noteListResponseSchema,
  notificationItemSchema,
  notificationListResponseSchema,
} from './communication-reads.js';
export type {
  AlertItem,
  AlertListResponse,
  AlertRuleItem,
  AlertRuleListResponse,
  AlertSummary,
  NoteAcknowledgementsResponse,
  NoteItem,
  NoteListResponse,
  NotificationItem,
  NotificationListResponse,
} from './communication-reads.js';
export {
  ANALYTICS_COMMAND_TYPES,
  ANALYTICS_EXPORT_FORMATS,
  analyticsExportFormatSchema,
  analyticsExportRequestPayloadSchema,
  analyticsQueryRequestSchema,
  analyticsViewDeletePayloadSchema,
  analyticsViewSavePayloadSchema,
  analyticsViewSetDefaultPayloadSchema,
  analyticsViewSharePayloadSchema,
  explorationDefinitionSchema,
  explorationFilterSchema,
  explorationPeriodSchema,
  explorationSortSchema,
} from './analytics-commands.js';
export type {
  AnalyticsExportFormat,
  AnalyticsExportRequestPayload,
  AnalyticsQueryRequest,
  AnalyticsViewSavePayload,
  AnalyticsViewSetDefaultPayload,
  AnalyticsViewSharePayload,
  ExplorationDefinitionInput,
  ExplorationFilterInput,
} from './analytics-commands.js';
export {
  DASHBOARD_BLOCK_CODES,
  DASHBOARD_CODES,
  EXPORT_STATUSES,
  analyticsCatalogResponseSchema,
  analyticsFreshnessSchema,
  analyticsPeriodSchema,
  analyticsQueryResponseSchema,
  catalogDatasetView,
  dashboardBlockSchema,
  dashboardCodeSchema,
  dashboardKpiSchema,
  dashboardResponseSchema,
  exportJobSchema,
  kpiSnapshotSchema,
  queryColumnSchema,
  queryRowSchema,
  savedViewSchema,
} from './analytics-reads.js';
export type {
  AnalyticsCatalogResponse,
  AnalyticsFreshness,
  AnalyticsPeriodView,
  AnalyticsQueryResponse,
  DashboardBlock,
  DashboardCode,
  DashboardKpi,
  DashboardResponse,
  ExportJob,
  KpiSnapshot,
  SavedView,
} from './analytics-reads.js';
