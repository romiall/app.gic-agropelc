// Garde en base des quotas d'appareil (P5-04 ; ADR-033, SM-ALLOCATION ; INV-STK-10, INV-STK-11,
// INV-STK-20) : quota d'appareil seul (plus de réservation de commande), reste jamais négatif et
// jamais supérieur à l'accordé, état cohérent avec ses données, registre d'entrées signé et lié à un
// mouvement une seule fois, UPDATE à liste blanche, un seul quota actif par couple. Insertions
// directes qui contournent l'application : chaque refus est prouvé par la base elle-même.
import { describe, expect, it } from 'vitest';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { randomId, withRollback } from './helpers.js';

const T0 = '2026-10-08 08:00:00.000000';

function randomCode(prefix: string): string {
  return `${prefix}${Math.floor(Math.random() * 1_000_000_000)}`;
}

/** Code court d'appareil : 4 caractères alphanumériques (unique en base). */
function shortCode(): string {
  return Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .toUpperCase()
    .padStart(4, '0');
}

interface Refs {
  readonly admin: Buffer;
  readonly holder: Buffer;
  readonly deviceA: Buffer;
  readonly deviceB: Buffer;
  readonly locationId: Buffer;
  readonly customerId: Buffer;
  readonly productId: Buffer;
  readonly otherProductId: Buffer;
}

async function setup(conn: PoolConnection): Promise<Refs> {
  const user = async (): Promise<Buffer> => {
    const id = randomId();
    await conn.query(
      `INSERT INTO identity_users (id, full_name, phone, password_hash, status, created_by)
       VALUES (?, 'Test', ?, 'x', 'ACTIVE', ?)`,
      [id, `+2376${Math.floor(10_000_000 + Math.random() * 89_999_999)}`, id],
    );
    return id;
  };
  const admin = await user();
  const holder = await user();
  const device = async (code: string): Promise<Buffer> => {
    const id = randomId();
    await conn.query(
      `INSERT INTO identity_devices (id, short_code, enrolled_by_user_id, created_by) VALUES (?, ?, ?, ?)`,
      [id, code, admin, admin],
    );
    return id;
  };
  const zoneId = randomId();
  await conn.query(
    `INSERT INTO organization_zones (id, level, code, name, depth, created_by) VALUES (?, 'VILLE', ?, 'Douala', 1, ?)`,
    [zoneId, randomCode('Z'), admin],
  );
  const siteId = randomId();
  await conn.query(
    `INSERT INTO organization_sites (id, code, name, site_type, zone_id, created_by)
     VALUES (?, ?, 'PDV', 'POINT_DE_VENTE', ?, ?)`,
    [siteId, randomCode('S'), zoneId, admin],
  );
  const locationId = randomId();
  await conn.query(
    `INSERT INTO organization_locations (id, site_id, code, name, location_type, custody_mode, created_by)
     VALUES (?, ?, ?, 'Vente', 'POS', 'SHARED', ?)`,
    [locationId, siteId, randomCode('L'), admin],
  );
  const [customer] = await conn.query<RowDataPacket[]>(
    `SELECT id FROM organization_locations WHERE location_type = 'V_CUSTOMER' AND status = 'ACTIVE'`,
  );
  let customerId: Buffer;
  if (customer[0]) customerId = customer[0].id as Buffer;
  else {
    customerId = randomId();
    await conn.query(
      `INSERT INTO organization_locations (id, code, name, location_type, created_by) VALUES (?, ?, 'Client', 'V_CUSTOMER', ?)`,
      [customerId, randomCode('V-'), admin],
    );
  }
  const unitCode = randomCode('U').slice(0, 20);
  await conn.query(`INSERT INTO catalog_units (code, name, is_count) VALUES (?, 'Pièce', TRUE)`, [
    unitCode,
  ]);
  const categoryId = randomId();
  await conn.query(
    `INSERT INTO catalog_product_categories (id, code, name, created_by) VALUES (?, ?, 'Divers', ?)`,
    [categoryId, randomCode('C'), admin],
  );
  const product = async (): Promise<Buffer> => {
    const id = randomId();
    await conn.query(
      `INSERT INTO catalog_products (id, code, name, category_id, stock_family, base_unit_code, created_by)
       VALUES (?, ?, 'Poulet', ?, 'MARCHANDISE', ?, ?)`,
      [id, randomCode('P'), categoryId, unitCode, admin],
    );
    return id;
  };
  return {
    admin,
    holder,
    deviceA: await device(shortCode()),
    deviceB: await device(shortCode()),
    locationId,
    customerId,
    productId: await product(),
    otherProductId: await product(),
  };
}

async function insertQuota(
  conn: PoolConnection,
  refs: Refs,
  input: {
    readonly device?: Buffer;
    readonly product?: Buffer;
    readonly granted?: number;
    readonly remaining?: number;
    readonly type?: string;
  } = {},
): Promise<Buffer> {
  const id = randomId();
  const granted = input.granted ?? 40;
  await conn.query(
    `INSERT INTO inventory_stock_allocations (id, allocation_type, location_id, product_id, holder_user_id, holder_device_id,
       quantity_granted, quantity_remaining, granted_by, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.type ?? 'DEVICE_QUOTA',
      refs.locationId,
      input.product ?? refs.productId,
      refs.holder,
      input.device ?? refs.deviceA,
      granted,
      input.remaining ?? granted,
      refs.admin,
      refs.admin,
    ],
  );
  return id;
}

async function insertEntry(
  conn: PoolConnection,
  refs: Refs,
  allocationId: Buffer,
  type: string,
  quantity: number,
  moveId: Buffer | null = null,
): Promise<void> {
  await conn.query(
    `INSERT INTO inventory_stock_allocation_entries (id, allocation_id, entry_type, quantity, stock_move_id, occurred_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [randomId(), allocationId, type, quantity, moveId, T0, refs.admin],
  );
}

async function insertSaleMove(
  conn: PoolConnection,
  refs: Refs,
  allocationId: Buffer,
): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO inventory_stock_moves (id, product_id, quantity, from_location_id, to_location_id, move_type, unit_cost_xaf,
       value_xaf, occurred_at, source_doc_type, source_doc_id, allocation_id, created_by)
     VALUES (?, ?, 2, ?, ?, 'SALE', 500, 1000, ?, 'SALE', ?, ?, ?)`,
    [
      id,
      refs.productId,
      refs.locationId,
      refs.customerId,
      T0,
      randomId(),
      allocationId,
      refs.admin,
    ],
  );
  return id;
}

describe('inventory_stock_allocations — quota d’appareil seul (ADR-033)', () => {
  it('accepte un quota d’appareil ; refuse une réservation de commande', () =>
    withRollback(async (conn) => {
      const refs = await setup(conn);
      await insertQuota(conn, refs);
      await expect(
        insertQuota(conn, refs, { type: 'ORDER_RESERVATION', device: refs.deviceB }),
      ).rejects.toThrow(/ck_inventory_stock_allocations_type/);
    }));

  it('la colonne de réservation de commande a disparu', () =>
    withRollback(async (conn) => {
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inventory_stock_allocations' AND COLUMN_NAME = 'sales_order_line_id'`,
      );
      expect(rows).toHaveLength(0);
    }));

  it('un quota exige un détenteur (utilisateur et appareil)', () =>
    withRollback(async (conn) => {
      const refs = await setup(conn);
      await expect(
        conn.query(
          `INSERT INTO inventory_stock_allocations (id, allocation_type, location_id, product_id, holder_user_id, quantity_granted,
             quantity_remaining, granted_by, created_by) VALUES (?, 'DEVICE_QUOTA', ?, ?, ?, 5, 5, ?, ?)`,
          [randomId(), refs.locationId, refs.productId, refs.holder, refs.admin, refs.admin],
        ),
      ).rejects.toThrow(/ck_inventory_stock_allocations_holder/);
    }));

  it('quantités : accordé > 0, reste ≥ 0 et jamais supérieur à l’accordé (INV-STK-10, INV-STK-20)', () =>
    withRollback(async (conn) => {
      const refs = await setup(conn);
      await expect(insertQuota(conn, refs, { granted: 0, remaining: 0 })).rejects.toThrow(
        /ck_inventory_stock_allocations_quantities/,
      );
      await expect(insertQuota(conn, refs, { granted: 10, remaining: -1 })).rejects.toThrow(
        /ck_inventory_stock_allocations_quantities/,
      );
      await expect(insertQuota(conn, refs, { granted: 10, remaining: 11 })).rejects.toThrow(
        /ck_inventory_stock_allocations_quantities/,
      );
      await insertQuota(conn, refs, { granted: 10, remaining: 10 });
    }));

  it('un seul quota actif par (utilisateur, appareil, emplacement, produit, lot) ; un autre appareil ou produit passe', () =>
    withRollback(async (conn) => {
      const refs = await setup(conn);
      await insertQuota(conn, refs);
      await expect(insertQuota(conn, refs)).rejects.toThrow(
        /Duplicate|uq_inventory_stock_allocations_active_device_quota/,
      );
      await insertQuota(conn, refs, { device: refs.deviceB });
      await insertQuota(conn, refs, { product: refs.otherProductId });
    }));
});

describe('états et garde d’UPDATE (SM-ALLOCATION)', () => {
  it('libération : fermé avec cause et reste nul ; une cause sans état fermé est refusée', () =>
    withRollback(async (conn) => {
      const refs = await setup(conn);
      const id = await insertQuota(conn, refs);
      await expect(
        conn.query(
          `UPDATE inventory_stock_allocations SET status = 'CLOSED', close_cause = 'RELEASED' WHERE id = ?`,
          [id],
        ),
      ).rejects.toThrow(/ck_inventory_stock_allocations_state/);
      await expect(
        conn.query(`UPDATE inventory_stock_allocations SET close_cause = 'RELEASED' WHERE id = ?`, [
          id,
        ]),
      ).rejects.toThrow(/ck_inventory_stock_allocations_state/);
      await conn.query(
        `UPDATE inventory_stock_allocations SET status = 'CLOSED', close_cause = 'RELEASED', quantity_remaining = 0,
           released_at = ?, release_declared_remaining = 2 WHERE id = ?`,
        [T0, id],
      );
    }));

  it('révocation : motif, auteur et date exigés, reste nul', () =>
    withRollback(async (conn) => {
      const refs = await setup(conn);
      const id = await insertQuota(conn, refs);
      await expect(
        conn.query(
          `UPDATE inventory_stock_allocations SET status = 'REVOKED', quantity_remaining = 0, revoked_at = ? WHERE id = ?`,
          [T0, id],
        ),
      ).rejects.toThrow(/ck_inventory_stock_allocations_state/);
      await conn.query(
        `UPDATE inventory_stock_allocations SET status = 'REVOKED', quantity_remaining = 0, revoked_at = ?, revoked_by = ?,
           revoke_reason = 'Appareil perdu' WHERE id = ?`,
        [T0, refs.admin, id],
      );
    }));

  it('un quota en attente de révocation reste actif ; l’indicateur n’existe pas sur un quota terminé', () =>
    withRollback(async (conn) => {
      const refs = await setup(conn);
      const id = await insertQuota(conn, refs);
      await conn.query(
        `UPDATE inventory_stock_allocations SET revocation_pending = TRUE WHERE id = ?`,
        [id],
      );
      await expect(
        conn.query(
          `UPDATE inventory_stock_allocations SET status = 'CLOSED', close_cause = 'RELEASED', quantity_remaining = 0,
             released_at = ?, revocation_pending = TRUE WHERE id = ?`,
          [T0, id],
        ),
      ).rejects.toThrow(/ck_inventory_stock_allocations_pending/);
    }));

  it('identité immuable ; quantité accordée jamais en baisse ; l’augmentation passe', () =>
    withRollback(async (conn) => {
      const refs = await setup(conn);
      const id = await insertQuota(conn, refs, { granted: 40 });
      await expect(
        conn.query(`UPDATE inventory_stock_allocations SET holder_device_id = ? WHERE id = ?`, [
          refs.deviceB,
          id,
        ]),
      ).rejects.toThrow(/identité du quota immuable/);
      await expect(
        conn.query(`UPDATE inventory_stock_allocations SET product_id = ? WHERE id = ?`, [
          refs.otherProductId,
          id,
        ]),
      ).rejects.toThrow(/identité du quota immuable/);
      await expect(
        conn.query(
          `UPDATE inventory_stock_allocations SET quantity_granted = 30, quantity_remaining = 30 WHERE id = ?`,
          [id],
        ),
      ).rejects.toThrow(/ne diminue jamais/);
      await conn.query(
        `UPDATE inventory_stock_allocations SET quantity_granted = 45, quantity_remaining = 45 WHERE id = ?`,
        [id],
      );
    }));

  it('un quota terminé ne change plus ; il ne se supprime pas', () =>
    withRollback(async (conn) => {
      const refs = await setup(conn);
      const id = await insertQuota(conn, refs);
      await conn.query(
        `UPDATE inventory_stock_allocations SET status = 'CLOSED', close_cause = 'RELEASED', quantity_remaining = 0,
           released_at = ? WHERE id = ?`,
        [T0, id],
      );
      await expect(
        conn.query(
          `UPDATE inventory_stock_allocations SET status = 'ACTIVE', close_cause = NULL, released_at = NULL WHERE id = ?`,
          [id],
        ),
      ).rejects.toThrow(/terminal/);
      await expect(
        conn.query(`UPDATE inventory_stock_allocations SET valid_until = ? WHERE id = ?`, [T0, id]),
      ).rejects.toThrow(/ne changent plus/);
      await expect(
        conn.query(`DELETE FROM inventory_stock_allocations WHERE id = ?`, [id]),
      ).rejects.toThrow(/suppression physique interdite/);
    }));
});

describe('inventory_stock_allocation_entries — registre signé (INV-STK-20)', () => {
  it('le signe suit le type : positif pour l’octroi, l’augmentation et la restitution ; négatif sinon ; ajustement non nul', () =>
    withRollback(async (conn) => {
      const refs = await setup(conn);
      const id = await insertQuota(conn, refs);
      await insertEntry(conn, refs, id, 'GRANT', 40);
      await insertEntry(conn, refs, id, 'INCREASE', 5);
      await insertEntry(conn, refs, id, 'RELEASE', -3);
      await insertEntry(conn, refs, id, 'REVOKE', -2);
      await insertEntry(conn, refs, id, 'ADJUST', -1);
      await insertEntry(conn, refs, id, 'ADJUST', 1);
      for (const [type, quantity] of [
        ['GRANT', -1],
        ['INCREASE', 0],
        ['RELEASE', 1],
        ['REVOKE', 2],
        ['ADJUST', 0],
      ] as const) {
        await expect(insertEntry(conn, refs, id, type, quantity)).rejects.toThrow(
          /ck_inventory_stock_allocation_entries_sign/,
        );
      }
    }));

  it('l’entrée de transfert n’existe plus (la réservation transférable est retirée)', () =>
    withRollback(async (conn) => {
      const refs = await setup(conn);
      const id = await insertQuota(conn, refs);
      await expect(insertEntry(conn, refs, id, 'TRANSFER', -1)).rejects.toThrow(
        /ck_inventory_stock_allocation_entries_(type|sign)/,
      );
    }));

  it('consommation et restitution citent leur mouvement, une seule fois par mouvement et par type', () =>
    withRollback(async (conn) => {
      const refs = await setup(conn);
      const id = await insertQuota(conn, refs);
      await expect(insertEntry(conn, refs, id, 'CONSUME', -2)).rejects.toThrow(
        /ck_inventory_stock_allocation_entries_move/,
      );
      await expect(insertEntry(conn, refs, id, 'RESTORE', 2)).rejects.toThrow(
        /ck_inventory_stock_allocation_entries_move/,
      );
      const move = await insertSaleMove(conn, refs, id);
      await insertEntry(conn, refs, id, 'CONSUME', -2, move);
      await expect(insertEntry(conn, refs, id, 'CONSUME', -2, move)).rejects.toThrow(
        /Duplicate|uq_inventory_stock_allocation_entries_move_type/,
      );
      // La restitution d'une vente annulée cite son propre mouvement de retour : un type différent, pas de conflit.
      await insertEntry(conn, refs, id, 'RESTORE', 2, move);
    }));

  it('registre immuable : ni modification ni suppression', () =>
    withRollback(async (conn) => {
      const refs = await setup(conn);
      const id = await insertQuota(conn, refs);
      await insertEntry(conn, refs, id, 'GRANT', 40);
      await expect(
        conn.query(
          `UPDATE inventory_stock_allocation_entries SET quantity = 41 WHERE allocation_id = ?`,
          [id],
        ),
      ).rejects.toThrow(/immuable/);
      await expect(
        conn.query(`DELETE FROM inventory_stock_allocation_entries WHERE allocation_id = ?`, [id]),
      ).rejects.toThrow(/suppression physique interdite/);
    }));

  it('INV-STK-20 : le reste d’un quota égale la somme signée de ses entrées', () =>
    withRollback(async (conn) => {
      const refs = await setup(conn);
      const id = await insertQuota(conn, refs, { granted: 45, remaining: 45 });
      const move = await insertSaleMove(conn, refs, id);
      await insertEntry(conn, refs, id, 'GRANT', 40);
      await insertEntry(conn, refs, id, 'INCREASE', 5);
      await insertEntry(conn, refs, id, 'CONSUME', -2, move);
      await conn.query(
        `UPDATE inventory_stock_allocations SET quantity_remaining = 43 WHERE id = ?`,
        [id],
      );
      const [[row]] = await conn.query<RowDataPacket[]>(
        `SELECT a.quantity_remaining AS remaining, SUM(e.quantity) AS total
           FROM inventory_stock_allocations a JOIN inventory_stock_allocation_entries e ON e.allocation_id = a.id
          WHERE a.id = ? GROUP BY a.id`,
        [id],
      );
      expect(Number(row!.remaining)).toBe(Number(row!.total));
    }));
});
