/**
 * Configuration d'un point de vente (organization.points_of_sale, extension 1:1 d'un site
 * `POINT_DE_VENTE` — docs/03-data/dictionnaire/02-organization.md). `site_id` est la clé
 * primaire de la table : l'agrégat de cette commande est le site lui-même
 * (`aggregate_id = site_id`), pas un identifiant propre — la commande est un
 * « configurer », naturellement idempotente par upsert (rejouer la même configuration, ou
 * la faire évoluer, produit le même état final sans registre d'existence séparé).
 */
import { z } from 'zod';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';

const custodyModeSchema = z.enum(['EXCLUSIVE_DEVICE', 'SHARED']);

const configurePayloadSchema = z
  .object({
    salesLocationId: z.string().uuid(),
    replenishmentSourceLocationId: z.string().uuid().optional(),
    custodyMode: custodyModeSchema,
    designatedDeviceId: z.string().uuid().optional(),
    openingHours: z.string().max(500).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.custodyMode === 'EXCLUSIVE_DEVICE' && data.designatedDeviceId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'custodyMode EXCLUSIVE_DEVICE exige designatedDeviceId.',
      });
    }
  });

type ConfigurePayload = z.infer<typeof configurePayloadSchema>;

function notFound(messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode: 'NOT_FOUND', messageFr };
}

const configure: CommandHandler<ConfigurePayload> = async (uow, envelope) => {
  const siteId = toBin(envelope.aggregate_id);
  const site = await uow
    .selectFrom('organization_sites')
    .select('site_type')
    .where('id', '=', siteId)
    .executeTakeFirst();
  if (!site) return notFound('Site introuvable.');
  if (site.site_type !== 'POINT_DE_VENTE') {
    return {
      status: 'REJECTED',
      errorCode: 'NOT_A_POS',
      messageFr: 'Ce site n’est pas un point de vente.',
    };
  }

  const {
    salesLocationId,
    replenishmentSourceLocationId,
    custodyMode,
    designatedDeviceId,
    openingHours,
  } = envelope.payload;
  const salesLocation = await uow
    .selectFrom('organization_locations')
    .select('id')
    .where('id', '=', toBin(salesLocationId))
    .executeTakeFirst();
  if (!salesLocation) return notFound('Emplacement de vente introuvable (salesLocationId).');

  if (replenishmentSourceLocationId !== undefined) {
    const source = await uow
      .selectFrom('organization_locations')
      .select('id')
      .where('id', '=', toBin(replenishmentSourceLocationId))
      .executeTakeFirst();
    if (!source) return notFound('Magasin source introuvable (replenishmentSourceLocationId).');
  }
  if (designatedDeviceId !== undefined) {
    const device = await uow
      .selectFrom('identity_devices')
      .select('id')
      .where('id', '=', toBin(designatedDeviceId))
      .executeTakeFirst();
    if (!device) return notFound('Appareil introuvable (designatedDeviceId).');
  }

  await uow
    .insertInto('organization_points_of_sale')
    .values({
      site_id: siteId,
      sales_location_id: toBin(salesLocationId),
      replenishment_source_location_id: toBinOrNull(replenishmentSourceLocationId ?? null),
      custody_mode: custodyMode,
      designated_device_id: toBinOrNull(designatedDeviceId ?? null),
      opening_hours: openingHours ?? null,
      created_by: toBin(envelope.author_user_id),
    })
    .onDuplicateKeyUpdate({
      sales_location_id: toBin(salesLocationId),
      replenishment_source_location_id: toBinOrNull(replenishmentSourceLocationId ?? null),
      custody_mode: custodyMode,
      designated_device_id: toBinOrNull(designatedDeviceId ?? null),
      opening_hours: openingHours ?? null,
      updated_by: toBin(envelope.author_user_id),
    })
    .execute();
  return { status: 'APPLIED' };
};

export function registerPosCommands(registry: CommandHandlerRegistry): void {
  registry.register({
    commandType: 'organization.pos.configure',
    version: 1,
    payloadSchema: configurePayloadSchema,
    permissionCode: 'org.structure.manage',
    handler: configure,
  });
}
