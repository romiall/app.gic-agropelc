/**
 * Lecture de « l'état courant » d'une entité pour `/sync/pull` (06-offline-sync/
 * 02-synchronisation.md §5.2 : « le flux ne stocke pas de copie des données » — chaque
 * `UPSERT` de `sync_change_feed` est résolu ici, au moment du téléchargement). Un lecteur par
 * `entity_type` réellement produit par un gestionnaire de commande à ce jour (identity,
 * organization, approvals, attachments ; catalog, pricing, procurement en P1-06 ; inventory en
 * P2-06, via `platform/sync/change-feed.ts`) — table fixe, tous définis dans ce seul fichier
 * (contrairement à `CommandHandlerRegistry`, alimenté par plusieurs modules indépendants,
 * une simple table couvre ce besoin sans registre mutable).
 *
 * Jamais de colonne sensible (`password_hash`…) dans une projection : ce module est le seul
 * point qui décide ce qu'un appareil reçoit d'une table, indépendamment de ce que la table
 * porte en interne.
 */
import type { Kysely, Transaction } from 'kysely';
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
  // lecture seule) » — filtrage par utilisateur non encore fait par device-scope.ts (P0-13,
  // comme toute entité P0-11/P0-13 : repli GLOBAL générique, commentaire command-pipeline.
  // service.ts « portée réelle déterminée par chaque module »).
  APPROVAL_REQUEST: async (executor, entityId) => {
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
        'amount_xaf',
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
    if (!row) return undefined;
    return {
      id: fromBin(row.id),
      operation_type: row.operation_type,
      subject_type: row.subject_type,
      subject_id: fromBin(row.subject_id),
      subject_summary: row.subject_summary,
      site_id: fromBinOrNull(row.site_id),
      zone_id: fromBinOrNull(row.zone_id),
      amount_xaf: row.amount_xaf,
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
};

export function resolveEntityProjection(entityType: string): EntityProjectionReader | undefined {
  return ENTITY_PROJECTIONS[entityType];
}
