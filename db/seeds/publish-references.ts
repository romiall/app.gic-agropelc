/**
 * Publication des référentiels semés dans le flux de synchronisation (P5-18, suite d'ADR-031 ;
 * AV-196). Le seed écrit ses tables sans passer par le pipeline de commandes : sans cette étape,
 * aucun appareil ne recevrait les motifs, étapes, sources, paramètres visibles, politiques ni
 * emplacements virtuels semés. Les écritures ultérieures sont publiées par leurs commandes, avec les
 * mêmes jeux, types d'entité et clés (`apps/server/src/modules/*\/application/*-changes.ts`).
 *
 * Idempotent : une ligne `UPSERT` `GLOBAL` par entité et par version, ajoutée seulement si le flux
 * ne porte pas déjà cette (jeu, type, entité, version). Les tables sans version (unités, canaux,
 * paramètres, une ligne par version) sont publiées en version 1. Le flux étant en ajout seul, une
 * entité modifiée depuis par une commande garde sa ligne la plus récente : la projection lit
 * toujours l'état courant. Paramètres : seule la version en vigueur est publiée, et les versions
 * visibles qu'elle remplace sont retirées (`DELETE`).
 */
import type mysql from 'mysql2/promise';
import { codeEntityId } from './code-entity-id.js';

interface ReferenceFeed {
  readonly dataset: string;
  readonly entityType: string;
  /** Lignes à publier : `entity_key` (UUID binaire ou code) et `row_version`. */
  readonly query: string;
  /** Clé de synchronisation dérivée du code (ADR-031) ; sinon `entity_key` est l'UUID binaire. */
  readonly codeKeyed?: boolean;
  /** Ligne servie à l'entité elle-même (portée `DEVICE` = l'appareil), au lieu de `GLOBAL`. */
  readonly selfDeviceScoped?: boolean;
}

const REFERENCE_FEEDS: readonly ReferenceFeed[] = [
  {
    dataset: 'catalog',
    entityType: 'PAYMENT_METHOD',
    query: 'SELECT code AS entity_key, version AS row_version FROM finance_payment_methods',
    codeKeyed: true,
  },
  {
    dataset: 'catalog',
    entityType: 'UNIT',
    query: 'SELECT code AS entity_key, 1 AS row_version FROM catalog_units',
    codeKeyed: true,
  },
  {
    dataset: 'catalog',
    entityType: 'SALES_CHANNEL',
    query: 'SELECT code AS entity_key, 1 AS row_version FROM catalog_sales_channels',
    codeKeyed: true,
  },
  {
    dataset: 'catalog',
    entityType: 'REASON_CODE',
    query: 'SELECT id AS entity_key, version AS row_version FROM catalog_reason_codes',
  },
  // AV-017 (MP-02) : catégories semées, publiées comme le repli générique du pipeline des commandes
  // `catalog.customer_category.*` (jeu `customer_category`, version 1).
  {
    dataset: 'customer_category',
    entityType: 'CUSTOMER_CATEGORY',
    query: 'SELECT id AS entity_key, 1 AS row_version FROM catalog_customer_categories',
  },
  {
    // P8-04 (ADR-042 §9) : catégories de dépense, à leur identifiant (UUIDv7) et leur version.
    dataset: 'catalog',
    entityType: 'EXPENSE_CATEGORY',
    query: 'SELECT id AS entity_key, version AS row_version FROM finance_expense_categories',
  },
  {
    dataset: 'catalog',
    entityType: 'PIPELINE_STEP',
    query: 'SELECT id AS entity_key, version AS row_version FROM crm_pipeline_steps',
  },
  {
    dataset: 'catalog',
    entityType: 'LEAD_SOURCE',
    query: 'SELECT id AS entity_key, version AS row_version FROM crm_lead_sources',
  },
  {
    // Version en vigueur de chaque (clé, portée), si elle est visible des appareils (jeu `me`).
    dataset: 'me',
    entityType: 'SETTING',
    query: `SELECT s.id AS entity_key, 1 AS row_version
              FROM organization_system_settings s
             WHERE s.is_client_visible = TRUE
               AND NOT EXISTS (
                 SELECT 1 FROM organization_system_settings n
                  WHERE n.\`key\` = s.\`key\` AND n.scope_type = s.scope_type
                    AND n.scope_id <=> s.scope_id
                    AND (n.valid_from > s.valid_from
                         OR (n.valid_from = s.valid_from AND n.created_at > s.created_at)))`,
  },
  {
    dataset: 'policies',
    entityType: 'CONTROL_POLICY',
    query: `SELECT id AS entity_key, 1 AS row_version
              FROM approvals_control_policies WHERE status = 'ACTIVE'`,
  },
  {
    // Emplacements virtuels globaux (« périmètre + virtuels », 01-architecture-offline.md §3.1) : jeu
    // du repli générique des emplacements. Les emplacements « à livrer » (virtuels d'un site, créés à
    // la première confirmation de commande) n'en sont pas.
    dataset: 'location',
    entityType: 'LOCATION',
    query: `SELECT id AS entity_key, version AS row_version
              FROM organization_locations WHERE is_virtual = TRUE AND site_id IS NULL`,
  },
  {
    // P5-23 (AV-195 (3)) : fiche de chaque appareil encore en service, servie à lui seul (jeu `device`,
    // portée `DEVICE`) — les commandes d'appareil la publient ensuite (`emitDeviceChange`).
    dataset: 'device',
    entityType: 'DEVICE',
    query: `SELECT id AS entity_key, version AS row_version
              FROM identity_devices WHERE status IN ('PENDING', 'ACTIVE')`,
    selfDeviceScoped: true,
  },
];

function entityIdOf(feed: ReferenceFeed, key: unknown): Buffer {
  if (!feed.codeKeyed) return key as Buffer;
  return Buffer.from(codeEntityId(feed.entityType, String(key)).replace(/-/g, ''), 'hex');
}

export async function publishReferenceFeeds(conn: mysql.Connection): Promise<void> {
  for (const feed of REFERENCE_FEEDS) {
    const [rows] = await conn.query<mysql.RowDataPacket[]>(feed.query);
    const scopeType = feed.selfDeviceScoped ? 'DEVICE' : 'GLOBAL';
    // Versions déjà publiées, lues en une fois (MP-11 : une requête par entité prenait près d'une
    // minute sur une base aux milliers d'appareils).
    const [publishedRows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT entity_id, row_version FROM sync_change_feed
        WHERE dataset = ? AND entity_type = ? AND scope_type = ?`,
      [feed.dataset, feed.entityType, scopeType],
    );
    const alreadyPublished = new Set(
      publishedRows.map(
        (row) => `${(row.entity_id as Buffer).toString('hex')}:${Number(row.row_version)}`,
      ),
    );
    let published = 0;
    for (const row of rows) {
      const entityId = entityIdOf(feed, row.entity_key);
      const rowVersion = Number(row.row_version);
      const scopeId = feed.selfDeviceScoped ? entityId : null;
      const key = `${entityId.toString('hex')}:${rowVersion}`;
      if (alreadyPublished.has(key)) continue;
      alreadyPublished.add(key);
      await conn.query(
        `INSERT INTO sync_change_feed
           (dataset, entity_type, entity_id, change_type, scope_type, scope_id, row_version)
         VALUES (?, ?, ?, 'UPSERT', ?, ?, ?)`,
        [feed.dataset, feed.entityType, entityId, scopeType, scopeId, rowVersion],
      );
      if (feed.entityType === 'SETTING') {
        // Comme `emitSettingChange` : les versions visibles antérieures de la même clé et de la même
        // portée sortent du jeu (révision d'une valeur par défaut, SYSTEM_SETTING_REVISIONS).
        await conn.query(
          `INSERT INTO sync_change_feed
             (dataset, entity_type, entity_id, change_type, scope_type, scope_id, row_version)
           SELECT 'me', 'SETTING', o.id, 'DELETE', 'GLOBAL', NULL, 1
             FROM organization_system_settings s
             JOIN organization_system_settings o
               ON o.\`key\` = s.\`key\` AND o.scope_type = s.scope_type
              AND o.scope_id <=> s.scope_id AND o.id <> s.id
              AND o.is_client_visible = TRUE AND o.valid_from <= s.valid_from
            WHERE s.id = ?`,
          [entityId],
        );
      }
      published++;
    }
    console.log(
      `  + sync_change_feed ${feed.dataset}/${feed.entityType} (${published} publication(s))`,
    );
  }
}
