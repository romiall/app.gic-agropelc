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
  currentPolicies,
  type ApprovalDecisionHandlerRegistry,
} from '../../../approvals/application/public/index.js';
import { findProductLotTracking, findUnit } from '../../../catalog/application/public/index.js';
import { recordChanges } from '../../../../platform/sync/change-feed.js';
import { recordConflict } from '../../../../platform/sync/conflicts.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { recordStockMove, type RecordMoveDeps } from '../public/record-move.js';
import { transferChanges } from '../sync-changes.js';
import { custodyMismatch, stockOwnerRole, type CustodyReason } from '../allocation-consumption.js';
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
  virtualLocationId,
  tryRecordMove,
} from './shared.js';

const lineInputSchema = z.object({
  productId: z.string().uuid(),
  unitCode: z.string().min(1).max(20),
  quantityBase: z.number().positive(),
  lotId: z.string().uuid().optional(),
});

const requestPayloadSchema = z.object({
  fromLocationId: z.string().uuid(),
  toLocationId: z.string().uuid(),
  lines: z.array(lineInputSchema).min(1),
  notes: z.string().max(2000).optional(),
});
type RequestPayload = z.infer<typeof requestPayloadSchema>;

const declinePayloadSchema = z.object({
  transferId: z.string().uuid(),
  comment: z.string().max(2000).optional(),
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
const LOCATION_INVALID = rejected('LOCATION_INVALID', 'Source et destination doivent différer.');
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
    conflictType: 'TRANSFER_OVER_RECEIVED' | 'TRANSFER_RETURN_CONFLICT',
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
    await recordChanges(uow, transferChanges(transferId, fromLocationId, toLocationId));
    return { status: 'APPLIED' };
  };

  const decline: CommandHandler<DeclinePayload> = async (uow, envelope) => {
    const row = await uow
      .selectFrom('inventory_stock_transfers')
      .select(['id', 'status', 'from_location_id', 'to_location_id'])
      .where('id', '=', toBin(envelope.payload.transferId))
      .executeTakeFirst();
    if (!row) return notFound();
    if (row.status !== 'REQUESTED') return badStatus('REQUESTED');

    await uow
      .updateTable('inventory_stock_transfers')
      .set({
        status: 'DECLINED',
        notes: envelope.payload.comment ?? null,
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
    if (fromBinOrNull(row.requested_by) !== envelope.author_user_id) {
      return rejected('FORBIDDEN', 'Seul le demandeur peut annuler.');
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
    if (transferId !== undefined) {
      const row = await lockTransferById(uow, transferId);
      if (!row) return notFound();
      if (row.kind !== 'STANDARD' || row.status !== 'REQUESTED') return badStatus('REQUESTED');
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
          updated_by: toBin(envelope.author_user_id),
          version: sql`version + 1`,
        })
        .where('id', '=', transfer.id)
        .execute();
    } else {
      if (await transferExists(uow, envelope.aggregate_id)) return TRANSFER_ID_TAKEN;
      receipts = await pendingBlindReceipts(uow, pair);
      const newTransferId = toBin(envelope.aggregate_id);
      const { siteId, codeSite } = await loadLocationSite(uow, fromLocationId!);
      const docNumber = await documentSequences.next(uow, {
        docType: 'TRF',
        siteId,
        codeSite,
        year: Number(businessDayOf(occurredAt).slice(0, 4)),
      });
      await uow
        .insertInto('inventory_stock_transfers')
        .values({
          id: newTransferId,
          doc_number: docNumber,
          site_id: toBin(siteId),
          transfer_kind: 'STANDARD',
          from_location_id: toBin(fromLocationId!),
          to_location_id: toBin(toLocationId!),
          status: 'DISPATCHED',
          dispatched_by: toBin(envelope.author_user_id),
          dispatched_at: occurredAt,
          carrier_user_id: toBinOrNull(carrierUserId ?? null),
          carrier_name: carrierName ?? null,
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
      transfer = {
        id: newTransferId,
        status: 'DISPATCHED',
        from_location_id: toBin(fromLocationId!),
        to_location_id: toBin(toLocationId!),
        requested_by: null,
      };
    }

    const transitLocationId = await virtualLocationId(uow, 'V_TRANSIT');
    const dispatchWarnings = new Set<WarningCode>();
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

      if (transferId !== undefined && line.transferLineId !== undefined) {
        await uow
          .updateTable('inventory_stock_transfer_lines')
          .set({
            dispatched_qty_base: String(line.quantityBase),
            lot_id: toBinOrNull(dispatchedLotId),
          })
          .where('id', '=', toBin(line.transferLineId))
          .execute();
      } else if (transferId !== undefined) {
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

    // Rapprochement différé : une réception sans document de la paire attendait cette expédition.
    const serverRefs: Record<string, string> = {};
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
    const policy = shape.discrepancy
      ? ((await currentPolicies(uow, 'TRANSFER_DISCREPANCY', occurredAt))[0] ?? null)
      : null;
    if (shape.discrepancy && policy === null) {
      return rejected(
        'CONTROL_POLICY_MISSING',
        'Aucune politique de contrôle TRANSFER_DISCREPANCY configurée (approvals.policy.set).',
      );
    }
    const origin = await loadCommandOrigin(uow, envelope.command_id);
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
    const exclusive = to.custodyMode === 'EXCLUSIVE_DEVICE' || to.custodyMode === 'EXCLUSIVE_USER';
    if (!exclusive && !offline) {
      return rejected(
        'BLIND_RECEIPT_NOT_ALLOWED',
        'Réception sans document réservée à un emplacement exclusif : recevoir avec le document (BR-STK-024).',
      );
    }
    const origin = await loadCommandOrigin(uow, envelope.command_id);
    let custodyReason: CustodyReason | null = exclusive ? null : 'LOCATION_NOT_EXCLUSIVE';
    if (exclusive && offline && origin.deviceId !== null) {
      custodyReason = await custodyMismatch(uow, { location: to, deviceId: origin.deviceId });
    }

    const occurredAt = new Date(envelope.occurred_at);
    const receiptId = envelope.aggregate_id;
    const header: TransferHeader = {
      id: receiptId,
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
    const occurredAt = new Date(envelope.occurred_at);
    const origin = await loadCommandOrigin(uow, envelope.command_id);
    const { siteId, codeSite } = await loadLocationSite(uow, fromLocationId);
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
        }),
      );
      if (!moveResult.ok) return moveResult.outcome;

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

    await recordChanges(uow, transferChanges(transferId, fromLocationId, toLocationId));
    return { status: 'APPLIED' };
  };

  return { request, decline, cancel, dispatch, receive, returnToSource, moveInternal };
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
    handler: handlers.request,
  });
  registry.register({
    commandType: 'inventory.transfer.decline',
    version: 1,
    payloadSchema: declinePayloadSchema,
    permissionCode: 'inventory.transfer.dispatch',
    handler: handlers.decline,
  });
  registry.register({
    commandType: 'inventory.transfer.cancel',
    version: 1,
    payloadSchema: cancelPayloadSchema,
    permissionCode: 'inventory.transfer.request',
    handler: handlers.cancel,
  });
  registry.register({
    commandType: 'inventory.transfer.dispatch',
    version: 1,
    payloadSchema: dispatchPayloadSchema,
    permissionCode: 'inventory.transfer.dispatch',
    handler: handlers.dispatch,
  });
  registry.register<ReceivePayload>({
    commandType: 'inventory.transfer.receive',
    version: 1,
    payloadSchema: receivePayloadSchema,
    permissionCode: 'inventory.transfer.receive',
    handler: handlers.receive,
  });
  registry.register({
    commandType: 'inventory.transfer.return_to_source',
    version: 1,
    payloadSchema: transferReturnToSourcePayloadSchema,
    permissionCode: 'inventory.transfer.dispatch',
    handler: handlers.returnToSource,
  });
  registry.register({
    commandType: 'inventory.transfer.move_internal',
    version: 1,
    payloadSchema: moveInternalPayloadSchema,
    permissionCode: 'inventory.transfer.dispatch',
    handler: handlers.moveInternal,
  });
  registerTransferDiscrepancyDecisionHandler(decisionRegistry, idGenerator);
}
