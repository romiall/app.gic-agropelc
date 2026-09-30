/**
 * Lecture de « l'état courant » d'une entité pour `/sync/pull` (06-offline-sync/
 * 02-synchronisation.md §5.2 : « le flux ne stocke pas de copie des données » — chaque
 * `UPSERT` de `sync_change_feed` est résolu ici, au moment du téléchargement). Un lecteur par
 * `entity_type` réellement produit par un gestionnaire de commande à ce jour (identity,
 * organization, approvals, attachments ; catalog, pricing, procurement en P1-06 ; inventory en
 * P2-06 ; crm et fieldwork en P3-07 ; documents d'achat en P6-07 ; production en P7-12, via
 * `platform/sync/change-feed.ts`) — table fixe, tous définis dans ce seul fichier
 * (contrairement à `CommandHandlerRegistry`, alimenté par plusieurs modules indépendants,
 * une simple table couvre ce besoin sans registre mutable).
 *
 * Jamais de colonne sensible (`password_hash`…) dans une projection : ce module est le seul
 * point qui décide ce qu'un appareil reçoit d'une table, indépendamment de ce que la table
 * porte en interne.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../platform/kysely/uuid-columns.js';

/** Périmètre de la ligne `change_feed` projetée (P2-06) : nécessaire quand la clé réelle de
 * l'entité est composite (`STOCK_BALANCE` : produit × emplacement) ou quand seule une ligne
 * émise par le module propriétaire, avec son vrai périmètre, doit être servie. */
export interface EntityProjectionContext {
  readonly scopeType: string;
  readonly scopeId: string | null;
}

export type EntityProjectionReader = (
  executor: Kysely<DB> | Transaction<DB>,
  entityId: string,
  context: EntityProjectionContext,
) => Promise<Record<string, unknown> | undefined>;

/** Emplacement porté par une ligne `LOCATION` ; `undefined` pour toute autre portée — dont le
 * repli générique `GLOBAL` du pipeline (même `entity_type` que l'agrégat de la commande), qui ne
 * doit jamais servir une donnée de stock à tous les appareils (P2-06). */
function locationScopeOf(context: EntityProjectionContext): string | undefined {
  return context.scopeType === 'LOCATION' && context.scopeId !== null ? context.scopeId : undefined;
}

/** Périmètres CRM (P3-07) : `USER` (titulaire ou auteur), `TEAM`, `SITE` — jamais `GLOBAL`. */
function crmScopeOf(
  context: EntityProjectionContext,
): { readonly type: 'USER' | 'TEAM' | 'SITE'; readonly id: string } | undefined {
  if (context.scopeId === null) return undefined;
  if (
    context.scopeType === 'USER' ||
    context.scopeType === 'TEAM' ||
    context.scopeType === 'SITE'
  ) {
    return { type: context.scopeType, id: context.scopeId };
  }
  return undefined;
}

/** Ferme portée par une ligne `SITE` (jeu `production`, P7-12) ; `undefined` pour toute autre
 * portée — dont le repli générique `GLOBAL` du pipeline, qui ne sert jamais une donnée de ferme. */
function siteScopeOf(context: EntityProjectionContext): string | undefined {
  return context.scopeType === 'SITE' && context.scopeId !== null ? context.scopeId : undefined;
}

/** Fenêtre des saisies de la ferme servies hors ligne (dictionnaire 07-production : « DL (30 j) »),
 * évaluée par la base au moment du téléchargement (comme les réceptions, P6-07). */
const RECENT_30_DAYS = sql<boolean>`occurred_at >= (UTC_TIMESTAMP(6) - INTERVAL 30 DAY)`;

const qtyOf = (value: string | number | null): number | null =>
  value === null ? null : Math.round(Number(value) * 1000) / 1000;

/** Ferme d'un lot de production. */
async function productionLotSite(
  executor: Kysely<DB> | Transaction<DB>,
  lotId: Buffer,
): Promise<string | undefined> {
  const lot = await executor
    .selectFrom('production_production_lots')
    .select('site_id')
    .where('id', '=', lotId)
    .executeTakeFirst();
  return lot ? fromBin(lot.site_id) : undefined;
}

/** L'un des utilisateurs est membre de l'équipe maintenant (appartenance courante). */
async function anyTeamMemberNow(
  executor: Kysely<DB> | Transaction<DB>,
  teamId: string,
  userIds: readonly (Buffer | null)[],
): Promise<boolean> {
  const ids = userIds.filter((id): id is Buffer => id !== null);
  if (ids.length === 0) return false;
  const row = await executor
    .selectFrom('organization_team_memberships')
    .select('id')
    .where('team_id', '=', toBin(teamId))
    .where('user_id', 'in', ids)
    .where(sql<boolean>`valid_from <= UTC_TIMESTAMP(6)`)
    .where(sql<boolean>`(valid_to IS NULL OR valid_to > UTC_TIMESTAMP(6))`)
    .executeTakeFirst();
  return row !== undefined;
}

function flagsOf(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Colonne `DATE` lue (mysql2 : minuit local) → `AAAA-MM-JJ`. */
function dateOnly(value: Date | null): string | null {
  if (value === null) return null;
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

/** Fenêtre du jeu `crm_activity` (01-architecture-offline.md §3.1 : « des 90 derniers jours »). */
const ACTIVITY_WINDOW = sql<boolean>`a.occurred_at >= (UTC_TIMESTAMP(6) - INTERVAL 90 DAY)`;

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

  // dictionnaire approvals.control_policies : « Offline DL (politiques actives, pour
  // l'évaluation indicative sur l'appareil) » — condition non interprétée ici (jamais
  // interrogée comme donnée métier, voir policy-commands.ts), transmise telle quelle.
  CONTROL_POLICY: async (executor, entityId) => {
    const row = await executor
      .selectFrom('approvals_control_policies')
      .select([
        'id',
        'code',
        'version',
        'operation_type',
        'condition',
        'requires_photo',
        'requires_comment',
        'requires_approval',
        'approver_permission',
        'approver_scope',
        'valid_from',
        'valid_to',
        'status',
      ])
      .where('id', '=', toBin(entityId))
      .executeTakeFirst();
    if (!row || row.status !== 'ACTIVE') return undefined;
    return {
      id: fromBin(row.id),
      code: row.code,
      version: row.version,
      operation_type: row.operation_type,
      condition: row.condition,
      requires_photo: Boolean(row.requires_photo),
      requires_comment: Boolean(row.requires_comment),
      requires_approval: Boolean(row.requires_approval),
      approver_permission: row.approver_permission,
      approver_scope: row.approver_scope,
      valid_from: row.valid_from,
      valid_to: row.valid_to,
    };
  },

  // dictionnaire approvals.approval_requests : « Offline DL (celles de l'utilisateur, en
  // lecture seule) ». Servie seulement par une ligne `USER` dont le périmètre est le demandeur
  // (émise par `approvals`, approval-changes.ts, jeu `comms`) : le repli GLOBAL du pipeline
  // (commandes `approvals.request.*`) diffusait sinon à tout appareil le résumé d'opérations
  // confidentielles (pertes, écarts — AV-094, P2). Sans `amount_xaf` : mesure financière
  // (RC-05), inutile au demandeur hors ligne.
  APPROVAL_REQUEST: async (executor, entityId, context) => {
    if (context.scopeType !== 'USER' || context.scopeId === null) return undefined;
    const row = await executor
      .selectFrom('approvals_approval_requests')
      .select([
        'id',
        'operation_type',
        'subject_type',
        'subject_id',
        'subject_summary',
        'site_id',
        'zone_id',
        'requested_by',
        'requested_at',
        'status',
        'decision_option',
        'decided_by',
        'decided_at',
        'decision_comment',
      ])
      .where('id', '=', toBin(entityId))
      .executeTakeFirst();
    if (!row || fromBin(row.requested_by) !== context.scopeId) return undefined;
    return {
      id: fromBin(row.id),
      operation_type: row.operation_type,
      subject_type: row.subject_type,
      subject_id: fromBin(row.subject_id),
      subject_summary: row.subject_summary,
      site_id: fromBinOrNull(row.site_id),
      zone_id: fromBinOrNull(row.zone_id),
      requested_by: fromBin(row.requested_by),
      requested_at: row.requested_at,
      status: row.status,
      decision_option: row.decision_option,
      decided_by: fromBinOrNull(row.decided_by),
      decided_at: row.decided_at,
      decision_comment: row.decision_comment,
    };
  },

  // P0-13 : ni storage_key (clé de stockage interne) ni sha256 (déjà connue de l'appareil
  // qui l'a calculée à la capture, ADR-012 point 1) ne sont projetées — seul upload_status
  // importe côté appareil (BR-ADM-020, « justificatif en cours de transmission »).
  ATTACHMENT: async (executor, entityId) => {
    const row = await executor
      .selectFrom('attachments_attachments')
      .select([
        'id',
        'owner_type',
        'owner_id',
        'kind',
        'mime_type',
        'upload_status',
        'superseded_by_id',
      ])
      .where('id', '=', toBin(entityId))
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      id: fromBin(row.id),
      owner_type: row.owner_type,
      owner_id: fromBin(row.owner_id),
      kind: row.kind,
      mime_type: row.mime_type,
      upload_status: row.upload_status,
      superseded_by_id: fromBinOrNull(row.superseded_by_id),
    };
  },
  // P1-06 : `catalog.unit.create` et `catalog.sales_channel.create` n'ont **pas** de
  // projection ici — leur clé primaire réelle est `code` (dictionnaire), alors que
  // `sync_change_feed.entity_id` ne peut porter qu'un UUID (`aggregate_id`, sans rapport
  // avec `code`). Aucune valeur de repli ne serait correcte : signalé, pas comblé en
  // silence (CLAUDE.md règle #2) — ces deux référentiels restent accessibles hors ligne
  // uniquement via `GET /units` et `GET /sales-channels` en ligne jusqu'à ce qu'une vraie
  // solution existe (clé de projection alternative, ou `id` UUID au lieu de `code`).

  PRODUCT_CATEGORY: async (executor, entityId) => {
    const row = await executor
      .selectFrom('catalog_product_categories')
      .select(['id', 'parent_id', 'code', 'name', 'is_active'])
      .where('id', '=', toBin(entityId))
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      id: fromBin(row.id),
      parent_id: fromBinOrNull(row.parent_id),
      code: row.code,
      name: row.name,
      is_active: Boolean(row.is_active),
    };
  },

  PRODUCT: async (executor, entityId) => {
    const row = await executor
      .selectFrom('catalog_products')
      .select([
        'id',
        'code',
        'name',
        'category_id',
        'stock_family',
        'base_unit_code',
        'lot_tracking',
        'expiry_tracking',
        'is_sellable',
        'is_purchasable',
        'is_producible',
        'is_consumable',
        'pricing_mode',
        'species',
        'status',
      ])
      .where('id', '=', toBin(entityId))
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      id: fromBin(row.id),
      code: row.code,
      name: row.name,
      category_id: fromBin(row.category_id),
      stock_family: row.stock_family,
      base_unit_code: row.base_unit_code,
      lot_tracking: row.lot_tracking,
      expiry_tracking: Boolean(row.expiry_tracking),
      is_sellable: Boolean(row.is_sellable),
      is_purchasable: Boolean(row.is_purchasable),
      is_producible: Boolean(row.is_producible),
      is_consumable: Boolean(row.is_consumable),
      pricing_mode: row.pricing_mode,
      species: row.species,
      status: row.status,
    };
  },

  PRODUCT_UNIT: async (executor, entityId) => {
    const row = await executor
      .selectFrom('catalog_product_units')
      .select([
        'id',
        'product_id',
        'unit_code',
        'factor_to_base',
        'is_sales_unit',
        'is_purchase_unit',
        'is_count_unit',
        'is_active',
      ])
      .where('id', '=', toBin(entityId))
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      id: fromBin(row.id),
      product_id: fromBin(row.product_id),
      unit_code: row.unit_code,
      factor_to_base: row.factor_to_base,
      is_sales_unit: Boolean(row.is_sales_unit),
      is_purchase_unit: Boolean(row.is_purchase_unit),
      is_count_unit: Boolean(row.is_count_unit),
      is_active: Boolean(row.is_active),
    };
  },

  PRODUCT_STANDARD_COST: async (executor, entityId) => {
    const row = await executor
      .selectFrom('catalog_product_standard_costs')
      .select(['id', 'product_id', 'unit_cost_xaf', 'valid_from', 'reason'])
      .where('id', '=', toBin(entityId))
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      id: fromBin(row.id),
      product_id: fromBin(row.product_id),
      unit_cost_xaf: row.unit_cost_xaf,
      valid_from: row.valid_from,
      reason: row.reason,
    };
  },

  REASON_CODE: async (executor, entityId) => {
    const row = await executor
      .selectFrom('catalog_reason_codes')
      .select(['id', 'category', 'code', 'label', 'loss_category', 'requires_comment', 'is_active'])
      .where('id', '=', toBin(entityId))
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      id: fromBin(row.id),
      category: row.category,
      code: row.code,
      label: row.label,
      loss_category: row.loss_category,
      requires_comment: Boolean(row.requires_comment),
      is_active: Boolean(row.is_active),
    };
  },

  CUSTOMER_CATEGORY: async (executor, entityId) => {
    const row = await executor
      .selectFrom('catalog_customer_categories')
      .select(['id', 'code', 'name', 'is_active'])
      .where('id', '=', toBin(entityId))
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      id: fromBin(row.id),
      code: row.code,
      name: row.name,
      is_active: Boolean(row.is_active),
    };
  },

  // dictionnaire pricing.price_rules : « Offline DL : règles ACTIVE non terminées (y
  // compris futures) pour les produits vendables, les zones (avec ancêtres) et les sites du
  // périmètre » — ce filtrage fin n'est pas encore fait ici (comme ZONE/SITE en P0-11) :
  // repli GLOBAL générique (command-pipeline.service.ts), affiné quand `sales` (P4) en aura
  // besoin. Une règle DRAFT ou RETIRED n'est volontairement pas transmise (elle ne sert à
  // rien hors ligne, et pourrait révéler un prix pas encore en vigueur).
  PRICE_RULE: async (executor, entityId) => {
    const row = await executor
      .selectFrom('pricing_price_rules')
      .selectAll()
      .where('id', '=', toBin(entityId))
      .executeTakeFirst();
    if (!row || row.status !== 'ACTIVE') return undefined;
    return {
      id: fromBin(row.id),
      code: row.code,
      version: row.version,
      product_id: fromBin(row.product_id),
      unit_price_xaf: row.unit_price_xaf,
      pricing_unit_code: row.pricing_unit_code,
      zone_id: fromBinOrNull(row.zone_id),
      site_id: fromBinOrNull(row.site_id),
      customer_category_id: fromBinOrNull(row.customer_category_id),
      channel_code: row.channel_code,
      min_quantity: row.min_quantity,
      commercial_campaign_id: fromBinOrNull(row.commercial_campaign_id),
      priority: row.priority,
      specificity: row.specificity,
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      status: row.status,
    };
  },

  COMMERCIAL_CAMPAIGN: async (executor, entityId) => {
    const row = await executor
      .selectFrom('pricing_commercial_campaigns')
      .select(['id', 'code', 'name', 'valid_from', 'valid_to', 'status'])
      .where('id', '=', toBin(entityId))
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      id: fromBin(row.id),
      code: row.code,
      name: row.name,
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      status: row.status,
    };
  },

  // dictionnaire procurement.suppliers : « Offline DL (actifs : id, code, nom) » — projection
  // volontairement réduite à ces trois champs (pas de téléphone/adresse/notes, non utiles
  // hors ligne en P1, aucun module ne les consomme encore côté appareil).
  SUPPLIER: async (executor, entityId) => {
    const row = await executor
      .selectFrom('procurement_suppliers')
      .select(['id', 'code', 'name', 'status'])
      .where('id', '=', toBin(entityId))
      .executeTakeFirst();
    if (!row || row.status !== 'ACTIVE') return undefined;
    return { id: fromBin(row.id), code: row.code, name: row.name };
  },

  // P2-06 — jeux `stock`, `transfers`, `counts` (01-architecture-offline.md §3.1), filtrés par
  // `LOCATION`, émis par `inventory` (sync-changes.ts). Aucune mesure financière (coût, valeur
  // — RC-05, BR-STK-054) : les rôles qui téléchargent ces jeux (magasinier, vendeur PDV,
  // responsables de ferme et de production, commercial pour son stock mobile, §3.2) ne sont
  // pas tous titulaires de `inventory.valuation.read`.

  // dictionnaire inventory.stock_balances : « Offline DL (emplacements du périmètre) » ; lots en
  // solde (stock_lots « Offline DL »). Entité = produit, emplacement = périmètre de la ligne.
  // Lignes à zéro incluses : un solde revenu à zéro doit remplacer l'ancien sur l'appareil.
  STOCK_BALANCE: async (executor, entityId, context) => {
    const locationId = locationScopeOf(context);
    if (locationId === undefined) return undefined;
    const rows = await executor
      .selectFrom('inventory_stock_balances as b')
      .leftJoin('inventory_stock_lots as lot', 'lot.id', 'b.lot_key')
      .select([
        'b.lot_key as lot_key',
        'lot.id as lot_id',
        'lot.lot_code as lot_code',
        'lot.expiry_date as expiry_date',
        'b.qty_on_hand as qty_on_hand',
        'b.qty_reserved as qty_reserved',
        'b.qty_allocated as qty_allocated',
        'b.last_move_at as last_move_at',
        'b.row_version as row_version',
      ])
      .where('b.location_id', '=', toBin(locationId))
      .where('b.product_id', '=', toBin(entityId))
      .orderBy('b.lot_key', 'asc')
      .execute();
    if (rows.length === 0) return undefined;
    const lots = rows.map((row) => ({
      lot_id: fromBinOrNull(row.lot_id),
      lot_code: row.lot_code,
      expiry_date: row.expiry_date,
      qty_on_hand: row.qty_on_hand,
      qty_reserved: row.qty_reserved,
      qty_allocated: row.qty_allocated,
      last_move_at: row.last_move_at,
      row_version: row.row_version,
    }));
    const sum = (pick: (lot: (typeof lots)[number]) => string) =>
      String(Math.round(lots.reduce((total, lot) => total + Number(pick(lot)), 0) * 1000) / 1000);
    return {
      location_id: locationId,
      product_id: entityId,
      qty_on_hand: sum((lot) => lot.qty_on_hand),
      qty_reserved: sum((lot) => lot.qty_reserved),
      qty_allocated: sum((lot) => lot.qty_allocated),
      lots,
    };
  },

  // dictionnaire inventory.stock_thresholds : « Offline DL ». Un seuil désactivé est projeté
  // (`is_active = false`) : l'appareil le retire (threshold-commands.ts le ré-émet exprès).
  STOCK_THRESHOLD: async (executor, entityId, context) => {
    const locationId = locationScopeOf(context);
    if (locationId === undefined) return undefined;
    const row = await executor
      .selectFrom('inventory_stock_thresholds')
      .select(['id', 'location_id', 'product_id', 'min_qty_base', 'target_qty_base', 'is_active'])
      .where('id', '=', toBin(entityId))
      .where('location_id', '=', toBin(locationId))
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      id: fromBin(row.id),
      location_id: fromBin(row.location_id),
      product_id: fromBin(row.product_id),
      min_qty_base: row.min_qty_base,
      target_qty_base: row.target_qty_base,
      is_active: Boolean(row.is_active),
    };
  },

  // dictionnaire inventory.stock_transfers : « Offline DL (ouverts du périmètre) ». Projeté quel
  // que soit le statut : un transfert qui se ferme (RECEIVED, CLOSED, DECLINED…) doit parvenir
  // à l'appareil pour qu'il le retire de sa liste des transferts ouverts.
  STOCK_TRANSFER: async (executor, entityId, context) => {
    const locationId = locationScopeOf(context);
    if (locationId === undefined) return undefined;
    const row = await executor
      .selectFrom('inventory_stock_transfers')
      .select([
        'id',
        'doc_number',
        'transfer_kind',
        'from_location_id',
        'to_location_id',
        'status',
        'requested_by',
        'requested_at',
        'dispatched_by',
        'dispatched_at',
        'carrier_user_id',
        'carrier_name',
        'received_by',
        'received_at',
        'approval_request_id',
        'notes',
        'occurred_at',
        'version',
      ])
      .where('id', '=', toBin(entityId))
      .executeTakeFirst();
    if (!row) return undefined;
    const fromLocationId = fromBin(row.from_location_id);
    const toLocationId = fromBin(row.to_location_id);
    if (locationId !== fromLocationId && locationId !== toLocationId) return undefined;
    const lines = await executor
      .selectFrom('inventory_stock_transfer_lines')
      .select([
        'id',
        'product_id',
        'lot_id',
        'unit_code',
        'requested_qty_base',
        'dispatched_qty_base',
        'received_qty_base',
        'discrepancy_qty_base',
        'returned_qty_base',
      ])
      .where('transfer_id', '=', row.id)
      .orderBy('id', 'asc')
      .execute();
    return {
      id: fromBin(row.id),
      doc_number: row.doc_number,
      transfer_kind: row.transfer_kind,
      from_location_id: fromLocationId,
      to_location_id: toLocationId,
      status: row.status,
      requested_by: fromBinOrNull(row.requested_by),
      requested_at: row.requested_at,
      dispatched_by: fromBinOrNull(row.dispatched_by),
      dispatched_at: row.dispatched_at,
      carrier_user_id: fromBinOrNull(row.carrier_user_id),
      carrier_name: row.carrier_name,
      received_by: fromBinOrNull(row.received_by),
      received_at: row.received_at,
      approval_request_id: fromBinOrNull(row.approval_request_id),
      notes: row.notes,
      occurred_at: row.occurred_at,
      version: row.version,
      lines: lines.map((line) => ({
        id: fromBin(line.id),
        product_id: fromBin(line.product_id),
        lot_id: fromBinOrNull(line.lot_id),
        unit_code: line.unit_code,
        requested_qty_base: line.requested_qty_base,
        dispatched_qty_base: line.dispatched_qty_base,
        received_qty_base: line.received_qty_base,
        discrepancy_qty_base: line.discrepancy_qty_base,
        returned_qty_base: line.returned_qty_base,
      })),
    };
  },

  // dictionnaire inventory.inventory_counts : « Offline DL (ouverts) ». Même principe que
  // STOCK_TRANSFER pour les statuts de sortie. Sans `variance_value_xaf`/coûts des lignes (RC-05).
  INVENTORY_COUNT: async (executor, entityId, context) => {
    const locationId = locationScopeOf(context);
    if (locationId === undefined) return undefined;
    const row = await executor
      .selectFrom('inventory_inventory_counts')
      .select([
        'id',
        'doc_number',
        'location_id',
        'count_type',
        'status',
        'opened_by',
        'occurred_at',
        'submitted_by',
        'submitted_at',
        'posted_at',
        'approval_request_id',
        'version',
      ])
      .where('id', '=', toBin(entityId))
      .where('location_id', '=', toBin(locationId))
      .executeTakeFirst();
    if (!row) return undefined;
    const lines = await executor
      .selectFrom('inventory_inventory_count_lines')
      .select([
        'id',
        'product_id',
        'lot_id',
        'counted_at',
        'counted_qty_base',
        'theoretical_qty_base',
        'variance_qty_base',
        'variance_reason_code_id',
        'comment',
      ])
      .where('count_id', '=', row.id)
      .orderBy('id', 'asc')
      .execute();
    return {
      id: fromBin(row.id),
      doc_number: row.doc_number,
      location_id: fromBin(row.location_id),
      count_type: row.count_type,
      status: row.status,
      opened_by: fromBinOrNull(row.opened_by),
      occurred_at: row.occurred_at,
      submitted_by: fromBinOrNull(row.submitted_by),
      submitted_at: row.submitted_at,
      posted_at: row.posted_at,
      approval_request_id: fromBinOrNull(row.approval_request_id),
      version: row.version,
      lines: lines.map((line) => ({
        id: fromBin(line.id),
        product_id: fromBin(line.product_id),
        lot_id: fromBinOrNull(line.lot_id),
        counted_at: line.counted_at,
        counted_qty_base: line.counted_qty_base,
        theoretical_qty_base: line.theoretical_qty_base,
        variance_qty_base: line.variance_qty_base,
        variance_reason_code_id: fromBinOrNull(line.variance_reason_code_id),
        comment: line.comment,
      })),
    };
  },

  // Jeu `customers` (P3-07) : servi seulement si le compte appartient encore au périmètre de la
  // ligne — titulaire (USER), équipe du titulaire (TEAM), PDV de rattachement (SITE). Une
  // réaffectation émet `SCOPE_EXIT` vers l'ancien titulaire (§5.3). `version` sert de
  // `base_version` aux modifications hors ligne (fusion champ par champ).
  CUSTOMER: async (executor, entityId, context) => {
    const scope = crmScopeOf(context);
    if (scope === undefined) return undefined;
    const row = await executor
      .selectFrom('crm_customers')
      .selectAll()
      .where('id', '=', toBin(entityId))
      .executeTakeFirst();
    if (!row) return undefined;
    const owner = fromBinOrNull(row.owner_user_id);
    const inScope =
      scope.type === 'USER'
        ? owner === scope.id
        : scope.type === 'SITE'
          ? fromBinOrNull(row.home_site_id) === scope.id
          : await anyTeamMemberNow(executor, scope.id, [row.owner_user_id]);
    if (!inScope) return undefined;
    return {
      id: fromBin(row.id),
      stage: row.stage,
      pipeline_step_id: fromBinOrNull(row.pipeline_step_id),
      customer_type: row.customer_type,
      display_name: row.display_name,
      contact_name: row.contact_name,
      business_activity: row.business_activity,
      category_id: fromBinOrNull(row.category_id),
      phone_primary: row.phone_primary,
      phone_secondary: row.phone_secondary,
      email: row.email,
      address_text: row.address_text,
      zone_id: fromBin(row.zone_id),
      lat: row.lat,
      lng: row.lng,
      geo_accuracy_m: row.geo_accuracy_m,
      source_code: row.source_code,
      acquired_by_user_id: fromBin(row.acquired_by_user_id),
      acquired_at: row.acquired_at,
      owner_user_id: owner,
      home_site_id: fromBinOrNull(row.home_site_id),
      converted_at: row.converted_at,
      conversion_reverted: Boolean(row.conversion_reverted),
      merged_into_id: fromBinOrNull(row.merged_into_id),
      duplicate_of_id: fromBinOrNull(row.duplicate_of_id),
      credit_allowed: Boolean(row.credit_allowed),
      credit_limit_xaf: row.credit_limit_xaf === null ? null : Number(row.credit_limit_xaf),
      payment_terms_days: row.payment_terms_days,
      last_sale_at: row.last_sale_at,
      version: row.version,
    };
  },

  // Jeu `crm_activity` (P3-07) : visites des 90 derniers jours, pour leur auteur, le titulaire
  // du compte et leurs équipes.
  VISIT: async (executor, entityId, context) => {
    const scope = crmScopeOf(context);
    if (scope === undefined || scope.type === 'SITE') return undefined;
    const row = await executor
      .selectFrom('crm_visits as a')
      .innerJoin('crm_customers as c', 'c.id', 'a.customer_id')
      .selectAll('a')
      .select('c.owner_user_id as owner_user_id')
      .where('a.id', '=', toBin(entityId))
      .where(ACTIVITY_WINDOW)
      .executeTakeFirst();
    if (!row) return undefined;
    const inScope =
      scope.type === 'USER'
        ? fromBin(row.user_id) === scope.id || fromBinOrNull(row.owner_user_id) === scope.id
        : await anyTeamMemberNow(executor, scope.id, [row.user_id, row.owner_user_id]);
    if (!inScope) return undefined;
    return {
      id: fromBin(row.id),
      customer_id: fromBin(row.customer_id),
      user_id: fromBin(row.user_id),
      work_session_id: fromBinOrNull(row.work_session_id),
      customer_stage_at_visit: row.customer_stage_at_visit,
      lat: row.lat,
      lng: row.lng,
      accuracy_m: row.accuracy_m,
      distance_to_customer_m: row.distance_to_customer_m,
      outcome_reason_code_id: fromBin(row.outcome_reason_code_id),
      notes: row.notes,
      next_action_at: dateOnly(row.next_action_at),
      next_action_note: row.next_action_note,
      flags: flagsOf(row.flags),
      status: row.status,
      cancelled_at: row.cancelled_at,
      occurred_at: row.occurred_at,
      version: row.version,
    };
  },

  INTERACTION: async (executor, entityId, context) => {
    const scope = crmScopeOf(context);
    if (scope === undefined || scope.type === 'SITE') return undefined;
    const row = await executor
      .selectFrom('crm_interactions as a')
      .innerJoin('crm_customers as c', 'c.id', 'a.customer_id')
      .selectAll('a')
      .select('c.owner_user_id as owner_user_id')
      .where('a.id', '=', toBin(entityId))
      .where(ACTIVITY_WINDOW)
      .executeTakeFirst();
    if (!row) return undefined;
    const inScope =
      scope.type === 'USER'
        ? fromBin(row.user_id) === scope.id || fromBinOrNull(row.owner_user_id) === scope.id
        : await anyTeamMemberNow(executor, scope.id, [row.user_id, row.owner_user_id]);
    if (!inScope) return undefined;
    return {
      id: fromBin(row.id),
      customer_id: fromBin(row.customer_id),
      user_id: fromBin(row.user_id),
      channel: row.channel,
      direction: row.direction,
      summary: row.summary,
      next_action_at: dateOnly(row.next_action_at),
      next_action_note: row.next_action_note,
      status: row.status,
      cancelled_at: row.cancelled_at,
      occurred_at: row.occurred_at,
      version: row.version,
    };
  },

  SALES_TARGET: async (executor, entityId, context) => {
    const scope = crmScopeOf(context);
    if (scope === undefined) return undefined;
    const row = await executor
      .selectFrom('crm_sales_targets')
      .selectAll()
      .where('id', '=', toBin(entityId))
      .executeTakeFirst();
    if (!row) return undefined;
    const target =
      scope.type === 'USER' ? row.user_id : scope.type === 'TEAM' ? row.team_id : row.site_id;
    if (target === null || fromBin(target) !== scope.id) return undefined;
    return {
      id: fromBin(row.id),
      target_type: row.target_type,
      user_id: fromBinOrNull(row.user_id),
      team_id: fromBinOrNull(row.team_id),
      site_id: fromBinOrNull(row.site_id),
      metric: row.metric,
      product_id: fromBinOrNull(row.product_id),
      period_start: dateOnly(row.period_start),
      period_end: dateOnly(row.period_end),
      target_value: row.target_value,
      status: row.status,
      version: row.version,
    };
  },

  // Jeu `fieldwork` (P3-07) : sessions de l'agent, pour lui renvoyer les décisions du serveur.
  WORK_SESSION: async (executor, entityId, context) => {
    if (context.scopeType !== 'USER' || context.scopeId === null) return undefined;
    const row = await executor
      .selectFrom('fieldwork_work_sessions')
      .select([
        'id',
        'user_id',
        'declared_zone_id',
        'started_at',
        'ended_at',
        'status',
        'close_cause',
        'override_status',
        'approval_request_id',
        'version',
      ])
      .where('id', '=', toBin(entityId))
      .executeTakeFirst();
    if (!row || fromBin(row.user_id) !== context.scopeId) return undefined;
    return {
      id: fromBin(row.id),
      user_id: fromBin(row.user_id),
      declared_zone_id: fromBin(row.declared_zone_id),
      started_at: row.started_at,
      ended_at: row.ended_at,
      status: row.status,
      close_cause: row.close_cause,
      override_status: row.override_status,
      approval_request_id: fromBinOrNull(row.approval_request_id),
      version: row.version,
    };
  },

  // P6-07 — jeu `procurement` (01-architecture-offline.md §3.1 : « BC livrables sur le site,
  // fournisseurs actifs (liste courte), DA de l'utilisateur »), émis par `procurement`
  // (sync-changes.ts). Aucun prix ni coût (RC-05) : le magasinier et le responsable de ferme qui
  // téléchargent ce jeu ne sont pas titulaires de `inventory.valuation.read`.

  // DA de l'utilisateur (`USER` = demandeur), tous statuts : il suit sa demande.
  PURCHASE_REQUEST: async (executor, entityId, context) => {
    if (context.scopeType !== 'USER' || context.scopeId === null) return undefined;
    const row = await executor
      .selectFrom('procurement_purchase_requests')
      .select([
        'id',
        'doc_number',
        'local_ref',
        'site_id',
        'requested_by',
        'justification',
        'needed_by_date',
        'status',
        'estimated_total_xaf',
        'approval_request_id',
        'occurred_at',
        'version',
      ])
      .where('id', '=', toBin(entityId))
      .executeTakeFirst();
    if (!row || fromBin(row.requested_by) !== context.scopeId) return undefined;
    const lines = await executor
      .selectFrom('procurement_purchase_request_lines')
      .select([
        'id',
        'product_id',
        'unit_code',
        'quantity',
        'quantity_base',
        'ordered_qty_base',
        'estimated_unit_price_xaf',
        'notes',
      ])
      .where('request_id', '=', row.id)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return {
      id: fromBin(row.id),
      doc_number: row.doc_number,
      local_ref: row.local_ref,
      site_id: fromBin(row.site_id),
      requested_by: fromBin(row.requested_by),
      justification: row.justification,
      needed_by_date: dateOnly(row.needed_by_date),
      status: row.status,
      estimated_total_xaf: Number(row.estimated_total_xaf),
      approval_request_id: fromBinOrNull(row.approval_request_id),
      occurred_at: row.occurred_at,
      version: row.version,
      lines: lines.map((line) => ({
        id: fromBin(line.id),
        product_id: fromBin(line.product_id),
        unit_code: line.unit_code,
        quantity: Number(line.quantity),
        quantity_base: Number(line.quantity_base),
        ordered_qty_base: Number(line.ordered_qty_base),
        estimated_unit_price_xaf:
          line.estimated_unit_price_xaf === null ? null : Number(line.estimated_unit_price_xaf),
        notes: line.notes,
      })),
    };
  },

  // BC livrable (`SENT`, `PARTIALLY_RECEIVED`) du site de livraison, avec ses reliquats — ce que
  // le magasinier réceptionne hors ligne (D08 §12). Sorti du jeu par `SCOPE_EXIT` ensuite.
  PURCHASE_ORDER: async (executor, entityId, context) => {
    if (context.scopeType !== 'SITE' || context.scopeId === null) return undefined;
    const row = await executor
      .selectFrom('procurement_purchase_orders')
      .select([
        'id',
        'doc_number',
        'site_id',
        'supplier_id',
        'delivery_location_id',
        'expected_delivery_date',
        'status',
        'sent_at',
        'version',
      ])
      .where('id', '=', toBin(entityId))
      .executeTakeFirst();
    if (
      !row ||
      fromBin(row.site_id) !== context.scopeId ||
      !['SENT', 'PARTIALLY_RECEIVED'].includes(row.status)
    ) {
      return undefined;
    }
    const lines = await executor
      .selectFrom('procurement_purchase_order_lines')
      .select([
        'id',
        'line_no',
        'product_id',
        'unit_code',
        'ordered_qty_base',
        'accepted_qty_base',
        'closed_qty_base',
        'status',
      ])
      .where('order_id', '=', row.id)
      .orderBy('line_no', 'asc')
      .execute();
    return {
      id: fromBin(row.id),
      doc_number: row.doc_number,
      site_id: fromBin(row.site_id),
      supplier_id: fromBin(row.supplier_id),
      delivery_location_id: fromBin(row.delivery_location_id),
      expected_delivery_date: dateOnly(row.expected_delivery_date),
      status: row.status,
      sent_at: row.sent_at,
      version: row.version,
      lines: lines.map((line) => {
        const ordered = Math.round(Number(line.ordered_qty_base) * 1000);
        const accepted = Math.round(Number(line.accepted_qty_base) * 1000);
        const closed = Math.round(Number(line.closed_qty_base) * 1000);
        return {
          id: fromBin(line.id),
          line_no: line.line_no,
          product_id: fromBin(line.product_id),
          unit_code: line.unit_code,
          ordered_qty_base: ordered / 1000,
          accepted_qty_base: accepted / 1000,
          closed_qty_base: closed / 1000,
          remaining_qty_base:
            line.status === 'CANCELLED' ? 0 : Math.max(0, ordered - accepted - closed) / 1000,
          status: line.status,
        };
      }),
    };
  },

  // Réceptions du site des 30 derniers jours (dictionnaire goods_receipts : « Offline DL (30 j
  // du site) ») : quantités livrées, rejetées, acceptées, sans coût.
  GOODS_RECEIPT: async (executor, entityId, context) => {
    if (context.scopeType !== 'SITE' || context.scopeId === null) return undefined;
    const row = await executor
      .selectFrom('procurement_goods_receipts')
      .select([
        'id',
        'doc_number',
        'local_ref',
        'site_id',
        'purchase_order_id',
        'supplier_id',
        'location_id',
        'received_by',
        'supplier_delivery_note_ref',
        'status',
        'occurred_at',
        'version',
      ])
      .where('id', '=', toBin(entityId))
      .where(sql<boolean>`occurred_at >= (UTC_TIMESTAMP(6) - INTERVAL 30 DAY)`)
      .executeTakeFirst();
    if (!row || fromBin(row.site_id) !== context.scopeId) return undefined;
    const lines = await executor
      .selectFrom('procurement_goods_receipt_lines')
      .select([
        'id',
        'po_line_id',
        'product_id',
        'unit_code',
        'qty_delivered_base',
        'qty_rejected_base',
        'qty_accepted_base',
        'rejection_reason_code_id',
        'supplier_lot_ref',
        'expiry_date',
        'stock_lot_id',
      ])
      .where('receipt_id', '=', row.id)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return {
      id: fromBin(row.id),
      doc_number: row.doc_number,
      local_ref: row.local_ref,
      site_id: fromBin(row.site_id),
      purchase_order_id: fromBinOrNull(row.purchase_order_id),
      supplier_id: fromBin(row.supplier_id),
      location_id: fromBin(row.location_id),
      received_by: fromBin(row.received_by),
      supplier_delivery_note_ref: row.supplier_delivery_note_ref,
      status: row.status,
      occurred_at: row.occurred_at,
      version: row.version,
      lines: lines.map((line) => ({
        id: fromBin(line.id),
        po_line_id: fromBinOrNull(line.po_line_id),
        product_id: fromBin(line.product_id),
        unit_code: line.unit_code,
        qty_delivered_base: Number(line.qty_delivered_base),
        qty_rejected_base: Number(line.qty_rejected_base),
        qty_accepted_base: Number(line.qty_accepted_base ?? 0),
        rejection_reason_code_id: fromBinOrNull(line.rejection_reason_code_id),
        supplier_lot_ref: line.supplier_lot_ref,
        expiry_date: dateOnly(line.expiry_date),
        stock_lot_id: fromBinOrNull(line.stock_lot_id),
      })),
    };
  },

  // P7-12 — jeu `production` (01-architecture-offline.md §3.1 : « lots actifs du site, lots
  // d'incubation en cours, saisies des 30 derniers jours », filtre `SITE`), émis par
  // `production` et, pour les pertes et consommations d'un lot, par `inventory`
  // (sync-changes.ts). Aucun coût ni valeur (RC-05 ; D07 §12 : « les coûts ne sont pas calculés
  // sur l'appareil ») : le responsable de ferme n'est pas titulaire de
  // `inventory.valuation.read`. L'effectif courant d'un lot n'est pas copié ici (INV-PRD-01) :
  // l'appareil le lit dans les soldes du lot de traçabilité (`stock_lot_id`, jeu `stock`).

  // Lot planifié, actif ou en vente de la ferme ; sorti du jeu par `SCOPE_EXIT` ensuite.
  PRODUCTION_LOT: async (executor, entityId, context) => {
    const siteId = siteScopeOf(context);
    if (siteId === undefined) return undefined;
    const row = await executor
      .selectFrom('production_production_lots')
      .select([
        'id',
        'lot_code',
        'lot_type',
        'product_id',
        'stock_lot_id',
        'site_id',
        'main_location_id',
        'parent_lot_id',
        'supplier_id',
        'strain',
        'status',
        'planned_start_date',
        'start_date',
        'planned_end_date',
        'initial_quantity',
        'occurred_at',
        'version',
      ])
      .where('id', '=', toBin(entityId))
      .executeTakeFirst();
    if (
      !row ||
      fromBin(row.site_id) !== siteId ||
      !['PLANNED', 'ACTIVE', 'SELLING'].includes(row.status)
    ) {
      return undefined;
    }
    return {
      id: fromBin(row.id),
      lot_code: row.lot_code,
      lot_type: row.lot_type,
      product_id: fromBin(row.product_id),
      stock_lot_id: fromBin(row.stock_lot_id),
      site_id: fromBin(row.site_id),
      main_location_id: fromBin(row.main_location_id),
      parent_lot_id: fromBinOrNull(row.parent_lot_id),
      supplier_id: fromBinOrNull(row.supplier_id),
      strain: row.strain,
      status: row.status,
      planned_start_date: dateOnly(row.planned_start_date),
      start_date: dateOnly(row.start_date),
      planned_end_date: dateOnly(row.planned_end_date),
      initial_quantity: qtyOf(row.initial_quantity),
      occurred_at: row.occurred_at,
      version: row.version,
    };
  },

  // Lot d'incubation en cours (en incubateur ou en éclosoir) de la ferme, avec ses compteurs et
  // ses dates prévues ; sorti du jeu à l'éclosion ou à l'annulation.
  INCUBATION_BATCH: async (executor, entityId, context) => {
    const siteId = siteScopeOf(context);
    if (siteId === undefined) return undefined;
    const row = await executor
      .selectFrom('production_incubation_batches')
      .select([
        'id',
        'batch_code',
        'stock_lot_id',
        'site_id',
        'species',
        'egg_product_id',
        'chick_product_id',
        'incubator_location_id',
        'hatcher_location_id',
        'egg_source',
        'eggs_set_qty',
        'set_at',
        'expected_candling_date',
        'expected_transfer_date',
        'expected_hatch_date',
        'infertile_qty',
        'early_dead_qty',
        'accidental_loss_qty',
        'transferred_qty',
        'status',
        'version',
      ])
      .where('id', '=', toBin(entityId))
      .executeTakeFirst();
    if (
      !row ||
      fromBin(row.site_id) !== siteId ||
      !['INCUBATING', 'IN_HATCHER'].includes(row.status)
    ) {
      return undefined;
    }
    return {
      id: fromBin(row.id),
      batch_code: row.batch_code,
      stock_lot_id: fromBin(row.stock_lot_id),
      site_id: fromBin(row.site_id),
      species: row.species,
      egg_product_id: fromBin(row.egg_product_id),
      chick_product_id: fromBin(row.chick_product_id),
      incubator_location_id: fromBin(row.incubator_location_id),
      hatcher_location_id: fromBinOrNull(row.hatcher_location_id),
      egg_source: row.egg_source,
      eggs_set_qty: row.eggs_set_qty,
      set_at: row.set_at,
      expected_candling_date: dateOnly(row.expected_candling_date),
      expected_transfer_date: dateOnly(row.expected_transfer_date),
      expected_hatch_date: dateOnly(row.expected_hatch_date),
      infertile_qty: row.infertile_qty,
      early_dead_qty: row.early_dead_qty,
      accidental_loss_qty: row.accidental_loss_qty,
      transferred_qty: row.transferred_qty,
      status: row.status,
      version: row.version,
    };
  },

  // Saisies des 30 derniers jours de la ferme, tous statuts (une annulation est renvoyée).
  LOT_ENTRY: async (executor, entityId, context) => {
    const siteId = siteScopeOf(context);
    if (siteId === undefined) return undefined;
    const row = await executor
      .selectFrom('production_lot_entries')
      .select([
        'id',
        'production_lot_id',
        'entry_type',
        'product_id',
        'quantity_base',
        'to_location_id',
        'source_kind',
        'source_location_id',
        'source_product_id',
        'source_stock_lot_id',
        'source_production_lot_id',
        'goods_receipt_id',
        'stillborn_qty',
        'avg_weight_g',
        'status',
        'occurred_at',
        'version',
      ])
      .where('id', '=', toBin(entityId))
      .where(RECENT_30_DAYS)
      .executeTakeFirst();
    if (!row || (await productionLotSite(executor, row.production_lot_id)) !== siteId) {
      return undefined;
    }
    return {
      id: fromBin(row.id),
      production_lot_id: fromBin(row.production_lot_id),
      entry_type: row.entry_type,
      product_id: fromBin(row.product_id),
      quantity_base: qtyOf(row.quantity_base),
      to_location_id: fromBin(row.to_location_id),
      source_kind: row.source_kind,
      source_location_id: fromBinOrNull(row.source_location_id),
      source_product_id: fromBinOrNull(row.source_product_id),
      source_stock_lot_id: fromBinOrNull(row.source_stock_lot_id),
      source_production_lot_id: fromBinOrNull(row.source_production_lot_id),
      goods_receipt_id: fromBinOrNull(row.goods_receipt_id),
      stillborn_qty: row.stillborn_qty,
      avg_weight_g: row.avg_weight_g === null ? null : Number(row.avg_weight_g),
      status: row.status,
      occurred_at: row.occurred_at,
      version: row.version,
    };
  },

  LOT_WEIGHING: async (executor, entityId, context) => {
    const siteId = siteScopeOf(context);
    if (siteId === undefined) return undefined;
    const row = await executor
      .selectFrom('production_lot_weighings')
      .select([
        'id',
        'production_lot_id',
        'location_id',
        'sample_size',
        'avg_weight_g',
        'total_weight_kg',
        'source',
        'status',
        'occurred_at',
        'version',
      ])
      .where('id', '=', toBin(entityId))
      .where(RECENT_30_DAYS)
      .executeTakeFirst();
    if (!row || (await productionLotSite(executor, row.production_lot_id)) !== siteId) {
      return undefined;
    }
    return {
      id: fromBin(row.id),
      production_lot_id: fromBin(row.production_lot_id),
      location_id: fromBinOrNull(row.location_id),
      sample_size: row.sample_size,
      avg_weight_g: Number(row.avg_weight_g),
      total_weight_kg: row.total_weight_kg === null ? null : Number(row.total_weight_kg),
      source: row.source,
      status: row.status,
      occurred_at: row.occurred_at,
      version: row.version,
    };
  },

  LOT_OBSERVATION: async (executor, entityId, context) => {
    const siteId = siteScopeOf(context);
    if (siteId === undefined) return undefined;
    const row = await executor
      .selectFrom('production_lot_observations')
      .select(['id', 'production_lot_id', 'observation_type', 'text', 'severity', 'occurred_at'])
      .where('id', '=', toBin(entityId))
      .where(RECENT_30_DAYS)
      .executeTakeFirst();
    if (!row || (await productionLotSite(executor, row.production_lot_id)) !== siteId) {
      return undefined;
    }
    return {
      id: fromBin(row.id),
      production_lot_id: fromBin(row.production_lot_id),
      observation_type: row.observation_type,
      text: row.text,
      severity: row.severity,
      occurred_at: row.occurred_at,
    };
  },

  // Perte (dont la mortalité) d'un lot de production, émise par `inventory` : statut courant
  // (en attente de validation, validée, rejetée, retirée), sans valeur.
  LOT_LOSS: async (executor, entityId, context) => {
    const siteId = siteScopeOf(context);
    if (siteId === undefined) return undefined;
    const row = await executor
      .selectFrom('inventory_loss_declarations')
      .select([
        'id',
        'doc_number',
        'site_id',
        'location_id',
        'product_id',
        'lot_id',
        'production_lot_id',
        'quantity_base',
        'category',
        'reason_code_id',
        'comment',
        'declared_by',
        'requires_approval',
        'status',
        'occurred_at',
        'version',
      ])
      .where('id', '=', toBin(entityId))
      .where(RECENT_30_DAYS)
      .executeTakeFirst();
    if (!row || row.production_lot_id === null || fromBin(row.site_id) !== siteId) {
      return undefined;
    }
    return {
      id: fromBin(row.id),
      doc_number: row.doc_number,
      site_id: fromBin(row.site_id),
      location_id: fromBin(row.location_id),
      product_id: fromBin(row.product_id),
      lot_id: fromBinOrNull(row.lot_id),
      production_lot_id: fromBin(row.production_lot_id),
      quantity_base: qtyOf(row.quantity_base),
      category: row.category,
      reason_code_id: fromBinOrNull(row.reason_code_id),
      comment: row.comment,
      declared_by: fromBin(row.declared_by),
      requires_approval: row.requires_approval === 1,
      status: row.status,
      occurred_at: row.occurred_at,
      version: row.version,
    };
  },

  // Consommation imputée à un lot de production, émise par `inventory`, sans valeur.
  LOT_CONSUMPTION: async (executor, entityId, context) => {
    const siteId = siteScopeOf(context);
    if (siteId === undefined) return undefined;
    const row = await executor
      .selectFrom('inventory_consumptions as c')
      .innerJoin('organization_locations as l', 'l.id', 'c.location_id')
      .select([
        'c.id as id',
        'l.site_id as site_id',
        'c.location_id as location_id',
        'c.product_id as product_id',
        'c.lot_id as lot_id',
        'c.quantity_base as quantity_base',
        'c.unit_code as unit_code',
        'c.quantity as quantity',
        'c.cost_object_type as cost_object_type',
        'c.cost_object_id as cost_object_id',
        'c.cost_type as cost_type',
        'c.recorded_by as recorded_by',
        'c.status as status',
        'c.occurred_at as occurred_at',
        'c.version as version',
      ])
      .where('c.id', '=', toBin(entityId))
      .where(sql<boolean>`c.occurred_at >= (UTC_TIMESTAMP(6) - INTERVAL 30 DAY)`)
      .executeTakeFirst();
    if (
      !row ||
      row.cost_object_type !== 'PRODUCTION_LOT' ||
      row.site_id === null ||
      fromBin(row.site_id) !== siteId
    ) {
      return undefined;
    }
    return {
      id: fromBin(row.id),
      site_id: fromBin(row.site_id),
      location_id: fromBin(row.location_id),
      product_id: fromBin(row.product_id),
      lot_id: fromBinOrNull(row.lot_id),
      production_lot_id: fromBin(row.cost_object_id),
      quantity_base: qtyOf(row.quantity_base),
      unit_code: row.unit_code,
      quantity: qtyOf(row.quantity),
      cost_type: row.cost_type,
      recorded_by: fromBin(row.recorded_by),
      status: row.status,
      occurred_at: row.occurred_at,
      version: row.version,
    };
  },

  EGG_COLLECTION: async (executor, entityId, context) => {
    const siteId = siteScopeOf(context);
    if (siteId === undefined) return undefined;
    const row = await executor
      .selectFrom('production_egg_collections')
      .select([
        'id',
        'doc_number',
        'production_lot_id',
        'site_id',
        'collection_date',
        'storage_location_id',
        'stock_lot_id',
        'hatching_product_id',
        'collected_qty',
        'broken_qty',
        'nonconforming_qty',
        'marketable_qty',
        'hatching_qty',
        'status',
        'occurred_at',
        'version',
      ])
      .where('id', '=', toBin(entityId))
      .where(RECENT_30_DAYS)
      .executeTakeFirst();
    if (!row || fromBin(row.site_id) !== siteId) return undefined;
    const grades = await executor
      .selectFrom('production_egg_collection_lines')
      .select(['product_id', 'quantity'])
      .where('collection_id', '=', row.id)
      .orderBy('id', 'asc')
      .execute();
    return {
      id: fromBin(row.id),
      doc_number: row.doc_number,
      production_lot_id: fromBin(row.production_lot_id),
      site_id: fromBin(row.site_id),
      collection_date: dateOnly(row.collection_date),
      storage_location_id: fromBin(row.storage_location_id),
      stock_lot_id: fromBin(row.stock_lot_id),
      hatching_product_id: fromBinOrNull(row.hatching_product_id),
      collected_qty: row.collected_qty,
      broken_qty: row.broken_qty,
      nonconforming_qty: row.nonconforming_qty,
      marketable_qty: row.marketable_qty,
      hatching_qty: row.hatching_qty,
      status: row.status,
      occurred_at: row.occurred_at,
      version: row.version,
      grades: grades.map((line) => ({
        product_id: fromBin(line.product_id),
        quantity: line.quantity,
      })),
    };
  },

  SLAUGHTER: async (executor, entityId, context) => {
    const siteId = siteScopeOf(context);
    if (siteId === undefined) return undefined;
    const row = await executor
      .selectFrom('production_slaughter_batches')
      .select([
        'id',
        'doc_number',
        'production_lot_id',
        'site_id',
        'source_location_id',
        'location_id',
        'input_product_id',
        'heads_qty',
        'condemned_heads',
        'live_weight_g',
        'output_weight_g',
        'yield_rate',
        'stock_lot_id',
        'status',
        'occurred_at',
        'version',
      ])
      .where('id', '=', toBin(entityId))
      .where(RECENT_30_DAYS)
      .executeTakeFirst();
    if (!row || fromBin(row.site_id) !== siteId) return undefined;
    const outputs = await executor
      .selectFrom('production_slaughter_outputs')
      .select(['product_id', 'to_location_id', 'quantity_base', 'weight_g'])
      .where('slaughter_id', '=', row.id)
      .orderBy('id', 'asc')
      .execute();
    return {
      id: fromBin(row.id),
      doc_number: row.doc_number,
      production_lot_id: fromBin(row.production_lot_id),
      site_id: fromBin(row.site_id),
      source_location_id: fromBin(row.source_location_id),
      location_id: fromBin(row.location_id),
      input_product_id: fromBin(row.input_product_id),
      heads_qty: row.heads_qty,
      condemned_heads: row.condemned_heads,
      live_weight_g: Number(row.live_weight_g),
      output_weight_g: Number(row.output_weight_g),
      yield_rate: row.yield_rate === null ? null : Number(row.yield_rate),
      stock_lot_id: fromBin(row.stock_lot_id),
      status: row.status,
      occurred_at: row.occurred_at,
      version: row.version,
      outputs: outputs.map((output) => ({
        product_id: fromBin(output.product_id),
        to_location_id: fromBin(output.to_location_id),
        quantity_base: qtyOf(output.quantity_base),
        weight_g: Number(output.weight_g),
      })),
    };
  },
};

export function resolveEntityProjection(entityType: string): EntityProjectionReader | undefined {
  return ENTITY_PROJECTIONS[entityType];
}
