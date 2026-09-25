/**
 * Paramètres système historisés (organization.system_settings, BR-ADM-015 ; docs/03-data/
 * dictionnaire/02-organization.md). `VERSIONNEMENT` : chaque `set` **insère une nouvelle
 * ligne** (jamais de UPDATE) — l'ancienne valeur reste consultable ; la valeur en vigueur à
 * un instant `t` (dernière `valid_from ≤ t`, BR-ADM-016) est calculée par le lecteur,
 * `application/public/setting-query.ts`, pas ici.
 */
import { z } from 'zod';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import { toDbBool } from '../../../../platform/kysely/bool-column.js';
import { jsonValue } from '../../../../platform/kysely/json-value.js';

const settingScopeTypeSchema = z.enum(['GLOBAL', 'SITE', 'ZONE', 'ROLE']);

const setPayloadSchema = z
  .object({
    key: z.string().min(1).max(100),
    value: z.unknown(),
    scopeType: settingScopeTypeSchema,
    scopeId: z.string().uuid().optional(),
    isClientVisible: z.boolean().optional(),
    reason: z.string().max(500).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.scopeType === 'GLOBAL' && data.scopeId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'scopeType GLOBAL ne doit porter aucun scopeId.',
      });
    }
    if (data.scopeType !== 'GLOBAL' && data.scopeId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `scopeType ${data.scopeType} exige scopeId.`,
      });
    }
  });

type SetPayload = z.infer<typeof setPayloadSchema>;

function notFound(messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode: 'NOT_FOUND', messageFr };
}

const scopeTable: Record<
  'SITE' | 'ZONE' | 'ROLE',
  'organization_sites' | 'organization_zones' | 'identity_roles'
> = {
  SITE: 'organization_sites',
  ZONE: 'organization_zones',
  ROLE: 'identity_roles',
};

const set: CommandHandler<SetPayload> = async (uow, envelope) => {
  const settingId = toBin(envelope.aggregate_id);
  const already = await uow
    .selectFrom('organization_system_settings')
    .select('id')
    .where('id', '=', settingId)
    .executeTakeFirst();
  if (already) return { status: 'APPLIED' }; // rejeu idempotent

  const { key, value, scopeType, scopeId, isClientVisible, reason } = envelope.payload;

  if (scopeType !== 'GLOBAL' && scopeId !== undefined) {
    const table = scopeTable[scopeType];
    const row = await uow
      .selectFrom(table)
      .select('id')
      .where('id', '=', toBin(scopeId))
      .executeTakeFirst();
    if (!row) return notFound(`Cible introuvable pour la portée ${scopeType} (scopeId).`);
  }

  await uow
    .insertInto('organization_system_settings')
    .values({
      id: settingId,
      key,
      value: jsonValue(value),
      scope_type: scopeType,
      scope_id: toBinOrNull(scopeId ?? null),
      valid_from: new Date(envelope.occurred_at),
      is_client_visible: toDbBool(isClientVisible ?? false),
      created_by: toBin(envelope.author_user_id),
      reason: reason ?? null,
    })
    .execute();
  return { status: 'APPLIED' };
};

export function registerSettingCommands(registry: CommandHandlerRegistry): void {
  registry.register({
    commandType: 'organization.setting.set',
    version: 1,
    payloadSchema: setPayloadSchema,
    permissionCode: 'org.settings.manage',
    handler: set,
  });
}
