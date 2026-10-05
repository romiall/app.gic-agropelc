/**
 * Annulation d'un document par contre-passation (ADR-006 ; BR-STK-002, BR-STK-052) : API
 * publique pour les modules qui annulent leurs propres documents à effets de stock
 * (`production` : entrées de lot, P7-05 ; collectes, incubation, abattage ensuite).
 *
 * - `reverseDocumentMoves` : inverse de chaque mouvement du document pas encore contre-passé,
 *   au coût d'origine, extrémités échangées ; les entrées en stock (depuis un emplacement
 *   virtuel) d'abord, puis les sorties — ce qui avait été produit sort avant que ce qui avait
 *   été pris revienne. En ligne (`allowNegative` = false), un stock déjà reparti bloque
 *   l'annulation (`INSUFFICIENT_STOCK`) ;
 * - les écritures de coût nées de ces mouvements (source `STOCK_MOVE`) sont contrepassées dans
 *   la foulée ; `reverseCostEntries` contrepasse celles d'une autre source (crédit de
 *   production transférée d'une naissance, par exemple).
 */
import { sql, type Transaction } from 'kysely';
import type { IdGenerator } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import {
  InventoryMoveError,
  recordStockMove,
  type MoveType,
  type SourceDocType,
} from './record-move.js';
import type { CostSourceType } from './cost-entries.js';

/** Type du mouvement inverse : mêmes extrémités, échangées (D06 §7.7). */
const REVERSE_MOVE_TYPE: Partial<Record<MoveType, MoveType>> = {
  PRODUCTION_OUTPUT: 'PRODUCTION_INPUT',
  PRODUCTION_INPUT: 'PRODUCTION_OUTPUT',
  INTERNAL_MOVE: 'INTERNAL_MOVE',
  CONSUMPTION: 'CONSUMPTION_REVERSAL',
};

export interface ReversedMove {
  readonly originalMoveId: string;
  readonly reverseMoveId: string;
  readonly valueXaf: number;
  /** Hors ligne : l'inverse a rendu négatif le solde d'un emplacement physique (`STOCK_NEGATIVE`). */
  readonly negativeBalance: boolean;
}

export async function reverseDocumentMoves(
  uow: Transaction<DB>,
  deps: { readonly idGenerator: IdGenerator },
  input: {
    readonly sourceDocType: SourceDocType;
    readonly sourceDocId: string;
    readonly occurredAt: Date;
    readonly createdBy: string;
    readonly commandId?: string;
    readonly capturedOffline?: boolean;
    readonly allowNegative: boolean;
  },
): Promise<readonly ReversedMove[]> {
  // Une vente, une livraison et un retour ne s'inversent pas : une vente se contre-passe par des
  // mouvements rattachés à elle (`returnSoldGoods`, ADR-029).
  if (
    input.sourceDocType === 'SALE' ||
    input.sourceDocType === 'DELIVERY' ||
    input.sourceDocType === 'SALE_CANCELLATION'
  ) {
    throw new InventoryMoveError(
      'Une vente se contre-passe par returnSoldGoods, jamais par inversion (ADR-029).',
      'MOVE_TYPE_INVALID',
    );
  }
  const moves = await uow
    .selectFrom('inventory_stock_moves as m')
    .innerJoin('organization_locations as fl', 'fl.id', 'm.from_location_id')
    .innerJoin('organization_locations as tl', 'tl.id', 'm.to_location_id')
    .select([
      'm.id',
      'm.product_id',
      'm.lot_id',
      'm.quantity',
      'm.move_type',
      'm.from_location_id',
      'm.to_location_id',
      'm.unit_cost_xaf',
      'fl.is_virtual as from_virtual',
      'tl.is_virtual as to_virtual',
    ])
    .where('m.source_doc_type', '=', input.sourceDocType)
    .where('m.source_doc_id', '=', toBin(input.sourceDocId))
    .where('m.is_reversal', '=', 0)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('inventory_stock_moves as r')
            .select('r.id')
            .whereRef('r.reverses_move_id', '=', 'm.id'),
        ),
      ),
    )
    .orderBy('m.occurred_at', 'asc')
    .execute();
  // Entrées en stock d'abord (source virtuelle), puis sorties.
  const ordered = [...moves].sort((a, b) => Number(b.from_virtual) - Number(a.from_virtual));
  const reversed: ReversedMove[] = [];
  for (const move of ordered) {
    const moveType = REVERSE_MOVE_TYPE[move.move_type as MoveType];
    if (!moveType) {
      throw new InventoryMoveError(
        `Mouvement ${move.move_type} non annulable par cette voie.`,
        'MOVE_TYPE_INVALID',
      );
    }
    const lotId = fromBinOrNull(move.lot_id);
    const [reverse] = await recordStockMove(uow, deps, {
      productId: fromBin(move.product_id),
      ...(lotId !== null ? { lotId } : {}),
      quantityBase: Number(move.quantity),
      fromLocationId: fromBin(move.to_location_id),
      toLocationId: fromBin(move.from_location_id),
      moveType,
      occurredAt: input.occurredAt,
      sourceDocType: input.sourceDocType,
      sourceDocId: input.sourceDocId,
      createdBy: input.createdBy,
      ...(input.commandId !== undefined ? { commandId: input.commandId } : {}),
      capturedOffline: input.capturedOffline ?? false,
      allowNegative: input.allowNegative,
      reversesMoveId: fromBin(move.id),
      reversedUnitCostXaf: Number(move.unit_cost_xaf),
    });
    reversed.push({
      originalMoveId: fromBin(move.id),
      reverseMoveId: reverse!.moveId,
      valueXaf: reverse!.valueXaf,
      negativeBalance: !move.to_virtual && reverse!.fromBalanceAfter < 0,
    });
  }
  await reverseCostEntries(uow, deps, {
    sourceType: 'STOCK_MOVE',
    sourceIds: reversed.map((move) => move.originalMoveId),
    reverseSourceIds: new Map(reversed.map((move) => [move.originalMoveId, move.reverseMoveId])),
    occurredAt: input.occurredAt,
    createdBy: input.createdBy,
  });
  return reversed;
}

/**
 * Contrepasse (sens opposé, même montant, `reverses_entry_id`) les écritures de coût d'une
 * source qui ne l'ont pas encore été ; renvoie le nombre d'écritures contrepassées. Source de
 * l'écriture inverse (clé unique source × objet) : le mouvement inverse correspondant
 * (`reverseSourceIds`), sinon un identifiant neuf — même précédent que l'annulation d'un frais
 * général.
 */
export async function reverseCostEntries(
  uow: Transaction<DB>,
  deps: { readonly idGenerator: IdGenerator },
  input: {
    readonly sourceType: CostSourceType;
    readonly sourceIds: readonly string[];
    readonly reverseSourceIds?: ReadonlyMap<string, string>;
    readonly occurredAt: Date;
    readonly createdBy: string;
    readonly comment?: string;
  },
): Promise<number> {
  if (input.sourceIds.length === 0) return 0;
  const entries = await uow
    .selectFrom('inventory_cost_entries as e')
    .selectAll('e')
    .where('e.source_type', '=', input.sourceType)
    .where(
      'e.source_id',
      'in',
      input.sourceIds.map((id) => toBin(id)),
    )
    .where('e.reverses_entry_id', 'is', null)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('inventory_cost_entries as r')
            .select('r.id')
            .whereRef('r.reverses_entry_id', '=', 'e.id'),
        ),
      ),
    )
    .execute();
  for (const entry of entries) {
    await uow
      .insertInto('inventory_cost_entries')
      .values({
        id: toBin(deps.idGenerator.newId()),
        cost_object_type: entry.cost_object_type,
        cost_object_id: entry.cost_object_id,
        cost_type: entry.cost_type,
        species_group: entry.species_group,
        amount_xaf: entry.amount_xaf,
        direction: entry.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT',
        source_type: entry.source_type,
        source_id: toBin(
          input.reverseSourceIds?.get(fromBin(entry.source_id)) ?? deps.idGenerator.newId(),
        ),
        reverses_entry_id: entry.id,
        occurred_at: input.occurredAt,
        created_by: toBin(input.createdBy),
        comment: input.comment ?? null,
      })
      .execute();
  }
  return entries.length;
}

/** Nombre de mouvements du document (hors inverses) ; sert de garde aux annulations. */
export async function documentMoveCount(
  uow: Transaction<DB>,
  input: { readonly sourceDocType: SourceDocType; readonly sourceDocId: string },
): Promise<number> {
  const row = await uow
    .selectFrom('inventory_stock_moves')
    .select(sql<string>`COUNT(*)`.as('n'))
    .where('source_doc_type', '=', input.sourceDocType)
    .where('source_doc_id', '=', toBin(input.sourceDocId))
    .where('is_reversal', '=', 0)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}
