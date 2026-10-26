/**
 * Données d'amorce des essais des vues de stock, de production et d'achats (P9-13) : des **copies** de lignes
 * réelles, dans l'état voulu, insérées dans la transaction de l'essai (`snapshot`, toujours annulée) — voir
 * `analytics-view-seeds.ts`, dont ce fichier réutilise les assistants.
 */
import { sql } from 'kysely';
import { fromBin } from '../src/platform/kysely/uuid-columns.js';
import { freshUuid } from './helpers.js';
import { atDay, firstRow, insertCopy, newId, type Row, type Trx } from './analytics-view-seeds.js';

export interface SeededBalance {
  readonly locationId: string;
  readonly custodyMode: string | null;
}

/**
 * Un solde réservé et alloué sur un emplacement de chaque mode de garde — exclusive par utilisateur, exclusive par
 * appareil (un emplacement partagé converti dans la transaction, avec un appareil désigné), partagée : les soldes
 * de la base d'essai n'ont ni réservé ni alloué (ADR-033) et aucun emplacement à garde par appareil.
 * Modifie la projection et l'emplacement dans la transaction de l'essai.
 */
export async function seedReservedBalances(trx: Trx): Promise<readonly SeededBalance[]> {
  const seeded: SeededBalance[] = [];
  const pick = (mode: 'EXCLUSIVE_USER' | 'SHARED') =>
    firstRow(
      trx,
      sql`SELECT b.location_id, b.product_id, b.lot_key, l.custody_mode
            FROM inventory_stock_balances b JOIN organization_locations l ON l.id = b.location_id
           WHERE l.custody_mode = ${mode} AND b.qty_on_hand > 5 AND l.is_virtual = 0
           ORDER BY b.location_id, b.product_id, b.lot_key LIMIT 1`,
    );
  const reserve = async (found: Awaited<ReturnType<typeof pick>>, custodyMode: string) => {
    if (!found) return;
    await sql`UPDATE inventory_stock_balances SET qty_reserved = 1, qty_allocated = 2
               WHERE location_id = ${found.location_id} AND product_id = ${found.product_id}
                 AND lot_key = ${found.lot_key}`.execute(trx);
    seeded.push({ locationId: fromBin(found.location_id as Buffer), custodyMode });
  };
  await reserve(await pick('EXCLUSIVE_USER'), 'EXCLUSIVE_USER');
  // Garde par appareil : un emplacement partagé converti, avec un appareil désigné (contrainte de la table).
  const converted = await pick('SHARED');
  if (converted) {
    await sql`UPDATE organization_locations
                 SET custody_mode = 'EXCLUSIVE_DEVICE',
                     designated_device_id = (SELECT id FROM identity_devices ORDER BY id LIMIT 1)
               WHERE id = ${converted.location_id}`.execute(trx);
    await reserve(converted, 'EXCLUSIVE_DEVICE');
  }
  await reserve(await pick('SHARED'), 'SHARED');
  return seeded;
}

export interface SeededVirtualBalance {
  readonly locationId: string;
  readonly locationType: string;
  readonly productId: string;
}

/** Types d'emplacement virtuel qui ne sont que la source ou le puits d'un mouvement : sans stock, hors de la vue. */
export const VIRTUAL_SINK_TYPES = ['V_SUPPLIER', 'V_LOSS', 'V_CUSTOMER'] as const;
/** Types d'emplacement virtuel qui portent du stock (transit, pertes en attente, vendu à livrer). */
export const VIRTUAL_STOCK_TYPES = ['V_TRANSIT', 'V_PENDING_LOSS', 'V_TO_DELIVER'] as const;

/**
 * Un solde de 7 sur un emplacement de chaque type virtuel (les trois qui portent du stock et trois sources ou
 * puits) et un solde entièrement à zéro sur un emplacement physique : la base d'essai peut n'en porter aucun.
 * Les soldes sont insérés ou fixés dans la transaction de l'essai ; `zeroBalance` est la ligne à zéro.
 */
export async function seedVirtualBalances(trx: Trx): Promise<{
  readonly virtual: readonly SeededVirtualBalance[];
  readonly zeroBalance: SeededVirtualBalance | undefined;
  readonly reservedOnly: SeededVirtualBalance | undefined;
  readonly allocatedOnly: SeededVirtualBalance | undefined;
}> {
  const product = await firstRow(trx, sql`SELECT id FROM catalog_products ORDER BY id LIMIT 1`);
  if (!product) {
    return {
      virtual: [],
      zeroBalance: undefined,
      reservedOnly: undefined,
      allocatedOnly: undefined,
    };
  }
  const productId = fromBin(product.id as Buffer);
  const noLot = sql`UNHEX('00000000000000000000000000000000')`;
  const virtual: SeededVirtualBalance[] = [];
  for (const locationType of [...VIRTUAL_STOCK_TYPES, ...VIRTUAL_SINK_TYPES]) {
    const location = await firstRow(
      trx,
      sql`SELECT id FROM organization_locations WHERE location_type = ${locationType} ORDER BY id LIMIT 1`,
    );
    if (!location) continue;
    await sql`INSERT INTO inventory_stock_balances
                (location_id, product_id, lot_key, qty_on_hand, qty_reserved, qty_allocated, last_move_at)
              VALUES (${location.id}, ${product.id}, ${noLot}, 7, 0, 0, UTC_TIMESTAMP(6))
              ON DUPLICATE KEY UPDATE qty_on_hand = 7, qty_reserved = 0, qty_allocated = 0`.execute(
      trx,
    );
    virtual.push({ locationId: fromBin(location.id as Buffer), locationType, productId });
  }
  const store = await firstRow(
    trx,
    sql`SELECT l.id FROM organization_locations l
         WHERE l.location_type = 'STORE' AND l.is_virtual = 0
           AND NOT EXISTS (SELECT 1 FROM inventory_stock_balances b
                            WHERE b.location_id = l.id AND b.product_id = ${product.id})
         ORDER BY l.id LIMIT 1`,
  );
  let zeroBalance: SeededVirtualBalance | undefined;
  if (store) {
    await sql`INSERT INTO inventory_stock_balances
                (location_id, product_id, lot_key, qty_on_hand, qty_reserved, qty_allocated, last_move_at)
              VALUES (${store.id}, ${product.id}, ${noLot}, 0, 0, 0, UTC_TIMESTAMP(6))`.execute(
      trx,
    );
    zeroBalance = { locationId: fromBin(store.id as Buffer), locationType: 'STORE', productId };
  }
  // Un solde sans stock mais réservé et alloué reste une ligne de `GET /stock` : il n'est pas omis.
  const others = (
    await sql<Row>`SELECT id FROM catalog_products WHERE id <> ${product.id} ORDER BY id LIMIT 2`.execute(
      trx,
    )
  ).rows;
  const insertAt = async (other: Row | undefined, reserved: number, allocated: number) => {
    if (!store || !other) return undefined;
    await sql`INSERT INTO inventory_stock_balances
                (location_id, product_id, lot_key, qty_on_hand, qty_reserved, qty_allocated, last_move_at)
              VALUES (${store.id}, ${other.id}, ${noLot}, 0, ${reserved}, ${allocated}, UTC_TIMESTAMP(6))
              ON DUPLICATE KEY UPDATE qty_on_hand = 0, qty_reserved = ${reserved}, qty_allocated = ${allocated}`.execute(
      trx,
    );
    return {
      locationId: fromBin(store.id as Buffer),
      locationType: 'STORE',
      productId: fromBin(other.id as Buffer),
    };
  };
  const reservedOnly = await insertAt(others[0], 1, 0);
  const allocatedOnly = await insertAt(others[1], 0, 2);
  return { virtual, zeroBalance, reservedOnly, allocatedOnly };
}

/**
 * Copies d'une déclaration de perte de mortalité d'un lot de production, le `day` donné, une par spécification
 * (statut, catégorie, quantité) ; la catégorie `CASSE` sert de contre-exemple (même lot, pas de la mortalité).
 * Rend le lot de production, `undefined` sans modèle.
 */
export async function cloneLossDeclarations(
  trx: Trx,
  day: string,
  specs: ReadonlyArray<{ status: string; category: string; quantity: number }>,
): Promise<string | undefined> {
  const source = await firstRow(
    trx,
    sql`SELECT * FROM inventory_loss_declarations
         WHERE category = 'MORTALITE' AND production_lot_id IS NOT NULL AND status = 'RECORDED' ORDER BY id LIMIT 1`,
  );
  if (!source) return undefined;
  for (const spec of specs) {
    await insertCopy(trx, 'inventory_loss_declarations', source, {
      id: newId(),
      doc_number: `AV-${freshUuid()}`,
      command_id: null,
      local_ref: null,
      status: spec.status,
      category: spec.category,
      comment: spec.category === 'MORTALITE' ? source.comment : 'copie',
      quantity: spec.quantity,
      quantity_base: spec.quantity,
      value_xaf: spec.quantity * 100,
      occurred_at: atDay(day),
    });
  }
  return fromBin(source.production_lot_id as Buffer);
}

/** Des consommations d'un lot de production, le `day` donné, une par spécification (statut, nature, quantité). */
export async function cloneConsumptions(
  trx: Trx,
  day: string,
  specs: ReadonlyArray<{ status: string; costType: string; quantity: number }>,
): Promise<string | undefined> {
  const source = await firstRow(
    trx,
    sql`SELECT * FROM inventory_consumptions
         WHERE cost_object_type = 'PRODUCTION_LOT' AND cost_type = 'ALIMENT' AND status = 'RECORDED' ORDER BY id LIMIT 1`,
  );
  if (!source) return undefined;
  for (const spec of specs) {
    await insertCopy(trx, 'inventory_consumptions', source, {
      id: newId(),
      command_id: null,
      status: spec.status,
      cost_type: spec.costType,
      quantity: spec.quantity,
      quantity_base: spec.quantity,
      value_xaf: spec.quantity * 100,
      occurred_at: atDay(day),
      ...(spec.status === 'CANCELLED'
        ? { cancelled_at: atDay(day), cancelled_by: source.created_by }
        : {}),
    });
  }
  return fromBin(source.cost_object_id as Buffer);
}

/** Des collectes d'œufs d'un lot, le `day` donné, une par spécification (statut, œufs collectés tous commercialisables). */
export async function cloneEggCollections(
  trx: Trx,
  day: string,
  specs: ReadonlyArray<{ status: string; collected: number }>,
): Promise<string | undefined> {
  const source = await firstRow(
    trx,
    sql`SELECT * FROM production_egg_collections WHERE status = 'RECORDED' ORDER BY id LIMIT 1`,
  );
  if (!source) return undefined;
  const stockLot = await firstRow(
    trx,
    sql`SELECT * FROM inventory_stock_lots WHERE id = ${source.stock_lot_id}`,
  );
  if (!stockLot) return undefined;
  for (const spec of specs) {
    // Chaque collecte a son lot de stock (unicité) : copie du lot de la collecte modèle.
    const lotId = newId();
    await insertCopy(trx, 'inventory_stock_lots', stockLot, {
      id: lotId,
      lot_code: `AV-${freshUuid()}`,
      supplier_lot_ref: null,
    });
    await insertCopy(trx, 'production_egg_collections', source, {
      id: newId(),
      doc_number: `AV-${freshUuid()}`,
      command_id: null,
      stock_lot_id: lotId,
      status: spec.status,
      collected_qty: spec.collected,
      marketable_qty: spec.collected,
      broken_qty: 0,
      nonconforming_qty: 0,
      hatching_qty: 0,
      hatching_product_id: null,
      collection_date: new Date(`${day}T00:00:00.000Z`),
      occurred_at: atDay(day),
      ...(spec.status === 'CANCELLED'
        ? { cancelled_at: atDay(day), cancelled_by: source.created_by }
        : {}),
    });
  }
  return fromBin(source.production_lot_id as Buffer);
}

export interface ClonedReceipts {
  readonly productId: string;
  readonly orderId: string;
}

/** Des réceptions d'un bon de commande, le `day` donné, une par spécification (statut, quantité livrée d'une ligne). */
export async function cloneReceipts(
  trx: Trx,
  day: string,
  specs: ReadonlyArray<{ status: string; delivered: number }>,
): Promise<ClonedReceipts | undefined> {
  const receipt = await firstRow(
    trx,
    sql`SELECT r.* FROM procurement_goods_receipts r
         WHERE r.status = 'POSTED' AND r.purchase_order_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM procurement_goods_receipt_lines l WHERE l.receipt_id = r.id) ORDER BY r.id LIMIT 1`,
  );
  if (!receipt) return undefined;
  const line = await firstRow(
    trx,
    sql`SELECT * FROM procurement_goods_receipt_lines WHERE receipt_id = ${receipt.id} ORDER BY id LIMIT 1`,
  );
  if (!line) return undefined;
  for (const spec of specs) {
    const id = newId();
    await insertCopy(trx, 'procurement_goods_receipts', receipt, {
      id,
      doc_number: `AV-${freshUuid()}`,
      command_id: null,
      local_ref: null,
      supplier_delivery_note_ref: `AV-${freshUuid().slice(-12)}`,
      status: spec.status,
      occurred_at: atDay(day),
      ...(spec.status === 'CANCELLED'
        ? { cancelled_at: atDay(day), cancelled_by: receipt.created_by }
        : {}),
    });
    await insertCopy(trx, 'procurement_goods_receipt_lines', line, {
      id: newId(),
      receipt_id: id,
      qty_delivered_base: spec.delivered,
      qty_rejected_base: 0,
      over_receipt_qty_base: 0,
      rejection_reason_code_id: null,
      stock_lot_id: null,
    });
  }
  return {
    productId: fromBin(line.product_id as Buffer),
    orderId: fromBin(receipt.purchase_order_id as Buffer),
  };
}

/**
 * Une ligne de plus, d'un produit que le bon ne commande pas encore (le `nth`-ième, pour des copies de produits
 * distincts) et d'un autre montant (statut au choix), sur un bon de commande engagé.
 */
export async function cloneOrderLine(
  trx: Trx,
  lineStatus = 'OPEN',
  nth = 0,
): Promise<{ orderId: string; productId: string; lineTotalXaf: number } | undefined> {
  const line = await firstRow(
    trx,
    sql`SELECT l.* FROM procurement_purchase_order_lines l
          JOIN procurement_purchase_orders o ON o.id = l.order_id
         WHERE o.status NOT IN ('DRAFT', 'PENDING_APPROVAL', 'CANCELLED') ORDER BY l.id LIMIT 1`,
  );
  if (!line) return undefined;
  const product = await firstRow(
    trx,
    sql`SELECT id FROM catalog_products
         WHERE id NOT IN (SELECT product_id FROM procurement_purchase_order_lines WHERE order_id = ${line.order_id})
         ORDER BY id LIMIT 1 OFFSET ${nth}`,
  );
  if (!product) return undefined;
  const next = await firstRow(
    trx,
    sql`SELECT MAX(line_no) + 1 AS next FROM procurement_purchase_order_lines WHERE order_id = ${line.order_id}`,
  );
  await insertCopy(trx, 'procurement_purchase_order_lines', line, {
    id: newId(),
    line_no: Number(next!.next),
    product_id: product.id,
    request_line_id: null,
    ordered_qty_base: 3,
    unit_price_xaf: 7_000,
    line_total_xaf: 21_000,
    accepted_qty_base: 0,
    closed_qty_base: 0,
    excess_qty_base: 0,
    invoiced_qty_base: 0,
    status: lineStatus,
  });
  return {
    orderId: fromBin(line.order_id as Buffer),
    productId: fromBin(product.id as Buffer),
    lineTotalXaf: 21_000,
  };
}

/**
 * Une copie d'un bon de commande engagé, dans le statut demandé, avec une copie de sa première ligne ;
 * `overrides` fixe d'autres colonnes du bon (dates de création et d'approbation par exemple).
 */
export async function cloneOrderWithStatus(
  trx: Trx,
  status: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<{ orderId: string; productId: string } | undefined> {
  const order = await firstRow(
    trx,
    sql`SELECT o.* FROM procurement_purchase_orders o
         WHERE o.status IN ('APPROVED', 'SENT', 'PARTIALLY_RECEIVED')
           AND EXISTS (SELECT 1 FROM procurement_purchase_order_lines l WHERE l.order_id = o.id)
         ORDER BY o.id LIMIT 1`,
  );
  if (!order) return undefined;
  const line = await firstRow(
    trx,
    sql`SELECT * FROM procurement_purchase_order_lines WHERE order_id = ${order.id} ORDER BY id LIMIT 1`,
  );
  if (!line) return undefined;
  const id = newId();
  await insertCopy(trx, 'procurement_purchase_orders', order, {
    id,
    doc_number: `AV-${freshUuid()}`,
    command_id: null,
    local_ref: null,
    status,
    ...(status === 'CANCELLED'
      ? { cancelled_at: order.occurred_at, cancelled_by: order.created_by }
      : {}),
    ...overrides,
  });
  await insertCopy(trx, 'procurement_purchase_order_lines', line, {
    id: newId(),
    order_id: id,
    request_line_id: null,
    accepted_qty_base: 0,
    closed_qty_base: 0,
    excess_qty_base: 0,
    invoiced_qty_base: 0,
    status: 'OPEN',
  });
  return { orderId: fromBin(id), productId: fromBin(line.product_id as Buffer) };
}

/**
 * Un mouvement de trésorerie copié sur un compte sans titulaire (caisse de PDV, compte central…), le `day` donné.
 * Rend le mouvement et le responsable du compte.
 */
export async function cloneCashMovementOnHolderlessAccount(
  trx: Trx,
  day: string,
): Promise<{ movementId: string; responsibleUserId: string } | undefined> {
  const account = await firstRow(
    trx,
    sql`SELECT id, responsible_user_id FROM finance_cash_accounts
         WHERE holder_user_id IS NULL ORDER BY id LIMIT 1`,
  );
  if (!account) return undefined;
  const movement = await firstRow(
    trx,
    sql`SELECT * FROM finance_cash_movements WHERE reverses_movement_id IS NULL ORDER BY id LIMIT 1`,
  );
  if (!movement) return undefined;
  const id = newId();
  await insertCopy(trx, 'finance_cash_movements', movement, {
    id,
    command_id: null,
    reverses_movement_id: null,
    cash_account_id: account.id,
    occurred_at: atDay(day),
  });
  return {
    movementId: fromBin(id),
    responsibleUserId: fromBin(account.responsible_user_id as Buffer),
  };
}
