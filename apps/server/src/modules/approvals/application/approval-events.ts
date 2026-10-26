/**
 * Événements des demandes de validation (P9-11 (3/3) ; catalogue d'événements §2.2 ; AV-389, AV-430) :
 * `ApprovalRequested` à la création d'une demande, `ApprovalGranted` ou `ApprovalRejected` à sa décision,
 * écrits dans `platform_domain_events` dans la transaction de l'opération qui les provoque. Ils servent les
 * notifications directes de `communication` (les approbateurs de la politique, puis le demandeur).
 *
 * L'identifiant de l'événement est déterministe (type + demande) : `requestApproval` et la décision ne
 * reçoivent pas de générateur d'identifiants, et une demande n'est créée et décidée qu'une fois.
 *
 * La charge utile ne porte **jamais** le résumé de la demande ni son contenu : il peut décrire une valeur
 * au coût (RC-05, AV-390) et les notifications partent à des personnes qui n'en ont pas toutes le droit.
 */
import type { Kysely } from 'kysely';
import type { DB } from '../../../platform/kysely/database.js';
import type { UnitOfWork } from '../../../platform/unit-of-work.js';
import { deterministicEventId } from '../../../platform/events/deterministic-event-id.js';
import { jsonValue } from '../../../platform/kysely/json-value.js';
import { toBin } from '../../../platform/kysely/uuid-columns.js';

type Executor = UnitOfWork | Kysely<DB>;

async function append(
  executor: Executor,
  input: {
    readonly eventType: 'ApprovalRequested' | 'ApprovalGranted' | 'ApprovalRejected';
    readonly requestId: string;
    readonly occurredAt: Date;
    readonly payload: Record<string, unknown>;
  },
): Promise<void> {
  await executor
    .insertInto('platform_domain_events')
    .values({
      event_id: toBin(deterministicEventId(input.eventType, input.requestId)),
      event_type: input.eventType,
      producer_module: 'approvals',
      aggregate_type: 'APPROVAL_REQUEST',
      aggregate_id: toBin(input.requestId),
      occurred_at: input.occurredAt,
      payload: jsonValue(input.payload),
    })
    .execute();
}

export interface ApprovalRequestedEvent {
  readonly requestId: string;
  readonly operationType: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly amountXaf: number | null;
  readonly siteId: string | null;
  readonly zoneId: string | null;
  readonly requestedBy: string;
  readonly requestedAt: Date;
  readonly policyId: string;
}

/**
 * `ApprovalRequested` : la permission d'approbation est celle de la politique **figée sur la demande**
 * (mêmes clés que `ApprovalPendingLong` : `approver_permission`, `requester_user_id`).
 */
export async function publishApprovalRequested(
  executor: Executor,
  event: ApprovalRequestedEvent,
): Promise<void> {
  const policy = await executor
    .selectFrom('approvals_control_policies')
    .select('approver_permission')
    .where('id', '=', toBin(event.policyId))
    .executeTakeFirst();
  await append(executor, {
    eventType: 'ApprovalRequested',
    requestId: event.requestId,
    occurredAt: event.requestedAt,
    payload: {
      approval_id: event.requestId,
      operation_type: event.operationType,
      subject_type: event.subjectType,
      subject_id: event.subjectId,
      amount_xaf: event.amountXaf,
      site_id: event.siteId,
      zone_id: event.zoneId,
      requester_user_id: event.requestedBy,
      approver_permission: policy?.approver_permission ?? null,
      requested_at: event.requestedAt.toISOString(),
    },
  });
}

export interface ApprovalDecidedEvent {
  readonly requestId: string;
  readonly operationType: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly siteId: string | null;
  readonly zoneId: string | null;
  readonly requestedBy: string;
  readonly decision: 'APPROVED' | 'REJECTED';
  readonly decisionOption: string | null;
  readonly decidedBy: string;
  readonly decidedAt: Date;
  /** Motif saisi par l'approbateur, tel quel ; `null` si vide. */
  readonly comment: string | null;
}

/** `ApprovalGranted` (approuvée) ou `ApprovalRejected` (refusée). */
export async function publishApprovalDecided(
  executor: Executor,
  event: ApprovalDecidedEvent,
): Promise<void> {
  await append(executor, {
    eventType: event.decision === 'APPROVED' ? 'ApprovalGranted' : 'ApprovalRejected',
    requestId: event.requestId,
    occurredAt: event.decidedAt,
    payload: {
      approval_id: event.requestId,
      operation_type: event.operationType,
      subject_type: event.subjectType,
      subject_id: event.subjectId,
      site_id: event.siteId,
      zone_id: event.zoneId,
      requester_user_id: event.requestedBy,
      decision: event.decision,
      decision_option: event.decisionOption,
      decided_by: event.decidedBy,
      comment: event.comment,
      decided_at: event.decidedAt.toISOString(),
    },
  });
}
