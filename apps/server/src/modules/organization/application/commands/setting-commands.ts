/**
 * Paramètres système historisés (organization.system_settings, BR-ADM-015 ; docs/03-data/
 * dictionnaire/02-organization.md). `VERSIONNEMENT` : chaque `set` **insère une nouvelle
 * ligne** (jamais de UPDATE) — l'ancienne valeur reste consultable ; la valeur en vigueur à
 * un instant `t` (dernière `valid_from ≤ t`, BR-ADM-016) est calculée par le lecteur,
 * `application/public/setting-query.ts`, pas ici.
 */
import { z } from 'zod';
import { settingDefOf, validateSettingValue, type SettingProblem } from '@gic/contracts';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import { toDbBool } from '../../../../platform/kysely/bool-column.js';
import { jsonValue } from '../../../../platform/kysely/json-value.js';
import { emitSettingChange } from '../sync-changes.js';

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

const PROBLEM_MESSAGES_FR: Readonly<Record<SettingProblem, string>> = {
  TYPE: 'le type de la valeur ne convient pas à ce paramètre',
  NOT_INTEGER: 'ce paramètre attend un nombre entier',
  MIN: 'la valeur est inférieure au minimum de ce paramètre',
  MAX: 'la valeur dépasse le maximum de ce paramètre',
  OPTION: 'la valeur n’est pas l’un des choix de ce paramètre',
  EMPTY_ITEM: 'un élément de la liste est vide',
  WEEKDAY: 'les jours se numérotent de 1 (lundi) à 7 (dimanche)',
  JSON_OBJECT: 'ce paramètre attend un objet',
};

/**
 * AV-496 (b) : la valeur d'une clé du catalogue partagé (`settings-catalog.ts`, celui de l'écran des
 * paramètres) est contrôlée par le serveur lui-même, pour qu'un autre client de l'API ne pose pas une valeur
 * de mauvais type. Une clé hors catalogue reste libre (toute valeur JSON).
 */
function invalidValue(key: string, value: unknown): CommandHandlerOutcome | null {
  if (value === undefined) {
    return {
      status: 'REJECTED',
      errorCode: 'SETTING_VALUE_INVALID',
      messageFr: `Valeur absente pour le paramètre ${key}.`,
    };
  }
  const def = settingDefOf(key);
  if (def === undefined) return null;
  const problem = validateSettingValue(def, value);
  return problem === null
    ? null
    : {
        status: 'REJECTED',
        errorCode: 'SETTING_VALUE_INVALID',
        messageFr: `Valeur refusée pour le paramètre ${key} : ${PROBLEM_MESSAGES_FR[problem]}.`,
      };
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

  const invalid = invalidValue(key, value);
  if (invalid) return invalid;

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
  // P5-18 : la version visible atteint les appareils, les précédentes en sortent (jeu `me`, AV-196).
  await emitSettingChange(uow, envelope.aggregate_id);
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
