/**
 * Lecture de « l'état courant » d'une entité pour `/sync/pull` (06-offline-sync/
 * 02-synchronisation.md §5.2 : « le flux ne stocke pas de copie des données » — chaque
 * `UPSERT` de `sync_change_feed` est résolu ici, au moment du téléchargement). Un lecteur par
 * `entity_type` réellement produit par un gestionnaire de commande à ce jour (identity,
 * organization) — table fixe, tous définis dans ce seul fichier (contrairement à
 * `CommandHandlerRegistry`, alimenté par plusieurs modules indépendants, une simple table
 * couvre ce besoin sans registre mutable).
 *
 * Jamais de colonne sensible (`password_hash`…) dans une projection : ce module est le seul
 * point qui décide ce qu'un appareil reçoit d'une table, indépendamment de ce que la table
 * porte en interne.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../platform/kysely/uuid-columns.js';

export type EntityProjectionReader = (
  executor: Kysely<DB> | Transaction<DB>,
  entityId: string,
) => Promise<Record<string, unknown> | undefined>;

const ENTITY_PROJECTIONS: Record<string, EntityProjectionReader> = {
  USER: async (executor, entityId) => {
    const row = await executor
      .selectFrom('identity_users')
      .select([
        'id',
        'full_name',
        'phone',
        'email',
        'status',
        'must_change_password',
        'last_login_at',
      ])
      .where('id', '=', toBin(entityId))
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      id: fromBin(row.id),
      full_name: row.full_name,
      phone: row.phone,
      email: row.email,
      status: row.status,
      must_change_password: Boolean(row.must_change_password),
      last_login_at: row.last_login_at,
    };
  },

  DEVICE: async (executor, entityId) => {
    const row = await executor
      .selectFrom('identity_devices')
      .select(['id', 'short_code', 'label', 'status', 'platform', 'app_version'])
      .where('id', '=', toBin(entityId))
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      id: fromBin(row.id),
      short_code: row.short_code,
      label: row.label,
      status: row.status,
      platform: row.platform,
      app_version: row.app_version,
    };
  },

  ROLE_ASSIGNMENT: async (executor, entityId) => {
    const row = await executor
      .selectFrom('identity_user_role_assignments')
      .select([
        'id',
        'user_id',
        'role_id',
        'scope_type',
        'scope_site_id',
        'scope_zone_id',
        'scope_team_id',
        'valid_from',
        'valid_to',
        'revoked_at',
      ])
      .where('id', '=', toBin(entityId))
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      id: fromBin(row.id),
      user_id: fromBin(row.user_id),
      role_id: fromBin(row.role_id),
      scope_type: row.scope_type,
      scope_site_id: fromBinOrNull(row.scope_site_id),
      scope_zone_id: fromBinOrNull(row.scope_zone_id),
      scope_team_id: fromBinOrNull(row.scope_team_id),
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      revoked_at: row.revoked_at,
    };
  },

  ZONE: async (executor, entityId) => {
    const row = await executor
      .selectFrom('organization_zones')
      .select([
        'id',
        'parent_id',
        'level',
        'code',
        'name',
        'depth',
        'geofence_lat',
        'geofence_lng',
        'geofence_radius_m',
        'max_gps_accuracy_m',
        'is_active',
      ])
      .where('id', '=', toBin(entityId))
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      id: fromBin(row.id),
      parent_id: fromBinOrNull(row.parent_id),
      level: row.level,
      code: row.code,
      name: row.name,
      depth: row.depth,
      geofence_lat: row.geofence_lat,
      geofence_lng: row.geofence_lng,
      geofence_radius_m: row.geofence_radius_m,
      max_gps_accuracy_m: row.max_gps_accuracy_m,
      is_active: Boolean(row.is_active),
    };
  },

  SITE: async (executor, entityId) => {
    const row = await executor
      .selectFrom('organization_sites')
      .select([
        'id',
        'code',
        'name',
        'site_type',
        'zone_id',
        'address',
        'lat',
        'lng',
        'status',
        'opened_on',
        'closed_on',
      ])
      .where('id', '=', toBin(entityId))
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      id: fromBin(row.id),
      code: row.code,
      name: row.name,
      site_type: row.site_type,
      zone_id: fromBin(row.zone_id),
      address: row.address,
      lat: row.lat,
      lng: row.lng,
      status: row.status,
      opened_on: row.opened_on,
      closed_on: row.closed_on,
    };
  },

  LOCATION: async (executor, entityId) => {
    const row = await executor
      .selectFrom('organization_locations')
      .select([
        'id',
        'site_id',
        'parent_location_id',
        'code',
        'name',
        'location_type',
        'is_virtual',
        'custody_mode',
        'custodian_user_id',
        'designated_device_id',
        'capacity',
        'status',
      ])
      .where('id', '=', toBin(entityId))
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      id: fromBin(row.id),
      site_id: fromBinOrNull(row.site_id),
      parent_location_id: fromBinOrNull(row.parent_location_id),
      code: row.code,
      name: row.name,
      location_type: row.location_type,
      is_virtual: Boolean(row.is_virtual),
      custody_mode: row.custody_mode,
      custodian_user_id: fromBinOrNull(row.custodian_user_id),
      designated_device_id: fromBinOrNull(row.designated_device_id),
      capacity: row.capacity,
      status: row.status,
    };
  },

  TEAM: async (executor, entityId) => {
    const row = await executor
      .selectFrom('organization_teams')
      .select(['id', 'code', 'name', 'manager_user_id', 'is_active'])
      .where('id', '=', toBin(entityId))
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      id: fromBin(row.id),
      code: row.code,
      name: row.name,
      manager_user_id: fromBin(row.manager_user_id),
      is_active: Boolean(row.is_active),
    };
  },

  TEAM_MEMBERSHIP: async (executor, entityId) => {
    const row = await executor
      .selectFrom('organization_team_memberships')
      .select(['id', 'team_id', 'user_id', 'valid_from', 'valid_to'])
      .where('id', '=', toBin(entityId))
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      id: fromBin(row.id),
      team_id: fromBin(row.team_id),
      user_id: fromBin(row.user_id),
      valid_from: row.valid_from,
      valid_to: row.valid_to,
    };
  },

  // dictionnaire organization.system_settings : « Offline DL (paramètres is_client_visible) »
  // — un paramètre non destiné aux appareils n'est pas projeté (traité comme absent, la
  // ligne `change_feed` est alors omise de la réponse par sync-pull.service.ts).
  SETTING: async (executor, entityId) => {
    const row = await executor
      .selectFrom('organization_system_settings')
      .select(['id', 'key', 'value', 'scope_type', 'scope_id', 'valid_from', 'is_client_visible'])
      .where('id', '=', toBin(entityId))
      .executeTakeFirst();
    if (!row || !row.is_client_visible) return undefined;
    return {
      id: fromBin(row.id),
      key: row.key,
      value: row.value,
      scope_type: row.scope_type,
      scope_id: fromBinOrNull(row.scope_id),
      valid_from: row.valid_from,
    };
  },
};

export function resolveEntityProjection(entityType: string): EntityProjectionReader | undefined {
  return ENTITY_PROJECTIONS[entityType];
}
