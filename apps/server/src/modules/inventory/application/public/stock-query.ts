/**
 * Lectures du stock (P2-05 ; 08-api-events/01-architecture-api.md §4.6 : `GET /stock`,
 * `/stock/at`, `/stock/availability`, `/stock-moves`). API publique d'`inventory`, consommée
 * par le transport `inventory-api/` (même précédent que `catalog-query.ts` pour
 * `catalog-api/`).
 *
 * Aucune décision d'autorisation ici : l'appelant évalue la portée de l'utilisateur sur
 * l'emplacement (`findStockLocation`, RC-04) et décide seul d'exposer les montants (RC-05,
 * BR-STK-054) — chaque lecture renvoie donc ses montants, que le transport masque. Lecture
 * directe d'`organization.locations`/`sites`/`zone_ancestors` (même précédent que
 * `record-move.ts::loadLocation` et `commands/shared.ts` : `organization` n'expose pas encore
 * d'API publique pour ses emplacements).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  availableOnExclusive,
  availableOnShared,
  roundCmupToXaf,
  stockValueXaf,
} from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

/** Même clé que `record-move.ts` : `lot_key` = UUID nul pour un solde sans lot (D06 §3.1). */
const LOT_KEY_NULL = Buffer.alloc(16);

/** Borne de pagination des listes (01-architecture-api.md §2 : `limit` ≤ 200). */
export const INVENTORY_LIST_MAX_LIMIT = 200;
export const INVENTORY_LIST_DEFAULT_LIMIT = 50;

function lotIdOfKey(lotKey: Buffer): string | null {
  return lotKey.equals(LOT_KEY_NULL) ? null : fromBin(lotKey);
}

/** Quantités `numeric(14,3)` : toute somme/différence est ramenée aux millièmes (ADR-013). */
function roundQty(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Colonne `DATE` (mysql2 : minuit heure locale du processus) → `YYYY-MM-DD`. */
export function formatDateColumn(value: Date | null): string | null {
  if (value === null) return null;
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

export interface StockLocationRef {
  readonly id: string;
  readonly siteId: string | null;
  readonly zoneId: string | null;
  readonly locationType: string;
  readonly isVirtual: boolean;
  readonly custodyMode: string | null;
  readonly custodianUserId: string | null;
}

/** Attributs d'un emplacement nécessaires à l'évaluation de portée (site, zone, détenteur). */
export async function findStockLocation(
  executor: Executor,
  locationId: string,
): Promise<StockLocationRef | undefined> {
  const row = await executor
    .selectFrom('organization_locations as l')
    .leftJoin('organization_sites as s', 's.id', 'l.site_id')
    .select([
      'l.id as id',
      'l.site_id as site_id',
      's.zone_id as zone_id',
      'l.location_type as location_type',
      'l.is_virtual as is_virtual',
      'l.custody_mode as custody_mode',
      'l.custodian_user_id as custodian_user_id',
    ])
    .where('l.id', '=', toBin(locationId))
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    id: fromBin(row.id),
    siteId: fromBinOrNull(row.site_id),
    zoneId: fromBinOrNull(row.zone_id),
    locationType: row.location_type,
    isVirtual: Boolean(row.is_virtual),
    custodyMode: row.custody_mode,
    custodianUserId: fromBinOrNull(row.custodian_user_id),
  };
}

/**
 * Stratégie stock §3.3, vue serveur sans consommateur désigné : sur un emplacement exclusif,
 * `qty_on_hand − qty_reserved` ; sinon (`SHARED`, ou mode absent — DÉDUIT : traité comme
 * partagé, lecture prudente) les quotas alloués sont retranchés en entier (`reste_alloué_à(C)`
 * = 0, aucun consommateur n'étant désigné par une lecture).
 */
export function availableQty(
  custodyMode: string | null,
  qtyOnHand: number,
  qtyReserved: number,
  qtyAllocated: number,
): number {
  const available =
    custodyMode === 'EXCLUSIVE_USER' || custodyMode === 'EXCLUSIVE_DEVICE'
      ? availableOnExclusive(qtyOnHand, qtyReserved)
      : availableOnShared(qtyOnHand, qtyReserved, qtyAllocated, 0);
  return roundQty(available);
}

export interface StockBalanceLine {
  readonly productId: string;
  readonly lotId: string | null;
  readonly lotCode: string | null;
  readonly expiryDate: string | null;
  readonly qtyOnHand: number;
  readonly qtyReserved: number;
  readonly qtyAllocated: number;
  readonly qtyAvailable: number;
  /** CMUP courant arrondi au franc (BR-STK-052) — mesure financière (RC-05). */
  readonly unitCostXaf: number;
  /** BR-STK-054 : solde × coût unitaire courant — mesure financière (RC-05). */
  readonly valueXaf: number;
  readonly lastMoveAt: Date | null;
  readonly rowVersion: number;
}

/** `GET /stock` : soldes courants (projection `stock_balances`, stratégie stock §10 — jamais
 * une agrégation du registre en temps réel), par produit et lot. Les lignes entièrement à zéro
 * (conservées par la projection, dictionnaire) sont omises. */
export async function listStockBalances(
  executor: Executor,
  params: {
    readonly locationId: string;
    readonly custodyMode: string | null;
    readonly productId?: string;
  },
): Promise<readonly StockBalanceLine[]> {
  const rows = await executor
    .selectFrom('inventory_stock_balances as b')
    .leftJoin('inventory_stock_lots as lot', 'lot.id', 'b.lot_key')
    .leftJoin('inventory_product_valuations as v', 'v.product_id', 'b.product_id')
    .select([
      'b.product_id as product_id',
      'b.lot_key as lot_key',
      'lot.lot_code as lot_code',
      'lot.expiry_date as expiry_date',
      'b.qty_on_hand as qty_on_hand',
      'b.qty_reserved as qty_reserved',
      'b.qty_allocated as qty_allocated',
      'b.last_move_at as last_move_at',
      'b.row_version as row_version',
      'v.avg_unit_cost_xaf as avg_unit_cost_xaf',
    ])
    .where('b.location_id', '=', toBin(params.locationId))
    .$if(params.productId !== undefined, (qb) =>
      qb.where('b.product_id', '=', toBin(params.productId!)),
    )
    .orderBy('b.product_id', 'asc')
    .orderBy('b.lot_key', 'asc')
    .execute();

  const lines: StockBalanceLine[] = [];
  for (const row of rows) {
    const qtyOnHand = Number(row.qty_on_hand);
    const qtyReserved = Number(row.qty_reserved);
    const qtyAllocated = Number(row.qty_allocated);
    if (qtyOnHand === 0 && qtyReserved === 0 && qtyAllocated === 0) continue;
    const avgUnitCost = row.avg_unit_cost_xaf === null ? 0 : Number(row.avg_unit_cost_xaf);
    lines.push({
      productId: fromBin(row.product_id),
      lotId: lotIdOfKey(row.lot_key),
      lotCode: row.lot_code,
      expiryDate: formatDateColumn(row.expiry_date),
      qtyOnHand,
      qtyReserved,
      qtyAllocated,
      qtyAvailable: availableQty(params.custodyMode, qtyOnHand, qtyReserved, qtyAllocated),
      unitCostXaf: roundCmupToXaf(avgUnitCost),
      valueXaf: stockValueXaf(qtyOnHand, avgUnitCost),
      lastMoveAt: row.last_move_at,
      rowVersion: Number(row.row_version),
    });
  }
  return lines;
}

export interface StockBalanceAtLine {
  readonly productId: string;
  readonly lotId: string | null;
  readonly qtyOnHand: number;
  /** Valeur au coût historique figé des mouvements (Σ signée de `value_xaf`) — distincte de
   * la valeur courante BR-STK-054, qui dépend du CMUP d'aujourd'hui. Mesure financière (RC-05). */
  readonly ledgerValueXaf: number;
}

/**
 * `GET /stock/at` — stratégie stock §3.2 : `balance_at(loc, produit, lot, t)` = Σ des
 * mouvements de `occurred_at` ≤ t (même définition que le théorique d'un inventaire,
 * `count-commands.ts`). Calculé sur le registre (pas d'instantané quotidien en P2 : la table
 * optionnelle `stock_balance_snapshots` n'est pas alimentée).
 */
export async function stockBalanceAt(
  executor: Executor,
  params: { readonly locationId: string; readonly at: Date; readonly productId?: string },
): Promise<readonly StockBalanceAtLine[]> {
  const location = toBin(params.locationId);
  const rows = await executor
    .selectFrom('inventory_stock_moves')
    .select([
      'product_id',
      'lot_id',
      sql<string>`SUM(CASE WHEN to_location_id = ${location} THEN quantity ELSE -quantity END)`.as(
        'qty',
      ),
      sql<string>`SUM(CASE WHEN to_location_id = ${location} THEN value_xaf ELSE -value_xaf END)`.as(
        'value_xaf',
      ),
    ])
    .where((eb) =>
      eb.or([eb('to_location_id', '=', location), eb('from_location_id', '=', location)]),
    )
    .where('occurred_at', '<=', params.at)
    .$if(params.productId !== undefined, (qb) =>
      qb.where('product_id', '=', toBin(params.productId!)),
    )
    .groupBy(['product_id', 'lot_id'])
    .orderBy('product_id', 'asc')
    .orderBy('lot_id', 'asc')
    .execute();

  const lines: StockBalanceAtLine[] = [];
  for (const row of rows) {
    const qtyOnHand = roundQty(Number(row.qty));
    const ledgerValueXaf = Number(row.value_xaf);
    if (qtyOnHand === 0 && ledgerValueXaf === 0) continue;
    lines.push({
      productId: fromBin(row.product_id),
      lotId: fromBinOrNull(row.lot_id),
      qtyOnHand,
      ledgerValueXaf,
    });
  }
  return lines;
}

/** Stratégie stock §4 : « stock commercial » = emplacements `STORE`, `POS`, `MOBILE`. */
export const COMMERCIAL_LOCATION_TYPES = ['STORE', 'POS', 'MOBILE'] as const;

export interface AvailabilityLocationLine {
  readonly locationId: string;
  readonly locationCode: string;
  readonly locationName: string;
  readonly locationType: string;
  readonly siteId: string;
  readonly zoneId: string;
  readonly custodyMode: string | null;
  readonly custodianUserId: string | null;
  readonly qtyOnHand: number;
  readonly qtyReserved: number;
  readonly qtyAllocated: number;
  readonly qtyAvailable: number;
}

/**
 * `GET /stock/availability` — question CM §62 (stratégie stock §4) : disponible d'un produit
 * sur les emplacements physiques des sites d'une zone **et de ses sous-zones**
 * (`organization.zone_ancestors`, la zone comptant comme son propre ancêtre), un total par
 * emplacement (lots confondus). La part « effectif en élevage des lots `SELLING` » du §4
 * dépend de `production` (P7) : hors périmètre ici. Le filtrage par portée de l'utilisateur
 * est fait par l'appelant, emplacement par emplacement.
 */
export async function listAvailabilityInZone(
  executor: Executor,
  params: {
    readonly zoneId: string;
    readonly productId: string;
    readonly locationTypes: readonly string[];
  },
): Promise<readonly AvailabilityLocationLine[]> {
  if (params.locationTypes.length === 0) return [];
  const rows = await executor
    .selectFrom('inventory_stock_balances as b')
    .innerJoin('organization_locations as l', 'l.id', 'b.location_id')
    .innerJoin('organization_sites as s', 's.id', 'l.site_id')
    .innerJoin('organization_zone_ancestors as za', 'za.zone_id', 's.zone_id')
    .select([
      'l.id as location_id',
      'l.code as location_code',
      'l.name as location_name',
      'l.location_type as location_type',
      'l.site_id as site_id',
      's.zone_id as zone_id',
      'l.custody_mode as custody_mode',
      'l.custodian_user_id as custodian_user_id',
      'b.qty_on_hand as qty_on_hand',
      'b.qty_reserved as qty_reserved',
      'b.qty_allocated as qty_allocated',
    ])
    .where('za.ancestor_id', '=', toBin(params.zoneId))
    .where('b.product_id', '=', toBin(params.productId))
    .where('l.is_virtual', '=', 0)
    .where('l.location_type', 'in', [...params.locationTypes])
    .orderBy('l.code', 'asc')
    .execute();

  const byLocation = new Map<string, AvailabilityLocationLine>();
  for (const row of rows) {
    const locationId = fromBin(row.location_id);
    const previous = byLocation.get(locationId);
    const qtyOnHand = roundQty((previous?.qtyOnHand ?? 0) + Number(row.qty_on_hand));
    const qtyReserved = roundQty((previous?.qtyReserved ?? 0) + Number(row.qty_reserved));
    const qtyAllocated = roundQty((previous?.qtyAllocated ?? 0) + Number(row.qty_allocated));
    byLocation.set(locationId, {
      locationId,
      locationCode: row.location_code,
      locationName: row.location_name,
      locationType: row.location_type,
      siteId: fromBin(row.site_id!),
      zoneId: fromBin(row.zone_id),
      custodyMode: row.custody_mode,
      custodianUserId: fromBinOrNull(row.custodian_user_id),
      qtyOnHand,
      qtyReserved,
      qtyAllocated,
      qtyAvailable: availableQty(row.custody_mode, qtyOnHand, qtyReserved, qtyAllocated),
    });
  }
  return [...byLocation.values()];
}

export interface StockMoveEntry {
  readonly id: string;
  readonly productId: string;
  readonly lotId: string | null;
  /** Sens vu de l'emplacement consulté. */
  readonly direction: 'IN' | 'OUT';
  readonly quantity: number;
  readonly counterpartLocationId: string;
  readonly moveType: string;
  readonly reasonCodeId: string | null;
  /** Coût figé du mouvement (INV-STK-15) — mesure financière (RC-05). */
  readonly unitCostXaf: number;
  /** Mesure financière (RC-05). */
  readonly valueXaf: number;
  readonly occurredAt: Date;
  readonly businessDate: string | null;
  readonly recordedAt: Date;
  readonly sourceDocType: string;
  readonly sourceDocId: string;
  readonly sourceLineId: string | null;
  readonly isReversal: boolean;
  readonly reversesMoveId: string | null;
  readonly createdBy: string;
  readonly capturedOffline: boolean;
}

export interface StockMovesCursor {
  readonly occurredAt: Date;
  readonly id: string;
}

/** Curseur opaque (01-architecture-api.md §2 : pagination par curseur, jamais par décalage). */
export function encodeStockMovesCursor(cursor: StockMovesCursor): string {
  return Buffer.from(`${cursor.occurredAt.getTime()}|${cursor.id}`, 'utf8').toString('base64url');
}

/** `undefined` si le curseur n'a pas été produit par `encodeStockMovesCursor`. */
export function decodeStockMovesCursor(raw: string): StockMovesCursor | undefined {
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const match = /^(\d{1,15})\|([0-9a-f-]{36})$/.exec(decoded);
  if (!match) return undefined;
  return { occurredAt: new Date(Number(match[1])), id: match[2]! };
}

/**
 * `GET /stock-moves` : registre d'un emplacement (explication d'écart, REQ-083), dans l'ordre
 * métier (`occurred_at`, puis `id` UUIDv7 pour départager). Filtres de période sur le **jour
 * métier** `Africa/Douala` (`business_date`, colonne générée ; 01-architecture-api.md §2).
 */
export async function listStockMoves(
  executor: Executor,
  params: {
    readonly locationId: string;
    readonly productId?: string;
    readonly fromBusinessDate?: string;
    readonly toBusinessDate?: string;
    readonly after?: StockMovesCursor;
    readonly limit: number;
  },
): Promise<{ readonly moves: readonly StockMoveEntry[]; readonly nextCursor: string | null }> {
  const location = toBin(params.locationId);
  const rows = await executor
    .selectFrom('inventory_stock_moves')
    .selectAll()
    .where((eb) =>
      eb.or([eb('to_location_id', '=', location), eb('from_location_id', '=', location)]),
    )
    .$if(params.productId !== undefined, (qb) =>
      qb.where('product_id', '=', toBin(params.productId!)),
    )
    .$if(params.fromBusinessDate !== undefined, (qb) =>
      qb.where(sql<boolean>`business_date >= ${params.fromBusinessDate!}`),
    )
    .$if(params.toBusinessDate !== undefined, (qb) =>
      qb.where(sql<boolean>`business_date <= ${params.toBusinessDate!}`),
    )
    .$if(params.after !== undefined, (qb) =>
      qb.where((eb) =>
        eb.or([
          eb('occurred_at', '>', params.after!.occurredAt),
          eb.and([
            eb('occurred_at', '=', params.after!.occurredAt),
            eb('id', '>', toBin(params.after!.id)),
          ]),
        ]),
      ),
    )
    .orderBy('occurred_at', 'asc')
    .orderBy('id', 'asc')
    .limit(params.limit + 1)
    .execute();

  const hasMore = rows.length > params.limit;
  const page = hasMore ? rows.slice(0, params.limit) : rows;
  const moves = page.map((row): StockMoveEntry => {
    const incoming = row.to_location_id.equals(location);
    return {
      id: fromBin(row.id),
      productId: fromBin(row.product_id),
      lotId: fromBinOrNull(row.lot_id),
      direction: incoming ? 'IN' : 'OUT',
      quantity: Number(row.quantity),
      counterpartLocationId: fromBin(incoming ? row.from_location_id : row.to_location_id),
      moveType: row.move_type,
      reasonCodeId: fromBinOrNull(row.reason_code_id),
      unitCostXaf: row.unit_cost_xaf,
      valueXaf: row.value_xaf,
      occurredAt: row.occurred_at,
      businessDate: formatDateColumn(row.business_date),
      recordedAt: row.recorded_at,
      sourceDocType: row.source_doc_type,
      sourceDocId: fromBin(row.source_doc_id),
      sourceLineId: fromBinOrNull(row.source_line_id),
      isReversal: Boolean(row.is_reversal),
      reversesMoveId: fromBinOrNull(row.reverses_move_id),
      createdBy: fromBin(row.created_by),
      capturedOffline: Boolean(row.captured_offline),
    };
  });
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeStockMovesCursor({ occurredAt: last.occurred_at, id: fromBin(last.id) })
      : null;
  return { moves, nextCursor };
}
