/**
 * Zones (organization.zones, BR-ADM-012 ; docs/03-data/dictionnaire/02-organization.md).
 * `zone_ancestors` (fermeture transitive) est maintenue ici, à la création (dictionnaire :
 * « maintenue par le gestionnaire de commande à la création ou au déplacement d'une zone »).
 *
 * Hors périmètre P0-11, délibérément :
 * - déplacer une zone existante (changer `parent_id`) — recalcul intégral de
 *   `zone_ancestors` pour tout le sous-arbre déplacé, détection de cycle (CK « pas de
 *   cycle (TX) »). Le dictionnaire qualifie l'opération elle-même de « rare ».
 * - modifier le géorepère d'une zone existante (le fixer à la création suffit à la
 *   démonstration de sortie de phase) — `organization.zone.update` ne touche donc que les
 *   colonnes non structurelles (nom, précision GPS maximale, actif).
 * Paramétrable plus tard si un besoin réel apparaît (règle CLAUDE.md #2).
 */
import { z } from 'zod';
import { sql } from 'kysely';
import { buildGeofence } from '@gic/domain';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import { toDbBool } from '../../../../platform/kysely/bool-column.js';

const zoneLevelSchema = z.enum(['PAYS', 'REGION', 'VILLE', 'MARCHE', 'QUARTIER', 'SECTEUR']);

const createPayloadSchema = z.object({
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(200),
  level: zoneLevelSchema,
  parentId: z.string().uuid().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  radiusM: z.number().optional(),
  maxGpsAccuracyM: z.number().positive().optional(),
});

const updatePayloadSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  maxGpsAccuracyM: z.number().positive().optional(),
  isActive: z.boolean().optional(),
});

type CreatePayload = z.infer<typeof createPayloadSchema>;
type UpdatePayload = z.infer<typeof updatePayloadSchema>;

function notFound(messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode: 'NOT_FOUND', messageFr };
}

function geofenceInvalid(messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode: 'GEOFENCE_INVALID', messageFr };
}

const create: CommandHandler<CreatePayload> = async (uow, envelope) => {
  const zoneId = toBin(envelope.aggregate_id);
  const already = await uow
    .selectFrom('organization_zones')
    .select('id')
    .where('id', '=', zoneId)
    .executeTakeFirst();
  if (already) return { status: 'APPLIED' }; // rejeu idempotent

  const { code, name, level, parentId, lat, lng, radiusM, maxGpsAccuracyM } = envelope.payload;

  let depth = 1;
  if (parentId !== undefined) {
    const parent = await uow
      .selectFrom('organization_zones')
      .select('depth')
      .where('id', '=', toBin(parentId))
      .executeTakeFirst();
    if (!parent) return notFound('Zone parente introuvable.');
    depth = parent.depth + 1;
  }

  let geofence;
  try {
    geofence = buildGeofence({
      ...(lat !== undefined ? { lat } : {}),
      ...(lng !== undefined ? { lng } : {}),
      ...(radiusM !== undefined ? { radiusM } : {}),
    });
  } catch (error) {
    return geofenceInvalid(error instanceof Error ? error.message : String(error));
  }

  await uow
    .insertInto('organization_zones')
    .values({
      id: zoneId,
      parent_id: toBinOrNull(parentId ?? null),
      level,
      code,
      name,
      depth,
      geofence_lat: geofence !== null ? String(geofence.lat) : null,
      geofence_lng: geofence !== null ? String(geofence.lng) : null,
      geofence_radius_m: geofence !== null ? String(geofence.radiusM) : null,
      max_gps_accuracy_m: maxGpsAccuracyM !== undefined ? String(maxGpsAccuracyM) : null,
      created_by: toBin(envelope.author_user_id),
    })
    .execute();

  await uow
    .insertInto('organization_zone_ancestors')
    .values({ zone_id: zoneId, ancestor_id: zoneId, depth: 0 })
    .execute();
  if (parentId !== undefined) {
    const parentAncestors = await uow
      .selectFrom('organization_zone_ancestors')
      .select(['ancestor_id', 'depth'])
      .where('zone_id', '=', toBin(parentId))
      .execute();
    for (const ancestor of parentAncestors) {
      await uow
        .insertInto('organization_zone_ancestors')
        .values({ zone_id: zoneId, ancestor_id: ancestor.ancestor_id, depth: ancestor.depth + 1 })
        .execute();
    }
  }

  return { status: 'APPLIED' };
};

const update: CommandHandler<UpdatePayload> = async (uow, envelope) => {
  const zoneId = toBin(envelope.aggregate_id);
  const zone = await uow
    .selectFrom('organization_zones')
    .select('id')
    .where('id', '=', zoneId)
    .executeTakeFirst();
  if (!zone) return notFound('Zone introuvable.');

  const { name, maxGpsAccuracyM, isActive } = envelope.payload;
  await uow
    .updateTable('organization_zones')
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(maxGpsAccuracyM !== undefined ? { max_gps_accuracy_m: String(maxGpsAccuracyM) } : {}),
      ...(isActive !== undefined ? { is_active: toDbBool(isActive) } : {}),
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('id', '=', zoneId)
    .execute();
  return { status: 'APPLIED' };
};

export function registerZoneCommands(registry: CommandHandlerRegistry): void {
  registry.register({
    commandType: 'organization.zone.create',
    version: 1,
    payloadSchema: createPayloadSchema,
    permissionCode: 'org.structure.manage',
    handler: create,
  });
  registry.register({
    commandType: 'organization.zone.update',
    version: 1,
    payloadSchema: updatePayloadSchema,
    permissionCode: 'org.structure.manage',
    handler: update,
  });
}
