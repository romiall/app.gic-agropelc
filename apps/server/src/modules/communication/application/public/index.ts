/**
 * API publique du module `communication` (ADR-070) : lue par la couche de transport `communication-api/`
 * et par `analytics-api/` (compteurs d'alertes de la tour de contrôle). Aucun autre module ne l'importe :
 * les modules propriétaires publient des événements (ADR-070 §2).
 */
export { ALERTS_CONSUMER_NAME } from '../events/alerts-consumer.js';
export { ALERT_RECIPIENT_RESOLVER } from '../recipients/recipient-resolver.js';
export type {
  AlertRecipientResolver,
  RecipientPerimeter,
  RoleHolder,
} from '../recipients/recipient-resolver.js';
export { DisabledWebPushSender, WEB_PUSH_SENDER } from '../notifications/web-push.js';
export type {
  PushMessage,
  PushSendResult,
  PushTarget,
  WebPushSender,
} from '../notifications/web-push.js';
