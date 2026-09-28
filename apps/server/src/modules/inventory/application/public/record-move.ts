/**
 * `inventory.recordStockMove` (D06-STK §9, règle de frontière : « seul inventory écrit dans
 * ses tables. Les autres modules appellent son API interne… dans la même transaction que
 * leur propre document »). Registre en partie double (ADR-003, BR-STK-001 à 006) : une
 * quantité positive d'un produit d'un emplacement source vers un emplacement destination,
 * avec mise à jour de la projection de solde (INV-STK-01) dans la même transaction, et, pour
 * une entrée valorisée, recalcul du CMUP (AV-042, ADR-015).
 *
 * Coût figé du mouvement (ADR-015, ADR-027 ; P7-03) :
 * - inverse : coût du mouvement d'origine (BR-STK-052) ;
 * - mouvement d'un **lot biologique** (lot de stock d'origine `PRODUCTION_LOT` ou
 *   `INCUBATION_BATCH`) : coût déclaré s'il est fourni (entrée de production, rendement à 0),
 *   sinon **coût par tête** = coût restant du lot ÷ effectif non vendu (AV-097) ; la dernière
 *   sortie définitive emporte exactement le coût restant ; jamais de CMUP pour ces lots ;
 * - sortie d'un emplacement virtuel intermédiaire (`V_TRANSIT`, `V_PENDING_LOSS`) : valeur
 *   moyenne du solde de cet emplacement (la valeur entrée en ressort, rien ne dérive) ;
 * - entrée valorisée (réception, ouverture, gain d'inventaire) ou sortie de production avec coût
 *   déclaré (œufs au coût standard, découpes, AV-098, AV-032) : coût déclaré et recalcul du CMUP ;
 * - sinon : CMUP courant.
 */
import type { Transaction } from 'kysely';
import { sql } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import type { IdGenerator } from '@gic/domain';
import {
  costPerHeadXaf,
  lineAmountXaf,
  quantityFromDecimal,
  recalculateCmup,
  roundCmupToXaf,
  selectLotsFifo,
  unitCostXaf as unitCostOfValue,
  xaf,
} from '@gic/domain';
import {
  toBin,
  toBinOrNull,
  fromBin,
  fromBinOrNull,
} from '../../../../platform/kysely/uuid-columns.js';
import { findProductLotTracking } from '../../../catalog/application/public/index.js';
import { toDbBool } from '../../../../platform/kysely/bool-column.js';
import { recordChanges } from '../../../../platform/sync/change-feed.js';
import { stockBalanceChange } from '../sync-changes.js';
import { lotHeadcount } from './lot-headcount.js';

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
  'SLAUGHTER',
  'LOT_TRANSFER',
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
  /** Requis pour une entrée valorisée (réception, ouverture, gain d'inventaire) ; accepté pour une
   * sortie de production (`PRODUCTION_OUTPUT`) et pour tout mouvement d'un lot biologique
   * (P7-03) ; ignoré sinon (CMUP courant utilisé). */
  readonly declaredUnitCostXaf?: number;
  /** Valeur exacte du mouvement (répartition au franc d'un abattage, P7-03) : le coût unitaire
   * figé en est déduit (arrondi), la valeur n'est pas recalculée. */
  readonly declaredValueXaf?: number;
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
   * alors celui du mouvement d'origine, lu en base (BR-STK-052), jamais le CMUP courant ; même
   * produit, lot et quantité, extrémités échangées (INV-STK-04, `checkReversal`). N'est pas
   * une entrée valorisée (pas de recalcul CMUP), même si le mouvement d'origine en était une.
   */
  readonly reversesMoveId?: string;
  /** Facultatif : s'il est fourni, doit égaler le coût du mouvement d'origine. */
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
 * BR-STK-050, INV-STK-13 (D06 §8 : `LOT_REQUIRED`, `LOT_MISMATCH`) : produit `REQUIRED` ⇒ lot
 * porté ; produit `NONE` ⇒ jamais de lot ; un lot porté existe et appartient au produit (ou
 * couvre plusieurs produits : `stock_lots.product_id` nul). Exception assumée (DÉDUIT) : un fait
 * hors ligne (`allowNegative`) sans lot résoluble — sortie d'un produit `REQUIRED` sans aucun
 * lot en solde — est appliqué sans lot plutôt que rejeté (BR-SYN-007, INV-STK-05 priment : le
 * fait physique existe) ; la traçabilité de ce mouvement reste alors statistique.
 */
async function checkLot(uow: Transaction<DB>, input: SingleMoveInput): Promise<void> {
  const tracking = await findProductLotTracking(uow, input.productId);
  if (tracking === undefined) {
    throw new InventoryMoveError('Produit introuvable.', 'PRODUCT_INVALID');
  }
  if (input.lotId === null) {
    if (tracking === 'REQUIRED' && !input.allowNegative) {
      throw new InventoryMoveError(
        'Ce produit est suivi par lot : le lot est obligatoire (BR-STK-050).',
        'LOT_REQUIRED',
      );
    }
    return;
  }
  if (tracking === 'NONE') {
    throw new InventoryMoveError(
      'Ce produit n’est pas suivi par lot : aucun lot ne peut être porté (BR-STK-050).',
      'LOT_MISMATCH',
    );
  }
  const lot = await uow
    .selectFrom('inventory_stock_lots')
    .select('product_id')
    .where('id', '=', toBin(input.lotId))
    .executeTakeFirst();
  if (!lot || (lot.product_id !== null && fromBin(lot.product_id) !== input.productId)) {
    throw new InventoryMoveError('Lot inconnu ou d’un autre produit.', 'LOT_MISMATCH');
  }
}

/**
 * INV-STK-04 : un inverse porte le même produit, le même lot et la même quantité que le
 * mouvement d'origine, en échange sa source et sa destination, et ne peut exister qu'une fois
 * (`UNIQUE (reverses_move_id)` en base — vérifié ici d'abord pour renvoyer une erreur métier
 * plutôt qu'une violation de contrainte). Renvoie le coût du mouvement d'origine (BR-STK-052) :
 * lu en base, jamais pris de l'appelant (`reversedUnitCostXaf`, s'il est fourni, doit concorder).
 */
async function checkReversal(
  uow: Transaction<DB>,
  input: SingleMoveInput,
  reversesMoveId: string,
): Promise<number> {
  const original = await uow
    .selectFrom('inventory_stock_moves')
    .select([
      'product_id',
      'lot_id',
      'quantity',
      'from_location_id',
      'to_location_id',
      'unit_cost_xaf',
    ])
    .where('id', '=', toBin(reversesMoveId))
    .executeTakeFirst();
  if (!original) {
    throw new InventoryMoveError('Mouvement d’origine introuvable.', 'REVERSAL_INVALID');
  }
  const sameLot = (fromBinOrNull(original.lot_id) ?? null) === (input.lotId ?? null);
  const sameQuantity = Math.abs(Number(original.quantity) - input.quantityBase) < 0.0005;
  const swapped =
    fromBin(original.from_location_id) === input.toLocationId &&
    fromBin(original.to_location_id) === input.fromLocationId;
  if (fromBin(original.product_id) !== input.productId || !sameLot || !sameQuantity || !swapped) {
    throw new InventoryMoveError(
      'Un inverse porte le même produit, lot et quantité, source et destination échangées (INV-STK-04).',
      'REVERSAL_INVALID',
    );
  }
  if (
    input.reversedUnitCostXaf !== undefined &&
    input.reversedUnitCostXaf !== original.unit_cost_xaf
  ) {
    throw new InventoryMoveError(
      'Le coût d’un inverse est celui du mouvement d’origine (BR-STK-052).',
      'REVERSAL_INVALID',
    );
  }
  const alreadyReversed = await uow
    .selectFrom('inventory_stock_moves')
    .select('id')
    .where('reverses_move_id', '=', toBin(reversesMoveId))
    .executeTakeFirst();
  if (alreadyReversed) {
    throw new InventoryMoveError(
      'Ce mouvement a déjà été inversé (INV-STK-04).',
      'REVERSAL_INVALID',
    );
  }
  return original.unit_cost_xaf;
}

/** Emplacements virtuels de sortie définitive d'un lot (vente, transformation, retour fournisseur). */
const EXIT_LOCATION_TYPES = ['V_CUSTOMER', 'V_PRODUCTION', 'V_SUPPLIER'] as const;

interface BiologicalLot {
  readonly costObjectType: 'PRODUCTION_LOT' | 'INCUBATION_BATCH';
  readonly costObjectId: string;
  readonly status: string;
}

/** Lot de stock d'un lot de production ou d'incubation (ADR-027), sinon `null`. */
async function biologicalLotOf(uow: Transaction<DB>, lotId: string): Promise<BiologicalLot | null> {
  const lot = await uow
    .selectFrom('inventory_stock_lots')
    .select(['origin_type', 'origin_id', 'status'])
    .where('id', '=', toBin(lotId))
    .executeTakeFirst();
  if (
    !lot ||
    lot.origin_id === null ||
    (lot.origin_type !== 'PRODUCTION_LOT' && lot.origin_type !== 'INCUBATION_BATCH')
  ) {
    return null;
  }
  return {
    costObjectType: lot.origin_type,
    costObjectId: fromBin(lot.origin_id),
    status: lot.status,
  };
}

/**
 * Coût restant d'un lot biologique (AV-097, ADR-027) : Σ écritures de coût du lot (débits −
 * crédits) − Σ valeurs figées de ses sorties définitives (vers `V_CUSTOMER`, `V_PRODUCTION`,
 * `V_SUPPLIER`, hors inverses) + Σ valeurs de leurs inverses. La mortalité et les écarts
 * d'inventaire ne le réduisent pas (BR-PRD-013).
 */
async function lotRemainingCostXaf(
  uow: Transaction<DB>,
  lotId: string,
  lot: BiologicalLot,
): Promise<number> {
  const costs = await uow
    .selectFrom('inventory_cost_entries')
    .select(
      sql<string>`COALESCE(SUM(CASE WHEN direction = 'DEBIT' THEN amount_xaf ELSE -amount_xaf END), 0)`.as(
        'net',
      ),
    )
    .where('cost_object_type', '=', lot.costObjectType)
    .where('cost_object_id', '=', toBin(lot.costObjectId))
    .executeTakeFirstOrThrow();
  const exits = await uow
    .selectFrom('inventory_stock_moves as m')
    .innerJoin('organization_locations as fl', 'fl.id', 'm.from_location_id')
    .innerJoin('organization_locations as tl', 'tl.id', 'm.to_location_id')
    .select(
      sql<string>`COALESCE(SUM(
        CASE WHEN m.is_reversal = 0 AND tl.location_type IN ('V_CUSTOMER', 'V_PRODUCTION', 'V_SUPPLIER') THEN m.value_xaf
             WHEN m.is_reversal = 1 AND fl.location_type IN ('V_CUSTOMER', 'V_PRODUCTION', 'V_SUPPLIER') THEN -m.value_xaf
             ELSE 0 END), 0)`.as('value'),
    )
    .where('m.lot_id', '=', toBin(lotId))
    .executeTakeFirstOrThrow();
  return Number(costs.net) - Number(exits.value);
}

/**
 * Coût par tête courant d'un lot biologique (ADR-027) : coût restant ÷ effectif non vendu,
 * arrondi au franc ; `null` si le lot n'est pas un lot de production ou d'incubation (P7-03 :
 * valorisation des écarts d'inventaire sur des animaux).
 */
export async function biologicalLotUnitCostXaf(
  uow: Transaction<DB>,
  lotId: string,
): Promise<number | null> {
  const lot = await biologicalLotOf(uow, lotId);
  if (lot === null) return null;
  const remaining = await lotRemainingCostXaf(uow, lotId, lot);
  const headcount = await lotHeadcount(uow, { lotId, scope: 'UNSOLD' });
  return costPerHeadXaf(Math.max(0, remaining), quantityFromDecimal(Math.max(0, headcount))) ?? 0;
}

/**
 * Coût restant d'un lot biologique (ADR-027) ; `null` pour un autre lot. À la clôture d'un lot
 * (effectif nul), c'est le coût que ses sorties n'ont pas emporté (mortalité en fin de lot).
 */
export async function biologicalLotRemainingCostXaf(
  uow: Transaction<DB>,
  lotId: string,
): Promise<number | null> {
  const lot = await biologicalLotOf(uow, lotId);
  return lot === null ? null : lotRemainingCostXaf(uow, lotId, lot);
}

/** Valeur moyenne d'un solde d'emplacement virtuel intermédiaire (qté > 0), sinon `null`. */
async function virtualBalanceCost(
  uow: Transaction<DB>,
  key: { readonly locationId: string; readonly productId: string; readonly lotKey: Buffer },
): Promise<{ readonly qty: number; readonly valueXaf: number } | null> {
  const row = await uow
    .selectFrom('inventory_stock_balances')
    .select(['qty_on_hand', 'value_xaf'])
    .where('location_id', '=', toBin(key.locationId))
    .where('product_id', '=', toBin(key.productId))
    .where('lot_key', '=', key.lotKey)
    .executeTakeFirst();
  if (!row || Number(row.qty_on_hand) <= 0) return null;
  return { qty: Number(row.qty_on_hand), valueXaf: Number(row.value_xaf) };
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
  await checkLot(uow, input);

  const isReversal = input.reversesMoveId !== undefined;
  const biological = input.lotId !== null ? await biologicalLotOf(uow, input.lotId) : null;
  // INV-PRD-02 : aucun nouveau mouvement sur le lot d'un lot de production clôturé, sauf fait
  // hors ligne tardif (appliqué ; le module appelant consigne le conflit `LOT_CLOSED`) et inverse.
  if (biological?.status === 'CLOSED' && !isReversal && !input.allowNegative) {
    throw new InventoryMoveError(
      'Lot clôturé : aucun nouveau mouvement (INV-PRD-02).',
      'LOT_CLOSED',
    );
  }
  const isProductionOutputWithCost =
    input.moveType === 'PRODUCTION_OUTPUT' &&
    (input.declaredUnitCostXaf !== undefined || input.declaredValueXaf !== undefined);
  // Entrée qui recalcule le CMUP : jamais pour un lot biologique (un CMUP par produit mélangerait
  // les lots, ADR-027).
  const isValuationEntry =
    !isReversal &&
    biological === null &&
    (VALUATION_ENTRY_MOVE_TYPES.has(input.moveType) || isProductionOutputWithCost);
  const quantity = quantityFromDecimal(input.quantityBase);
  const lotKeyForCost = input.lotId ? toBin(input.lotId) : LOT_KEY_NULL;
  let unitCostXaf: number;
  let valueOverrideXaf: number | null = null;
  if (isReversal) {
    unitCostXaf = await checkReversal(uow, input, input.reversesMoveId!);
  } else if (input.declaredValueXaf !== undefined) {
    valueOverrideXaf = input.declaredValueXaf;
    unitCostXaf = unitCostOfValue(input.declaredValueXaf, quantity);
  } else if (
    input.declaredUnitCostXaf !== undefined &&
    (isValuationEntry || biological !== null || input.moveType === 'PRODUCTION_OUTPUT')
  ) {
    unitCostXaf = input.declaredUnitCostXaf;
  } else if (isValuationEntry) {
    throw new InventoryMoveError(
      'Un coût unitaire déclaré est requis pour une entrée valorisée.',
      'UNIT_COST_REQUIRED',
    );
  } else if (
    fromLocation.locationType === 'V_TRANSIT' ||
    fromLocation.locationType === 'V_PENDING_LOSS'
  ) {
    // La valeur entrée dans l'emplacement intermédiaire en ressort (P7-03).
    const pending = await virtualBalanceCost(uow, {
      locationId: input.fromLocationId,
      productId: input.productId,
      lotKey: lotKeyForCost,
    });
    if (pending && Math.abs(pending.qty - input.quantityBase) < 0.0005) {
      valueOverrideXaf = pending.valueXaf;
      unitCostXaf = unitCostOfValue(Math.max(0, pending.valueXaf), quantity);
    } else if (pending) {
      unitCostXaf = roundCmupToXaf(Math.max(0, pending.valueXaf) / pending.qty);
    } else {
      unitCostXaf = roundCmupToXaf((await currentCmup(uow, input.productId)).avgUnitCostXaf);
    }
  } else if (biological !== null) {
    // Coût par tête (AV-097) : coût restant ÷ effectif non vendu, avant ce mouvement.
    const remaining = await lotRemainingCostXaf(uow, input.lotId!, biological);
    const headcount = await lotHeadcount(uow, { lotId: input.lotId!, scope: 'UNSOLD' });
    const isExit = (EXIT_LOCATION_TYPES as readonly string[]).includes(toLocation.locationType);
    if (isExit && headcount > 0 && input.quantityBase >= headcount - 0.0005 && remaining > 0) {
      // Dernière sortie définitive : elle emporte exactement le coût restant.
      valueOverrideXaf = remaining;
      unitCostXaf = unitCostOfValue(remaining, quantity);
    } else {
      unitCostXaf =
        costPerHeadXaf(Math.max(0, remaining), quantityFromDecimal(Math.max(0, headcount))) ?? 0;
    }
  } else {
    unitCostXaf = (await currentCmup(uow, input.productId)).avgUnitCostXaf;
    unitCostXaf = roundCmupToXaf(unitCostXaf);
  }

  const valueXaf = valueOverrideXaf ?? lineAmountXaf(quantity, xaf(unitCostXaf));

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
      valueOverrideXaf !== null ? valueOverrideXaf / input.quantityBase : unitCostXaf,
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
