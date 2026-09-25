/**
 * `approvals.policy.set` (UC-ADM-14 ; BR-ADM-016 ; `VERSIONNEMENT`, dictionnaire
 * `approvals.control_policies`). Comme `organization.setting.set` (P0-11) : chaque `set`
 * **insère une nouvelle version** (jamais de UPDATE sur les colonnes figées — le
 * déclencheur SQL ne laisse muter que `status`/`valid_to`, migration P0-04) ; la version
 * active précédente du même `code`, s'il y en a une, est retirée (`status='RETIRED'`,
 * `valid_to` = `occurred_at` de cette commande) dans la même transaction.
 *
 * Numérotation de version : `MAX(version) + 1` par `code`, lu sans verrou explicite —
 * DÉDUIT, action administrative rare (contrairement à `document_sequence.service.ts`,
 * INV-GLO-07, appelé à chaque document) ; la contrainte `UNIQUE (code, version)` reste le
 * filet de sécurité en cas de concurrence réelle (l'INSERT échoue, le pipeline le traduit en
 * `RETRY_LATER` — étape 7, comportement générique déjà existant, rien à coder ici).
 *
 * `condition` (JSON) : structure libre, **jamais interrogée comme donnée métier par ce
 * module** (dictionnaire, note sous `approvals.control_policies`) — sa lecture/interprétation
 * appartient au futur module propriétaire de l'`operation_type` (inventory, procurement…),
 * pas à `approvals`.
 */
import { z } from 'zod';
import type {
  CommandHandler,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';
import { toDbBool } from '../../../../platform/kysely/bool-column.js';
import { jsonValue } from '../../../../platform/kysely/json-value.js';
import { OPERATION_TYPES } from './operation-types.js';

const APPROVER_SCOPES = ['SITE', 'ZONE', 'TEAM', 'ALL'] as const;

const setPayloadSchema = z
  .object({
    code: z.string().min(1).max(40),
    operationType: z.enum(OPERATION_TYPES),
    condition: z.record(z.unknown()).optional(),
    requiresPhoto: z.boolean().optional(),
    requiresComment: z.boolean().optional(),
    requiresApproval: z.boolean().optional(),
    approverPermission: z.string().min(1).max(80).optional(),
    approverScope: z.enum(APPROVER_SCOPES).optional(),
    validFrom: z.string().datetime({ offset: true }).optional(),
    validTo: z.string().datetime({ offset: true }).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.requiresApproval && data.approverPermission === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'requiresApproval exige approverPermission (CK, dictionnaire).',
      });
    }
  });
type SetPayload = z.infer<typeof setPayloadSchema>;

const set: CommandHandler<SetPayload> = async (uow, envelope) => {
  const id = toBin(envelope.aggregate_id);
  const already = await uow
    .selectFrom('approvals_control_policies')
    .select('id')
    .where('id', '=', id)
    .executeTakeFirst();
  if (already) return { status: 'APPLIED' }; // rejeu idempotent

  const {
    code,
    operationType,
    condition,
    requiresPhoto,
    requiresComment,
    requiresApproval,
    approverPermission,
    approverScope,
    validFrom,
    validTo,
  } = envelope.payload;
  const occurredAt = new Date(envelope.occurred_at);

  const currentMax = await uow
    .selectFrom('approvals_control_policies')
    .select(({ fn }) => fn.max('version').as('maxVersion'))
    .where('code', '=', code)
    .executeTakeFirst();
  const nextVersion = (currentMax?.maxVersion ?? 0) + 1;

  await uow
    .updateTable('approvals_control_policies')
    .set({ status: 'RETIRED', valid_to: occurredAt })
    .where('code', '=', code)
    .where('status', '=', 'ACTIVE')
    .execute();

  await uow
    .insertInto('approvals_control_policies')
    .values({
      id,
      code,
      version: nextVersion,
      operation_type: operationType,
      condition: jsonValue(condition ?? {}),
      requires_photo: toDbBool(requiresPhoto ?? false),
      requires_comment: toDbBool(requiresComment ?? false),
      requires_approval: toDbBool(requiresApproval ?? false),
      approver_permission: approverPermission ?? null,
      approver_scope: approverScope ?? null,
      valid_from: validFrom !== undefined ? new Date(validFrom) : occurredAt,
      valid_to: validTo !== undefined ? new Date(validTo) : null,
      status: 'ACTIVE',
      created_by: toBin(envelope.author_user_id),
    })
    .execute();

  return { status: 'APPLIED' };
};

export function registerPolicyCommands(registry: CommandHandlerRegistry): void {
  registry.register({
    commandType: 'approvals.policy.set',
    version: 1,
    payloadSchema: setPayloadSchema,
    permissionCode: 'approvals.policy.manage',
    handler: set,
  });
}
