/**
 * Zones (organization.zones, BR-ADM-012 ; docs/03-data/dictionnaire/02-organization.md).
 * `zone_ancestors` (fermeture transitive) est maintenue ici, à la création (dictionnaire :
 * « maintenue par le gestionnaire de commande à la création ou au déplacement d'une zone »).
 *
 * Géorepère (AV-003, AV-022) : fixé à la création ou modifié par `organization.zone.update`
 * (P3-09 : les zones de pointage se saisissent avant l'arrivée des commerciaux). Rayon par
 * défaut = paramètre `fieldwork.geofence_radius_m` en vigueur (règle 8) ; la constante de
 * `buildGeofence` ne sert qu'en l'absence du paramètre. Aucune version antérieure n'est
 * conservée dans la zone (le journal d'audit garde l'avant / après) : chaque tentative de
 * pointage fige le géorepère qu'elle a utilisé (BR-TER-001).
 *
 * Déplacer une zone (`organization.zone.move`, AV-515 ; le dictionnaire qualifie l'opération de « rare ») :
 * changer sa zone parente (ou en faire une racine) recalcule `zone_ancestors` et la profondeur de toute la
 * sous-arborescence déplacée, sans cycle possible (CK « pas de cycle (TX) »). Les affectations de rôle de zone
 * suivent d'elles-mêmes (elles se lisent par la fermeture) ; la spécificité déjà écrite d'une règle de prix,
 * calculée à sa création depuis la profondeur d'alors, n'est pas recalculée (le moteur la recalcule depuis la
 * profondeur courante, AV-515).
 */
import { z } from 'zod';
import { sql } from 'kysely';
import { buildGeofence } from '@gic/domain';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { fromBin, toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import { toDbBool } from '../../../../platform/kysely/bool-column.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { recordChanges } from '../../../../platform/sync/change-feed.js';
import { currentSettingValue } from '../public/setting-query.js';

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
  /** Nouveau géorepère ; `null` le retire (la zone ne sert plus au pointage). */
  geofence: z
    .object({ lat: z.number(), lng: z.number(), radiusM: z.number().optional() })
    .nullable()
    .optional(),
});

const movePayloadSchema = z.object({
  /** Nouvelle zone parente ; `null` fait de la zone une zone racine. */
  parentId: z.string().uuid().nullable(),
});

type CreatePayload = z.infer<typeof createPayloadSchema>;
type UpdatePayload = z.infer<typeof updatePayloadSchema>;
type MovePayload = z.infer<typeof movePayloadSchema>;

function notFound(messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode: 'NOT_FOUND', messageFr };
}

function geofenceInvalid(messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode: 'GEOFENCE_INVALID', messageFr };
}

/** AV-022 : rayon par défaut en vigueur à `at` (paramètre système, règle 8). */
async function defaultRadiusM(uow: UnitOfWork, at: Date): Promise<number | undefined> {
  const value = await currentSettingValue(uow, {
    key: 'fieldwork.geofence_radius_m',
    scopeType: 'GLOBAL',
    scopeId: null,
    at,
  });
  const parsed = typeof value === 'number' ? value : Number(value);
  return value !== undefined && value !== null && Number.isFinite(parsed) ? parsed : undefined;
}

type GeofenceColumns = {
  readonly geofence_lat: string | null;
  readonly geofence_lng: string | null;
  readonly geofence_radius_m: string | null;
};

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
    // Verrou partagé : un déplacement de la parente (`organization.zone.move`) attend cette création, ou
    // l'inverse, au lieu de laisser des ancêtres périmés à la nouvelle zone.
    const parent = await uow
      .selectFrom('organization_zones')
      .select('depth')
      .where('id', '=', toBin(parentId))
      .forShare()
      .executeTakeFirst();
    if (!parent) return notFound('Zone parente introuvable.');
    depth = parent.depth + 1;
  }

  const radius =
    radiusM ??
    (lat !== undefined || lng !== undefined
      ? await defaultRadiusM(uow, new Date(envelope.occurred_at))
      : undefined);
  let geofence;
  try {
    geofence = buildGeofence({
      ...(lat !== undefined ? { lat } : {}),
      ...(lng !== undefined ? { lng } : {}),
      ...(radius !== undefined ? { radiusM: radius } : {}),
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
    .select(['id', 'geofence_lat', 'geofence_lng', 'geofence_radius_m'])
    .where('id', '=', zoneId)
    .forUpdate()
    .executeTakeFirst();
  if (!zone) return notFound('Zone introuvable.');

  const { name, maxGpsAccuracyM, isActive, geofence } = envelope.payload;
  let geofenceColumns: GeofenceColumns | undefined;
  if (geofence === null) {
    geofenceColumns = { geofence_lat: null, geofence_lng: null, geofence_radius_m: null };
  } else if (geofence !== undefined) {
    const radius = geofence.radiusM ?? (await defaultRadiusM(uow, new Date(envelope.occurred_at)));
    try {
      const built = buildGeofence({
        lat: geofence.lat,
        lng: geofence.lng,
        ...(radius !== undefined ? { radiusM: radius } : {}),
      })!;
      geofenceColumns = {
        geofence_lat: String(built.lat),
        geofence_lng: String(built.lng),
        geofence_radius_m: String(built.radiusM),
      };
    } catch (error) {
      return geofenceInvalid(error instanceof Error ? error.message : String(error));
    }
  }
  await uow
    .updateTable('organization_zones')
    .set({
      ...(name !== undefined ? { name } : {}),
      ...(maxGpsAccuracyM !== undefined ? { max_gps_accuracy_m: String(maxGpsAccuracyM) } : {}),
      ...(isActive !== undefined ? { is_active: toDbBool(isActive) } : {}),
      ...(geofenceColumns ?? {}),
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('id', '=', zoneId)
    .execute();
  if (geofenceColumns === undefined) return { status: 'APPLIED' };
  // BR-ADM-013 : l'ancien géorepère reste lisible dans le journal (avant / après).
  const asGeofence = (columns: GeofenceColumns) =>
    columns.geofence_lat === null
      ? null
      : {
          lat: Number(columns.geofence_lat),
          lng: Number(columns.geofence_lng),
          radiusM: Number(columns.geofence_radius_m),
        };
  return {
    status: 'APPLIED',
    audit: {
      before: { geofence: asGeofence(zone) },
      after: { ...envelope.payload, geofence: asGeofence(geofenceColumns) },
    },
  };
};

/** Les lignes de fermeture ajoutées d'un coup (une zone déplacée avec une grande sous-arborescence). */
const CLOSURE_INSERT_CHUNK = 500;

/**
 * Déplace une zone et toute sa sous-arborescence sous une autre zone parente, ou à la racine (AV-515).
 * Verrous : la zone, ses descendantes, puis la nouvelle parente (`FOR UPDATE`) ; une création sous l'une
 * d'elles (verrou partagé de `create`) attend. Rejeu ou déplacement redondant : sans effet.
 */
const move: CommandHandler<MovePayload> = async (uow, envelope) => {
  const zoneId = toBin(envelope.aggregate_id);
  const zone = await uow
    .selectFrom('organization_zones')
    .select(['id', 'parent_id'])
    .where('id', '=', zoneId)
    .forUpdate()
    .executeTakeFirst();
  if (!zone) return notFound('Zone introuvable.');

  const newParentId = envelope.payload.parentId === null ? null : toBin(envelope.payload.parentId);
  const unchanged =
    zone.parent_id === null
      ? newParentId === null
      : newParentId !== null && zone.parent_id.equals(newParentId);
  if (unchanged) return { status: 'APPLIED' };

  // La zone et ses descendantes, avec leur distance à la zone déplacée.
  const found = await uow
    .selectFrom('organization_zone_ancestors')
    .select(['zone_id', 'depth'])
    .where('ancestor_id', '=', zoneId)
    .execute();
  // Toute zone porte sa propre ligne de fermeture (profondeur 0) depuis sa création ; garde-fou seulement.
  const subtree = found.length > 0 ? found : [{ zone_id: zone.id, depth: 0 }];
  const subtreeIds = subtree.map((row) => row.zone_id);
  await uow
    .selectFrom('organization_zones')
    .select('id')
    .where('id', 'in', subtreeIds)
    .orderBy('id')
    .forUpdate()
    .execute();

  let parentDepth = 0;
  let parentAncestors: readonly { ancestor_id: Buffer; depth: number }[] = [];
  if (newParentId !== null) {
    const parent = await uow
      .selectFrom('organization_zones')
      .select(['id', 'depth'])
      .where('id', '=', newParentId)
      .forUpdate()
      .executeTakeFirst();
    if (!parent) return notFound('Zone parente introuvable.');
    // Une zone ne se place ni sous elle-même ni sous l'une de ses descendantes (cycle).
    if (subtree.some((row) => row.zone_id.equals(newParentId))) {
      return {
        status: 'REJECTED',
        errorCode: 'ZONE_CYCLE',
        messageFr:
          'Une zone ne peut pas être placée sous elle-même ni sous l’une de ses descendantes.',
      };
    }
    parentDepth = parent.depth;
    parentAncestors = await uow
      .selectFrom('organization_zone_ancestors')
      .select(['ancestor_id', 'depth'])
      .where('zone_id', '=', newParentId)
      .execute();
  }

  // 1. Les liens des descendantes vers les anciennes ancêtres de la zone (au-dessus d'elle) tombent.
  const oldAbove = await uow
    .selectFrom('organization_zone_ancestors')
    .select('ancestor_id')
    .where('zone_id', '=', zoneId)
    .where('ancestor_id', '!=', zoneId)
    .execute();
  if (oldAbove.length > 0) {
    await uow
      .deleteFrom('organization_zone_ancestors')
      .where('zone_id', 'in', subtreeIds)
      .where(
        'ancestor_id',
        'in',
        oldAbove.map((row) => row.ancestor_id),
      )
      .execute();
  }
  // 2. Elles se relient à la nouvelle parente et à ses ancêtres.
  const links = subtree.flatMap((row) =>
    parentAncestors.map((ancestor) => ({
      zone_id: row.zone_id,
      ancestor_id: ancestor.ancestor_id,
      depth: row.depth + ancestor.depth + 1,
    })),
  );
  for (let from = 0; from < links.length; from += CLOSURE_INSERT_CHUNK) {
    await uow
      .insertInto('organization_zone_ancestors')
      .values(links.slice(from, from + CLOSURE_INSERT_CHUNK))
      .execute();
  }
  // 3. Le parent de la zone et la profondeur de chacune des zones déplacées.
  await uow
    .updateTable('organization_zones')
    .set({
      parent_id: newParentId,
      updated_by: toBin(envelope.author_user_id),
      version: sql`version + 1`,
    })
    .where('id', '=', zoneId)
    .execute();
  for (const row of subtree) {
    await uow
      .updateTable('organization_zones')
      .set({ depth: parentDepth + 1 + row.depth })
      .where('id', '=', row.zone_id)
      .execute();
  }
  // Les descendantes changent de profondeur : leur fiche est republiée (celle de la zone l'est par le pipeline).
  const descendants = subtree.filter((row) => !row.zone_id.equals(zoneId));
  if (descendants.length > 0) {
    await recordChanges(
      uow,
      descendants.map((row) => ({
        dataset: 'zone',
        entityType: 'ZONE',
        entityId: fromBin(row.zone_id),
        scopeType: 'GLOBAL' as const,
        scopeId: null,
      })),
    );
  }
  return {
    status: 'APPLIED',
    audit: {
      before: { parentId: zone.parent_id === null ? null : fromBin(zone.parent_id) },
      after: { parentId: envelope.payload.parentId, movedZones: subtree.length },
    },
  };
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
  registry.register({
    commandType: 'organization.zone.move',
    version: 1,
    payloadSchema: movePayloadSchema,
    permissionCode: 'org.structure.manage',
    handler: move,
  });
}
