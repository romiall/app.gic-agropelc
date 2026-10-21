/**
 * API publique du module `communication` (ADR-070) : lue par la couche de transport `communication-api/`
 * et par `analytics-api/` (compteurs d'alertes de la tour de contrôle). Aucun autre module ne l'importe :
 * les modules propriétaires publient des événements (ADR-070 §2).
 */
export { ALERTS_CONSUMER_NAME } from '../events/alerts-consumer.js';
export {
  ALERT_READ_PERMISSION,
  alertDetail,
  alertPage,
  alertSummary,
  decodeAlertCursor,
} from './alert-read.js';
export type {
  AlertCursor,
  AlertFilter,
  AlertPage,
  AlertReadItem,
  AlertSummaryResult,
  AlertVisibility,
} from './alert-read.js';
export {
  decodeNotificationCursor,
  listAlertRuleItems,
  notificationPage,
} from './notification-read.js';
export type {
  AlertRuleReadItem,
  NotificationCursor,
  NotificationPage,
  NotificationReadItem,
} from './notification-read.js';
export {
  NOTE_INBOX_SCAN_MAX,
  NOTE_PUBLISH_PERMISSION,
  NOTE_READ_PERMISSION,
  decodeNoteCursor,
  noteAcknowledgementFollowUp,
  noteDetail,
  notePage,
} from './note-read.js';
export type {
  NoteAcknowledgementFollowUp,
  NoteCursor,
  NotePage,
  NoteReadItem,
  NoteReadStatus,
  NoteViewScope,
} from './note-read.js';
export { ALERT_RECIPIENT_RESOLVER } from '../recipients/recipient-resolver.js';
export type {
  AlertRecipientResolver,
  RecipientPerimeter,
  RoleHolder,
} from '../recipients/recipient-resolver.js';
export { NOTE_AUDIENCE_RESOLVER } from '../notes/note-audience-resolver.js';
export type {
  NoteAudienceExecutor,
  NoteAudienceResolver,
} from '../notes/note-audience-resolver.js';
export { DisabledWebPushSender, WEB_PUSH_SENDER } from '../notifications/web-push.js';
export type {
  PushMessage,
  PushSendResult,
  PushTarget,
  WebPushSender,
} from '../notifications/web-push.js';
