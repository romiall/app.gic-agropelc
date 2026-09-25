/**
 * Emplacements physiques (organization.locations, BR-ADM-009 à 011 ; docs/03-data/
 * dictionnaire/02-organization.md). Les emplacements **virtuels** (`V_*`) sont créés par le
 * seed système (BR-ADM-010, ADR-003) : cette commande ne crée que des emplacements
 * physiques, `locationType` exclut volontairement les types `V_*` (le schéma Zod ne les
 * liste même pas).
 *
 * `deactivate` (BR-ADM-011, « soldes nuls, aucun transfert/réservation/allocation en cours »)
 * : condition non vérifiable en P0 — le module `inventory` (mouvements, soldes) n'existe pas
 * encore. Seule la partie structurelle (jamais un emplacement virtuel, toujours vrai ici
 * puisque cette commande n'en crée aucun) est appliquée ; la condition de solde sera
 * ajoutée par `inventory` quand il existera (règle CLAUDE.md #2 : paramétrable, pas ignorée
 * en silence — documentée ici).
 */
import { z } from 'zod';
import { sql } from 'kysely';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';

const physicalLocationTypeSchema = z.enum([
  'STORE',
  'POS',
  'BUILDING',
  'PEN',
  'INCUBATOR',
  'HATCHER',
  'MOBILE',
]);
const custodyModeSchema = z.enum(['EXCLUSIVE_USER', 'EXCLUSIVE_DEVICE', 'SHARED']);

const createPayloadSchema = z
  .object({
    siteId: z.string().uuid(),
    parentLocationId: z.string().uuid().optional(),
    code: z.string().min(1).max(40),
    name: z.string().min(1).max(200),
    locationType: physicalLocationTypeSchema,
    custodyMode: custodyModeSchema.optional(),
    custodianUserId: z.string().uuid().optional(),
    designatedDeviceId: z.string().uuid().optional(),
    capacity: z.number().int().positive().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.locationType === 'MOBILE') {
      if (data.custodianUserId === undefined || data.custodyMode !== 'EXCLUSIVE_USER') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'MOBILE exige custodianUserId et custodyMode EXCLUSIVE_USER.',
        });
      }
    }
    if (data.custodyMode === 'EXCLUSIVE_DEVICE' && data.designatedDeviceId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'custodyMode EXCLUSIVE_DEVICE exige designatedDeviceId.',
      });
    }
  });

const updatePayloadSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  capacity: z.number().int().positive().optional(),
});

type CreatePayload = z.infer<typeof createPayloadSchema>;
type UpdatePayload = z.infer<typeof updatePayloadSchema>;
type DeactivatePayload = Record<string, never>;

function notFound(messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode: 'NOT_FOUND', messageFr };
}

function invalid(errorCode: string, messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode, messageFr };
}

const create: CommandHandler<CreatePayload> = async (uow, envelope) => {
  const locationId = toBin(envelope.aggregate_id);
  const already = await uow
    .selectFrom('organization_locations')
    .select('id')
    .where('id', '=', locationId)
    .executeTakeFirst();
  if (already) return { status: 'APPLIED' };

  const {
    siteId,
    parentLocationId,
    code,
    name,
    locationType,
    custodyMode,
    custodianUserId,
    designatedDeviceId,
    capacity,
  } = envelope.payload;

  const site = await uow
    .selectFrom('organization_sites')
    .select('id')
    .where('id', '=', toBin(siteId))
    .executeTakeFirst();
  if (!site) return notFound('Site introuvable.');

  if (parentLocationId !== undefined) {
    const parent = await uow
      .selectFrom('organization_locations')
      .select('location_type')
      .where('id', '=', toBin(parentLocationId))
      .executeTakeFirst();
    if (!parent) return notFound('Emplacement parent introuvable.');
    if (locationType === 'PEN' && parent.location_type !== 'BUILDING') {
      return invalid('LOCATION_PARENT_INVALID', 'Une case (PEN) exige un parent de type BUILDING.');
    }
  } else if (locationType === 'PEN') {
    return invalid('LOCATION_PARENT_INVALID', 'Une case (PEN) exige un parent de type BUILDING.');
  }

  if (custodianUserId !== undefined) {
    const custodian = await uow
      .selectFrom('identity_users')
      .select('status')
      .where('id', '=', toBin(custodianUserId))
      .executeTakeFirst();
    if (!custodian) return notFound('Détenteur introuvable (custodianUserId).');
    if (custodian.status !== 'ACTIVE') {
      return invalid('LOCATION_CUSTODIAN_INVALID', 'Le détenteur doit être un utilisateur actif.');
    }
  }

  await uow
    .insertInto('organization_locations')
    .values({
      id: locationId,
      site_id: toBin(siteId),
      parent_location_id: toBinOrNull(parentLocationId ?? null),
      code,
      name,
      location_type: locationType,
      custody_mode: custodyMode ?? null,
      custodian_user_id: toBinOrNull(custodianUserId ?? null),
      designated_device_id: toBinOrNull(designatedDeviceId ?? null),
      capacity: capacity ?? null,
      created_by: toBin(envelope.author_user_id),
    })
    .execute();
  return { status: 'APPLIED' };
};

const update: CommandHandler<UpdatePayload> = async (uow, envelope) => {
  const locationId = toBin(envelope.aggregate_id);
  const location = await uow
    .selectFrom('organization_locations')
    .select('is_virtual')
    .where('id', '=', locationId)
    .executeTakeFirst();
  if (!location) return notFound('Emplacement introuvable.');
  if (location.is_virtual) {
    return invalid(
      'LOCATION_VIRTUAL_IMMUTABLE',
      'Un emplacement virtuel ne peut pas être modifié (BR-ADM-010).',
    );
  }

  const { name, capacity } = envelope.payload;
  await uow
    .updateTable('organization_locations')
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(capacity !== undefined ? { capacity } : {}),
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('id', '=', locationId)
    .execute();
  return { status: 'APPLIED' };
};

const deactivate: CommandHandler<DeactivatePayload> = async (uow, envelope) => {
  const locationId = toBin(envelope.aggregate_id);
  const location = await uow
    .selectFrom('organization_locations')
    .select(['status', 'is_virtual'])
    .where('id', '=', locationId)
    .executeTakeFirst();
  if (!location) return notFound('Emplacement introuvable.');
  if (location.status === 'INACTIVE') return { status: 'APPLIED' }; // rejeu idempotent
  if (location.is_virtual) {
    return invalid(
      'LOCATION_VIRTUAL_IMMUTABLE',
      'Un emplacement virtuel ne peut pas être désactivé (BR-ADM-010).',
    );
  }

  await uow
    .updateTable('organization_locations')
    .set({
      status: 'INACTIVE',
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('id', '=', locationId)
    .execute();
  return { status: 'APPLIED' };
};

export function registerLocationCommands(registry: CommandHandlerRegistry): void {
  registry.register({
    commandType: 'organization.location.create',
    version: 1,
    payloadSchema: createPayloadSchema,
    permissionCode: 'org.structure.manage',
    handler: create,
  });
  registry.register({
    commandType: 'organization.location.update',
    version: 1,
    payloadSchema: updatePayloadSchema,
    permissionCode: 'org.structure.manage',
    handler: update,
  });
  registry.register({
    commandType: 'organization.location.deactivate',
    version: 1,
    payloadSchema: z.object({}),
    permissionCode: 'org.structure.manage',
    handler: deactivate,
  });
}
