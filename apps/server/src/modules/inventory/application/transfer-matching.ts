/**
 * Réception d'un transfert expédié et rapprochement des réceptions sans document (P5-16 ; D06
 * BR-STK-021, BR-STK-024, BR-STK-025 ; SM-TRANSFER ; INV-STK-08 ; AV-177 à AV-181). Interne à
 * `inventory` : les gestionnaires de `commands/transfer-commands.ts`, la tâche de balayage
 * (`jobs/unmatched-transfer-sweep-job.ts`) et la décision `TRANSFER_DISCREPANCY` en sont les appelants.
 *
 * **Réception** (avec ou sans document) : chaque ligne prend sa quantité expédiée parmi les
 * mouvements d'expédition du transfert, dans l'ordre, et la réception en emporte le **lot** et la
 * **valeur** au prorata (`planTransferReceipt`, packages/domain) : le transit du transfert s'annule
 * exactement, en quantité, par lot et en valeur, même pour une expédition multi-lots (AV-179).
 *
 * **Rapprochement** d'une réception sans document (document `BLIND_RECEIPT`) avec une expédition de la
 * même paire (source, destination), en trois points :
 * 1. à l'application de la réception, si l'expédition est déjà connue (`immédiat`) : la réception est
 *    appliquée directement au transfert expédié ;
 * 2. à l'application de l'expédition, si la réception est arrivée avant (`différé`) : la réception
 *    non rapprochée, imputée sans document sur le transit de la paire, est contre-passée au coût
 *    d'origine puis le transfert est reçu au lot et à la valeur de l'expédition (requalification,
 *    AV-179 : un lot biologique reste exact et clôturable) ;
 * 3. par la tâche horaire `inventory.transfers.unmatched_sweep` : filet pour la concurrence, une
 *    politique de validation ajoutée après coup ou un rapprochement manqué ; elle ouvre aussi le
 *    conflit de délai `TRANSFER_UNMATCHED`.
 *
 * **Ordre de verrouillage**, commun à l'expédition, aux deux réceptions, au retour à la source et au
 * balayage :
 * 1. la **ligne-verrou de la paire** (`inventory_transfer_pair_locks`), toujours en premier : toute
 *    écriture qui fait naître, change ou consomme un candidat au rapprochement de la paire la tient ;
 *    les lectures qui la suivent sont donc à jour (l'instantané d'une transaction qui commence par ce
 *    verrou est pris après lui) ;
 * 2. les transferts `STANDARD` de la paire, puis les réceptions sans document de la paire (lectures
 *    verrouillantes forcées sur l'index de paire : seules les lignes de la paire sont verrouillées) ;
 * 3. leurs lignes (lecture verrouillante : jamais une ligne absente d'un instantané périmé) ;
 * 4. le compteur de numéros `TRF` du site source ;
 * 5. les soldes (`recordStockMove` : `V_TRANSIT`, source, destination), puis les quotas ;
 * 6. les demandes de validation et les conflits ;
 * 7. la tête de chaîne d'audit (pipeline, ou fin de la transaction du balayage).
 *
 * Un gestionnaire qui ne connaît la paire qu'en lisant le transfert (réception avec document,
 * expédition d'une demande, retour) fait cette lecture simple avant le verrou : les mouvements qu'il
 * relit ensuite le sont par lecture verrouillante (`FOR SHARE`), et une contre-passation qui ne
 * verrait pas son mouvement d'origine échoue en erreur transitoire (rejouée), jamais en silence.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import {
  allocateReceivedToLines,
  blindReceiptMatchModeOrDefault,
  businessDayOf,
  chooseBlindReceiptForDispatch,
  chooseDispatchForBlindReceipt,
  elapsedHours,
  isUnmatchedOverdue,
  planTransferReceipt,
  unmatchedHoursOrDefault,
  type BlindReceiptMatchMode,
  type ChosenMatch,
  type Clock,
  type DispatchPiece,
  type IdGenerator,
  type MatchCandidate,
  type ProductQuantityMilli,
} from '@gic/domain';
import type { DB } from '../../../platform/kysely/database.js';
import {
  fromBin,
  fromBinOrNull,
  toBin,
  toBinOrNull,
} from '../../../platform/kysely/uuid-columns.js';
import { jsonValue } from '../../../platform/kysely/json-value.js';
import { publishDetectionEvent } from '../../../platform/events/detection-events.js';
import { recordChanges } from '../../../platform/sync/change-feed.js';
import { recordConflict, resolveOpenConflicts } from '../../../platform/sync/conflicts.js';
import { recordAudit } from '../../../audit/record-audit.js';
import { currentSettingValue } from '../../organization/application/public/index.js';
import {
  decidablePolicyFor,
  requestApproval,
  type ActiveControlPolicy,
} from '../../approvals/application/public/index.js';
import {
  InventoryMoveError,
  lockPhysicalStockCouples,
  recordStockMove,
  type RecordMoveDeps,
} from './public/record-move.js';
import { virtualLocationId } from './commands/shared.js';
import { milliToText, quantityToMilli } from './allocation-ledger.js';
import { stockOwnerRole } from './allocation-consumption.js';
import { transferChanges } from './sync-changes.js';
import { detectionInstant, locationAlertInfos } from './inventory-alert-events.js';

type Uow = Transaction<DB>;

/** Index de paire (migration 20261010093000) : désigné par les lectures verrouillantes des candidats. */
const PAIR_INDEX = 'ix_inventory_stock_transfers_pair';

export interface TransferPair {
  readonly fromLocationId: string;
  readonly toLocationId: string;
}

export interface TransferHeader {
  readonly id: string;
  /** Numéro du document ; `null` pour une réception sans document pas encore enregistrée. */
  readonly docNumber: string | null;
  readonly kind: string;
  readonly status: string;
  readonly siteId: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly occurredAt: Date;
  readonly createdBy: string;
  readonly createdDeviceId: string | null;
  readonly commandId: string | null;
  readonly capturedOffline: boolean;
  readonly dispatchedBy: string | null;
  readonly dispatchedAt: Date | null;
  readonly receivedBy: string | null;
  readonly receivedAt: Date | null;
  readonly unmatchedSignalledAt: Date | null;
}

export interface TransferLineRow {
  readonly id: string;
  readonly transferId: string;
  readonly productId: string;
  readonly lotId: string | null;
  readonly unitCode: string;
  readonly dispatchedMilli: number | null;
  readonly receivedMilli: number | null;
}

interface RawHeader {
  readonly id: Buffer;
  readonly doc_number: string;
  readonly transfer_kind: string;
  readonly status: string;
  readonly site_id: Buffer;
  readonly from_location_id: Buffer;
  readonly to_location_id: Buffer;
  readonly occurred_at: Date;
  readonly created_by: Buffer;
  readonly created_device_id: Buffer | null;
  readonly command_id: Buffer | null;
  readonly captured_offline: number;
  readonly dispatched_by: Buffer | null;
  readonly dispatched_at: Date | null;
  readonly received_by: Buffer | null;
  readonly received_at: Date | null;
  readonly unmatched_signalled_at: Date | null;
}

const HEADER_COLUMNS = [
  'id',
  'doc_number',
  'transfer_kind',
  'status',
  'site_id',
  'from_location_id',
  'to_location_id',
  'occurred_at',
  'created_by',
  'created_device_id',
  'command_id',
  'captured_offline',
  'dispatched_by',
  'dispatched_at',
  'received_by',
  'received_at',
  'unmatched_signalled_at',
] as const;

function headerOf(row: RawHeader): TransferHeader {
  return {
    id: fromBin(row.id),
    docNumber: row.doc_number,
    kind: row.transfer_kind,
    status: row.status,
    siteId: fromBin(row.site_id),
    fromLocationId: fromBin(row.from_location_id),
    toLocationId: fromBin(row.to_location_id),
    occurredAt: row.occurred_at,
    createdBy: fromBin(row.created_by),
    createdDeviceId: fromBinOrNull(row.created_device_id),
    commandId: fromBinOrNull(row.command_id),
    capturedOffline: Boolean(row.captured_offline),
    dispatchedBy: fromBinOrNull(row.dispatched_by),
    dispatchedAt: row.dispatched_at,
    receivedBy: fromBinOrNull(row.received_by),
    receivedAt: row.received_at,
    unmatchedSignalledAt: row.unmatched_signalled_at,
  };
}

// --- Verrous -------------------------------------------------------------------------------------

/**
 * Ligne-verrou de la paire (étape 1 de l'ordre de verrouillage). L'upsert sans effet crée la ligne au
 * premier usage et pose le verrou exclusif en un aller-retour (même motif que
 * `DocumentSequenceService`) ; la lecture verrouillante qui suit le confirme.
 */
export async function lockTransferPair(uow: Uow, pair: TransferPair): Promise<void> {
  const from = toBin(pair.fromLocationId);
  const to = toBin(pair.toLocationId);
  await uow
    .insertInto('inventory_transfer_pair_locks')
    .values({ from_location_id: from, to_location_id: to })
    .onDuplicateKeyUpdate({ from_location_id: sql`from_location_id` })
    .execute();
  await uow
    .selectFrom('inventory_transfer_pair_locks')
    .select('from_location_id')
    .where('from_location_id', '=', from)
    .where('to_location_id', '=', to)
    .forUpdate()
    .executeTakeFirstOrThrow();
}

/** Lecture simple d'un transfert (paire, nature, statut), avant le verrou de paire. */
export async function peekTransfer(
  uow: Uow,
  transferId: string,
): Promise<TransferHeader | undefined> {
  const row = await uow
    .selectFrom('inventory_stock_transfers')
    .select([...HEADER_COLUMNS])
    .where('id', '=', toBin(transferId))
    .executeTakeFirst();
  return row ? headerOf(row) : undefined;
}

/** Un transfert, verrouillé (`FOR UPDATE`) et lu à jour. */
export async function lockTransferById(
  uow: Uow,
  transferId: string,
): Promise<TransferHeader | undefined> {
  const row = await uow
    .selectFrom('inventory_stock_transfers')
    .select([...HEADER_COLUMNS])
    .where('id', '=', toBin(transferId))
    .forUpdate()
    .executeTakeFirst();
  return row ? headerOf(row) : undefined;
}

/**
 * Documents d'une nature et d'un statut pour la paire, verrouillés (`FOR UPDATE`) sur l'index de paire
 * seul (aucun verrou sur les documents des autres paires), dans l'ordre (date, identifiant).
 */
export async function lockPairTransfers(
  uow: Uow,
  pair: TransferPair,
  kind: 'STANDARD' | 'BLIND_RECEIPT',
  status: 'DISPATCHED' | 'UNMATCHED',
): Promise<readonly TransferHeader[]> {
  const result = await sql<RawHeader>`
    SELECT ${sql.join(HEADER_COLUMNS.map((column) => sql.ref(column)))}
      FROM inventory_stock_transfers FORCE INDEX (${sql.raw(PAIR_INDEX)})
     WHERE to_location_id = ${toBin(pair.toLocationId)}
       AND from_location_id = ${toBin(pair.fromLocationId)}
       AND transfer_kind = ${kind}
       AND status = ${status}
     ORDER BY occurred_at, id
     FOR UPDATE`.execute(uow);
  return result.rows.map(headerOf);
}

/** Lignes des documents, verrouillées et lues à jour, par document, dans l'ordre des identifiants. */
export async function lockTransferLines(
  uow: Uow,
  transferIds: readonly string[],
): Promise<ReadonlyMap<string, readonly TransferLineRow[]>> {
  const byTransfer = new Map<string, TransferLineRow[]>(transferIds.map((id) => [id, []]));
  if (transferIds.length === 0) return byTransfer;
  const rows = await uow
    .selectFrom('inventory_stock_transfer_lines')
    .select([
      'id',
      'transfer_id',
      'product_id',
      'lot_id',
      'unit_code',
      'dispatched_qty_base',
      'received_qty_base',
    ])
    .where(
      'transfer_id',
      'in',
      transferIds.map((id) => toBin(id)),
    )
    .orderBy('transfer_id')
    .orderBy('id')
    .forUpdate()
    .execute();
  for (const row of rows) {
    const transferId = fromBin(row.transfer_id);
    byTransfer.get(transferId)?.push({
      id: fromBin(row.id),
      transferId,
      productId: fromBin(row.product_id),
      lotId: fromBinOrNull(row.lot_id),
      unitCode: row.unit_code,
      dispatchedMilli:
        row.dispatched_qty_base === null ? null : quantityToMilli(row.dispatched_qty_base),
      receivedMilli: row.received_qty_base === null ? null : quantityToMilli(row.received_qty_base),
    });
  }
  return byTransfer;
}

/** Mouvement d'un document de transfert, lu par lecture verrouillante partagée. */
export interface TransferMoveRow {
  readonly id: string;
  readonly moveType: string;
  readonly productId: string;
  readonly lotId: string | null;
  readonly quantityMilli: number;
  readonly unitCostXaf: number;
  readonly valueXaf: number;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly sourceLineId: string | null;
}

/**
 * Mouvements d'un document **encore actifs** (ni inverses, ni contre-passés), d'un type, dans l'ordre
 * d'écriture. Lecture verrouillante (`FOR SHARE`, seul le privilège SELECT est requis) : à jour même
 * dans une transaction dont l'instantané a été pris plus tôt.
 */
export async function activeDocumentMoves(
  uow: Uow,
  documentId: string,
  moveType: 'TRANSFER_DISPATCH' | 'TRANSFER_RECEIPT' | 'TRANSFER_DISCREPANCY',
): Promise<readonly TransferMoveRow[]> {
  const rows = await uow
    .selectFrom('inventory_stock_moves')
    .select([
      'id',
      'move_type',
      'product_id',
      'lot_id',
      'quantity',
      'unit_cost_xaf',
      'value_xaf',
      'from_location_id',
      'to_location_id',
      'source_line_id',
      'is_reversal',
      'reverses_move_id',
    ])
    .where('source_doc_type', '=', 'TRANSFER')
    .where('source_doc_id', '=', toBin(documentId))
    // Ordre d'écriture : celui du FIFO de l'expédition (lots dans l'ordre où ils sont sortis).
    .orderBy('recorded_at')
    .orderBy('id')
    .forShare()
    .execute();
  const reversed = new Set(
    rows
      .filter((row) => row.reverses_move_id !== null)
      .map((row) => fromBin(row.reverses_move_id!)),
  );
  return rows
    .filter(
      (row) => row.move_type === moveType && !row.is_reversal && !reversed.has(fromBin(row.id)),
    )
    .map((row) => ({
      id: fromBin(row.id),
      moveType: row.move_type,
      productId: fromBin(row.product_id),
      lotId: fromBinOrNull(row.lot_id),
      quantityMilli: quantityToMilli(row.quantity),
      unitCostXaf: Number(row.unit_cost_xaf),
      valueXaf: Number(row.value_xaf),
      fromLocationId: fromBin(row.from_location_id),
      toLocationId: fromBin(row.to_location_id),
      sourceLineId: fromBinOrNull(row.source_line_id),
    }));
}

/**
 * Contre-passe exactement des mouvements (même produit, lot, quantité, coût et valeur d'origine,
 * extrémités échangées, INV-STK-04) : retour à la source (expédition), requalification d'une
 * réception sans document. Un inverse qui ne voit pas son origine (instantané périmé) ou la voit déjà
 * inversée échoue : l'erreur est **transitoire** (commande rejouée, jamais un refus définitif ni un
 * effet partiel validé).
 */
export async function reverseTransferMoves(
  uow: Uow,
  deps: RecordMoveDeps,
  moves: readonly TransferMoveRow[],
  input: {
    readonly reverseType: 'TRANSFER_RECEIPT' | 'TRANSFER_DISPATCH';
    readonly documentId: string;
    readonly occurredAt: Date;
    readonly createdBy: string;
    readonly commandId: string | null;
    readonly capturedOffline: boolean;
  },
): Promise<void> {
  // ADR-038 N5 : soldes physiques de l'opération (l'extrémité non virtuelle de chaque mouvement), triés.
  await lockPhysicalStockCouples(
    uow,
    moves.flatMap((move) => [
      { locationId: move.fromLocationId, productId: move.productId },
      { locationId: move.toLocationId, productId: move.productId },
    ]),
  );
  for (const move of moves) {
    try {
      await recordStockMove(uow, deps, {
        productId: move.productId,
        lotId: move.lotId,
        quantityBase: move.quantityMilli / 1000,
        fromLocationId: move.toLocationId,
        toLocationId: move.fromLocationId,
        moveType: input.reverseType,
        occurredAt: input.occurredAt,
        sourceDocType: 'TRANSFER',
        sourceDocId: input.documentId,
        ...(move.sourceLineId !== null ? { sourceLineId: move.sourceLineId } : {}),
        createdBy: input.createdBy,
        ...(input.commandId !== null ? { commandId: input.commandId } : {}),
        capturedOffline: input.capturedOffline,
        allowNegative: true,
        reversesMoveId: move.id,
        reversedUnitCostXaf: move.unitCostXaf,
      });
    } catch (error) {
      if (error instanceof InventoryMoveError) {
        throw new Error(
          `Contre-passation du transfert ${input.documentId} à rejouer : ${error.message}`,
        );
      }
      throw error;
    }
  }
}

// --- Paramètres ----------------------------------------------------------------------------------

async function siteThenGlobalSetting(
  uow: Uow,
  key: string,
  siteId: string | null,
  at: Date,
): Promise<unknown> {
  if (siteId !== null) {
    const bySite = await currentSettingValue(uow, { key, scopeType: 'SITE', scopeId: siteId, at });
    if (bySite !== undefined) return bySite;
  }
  return currentSettingValue(uow, { key, scopeType: 'GLOBAL', scopeId: null, at });
}

/** `inventory.blind_receipt_match_mode` (AV-177) : réglage du site, à défaut global, `SUBSET` sinon. */
export async function blindReceiptMatchMode(
  uow: Uow,
  siteId: string | null,
  at: Date,
): Promise<BlindReceiptMatchMode> {
  return blindReceiptMatchModeOrDefault(
    await siteThenGlobalSetting(uow, 'inventory.blind_receipt_match_mode', siteId, at),
  );
}

/** `inventory.transfer_unmatched_hours` (BR-STK-024, AV-181) : site, à défaut global, 48 sinon. */
export async function transferUnmatchedHours(uow: Uow, siteId: string, at: Date): Promise<number> {
  return unmatchedHoursOrDefault(
    await siteThenGlobalSetting(uow, 'inventory.transfer_unmatched_hours', siteId, at),
  );
}

/**
 * Politique `TRANSFER_DISCREPANCY` applicable à un écart constaté à `at` ; à défaut, celle en vigueur
 * maintenant (une politique ajoutée après coup permet au balayage de rapprocher).
 */
export async function discrepancyPolicy(
  uow: Uow,
  at: Date,
  now: Date,
): Promise<ActiveControlPolicy | null> {
  return (await decidablePolicyFor(uow, 'TRANSFER_DISCREPANCY', at, now)) ?? null;
}

// --- Réception d'un transfert expédié ------------------------------------------------------------

/** Lignes expédiées d'un transfert, cumulées par produit (règle d'éligibilité). */
export function dispatchedQuantities(
  lines: readonly TransferLineRow[],
): readonly ProductQuantityMilli[] {
  return lines
    .filter((line) => line.dispatchedMilli !== null)
    .map((line) => ({ productId: line.productId, quantityMilli: line.dispatchedMilli! }));
}

/** Lignes reçues d'une réception sans document, par produit. */
export function receivedQuantities(
  lines: readonly TransferLineRow[],
): readonly ProductQuantityMilli[] {
  return lines.map((line) => ({
    productId: line.productId,
    quantityMilli: line.receivedMilli ?? 0,
  }));
}

/** Écart (reçu < expédié) et excédent (reçu > expédié) d'une réception répartie par ligne. */
export function receiptShape(
  lines: readonly TransferLineRow[],
  receivedByLine: ReadonlyMap<string, number>,
): { readonly discrepancy: boolean; readonly overReceived: boolean } {
  let discrepancy = false;
  let overReceived = false;
  for (const line of lines) {
    if (line.dispatchedMilli === null) continue;
    const received = receivedByLine.get(line.id) ?? 0;
    if (received < line.dispatchedMilli) discrepancy = true;
    if (received > line.dispatchedMilli) overReceived = true;
  }
  return { discrepancy, overReceived };
}

export interface ReceiptApplication {
  readonly transfer: TransferHeader;
  readonly lines: readonly TransferLineRow[];
  /** Quantité reçue par ligne (millièmes) ; une ligne expédiée absente est reçue à 0. */
  readonly receivedByLine: ReadonlyMap<string, number>;
  readonly reasonByLine?: ReadonlyMap<string, string>;
  readonly receivedBy: string;
  readonly receivedAt: Date;
  readonly commandId: string | null;
  readonly capturedOffline: boolean;
  readonly deviceId: string | null;
  /** Obligatoire dès qu'il y a un écart (contrôlée par l'appelant **avant** toute écriture). */
  readonly policy: ActiveControlPolicy | null;
}

export interface ReceiptOutcome {
  readonly status: 'RECEIVED' | 'DISCREPANCY_PENDING';
  readonly overReceived: boolean;
  readonly approvalRequestId: string | null;
}

/**
 * Applique la réception d'un transfert `DISPATCHED` (SM-TRANSFER) : par produit, la répartition sur
 * les mouvements d'expédition (`planTransferReceipt`) donne les `TRANSFER_RECEIPT` (`V_TRANSIT` →
 * destination, lot et valeur de l'expédition), les `TRANSFER_DISCREPANCY` (`V_TRANSIT` →
 * `V_PENDING_LOSS`) et l'éventuel excédent (`TRANSFER_RECEIPT` sans mouvement d'expédition en face,
 * BR-STK-021). Le transfert passe `RECEIVED`, ou `DISCREPANCY_PENDING` avec une demande
 * `TRANSFER_DISCREPANCY` au nom du réceptionnaire.
 */
export async function applyTransferReceipt(
  uow: Uow,
  deps: RecordMoveDeps,
  input: ReceiptApplication,
): Promise<ReceiptOutcome> {
  const { transfer } = input;
  const shape = receiptShape(input.lines, input.receivedByLine);
  if (shape.discrepancy && input.policy === null) {
    throw new Error('applyTransferReceipt : écart sans politique TRANSFER_DISCREPANCY.');
  }
  const transit = await virtualLocationId(uow, 'V_TRANSIT');
  const pendingLoss = await virtualLocationId(uow, 'V_PENDING_LOSS');
  const dispatchMoves = await activeDocumentMoves(uow, transfer.id, 'TRANSFER_DISPATCH');

  const products = [...new Set(input.lines.map((line) => line.productId))];
  // Valeur de l'écart (au coût) : montrée au valideur, masquée sans droit de valorisation (RC-05).
  let discrepancyValueXaf = 0;
  // ADR-038 N5 : soldes de tous les produits de la destination, triés, avant le premier mouvement.
  await lockPhysicalStockCouples(
    uow,
    products.map((productId) => ({ locationId: transfer.toLocationId, productId })),
  );
  for (const productId of products) {
    const pieces: DispatchPiece[] = dispatchMoves
      .filter((move) => move.productId === productId)
      .map((move) => ({
        moveId: move.id,
        lotId: move.lotId,
        quantityMilli: move.quantityMilli,
        valueXaf: move.valueXaf,
      }));
    const lines = input.lines
      .filter((line) => line.productId === productId && line.dispatchedMilli !== null)
      .map((line) => ({
        lineId: line.id,
        dispatchedMilli: line.dispatchedMilli!,
        receivedMilli: input.receivedByLine.get(line.id) ?? 0,
        lotId: line.lotId,
      }));
    for (const planned of planTransferReceipt(pieces, lines)) {
      const recorded = await recordStockMove(uow, deps, {
        productId,
        lotId: planned.lotId,
        quantityBase: planned.quantityMilli / 1000,
        fromLocationId: transit,
        toLocationId: planned.kind === 'DISCREPANCY' ? pendingLoss : transfer.toLocationId,
        moveType: planned.kind === 'DISCREPANCY' ? 'TRANSFER_DISCREPANCY' : 'TRANSFER_RECEIPT',
        ...(planned.valueXaf !== null ? { declaredValueXaf: planned.valueXaf } : {}),
        occurredAt: input.receivedAt,
        sourceDocType: 'TRANSFER',
        sourceDocId: transfer.id,
        sourceLineId: planned.lineId,
        createdBy: input.receivedBy,
        ...(input.deviceId !== null ? { createdDeviceId: input.deviceId } : {}),
        ...(input.commandId !== null ? { commandId: input.commandId } : {}),
        capturedOffline: input.capturedOffline,
        allowNegative: true,
      });
      if (planned.kind === 'DISCREPANCY') {
        for (const move of recorded) discrepancyValueXaf += move.valueXaf;
      }
    }
  }

  for (const line of input.lines) {
    if (line.dispatchedMilli === null) continue;
    await uow
      .updateTable('inventory_stock_transfer_lines')
      .set({
        received_qty_base: milliToText(input.receivedByLine.get(line.id) ?? 0),
        discrepancy_reason_code_id: toBinOrNull(input.reasonByLine?.get(line.id) ?? null),
      })
      .where('id', '=', toBin(line.id))
      .execute();
  }

  let approvalRequestId: string | null = null;
  if (shape.discrepancy) {
    approvalRequestId = deps.idGenerator.newId();
    await requestApproval(uow, {
      requestId: approvalRequestId,
      operationType: 'TRANSFER_DISCREPANCY',
      subjectType: 'STOCK_TRANSFER',
      subjectId: transfer.id,
      // MP-11 (revue adverse) : le numéro du document, pas son identifiant technique.
      subjectSummary: `Écart de réception sur transfert ${transfer.docNumber ?? transfer.id}`,
      siteId: transfer.siteId,
      requestedBy: input.receivedBy,
      requestedAt: input.receivedAt,
      amountXaf: discrepancyValueXaf,
      policyId: input.policy!.id,
      policyVersion: input.policy!.version,
    });
  }
  const status = shape.discrepancy ? 'DISCREPANCY_PENDING' : 'RECEIVED';
  await uow
    .updateTable('inventory_stock_transfers')
    .set({
      status,
      received_by: toBin(input.receivedBy),
      received_at: input.receivedAt,
      approval_request_id: toBinOrNull(approvalRequestId),
      updated_by: toBin(input.receivedBy),
      version: sql`version + 1`,
    })
    .where('id', '=', toBin(transfer.id))
    .execute();
  await recordChanges(
    uow,
    transferChanges(transfer.id, transfer.fromLocationId, transfer.toLocationId),
  );
  return { status, overReceived: shape.overReceived, approvalRequestId };
}

/** Emplacement d'un transfert, pour le propriétaire de ses conflits (AV-142). */
export async function locationFacts(
  uow: Uow,
  locationId: string,
): Promise<{
  readonly id: string;
  readonly isVirtual: boolean;
  readonly status: string;
  readonly locationType: string;
  readonly siteId: string | null;
  readonly siteType: string | null;
  readonly custodyMode: string | null;
  readonly designatedDeviceId: string | null;
  readonly custodianUserId: string | null;
} | null> {
  const row = await uow
    .selectFrom('organization_locations as l')
    .leftJoin('organization_sites as s', 's.id', 'l.site_id')
    .select([
      'l.is_virtual as is_virtual',
      'l.status as status',
      'l.location_type as location_type',
      'l.site_id as site_id',
      's.site_type as site_type',
      'l.custody_mode as custody_mode',
      'l.designated_device_id as designated_device_id',
      'l.custodian_user_id as custodian_user_id',
    ])
    .where('l.id', '=', toBin(locationId))
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: locationId,
    isVirtual: Boolean(row.is_virtual),
    status: row.status,
    locationType: row.location_type,
    siteId: fromBinOrNull(row.site_id),
    siteType: row.site_type,
    custodyMode: row.custody_mode,
    designatedDeviceId: fromBinOrNull(row.designated_device_id),
    custodianUserId: fromBinOrNull(row.custodian_user_id),
  };
}

/** Rôle chargé des conflits d'un transfert : responsable du stock de l'emplacement expéditeur. */
export async function transferOwnerRole(uow: Uow, fromLocationId: string): Promise<string> {
  const from = await locationFacts(uow, fromLocationId);
  return from === null ? 'MAGASINIER' : stockOwnerRole(from.locationType, from.siteType);
}

/** Conflit informatif `TRANSFER_OVER_RECEIVED` (BR-STK-021) : excédent reçu, appliqué. */
export async function recordOverReceipt(
  uow: Uow,
  deps: { readonly idGenerator: IdGenerator },
  input: {
    readonly transfer: TransferHeader;
    readonly commandId: string | null;
    readonly blindReceiptId: string | null;
    readonly lines: readonly TransferLineRow[];
    readonly receivedByLine: ReadonlyMap<string, number>;
  },
): Promise<void> {
  await recordConflict(uow, {
    id: deps.idGenerator.newId(),
    commandId: input.commandId,
    conflictType: 'TRANSFER_OVER_RECEIVED',
    entityType: 'STOCK_TRANSFER',
    entityId: input.transfer.id,
    siteId: input.transfer.siteId,
    ownerRole: await transferOwnerRole(uow, input.transfer.fromLocationId),
    applied: true,
    details: {
      transferId: input.transfer.id,
      blindReceiptId: input.blindReceiptId,
      fromLocationId: input.transfer.fromLocationId,
      toLocationId: input.transfer.toLocationId,
      lines: input.lines
        .filter((line) => line.dispatchedMilli !== null)
        .map((line) => ({
          lineId: line.id,
          productId: line.productId,
          dispatched: milliToText(line.dispatchedMilli!),
          received: milliToText(input.receivedByLine.get(line.id) ?? 0),
        })),
    },
  });
}

// --- Rapprochement d'une réception sans document -------------------------------------------------

export interface PendingBlindReceipt {
  readonly header: TransferHeader;
  readonly lines: readonly TransferLineRow[];
}

export interface DispatchedTransfer {
  readonly header: TransferHeader;
  readonly lines: readonly TransferLineRow[];
}

function candidateOf(
  document: { readonly header: TransferHeader; readonly lines: readonly TransferLineRow[] },
  quantities: readonly ProductQuantityMilli[],
): MatchCandidate {
  return {
    id: document.header.id,
    at: document.header.dispatchedAt ?? document.header.occurredAt,
    lines: quantities,
  };
}

/** Expédition à rapprocher d'une réception sans document parmi celles de la paire (AV-177). */
export function chooseDispatch(
  receipt: PendingBlindReceipt,
  dispatches: readonly DispatchedTransfer[],
  mode: BlindReceiptMatchMode,
): { readonly dispatch: DispatchedTransfer; readonly match: ChosenMatch } | null {
  const match = chooseDispatchForBlindReceipt(
    receivedQuantities(receipt.lines),
    dispatches.map((dispatch) => candidateOf(dispatch, dispatchedQuantities(dispatch.lines))),
    mode,
  );
  if (match === null) return null;
  return { dispatch: dispatches.find((d) => d.header.id === match.id)!, match };
}

/** Réception sans document à rapprocher d'une expédition qui arrive (AV-177). */
export function chooseBlindReceipt(
  dispatch: DispatchedTransfer,
  receipts: readonly PendingBlindReceipt[],
  mode: BlindReceiptMatchMode,
): { readonly receipt: PendingBlindReceipt; readonly match: ChosenMatch } | null {
  const match = chooseBlindReceiptForDispatch(
    dispatchedQuantities(dispatch.lines),
    receipts.map((receipt) => ({
      id: receipt.header.id,
      at: receipt.header.occurredAt,
      lines: receivedQuantities(receipt.lines),
    })),
    mode,
  );
  if (match === null) return null;
  return { receipt: receipts.find((r) => r.header.id === match.id)!, match };
}

/** Réception d'une réception sans document répartie sur les lignes du transfert expédié. */
export function blindReceiptAllocation(
  receipt: PendingBlindReceipt,
  dispatch: DispatchedTransfer,
): ReadonlyMap<string, number> {
  return allocateReceivedToLines(
    receivedQuantities(receipt.lines),
    dispatch.lines
      .filter((line) => line.dispatchedMilli !== null)
      .map((line) => ({
        lineId: line.id,
        productId: line.productId,
        dispatchedMilli: line.dispatchedMilli!,
      })),
  );
}

export interface DeferredMatchInput {
  readonly receipt: PendingBlindReceipt;
  readonly dispatch: DispatchedTransfer;
  readonly policy: ActiveControlPolicy | null;
  /** Commande qui déclenche le rapprochement (expédition), `null` pour le balayage. */
  readonly triggerCommandId: string | null;
  /** Auteur de la clôture du conflit de délai (expéditeur ; balayage : expéditeur du transfert). */
  readonly resolvedBy: string;
  /** Instant serveur du rapprochement (`matched_at`). */
  readonly matchedAt: Date;
}

/**
 * Rapprochement **différé** (la réception est arrivée avant l'expédition) : réception du transfert
 * expédié au lot et à la valeur de l'expédition, datée de la réception et à son auteur (AV-179), puis
 * contre-passation exacte des réceptions sans document imputées sur le transit de la paire ; réception
 * `MATCHED` ; conflit de délai éventuel clos (`MERGE`, référence du transfert) ; excédent signalé. Les
 * écritures sont celles d'une réception, dans le même ordre de verrouillage.
 *
 * Les entrées d'abord (P5-23, revue adverse) : contre-passée la première, la réception sans document
 * faisait passer un instant le solde de la destination en négatif dès que des ventes l'avaient entamé,
 * ce qui ouvrait un faux `STOCK_NEGATIVE` (AV-215), voire un faux `ALLOCATION_OVERCOMMITTED`. Le transit,
 * virtuel, peut, lui, passer un instant en négatif. Seul un solde qui reste négatif (lot requalifié,
 * AV-179) ouvre encore son conflit.
 */
export async function applyDeferredMatch(
  uow: Uow,
  deps: RecordMoveDeps,
  input: DeferredMatchInput,
): Promise<ReceiptOutcome> {
  const { receipt, dispatch } = input;
  const unmatchedMoves = await activeDocumentMoves(uow, receipt.header.id, 'TRANSFER_RECEIPT');
  const receivedByLine = blindReceiptAllocation(receipt, dispatch);
  const outcome = await applyTransferReceipt(uow, deps, {
    transfer: dispatch.header,
    lines: dispatch.lines,
    receivedByLine,
    receivedBy: receipt.header.createdBy,
    receivedAt: receipt.header.occurredAt,
    commandId: input.triggerCommandId,
    capturedOffline: receipt.header.capturedOffline,
    deviceId: receipt.header.createdDeviceId,
    policy: input.policy,
  });
  await reverseTransferMoves(uow, deps, unmatchedMoves, {
    reverseType: 'TRANSFER_DISPATCH',
    documentId: receipt.header.id,
    occurredAt: receipt.header.occurredAt,
    createdBy: receipt.header.createdBy,
    commandId: input.triggerCommandId,
    capturedOffline: receipt.header.capturedOffline,
  });
  await markMatched(uow, receipt.header, dispatch.header.id, input.matchedAt);
  await resolveOpenConflicts(uow, {
    conflictType: 'TRANSFER_UNMATCHED',
    entityType: 'STOCK_TRANSFER',
    entityIds: [receipt.header.id],
    resolution: 'MERGE',
    resolvedBy: input.resolvedBy,
    resolvedAt: input.matchedAt,
    comment: 'Réception sans document rapprochée de son expédition (P5-16).',
    refs: [dispatch.header.id],
  });
  // P9-08 : le rapprochement tardif ferme l'alerte `TRANSFER_UNMATCHED` (sujet : la réception). Le
  // rapprochement immédiat (à l'enregistrement de la réception) n'a jamais levé d'alerte.
  await publishDetectionEvent(uow, deps.idGenerator, {
    eventType: 'BlindReceiptMatched',
    producerModule: 'inventory',
    aggregateType: 'STOCK_TRANSFER',
    aggregateId: receipt.header.id,
    occurredAt: detectionInstant(deps),
    payload: {
      receipt_id: receipt.header.id,
      transfer_id: dispatch.header.id,
      matched_by: input.resolvedBy,
      matched_at: input.matchedAt.toISOString(),
      site_id: receipt.header.siteId,
      business_day: businessDayOf(input.matchedAt),
    },
    ...(input.triggerCommandId !== null ? { commandId: input.triggerCommandId } : {}),
  });
  await publishTransferMatchedByBlindReceipt(uow, deps, {
    dispatch: dispatch.header,
    receiptId: receipt.header.id,
    status: outcome.status,
    matchedAt: input.matchedAt,
    commandId: input.triggerCommandId,
  });
  if (outcome.overReceived) {
    await recordOverReceipt(uow, deps, {
      transfer: dispatch.header,
      commandId: receipt.header.commandId,
      blindReceiptId: receipt.header.id,
      lines: dispatch.lines,
      receivedByLine,
    });
  }
  return outcome;
}

/**
 * P9-08 (AV-408) : l'expédition est reçue par le rapprochement d'une réception sans document. Les
 * résolveurs de `TRANSFER_NOT_RECEIVED` (commandes de réception, d'annulation, de refus et de retour)
 * portent l'identifiant de l'expédition ; le rapprochement, lui, est une commande de la **réception** :
 * sans cet événement, l'alerte attendrait la passe quotidienne suivante. Publié aux deux chemins de
 * rapprochement (immédiat à l'enregistrement de la réception, tardif).
 */
export async function publishTransferMatchedByBlindReceipt(
  uow: Uow,
  deps: RecordMoveDeps,
  input: {
    readonly dispatch: TransferHeader;
    readonly receiptId: string;
    readonly status: string;
    readonly matchedAt: Date;
    readonly commandId: string | null;
  },
): Promise<void> {
  await publishDetectionEvent(uow, deps.idGenerator, {
    eventType: 'TransferMatchedByBlindReceipt',
    producerModule: 'inventory',
    aggregateType: 'STOCK_TRANSFER',
    aggregateId: input.dispatch.id,
    occurredAt: detectionInstant(deps),
    payload: {
      transfer_id: input.dispatch.id,
      receipt_id: input.receiptId,
      status: input.status,
      site_id: input.dispatch.siteId,
      business_day: businessDayOf(input.matchedAt),
    },
    ...(input.commandId !== null ? { commandId: input.commandId } : {}),
  });
}

/** Réception sans document `UNMATCHED` → `MATCHED`, liée à son transfert (un seul, UNIQUE). */
export async function markMatched(
  uow: Uow,
  receipt: TransferHeader,
  transferId: string,
  matchedAt: Date,
): Promise<void> {
  await uow
    .updateTable('inventory_stock_transfers')
    .set({
      status: 'MATCHED',
      matched_transfer_id: toBin(transferId),
      matched_at: matchedAt,
      version: sql`version + 1`,
    })
    .where('id', '=', toBin(receipt.id))
    .execute();
  await recordChanges(
    uow,
    transferChanges(receipt.id, receipt.fromLocationId, receipt.toLocationId),
  );
}

/** Ce rapprochement exige-t-il une validation d'écart, et la politique est-elle là ? */
export async function matchPolicy(
  uow: Uow,
  receipt: PendingBlindReceipt,
  dispatch: DispatchedTransfer,
  now: Date,
): Promise<{ readonly allowed: boolean; readonly policy: ActiveControlPolicy | null }> {
  const shape = receiptShape(dispatch.lines, blindReceiptAllocation(receipt, dispatch));
  if (!shape.discrepancy) return { allowed: true, policy: null };
  const policy = await discrepancyPolicy(uow, receipt.header.occurredAt, now);
  return { allowed: policy !== null, policy };
}

// --- Balayage --------------------------------------------------------------------------------------

/** Paires lues par page (constante technique, pas un seuil métier) ; toutes les pages sont traitées. */
export const SWEEP_PAIR_PAGE = 200;

/** Paire dont le traitement a échoué (transaction annulée en entier, aucun effet partiel). */
export interface SweepFailure {
  readonly pair: TransferPair;
  readonly message: string;
}

export interface SweepResult {
  readonly pairs: number;
  readonly matched: number;
  readonly signalled: number;
  /** Paires en échec : les suivantes ont été traitées quand même ; l'appelant rejoue la tâche. */
  readonly failures: readonly SweepFailure[];
}

/**
 * `inventory.transfers.unmatched_sweep` : pour chaque paire qui a des réceptions sans document
 * `UNMATCHED`, une transaction propre (le verrou de paire en premier : lectures à jour, verrous
 * courts) ; une paire en échec est consignée dans `failures` (sa transaction est annulée en entier)
 * et les paires suivantes sont traitées quand même : c'est à l'appelant (la tâche) de lever à la fin
 * pour que la tâche soit rejouée, sans priver les autres paires du rapprochement ni du signalement :
 * 1. rapprochement glouton, la plus ancienne réception d'abord, sur les expéditions non encore
 *    rapprochées ; événement `StockTransferReceived` ou `StockTransferDiscrepancyDetected` et audit
 *    sous l'utilisateur système (action `inventory.transfer.auto_match`) ;
 * 2. réception restée `UNMATCHED` dont le délai est échu (paramètre du site du document) et encore
 *    jamais signalée : conflit informatif `TRANSFER_UNMATCHED` (responsable du stock expéditeur) et
 *    événement `StockTransferUnmatched`, une seule fois (`unmatched_signalled_at`).
 * Rejouable : aucun doublon de rapprochement (UNIQUE `matched_transfer_id`), de conflit ou
 * d'événement.
 */
export async function sweepUnmatchedTransfers(
  db: Kysely<DB>,
  deps: { readonly idGenerator: IdGenerator; readonly clock: Clock },
  options: { readonly pairs?: readonly TransferPair[] } = {},
): Promise<SweepResult> {
  const now = deps.clock.now();
  const pairs = options.pairs ?? (await pendingPairs(db));
  let matched = 0;
  let signalled = 0;
  const failures: SweepFailure[] = [];
  for (const pair of pairs) {
    try {
      const result = await db.transaction().execute((trx) => sweepPair(trx, deps, pair, now));
      matched += result.matched;
      signalled += result.signalled;
    } catch (error) {
      failures.push({ pair, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { pairs: pairs.length, matched, signalled, failures };
}

interface PairCursor {
  readonly from: Buffer;
  readonly to: Buffer;
}

/** Une page de paires qui ont des réceptions sans document `UNMATCHED`, après le curseur. */
async function pendingPairsPage(
  db: Kysely<DB>,
  cursor: PairCursor | null,
): Promise<ReadonlyArray<{ readonly from_location_id: Buffer; readonly to_location_id: Buffer }>> {
  return db
    .selectFrom('inventory_stock_transfers')
    .select(['from_location_id', 'to_location_id'])
    .where('transfer_kind', '=', 'BLIND_RECEIPT')
    .where('status', '=', 'UNMATCHED')
    .$if(cursor !== null, (qb) =>
      qb.where((eb) =>
        eb.or([
          eb('from_location_id', '>', cursor!.from),
          eb.and([
            eb('from_location_id', '=', cursor!.from),
            eb('to_location_id', '>', cursor!.to),
          ]),
        ]),
      ),
    )
    .groupBy(['from_location_id', 'to_location_id'])
    .orderBy('from_location_id')
    .orderBy('to_location_id')
    .limit(SWEEP_PAIR_PAGE)
    .execute();
}

/** Paires qui ont des réceptions sans document `UNMATCHED`, par pages ordonnées (lecture simple). */
async function pendingPairs(db: Kysely<DB>): Promise<readonly TransferPair[]> {
  const pairs: TransferPair[] = [];
  let cursor: PairCursor | null = null;
  for (;;) {
    const rows = await pendingPairsPage(db, cursor);
    for (const row of rows) {
      pairs.push({
        fromLocationId: fromBin(row.from_location_id),
        toLocationId: fromBin(row.to_location_id),
      });
    }
    if (rows.length < SWEEP_PAIR_PAGE) return pairs;
    const last = rows[rows.length - 1]!;
    cursor = { from: last.from_location_id, to: last.to_location_id };
  }
}

async function systemUserId(uow: Uow): Promise<string | null> {
  const row = await uow
    .selectFrom('identity_users')
    .select('id')
    .where('is_system', '=', 1)
    .orderBy('created_at')
    .limit(1)
    .executeTakeFirst();
  return row ? fromBin(row.id) : null;
}

async function sweepPair(
  uow: Uow,
  deps: { readonly idGenerator: IdGenerator; readonly clock: Clock },
  pair: TransferPair,
  now: Date,
): Promise<{ readonly matched: number; readonly signalled: number }> {
  await lockTransferPair(uow, pair);
  const dispatchHeaders = await lockPairTransfers(uow, pair, 'STANDARD', 'DISPATCHED');
  const receiptHeaders = await lockPairTransfers(uow, pair, 'BLIND_RECEIPT', 'UNMATCHED');
  if (receiptHeaders.length === 0) return { matched: 0, signalled: 0 };
  const lines = await lockTransferLines(uow, [
    ...dispatchHeaders.map((h) => h.id),
    ...receiptHeaders.map((h) => h.id),
  ]);
  let dispatches: DispatchedTransfer[] = dispatchHeaders.map((header) => ({
    header,
    lines: lines.get(header.id) ?? [],
  }));
  const autoMatches: Array<{
    readonly transferId: string;
    readonly receiptId: string;
    readonly receiptAuthor: string;
    readonly status: string;
    readonly siteId: string;
  }> = [];
  const stillUnmatched: PendingBlindReceipt[] = [];
  for (const header of receiptHeaders) {
    const receipt: PendingBlindReceipt = { header, lines: lines.get(header.id) ?? [] };
    const mode = await blindReceiptMatchMode(uow, header.siteId, now);
    const chosen = chooseDispatch(receipt, dispatches, mode);
    const allowed = chosen ? await matchPolicy(uow, receipt, chosen.dispatch, now) : null;
    if (!chosen || !allowed?.allowed) {
      stillUnmatched.push(receipt);
      continue;
    }
    const outcome = await applyDeferredMatch(uow, deps, {
      receipt,
      dispatch: chosen.dispatch,
      policy: allowed.policy,
      triggerCommandId: null,
      resolvedBy: chosen.dispatch.header.dispatchedBy ?? header.createdBy,
      matchedAt: now,
    });
    dispatches = dispatches.filter((d) => d.header.id !== chosen.dispatch.header.id);
    await uow
      .insertInto('platform_domain_events')
      .values({
        event_id: toBin(deps.idGenerator.newId()),
        event_type:
          outcome.status === 'RECEIVED'
            ? 'StockTransferReceived'
            : 'StockTransferDiscrepancyDetected',
        producer_module: 'inventory',
        aggregate_type: 'STOCK_TRANSFER',
        aggregate_id: toBin(chosen.dispatch.header.id),
        occurred_at: header.occurredAt,
        payload: jsonValue({
          transfer_id: chosen.dispatch.header.id,
          blind_receipt_id: header.id,
          status: outcome.status,
          over_received: outcome.overReceived,
          approval_request_id: outcome.approvalRequestId,
          matched_by: 'inventory.transfers.unmatched_sweep',
        }),
        command_id: null,
      })
      .execute();
    autoMatches.push({
      transferId: chosen.dispatch.header.id,
      receiptId: header.id,
      receiptAuthor: header.createdBy,
      status: outcome.status,
      siteId: chosen.dispatch.header.siteId,
    });
  }

  let signalled = 0;
  for (const receipt of stillUnmatched) {
    const { header } = receipt;
    if (header.unmatchedSignalledAt !== null) continue;
    const hours = await transferUnmatchedHours(uow, header.siteId, now);
    if (!isUnmatchedOverdue(header.occurredAt, now, hours)) continue;
    const details = {
      fromLocationId: header.fromLocationId,
      toLocationId: header.toLocationId,
      occurredAt: header.occurredAt.toISOString(),
      hours,
      lines: receipt.lines.map((line) => ({
        productId: line.productId,
        received: milliToText(line.receivedMilli ?? 0),
      })),
    };
    await recordConflict(uow, {
      id: deps.idGenerator.newId(),
      commandId: null,
      conflictType: 'TRANSFER_UNMATCHED',
      entityType: 'STOCK_TRANSFER',
      entityId: header.id,
      siteId: header.siteId,
      ownerRole: await transferOwnerRole(uow, header.fromLocationId),
      applied: true,
      details,
    });
    const destination = await locationFacts(uow, header.toLocationId);
    const labels = await locationAlertInfos(uow, [header.fromLocationId, header.toLocationId]);
    // P9-08 : numéro du document et délais lisibles dans le message ; au plus un événement par réception
    // (garde `unmatched_signalled_at`), sans passe : l'alerte se ferme au rapprochement tardif
    // (`BlindReceiptMatched`, publié sous l'identifiant de la réception).
    await publishDetectionEvent(uow, deps.idGenerator, {
      eventType: 'StockTransferUnmatched',
      producerModule: 'inventory',
      aggregateType: 'STOCK_TRANSFER',
      aggregateId: header.id,
      occurredAt: now,
      payload: {
        transfer_id: header.id,
        doc_number: header.docNumber,
        from_location_id: header.fromLocationId,
        to_location_id: header.toLocationId,
        from_location_label: labels.get(header.fromLocationId)?.name ?? null,
        to_location_label: labels.get(header.toLocationId)?.name ?? null,
        site_id: header.siteId,
        destination_site_id: destination?.siteId ?? null,
        occurred_at: header.occurredAt.toISOString(),
        // Seuil du paramètre ; le temps écoulé suit (le message affiche le temps écoulé).
        hours,
        hours_elapsed: elapsedHours(header.occurredAt, now),
        business_day: businessDayOf(now),
        lines: details.lines,
      },
    });
    await uow
      .updateTable('inventory_stock_transfers')
      .set({ unmatched_signalled_at: now })
      .where('id', '=', toBin(header.id))
      .execute();
    signalled += 1;
  }

  // Audit des rapprochements de la tâche en fin de transaction (tête de chaîne prise en dernier).
  if (autoMatches.length > 0) {
    const actor = await systemUserId(uow);
    for (const match of autoMatches) {
      await recordAudit(uow, deps, {
        occurredAt: now,
        actorUserId: actor ?? match.receiptAuthor,
        actorRoles: [],
        action: 'inventory.transfer.auto_match',
        entityType: 'STOCK_TRANSFER',
        entityId: match.transferId,
        siteId: match.siteId,
        after: { blindReceiptId: match.receiptId, status: match.status },
        result: 'SUCCESS',
      });
    }
  }
  return { matched: autoMatches.length, signalled };
}
