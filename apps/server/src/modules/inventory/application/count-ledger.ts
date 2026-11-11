/**
 * Lectures du registre propres aux inventaires : soldes par lot d'un emplacement à un instant (BR-STK-042 : théorique
 * à `counted_at`), lignes comptées à rapprocher d'un mouvement tardif (BR-STK-044) et répartition d'une ligne sans lot
 * (BR-STK-045). Feuille du module : elle ne dépend ni de `record-move` ni des commandes, qui l'importent toutes deux.
 *
 * Lectures **verrouillantes** par défaut dans le chemin du rapprochement : sous l'isolation répétable, une lecture simple
 * faite après l'attente d'un verrou voit l'instantané de la transaction et non ce qu'un inventaire ou un mouvement
 * concurrent vient de valider ; le rapprochement s'appuierait alors sur un solde périmé et manquerait un écart.
 */
import type { Transaction } from 'kysely';
import type { CountLineScope, CountLotBalance } from '@gic/domain';
import type { DB } from '../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../platform/kysely/uuid-columns.js';

/** Soldes d'un produit dans un emplacement, par lot (clé `null` : sans lot), en millièmes entiers. */
export type LotBuckets = ReadonlyMap<string | null, number>;

/**
 * Σ des entrées moins Σ des sorties de l'emplacement pour le produit, mouvements d'`occurred_at <= at`, par lot.
 * `lock` : lecture verrouillante (`FOR SHARE`) des mouvements lus.
 */
export async function ledgerBucketsAt(
  uow: Transaction<DB>,
  params: {
    readonly locationId: string;
    readonly productId: string;
    readonly at: Date;
    readonly lock: boolean;
  },
): Promise<LotBuckets> {
  const location = toBin(params.locationId);
  const product = toBin(params.productId);
  const buckets = new Map<string | null, number>();
  const add = (rows: readonly { lot_id: Buffer | null; total: string | null }[], sign: 1 | -1) => {
    for (const row of rows) {
      const key = fromBinOrNull(row.lot_id);
      buckets.set(key, (buckets.get(key) ?? 0) + sign * Math.round(Number(row.total ?? 0) * 1000));
    }
  };
  const inflow = await uow
    .selectFrom('inventory_stock_moves')
    .select(['lot_id', (eb) => eb.fn.sum<string>('quantity').as('total')])
    .where('to_location_id', '=', location)
    .where('product_id', '=', product)
    .where('occurred_at', '<=', params.at)
    .groupBy('lot_id')
    .$if(params.lock, (qb) => qb.forShare())
    .execute();
  add(inflow, 1);
  const outflow = await uow
    .selectFrom('inventory_stock_moves')
    .select(['lot_id', (eb) => eb.fn.sum<string>('quantity').as('total')])
    .where('from_location_id', '=', location)
    .where('product_id', '=', product)
    .where('occurred_at', '<=', params.at)
    .groupBy('lot_id')
    .$if(params.lock, (qb) => qb.forShare())
    .execute();
  add(outflow, -1);
  return buckets;
}

/** Solde (unités) de la portée d'une ligne : un lot, le sans-lot, ou tous les soldes du produit. */
export function bucketBalance(
  buckets: LotBuckets,
  scope: CountLineScope,
  lotId: string | null,
): number {
  if (scope === 'ALL_LOTS') {
    let total = 0;
    for (const milli of buckets.values()) total += milli;
    return total / 1000;
  }
  return (buckets.get(scope === 'LOT' ? lotId : null) ?? 0) / 1000;
}

/** Le produit a des soldes par lot dans l'emplacement (BR-STK-045). */
export function bucketsHaveLots(buckets: LotBuckets): boolean {
  for (const lotId of buckets.keys()) if (lotId !== null) return true;
  return false;
}

/**
 * Les lots des soldes avec leur rang FIFO (`fifo_rank_at`) et leur état (ouvert ou non), pour la répartition d'un écart sans
 * lot : seul un lot ouvert reçoit un gain (BR-STK-050, le serveur ne sort jamais d'un lot clos).
 */
export async function lotBalancesOf(
  uow: Transaction<DB>,
  buckets: LotBuckets,
): Promise<readonly CountLotBalance[]> {
  const lotIds = [...buckets.keys()].filter((lotId): lotId is string => lotId !== null);
  if (lotIds.length === 0) return [];
  const rows = await uow
    .selectFrom('inventory_stock_lots')
    .select(['id', 'fifo_rank_at', 'status'])
    .where(
      'id',
      'in',
      lotIds.map((lotId) => toBin(lotId)),
    )
    .execute();
  const known = new Map(rows.map((row) => [fromBin(row.id), row] as const));
  return lotIds
    .filter((lotId) => known.has(lotId))
    .map((lotId) => ({
      lotId,
      balance: (buckets.get(lotId) ?? 0) / 1000,
      rankAt: known.get(lotId)!.fifo_rank_at,
      open: known.get(lotId)!.status === 'OPEN',
    }));
}

/** Solde (unités) du seul sans-lot dans les soldes : la dernière réserve d'une perte répartie (BR-STK-045). */
export function lotLessBalanceOf(buckets: LotBuckets): number {
  return (buckets.get(null) ?? 0) / 1000;
}

/** Une ligne comptée d'un inventaire comptabilisé, candidate au rapprochement d'un mouvement tardif. */
export interface PostedCountLine {
  readonly lineId: string;
  readonly countId: string;
  readonly locationId: string;
  readonly siteId: string;
  readonly productId: string;
  readonly lotId: string | null;
  readonly allLots: boolean;
  readonly countedAt: Date;
  readonly countedQtyBase: number;
}

/** La portée d'une ligne (colonne `all_lots` + lot désigné). */
export function scopeOfLine(line: Pick<PostedCountLine, 'lotId' | 'allLots'>): CountLineScope {
  if (line.lotId !== null) return 'LOT';
  return line.allLots ? 'ALL_LOTS' : 'NO_LOT';
}

/** Une ligne couvre un mouvement du lot `moveLotId` si ce lot est dans sa portée. */
export function lineCoversLot(
  line: Pick<PostedCountLine, 'lotId' | 'allLots'>,
  moveLotId: string | null,
): boolean {
  const scope = scopeOfLine(line);
  if (scope === 'ALL_LOTS') return true;
  return scope === 'LOT' ? line.lotId === moveLotId : moveLotId === null;
}

/**
 * Les lignes de produit `productId` comptées dans `locationId`, d'inventaires `POSTED` (hors stock d'ouverture), à un
 * instant égal ou postérieur à `notBefore`, de la plus ancienne à la plus récente. Lecture verrouillante : un
 * inventaire qui vient d'être comptabilisé par une transaction concurrente est vu, un inventaire en cours d'écriture
 * fait attendre la sienne (courte).
 *
 * En deux lectures sans jointure (pas de `FOR SHARE OF`, que MariaDB ne connaît pas) ; la première, sur l'index
 * `(product_id, counted_at)`, est vide pour tout mouvement du jour.
 */
export async function findPostedLinesNotBefore(
  uow: Transaction<DB>,
  params: { readonly locationId: string; readonly productId: string; readonly notBefore: Date },
): Promise<readonly PostedCountLine[]> {
  const lines = await uow
    .selectFrom('inventory_inventory_count_lines')
    .select(['id', 'count_id', 'lot_id', 'all_lots', 'counted_at', 'counted_qty_base'])
    .where('product_id', '=', toBin(params.productId))
    .where('counted_at', '>=', params.notBefore)
    .orderBy('counted_at', 'asc')
    .orderBy('id', 'asc')
    .forShare()
    .execute();
  if (lines.length === 0) return [];
  const counts = await uow
    .selectFrom('inventory_inventory_counts')
    .select(['id', 'location_id', 'site_id', 'status', 'count_type'])
    .where('id', 'in', [
      ...new Map(lines.map((line) => [fromBin(line.count_id), line.count_id])).values(),
    ])
    .forShare()
    .execute();
  const eligible = new Map(
    counts
      .filter(
        (count) =>
          count.status === 'POSTED' &&
          count.count_type !== 'OPENING' &&
          fromBin(count.location_id) === params.locationId,
      )
      .map((count) => [fromBin(count.id), count] as const),
  );
  return lines
    .filter((line) => eligible.has(fromBin(line.count_id)))
    .map((line) => {
      const count = eligible.get(fromBin(line.count_id))!;
      return {
        lineId: fromBin(line.id),
        countId: fromBin(line.count_id),
        locationId: params.locationId,
        siteId: fromBin(count.site_id),
        productId: params.productId,
        lotId: fromBinOrNull(line.lot_id),
        allLots: Boolean(line.all_lots),
        countedAt: line.counted_at,
        countedQtyBase: Number(line.counted_qty_base),
      };
    });
}

/** Le compte du système (acteur des écritures qu'aucun utilisateur ne fait), `null` sur une base sans semis. */
export async function systemUserId(uow: Transaction<DB>): Promise<string | null> {
  const row = await uow
    .selectFrom('identity_users')
    .select('id')
    .where('is_system', '=', 1)
    .orderBy('created_at')
    .limit(1)
    .executeTakeFirst();
  return row ? fromBin(row.id) : null;
}

const adjustmentLocationCache = new Map<string, string>();

/** L'emplacement virtuel `V_ADJUSTMENT` (une ligne par type, jamais recréée après le semis : mise en cache). */
export async function adjustmentLocationId(uow: Transaction<DB>): Promise<string> {
  const cached = adjustmentLocationCache.get('V_ADJUSTMENT');
  if (cached) return cached;
  const row = await uow
    .selectFrom('organization_locations')
    .select('id')
    .where('location_type', '=', 'V_ADJUSTMENT')
    .executeTakeFirstOrThrow();
  const id = fromBin(row.id);
  adjustmentLocationCache.set('V_ADJUSTMENT', id);
  return id;
}
