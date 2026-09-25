/**
 * `approvals.requestApproval` (ADR-018 ; SM-APPROVAL `[*] --> PENDING`) : API interne
 * appelée par le module propriétaire d'une opération, **dans la transaction de son propre
 * gestionnaire de commande** — jamais un `command_type` à part entière (la demande de
 * validation est un effet de bord de l'opération, pas une commande indépendante de
 * l'appareil).
 *
 * Le choix de la politique applicable (correspondance de `condition`, jamais interrogée par
 * `approvals` lui-même — voir `policy-commands.ts`) revient entièrement à l'appelant, qui a
 * déjà lu `currentPolicies(operationType, occurredAt)` et décidé qu'une validation est
 * requise avant d'appeler cette fonction.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import { jsonValue } from '../../../../platform/kysely/json-value.js';
import type { OperationType } from '../commands/operation-types.js';

export interface RequestApprovalInput {
  /** UUIDv7 fourni par l'appelant (idempotence : même convention que `aggregate_id`). */
  readonly requestId: string;
  readonly operationType: OperationType;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly subjectSummary: string;
  readonly siteId?: string;
  readonly zoneId?: string;
  readonly amountXaf?: number;
  readonly requestedBy: string;
  readonly requestedAt: Date;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly requiredAttachmentIds?: readonly string[];
}

export async function requestApproval(
  executor: Kysely<DB> | Transaction<DB>,
  input: RequestApprovalInput,
): Promise<void> {
  await executor
    .insertInto('approvals_approval_requests')
    .values({
      id: toBin(input.requestId),
      operation_type: input.operationType,
      subject_type: input.subjectType,
      subject_id: toBin(input.subjectId),
      subject_summary: input.subjectSummary,
      site_id: toBinOrNull(input.siteId ?? null),
      zone_id: toBinOrNull(input.zoneId ?? null),
      amount_xaf: input.amountXaf ?? null,
      requested_by: toBin(input.requestedBy),
      requested_at: input.requestedAt,
      policy_id: toBin(input.policyId),
      policy_version: input.policyVersion,
      required_attachment_ids: jsonValue(input.requiredAttachmentIds ?? []),
      created_by: toBin(input.requestedBy),
    })
    .execute();
}
