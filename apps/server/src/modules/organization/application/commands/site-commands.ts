/**
 * Sites (organization.sites, BR-ADM-008 ; docs/03-data/dictionnaire/02-organization.md).
 * Un site fermé (`CLOSED`) n'accepte plus de nouvelles opérations mais reste consultable —
 * `close` est donc une fermeture définitive (pas de réouverture dans la matrice de
 * transitions documentée ; aucune commande `reopen` n'existe).
 */
import { z } from 'zod';
import { sql } from 'kysely';
import { businessDayOf, businessDayStartUtc } from '@gic/domain';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';

const siteTypeSchema = z.enum(['FERME', 'MAGASIN', 'POINT_DE_VENTE', 'BUREAU']);

const createPayloadSchema = z.object({
  code: z.string().min(1).max(10),
  name: z.string().min(1).max(200),
  siteType: siteTypeSchema,
  zoneId: z.string().uuid(),
  address: z.string().max(500).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  openedOn: z.string().date().optional(),
});

const updatePayloadSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  address: z.string().max(500).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
});

type CreatePayload = z.infer<typeof createPayloadSchema>;
type UpdatePayload = z.infer<typeof updatePayloadSchema>;
type ClosePayload = Record<string, never>;

function notFound(messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode: 'NOT_FOUND', messageFr };
}

const create: CommandHandler<CreatePayload> = async (uow, envelope) => {
  const siteId = toBin(envelope.aggregate_id);
  const already = await uow
    .selectFrom('organization_sites')
    .select('id')
    .where('id', '=', siteId)
    .executeTakeFirst();
  if (already) return { status: 'APPLIED' };

  const { code, name, siteType, zoneId, address, lat, lng, openedOn } = envelope.payload;
  const zone = await uow
    .selectFrom('organization_zones')
    .select('id')
    .where('id', '=', toBin(zoneId))
    .executeTakeFirst();
  if (!zone) return notFound('Zone introuvable.');

  await uow
    .insertInto('organization_sites')
    .values({
      id: siteId,
      code,
      name,
      site_type: siteType,
      zone_id: toBin(zoneId),
      address: address ?? null,
      lat: lat ?? null,
      lng: lng ?? null,
      opened_on: openedOn !== undefined ? businessDayStartUtc(openedOn) : null,
      created_by: toBin(envelope.author_user_id),
    })
    .execute();
  return { status: 'APPLIED' };
};

const update: CommandHandler<UpdatePayload> = async (uow, envelope) => {
  const siteId = toBin(envelope.aggregate_id);
  const site = await uow
    .selectFrom('organization_sites')
    .select('id')
    .where('id', '=', siteId)
    .executeTakeFirst();
  if (!site) return notFound('Site introuvable.');

  const { name, address, lat, lng } = envelope.payload;
  await uow
    .updateTable('organization_sites')
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(address !== undefined ? { address } : {}),
      ...(lat !== undefined ? { lat: String(lat) } : {}),
      ...(lng !== undefined ? { lng: String(lng) } : {}),
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('id', '=', siteId)
    .execute();
  return { status: 'APPLIED' };
};

const close: CommandHandler<ClosePayload> = async (uow, envelope) => {
  const siteId = toBin(envelope.aggregate_id);
  const site = await uow
    .selectFrom('organization_sites')
    .select('status')
    .where('id', '=', siteId)
    .executeTakeFirst();
  if (!site) return notFound('Site introuvable.');
  if (site.status === 'CLOSED') return { status: 'APPLIED' }; // rejeu idempotent

  const occurredAt = new Date(envelope.occurred_at);
  const closedOn = businessDayStartUtc(businessDayOf(occurredAt));
  await uow
    .updateTable('organization_sites')
    .set({
      status: 'CLOSED',
      closed_on: closedOn,
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('id', '=', siteId)
    .execute();
  return { status: 'APPLIED' };
};

export function registerSiteCommands(registry: CommandHandlerRegistry): void {
  registry.register({
    commandType: 'organization.site.create',
    version: 1,
    payloadSchema: createPayloadSchema,
    permissionCode: 'org.structure.manage',
    handler: create,
  });
  registry.register({
    commandType: 'organization.site.update',
    version: 1,
    payloadSchema: updatePayloadSchema,
    permissionCode: 'org.structure.manage',
    handler: update,
  });
  registry.register({
    commandType: 'organization.site.close',
    version: 1,
    payloadSchema: z.object({}),
    permissionCode: 'org.structure.manage',
    handler: close,
  });
}
