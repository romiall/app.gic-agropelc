// Contraintes de base de la production (P7-04) : invariants portés par la base elle-même
// (INV-OEU-01 bilan de collecte, INV-INC-01 bilan d'incubation à la clôture, un seul transfert et
// une seule éclosion par lot d'incubation, immuabilités, lot clos figé, répartitions de frais
// généraux jamais réécrites). Chaque test crée ses propres référentiels dans une transaction
// annulée : aucune dépendance à l'ordre d'exécution ni au seed.
import { describe, expect, it } from 'vitest';
import type { PoolConnection } from 'mysql2/promise';
import { randomId, withRollback } from './helpers.js';

const T0 = '2026-10-10 08:00:00.000000';

function randomCode(prefix: string): string {
  return `${prefix}${Math.floor(Math.random() * 1_000_000_000)}`;
}

interface Refs {
  readonly admin: Buffer;
  readonly siteId: Buffer;
  readonly buildingId: Buffer;
  readonly storeId: Buffer;
  readonly productId: Buffer;
  readonly eggId: Buffer;
}

async function setup(conn: PoolConnection): Promise<Refs> {
  const admin = randomId();
  await conn.query(
    `INSERT INTO identity_users (id, full_name, phone, password_hash, status, created_by)
     VALUES (?, 'Test', ?, 'x', 'ACTIVE', ?)`,
    [admin, `+2376${Math.floor(10_000_000 + Math.random() * 89_999_999)}`, admin],
  );
  const zoneId = randomId();
  await conn.query(
    `INSERT INTO organization_zones (id, level, code, name, depth, created_by) VALUES (?, 'VILLE', ?, 'Douala', 1, ?)`,
    [zoneId, randomCode('Z'), admin],
  );
  const siteId = randomId();
  await conn.query(
    `INSERT INTO organization_sites (id, code, name, site_type, zone_id, created_by) VALUES (?, ?, 'Ferme', 'FERME', ?, ?)`,
    [siteId, randomCode('S'), zoneId, admin],
  );
  const buildingId = randomId();
  const storeId = randomId();
  await conn.query(
    `INSERT INTO organization_locations (id, site_id, code, name, location_type, created_by)
     VALUES (?, ?, ?, 'Bâtiment 1', 'BUILDING', ?), (?, ?, ?, 'Magasin', 'STORE', ?)`,
    [buildingId, siteId, randomCode('B'), admin, storeId, siteId, randomCode('M'), admin],
  );
  const unitCode = randomCode('U').slice(0, 20);
  await conn.query(`INSERT INTO catalog_units (code, name, is_count) VALUES (?, 'Tête', TRUE)`, [
    unitCode,
  ]);
  const categoryId = randomId();
  await conn.query(
    `INSERT INTO catalog_product_categories (id, code, name, created_by) VALUES (?, ?, 'Élevage', ?)`,
    [categoryId, randomCode('C'), admin],
  );
  const productId = randomId();
  const eggId = randomId();
  await conn.query(
    `INSERT INTO catalog_products (id, code, name, category_id, stock_family, species, base_unit_code, lot_tracking, created_by)
     VALUES (?, ?, 'Pondeuse', ?, 'BIOLOGIQUE', 'PONDEUSE', ?, 'REQUIRED', ?),
            (?, ?, 'Œuf gros', ?, 'PRODUCTION_COMMERCIALISABLE', NULL, ?, 'REQUIRED', ?)`,
    [
      productId,
      randomCode('P'),
      categoryId,
      unitCode,
      admin,
      eggId,
      randomCode('E'),
      categoryId,
      unitCode,
      admin,
    ],
  );
  return { admin, siteId, buildingId, storeId, productId, eggId };
}

async function stockLot(conn: PoolConnection, refs: Refs, origin: string): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO inventory_stock_lots (id, lot_code, product_id, origin_type, origin_id, fifo_rank_at, created_by)
     VALUES (?, ?, NULL, ?, ?, ?, ?)`,
    [id, randomCode('SL-'), origin, randomId(), T0, refs.admin],
  );
  return id;
}

async function insertLot(conn: PoolConnection, refs: Refs): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO production_production_lots (id, lot_code, lot_type, product_id, stock_lot_id, site_id,
       main_location_id, status, occurred_at, created_by)
     VALUES (?, ?, 'PONDEUSE', ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
    [
      id,
      randomCode('LOT-'),
      refs.productId,
      await stockLot(conn, refs, 'PRODUCTION_LOT'),
      refs.siteId,
      refs.buildingId,
      T0,
      refs.admin,
    ],
  );
  return id;
}

async function insertCollection(
  conn: PoolConnection,
  refs: Refs,
  lotId: Buffer,
  q: {
    collected: number;
    broken: number;
    nonconforming: number;
    marketable: number;
    hatching: number;
  },
): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO production_egg_collections (id, doc_number, production_lot_id, site_id, collection_date,
       storage_location_id, stock_lot_id, hatching_product_id, collected_qty, broken_qty, nonconforming_qty,
       marketable_qty, hatching_qty, occurred_at, created_by)
     VALUES (?, ?, ?, ?, '2026-10-10', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      randomCode('COL-'),
      lotId,
      refs.siteId,
      refs.storeId,
      await stockLot(conn, refs, 'COLLECTION'),
      q.hatching > 0 ? refs.eggId : null,
      q.collected,
      q.broken,
      q.nonconforming,
      q.marketable,
      q.hatching,
      T0,
      refs.admin,
    ],
  );
  return id;
}

async function insertBatch(conn: PoolConnection, refs: Refs): Promise<Buffer> {
  const id = randomId();
  const incubatorId = randomId();
  await conn.query(
    `INSERT INTO organization_locations (id, site_id, code, name, location_type, created_by) VALUES (?, ?, ?, 'Incubateur', 'INCUBATOR', ?)`,
    [incubatorId, refs.siteId, randomCode('I'), refs.admin],
  );
  await conn.query(
    `INSERT INTO production_incubation_batches (id, batch_code, stock_lot_id, site_id, species, egg_product_id,
       chick_product_id, incubator_location_id, egg_source, eggs_set_qty, set_at, occurred_at, created_by)
     VALUES (?, ?, ?, ?, 'POULE', ?, ?, ?, 'INTERNAL', 600, ?, ?, ?)`,
    [
      id,
      randomCode('INC-'),
      await stockLot(conn, refs, 'INCUBATION_BATCH'),
      refs.siteId,
      refs.eggId,
      refs.productId,
      incubatorId,
      T0,
      T0,
      refs.admin,
    ],
  );
  return id;
}

describe('production (P7-04) : contraintes de base', () => {
  it('INV-OEU-01 : collectés = cassés + non conformes + commercialisables + à couver ; plusieurs collectes par jour (AV-110)', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const lotId = await insertLot(conn, refs);
      await insertCollection(conn, refs, lotId, {
        collected: 1850,
        broken: 25,
        nonconforming: 15,
        marketable: 1690,
        hatching: 120,
      });
      // Seconde collecte du même jour : admise.
      await insertCollection(conn, refs, lotId, {
        collected: 100,
        broken: 0,
        nonconforming: 0,
        marketable: 100,
        hatching: 0,
      });
      await expect(
        insertCollection(conn, refs, lotId, {
          collected: 1851,
          broken: 25,
          nonconforming: 15,
          marketable: 1690,
          hatching: 120,
        }),
      ).rejects.toThrow(/ck_production_egg_collections_balance/);
    });
  });

  it('collecte immuable ; lot clos figé ; aucune suppression', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const lotId = await insertLot(conn, refs);
      const collectionId = await insertCollection(conn, refs, lotId, {
        collected: 10,
        broken: 0,
        nonconforming: 0,
        marketable: 10,
        hatching: 0,
      });
      await expect(
        conn.query(
          'UPDATE production_egg_collections SET marketable_qty = 9, broken_qty = 1 WHERE id = ?',
          [collectionId],
        ),
      ).rejects.toThrow(/collecte non modifiable/);
      await conn.query(
        `UPDATE production_production_lots SET status = 'CLOSED', closed_at = ? WHERE id = ?`,
        [T0, lotId],
      );
      await expect(
        conn.query(`UPDATE production_production_lots SET status = 'ACTIVE' WHERE id = ?`, [lotId]),
      ).rejects.toThrow(/ne change plus de statut/);
      await expect(
        conn.query('DELETE FROM production_production_lots WHERE id = ?', [lotId]),
      ).rejects.toThrow(/INV-GLO-03/);
    });
  });

  it('INV-INC-01 : bilan juste exigé à la clôture ; un seul transfert et une seule éclosion par lot', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const batchId = await insertBatch(conn, refs);
      await expect(
        conn.query(
          `UPDATE production_incubation_batches SET status = 'CLOSED', infertile_qty = 42, early_dead_qty = 18,
             unhatched_qty = 35, hatched_viable_qty = 498, hatched_nonviable_qty = 6 WHERE id = ?`,
          [batchId],
        ),
      ).rejects.toThrow(/ck_production_incubation_batches_balance/);
      await conn.query(
        `UPDATE production_incubation_batches SET status = 'CLOSED', infertile_qty = 42, early_dead_qty = 18,
           unhatched_qty = 35, hatched_viable_qty = 498, hatched_nonviable_qty = 7, hatch_rate = 0.8300 WHERE id = ?`,
        [batchId],
      );
      const hatch = () =>
        conn.query(
          `INSERT INTO production_incubation_events (id, batch_id, event_type, qty_hatched_viable, occurred_at, created_by)
           VALUES (?, ?, 'HATCH', 498, ?, ?)`,
          [randomId(), batchId, T0, refs.admin],
        );
      await hatch();
      await expect(hatch()).rejects.toThrow(/uq_production_incubation_events_single_step/);
    });
  });

  it('répartition de frais généraux : jamais réécrite ; part estimée liée à un lot (AV-105)', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const lotId = await insertLot(conn, refs);
      const runId = randomId();
      await conn.query(
        `INSERT INTO production_overhead_allocations (id, site_id, species_group, period, run_kind, sequence,
           pool_xaf, allocated_xaf, head_days_total, occurred_at, created_by)
         VALUES (?, ?, 'VOLAILLE', '2026-10', 'INITIAL', 1, 100000, 100000, 60000, ?, ?)`,
        [runId, refs.siteId, T0, refs.admin],
      );
      await expect(
        conn.query('UPDATE production_overhead_allocations SET allocated_xaf = 1 WHERE id = ?', [
          runId,
        ]),
      ).rejects.toThrow(/jamais réécrite/);
      await expect(
        conn.query(
          `INSERT INTO production_overhead_allocations (id, site_id, species_group, period, run_kind, sequence,
             pool_xaf, allocated_xaf, head_days_total, occurred_at, created_by)
           VALUES (?, ?, 'VOLAILLE', '2026-10', 'CLOSING_ESTIMATE', 2, 100, 100, 10, ?, ?)`,
          [randomId(), refs.siteId, T0, refs.admin],
        ),
      ).rejects.toThrow(/ck_production_overhead_allocations_estimate/);
      await conn.query(
        `INSERT INTO production_overhead_allocations (id, site_id, species_group, period, run_kind, sequence,
           pool_xaf, allocated_xaf, head_days_total, production_lot_id, occurred_at, created_by)
         VALUES (?, ?, 'VOLAILLE', '2026-10', 'CLOSING_ESTIMATE', 2, 100, 100, 10, ?, ?, ?)`,
        [randomId(), refs.siteId, lotId, T0, refs.admin],
      );
    });
  });
});
