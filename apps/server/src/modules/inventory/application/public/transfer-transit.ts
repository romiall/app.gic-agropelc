/**
 * Transit des transferts (P5-16 ; INV-STK-08, BR-STK-024 ; stratégie stock §6). `V_TRANSIT` est un
 * emplacement virtuel unique (une ligne de solde par produit et par lot, tous transferts confondus) :
 * le transit d'un transfert se lit donc **par document**, sur les mouvements dont il est la source
 * (`source_doc_type = 'TRANSFER'`). Lecture seule.
 *
 * - `transferTransit` : transit net d'un document, par (produit, lot), en quantité et en valeur ;
 * - `pairTransit` : transit net de la paire (source, destination), par produit, tous documents de la
 *   paire confondus (expéditions en route, réceptions sans document non rapprochées : négatif) ;
 * - `verifyTransferTransit` : INV-STK-08 sur les transferts clos — transit net nul par (document,
 *   produit), sauf l'excédent reçu au-delà de l'expédié (BR-STK-021) ; lignes retournées = expédiées
 *   pour un transfert `RETURNED`, nulles sinon. Relu par la réconciliation quotidienne ; volontairement
 *   hors de `verifyStockLedger`, que de nombreux tests appellent sur toute la base.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

/** Tolérance d'égalité des quantités `numeric(14,3)` (un demi-millième). */
const QTY_EPSILON = 0.0005;

export interface TransitLine {
  readonly productId: string;
  readonly lotId: string | null;
  readonly qty: number;
  readonly valueXaf: number;
}

/** `V_TRANSIT` (une seule ligne, seed) ; lu par l'exécuteur donné (connexion ou transaction). */
async function transitLocation(executor: Executor): Promise<Buffer> {
  const row = await executor
    .selectFrom('organization_locations')
    .select('id')
    .where('location_type', '=', 'V_TRANSIT')
    .executeTakeFirstOrThrow();
  return row.id;
}

const netQty = (transit: Buffer) =>
  sql<string>`COALESCE(SUM(CASE WHEN m.to_location_id = ${transit} THEN m.quantity
                                WHEN m.from_location_id = ${transit} THEN -m.quantity
                                ELSE 0 END), 0)`;
const netValue = (transit: Buffer) =>
  sql<string>`COALESCE(SUM(CASE WHEN m.to_location_id = ${transit} THEN m.value_xaf
                                WHEN m.from_location_id = ${transit} THEN -m.value_xaf
                                ELSE 0 END), 0)`;

/** Transit net d'un document de transfert par (produit, lot) ; lignes nulles omises. */
export async function transferTransit(
  executor: Executor,
  transferId: string,
): Promise<readonly TransitLine[]> {
  const transit = await transitLocation(executor);
  const rows = await executor
    .selectFrom('inventory_stock_moves as m')
    .select(['m.product_id', 'm.lot_id', netQty(transit).as('qty'), netValue(transit).as('value')])
    .where('m.source_doc_type', '=', 'TRANSFER')
    .where('m.source_doc_id', '=', toBin(transferId))
    .groupBy(['m.product_id', 'm.lot_id'])
    .execute();
  return rows
    .map((row) => ({
      productId: fromBin(row.product_id),
      lotId: fromBinOrNull(row.lot_id),
      qty: Number(row.qty),
      valueXaf: Number(row.value),
    }))
    .filter((line) => Math.abs(line.qty) > QTY_EPSILON || line.valueXaf !== 0);
}

/** Transit net de la paire (source, destination), par produit ; produits à zéro omis. */
export async function pairTransit(
  executor: Executor,
  pair: {
    readonly fromLocationId: string;
    readonly toLocationId: string;
    readonly productId?: string;
  },
): Promise<ReadonlyMap<string, number>> {
  const transit = await transitLocation(executor);
  const rows = await executor
    .selectFrom('inventory_stock_moves as m')
    .innerJoin('inventory_stock_transfers as t', 't.id', 'm.source_doc_id')
    .select(['m.product_id', netQty(transit).as('qty')])
    .where('m.source_doc_type', '=', 'TRANSFER')
    .where('t.from_location_id', '=', toBin(pair.fromLocationId))
    .where('t.to_location_id', '=', toBin(pair.toLocationId))
    .$if(pair.productId !== undefined, (qb) =>
      qb.where('m.product_id', '=', toBin(pair.productId!)),
    )
    .groupBy('m.product_id')
    .execute();
  const result = new Map<string, number>();
  for (const row of rows) {
    const qty = Number(row.qty);
    if (Math.abs(qty) > QTY_EPSILON) result.set(fromBin(row.product_id), qty);
  }
  return result;
}

export interface TransferTransitBreach {
  readonly transferId: string;
  readonly productId: string | null;
  readonly reason: 'TRANSIT_NOT_SETTLED' | 'RETURNED_QTY_MISMATCH';
  readonly expectedQty: number;
  readonly actualQty: number;
}

export interface TransferTransitVerification {
  readonly ok: boolean;
  readonly transfersChecked: number;
  readonly breaches: readonly TransferTransitBreach[];
}

/** Statuts d'un transfert clos : son transit doit être soldé (INV-STK-08). */
const SETTLED_STATUSES = ['RECEIVED', 'DISCREPANCY_PENDING', 'CLOSED', 'RETURNED', 'MATCHED'];

/**
 * INV-STK-08 (TX + JOB) : pour chaque transfert `STANDARD` clos (reçu, en écart, clos, retourné) et
 * chaque réception sans document rapprochée, transit net par produit = −excédent reçu au-delà de
 * l'expédié (0 sans excédent) ; lignes d'un transfert `RETURNED` : retourné = expédié ; autres :
 * retourné = 0. `transferIds` restreint la vérification (tests sur la base partagée).
 */
export async function verifyTransferTransit(
  executor: Executor,
  scope: { readonly transferIds?: readonly string[] } = {},
): Promise<TransferTransitVerification> {
  if (scope.transferIds !== undefined && scope.transferIds.length === 0) {
    return { ok: true, transfersChecked: 0, breaches: [] };
  }
  const transit = await transitLocation(executor);
  const ids = scope.transferIds?.map((id) => toBin(id));
  const transfers = await executor
    .selectFrom('inventory_stock_transfers')
    .select(['id', 'status'])
    .where('status', 'in', SETTLED_STATUSES)
    .where('transfer_kind', 'in', ['STANDARD', 'BLIND_RECEIPT'])
    .$if(ids !== undefined, (qb) => qb.where('id', 'in', ids!))
    .execute();
  if (transfers.length === 0) return { ok: true, transfersChecked: 0, breaches: [] };
  const settled = new Map(transfers.map((t) => [fromBin(t.id), t.status]));

  const moves = await executor
    .selectFrom('inventory_stock_moves as m')
    .innerJoin('inventory_stock_transfers as t', 't.id', 'm.source_doc_id')
    .select(['m.source_doc_id', 'm.product_id', netQty(transit).as('qty')])
    .where('m.source_doc_type', '=', 'TRANSFER')
    .where('t.status', 'in', SETTLED_STATUSES)
    .where('t.transfer_kind', 'in', ['STANDARD', 'BLIND_RECEIPT'])
    .$if(ids !== undefined, (qb) => qb.where('t.id', 'in', ids!))
    .groupBy(['m.source_doc_id', 'm.product_id'])
    .execute();
  const lines = await executor
    .selectFrom('inventory_stock_transfer_lines as l')
    .innerJoin('inventory_stock_transfers as t', 't.id', 'l.transfer_id')
    .select([
      'l.transfer_id',
      'l.product_id',
      'l.dispatched_qty_base',
      'l.received_qty_base',
      'l.returned_qty_base',
      't.status',
      't.transfer_kind',
    ])
    .where('t.status', 'in', SETTLED_STATUSES)
    .where('t.transfer_kind', '=', 'STANDARD')
    .$if(ids !== undefined, (qb) => qb.where('t.id', 'in', ids!))
    .execute();

  const breaches: TransferTransitBreach[] = [];
  const expected = new Map<string, number>();
  const key = (transferId: string, productId: string) => `${transferId}|${productId}`;
  for (const line of lines) {
    const transferId = fromBin(line.transfer_id);
    const productId = fromBin(line.product_id);
    const dispatched = line.dispatched_qty_base === null ? 0 : Number(line.dispatched_qty_base);
    const received = line.received_qty_base === null ? 0 : Number(line.received_qty_base);
    const returned = Number(line.returned_qty_base);
    const excess = Math.max(0, received - dispatched);
    const k = key(transferId, productId);
    expected.set(k, (expected.get(k) ?? 0) - excess);
    const expectedReturned = line.status === 'RETURNED' ? dispatched : 0;
    if (Math.abs(returned - expectedReturned) > QTY_EPSILON) {
      breaches.push({
        transferId,
        productId,
        reason: 'RETURNED_QTY_MISMATCH',
        expectedQty: expectedReturned,
        actualQty: returned,
      });
    }
  }
  const actual = new Map<string, number>();
  for (const row of moves) {
    actual.set(key(fromBin(row.source_doc_id), fromBin(row.product_id)), Number(row.qty));
  }
  for (const k of new Set([...expected.keys(), ...actual.keys()])) {
    const [transferId, productId] = k.split('|') as [string, string];
    const want = expected.get(k) ?? 0;
    const got = actual.get(k) ?? 0;
    if (Math.abs(want - got) > QTY_EPSILON) {
      breaches.push({
        transferId,
        productId,
        reason: 'TRANSIT_NOT_SETTLED',
        expectedQty: want,
        actualQty: got,
      });
    }
  }
  return { ok: breaches.length === 0, transfersChecked: settled.size, breaches };
}
