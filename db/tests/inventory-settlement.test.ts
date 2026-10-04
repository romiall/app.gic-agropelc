// Garde en base des mouvements rattachés à une origine (P4-02 2/2, ADR-029 ; INV-STK-17,
// BR-STK-055 à 057) : un retour client (`CUSTOMER_RETURN`) et une livraison (`DELIVERY`) consomment
// une part d'un mouvement `SALE` d'origine, jamais plus que sa quantité ni sa valeur, la dernière
// opération emportant exactement le reliquat de valeur. Insertions directes qui contournent
// l'application : chaque refus est prouvé par la base elle-même. Chaque test crée ses propres
// référentiels dans une transaction annulée.
import { describe, expect, it } from 'vitest';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { randomId, withRollback } from './helpers.js';

const T0 = '2026-10-01 08:00:00.000000';

function randomCode(prefix: string): string {
  return `${prefix}${Math.floor(Math.random() * 1_000_000_000)}`;
}

interface Refs {
  readonly admin: Buffer;
  readonly productId: Buffer;
  readonly otherProductId: Buffer;
  /** Emplacement physique de préparation (source des ventes). */
  readonly storeId: Buffer;
  /** Autre emplacement physique (destination fautive d'un retour). */
  readonly otherStoreId: Buffer;
  readonly customerId: Buffer;
  readonly toDeliverId: Buffer;
  readonly lotA: Buffer;
  readonly lotB: Buffer;
}

async function virtualLocation(conn: PoolConnection, admin: Buffer, type: string): Promise<Buffer> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT id FROM organization_locations WHERE location_type = ? AND status = 'ACTIVE'`,
    [type],
  );
  if (rows[0]) return rows[0].id as Buffer;
  const id = randomId();
  await conn.query(
    `INSERT INTO organization_locations (id, code, name, location_type, created_by) VALUES (?, ?, ?, ?, ?)`,
    [id, randomCode('V-'), type, type, admin],
  );
  return id;
}

async function product(
  conn: PoolConnection,
  admin: Buffer,
  categoryId: Buffer,
  unitCode: string,
): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO catalog_products (id, code, name, category_id, stock_family, base_unit_code, created_by)
     VALUES (?, ?, 'Produit', ?, 'MARCHANDISE', ?, ?)`,
    [id, randomCode('P'), categoryId, unitCode, admin],
  );
  return id;
}

async function stockLot(conn: PoolConnection, admin: Buffer): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO inventory_stock_lots (id, lot_code, product_id, origin_type, origin_id, fifo_rank_at, created_by)
     VALUES (?, ?, NULL, 'SUPPLIER_LOT', ?, ?, ?)`,
    [id, randomCode('SL-'), randomId(), T0, admin],
  );
  return id;
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
    `INSERT INTO organization_sites (id, code, name, site_type, zone_id, created_by) VALUES (?, ?, 'Magasin', 'MAGASIN', ?, ?)`,
    [siteId, randomCode('S'), zoneId, admin],
  );
  const storeId = randomId();
  const otherStoreId = randomId();
  for (const id of [storeId, otherStoreId]) {
    await conn.query(
      `INSERT INTO organization_locations (id, site_id, code, name, location_type, created_by) VALUES (?, ?, ?, 'Réserve', 'STORE', ?)`,
      [id, siteId, randomCode('L'), admin],
    );
  }
  const toDeliverId = randomId();
  await conn.query(
    `INSERT INTO organization_locations (id, site_id, code, name, location_type, created_by) VALUES (?, ?, ?, 'À livrer', 'V_TO_DELIVER', ?)`,
    [toDeliverId, siteId, randomCode('TD'), admin],
  );
  const customerId = await virtualLocation(conn, admin, 'V_CUSTOMER');
  const unitCode = randomCode('U').slice(0, 20);
  await conn.query(`INSERT INTO catalog_units (code, name, is_count) VALUES (?, 'Pièce', TRUE)`, [
    unitCode,
  ]);
  const categoryId = randomId();
  await conn.query(
    `INSERT INTO catalog_product_categories (id, code, name, created_by) VALUES (?, ?, 'Divers', ?)`,
    [categoryId, randomCode('C'), admin],
  );
  return {
    admin,
    productId: await product(conn, admin, categoryId, unitCode),
    otherProductId: await product(conn, admin, categoryId, unitCode),
    storeId,
    otherStoreId,
    customerId,
    toDeliverId,
    lotA: await stockLot(conn, admin),
    lotB: await stockLot(conn, admin),
  };
}

interface MoveInput {
  readonly type: string;
  readonly from: Buffer;
  readonly to: Buffer;
  readonly quantity: number;
  readonly value: number;
  readonly product?: Buffer;
  readonly lot?: Buffer | null;
  readonly sourceDocType?: string;
  readonly reverses?: Buffer | null;
  readonly origin?: Buffer | null;
  readonly seq?: number | null;
}

async function insertMove(conn: PoolConnection, refs: Refs, input: MoveInput): Promise<Buffer> {
  const id = randomId();
  await conn.query(
    `INSERT INTO inventory_stock_moves (id, product_id, lot_id, quantity, from_location_id, to_location_id, move_type,
       unit_cost_xaf, value_xaf, occurred_at, source_doc_type, source_doc_id, is_reversal, reverses_move_id,
       origin_move_id, origin_seq, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.product ?? refs.productId,
      input.lot === undefined ? refs.lotA : input.lot,
      input.quantity,
      input.from,
      input.to,
      input.type,
      Math.round(input.value / input.quantity),
      input.value,
      T0,
      input.sourceDocType ?? 'SALE',
      randomId(),
      input.reverses ? 1 : 0,
      input.reverses ?? null,
      input.origin ?? null,
      input.seq ?? null,
      refs.admin,
    ],
  );
  return id;
}

/** Vente directe de `quantity` pièces du magasin vers le client, valeur figée `value`. */
function directSale(conn: PoolConnection, refs: Refs, quantity: number, value: number) {
  return insertMove(conn, refs, {
    type: 'SALE',
    from: refs.storeId,
    to: refs.customerId,
    quantity,
    value,
  });
}

/** Confirmation d'une commande : magasin vers « à livrer ». */
function orderSale(conn: PoolConnection, refs: Refs, quantity: number, value: number) {
  return insertMove(conn, refs, {
    type: 'SALE',
    from: refs.storeId,
    to: refs.toDeliverId,
    quantity,
    value,
  });
}

function returnOf(
  conn: PoolConnection,
  refs: Refs,
  origin: Buffer,
  from: Buffer,
  seq: number,
  quantity: number,
  value: number,
  overrides: Partial<MoveInput> = {},
) {
  return insertMove(conn, refs, {
    type: 'CUSTOMER_RETURN',
    from,
    to: refs.storeId,
    quantity,
    value,
    sourceDocType: 'SALE_CANCELLATION',
    origin,
    seq,
    ...overrides,
  });
}

function deliveryOf(
  conn: PoolConnection,
  refs: Refs,
  origin: Buffer,
  seq: number,
  quantity: number,
  value: number,
  overrides: Partial<MoveInput> = {},
) {
  return insertMove(conn, refs, {
    type: 'DELIVERY',
    from: refs.toDeliverId,
    to: refs.customerId,
    quantity,
    value,
    sourceDocType: 'DELIVERY',
    origin,
    seq,
    ...overrides,
  });
}

describe('inventory_stock_moves : mouvements rattachés (INV-STK-17, ADR-029)', () => {
  it('exige une origine pour un retour ou une livraison, et réserve les colonnes à ces types', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const sale = await directSale(conn, refs, 10, 1001);
      await expect(
        insertMove(conn, refs, {
          type: 'CUSTOMER_RETURN',
          from: refs.customerId,
          to: refs.storeId,
          quantity: 2,
          value: 200,
        }),
      ).rejects.toThrow(/ck_inventory_stock_moves_settlement/);
      // Un type ordinaire ne porte pas d'origine (le mouvement respecte le déclencheur, qui
      // s'exécute avant les contraintes : c'est bien le CHECK qui refuse).
      await expect(
        insertMove(conn, refs, {
          type: 'INTERNAL_MOVE',
          from: refs.customerId,
          to: refs.storeId,
          quantity: 1,
          value: 100,
          origin: sale,
          seq: 1,
        }),
      ).rejects.toThrow(/ck_inventory_stock_moves_origin/);
      // Une séquence sans origine est incohérente.
      await expect(
        insertMove(conn, refs, {
          type: 'INTERNAL_MOVE',
          from: refs.storeId,
          to: refs.otherStoreId,
          quantity: 1,
          value: 100,
          seq: 1,
        }),
      ).rejects.toThrow(/ck_inventory_stock_moves_origin/);
    });
  });

  it('vente directe annulée en deux fois : 2 puis 8 sur 1 001 emportent exactement la valeur', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const sale = await directSale(conn, refs, 10, 1001);
      await returnOf(conn, refs, sale, refs.customerId, 1, 2, 200);
      await returnOf(conn, refs, sale, refs.customerId, 2, 8, 801);
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS n, SUM(quantity) AS q, SUM(value_xaf) AS v FROM inventory_stock_moves WHERE origin_move_id = ?`,
        [sale],
      );
      expect(Number(rows[0]!.n)).toBe(2);
      expect(Number(rows[0]!.q)).toBe(10);
      expect(Number(rows[0]!.v)).toBe(1001);
      // Une troisième opération dépasse l'origine, même d'une pièce.
      await expect(returnOf(conn, refs, sale, refs.customerId, 3, 1, 0)).rejects.toThrow(
        /quantité au-delà de l'origine/,
      );
    });
  });

  it('commande : livraison de 4 puis retour des 6 restants depuis « à livrer »', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const sale = await orderSale(conn, refs, 10, 2400);
      await deliveryOf(conn, refs, sale, 1, 4, 960);
      await returnOf(conn, refs, sale, refs.toDeliverId, 2, 6, 1440);
      await expect(deliveryOf(conn, refs, sale, 3, 1, 0)).rejects.toThrow(
        /quantité au-delà de l'origine/,
      );
    });
  });

  it('refuse un dépassement de quantité (11 sur 10) et un dépassement de valeur', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const sale = await directSale(conn, refs, 10, 1000);
      await expect(returnOf(conn, refs, sale, refs.customerId, 1, 11, 1000)).rejects.toThrow(
        /quantité au-delà de l'origine/,
      );
      await expect(returnOf(conn, refs, sale, refs.customerId, 1, 4, 1001)).rejects.toThrow(
        /valeur au-delà de l'origine/,
      );
      // Un retour partiel valide reste possible après ces refus.
      await returnOf(conn, refs, sale, refs.customerId, 1, 4, 400);
      await expect(returnOf(conn, refs, sale, refs.customerId, 2, 7, 600)).rejects.toThrow(
        /quantité au-delà de l'origine/,
      );
    });
  });

  it('exige que le dernier mouvement solde la valeur exacte (aucune dérive de franc)', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const sale = await directSale(conn, refs, 3, 100);
      await returnOf(conn, refs, sale, refs.customerId, 1, 1, 33);
      await returnOf(conn, refs, sale, refs.customerId, 2, 1, 34);
      // 33 + 34 + 32 = 99 ≠ 100 : le reliquat de valeur disparaîtrait.
      await expect(returnOf(conn, refs, sale, refs.customerId, 3, 1, 32)).rejects.toThrow(
        /doit solder la valeur exacte/,
      );
      await returnOf(conn, refs, sale, refs.customerId, 3, 1, 33);
    });
  });

  it('exige la séquence 1, 2, 3 sans trou ni doublon', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const sale = await directSale(conn, refs, 10, 1000);
      await expect(returnOf(conn, refs, sale, refs.customerId, 2, 1, 100)).rejects.toThrow(
        /séquence de rattachement invalide/,
      );
      await returnOf(conn, refs, sale, refs.customerId, 1, 1, 100);
      await expect(returnOf(conn, refs, sale, refs.customerId, 1, 1, 100)).rejects.toThrow(
        /séquence de rattachement invalide/,
      );
      await expect(returnOf(conn, refs, sale, refs.customerId, 3, 1, 100)).rejects.toThrow(
        /séquence de rattachement invalide/,
      );
    });
  });

  it("exige une origine SALE non inverse, même produit, même lot, départ = arrivée de l'origine", async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const sale = await directSale(conn, refs, 10, 1000);
      // Origine qui n'est pas un SALE.
      const internal = await insertMove(conn, refs, {
        type: 'INTERNAL_MOVE',
        from: refs.storeId,
        to: refs.otherStoreId,
        quantity: 5,
        value: 500,
        sourceDocType: 'TRANSFER',
      });
      await expect(
        returnOf(conn, refs, internal, refs.otherStoreId, 1, 1, 100, { to: refs.storeId }),
      ).rejects.toThrow(/l'origine doit être un mouvement SALE non inverse/);
      // Origine inexistante.
      await expect(returnOf(conn, refs, randomId(), refs.customerId, 1, 1, 100)).rejects.toThrow();
      // Autre produit.
      await expect(
        returnOf(conn, refs, sale, refs.customerId, 1, 1, 100, { product: refs.otherProductId }),
      ).rejects.toThrow(/produit ou lot différent de l'origine/);
      // Autre lot, ou lot absent.
      await expect(
        returnOf(conn, refs, sale, refs.customerId, 1, 1, 100, { lot: refs.lotB }),
      ).rejects.toThrow(/produit ou lot différent de l'origine/);
      await expect(
        returnOf(conn, refs, sale, refs.customerId, 1, 1, 100, { lot: null }),
      ).rejects.toThrow(/produit ou lot différent de l'origine/);
      // Départ différent de l'arrivée de l'origine.
      await expect(returnOf(conn, refs, sale, refs.toDeliverId, 1, 1, 100)).rejects.toThrow(
        /départ différent de l'arrivée de l'origine/,
      );
    });
  });

  it("exige qu'un retour revienne au départ de l'origine et qu'une livraison aille de « à livrer » au client", async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const direct = await directSale(conn, refs, 10, 1000);
      await expect(
        returnOf(conn, refs, direct, refs.customerId, 1, 2, 200, { to: refs.otherStoreId }),
      ).rejects.toThrow(/un retour revient au départ de l'origine/);
      // Une livraison sur une vente directe (arrivée V_CUSTOMER) n'a pas de sens.
      await expect(
        deliveryOf(conn, refs, direct, 1, 2, 200, { from: refs.customerId, to: refs.storeId }),
      ).rejects.toThrow(/une livraison va de V_TO_DELIVER vers V_CUSTOMER/);
      const order = await orderSale(conn, refs, 10, 1000);
      // Livraison vers un emplacement qui n'est pas le client.
      await expect(deliveryOf(conn, refs, order, 1, 2, 200, { to: refs.storeId })).rejects.toThrow(
        /une livraison va de V_TO_DELIVER vers V_CUSTOMER/,
      );
      await deliveryOf(conn, refs, order, 1, 2, 200);
    });
  });

  it('interdit d’inverser une vente ou une livraison (reverses_move_id)', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const sale = await directSale(conn, refs, 10, 1000);
      await expect(
        insertMove(conn, refs, {
          type: 'CUSTOMER_RETURN',
          from: refs.customerId,
          to: refs.storeId,
          quantity: 10,
          value: 1000,
          reverses: sale,
          origin: null,
        }),
      ).rejects.toThrow(/une vente, une livraison ou un retour ne s'inverse pas/);
      const order = await orderSale(conn, refs, 10, 1000);
      const delivery = await deliveryOf(conn, refs, order, 1, 4, 400);
      await expect(
        insertMove(conn, refs, {
          type: 'INTERNAL_MOVE',
          from: refs.customerId,
          to: refs.toDeliverId,
          quantity: 4,
          value: 400,
          reverses: delivery,
        }),
      ).rejects.toThrow(/une vente, une livraison ou un retour ne s'inverse pas/);
      // Un retour rattaché ne s'inverse pas non plus : le stock repartirait chez le client alors
      // que la part reste consommée dans le plafond (une revente est un nouveau SALE).
      const direct = await directSale(conn, refs, 10, 1000);
      const returned = await returnOf(conn, refs, direct, refs.customerId, 1, 10, 1000);
      await expect(
        insertMove(conn, refs, {
          type: 'INTERNAL_MOVE',
          from: refs.storeId,
          to: refs.customerId,
          quantity: 10,
          value: 1000,
          sourceDocType: 'TRANSFER',
          reverses: returned,
        }),
      ).rejects.toThrow(/une vente, une livraison ou un retour ne s'inverse pas/);
    });
  });

  it("n'altère pas l'inverse ordinaire des autres types (INV-STK-04 inchangé)", async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const original = await insertMove(conn, refs, {
        type: 'INTERNAL_MOVE',
        from: refs.storeId,
        to: refs.otherStoreId,
        quantity: 5,
        value: 500,
        sourceDocType: 'TRANSFER',
      });
      await insertMove(conn, refs, {
        type: 'INTERNAL_MOVE',
        from: refs.otherStoreId,
        to: refs.storeId,
        quantity: 5,
        value: 500,
        sourceDocType: 'TRANSFER',
        reverses: original,
      });
      // Un seul inverse par mouvement : la garantie d'unicité demeure.
      await expect(
        insertMove(conn, refs, {
          type: 'INTERNAL_MOVE',
          from: refs.otherStoreId,
          to: refs.storeId,
          quantity: 5,
          value: 500,
          sourceDocType: 'TRANSFER',
          reverses: original,
        }),
      ).rejects.toThrow(/uq_inventory_stock_moves_reverses/);
    });
  });

  it('accepte le type et les documents sources de la vente (listes actualisées)', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const order = await orderSale(conn, refs, 2, 200);
      await deliveryOf(conn, refs, order, 1, 1, 100);
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT move_type, source_doc_type, origin_seq FROM inventory_stock_moves WHERE origin_move_id = ?`,
        [order],
      );
      expect(rows[0]).toMatchObject({
        move_type: 'DELIVERY',
        source_doc_type: 'DELIVERY',
        origin_seq: 1,
      });
    });
  });

  it("impose l'emplacement « à livrer » du site de la source (INV-STK-18)", async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      // Un « à livrer » d'un autre site.
      const zoneId = randomId();
      await conn.query(
        `INSERT INTO organization_zones (id, level, code, name, depth, created_by) VALUES (?, 'VILLE', ?, 'Yaoundé', 1, ?)`,
        [zoneId, randomCode('Z'), refs.admin],
      );
      const otherSite = randomId();
      await conn.query(
        `INSERT INTO organization_sites (id, code, name, site_type, zone_id, created_by) VALUES (?, ?, 'Autre', 'MAGASIN', ?, ?)`,
        [otherSite, randomCode('S'), zoneId, refs.admin],
      );
      const otherToDeliver = randomId();
      await conn.query(
        `INSERT INTO organization_locations (id, site_id, code, name, location_type, created_by) VALUES (?, ?, ?, 'À livrer', 'V_TO_DELIVER', ?)`,
        [otherToDeliver, otherSite, randomCode('TD'), refs.admin],
      );
      await expect(
        insertMove(conn, refs, {
          type: 'SALE',
          from: refs.storeId,
          to: otherToDeliver,
          quantity: 5,
          value: 500,
        }),
      ).rejects.toThrow(/« à livrer » doit être celui du site de la source/);
      await orderSale(conn, refs, 5, 500);
    });
  });

  it('lie le type de mouvement et le document source (livraison, annulation de vente)', async () => {
    await withRollback(async (conn) => {
      const refs = await setup(conn);
      const order = await orderSale(conn, refs, 10, 1000);
      // Une livraison porte le document DELIVERY, et inversement.
      await expect(
        deliveryOf(conn, refs, order, 1, 2, 200, { sourceDocType: 'SALE' }),
      ).rejects.toThrow(/ck_inventory_stock_moves_delivery_doc/);
      await expect(
        insertMove(conn, refs, {
          type: 'INTERNAL_MOVE',
          from: refs.storeId,
          to: refs.otherStoreId,
          quantity: 1,
          value: 100,
          sourceDocType: 'DELIVERY',
        }),
      ).rejects.toThrow(/ck_inventory_stock_moves_delivery_doc/);
      // Un document d'annulation de vente ne produit que des retours.
      await expect(
        insertMove(conn, refs, {
          type: 'INTERNAL_MOVE',
          from: refs.storeId,
          to: refs.otherStoreId,
          quantity: 1,
          value: 100,
          sourceDocType: 'SALE_CANCELLATION',
        }),
      ).rejects.toThrow(/ck_inventory_stock_moves_cancellation_doc/);
    });
  });
});
