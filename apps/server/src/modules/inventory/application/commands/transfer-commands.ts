/**
 * `inventory.transfer.*` (SM-TRANSFER, 04-workflows/machines-a-etats/03-stock.md). Portée de
 * P2-04 : natures `STANDARD` et `INTERNAL` (demande, refus, annulation, expédition, réception
 * complète ou avec écart, déplacement interne) + décision d'approbation `TRANSFER_DISCREPANCY`.
 * Hors périmètre, documenté et non simulé : `BLIND_RECEIPT` (réception sans document, sa
 * réconciliation `UNMATCHED`/`MATCHED` et le délai de 48 h, BR-STK-024) et le retour intégral
 * (`return_to_source`) — les deux exigent une recherche de correspondance et une horloge
 * différée qui n'existent pas encore ; à construire avec les prochains besoins réels (P5/P7
 * selon les modules qui les déclenchent).
 */
import { z } from 'zod';
import { sql } from 'kysely';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import type { IdGenerator } from '@gic/domain';
import {
  toBin,
  toBinOrNull,
  fromBin,
  fromBinOrNull,
} from '../../../../platform/kysely/uuid-columns.js';
import { DocumentSequenceService } from '../../../../platform/document-sequences/document-sequence.service.js';
import {
  requestApproval,
  currentPolicies,
  type ApprovalDecisionHandlerRegistry,
} from '../../../approvals/application/public/index.js';
import { recordStockMove, type RecordMoveDeps } from '../public/record-move.js';
import { loadCommandOrigin, loadLocationSite, virtualLocationId, tryRecordMove } from './shared.js';

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

const receivePayloadSchema = z.object({
  transferId: z.string().uuid(),
  lines: z
    .array(
      z.object({
        transferLineId: z.string().uuid(),
        receivedQtyBase: z.number().nonnegative(),
        discrepancyReasonCodeId: z.string().uuid().optional(),
      }),
    )
    .min(1),
});
type ReceivePayload = z.infer<typeof receivePayloadSchema>;

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

interface TransferRow {
  readonly id: Buffer;
  readonly status: string;
  readonly from_location_id: Buffer;
  readonly to_location_id: Buffer;
  readonly requested_by: Buffer | null;
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
  moveInternal: CommandHandler<MoveInternalPayload>;
} {
  const deps: RecordMoveDeps = { idGenerator };

  const request: CommandHandler<RequestPayload> = async (uow, envelope) => {
    const { fromLocationId, toLocationId, lines } = envelope.payload;
    if (fromLocationId === toLocationId) {
      return {
        status: 'REJECTED',
        errorCode: 'LOCATION_INVALID',
        messageFr: 'Source et destination doivent différer.',
      };
    }
    const occurredAt = new Date(envelope.occurred_at);
    const { siteId, codeSite } = await loadLocationSite(uow, fromLocationId);
    const origin = await loadCommandOrigin(uow, envelope.command_id);
    const docNumber = await documentSequences.next(uow, {
      docType: 'TRF',
      siteId,
      codeSite,
      year: occurredAt.getUTCFullYear(),
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
    return { status: 'APPLIED' };
  };

  const decline: CommandHandler<DeclinePayload> = async (uow, envelope) => {
    const row = await uow
      .selectFrom('inventory_stock_transfers')
      .select(['id', 'status'])
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
    return { status: 'APPLIED' };
  };

  const cancel: CommandHandler<CancelPayload> = async (uow, envelope) => {
    const row = await uow
      .selectFrom('inventory_stock_transfers')
      .select(['id', 'status', 'requested_by'])
      .where('id', '=', toBin(envelope.payload.transferId))
      .executeTakeFirst();
    if (!row) return notFound();
    if (row.status !== 'REQUESTED') return badStatus('REQUESTED');
    if (fromBinOrNull(row.requested_by) !== envelope.author_user_id) {
      return {
        status: 'REJECTED',
        errorCode: 'FORBIDDEN',
        messageFr: 'Seul le demandeur peut annuler.',
      };
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
    return { status: 'APPLIED' };
  };

  const dispatch: CommandHandler<DispatchPayload> = async (uow, envelope) => {
    const occurredAt = new Date(envelope.occurred_at);
    const { transferId, fromLocationId, toLocationId, lines, carrierUserId, carrierName } =
      envelope.payload;
    const origin = await loadCommandOrigin(uow, envelope.command_id);

    let transfer: TransferRow;
    if (transferId !== undefined) {
      const row = await uow
        .selectFrom('inventory_stock_transfers')
        .select(['id', 'status', 'from_location_id', 'to_location_id', 'requested_by'])
        .where('id', '=', toBin(transferId))
        .executeTakeFirst();
      if (!row) return notFound();
      if (row.status !== 'REQUESTED') return badStatus('REQUESTED');
      transfer = row;

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
        .where('id', '=', row.id)
        .execute();
    } else {
      const newTransferId = toBin(envelope.aggregate_id);
      const { siteId, codeSite } = await loadLocationSite(uow, fromLocationId!);
      const docNumber = await documentSequences.next(uow, {
        docType: 'TRF',
        siteId,
        codeSite,
        year: occurredAt.getUTCFullYear(),
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
        }),
      );
      if (!moveResult.ok) return moveResult.outcome;
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

    return { status: 'APPLIED' };
  };

  const receive: CommandHandler<ReceivePayload> = async (uow, envelope) => {
    const transferRow = await uow
      .selectFrom('inventory_stock_transfers')
      .select(['id', 'status', 'to_location_id', 'site_id'])
      .where('id', '=', toBin(envelope.payload.transferId))
      .executeTakeFirst();
    if (!transferRow) return notFound();
    if (transferRow.status !== 'DISPATCHED') return badStatus('DISPATCHED');

    const occurredAt = new Date(envelope.occurred_at);
    const toLocationId = fromBin(transferRow.to_location_id);
    const transitLocationId = await virtualLocationId(uow, 'V_TRANSIT');
    const pendingLossLocationId = await virtualLocationId(uow, 'V_PENDING_LOSS');
    let hasDiscrepancy = false;

    for (const line of envelope.payload.lines) {
      const lineRow = await uow
        .selectFrom('inventory_stock_transfer_lines')
        .select(['id', 'product_id', 'lot_id', 'dispatched_qty_base'])
        .where('id', '=', toBin(line.transferLineId))
        .where('transfer_id', '=', transferRow.id)
        .executeTakeFirst();
      if (!lineRow || lineRow.dispatched_qty_base === null) {
        return {
          status: 'REJECTED',
          errorCode: 'NOT_FOUND',
          messageFr: 'Ligne de transfert introuvable ou non expédiée.',
        };
      }
      const dispatchedQty = Number(lineRow.dispatched_qty_base);
      if (line.receivedQtyBase > dispatchedQty) {
        // BR-STK-021 : refusé en ligne ; hors ligne, ouvrirait TRANSFER_OVER_RECEIVED
        // (AV-082, non implémenté — aucun mécanisme de conflit dédié en P2, à construire avec
        // le prochain module qui en a réellement besoin).
        return {
          status: 'REJECTED',
          errorCode: 'TRANSFER_OVER_RECEIVED',
          messageFr: 'Quantité reçue supérieure à la quantité expédiée (BR-STK-021).',
        };
      }

      const lotId = fromBinOrNull(lineRow.lot_id);
      const receiveResult = await tryRecordMove(() =>
        recordStockMove(uow, deps, {
          productId: fromBin(lineRow.product_id),
          ...(lotId !== null ? { lotId } : {}),
          quantityBase: line.receivedQtyBase,
          fromLocationId: transitLocationId,
          toLocationId,
          moveType: 'TRANSFER_RECEIPT',
          occurredAt,
          sourceDocType: 'TRANSFER',
          sourceDocId: envelope.payload.transferId,
          sourceLineId: fromBin(lineRow.id),
          createdBy: envelope.author_user_id,
          commandId: envelope.command_id,
          capturedOffline: envelope.captured_offline,
          allowNegative: true,
        }),
      );
      if (!receiveResult.ok) return receiveResult.outcome;

      const discrepancy = dispatchedQty - line.receivedQtyBase;
      if (discrepancy > 0) {
        hasDiscrepancy = true;
        const discrepancyResult = await tryRecordMove(() =>
          recordStockMove(uow, deps, {
            productId: fromBin(lineRow.product_id),
            ...(lotId !== null ? { lotId } : {}),
            quantityBase: discrepancy,
            fromLocationId: transitLocationId,
            toLocationId: pendingLossLocationId,
            moveType: 'TRANSFER_DISCREPANCY',
            occurredAt,
            sourceDocType: 'TRANSFER',
            sourceDocId: envelope.payload.transferId,
            sourceLineId: fromBin(lineRow.id),
            createdBy: envelope.author_user_id,
            commandId: envelope.command_id,
            capturedOffline: envelope.captured_offline,
            allowNegative: true,
          }),
        );
        if (!discrepancyResult.ok) return discrepancyResult.outcome;
      }

      await uow
        .updateTable('inventory_stock_transfer_lines')
        .set({
          received_qty_base: String(line.receivedQtyBase),
          discrepancy_reason_code_id: toBinOrNull(line.discrepancyReasonCodeId ?? null),
        })
        .where('id', '=', lineRow.id)
        .execute();
    }

    if (!hasDiscrepancy) {
      await uow
        .updateTable('inventory_stock_transfers')
        .set({
          status: 'RECEIVED',
          received_by: toBin(envelope.author_user_id),
          received_at: occurredAt,
          updated_by: toBin(envelope.author_user_id),
          version: sql`version + 1`,
        })
        .where('id', '=', transferRow.id)
        .execute();
      return { status: 'APPLIED' };
    }

    const policies = await currentPolicies(uow, 'TRANSFER_DISCREPANCY', occurredAt);
    const policy = policies[0];
    if (!policy) {
      return {
        status: 'REJECTED',
        errorCode: 'CONTROL_POLICY_MISSING',
        messageFr:
          'Aucune politique de contrôle TRANSFER_DISCREPANCY configurée (approvals.policy.set).',
      };
    }
    const approvalRequestId = idGenerator.newId();
    await requestApproval(uow, {
      requestId: approvalRequestId,
      operationType: 'TRANSFER_DISCREPANCY',
      subjectType: 'STOCK_TRANSFER',
      subjectId: envelope.payload.transferId,
      subjectSummary: `Écart de réception sur transfert ${envelope.payload.transferId}`,
      siteId: fromBin(transferRow.site_id),
      requestedBy: envelope.author_user_id,
      requestedAt: occurredAt,
      policyId: policy.id,
      policyVersion: policy.version,
    });
    await uow
      .updateTable('inventory_stock_transfers')
      .set({
        status: 'DISCREPANCY_PENDING',
        received_by: toBin(envelope.author_user_id),
        received_at: occurredAt,
        approval_request_id: toBin(approvalRequestId),
        updated_by: toBin(envelope.author_user_id),
        version: sql`version + 1`,
      })
      .where('id', '=', transferRow.id)
      .execute();
    return { status: 'APPLIED' };
  };

  const moveInternal: CommandHandler<MoveInternalPayload> = async (uow, envelope) => {
    const { fromLocationId, toLocationId, lines } = envelope.payload;
    if (fromLocationId === toLocationId) {
      return {
        status: 'REJECTED',
        errorCode: 'LOCATION_INVALID',
        messageFr: 'Source et destination doivent différer.',
      };
    }
    const occurredAt = new Date(envelope.occurred_at);
    const origin = await loadCommandOrigin(uow, envelope.command_id);
    const { siteId, codeSite } = await loadLocationSite(uow, fromLocationId);
    const docNumber = await documentSequences.next(uow, {
      docType: 'TRF',
      siteId,
      codeSite,
      year: occurredAt.getUTCFullYear(),
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

    return { status: 'APPLIED' };
  };

  return { request, decline, cancel, dispatch, receive, moveInternal };
}

/** Décision `TRANSFER_DISCREPANCY` (SM-TRANSFER `DISCREPANCY_PENDING -> CLOSED`) : approuvée =
 * perte confirmée (`V_PENDING_LOSS -> V_LOSS`, catégorie `ECART_TRANSFERT`) ; rejetée =
 * marchandise retrouvée (`V_PENDING_LOSS -> destination`). */
function registerTransferDiscrepancyDecisionHandler(
  decisionRegistry: ApprovalDecisionHandlerRegistry,
  idGenerator: IdGenerator,
): void {
  decisionRegistry.register('TRANSFER_DISCREPANCY', async (uow, ctx) => {
    const transferRow = await uow
      .selectFrom('inventory_stock_transfers')
      .select(['id', 'to_location_id'])
      .where('id', '=', toBin(ctx.subjectId))
      .executeTakeFirstOrThrow();
    const lines = await uow
      .selectFrom('inventory_stock_transfer_lines')
      .select(['id', 'product_id', 'lot_id', 'discrepancy_qty_base'])
      .where('transfer_id', '=', transferRow.id)
      .execute();
    const deps: RecordMoveDeps = { idGenerator };
    const toLocationId = fromBin(transferRow.to_location_id);

    for (const line of lines) {
      const discrepancyQty =
        line.discrepancy_qty_base !== null ? Number(line.discrepancy_qty_base) : 0;
      if (discrepancyQty <= 0) continue;
      const lotId = fromBinOrNull(line.lot_id);
      const moveInput = {
        productId: fromBin(line.product_id),
        ...(lotId !== null ? { lotId } : {}),
        quantityBase: discrepancyQty,
        occurredAt: ctx.decidedAt,
        sourceDocType: 'TRANSFER' as const,
        sourceDocId: ctx.subjectId,
        sourceLineId: fromBin(line.id),
        createdBy: ctx.decidedBy,
        capturedOffline: false,
        allowNegative: true,
      };
      if (ctx.decision === 'APPROVED') {
        await recordStockMove(uow, deps, {
          ...moveInput,
          fromLocationId: await virtualLocationId(uow, 'V_PENDING_LOSS'),
          toLocationId: await virtualLocationId(uow, 'V_LOSS'),
          moveType: 'LOSS_CONFIRMATION',
        });
      } else {
        await recordStockMove(uow, deps, {
          ...moveInput,
          fromLocationId: await virtualLocationId(uow, 'V_PENDING_LOSS'),
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
  registry.register({
    commandType: 'inventory.transfer.receive',
    version: 1,
    payloadSchema: receivePayloadSchema,
    permissionCode: 'inventory.transfer.receive',
    handler: handlers.receive,
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
