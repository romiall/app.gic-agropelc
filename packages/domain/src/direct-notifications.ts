/**
 * Notifications directes d'événements du catalogue (P9-11 (3/3) ; AV-389, AV-430 à AV-432 ; ADR-062 §4 ;
 * D13 §7). Un événement métier qui n'est pas une alerte — une demande de validation, sa décision, un
 * transfert demandé ou expédié — prévient la personne qui doit agir ou qui attendait la réponse. Sans
 * entrée-sortie : le consommateur de `communication` résout le plan avec le port des destinataires.
 *
 * - **Qui** : les titulaires de la permission qui autorise l'action sur le périmètre de l'objet (les
 *   approbateurs de la politique figée sur la demande, l'expéditeur du site source, le réceptionnaire du
 *   site destinataire), ou le demandeur désigné par l'événement. L'auteur du fait n'est jamais prévenu de
 *   ce qu'il vient de faire ; une demande sans approbateur retombe sur la Direction (comme une alerte).
 * - **Quoi** : un message court, **sans valeur ni résumé de l'objet** — le résumé d'une demande peut
 *   porter une valeur au coût (RC-05, AV-390) et la notification part à des personnes qui n'ont pas
 *   forcément ce droit ; le libellé du type d'opération suffit, la file de validation donne le détail.
 * - **Charge utile fautive** : un événement d'un type direct dont la charge ne tient pas son contrat lève
 *   une `DirectNotificationPayloadError` — l'échec est consigné et alerté (`CONSUMER_FAILED`), jamais tu.
 */
import { approvalOperationLabel } from './approval-alerts.js';

export const DIRECT_NOTIFICATION_EVENT_TYPES = [
  'ApprovalRequested',
  'ApprovalGranted',
  'ApprovalRejected',
  'StockTransferRequested',
  'StockTransferDispatched',
  'AnalyticsExportCompleted',
] as const;
export type DirectNotificationEventType = (typeof DIRECT_NOTIFICATION_EVENT_TYPES)[number];

export function isDirectNotificationEventType(value: string): value is DirectNotificationEventType {
  return (DIRECT_NOTIFICATION_EVENT_TYPES as readonly string[]).includes(value);
}

/** Permission d'expédition (site source) et de réception (site destinataire) d'un transfert. */
export const TRANSFER_DISPATCH_PERMISSION = 'inventory.transfer.dispatch';
export const TRANSFER_RECEIVE_PERMISSION = 'inventory.transfer.receive';

/** Plafond de la partie libre d'un message (la colonne `body` en accepte davantage). */
export const DIRECT_NOTIFICATION_COMMENT_MAX = 300;

export class DirectNotificationPayloadError extends Error {
  constructor(eventType: string, detail: string) {
    super(`Charge utile de ${eventType} invalide : ${detail}.`);
    this.name = 'DirectNotificationPayloadError';
  }
}

/** Où se situe l'objet : son site, sa zone et les utilisateurs auxquels il appartient (portées `OWN`, `TEAM`). */
export interface DirectPerimeter {
  readonly siteId: string | null;
  readonly zoneId: string | null;
  readonly ownerUserIds: readonly string[];
}

export type DirectAudience =
  /** Utilisateurs désignés par l'événement (le demandeur d'une validation). */
  | { readonly kind: 'USERS'; readonly userIds: readonly string[] }
  /**
   * Titulaires de `permission` sur le périmètre, à l'exclusion de ces utilisateurs ; `permission` absente
   * (politique sans approbateur désigné) ou personne trouvé : la Direction si `fallbackToDirection`.
   */
  | {
      readonly kind: 'PERMISSION_HOLDERS';
      readonly permission: string | null;
      readonly perimeter: DirectPerimeter;
      readonly excludeUserIds: readonly string[];
      readonly fallbackToDirection: boolean;
    };

/** Type de l'objet source de la notification (colonne `source_type`). */
export type DirectNotificationSourceType =
  'APPROVAL_REQUEST' | 'STOCK_TRANSFER' | 'ANALYTICS_EXPORT';

export interface DirectNotificationPlan {
  readonly eventType: DirectNotificationEventType;
  readonly audience: DirectAudience;
  readonly title: string;
  readonly body: string;
  readonly sourceType: DirectNotificationSourceType;
  readonly sourceId: string;
  /** Nature de la notification : `DIRECT` par défaut, `EXPORT` pour la fin d'un export (P9-20, ADR-067 §7). */
  readonly kind?: 'EXPORT';
}

type Payload = Readonly<Record<string, unknown>>;

function asRecord(eventType: string, payload: unknown): Payload {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new DirectNotificationPayloadError(eventType, 'objet attendu');
  }
  return payload as Payload;
}

function requiredString(eventType: string, payload: Payload, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DirectNotificationPayloadError(eventType, `« ${key} » manquant`);
  }
  return value;
}

/** Texte facultatif : absent, nul ou vide donne `null` ; un autre type est une charge fautive. */
function optionalString(eventType: string, payload: Payload, key: string): string | null {
  const value = payload[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new DirectNotificationPayloadError(eventType, `« ${key} » doit être un texte`);
  }
  return value.trim() === '' ? null : value;
}

function truncated(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function approvalPlan(
  eventType: 'ApprovalRequested' | 'ApprovalGranted' | 'ApprovalRejected',
  aggregateId: string,
  payload: Payload,
): DirectNotificationPlan {
  const operationType = requiredString(eventType, payload, 'operation_type');
  const requester = requiredString(eventType, payload, 'requester_user_id');
  const label = approvalOperationLabel(operationType);

  if (eventType === 'ApprovalRequested') {
    return {
      eventType,
      audience: {
        kind: 'PERMISSION_HOLDERS',
        permission: optionalString(eventType, payload, 'approver_permission'),
        // Le demandeur est le propriétaire de la ressource (portées `OWN` et `TEAM` de l'approbateur) sans
        // devenir destinataire : nul ne s'approuve soi-même.
        perimeter: {
          siteId: optionalString(eventType, payload, 'site_id'),
          zoneId: optionalString(eventType, payload, 'zone_id'),
          ownerUserIds: [requester],
        },
        excludeUserIds: [requester],
        fallbackToDirection: true,
      },
      title: 'Validation à donner',
      body: `${label} : une demande attend votre décision.`,
      sourceType: 'APPROVAL_REQUEST',
      sourceId: aggregateId,
    };
  }

  const decidedBy = requiredString(eventType, payload, 'decided_by');
  const comment = optionalString(eventType, payload, 'comment');
  const approved = eventType === 'ApprovalGranted';
  const reason =
    !approved && comment !== null
      ? ` Motif : ${truncated(comment, DIRECT_NOTIFICATION_COMMENT_MAX)}`
      : '';
  return {
    eventType,
    // Le demandeur qui a validé lui-même sa demande (Direction, BR-ADM-017) n'est pas prévenu de son propre acte.
    audience: { kind: 'USERS', userIds: decidedBy === requester ? [] : [requester] },
    title: approved ? 'Validation accordée' : 'Validation refusée',
    body: `Votre demande (${label}) a été ${approved ? 'approuvée' : 'refusée'}.${reason}`,
    sourceType: 'APPROVAL_REQUEST',
    sourceId: aggregateId,
  };
}

function transferPlan(
  eventType: 'StockTransferRequested' | 'StockTransferDispatched',
  aggregateId: string,
  payload: Payload,
): DirectNotificationPlan {
  const docNumber = requiredString(eventType, payload, 'doc_number');
  const requested = eventType === 'StockTransferRequested';
  // Demandé : l'expéditeur du site source prépare ; expédié : le réceptionnaire du site destinataire attend.
  const actor = requiredString(eventType, payload, requested ? 'requested_by' : 'dispatched_by');
  const siteId = optionalString(eventType, payload, requested ? 'from_site_id' : 'to_site_id');
  return {
    eventType,
    audience: {
      kind: 'PERMISSION_HOLDERS',
      permission: requested ? TRANSFER_DISPATCH_PERMISSION : TRANSFER_RECEIVE_PERMISSION,
      perimeter: { siteId, zoneId: null, ownerUserIds: [] },
      excludeUserIds: [actor],
      fallbackToDirection: false,
    },
    title: requested ? 'Transfert à expédier' : 'Transfert en route',
    body: requested
      ? `Le transfert ${docNumber} est demandé : à préparer et à expédier.`
      : `Le transfert ${docNumber} est expédié vers votre site.`,
    sourceType: 'STOCK_TRANSFER',
    sourceId: aggregateId,
  };
}

/** Libellé court du motif d'échec d'un export (`analytics_export_jobs.error_code`). */
const EXPORT_FAILURE_REASONS: Readonly<Record<string, string>> = {
  QUERY_LIMIT_EXCEEDED:
    'trop de lignes ou trop long : affinez la période, les filtres ou les regroupements',
  FORBIDDEN: 'un droit nécessaire a été retiré',
  FORBIDDEN_MEASURE: 'la valeur au coût n’est plus accessible à votre compte',
  CATALOG_OUTDATED: 'le catalogue a changé : refaites l’export',
  SCOPE_TRUNCATED: 'votre périmètre est trop étendu pour un export complet',
  // P9-25 (PF-6, AV-469) : la tâche a épuisé ses essais sur une erreur technique.
  EXPORT_JOB_FAILED: 'incident technique, refaites l’export',
};

/**
 * Fin d'un export (P9-20 ; ADR-067 §7) : le demandeur est prévenu, quelle que soit l'issue, sans aucune donnée
 * de l'export dans le message.
 */
function exportPlan(aggregateId: string, payload: Payload): DirectNotificationPlan {
  const eventType = 'AnalyticsExportCompleted';
  const requester = requiredString(eventType, payload, 'requested_by');
  const status = requiredString(eventType, payload, 'status');
  if (status !== 'DONE' && status !== 'FAILED') {
    throw new DirectNotificationPayloadError(eventType, '« status » doit être DONE ou FAILED');
  }
  const errorCode = optionalString(eventType, payload, 'error_code');
  const reason =
    errorCode === null ? '' : ` : ${EXPORT_FAILURE_REASONS[errorCode] ?? 'erreur de production'}`;
  return {
    eventType,
    kind: 'EXPORT',
    audience: { kind: 'USERS', userIds: [requester] },
    title: status === 'DONE' ? 'Export prêt' : 'Export non produit',
    body:
      status === 'DONE'
        ? 'Votre export est prêt : il se télécharge pendant 24 heures.'
        : `Votre export n’a pas pu être produit${reason}.`,
    sourceType: 'ANALYTICS_EXPORT',
    sourceId: aggregateId,
  };
}

/**
 * Plan de notification d'un événement d'un type direct (`isDirectNotificationEventType` le décide, avant).
 * Lève `DirectNotificationPayloadError` si la charge ne tient pas son contrat.
 */
export function planDirectNotification(event: {
  readonly eventType: DirectNotificationEventType;
  readonly aggregateId: string;
  readonly payload: unknown;
}): DirectNotificationPlan {
  const payload = asRecord(event.eventType, event.payload);
  switch (event.eventType) {
    case 'ApprovalRequested':
    case 'ApprovalGranted':
    case 'ApprovalRejected':
      return approvalPlan(event.eventType, event.aggregateId, payload);
    case 'StockTransferRequested':
    case 'StockTransferDispatched':
      return transferPlan(event.eventType, event.aggregateId, payload);
    case 'AnalyticsExportCompleted':
      return exportPlan(event.aggregateId, payload);
  }
}

/**
 * `communication.direct_notification_disabled_types` : la liste des types dont la notification est
 * désactivée (AV-431). Une valeur qui n'est pas une liste de textes désactive rien (tout reste actif).
 */
export function disabledDirectNotificationTypes(
  value: unknown,
): ReadonlySet<DirectNotificationEventType> {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value.filter((entry): entry is DirectNotificationEventType => {
      return typeof entry === 'string' && isDirectNotificationEventType(entry);
    }),
  );
}
