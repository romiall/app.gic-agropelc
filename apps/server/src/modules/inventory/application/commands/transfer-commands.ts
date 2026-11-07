/**
 * `inventory.transfer.*` (SM-TRANSFER, 04-workflows/machines-a-etats/03-stock.md). Natures
 * `STANDARD` (demande, refus, annulation, expédition, réception complète ou avec écart, retour à la
 * source), `INTERNAL` (déplacement immédiat) et `BLIND_RECEIPT` (réception sans document, P5-16) ;
 * décision d'approbation `TRANSFER_DISCREPANCY`.
 *
 * P5-16 (BR-STK-021, BR-STK-024, BR-STK-025 ; AV-177 à AV-181) :
 * - `inventory.transfer.receive` accepte deux charges utiles : avec document (`transferId`, lignes
 *   du transfert) ou **sans document** (`fromLocationId`, `toLocationId`, produits et quantités,
 *   `transferBlindReceivePayloadSchema`, packages/contracts) ;
 * - la réception d'un transfert expédié, avec ou sans document, se répartit sur les mouvements
 *   d'expédition : lot et valeur exacts (transfer-matching.ts) ;
 * - une réception sans document est rapprochée à son application, à l'arrivée de l'expédition ou par
 *   le balayage horaire ; non rapprochée, elle est imputée sur le transit de la paire ;
 * - `inventory.transfer.return_to_source` contre-passe l'expédition au coût d'origine (quota rendu) ;
 * - hors ligne, un fait physiquement contradictoire (seconde réception, réception d'un transfert
 *   retourné, retour d'un transfert reçu) est mis en quarantaine (`CONFLICT`), jamais rejeté ni
 *   appliqué deux fois (BR-SYN-007, INV-STK-03).
 * Ordre de verrouillage : transfer-matching.ts.
 */
import { z } from 'zod';
import { sql } from 'kysely';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import {
  blindReceiptMatch,
  businessDayOf,
  quantityFromDecimal,
  quantityMilliUnits,
} from '@gic/domain';
import type { IdGenerator } from '@gic/domain';
import {
  positiveQuantitySchema,
  receivedQuantitySchema,
  transferBlindReceivePayloadSchema,
  transferReturnToSourcePayloadSchema,
  type CommandEnvelope,
  type TransferBlindReceivePayload,
  type TransferReturnToSourcePayload,
  type WarningCode,
} from '@gic/contracts';
import {
  toBin,
  toBinOrNull,
  fromBin,
  fromBinOrNull,
} from '../../../../platform/kysely/uuid-columns.js';
import { DocumentSequenceService } from '../../../../platform/document-sequences/document-sequence.service.js';
import {
  decidablePolicyFor,
  type ApprovalDecisionHandlerRegistry,
} from '../../../approvals/application/public/index.js';
import { findProductLotTracking, findUnit } from '../../../catalog/application/public/index.js';
import { custodyAt } from '../../../organization/application/public/index.js';
import { recordChanges } from '../../../../platform/sync/change-feed.js';
import { recordConflict, resolveOpenConflicts } from '../../../../platform/sync/conflicts.js';
import { publishDetectionEvent } from '../../../../platform/events/detection-events.js';
import { quantityToMilli } from '../allocation-ledger.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import {
  lockPhysicalStockCouples,
  recordStockMove,
  type RecordMoveDeps,
} from '../public/record-move.js';
import { transferChanges } from '../sync-changes.js';
import { publishTransferEvent } from '../transfer-events.js';
import {
  custodyMismatch,
  locationAt,
  stockOwnerRole,
  type CustodyReason,
} from '../allocation-consumption.js';
import {
  activeDocumentMoves,
  applyDeferredMatch,
  applyTransferReceipt,
  blindReceiptAllocation,
  blindReceiptMatchMode,
  chooseBlindReceipt,
  chooseDispatch,
  dispatchedQuantities,
  locationFacts,
  lockPairTransfers,
  lockTransferById,
  lockTransferLines,
  lockTransferPair,
  matchPolicy,
  markMatched,
  publishTransferMatchedByBlindReceipt,
  peekTransfer,
  receiptShape,
  receivedQuantities,
  recordOverReceipt,
  reverseTransferMoves,
  transferOwnerRole,
  type DispatchedTransfer,
  type PendingBlindReceipt,
  type TransferHeader,
  type TransferLineRow,
  type TransferPair,
} from '../transfer-matching.js';
import {
  allocationWarnings,
  loadCommandOrigin,
  loadLocationSite,
  stockScopeAllowed,
  virtualLocationId,
  tryRecordMove,
  transferLocations,
  withStockScope,
} from './shared.js';

const lineInputSchema = z.object({
  productId: z.string().uuid(),
  unitCode: z.string().min(1).max(20),
  // Bornée à `numeric(14,3)` (P5-23, S-20) : au-delà, l'écriture échouait et la commande était rejouée sans fin.
  quantityBase: positiveQuantitySchema,
  lotId: z.string().uuid().optional(),
});

const requestPayloadSchema = z.object({
  fromLocationId: z.string().uuid(),
  toLocationId: z.string().uuid(),
  lines: z.array(lineInputSchema).min(1),
  notes: z.string().max(2000).optional(),
});
type RequestPayload = z.infer<typeof requestPayloadSchema>;

// SM-TRANSFER : un refus porte son motif (P5-23, S-40 : il était facultatif).
const declinePayloadSchema = z.object({
  transferId: z.string().uuid(),
  comment: z.string().trim().min(1).max(2000),
});
type DeclinePayload = z.infer<typeof declinePayloadSchema>;

const cancelPayloadSchema = z.object({ transferId: z.string().uuid() });
type CancelPayload = z.infer<typeof cancelPayloadSchema>;

const dispatchLineSchema = lineInputSchema.extend({ transferLineId: z.string().uuid().optional() });
const dispatchPayloadSchema = z
  .object({
    transferId: z.string().uuid().optional(),
    fromLocationId: z.string().uuid().optional(),
    toLocationId: z.string().uuid().optional(),
    lines: z.array(dispatchLineSchema).min(1),
    carrierUserId: z.string().uuid().optional(),
    carrierName: z.string().max(200).optional(),
    notes: z.string().max(2000).optional(),
  })
  .superRefine((data, ctx) => {
    if (
      data.transferId === undefined &&
      (data.fromLocationId === undefined || data.toLocationId === undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Expédition directe (sans transferId) : fromLocationId et toLocationId requis.',
      });
    }
  });
type DispatchPayload = z.infer<typeof dispatchPayloadSchema>;

/**
 * Réception avec document (P2-04) : lignes du transfert expédié. La quantité reçue est bornée à
 * `numeric(14,3)` (contrat partagé) : un excédent hors ligne démesuré est refusé en validation, il
 * ne fait pas échouer l'écriture (erreur SQL rejouée sans fin).
 */
const documentedReceivePayloadSchema = z.object({
  transferId: z.string().uuid(),
  lines: z
    .array(
      z.object({
        transferLineId: z.string().uuid(),
        receivedQtyBase: receivedQuantitySchema,
        discrepancyReasonCodeId: z.string().uuid().optional(),
      }),
    )
    .min(1),
});
type DocumentedReceivePayload = z.infer<typeof documentedReceivePayloadSchema>;

/** Avec document (`transferId`) ou sans document (BR-STK-024, schéma partagé et strict). */
const receivePayloadSchema = z.union([
  documentedReceivePayloadSchema,
  transferBlindReceivePayloadSchema,
]);
type ReceivePayload = DocumentedReceivePayload | TransferBlindReceivePayload;

// AV-520 : rapprochement manuel (l'agrégat est la réception sans document) et annulation motivée.
const matchBlindPayloadSchema = z.object({ transferId: z.string().uuid() });
type MatchBlindPayload = z.infer<typeof matchBlindPayloadSchema>;
const cancelBlindPayloadSchema = z.object({ reason: z.string().trim().min(1).max(500) });
type CancelBlindPayload = z.infer<typeof cancelBlindPayloadSchema>;

const moveInternalPayloadSchema = z.object({
  fromLocationId: z.string().uuid(),
  toLocationId: z.string().uuid(),
  lines: z.array(lineInputSchema).min(1),
  notes: z.string().max(2000).optional(),
});
type MoveInternalPayload = z.infer<typeof moveInternalPayloadSchema>;

function notFound(): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode: 'NOT_FOUND', messageFr: 'Transfert introuvable.' };
}
function badStatus(expected: string): CommandHandlerOutcome {
  return {
    status: 'REJECTED',
    errorCode: 'TRANSFER_STATUS_INVALID',
    messageFr: `Le transfert doit être au statut ${expected}.`,
  };
}
function rejected(errorCode: string, messageFr: string): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode, messageFr };
}
/**
 * S-36 (b) : le produit et l'unité de chaque ligne existent. Sans ce contrôle, une référence inconnue lèverait une violation
 * de clé étrangère à l'écriture de la ligne : exception technique, commande rejouée sans fin (`RETRY_LATER`) au lieu
 * d'un refus clair. Même contrôle que la réception sans document.
 */
async function unknownLineReference(
  uow: UnitOfWork,
  lines: readonly { readonly productId: string; readonly unitCode: string }[],
): Promise<CommandHandlerOutcome | undefined> {
  for (const line of lines) {
    if ((await findProductLotTracking(uow, line.productId)) === undefined) {
      return rejected('PRODUCT_INVALID', 'Produit introuvable.');
    }
    if ((await findUnit(uow, line.unitCode)) === undefined) {
      return rejected('UNIT_INVALID', `Unité inconnue : ${line.unitCode}.`);
    }
  }
  return undefined;
}

const LOCATION_INVALID = rejected('LOCATION_INVALID', 'Source et destination doivent différer.');
const INTERNAL_MOVE_OTHER_SITE = rejected(
  'LOCATION_INVALID',
  'Un mouvement interne relie deux emplacements du même site (BR-STK-022) ; sinon, un transfert.',
);
const INTERNAL_MOVE_CUSTODY = rejected(
  'INTERNAL_MOVE_CUSTODY',
  'Mouvement interne : emplacement sous la garde d’un autre détenteur (BR-STK-022, « même responsable ») ; passer par un transfert.',
);

/**
 * Garde d'un emplacement pour un mouvement interne (P5-23, S-40 ; BR-STK-022 « même responsable ») : un
 * emplacement exclusif à un autre utilisateur (stock mobile d'un commercial compris) ou désigné pour un
 * autre appareil n'est pas sous la garde de l'auteur.
 */
async function otherCustody(
  uow: UnitOfWork,
  locationId: string,
  author: { readonly userId: string; readonly deviceId: string | null },
  /** Hors ligne : date du fait, la garde en vigueur à cette date fait foi (P5-23, ADR-040). */
  at?: Date,
): Promise<boolean> {
  const row = await uow
    .selectFrom('organization_locations')
    .select(['custody_mode', 'custodian_user_id', 'designated_device_id'])
    .where('id', '=', toBin(locationId))
    .executeTakeFirst();
  if (!row) return false;
  const period = at === undefined ? undefined : await custodyAt(uow, locationId, at);
  const mode = period?.custodyMode ?? row.custody_mode;
  const custodian = fromBinOrNull(row.custodian_user_id);
  const designated =
    period !== undefined ? period.designatedDeviceId : fromBinOrNull(row.designated_device_id);
  if (mode === 'EXCLUSIVE_USER')
    return custodian !== null && custodian !== author.userId.toLowerCase();
  if (mode === 'EXCLUSIVE_DEVICE') {
    return designated !== null && designated !== author.deviceId?.toLowerCase();
  }
  return false;
}
const TRANSFER_ID_TAKEN = rejected(
  'TRANSFER_ID_TAKEN',
  'Cet identifiant désigne déjà un autre transfert.',
);

interface TransferRow {
  readonly id: Buffer;
  readonly status: string;
  readonly from_location_id: Buffer;
  readonly to_location_id: Buffer;
  readonly requested_by: Buffer | null;
}

/** Jeu `transfers` (P2-06) : à chaque changement d'état, une ligne par extrémité. */
async function recordTransferChanges(
  uow: UnitOfWork,
  row: {
    readonly id: Buffer;
    readonly from_location_id: Buffer;
    readonly to_location_id: Buffer;
  },
): Promise<void> {
  await recordChanges(
    uow,
    transferChanges(fromBin(row.id), fromBin(row.from_location_id), fromBin(row.to_location_id)),
  );
}

async function transferExists(uow: UnitOfWork, transferId: string): Promise<boolean> {
  const row = await uow
    .selectFrom('inventory_stock_transfers')
    .select('id')
    .where('id', '=', toBin(transferId))
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Rejeu d'une expédition directe déjà appliquée : même identifiant, même paire d'emplacements, même expéditeur **et
 * mêmes lignes** (produit et quantité). Le chargement par lots des pièces papier (PP-C) dérive l'identifiant de la
 * pièce : recharger le fichier renvoie la même expédition sous un autre `command_id`, qui doit être reconnue (rien
 * n'est refait) et non refusée comme un identifiant « pris ». Une autre expédition qui réutiliserait l'identifiant
 * (autre expéditeur, autre paire, autres lignes) n'est pas un rejeu : elle reste refusée, jamais avalée en silence.
 */
async function isDispatchReplay(
  uow: UnitOfWork,
  transferId: string,
  pair: TransferPair,
  author: string,
  lines: readonly { readonly productId: string; readonly quantityBase: number }[],
): Promise<boolean> {
  const row = await uow
    .selectFrom('inventory_stock_transfers')
    .select(['from_location_id', 'to_location_id', 'dispatched_by'])
    .where('id', '=', toBin(transferId))
    .executeTakeFirst();
  if (
    row === undefined ||
    row.dispatched_by === null ||
    fromBin(row.from_location_id).toLowerCase() !== pair.fromLocationId.toLowerCase() ||
    fromBin(row.to_location_id).toLowerCase() !== pair.toLocationId.toLowerCase() ||
    fromBin(row.dispatched_by).toLowerCase() !== author.toLowerCase()
  ) {
    return false;
  }
  const stored = await uow
    .selectFrom('inventory_stock_transfer_lines')
    .select(['product_id', 'dispatched_qty_base'])
    .where('transfer_id', '=', toBin(transferId))
    .execute();
  const keyOf = (productId: string, quantity: number): string =>
    `${productId.toLowerCase()}:${quantity}`;
  const expected = lines.map((line) => keyOf(line.productId, line.quantityBase)).sort();
  const actual = stored
    .map((line) => keyOf(fromBin(line.product_id), Number(line.dispatched_qty_base)))
    .sort();
  return expected.length === actual.length && expected.every((key, index) => key === actual[index]);
}

/** Réceptions sans document `UNMATCHED` de la paire, avec leurs lignes (verrouillées). */
async function pendingBlindReceipts(
  uow: UnitOfWork,
  pair: TransferPair,
): Promise<readonly PendingBlindReceipt[]> {
  const headers = await lockPairTransfers(uow, pair, 'BLIND_RECEIPT', 'UNMATCHED');
  const lines = await lockTransferLines(
    uow,
    headers.map((header) => header.id),
  );
  return headers.map((header) => ({ header, lines: lines.get(header.id) ?? [] }));
}

/**
 * Réception sans document `UNMATCHED` de la paire qui attend ce transfert expédié (même règle
 * d'éligibilité que le rapprochement, AV-177), ou `undefined`. Appelée sous le verrou de paire.
 */
async function awaitingBlindReceipt(
  uow: UnitOfWork,
  pair: TransferPair,
  transfer: TransferHeader,
  lines: readonly TransferLineRow[],
  at: Date,
): Promise<PendingBlindReceipt | undefined> {
  const receipts = await pendingBlindReceipts(uow, pair);
  if (receipts.length === 0) return undefined;
  const mode = await blindReceiptMatchMode(uow, transfer.siteId, at);
  return receipts.find(
    (receipt) =>
      blindReceiptMatch(receivedQuantities(receipt.lines), dispatchedQuantities(lines), mode) !==
      null,
  );
}

/** Quantité de base en millièmes ; `null` si elle porte plus de trois décimales. */
function milliOrNull(value: number): number | null {
  try {
    return quantityMilliUnits(quantityFromDecimal(value));
  } catch {
    return null;
  }
}

function buildTransferCommands(
  idGenerator: IdGenerator,
  documentSequences: DocumentSequenceService,
): {
  request: CommandHandler<RequestPayload>;
  decline: CommandHandler<DeclinePayload>;
  cancel: CommandHandler<CancelPayload>;
  dispatch: CommandHandler<DispatchPayload>;
  receive: CommandHandler<ReceivePayload>;
  returnToSource: CommandHandler<TransferReturnToSourcePayload>;
  moveInternal: CommandHandler<MoveInternalPayload>;
  matchBlind: CommandHandler<MatchBlindPayload>;
  cancelBlind: CommandHandler<CancelBlindPayload>;
} {
  const deps: RecordMoveDeps = { idGenerator };

  /**
   * Quarantaine d'un fait hors ligne physiquement contradictoire avec l'état du transfert (AV-180) :
   * aucun effet de stock, conflit `applied = false` au responsable du stock expéditeur.
   */
  async function quarantine(
    uow: UnitOfWork,
    envelope: CommandEnvelope<unknown>,
    transfer: TransferHeader,
    conflictType:
      'TRANSFER_OVER_RECEIVED' | 'TRANSFER_RETURN_CONFLICT' | 'TRANSFER_DISPATCH_CONFLICT',
    details: Record<string, unknown>,
  ): Promise<CommandHandlerOutcome> {
    const conflictId = idGenerator.newId();
    await recordConflict(uow, {
      id: conflictId,
      commandId: envelope.command_id,
      conflictType,
      entityType: 'STOCK_TRANSFER',
      entityId: transfer.id,
      siteId: transfer.siteId,
      ownerRole: await transferOwnerRole(uow, transfer.fromLocationId),
      applied: false,
      details: {
        status: transfer.status,
        receivedAt: transfer.receivedAt?.toISOString() ?? null,
        receivedBy: transfer.receivedBy,
        commandType: envelope.command_type,
        occurredAt: envelope.occurred_at,
        authorUserId: envelope.author_user_id,
        payload: envelope.payload,
        ...details,
      },
    });
    return { status: 'CONFLICT', conflictId };
  }

  const request: CommandHandler<RequestPayload> = async (uow, envelope) => {
    const { fromLocationId, toLocationId, lines } = envelope.payload;
    if (fromLocationId === toLocationId) return LOCATION_INVALID;
    // S-36 (a) : emplacements physiques existants, produits et unités connus — sinon la clé étrangère lèverait une
    // exception technique, la demande serait rejouée sans fin au lieu d'être refusée.
    const fromFacts = await locationFacts(uow, fromLocationId);
    const toFacts = await locationFacts(uow, toLocationId);
    if (
      !fromFacts ||
      !toFacts ||
      fromFacts.isVirtual ||
      toFacts.isVirtual ||
      fromFacts.siteId === null
    ) {
      return rejected('LOCATION_INVALID', 'Emplacements physiques existants attendus.');
    }
    const unknownReference = await unknownLineReference(uow, lines);
    if (unknownReference) return unknownReference;
    const occurredAt = new Date(envelope.occurred_at);
    const { siteId, codeSite } = await loadLocationSite(uow, fromLocationId);
    const origin = await loadCommandOrigin(uow, envelope.command_id);
    const docNumber = await documentSequences.next(uow, {
      docType: 'TRF',
      siteId,
      codeSite,
      year: Number(businessDayOf(occurredAt).slice(0, 4)),
    });
    const transferId = envelope.aggregate_id;

    await uow
      .insertInto('inventory_stock_transfers')
      .values({
        id: toBin(transferId),
        doc_number: docNumber,
        site_id: toBin(siteId),
        transfer_kind: 'STANDARD',
        from_location_id: toBin(fromLocationId),
        to_location_id: toBin(toLocationId),
        status: 'REQUESTED',
        requested_by: toBin(envelope.author_user_id),
        requested_at: occurredAt,
        notes: envelope.payload.notes ?? null,
        occurred_at: occurredAt,
        client_created_at: new Date(envelope.client_created_at),
        command_id: toBin(envelope.command_id),
        created_device_id: toBinOrNull(origin.deviceId),
        captured_offline: envelope.captured_offline ? 1 : 0,
        backdated_reason: envelope.backdated_reason,
        created_by: toBin(envelope.author_user_id),
      })
      .execute();

    for (const line of lines) {
      await uow
        .insertInto('inventory_stock_transfer_lines')
        .values({
          id: toBin(idGenerator.newId()),
          transfer_id: toBin(transferId),
          product_id: toBin(line.productId),
          lot_id: toBinOrNull(line.lotId ?? null),
          unit_code: line.unitCode,
          requested_qty_base: String(line.quantityBase),
        })
        .execute();
    }
    // P9-11 (3/3, AV-430) : la demande prévient les expéditeurs du site source.
    await publishTransferEvent(uow, {
      eventType: 'StockTransferRequested',
      transferId,
      actorUserId: envelope.author_user_id,
      occurredAt,
      commandId: envelope.command_id,
    });
    await recordChanges(uow, transferChanges(transferId, fromLocationId, toLocationId));
    // S-50 : le numéro du transfert (TRF) est rendu à l'appareil, comme celui d'une déclaration de perte.
    return { status: 'APPLIED', serverRefs: { docNumber } };
  };

  const decline: CommandHandler<DeclinePayload> = async (uow, envelope) => {
    const row = await uow
      .selectFrom('inventory_stock_transfers')
      .select(['id', 'status', 'from_location_id', 'to_location_id', 'notes'])
      .where('id', '=', toBin(envelope.payload.transferId))
      .executeTakeFirst();
    if (!row) return notFound();
    if (row.status !== 'REQUESTED') return badStatus('REQUESTED');

    // La note du demandeur est gardée ; le motif du refus la suit (aucune colonne dédiée).
    const refusal = `Refus : ${envelope.payload.comment}`;
    await uow
      .updateTable('inventory_stock_transfers')
      .set({
        status: 'DECLINED',
        notes: row.notes
          ? `${row.notes}
${refusal}`
          : refusal,
        updated_by: toBin(envelope.author_user_id),
        version: sql`version + 1`,
      })
      .where('id', '=', row.id)
      .execute();
    await recordTransferChanges(uow, row);
    return { status: 'APPLIED' };
  };

  const cancel: CommandHandler<CancelPayload> = async (uow, envelope) => {
    const row = await uow
      .selectFrom('inventory_stock_transfers')
      .select(['id', 'status', 'requested_by', 'from_location_id', 'to_location_id'])
      .where('id', '=', toBin(envelope.payload.transferId))
      .executeTakeFirst();
    if (!row) return notFound();
    if (row.status !== 'REQUESTED') return badStatus('REQUESTED');
    // UC-STK-07 (S-36 (c)) : le demandeur, ou qui peut expédier depuis le site source (le magasinier) ; un autre
    // utilisateur du site qui n'a que le droit de demande n'annule pas la demande d'autrui.
    if (
      fromBinOrNull(row.requested_by) !== envelope.author_user_id &&
      !(await stockScopeAllowed(uow, {
        userId: envelope.author_user_id,
        permissionCode: 'inventory.transfer.dispatch',
        occurredAt: new Date(envelope.occurred_at),
        locationIds: [fromBin(row.from_location_id)],
      }))
    ) {
      return rejected(
        'FORBIDDEN',
        'Seuls le demandeur et un expéditeur du site source peuvent annuler.',
      );
    }

    await uow
      .updateTable('inventory_stock_transfers')
      .set({
        status: 'CANCELLED',
        updated_by: toBin(envelope.author_user_id),
        version: sql`version + 1`,
      })
      .where('id', '=', row.id)
      .execute();
    await recordTransferChanges(uow, row);
    return { status: 'APPLIED' };
  };

  /**
   * Expédition (SM-TRANSFER `[*]`/`REQUESTED → DISPATCHED`). P5-16 : verrou de la paire en premier,
   * puis réceptions sans document de la paire (avant le numéro et les soldes) ; après les mouvements
   * d'expédition, rapprochement **différé** d'une réception arrivée avant (AV-177, AV-179).
   */
  const dispatch: CommandHandler<DispatchPayload> = async (uow, envelope) => {
    const occurredAt = new Date(envelope.occurred_at);
    const { transferId, fromLocationId, toLocationId, lines, carrierUserId, carrierName } =
      envelope.payload;

    let pair: TransferPair;
    if (transferId !== undefined) {
      const peek = await peekTransfer(uow, transferId);
      if (!peek) return notFound();
      pair = { fromLocationId: peek.fromLocationId, toLocationId: peek.toLocationId };
    } else {
      if (fromLocationId === toLocationId) return LOCATION_INVALID;
      pair = { fromLocationId: fromLocationId!, toLocationId: toLocationId! };
    }
    await lockTransferPair(uow, pair);
    const origin = await loadCommandOrigin(uow, envelope.command_id);

    let transfer: TransferRow;
    let receipts: readonly PendingBlindReceipt[];
    // P5-23 (S-40, AV-223) : hors ligne, la marchandise d'une demande refusée ou annulée depuis est partie —
    // fait accompli (BR-SYN-007), appliqué en expédition directe de la même paire, avec un conflit ; une
    // demande déjà expédiée (une expédition existe) est mise en quarantaine pour arbitrage, sans effet.
    let requestRow: TransferHeader | undefined;
    let closedRequest: TransferHeader | undefined;
    if (transferId !== undefined) {
      const row = await lockTransferById(uow, transferId);
      if (!row) return notFound();
      if (row.kind !== 'STANDARD' || row.status !== 'REQUESTED') {
        if (!envelope.captured_offline || row.kind !== 'STANDARD') return badStatus('REQUESTED');
        if (row.status !== 'DECLINED' && row.status !== 'CANCELLED') {
          return quarantine(uow, envelope, row, 'TRANSFER_DISPATCH_CONFLICT', {
            reason: 'REQUEST_ALREADY_DISPATCHED',
          });
        }
        closedRequest = row;
      } else {
        requestRow = row;
      }
    }
    // S-34 : le numéro du transfert (celui de la demande, ou le TRF tiré par une expédition directe).
    let transferDocNumber: string | null = null;
    if (requestRow !== undefined) {
      const row = requestRow;
      transferDocNumber = row.docNumber;
      receipts = await pendingBlindReceipts(uow, pair);
      transfer = {
        id: toBin(row.id),
        status: row.status,
        from_location_id: toBin(row.fromLocationId),
        to_location_id: toBin(row.toLocationId),
        requested_by: null,
      };

      await uow
        .updateTable('inventory_stock_transfers')
        .set({
          status: 'DISPATCHED',
          dispatched_by: toBin(envelope.author_user_id),
          dispatched_at: occurredAt,
          carrier_user_id: toBinOrNull(carrierUserId ?? null),
          carrier_name: carrierName ?? null,
          // S-21 : la note de l'expéditeur suit celle du demandeur (aucune colonne dédiée), comme le motif d'un refus.
          ...(envelope.payload.notes !== undefined
            ? { notes: sql<string>`CONCAT_WS(${'\n'}, notes, ${envelope.payload.notes})` }
            : {}),
          updated_by: toBin(envelope.author_user_id),
          version: sql`version + 1`,
        })
        .where('id', '=', transfer.id)
        .execute();
    } else {
      // S-36 (b) : produit et unité de chaque ligne existent (l'expédition d'une demande reprend ceux de la demande).
      const unknownReference = await unknownLineReference(uow, lines);
      if (unknownReference) return unknownReference;
      if (closedRequest === undefined && (await transferExists(uow, envelope.aggregate_id))) {
        return (await isDispatchReplay(
          uow,
          envelope.aggregate_id,
          pair,
          envelope.author_user_id,
          lines,
        ))
          ? { status: 'APPLIED' }
          : TRANSFER_ID_TAKEN;
      }
      receipts = await pendingBlindReceipts(uow, pair);
      // L'agrégat d'une expédition de demande est la demande : l'expédition directe qui la remplace a son
      // propre identifiant.
      const newTransferId = toBin(
        closedRequest !== undefined ? idGenerator.newId() : envelope.aggregate_id,
      );
      const { siteId, codeSite } = await loadLocationSite(uow, pair.fromLocationId);
      const docNumber = await documentSequences.next(uow, {
        docType: 'TRF',
        siteId,
        codeSite,
        year: Number(businessDayOf(occurredAt).slice(0, 4)),
      });
      transferDocNumber = docNumber;
      await uow
        .insertInto('inventory_stock_transfers')
        .values({
          id: newTransferId,
          doc_number: docNumber,
          site_id: toBin(siteId),
          transfer_kind: 'STANDARD',
          from_location_id: toBin(pair.fromLocationId),
          to_location_id: toBin(pair.toLocationId),
          status: 'DISPATCHED',
          dispatched_by: toBin(envelope.author_user_id),
          dispatched_at: occurredAt,
          carrier_user_id: toBinOrNull(carrierUserId ?? null),
          carrier_name: carrierName ?? null,
          notes:
            closedRequest !== undefined
              ? [
                  `Expédition hors ligne de la demande ${closedRequest.id} (${closedRequest.status} depuis).`,
                  envelope.payload.notes,
                ]
                  .filter((part) => part !== undefined)
                  .join(' ')
              : (envelope.payload.notes ?? null),
          occurred_at: occurredAt,
          client_created_at: new Date(envelope.client_created_at),
          command_id: toBin(envelope.command_id),
          created_device_id: toBinOrNull(origin.deviceId),
          captured_offline: envelope.captured_offline ? 1 : 0,
          backdated_reason: envelope.backdated_reason,
          created_by: toBin(envelope.author_user_id),
        })
        .execute();
      transfer = {
        id: newTransferId,
        status: 'DISPATCHED',
        from_location_id: toBin(pair.fromLocationId),
        to_location_id: toBin(pair.toLocationId),
        requested_by: null,
      };
    }
    const asRequest = requestRow !== undefined;

    const transitLocationId = await virtualLocationId(uow, 'V_TRANSIT');
    const dispatchWarnings = new Set<WarningCode>();
    // ADR-038 N5 : soldes de tous les produits de la source, triés, avant le premier mouvement.
    await lockPhysicalStockCouples(
      uow,
      lines.map((line) => ({
        locationId: fromBin(transfer.from_location_id),
        productId: line.productId,
      })),
    );
    for (const line of lines) {
      const moveResult = await tryRecordMove(() =>
        recordStockMove(uow, deps, {
          productId: line.productId,
          ...(line.lotId !== undefined ? { lotId: line.lotId } : {}),
          quantityBase: line.quantityBase,
          fromLocationId: fromBin(transfer.from_location_id),
          toLocationId: transitLocationId,
          moveType: 'TRANSFER_DISPATCH',
          occurredAt,
          sourceDocType: 'TRANSFER',
          sourceDocId: fromBin(transfer.id),
          createdBy: envelope.author_user_id,
          ...(origin.deviceId !== null ? { createdDeviceId: origin.deviceId } : {}),
          commandId: envelope.command_id,
          capturedOffline: envelope.captured_offline,
          allowNegative: envelope.captured_offline,
          consumesAllocation: true,
        }),
      );
      if (!moveResult.ok) return moveResult.outcome;
      for (const warning of allocationWarnings(moveResult.moves)) dispatchWarnings.add(warning);
      const dispatchedLotId = moveResult.moves[0]?.lotId ?? null;

      if (asRequest && line.transferLineId !== undefined) {
        await uow
          .updateTable('inventory_stock_transfer_lines')
          .set({
            dispatched_qty_base: String(line.quantityBase),
            lot_id: toBinOrNull(dispatchedLotId),
          })
          .where('id', '=', toBin(line.transferLineId))
          .execute();
      } else if (asRequest) {
        await uow
          .updateTable('inventory_stock_transfer_lines')
          .set({
            dispatched_qty_base: String(line.quantityBase),
            lot_id: toBinOrNull(dispatchedLotId),
          })
          .where('transfer_id', '=', transfer.id)
          .where('product_id', '=', toBin(line.productId))
          .execute();
      } else {
        await uow
          .insertInto('inventory_stock_transfer_lines')
          .values({
            id: toBin(idGenerator.newId()),
            transfer_id: transfer.id,
            product_id: toBin(line.productId),
            lot_id: toBinOrNull(dispatchedLotId),
            unit_code: line.unitCode,
            dispatched_qty_base: String(line.quantityBase),
          })
          .execute();
      }
    }

    await recordTransferChanges(uow, transfer);
    // P9-11 (3/3, AV-430) : l'expédition prévient les réceptionnaires du site destinataire.
    await publishTransferEvent(uow, {
      eventType: 'StockTransferDispatched',
      transferId: fromBin(transfer.id),
      actorUserId: envelope.author_user_id,
      occurredAt,
      commandId: envelope.command_id,
    });

    const serverRefs: Record<string, string> = {};
    if (transferDocNumber !== null) serverRefs['docNumber'] = transferDocNumber;
    if (closedRequest !== undefined) {
      serverRefs['transferId'] = fromBin(transfer.id);
      dispatchWarnings.add('TRANSFER_REQUEST_CLOSED');
      await recordConflict(uow, {
        id: idGenerator.newId(),
        commandId: envelope.command_id,
        conflictType: 'TRANSFER_REQUEST_CLOSED',
        entityType: 'STOCK_TRANSFER',
        entityId: fromBin(transfer.id),
        siteId: closedRequest.siteId,
        ownerRole: await transferOwnerRole(uow, pair.fromLocationId),
        applied: true,
        details: {
          requestId: closedRequest.id,
          requestStatus: closedRequest.status,
          transferId: fromBin(transfer.id),
          occurredAt: envelope.occurred_at,
          authorUserId: envelope.author_user_id,
        },
      });
    }

    // Rapprochement différé : une réception sans document de la paire attendait cette expédition.
    if (receipts.length > 0) {
      const header = await lockTransferById(uow, fromBin(transfer.id));
      const dispatched: DispatchedTransfer = {
        header: header!,
        lines: (await lockTransferLines(uow, [header!.id])).get(header!.id) ?? [],
      };
      const mode = await blindReceiptMatchMode(uow, header!.siteId, occurredAt);
      const chosen = chooseBlindReceipt(dispatched, receipts, mode);
      if (chosen) {
        const allowed = await matchPolicy(uow, chosen.receipt, dispatched, origin.receivedAt);
        if (allowed.allowed) {
          await applyDeferredMatch(uow, deps, {
            receipt: chosen.receipt,
            dispatch: dispatched,
            policy: allowed.policy,
            triggerCommandId: envelope.command_id,
            resolvedBy: envelope.author_user_id,
            matchedAt: origin.receivedAt,
          });
          serverRefs['matchedBlindReceiptId'] = chosen.receipt.header.id;
        }
      }
    }

    const refs = Object.keys(serverRefs).length > 0 ? { serverRefs } : {};
    return dispatchWarnings.size > 0
      ? { status: 'APPLIED_WITH_WARNINGS', warnings: [...dispatchWarnings], ...refs }
      : { status: 'APPLIED', ...refs };
  };

  /**
   * Réception **avec document** (SM-TRANSFER `DISPATCHED → RECEIVED | DISCREPANCY_PENDING`) : lignes
   * du transfert ; une ligne expédiée absente de la charge utile est reçue à 0 (écart). Au-delà de
   * l'expédié : refusée en ligne, appliquée hors ligne avec `TRANSFER_OVER_RECEIVED` (BR-STK-021).
   * Hors ligne, une seconde réception ou la réception d'un transfert retourné est mise en quarantaine.
   */
  async function receiveDocumented(
    uow: UnitOfWork,
    envelope: CommandEnvelope<DocumentedReceivePayload>,
  ): Promise<CommandHandlerOutcome> {
    const payload = envelope.payload;
    const peek = await peekTransfer(uow, payload.transferId);
    if (!peek) return notFound();
    if (peek.kind !== 'STANDARD') return badStatus('DISPATCHED');
    await lockTransferPair(uow, peek);
    const transfer = (await lockTransferById(uow, payload.transferId))!;
    const offline = envelope.captured_offline;
    if (transfer.status === 'RETURNED') {
      return offline
        ? quarantine(uow, envelope, transfer, 'TRANSFER_RETURN_CONFLICT', {
            reason: 'RECEIVED_AFTER_RETURN',
          })
        : badStatus('DISPATCHED');
    }
    if (['RECEIVED', 'DISCREPANCY_PENDING', 'CLOSED'].includes(transfer.status)) {
      return offline
        ? quarantine(uow, envelope, transfer, 'TRANSFER_OVER_RECEIVED', {
            reason: 'SECOND_RECEIPT',
          })
        : badStatus('DISPATCHED');
    }
    if (transfer.status !== 'DISPATCHED') return badStatus('DISPATCHED');

    const lines = (await lockTransferLines(uow, [transfer.id])).get(transfer.id) ?? [];
    // Une réception sans document de la paire attend déjà ce transfert (rapprochement refusé faute de
    // politique d'écart, ou course) : la recevoir aussi avec le document compterait deux fois la
    // marchandise (INV-STK-03). Même traitement que le retour (AV-180) : refus en ligne, quarantaine
    // hors ligne ; le balayage la rapprochera dès que la politique existe.
    const awaiting = await awaitingBlindReceipt(
      uow,
      peek,
      transfer,
      lines,
      new Date(envelope.occurred_at),
    );
    if (awaiting) {
      return offline
        ? quarantine(uow, envelope, transfer, 'TRANSFER_OVER_RECEIVED', {
            reason: 'BLIND_RECEIPT_PENDING',
            blindReceiptId: awaiting.header.id,
          })
        : rejected(
            'TRANSFER_STATUS_INVALID',
            'Une réception sans document attend ce transfert : il ne peut plus être reçu avec le document.',
          );
    }
    const receivedByLine = new Map<string, number>();
    const reasonByLine = new Map<string, string>();
    for (const line of payload.lines) {
      const row = lines.find((candidate) => candidate.id === line.transferLineId);
      if (!row || row.dispatchedMilli === null) {
        return rejected('NOT_FOUND', 'Ligne de transfert introuvable ou non expédiée.');
      }
      if (receivedByLine.has(row.id)) {
        return rejected('VALIDATION_ERROR:DUPLICATE_LINE', 'Une ligne ne se reçoit qu’une fois.');
      }
      const milli = milliOrNull(line.receivedQtyBase);
      if (milli === null) {
        return rejected('VALIDATION_ERROR:QUANTITY_INVALID', 'Trois décimales au plus.');
      }
      receivedByLine.set(row.id, milli);
      if (line.discrepancyReasonCodeId !== undefined) {
        reasonByLine.set(row.id, line.discrepancyReasonCodeId);
      }
    }
    const shape = receiptShape(lines, receivedByLine);
    if (shape.overReceived && !offline) {
      return rejected(
        'TRANSFER_OVER_RECEIVED',
        'Quantité reçue supérieure à la quantité expédiée (BR-STK-021).',
      );
    }
    const occurredAt = new Date(envelope.occurred_at);
    const origin = await loadCommandOrigin(uow, envelope.command_id);
    // Hors ligne, une politique révisée entre la réception réelle et l'envoi ne rend pas le fait refusé.
    const policy = shape.discrepancy
      ? ((await decidablePolicyFor(
          uow,
          'TRANSFER_DISCREPANCY',
          occurredAt,
          offline ? origin.receivedAt : undefined,
        )) ?? null)
      : null;
    if (shape.discrepancy && policy === null) {
      return rejected(
        'CONTROL_POLICY_MISSING',
        'Aucune politique de contrôle TRANSFER_DISCREPANCY configurée (approvals.policy.set).',
      );
    }
    const outcome = await applyTransferReceipt(uow, deps, {
      transfer,
      lines,
      receivedByLine,
      reasonByLine,
      receivedBy: envelope.author_user_id,
      receivedAt: occurredAt,
      commandId: envelope.command_id,
      capturedOffline: offline,
      deviceId: origin.deviceId,
      policy,
    });
    if (!outcome.overReceived) return { status: 'APPLIED' };
    await recordOverReceipt(uow, deps, {
      transfer,
      commandId: envelope.command_id,
      blindReceiptId: null,
      lines,
      receivedByLine,
    });
    return { status: 'APPLIED_WITH_WARNINGS', warnings: ['TRANSFER_OVER_RECEIVED'] };
  }

  /**
   * Réception **sans document** (BR-STK-024 ; SM-TRANSFER `[*] → UNMATCHED`) : document
   * `BLIND_RECEIPT` (numéro `TRF` du site source), rapproché sur-le-champ d'une expédition connue de la
   * paire (AV-177), sinon imputé sur le transit de la paire (`UNMATCHED`, avertissement
   * `TRANSFER_UNMATCHED`). Destination exclusive seulement : en ligne, refus ; hors ligne, fait
   * appliqué avec `CUSTODY_DEVICE_MISMATCH` (AV-178). Un produit suivi par lot sans lot indiqué n'est
   * reçu sans lot qu'à titre d'exception hors ligne (INV-STK-13), requalifié au rapprochement.
   */
  async function receiveBlind(
    uow: UnitOfWork,
    envelope: CommandEnvelope<TransferBlindReceivePayload>,
  ): Promise<CommandHandlerOutcome> {
    const payload = envelope.payload;
    const pair: TransferPair = {
      fromLocationId: payload.fromLocationId,
      toLocationId: payload.toLocationId,
    };
    await lockTransferPair(uow, pair);
    if (await transferExists(uow, envelope.aggregate_id)) return TRANSFER_ID_TAKEN;
    const from = await locationFacts(uow, payload.fromLocationId);
    const to = await locationFacts(uow, payload.toLocationId);
    if (!from || !to || from.isVirtual || to.isVirtual || from.siteId === null) {
      return rejected('LOCATION_INVALID', 'Emplacements physiques existants attendus.');
    }
    const offline = envelope.captured_offline;
    const lotHints = new Map<string, string>();
    const tracking = new Map<string, string>();
    for (const line of payload.lines) {
      const lotTracking = await findProductLotTracking(uow, line.productId);
      if (lotTracking === undefined) return rejected('PRODUCT_INVALID', 'Produit introuvable.');
      tracking.set(line.productId, lotTracking);
      if ((await findUnit(uow, line.unitCode)) === undefined) {
        return rejected('UNIT_INVALID', `Unité inconnue : ${line.unitCode}.`);
      }
      if (line.lotId !== undefined && lotTracking !== 'NONE') {
        const lot = await uow
          .selectFrom('inventory_stock_lots')
          .select('product_id')
          .where('id', '=', toBin(line.lotId))
          .executeTakeFirst();
        // Lot indicatif : ignoré s'il est inconnu ou d'un autre produit (comme `client_lot_hint`).
        if (lot && (lot.product_id === null || fromBin(lot.product_id) === line.productId)) {
          lotHints.set(line.productId, line.lotId);
        }
      }
    }
    // P5-23 (ADR-040) : hors ligne, la garde de la destination est celle de la date de la réception.
    const judged = offline ? await locationAt(uow, to, new Date(envelope.occurred_at)) : to;
    const exclusive =
      judged.custodyMode === 'EXCLUSIVE_DEVICE' || judged.custodyMode === 'EXCLUSIVE_USER';
    if (!exclusive && !offline) {
      return rejected(
        'BLIND_RECEIPT_NOT_ALLOWED',
        'Réception sans document réservée à un emplacement exclusif : recevoir avec le document (BR-STK-024).',
      );
    }
    const origin = await loadCommandOrigin(uow, envelope.command_id);
    let custodyReason: CustodyReason | null = exclusive ? null : 'LOCATION_NOT_EXCLUSIVE';
    if (exclusive && offline && origin.deviceId !== null) {
      custodyReason = await custodyMismatch(uow, { location: judged, deviceId: origin.deviceId });
    }

    const occurredAt = new Date(envelope.occurred_at);
    const receiptId = envelope.aggregate_id;
    const header: TransferHeader = {
      id: receiptId,
      docNumber: null,
      kind: 'BLIND_RECEIPT',
      status: 'UNMATCHED',
      siteId: from.siteId,
      fromLocationId: payload.fromLocationId,
      toLocationId: payload.toLocationId,
      occurredAt,
      createdBy: envelope.author_user_id,
      createdDeviceId: origin.deviceId,
      commandId: envelope.command_id,
      capturedOffline: offline,
      dispatchedBy: null,
      dispatchedAt: null,
      receivedBy: envelope.author_user_id,
      receivedAt: occurredAt,
      unmatchedSignalledAt: null,
    };
    const receiptLines: TransferLineRow[] = payload.lines.map((line) => ({
      id: idGenerator.newId(),
      transferId: receiptId,
      productId: line.productId,
      lotId: lotHints.get(line.productId) ?? null,
      unitCode: line.unitCode,
      dispatchedMilli: null,
      receivedMilli: quantityMilliUnits(quantityFromDecimal(line.receivedQtyBase)),
    }));
    const receipt: PendingBlindReceipt = { header, lines: receiptLines };

    // Candidats : expéditions de la paire (verrou de paire tenu, lectures verrouillantes à jour).
    const dispatchHeaders = await lockPairTransfers(uow, pair, 'STANDARD', 'DISPATCHED');
    const dispatchLines = await lockTransferLines(
      uow,
      dispatchHeaders.map((h) => h.id),
    );
    const dispatches: DispatchedTransfer[] = dispatchHeaders.map((h) => ({
      header: h,
      lines: dispatchLines.get(h.id) ?? [],
    }));
    const mode = await blindReceiptMatchMode(uow, from.siteId, occurredAt);
    const chosen = chooseDispatch(receipt, dispatches, mode);
    const allowed = chosen
      ? await matchPolicy(uow, receipt, chosen.dispatch, origin.receivedAt)
      : null;
    const matching = chosen !== null && allowed !== null && allowed.allowed ? chosen : null;
    // BR-STK-021 vaut aussi sans document : un excédent connu au rapprochement immédiat est refusé en
    // ligne, appliqué et signalé hors ligne (fait accompli, BR-SYN-007). Rapproché après coup
    // (expédition ou balayage), l'excédent est déjà un fait appliqué : reçu et signalé.
    if (matching !== null && matching.match.kind === 'OVER' && !offline) {
      return rejected(
        'TRANSFER_OVER_RECEIVED',
        'Quantité reçue supérieure à la quantité expédiée (BR-STK-021).',
      );
    }

    if (matching === null && !offline) {
      const missingLot = receiptLines.find(
        (line) => tracking.get(line.productId) === 'REQUIRED' && line.lotId === null,
      );
      if (missingLot) {
        return rejected(
          'LOT_REQUIRED',
          'Ce produit est suivi par lot : le lot est obligatoire (BR-STK-050).',
        );
      }
    }

    const { codeSite } = await loadLocationSite(uow, payload.fromLocationId);
    const docNumber = await documentSequences.next(uow, {
      docType: 'TRF',
      siteId: from.siteId,
      codeSite,
      year: Number(businessDayOf(occurredAt).slice(0, 4)),
    });
    await uow
      .insertInto('inventory_stock_transfers')
      .values({
        id: toBin(receiptId),
        doc_number: docNumber,
        site_id: toBin(from.siteId),
        transfer_kind: 'BLIND_RECEIPT',
        from_location_id: toBin(payload.fromLocationId),
        to_location_id: toBin(payload.toLocationId),
        status: 'UNMATCHED',
        received_by: toBin(envelope.author_user_id),
        received_at: occurredAt,
        notes: payload.notes ?? null,
        occurred_at: occurredAt,
        client_created_at: new Date(envelope.client_created_at),
        command_id: toBin(envelope.command_id),
        created_device_id: toBinOrNull(origin.deviceId),
        captured_offline: offline ? 1 : 0,
        backdated_reason: envelope.backdated_reason,
        created_by: toBin(envelope.author_user_id),
      })
      .execute();
    for (const line of receiptLines) {
      await uow
        .insertInto('inventory_stock_transfer_lines')
        .values({
          id: toBin(line.id),
          transfer_id: toBin(receiptId),
          product_id: toBin(line.productId),
          lot_id: toBinOrNull(line.lotId),
          unit_code: line.unitCode,
          received_qty_base: String((line.receivedMilli ?? 0) / 1000),
        })
        .execute();
    }

    const warnings = new Set<WarningCode>();
    const serverRefs: Record<string, string> = { transferId: receiptId };
    if (matching !== null) {
      const receivedByLine = blindReceiptAllocation(receipt, matching.dispatch);
      const outcome = await applyTransferReceipt(uow, deps, {
        transfer: matching.dispatch.header,
        lines: matching.dispatch.lines,
        receivedByLine,
        receivedBy: envelope.author_user_id,
        receivedAt: occurredAt,
        commandId: envelope.command_id,
        capturedOffline: offline,
        deviceId: origin.deviceId,
        policy: allowed!.policy,
      });
      await markMatched(uow, header, matching.dispatch.header.id, origin.receivedAt);
      await publishTransferMatchedByBlindReceipt(uow, deps, {
        dispatch: matching.dispatch.header,
        receiptId,
        status: outcome.status,
        matchedAt: origin.receivedAt,
        commandId: envelope.command_id,
      });
      serverRefs['matchedTransferId'] = matching.dispatch.header.id;
      if (outcome.overReceived) {
        await recordOverReceipt(uow, deps, {
          transfer: matching.dispatch.header,
          commandId: envelope.command_id,
          blindReceiptId: receiptId,
          lines: matching.dispatch.lines,
          receivedByLine,
        });
        warnings.add('TRANSFER_OVER_RECEIVED');
      }
    } else {
      // Transit non rapproché de la paire (BR-STK-024) : `V_TRANSIT` (produit, lot indiqué ou aucun)
      // peut devenir négatif ; la valeur est celle du solde de `V_TRANSIT`, sinon le CMUP.
      const transit = await virtualLocationId(uow, 'V_TRANSIT');
      await lockPhysicalStockCouples(
        uow,
        receiptLines.map((line) => ({
          locationId: payload.toLocationId,
          productId: line.productId,
        })),
      );
      for (const line of receiptLines) {
        await recordStockMove(uow, deps, {
          productId: line.productId,
          lotId: line.lotId,
          quantityBase: (line.receivedMilli ?? 0) / 1000,
          fromLocationId: transit,
          toLocationId: payload.toLocationId,
          moveType: 'TRANSFER_RECEIPT',
          occurredAt,
          sourceDocType: 'TRANSFER',
          sourceDocId: receiptId,
          sourceLineId: line.id,
          createdBy: envelope.author_user_id,
          ...(origin.deviceId !== null ? { createdDeviceId: origin.deviceId } : {}),
          commandId: envelope.command_id,
          capturedOffline: offline,
          allowNegative: true,
        });
      }
      await recordChanges(uow, transferChanges(receiptId, pair.fromLocationId, pair.toLocationId));
      warnings.add('TRANSFER_UNMATCHED');
    }

    if (custodyReason !== null) {
      warnings.add('CUSTODY_DEVICE_MISMATCH');
      await recordConflict(uow, {
        id: idGenerator.newId(),
        commandId: envelope.command_id,
        conflictType: 'CUSTODY_DEVICE_MISMATCH',
        entityType: 'LOCATION',
        entityId: to.id,
        siteId: to.siteId,
        ownerRole: stockOwnerRole(to.locationType, to.siteType),
        applied: true,
        details: {
          reason: custodyReason,
          userId: envelope.author_user_id,
          deviceId: origin.deviceId,
          locationId: to.id,
          sourceDocType: 'TRANSFER',
          sourceDocId: receiptId,
          occurredAt: occurredAt.toISOString(),
        },
      });
    }

    const audit = {
      after: {
        ...payload,
        ...(serverRefs['matchedTransferId'] !== undefined
          ? { matchedTransferId: serverRefs['matchedTransferId'] }
          : {}),
      },
    };
    return warnings.size > 0
      ? { status: 'APPLIED_WITH_WARNINGS', warnings: [...warnings], serverRefs, audit }
      : { status: 'APPLIED', serverRefs, audit };
  }

  const receive: CommandHandler<ReceivePayload> = (uow, envelope) =>
    'transferId' in envelope.payload
      ? receiveDocumented(uow, envelope as CommandEnvelope<DocumentedReceivePayload>)
      : receiveBlind(uow, envelope as CommandEnvelope<TransferBlindReceivePayload>);

  /**
   * Retour à la source (BR-STK-025 ; SM-TRANSFER `DISPATCHED → RETURNED`, « aucune réception ;
   * motif ») : chaque mouvement d'expédition est contre-passé (`TRANSFER_RECEIPT` inverse,
   * `V_TRANSIT` → source, même lot, quantité et valeur, INV-STK-04) ; le quota consommé à
   * l'expédition est rendu s'il est encore actif (ADR-033 §8). Courses (AV-180) : un transfert déjà
   * reçu, ou dont une réception sans document de la paire l'attend, est refusé en ligne et mis en
   * quarantaine hors ligne ; un second retour hors ligne est sans effet.
   */
  const returnToSource: CommandHandler<TransferReturnToSourcePayload> = async (uow, envelope) => {
    const payload = envelope.payload;
    const peek = await peekTransfer(uow, payload.transferId);
    if (!peek) return notFound();
    if (peek.kind !== 'STANDARD') return badStatus('DISPATCHED');
    const pair: TransferPair = peek;
    await lockTransferPair(uow, pair);
    const transfer = (await lockTransferById(uow, payload.transferId))!;
    const offline = envelope.captured_offline;
    if (transfer.status === 'RETURNED') {
      // Doublon hors ligne (deux appareils) : appliqué sans effet, jamais un second inverse.
      return offline ? { status: 'APPLIED' } : badStatus('DISPATCHED');
    }
    if (['RECEIVED', 'DISCREPANCY_PENDING', 'CLOSED'].includes(transfer.status)) {
      return offline
        ? quarantine(uow, envelope, transfer, 'TRANSFER_RETURN_CONFLICT', {
            reason: 'RETURN_AFTER_RECEIPT',
          })
        : badStatus('DISPATCHED');
    }
    if (transfer.status !== 'DISPATCHED') return badStatus('DISPATCHED');

    const lines = (await lockTransferLines(uow, [transfer.id])).get(transfer.id) ?? [];
    const occurredAt = new Date(envelope.occurred_at);
    const awaiting = await awaitingBlindReceipt(uow, pair, transfer, lines, occurredAt);
    if (awaiting) {
      return offline
        ? quarantine(uow, envelope, transfer, 'TRANSFER_RETURN_CONFLICT', {
            reason: 'BLIND_RECEIPT_PENDING',
            blindReceiptId: awaiting.header.id,
          })
        : rejected(
            'TRANSFER_STATUS_INVALID',
            'Une réception sans document attend ce transfert : il ne peut plus être retourné.',
          );
    }

    const dispatchMoves = await activeDocumentMoves(uow, transfer.id, 'TRANSFER_DISPATCH');
    await reverseTransferMoves(uow, deps, dispatchMoves, {
      reverseType: 'TRANSFER_RECEIPT',
      documentId: transfer.id,
      occurredAt,
      createdBy: envelope.author_user_id,
      commandId: envelope.command_id,
      capturedOffline: offline,
    });
    for (const line of lines) {
      if (line.dispatchedMilli === null) continue;
      await uow
        .updateTable('inventory_stock_transfer_lines')
        .set({ returned_qty_base: sql`dispatched_qty_base` })
        .where('id', '=', toBin(line.id))
        .execute();
    }
    await uow
      .updateTable('inventory_stock_transfers')
      .set({
        status: 'RETURNED',
        returned_by: toBin(envelope.author_user_id),
        returned_at: occurredAt,
        return_reason: payload.reason,
        updated_by: toBin(envelope.author_user_id),
        version: sql`version + 1`,
      })
      .where('id', '=', toBin(transfer.id))
      .execute();
    await recordChanges(
      uow,
      transferChanges(transfer.id, transfer.fromLocationId, transfer.toLocationId),
    );
    return { status: 'APPLIED' };
  };

  const moveInternal: CommandHandler<MoveInternalPayload> = async (uow, envelope) => {
    const { fromLocationId, toLocationId, lines } = envelope.payload;
    if (fromLocationId === toLocationId) return LOCATION_INVALID;
    const unknownReference = await unknownLineReference(uow, lines);
    if (unknownReference) return unknownReference;
    const occurredAt = new Date(envelope.occurred_at);
    const origin = await loadCommandOrigin(uow, envelope.command_id);
    const { siteId, codeSite } = await loadLocationSite(uow, fromLocationId);
    // P5-23 (S-40) : même site (règle de validité, hors ligne compris) ; garde des deux emplacements —
    // refus en ligne, fait appliqué avec `CUSTODY_DEVICE_MISMATCH` hors ligne (BR-SYN-007).
    if ((await loadLocationSite(uow, toLocationId)).siteId !== siteId)
      return INTERNAL_MOVE_OTHER_SITE;
    const author = { userId: envelope.author_user_id, deviceId: origin.deviceId };
    const foreign: string[] = [];
    for (const locationId of [fromLocationId, toLocationId]) {
      const at = envelope.captured_offline ? occurredAt : undefined;
      if (await otherCustody(uow, locationId, author, at)) foreign.push(locationId);
    }
    if (foreign.length > 0 && !envelope.captured_offline) return INTERNAL_MOVE_CUSTODY;
    const docNumber = await documentSequences.next(uow, {
      docType: 'TRF',
      siteId,
      codeSite,
      year: Number(businessDayOf(occurredAt).slice(0, 4)),
    });
    const transferId = envelope.aggregate_id;

    await uow
      .insertInto('inventory_stock_transfers')
      .values({
        id: toBin(transferId),
        doc_number: docNumber,
        site_id: toBin(siteId),
        transfer_kind: 'INTERNAL',
        from_location_id: toBin(fromLocationId),
        to_location_id: toBin(toLocationId),
        status: 'COMPLETED',
        dispatched_by: toBin(envelope.author_user_id),
        dispatched_at: occurredAt,
        received_by: toBin(envelope.author_user_id),
        received_at: occurredAt,
        notes: envelope.payload.notes ?? null,
        occurred_at: occurredAt,
        client_created_at: new Date(envelope.client_created_at),
        command_id: toBin(envelope.command_id),
        created_device_id: toBinOrNull(origin.deviceId),
        captured_offline: envelope.captured_offline ? 1 : 0,
        backdated_reason: envelope.backdated_reason,
        created_by: toBin(envelope.author_user_id),
      })
      .execute();

    const moveWarnings = new Set<WarningCode>();
    // ADR-038 N5 : soldes des deux emplacements, triés, avant le premier mouvement.
    await lockPhysicalStockCouples(
      uow,
      lines.flatMap((line) => [
        { locationId: fromLocationId, productId: line.productId },
        { locationId: toLocationId, productId: line.productId },
      ]),
    );
    for (const line of lines) {
      const moveResult = await tryRecordMove(() =>
        recordStockMove(uow, deps, {
          productId: line.productId,
          ...(line.lotId !== undefined ? { lotId: line.lotId } : {}),
          quantityBase: line.quantityBase,
          fromLocationId,
          toLocationId,
          moveType: 'INTERNAL_MOVE',
          occurredAt,
          sourceDocType: 'TRANSFER',
          sourceDocId: transferId,
          createdBy: envelope.author_user_id,
          ...(origin.deviceId !== null ? { createdDeviceId: origin.deviceId } : {}),
          commandId: envelope.command_id,
          capturedOffline: envelope.captured_offline,
          allowNegative: envelope.captured_offline,
          // P5-23 (S-40) : garde d'appareil et quota de l'auteur sur la source partagée, comme une expédition.
          consumesAllocation: true,
        }),
      );
      if (!moveResult.ok) return moveResult.outcome;
      for (const warning of allocationWarnings(moveResult.moves)) moveWarnings.add(warning);

      await uow
        .insertInto('inventory_stock_transfer_lines')
        .values({
          id: toBin(idGenerator.newId()),
          transfer_id: toBin(transferId),
          product_id: toBin(line.productId),
          lot_id: toBinOrNull(moveResult.moves[0]?.lotId ?? null),
          unit_code: line.unitCode,
          dispatched_qty_base: String(line.quantityBase),
          received_qty_base: String(line.quantityBase),
        })
        .execute();
    }

    for (const locationId of foreign) {
      moveWarnings.add('CUSTODY_DEVICE_MISMATCH');
      await recordConflict(uow, {
        id: idGenerator.newId(),
        commandId: envelope.command_id,
        conflictType: 'CUSTODY_DEVICE_MISMATCH',
        entityType: 'LOCATION',
        entityId: locationId,
        siteId,
        ownerRole: await transferOwnerRole(uow, fromLocationId),
        applied: true,
        details: {
          reason: 'LOCATION_OTHER_CUSTODY',
          locationId,
          sourceDocType: 'TRANSFER',
          sourceDocId: transferId,
          userId: envelope.author_user_id,
          deviceId: origin.deviceId,
          occurredAt: envelope.occurred_at,
        },
      });
    }

    await recordChanges(uow, transferChanges(transferId, fromLocationId, toLocationId));
    return moveWarnings.size > 0
      ? { status: 'APPLIED_WITH_WARNINGS', warnings: [...moveWarnings] }
      : { status: 'APPLIED' };
  };

  /**
   * Rapprochement **manuel** d'une réception sans document (AV-520 ; BR-STK-024, AV-177) : la personne choisit le
   * transfert expédié de la même paire que les règles automatiques n'ont pas rapproché (mode `EXACT`, plusieurs
   * expéditions, écart refusé faute de politique). Mêmes écritures que le rapprochement différé (`applyDeferredMatch`) :
   * le transfert est reçu au lot et à la valeur de l'expédition, la réception sans document est contre-passée du transit
   * de la paire, le conflit de délai est clos, l'alerte se ferme. Garde-fous : en ligne seulement ; la réception doit
   * être `UNMATCHED`, le transfert `DISPATCHED` et de la même paire ; les produits reçus doivent figurer dans
   * l'expédition (un produit hors expédition ne se rapproche jamais, AV-177 : enregistrer l'expédition manquante) ; un
   * écart exige la politique de validation, comme à l'automatique.
   */
  const matchBlind: CommandHandler<MatchBlindPayload> = async (uow, envelope) => {
    if (envelope.captured_offline) {
      return rejected('ONLINE_REQUIRED', 'Le rapprochement manuel se fait en ligne.');
    }
    const peek = await peekTransfer(uow, envelope.aggregate_id);
    if (!peek || peek.kind !== 'BLIND_RECEIPT') {
      return rejected('NOT_FOUND', 'Réception sans document introuvable.');
    }
    const pair: TransferPair = peek;
    await lockTransferPair(uow, pair);
    const receiptHeader = await lockTransferById(uow, envelope.aggregate_id);
    if (!receiptHeader || receiptHeader.status !== 'UNMATCHED') {
      return rejected(
        'RECEIPT_STATUS_INVALID',
        'Cette réception sans document est déjà rapprochée.',
      );
    }
    const dispatchHeader = await lockTransferById(uow, envelope.payload.transferId);
    if (!dispatchHeader || dispatchHeader.kind !== 'STANDARD') return notFound();
    if (
      dispatchHeader.fromLocationId !== pair.fromLocationId ||
      dispatchHeader.toLocationId !== pair.toLocationId
    ) {
      return rejected(
        'TRANSFER_PAIR_MISMATCH',
        'Le transfert choisi n’a pas la même source et la même destination que la réception.',
      );
    }
    if (dispatchHeader.status !== 'DISPATCHED') return badStatus('DISPATCHED');
    const lines = await lockTransferLines(uow, [receiptHeader.id, dispatchHeader.id]);
    const receipt: PendingBlindReceipt = {
      header: receiptHeader,
      lines: lines.get(receiptHeader.id) ?? [],
    };
    const dispatchedTransfer: DispatchedTransfer = {
      header: dispatchHeader,
      lines: lines.get(dispatchHeader.id) ?? [],
    };
    if (
      blindReceiptMatch(
        receivedQuantities(receipt.lines),
        dispatchedQuantities(dispatchedTransfer.lines),
        'SUBSET',
      ) === null
    ) {
      return rejected(
        'RECEIPT_NOT_MATCHABLE',
        'Les produits reçus ne figurent pas tous dans ce transfert : enregistrer l’expédition manquante, qui se rapprochera seule (AV-177).',
      );
    }
    const origin = await loadCommandOrigin(uow, envelope.command_id);
    const allowed = await matchPolicy(uow, receipt, dispatchedTransfer, origin.receivedAt);
    if (!allowed.allowed) {
      return rejected(
        'CONTROL_POLICY_MISSING',
        'Un écart de transfert doit être validé et aucune politique de validation n’est active : la créer d’abord.',
      );
    }
    const outcome = await applyDeferredMatch(uow, deps, {
      receipt,
      dispatch: dispatchedTransfer,
      policy: allowed.policy,
      triggerCommandId: envelope.command_id,
      resolvedBy: envelope.author_user_id,
      matchedAt: origin.receivedAt,
    });
    const serverRefs = {
      transferId: dispatchHeader.id,
      receiptId: receiptHeader.id,
      status: outcome.status,
    };
    const audit = {
      after: { receiptId: receiptHeader.id, transferId: dispatchHeader.id, status: outcome.status },
    };
    return outcome.overReceived
      ? { status: 'APPLIED_WITH_WARNINGS', warnings: ['TRANSFER_OVER_RECEIVED'], serverRefs, audit }
      : { status: 'APPLIED', serverRefs, audit };
  };

  /**
   * Annulation d'une réception sans document non rapprochée (AV-520 ; SM-TRANSFER `UNMATCHED → CANCELLED`) : la
   * réception saisie par erreur est contre-passée du transit de la paire, exactement (même produit, lot, quantité et
   * valeur, INV-STK-04). Refusée si la marchandise n'est plus au complet à la destination (déjà vendue ou déplacée :
   * le stock se régularise alors par un inventaire ou une perte, jamais en silence). Le conflit de délai est clos,
   * l'alerte se ferme (`BlindReceiptCancelled`). Le motif est exigé et tracé par l'audit. En ligne seulement.
   */
  const cancelBlind: CommandHandler<CancelBlindPayload> = async (uow, envelope) => {
    if (envelope.captured_offline) {
      return rejected('ONLINE_REQUIRED', 'L’annulation d’une réception se fait en ligne.');
    }
    const peek = await peekTransfer(uow, envelope.aggregate_id);
    if (!peek || peek.kind !== 'BLIND_RECEIPT') {
      return rejected('NOT_FOUND', 'Réception sans document introuvable.');
    }
    const pair: TransferPair = peek;
    await lockTransferPair(uow, pair);
    const receipt = await lockTransferById(uow, envelope.aggregate_id);
    if (!receipt || receipt.status !== 'UNMATCHED') {
      return rejected(
        'RECEIPT_STATUS_INVALID',
        'Seule une réception sans document non rapprochée peut être annulée.',
      );
    }
    const moves = await activeDocumentMoves(uow, receipt.id, 'TRANSFER_RECEIPT');
    await lockPhysicalStockCouples(
      uow,
      moves.map((move) => ({ locationId: move.toLocationId, productId: move.productId })),
    );
    // La marchandise doit être toujours là : par produit et par lot, le solde de la destination couvre la réception.
    const needed = new Map<string, { productId: string; lotId: string | null; milli: number }>();
    for (const move of moves) {
      const key = `${move.productId}|${move.lotId ?? ''}`;
      const entry = needed.get(key) ?? { productId: move.productId, lotId: move.lotId, milli: 0 };
      entry.milli += move.quantityMilli;
      needed.set(key, entry);
    }
    for (const entry of needed.values()) {
      // Lecture verrouillante : sous l'isolation répétable, une lecture simple verrait l'instantané pris plus haut
      // (`peekTransfer`), pas la vente qu'on vient d'attendre (`lockPhysicalStockCouples`), et la contre-passation
      // laisserait le stock négatif (AV-520, option 5 (b) écartée).
      const balance = await uow
        .selectFrom('inventory_stock_balances')
        .select('qty_on_hand')
        .where('location_id', '=', toBin(receipt.toLocationId))
        .where('product_id', '=', toBin(entry.productId))
        .where('lot_key', '=', entry.lotId === null ? Buffer.alloc(16) : toBin(entry.lotId))
        .forUpdate()
        .executeTakeFirst();
      if (quantityToMilli(balance?.qty_on_hand ?? 0) < entry.milli) {
        return rejected(
          'RECEIPT_GOODS_USED',
          'La marchandise reçue n’est plus au complet à la destination (vendue ou déplacée) : régulariser le stock par un inventaire ou une perte.',
        );
      }
    }
    const occurredAt = new Date(envelope.occurred_at);
    const moveWarnings = await reverseTransferMoves(uow, deps, moves, {
      reverseType: 'TRANSFER_DISPATCH',
      documentId: receipt.id,
      occurredAt,
      createdBy: envelope.author_user_id,
      commandId: envelope.command_id,
      capturedOffline: false,
    });
    await uow
      .updateTable('inventory_stock_transfers')
      .set({
        status: 'CANCELLED',
        updated_by: toBin(envelope.author_user_id),
        version: sql`version + 1`,
      })
      .where('id', '=', toBin(receipt.id))
      .execute();
    await recordChanges(
      uow,
      transferChanges(receipt.id, receipt.fromLocationId, receipt.toLocationId),
    );
    await resolveOpenConflicts(uow, {
      conflictType: 'TRANSFER_UNMATCHED',
      entityType: 'STOCK_TRANSFER',
      entityIds: [receipt.id],
      resolution: 'KEEP_SERVER',
      resolvedBy: envelope.author_user_id,
      resolvedAt: occurredAt,
      comment: `Réception sans document annulée : ${envelope.payload.reason}`,
      refs: [],
    });
    await publishDetectionEvent(uow, idGenerator, {
      eventType: 'BlindReceiptCancelled',
      producerModule: 'inventory',
      aggregateType: 'STOCK_TRANSFER',
      aggregateId: receipt.id,
      occurredAt,
      payload: {
        receipt_id: receipt.id,
        cancelled_by: envelope.author_user_id,
        site_id: receipt.siteId,
        business_day: businessDayOf(occurredAt),
      },
      commandId: envelope.command_id,
    });
    const serverRefs = { receiptId: receipt.id };
    const audit = { after: { receiptId: receipt.id, reason: envelope.payload.reason } };
    // Des quotas d'appareil actifs au-delà du stock restant : `inventory` a ouvert `ALLOCATION_OVERCOMMITTED` (informatif),
    // et la réponse le dit à l'annulant au lieu de se taire (revue adverse du 05/11/2026).
    return moveWarnings.includes('ALLOCATION_OVERCOMMITTED')
      ? {
          status: 'APPLIED_WITH_WARNINGS',
          warnings: ['ALLOCATION_OVERCOMMITTED'],
          serverRefs,
          audit,
        }
      : { status: 'APPLIED', serverRefs, audit };
  };

  return {
    request,
    decline,
    cancel,
    dispatch,
    receive,
    returnToSource,
    moveInternal,
    matchBlind,
    cancelBlind,
  };
}

/** Décision `TRANSFER_DISCREPANCY` (SM-TRANSFER `DISCREPANCY_PENDING -> CLOSED`) : approuvée =
 * perte confirmée (`V_PENDING_LOSS -> V_LOSS`, catégorie `ECART_TRANSFERT`) ; rejetée =
 * marchandise retrouvée (`V_PENDING_LOSS -> destination`). P5-16 : un mouvement par mouvement
 * d'écart, au même lot et à la même valeur (l'attente de perte s'annule exactement par document). */
function registerTransferDiscrepancyDecisionHandler(
  decisionRegistry: ApprovalDecisionHandlerRegistry,
  idGenerator: IdGenerator,
): void {
  decisionRegistry.register('TRANSFER_DISCREPANCY', async (uow, ctx) => {
    const transferRow = await uow
      .selectFrom('inventory_stock_transfers')
      .select(['id', 'from_location_id', 'to_location_id'])
      .where('id', '=', toBin(ctx.subjectId))
      .executeTakeFirstOrThrow();
    const deps: RecordMoveDeps = { idGenerator };
    const toLocationId = fromBin(transferRow.to_location_id);
    const pendingLoss = await virtualLocationId(uow, 'V_PENDING_LOSS');
    const discrepancies = await activeDocumentMoves(uow, ctx.subjectId, 'TRANSFER_DISCREPANCY');
    await lockPhysicalStockCouples(
      uow,
      discrepancies.map((move) => ({ locationId: toLocationId, productId: move.productId })),
    );

    for (const move of discrepancies) {
      const moveInput = {
        productId: move.productId,
        lotId: move.lotId,
        quantityBase: move.quantityMilli / 1000,
        declaredValueXaf: move.valueXaf,
        occurredAt: ctx.decidedAt,
        sourceDocType: 'TRANSFER' as const,
        sourceDocId: ctx.subjectId,
        ...(move.sourceLineId !== null ? { sourceLineId: move.sourceLineId } : {}),
        createdBy: ctx.decidedBy,
        capturedOffline: false,
        allowNegative: true,
        fromLocationId: pendingLoss,
      };
      if (ctx.decision === 'APPROVED') {
        await recordStockMove(uow, deps, {
          ...moveInput,
          toLocationId: await virtualLocationId(uow, 'V_LOSS'),
          moveType: 'LOSS_CONFIRMATION',
        });
      } else {
        await recordStockMove(uow, deps, {
          ...moveInput,
          toLocationId,
          moveType: 'LOSS_RELEASE',
        });
      }
    }

    await uow
      .updateTable('inventory_stock_transfers')
      .set({ status: 'CLOSED', updated_by: toBin(ctx.decidedBy), version: sql`version + 1` })
      .where('id', '=', transferRow.id)
      .execute();
    await recordTransferChanges(uow, transferRow);
  });
}

export function registerTransferCommands(
  registry: CommandHandlerRegistry,
  decisionRegistry: ApprovalDecisionHandlerRegistry,
  idGenerator: IdGenerator,
  documentSequences: DocumentSequenceService,
): void {
  const handlers = buildTransferCommands(idGenerator, documentSequences);
  registry.register({
    commandType: 'inventory.transfer.request',
    version: 1,
    payloadSchema: requestPayloadSchema,
    permissionCode: 'inventory.transfer.request',
    // AV-182 (P5-23) : portée sur l'une des extrémités.
    handler: withStockScope(
      'inventory.transfer.request',
      async (_uow, envelope) => [envelope.payload.fromLocationId, envelope.payload.toLocationId],
      handlers.request,
    ),
  });
  registry.register({
    commandType: 'inventory.transfer.decline',
    version: 1,
    payloadSchema: declinePayloadSchema,
    permissionCode: 'inventory.transfer.dispatch',
    handler: withStockScope(
      'inventory.transfer.dispatch',
      (uow, envelope) => transferLocations(uow, envelope.payload.transferId),
      handlers.decline,
    ),
  });
  registry.register({
    commandType: 'inventory.transfer.cancel',
    version: 1,
    payloadSchema: cancelPayloadSchema,
    permissionCode: 'inventory.transfer.request',
    handler: withStockScope(
      'inventory.transfer.request',
      (uow, envelope) => transferLocations(uow, envelope.payload.transferId),
      handlers.cancel,
    ),
  });
  registry.register({
    commandType: 'inventory.transfer.dispatch',
    version: 1,
    payloadSchema: dispatchPayloadSchema,
    permissionCode: 'inventory.transfer.dispatch',
    handler: withStockScope(
      'inventory.transfer.dispatch',
      async (uow, envelope) =>
        envelope.payload.transferId !== undefined
          ? transferLocations(uow, envelope.payload.transferId)
          : [envelope.payload.fromLocationId!, envelope.payload.toLocationId!],
      handlers.dispatch,
    ),
  });
  registry.register<ReceivePayload>({
    commandType: 'inventory.transfer.receive',
    version: 1,
    payloadSchema: receivePayloadSchema,
    permissionCode: 'inventory.transfer.receive',
    handler: withStockScope<ReceivePayload>(
      'inventory.transfer.receive',
      async (uow, envelope) =>
        'transferId' in envelope.payload
          ? transferLocations(uow, envelope.payload.transferId)
          : [envelope.payload.fromLocationId, envelope.payload.toLocationId],
      handlers.receive,
    ),
  });
  registry.register({
    commandType: 'inventory.transfer.return_to_source',
    version: 1,
    payloadSchema: transferReturnToSourcePayloadSchema,
    permissionCode: 'inventory.transfer.dispatch',
    handler: withStockScope(
      'inventory.transfer.dispatch',
      (uow, envelope) => transferLocations(uow, envelope.payload.transferId),
      handlers.returnToSource,
    ),
  });
  registry.register({
    commandType: 'inventory.transfer.move_internal',
    version: 1,
    payloadSchema: moveInternalPayloadSchema,
    permissionCode: 'inventory.transfer.dispatch',
    handler: withStockScope(
      'inventory.transfer.dispatch',
      async (_uow, envelope) => [envelope.payload.fromLocationId, envelope.payload.toLocationId],
      handlers.moveInternal,
    ),
  });
  // AV-520 : rapprochement manuel et annulation d'une réception sans document (l'agrégat est la réception).
  registry.register({
    commandType: 'inventory.transfer.match_blind',
    version: 1,
    payloadSchema: matchBlindPayloadSchema,
    permissionCode: 'inventory.transfer.receive',
    handler: withStockScope(
      'inventory.transfer.receive',
      (uow, envelope) => transferLocations(uow, envelope.aggregate_id),
      handlers.matchBlind,
    ),
  });
  registry.register({
    commandType: 'inventory.transfer.cancel_blind',
    version: 1,
    payloadSchema: cancelBlindPayloadSchema,
    permissionCode: 'inventory.transfer.receive',
    handler: withStockScope(
      'inventory.transfer.receive',
      (uow, envelope) => transferLocations(uow, envelope.aggregate_id),
      handlers.cancelBlind,
    ),
  });
  registerTransferDiscrepancyDecisionHandler(decisionRegistry, idGenerator);
}
