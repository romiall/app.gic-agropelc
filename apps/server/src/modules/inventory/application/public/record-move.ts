/**
 * `inventory.recordStockMove` (D06-STK §9, règle de frontière : « seul inventory écrit dans
 * ses tables. Les autres modules appellent son API interne… dans la même transaction que
 * leur propre document »). Registre en partie double (ADR-003, BR-STK-001 à 006) : une
 * quantité positive d'un produit d'un emplacement source vers un emplacement destination,
 * avec mise à jour de la projection de solde (INV-STK-01) dans la même transaction, et, pour
 * une entrée valorisée, recalcul du CMUP (AV-042, ADR-015).
 *
 * Coût : uniquement le CMUP courant (`product_valuations`) en P2 — le coût par tête d'un lot
 * de production biologique (stratégie stock §9) exige `production` (P7, table des lots de
 * production) qui n'existe pas encore. Documenté, pas simulé : un produit de famille
 * `BIOLOGIQUE` avec un lot se valorise pour l'instant comme n'importe quel autre produit
 * (CMUP), à corriger quand `production` existe.
 */
import type { Transaction } from 'kysely';
import { sql } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import type { IdGenerator } from '@gic/domain';
import {
  lineAmountXaf,
  quantityFromDecimal,
  recalculateCmup,
  roundCmupToXaf,
  selectLotsFifo,
  xaf,
} from '@gic/domain';
import { toBin, toBinOrNull, fromBin } from '../../../../platform/kysely/uuid-columns.js';
import { toDbBool } from '../../../../platform/kysely/bool-column.js';
import { recordChanges } from '../../../../platform/sync/change-feed.js';
import { stockBalanceChange } from '../sync-changes.js';

const LOT_KEY_NULL = Buffer.alloc(16);

export const MOVE_TYPES = [
  'OPENING_BALANCE',
  'PURCHASE_RECEIPT',
  'SUPPLIER_RETURN',
  'TRANSFER_DISPATCH',
  'TRANSFER_RECEIPT',
  'TRANSFER_DISCREPANCY',
  'INTERNAL_MOVE',
  'SALE',
  'CUSTOMER_RETURN',
  'LOSS',
  'LOSS_PENDING',
  'LOSS_CONFIRMATION',
  'LOSS_RELEASE',
  'CONSUMPTION',
  'CONSUMPTION_REVERSAL',
  'PRODUCTION_OUTPUT',
  'PRODUCTION_INPUT',
  'INVENTORY_GAIN',
  'INVENTORY_LOSS',
] as const;
export type MoveType = (typeof MOVE_TYPES)[number];

export const SOURCE_DOC_TYPES = [
  'SALE',
  'TRANSFER',
  'LOSS',
  'CONSUMPTION',
  'INVENTORY_COUNT',
  'GOODS_RECEIPT',
  'EGG_COLLECTION',
  'INCUBATION_EVENT',
  'LOT_ENTRY',
] as const;
export type SourceDocType = (typeof SOURCE_DOC_TYPES)[number];

/** D06 §7.7 : couple (source, destination) autorisé pour chaque type de mouvement. */
const MOVE_TYPE_ENDPOINTS: Record<MoveType, { from: string; to: string }> = {
  OPENING_BALANCE: { from: 'V_OPENING', to: 'PHYSICAL' },
  PURCHASE_RECEIPT: { from: 'V_SUPPLIER', to: 'PHYSICAL' },
  SUPPLIER_RETURN: { from: 'PHYSICAL', to: 'V_SUPPLIER' },
  TRANSFER_DISPATCH: { from: 'PHYSICAL', to: 'V_TRANSIT' },
  TRANSFER_RECEIPT: { from: 'V_TRANSIT', to: 'PHYSICAL' },
  TRANSFER_DISCREPANCY: { from: 'V_TRANSIT', to: 'V_PENDING_LOSS' },
  INTERNAL_MOVE: { from: 'PHYSICAL', to: 'PHYSICAL' },
  SALE: { from: 'PHYSICAL', to: 'V_CUSTOMER' },
  CUSTOMER_RETURN: { from: 'V_CUSTOMER', to: 'PHYSICAL' },
  LOSS: { from: 'PHYSICAL', to: 'V_LOSS' },
  LOSS_PENDING: { from: 'PHYSICAL', to: 'V_PENDING_LOSS' },
  LOSS_CONFIRMATION: { from: 'V_PENDING_LOSS', to: 'V_LOSS' },
  LOSS_RELEASE: { from: 'V_PENDING_LOSS', to: 'PHYSICAL' },
  CONSUMPTION: { from: 'PHYSICAL', to: 'V_CONSUMPTION' },
  CONSUMPTION_REVERSAL: { from: 'V_CONSUMPTION', to: 'PHYSICAL' },
  PRODUCTION_OUTPUT: { from: 'V_PRODUCTION', to: 'PHYSICAL' },
  PRODUCTION_INPUT: { from: 'PHYSICAL', to: 'V_PRODUCTION' },
  INVENTORY_GAIN: { from: 'V_ADJUSTMENT', to: 'PHYSICAL' },
  INVENTORY_LOSS: { from: 'PHYSICAL', to: 'V_ADJUSTMENT' },
};

/** Stratégie stock §9 : entrées qui recalculent le CMUP (coût déclaré par l'appelant). */
const VALUATION_ENTRY_MOVE_TYPES = new Set<MoveType>([
  'PURCHASE_RECEIPT',
  'OPENING_BALANCE',
  'INVENTORY_GAIN',
]);

export class InventoryMoveError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'InventoryMoveError';
  }
}

export interface RecordMoveInput {
  readonly productId: string;
  /** Omis pour une sortie sans lot désigné sur un produit à suivi par lot : FIFO serveur (BR-STK-050). */
  readonly lotId?: string;
  readonly quantityBase: number;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly moveType: MoveType;
  readonly reasonCodeId?: string;
  /** Requis pour une entrée valorisée (réception, ouverture, gain d'inventaire) ; ignoré sinon (CMUP courant utilisé). */
  readonly declaredUnitCostXaf?: number;
  readonly occurredAt: Date;
  readonly sourceDocType: SourceDocType;
  readonly sourceDocId: string;
  readonly sourceLineId?: string;
  readonly costObjectType?: 'PRODUCTION_LOT' | 'INCUBATION_BATCH' | 'SITE';
  readonly costObjectId?: string;
  readonly createdBy: string;
  readonly createdDeviceId?: string;
  readonly commandId?: string;
  readonly capturedOffline?: boolean;
  /** BR-STK-017/018 : hors ligne, un fait physique est toujours appliqué, même si le solde devient négatif. */
  readonly allowNegative: boolean;
  /**
   * Mouvement inverse (BR-STK-002) : identifiant du mouvement corrigé. `unit_cost_xaf` reprend
   * alors obligatoirement celui du mouvement d'origine (BR-STK-052), jamais le CMUP courant —
   * fournir aussi `reversedUnitCostXaf`. N'est pas une entrée valorisée (pas de recalcul CMUP),
   * même si le mouvement d'origine en était une.
   */
  readonly reversesMoveId?: string;
  readonly reversedUnitCostXaf?: number;
}

export interface RecordedMove {
  readonly moveId: string;
  readonly lotId: string | null;
  readonly quantity: number;
  readonly unitCostXaf: number;
  readonly valueXaf: number;
  readonly fromBalanceAfter: number;
  readonly toBalanceAfter: number;
}

export interface RecordMoveDeps {
  readonly idGenerator: IdGenerator;
}

async function loadLocation(
  uow: Transaction<DB>,
  locationId: string,
): Promise<{ readonly isVirtual: boolean; readonly locationType: string }> {
  const row = await uow
    .selectFrom('organization_locations')
    .select(['is_virtual', 'location_type'])
    .where('id', '=', toBin(locationId))
    .executeTakeFirst();
  if (!row) throw new InventoryMoveError('Emplacement introuvable.', 'LOCATION_INVALID');
  return { isVirtual: Boolean(row.is_virtual), locationType: row.location_type };
}

function checkEndpoint(
  side: 'from' | 'to',
  expected: string,
  location: { readonly isVirtual: boolean; readonly locationType: string },
): void {
  if (expected === 'PHYSICAL') {
    if (location.isVirtual) {
      throw new InventoryMoveError(
        `Emplacement ${side === 'from' ? 'source' : 'destination'} : un emplacement physique était attendu.`,
        'MOVE_TYPE_INVALID',
      );
    }
    return;
  }
  if (location.locationType !== expected) {
    throw new InventoryMoveError(
      `Emplacement ${side === 'from' ? 'source' : 'destination'} : ${expected} attendu.`,
      'MOVE_TYPE_INVALID',
    );
  }
}

async function currentCmup(
  uow: Transaction<DB>,
  productId: string,
): Promise<{ readonly qtyBasis: number; readonly avgUnitCostXaf: number }> {
  const row = await uow
    .selectFrom('inventory_product_valuations')
    .select(['qty_basis', 'avg_unit_cost_xaf'])
    .where('product_id', '=', toBin(productId))
    .executeTakeFirst();
  if (!row) return { qtyBasis: 0, avgUnitCostXaf: 0 };
  return { qtyBasis: Number(row.qty_basis), avgUnitCostXaf: Number(row.avg_unit_cost_xaf) };
}

async function upsertBalance(
  uow: Transaction<DB>,
  key: { readonly locationId: string; readonly productId: string; readonly lotKey: Buffer },
  deltaQty: number,
  deltaValueXaf: number,
  lastMoveAt: Date,
): Promise<number> {
  const locationIdBin = toBin(key.locationId);
  const productIdBin = toBin(key.productId);
  const existing = await uow
    .selectFrom('inventory_stock_balances')
    .select(['qty_on_hand', 'value_xaf'])
    .where('location_id', '=', locationIdBin)
    .where('product_id', '=', productIdBin)
    .where('lot_key', '=', key.lotKey)
    .forUpdate()
    .executeTakeFirst();

  if (existing) {
    const newQty = Number(existing.qty_on_hand) + deltaQty;
    await uow
      .updateTable('inventory_stock_balances')
      .set({
        qty_on_hand: String(newQty),
        value_xaf: sql`value_xaf + ${deltaValueXaf}`,
        last_move_at: lastMoveAt,
        row_version: sql`row_version + 1`,
      })
      .where('location_id', '=', locationIdBin)
      .where('product_id', '=', productIdBin)
      .where('lot_key', '=', key.lotKey)
      .execute();
    return newQty;
  }

  await uow
    .insertInto('inventory_stock_balances')
    .values({
      location_id: locationIdBin,
      product_id: productIdBin,
      lot_key: key.lotKey,
      qty_on_hand: String(deltaQty),
      value_xaf: deltaValueXaf,
      last_move_at: lastMoveAt,
      row_version: 1,
    })
    .execute();
  return deltaQty;
}

/**
 * Enregistre un mouvement pour une quantité déjà résolue sur un lot précis (ou aucun lot).
 * Usage interne de `recordStockMove` (résolution FIFO) et direct quand l'appelant connaît
 * déjà le lot exact (ex. réception avec lot fournisseur).
 */
type SingleMoveInput = Omit<RecordMoveInput, 'lotId'> & { readonly lotId: string | null };

async function recordSingleMove(
  uow: Transaction<DB>,
  deps: RecordMoveDeps,
  input: SingleMoveInput,
): Promise<RecordedMove> {
  const endpoints = MOVE_TYPE_ENDPOINTS[input.moveType];
  const [fromLocation, toLocation] = await Promise.all([
    loadLocation(uow, input.fromLocationId),
    loadLocation(uow, input.toLocationId),
  ]);
  checkEndpoint('from', endpoints.from, fromLocation);
  checkEndpoint('to', endpoints.to, toLocation);

  if (input.quantityBase <= 0) {
    throw new InventoryMoveError('La quantité doit être positive.', 'QUANTITY_INVALID');
  }
  if (input.fromLocationId === input.toLocationId) {
    throw new InventoryMoveError('Source et destination doivent différer.', 'LOCATION_INVALID');
  }

  const isReversal = input.reversesMoveId !== undefined;
  const isValuationEntry = !isReversal && VALUATION_ENTRY_MOVE_TYPES.has(input.moveType);
  let unitCostXaf: number;
  if (isReversal) {
    if (input.reversedUnitCostXaf === undefined) {
      throw new InventoryMoveError(
        'Le coût du mouvement d’origine est requis pour un mouvement inverse (BR-STK-052).',
        'UNIT_COST_REQUIRED',
      );
    }
    unitCostXaf = input.reversedUnitCostXaf;
  } else if (isValuationEntry) {
    if (input.declaredUnitCostXaf === undefined) {
      throw new InventoryMoveError(
        'Un coût unitaire déclaré est requis pour une entrée valorisée.',
        'UNIT_COST_REQUIRED',
      );
    }
    unitCostXaf = input.declaredUnitCostXaf;
  } else {
    unitCostXaf = (await currentCmup(uow, input.productId)).avgUnitCostXaf;
    unitCostXaf = roundCmupToXaf(unitCostXaf);
  }

  const quantity = quantityFromDecimal(input.quantityBase);
  const valueXaf = lineAmountXaf(quantity, xaf(unitCostXaf));

  const moveId = deps.idGenerator.newId();
  const lotKey = input.lotId ? toBin(input.lotId) : LOT_KEY_NULL;

  await uow
    .insertInto('inventory_stock_moves')
    .values({
      id: toBin(moveId),
      product_id: toBin(input.productId),
      lot_id: toBinOrNull(input.lotId ?? null),
      quantity: String(input.quantityBase),
      from_location_id: toBin(input.fromLocationId),
      to_location_id: toBin(input.toLocationId),
      move_type: input.moveType,
      reason_code_id: toBinOrNull(input.reasonCodeId ?? null),
      unit_cost_xaf: unitCostXaf,
      value_xaf: valueXaf,
      occurred_at: input.occurredAt,
      source_doc_type: input.sourceDocType,
      source_doc_id: toBin(input.sourceDocId),
      source_line_id: toBinOrNull(input.sourceLineId ?? null),
      cost_object_type: input.costObjectType ?? null,
      cost_object_id: toBinOrNull(input.costObjectId ?? null),
      is_reversal: toDbBool(isReversal),
      reverses_move_id: toBinOrNull(input.reversesMoveId ?? null),
      created_by: toBin(input.createdBy),
      created_device_id: toBinOrNull(input.createdDeviceId ?? null),
      command_id: toBinOrNull(input.commandId ?? null),
      captured_offline: toDbBool(input.capturedOffline ?? false),
    })
    .execute();

  const fromBalanceAfter = await upsertBalance(
    uow,
    { locationId: input.fromLocationId, productId: input.productId, lotKey },
    -input.quantityBase,
    -valueXaf,
    input.occurredAt,
  );
  if (!fromLocation.isVirtual && fromBalanceAfter < 0 && !input.allowNegative) {
    throw new InventoryMoveError(
      'Stock insuffisant sur l’emplacement source (BR-STK-017).',
      'INSUFFICIENT_STOCK',
    );
  }
  const toBalanceAfter = await upsertBalance(
    uow,
    { locationId: input.toLocationId, productId: input.productId, lotKey },
    input.quantityBase,
    valueXaf,
    input.occurredAt,
  );

  // Jeu `stock` (P2-06) : émis ici, seul point qui modifie un solde — tout appelant (commande
  // d'inventory, décision d'approbation, futurs modules ventes/achats/production) est couvert
  // sans avoir à y penser. Emplacements physiques seulement (sync-changes.ts).
  await recordChanges(
    uow,
    [
      fromLocation.isVirtual ? null : input.fromLocationId,
      toLocation.isVirtual ? null : input.toLocationId,
    ]
      .filter((locationId): locationId is string => locationId !== null)
      .map((locationId) => stockBalanceChange(locationId, input.productId)),
  );

  if (isValuationEntry) {
    const before = await currentCmup(uow, input.productId);
    const nextCmup = recalculateCmup(
      before.qtyBasis,
      before.avgUnitCostXaf,
      input.quantityBase,
      unitCostXaf,
    );
    await uow
      .insertInto('inventory_product_valuations')
      .values({
        product_id: toBin(input.productId),
        avg_unit_cost_xaf: String(nextCmup),
        qty_basis: String(before.qtyBasis + input.quantityBase),
        last_entry_move_id: toBin(moveId),
      })
      .onDuplicateKeyUpdate({
        avg_unit_cost_xaf: String(nextCmup),
        qty_basis: String(before.qtyBasis + input.quantityBase),
        last_entry_move_id: toBin(moveId),
      })
      .execute();
  }

  return {
    moveId,
    lotId: input.lotId,
    quantity: input.quantityBase,
    unitCostXaf,
    valueXaf,
    fromBalanceAfter,
    toBalanceAfter,
  };
}

/**
 * Point d'entrée principal : résout automatiquement le lot par FIFO (BR-STK-050) quand
 * `lotId` est omis et que la source est un emplacement physique (une sortie réelle) — peut
 * alors produire **plusieurs** mouvements (un par lot traversé). Sinon, un seul mouvement.
 */
export async function recordStockMove(
  uow: Transaction<DB>,
  deps: RecordMoveDeps,
  input: RecordMoveInput,
): Promise<readonly RecordedMove[]> {
  if (input.lotId !== undefined) {
    return [await recordSingleMove(uow, deps, { ...input, lotId: input.lotId })];
  }

  const endpoints = MOVE_TYPE_ENDPOINTS[input.moveType];
  const fromIsPhysicalOutflow = endpoints.from === 'PHYSICAL';
  if (!fromIsPhysicalOutflow) {
    // Entrée depuis un emplacement virtuel : pas de sélection FIFO à faire ici (le lot, s'il
    // existe, est déjà connu de l'appelant — ex. réception avec lot fournisseur explicite).
    return [await recordSingleMove(uow, deps, { ...input, lotId: null })];
  }

  const lotRows = await uow
    .selectFrom('inventory_stock_balances')
    .innerJoin(
      'inventory_stock_lots',
      'inventory_stock_lots.id',
      'inventory_stock_balances.lot_key',
    )
    .select([
      'inventory_stock_lots.id as lot_id',
      'inventory_stock_balances.qty_on_hand as qty_on_hand',
      'inventory_stock_lots.fifo_rank_at as fifo_rank_at',
    ])
    .where('inventory_stock_balances.location_id', '=', toBin(input.fromLocationId))
    .where('inventory_stock_balances.product_id', '=', toBin(input.productId))
    .where('inventory_stock_balances.qty_on_hand', '>', '0')
    .where('inventory_stock_lots.status', '=', 'OPEN')
    .orderBy('inventory_stock_lots.fifo_rank_at', 'asc')
    .execute();

  if (lotRows.length === 0) {
    // Produit sans lot en solde ici (soit non suivi par lot, soit rupture totale) : un seul
    // mouvement sans lot ; BR-STK-018/017 tranchent la négativité selon allowNegative.
    return [await recordSingleMove(uow, deps, { ...input, lotId: null })];
  }

  const selection = selectLotsFifo(
    lotRows.map((row) => ({
      lotId: fromBin(row.lot_id),
      qtyAvailable: Number(row.qty_on_hand),
      rankAt: row.fifo_rank_at,
    })),
    input.quantityBase,
  );

  const results: RecordedMove[] = [];
  for (const allocation of selection.allocations) {
    results.push(
      await recordSingleMove(uow, deps, {
        ...input,
        lotId: allocation.lotId,
        quantityBase: allocation.quantity,
      }),
    );
  }
  if (selection.shortfall > 0) {
    // BR-STK-018 : le fait physique est appliqué malgré tout, imputé au dernier lot consulté
    // (ou sans lot si aucun lot n'existait) — traçabilité statistique, pas exacte (D06 §7, L-07).
    const lastLotId = lotRows.length > 0 ? fromBin(lotRows[lotRows.length - 1]!.lot_id) : null;
    results.push(
      await recordSingleMove(uow, deps, {
        ...input,
        lotId: lastLotId,
        quantityBase: selection.shortfall,
      }),
    );
  }
  return results;
}
