/**
 * Réconciliation du registre de stock (P2-07 ; stratégie stock §3.1 : « un job quotidien
 * compare la projection au registre (INV-STK-01) et lève `LEDGER_MISMATCH` en cas d'écart » ;
 * dictionnaire `inventory.stock_balances` : « reconstruction complète possible, procédure
 * `rebuild_stock_balances` »).
 *
 * - `verifyStockLedger` : compare, pour chaque (emplacement, produit, lot), le solde projeté
 *   à Σ entrées − Σ sorties du registre (INV-STK-01), et vérifie la conservation par produit
 *   (INV-STK-03 : Σ des soldes sur tous les emplacements, virtuels compris, = 0). Lecture
 *   seule, **dans une transaction** : registre et projection sont lus dans le même instantané
 *   (REPEATABLE READ) — un mouvement valide pendant la vérification est vu des deux côtés ou
 *   d'aucun, jamais d'un seul (sinon faux écart). Agrégation complète du registre — acceptable
 *   au volume P2 (H-06), à restreindre aux (emplacement, produit) touchés depuis la dernière
 *   vérification quand le registre grossira (stratégie stock §10).
 * - `rebuildStockBalances` : remet `qty_on_hand`, `value_xaf` et `last_move_at` de la projection
 *   en accord avec le registre (seule source de vérité, ADR-003), ligne par ligne, et ré-émet le
 *   jeu `stock` pour les emplacements physiques corrigés. Verrouille **d'abord** les soldes, lit
 *   **ensuite** le registre : un mouvement en cours attend le verrou et applique son delta après
 *   la reconstruction, au lieu d'être écrasé par un registre lu trop tôt. `qty_reserved`/
 *   `qty_allocated` ne viennent pas du registre (réservations, allocations : P5), non touchés.
 *
 * Les deux acceptent une portée facultative par produits (`productIds`) : réparation ciblée
 * après analyse d'un écart, sans verrouiller toute la projection.
 */
import { sql, type RawBuilder, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { recordChanges } from '../../../../platform/sync/change-feed.js';
import { stockBalanceChange } from '../sync-changes.js';

/** Tolérance d'égalité des quantités `numeric(14,3)` (un demi-millième). */
const QTY_EPSILON = 0.0005;

export interface LedgerScope {
  /** Produits vérifiés ou reconstruits ; tous si absent. */
  readonly productIds?: readonly string[];
}

export interface LedgerMismatch {
  readonly locationId: string;
  readonly productId: string;
  /** `null` pour un solde sans lot (clé UUID nulle). */
  readonly lotId: string | null;
  readonly projectedQty: number;
  readonly ledgerQty: number;
}

export interface ConservationBreach {
  readonly productId: string;
  readonly totalQty: number;
}

export interface LedgerVerification {
  readonly ok: boolean;
  readonly balancesChecked: number;
  readonly mismatches: readonly LedgerMismatch[];
  readonly conservationBreaches: readonly ConservationBreach[];
}

interface LedgerRow {
  readonly location_id: Buffer;
  readonly product_id: Buffer;
  readonly lot_key: Buffer;
  readonly qty: string;
  readonly value_xaf: string;
  readonly last_move_at: Date | null;
}

interface BalanceRow {
  readonly locationId: Buffer;
  readonly productId: Buffer;
  readonly lotKey: Buffer;
  readonly qty: number;
  readonly value: number;
}

const LOT_KEY_NULL = Buffer.alloc(16);

function keyOf(locationId: Buffer, productId: Buffer, lotKey: Buffer): string {
  return `${locationId.toString('hex')}|${productId.toString('hex')}|${lotKey.toString('hex')}`;
}

function productFilter(scope: LedgerScope): RawBuilder<unknown> {
  if (scope.productIds === undefined) return sql``;
  if (scope.productIds.length === 0) return sql`WHERE FALSE`;
  return sql`WHERE product_id IN (${sql.join(scope.productIds.map((id) => toBin(id)))})`;
}

/** Σ signée du registre par (emplacement, produit, lot) — même clé que `stock_balances`. */
async function ledgerTotals(
  trx: Transaction<DB>,
  scope: LedgerScope,
): Promise<readonly LedgerRow[]> {
  const filter = productFilter(scope);
  const result = await sql<LedgerRow>`
    SELECT location_id, product_id, lot_key,
           SUM(delta) AS qty, SUM(value_delta) AS value_xaf, MAX(occurred_at) AS last_move_at
    FROM (
      SELECT to_location_id AS location_id, product_id,
             COALESCE(lot_id, ${LOT_KEY_NULL}) AS lot_key,
             quantity AS delta, value_xaf AS value_delta, occurred_at
      FROM inventory_stock_moves ${filter}
      UNION ALL
      SELECT from_location_id AS location_id, product_id,
             COALESCE(lot_id, ${LOT_KEY_NULL}) AS lot_key,
             -quantity AS delta, -value_xaf AS value_delta, occurred_at
      FROM inventory_stock_moves ${filter}
    ) AS ledger
    GROUP BY location_id, product_id, lot_key
  `.execute(trx);
  return result.rows;
}

async function projectedBalances(
  trx: Transaction<DB>,
  scope: LedgerScope,
  lock: boolean,
): Promise<readonly BalanceRow[]> {
  const rows = await trx
    .selectFrom('inventory_stock_balances')
    .select(['location_id', 'product_id', 'lot_key', 'qty_on_hand', 'value_xaf'])
    .$if(scope.productIds !== undefined, (qb) =>
      scope.productIds!.length === 0
        ? qb.where(sql<boolean>`FALSE`)
        : qb.where(
            'product_id',
            'in',
            scope.productIds!.map((id) => toBin(id)),
          ),
    )
    .$if(lock, (qb) => qb.forUpdate())
    .execute();
  return rows.map((row) => ({
    locationId: row.location_id,
    productId: row.product_id,
    lotKey: row.lot_key,
    qty: Number(row.qty_on_hand),
    value: Number(row.value_xaf),
  }));
}

export async function verifyStockLedger(
  trx: Transaction<DB>,
  scope: LedgerScope = {},
): Promise<LedgerVerification> {
  const ledger = new Map<string, LedgerRow>();
  for (const row of await ledgerTotals(trx, scope)) {
    ledger.set(keyOf(row.location_id, row.product_id, row.lot_key), row);
  }
  const balances = await projectedBalances(trx, scope, false);

  const mismatches: LedgerMismatch[] = [];
  const seen = new Set<string>();
  const totalByProduct = new Map<string, { productId: Buffer; total: number }>();
  for (const balance of balances) {
    const key = keyOf(balance.locationId, balance.productId, balance.lotKey);
    seen.add(key);
    const ledgerQty = Number(ledger.get(key)?.qty ?? 0);
    if (Math.abs(balance.qty - ledgerQty) > QTY_EPSILON) {
      mismatches.push(
        mismatchOf(balance.locationId, balance.productId, balance.lotKey, balance.qty, ledgerQty),
      );
    }
    const productKey = balance.productId.toString('hex');
    const running = totalByProduct.get(productKey) ?? { productId: balance.productId, total: 0 };
    running.total += balance.qty;
    totalByProduct.set(productKey, running);
  }
  // Registre sans ligne de projection (solde jamais créé) : écart si non nul.
  for (const [key, row] of ledger) {
    if (seen.has(key)) continue;
    const ledgerQty = Number(row.qty);
    if (Math.abs(ledgerQty) > QTY_EPSILON) {
      mismatches.push(mismatchOf(row.location_id, row.product_id, row.lot_key, 0, ledgerQty));
    }
  }

  const conservationBreaches = [...totalByProduct.values()]
    .map(({ productId, total }) => ({ productId, total: Math.round(total * 1000) / 1000 }))
    .filter(({ total }) => Math.abs(total) > QTY_EPSILON)
    .map(({ productId, total }) => ({ productId: fromBin(productId), totalQty: total }));

  return {
    ok: mismatches.length === 0 && conservationBreaches.length === 0,
    balancesChecked: balances.length,
    mismatches,
    conservationBreaches,
  };
}

function mismatchOf(
  locationId: Buffer,
  productId: Buffer,
  lotKey: Buffer,
  projectedQty: number,
  ledgerQty: number,
): LedgerMismatch {
  return {
    locationId: fromBin(locationId),
    productId: fromBin(productId),
    lotId: lotKey.equals(LOT_KEY_NULL) ? null : fromBin(lotKey),
    projectedQty,
    ledgerQty,
  };
}

/**
 * Reconstruit la projection depuis le registre (procédure de maintenance, jamais appelée par une
 * commande) : corrige chaque ligne en écart, crée celles qui manquent. Renvoie le nombre de
 * lignes corrigées. Une reconstruction complète (sans `productIds`) verrouille toute la
 * projection le temps de la transaction : à lancer hors activité, les commandes concurrentes
 * pouvant sinon attendre ou repartir en `RETRY_LATER`.
 */
export async function rebuildStockBalances(
  uow: Transaction<DB>,
  scope: LedgerScope = {},
): Promise<number> {
  const current = new Map<string, BalanceRow>();
  for (const row of await projectedBalances(uow, scope, true)) {
    current.set(keyOf(row.locationId, row.productId, row.lotKey), row);
  }
  const ledger = await ledgerTotals(uow, scope);
  const ledgerKeys = new Set(
    ledger.map((row) => keyOf(row.location_id, row.product_id, row.lot_key)),
  );

  const physical = new Set(
    (
      await uow
        .selectFrom('organization_locations')
        .select('id')
        .where('is_virtual', '=', 0)
        .execute()
    ).map((row) => row.id.toString('hex')),
  );

  let corrected = 0;
  for (const row of ledger) {
    const key = keyOf(row.location_id, row.product_id, row.lot_key);
    const ledgerQty = Number(row.qty);
    const ledgerValue = Number(row.value_xaf);
    const existing = current.get(key);
    if (
      existing &&
      Math.abs(existing.qty - ledgerQty) <= QTY_EPSILON &&
      existing.value === ledgerValue
    ) {
      continue;
    }
    await uow
      .insertInto('inventory_stock_balances')
      .values({
        location_id: row.location_id,
        product_id: row.product_id,
        lot_key: row.lot_key,
        qty_on_hand: String(ledgerQty),
        value_xaf: ledgerValue,
        last_move_at: row.last_move_at,
        row_version: 1,
      })
      .onDuplicateKeyUpdate({
        qty_on_hand: String(ledgerQty),
        value_xaf: ledgerValue,
        last_move_at: row.last_move_at,
        row_version: sql`row_version + 1`,
      })
      .execute();
    corrected++;
    if (physical.has(row.location_id.toString('hex'))) {
      await recordChanges(uow, [
        stockBalanceChange(fromBin(row.location_id), fromBin(row.product_id)),
      ]);
    }
  }

  // Ligne de projection sans aucun mouvement au registre : son solde vrai est nul.
  for (const [key, balance] of current) {
    if (ledgerKeys.has(key) || (Math.abs(balance.qty) <= QTY_EPSILON && balance.value === 0)) {
      continue;
    }
    await uow
      .updateTable('inventory_stock_balances')
      .set({ qty_on_hand: '0', value_xaf: 0, row_version: sql`row_version + 1` })
      .where('location_id', '=', balance.locationId)
      .where('product_id', '=', balance.productId)
      .where('lot_key', '=', balance.lotKey)
      .execute();
    corrected++;
    if (physical.has(balance.locationId.toString('hex'))) {
      await recordChanges(uow, [
        stockBalanceChange(fromBin(balance.locationId), fromBin(balance.productId)),
      ]);
    }
  }
  return corrected;
}
