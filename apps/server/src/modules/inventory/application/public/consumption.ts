/**
 * Consommation d'intrant imputée à un objet de coût (`inventory.consumptions`, BR-STK-036,
 * BR-PRD-007) : API publique d'`inventory`, appelée par la commande `inventory.consumption.record`
 * et, depuis P7, par `production.input.record` (consommation d'un lot).
 *
 * Une écriture de coût (`DEBIT`, nature `costType`) par mouvement de consommation, sauf si le
 * mouvement vaut 0 XAF (intrant à CMUP nul) : la consommation reste un fait physique valide
 * (BR-SYN-007), sans ligne de coût ; la nature est conservée sur la consommation (AV-049,
 * indice de consommation).
 */
import type { IdGenerator } from '@gic/domain';
import type { CommandHandlerOutcome } from '../../../../platform/sync/command-handler-registry.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import { loadCommandOrigin } from '../../../../platform/sync/command-origin.js';
import { recordStockMove } from './record-move.js';
import { recordCostEntry, type CostObjectType, type CostType } from './cost-entries.js';
import { tryRecordMove, virtualLocationId } from '../commands/shared.js';

export interface RecordConsumptionInput {
  readonly consumptionId: string;
  readonly locationId: string;
  readonly productId: string;
  readonly lotId?: string;
  readonly quantityBase: number;
  readonly unitCode: string;
  readonly quantity: number;
  readonly costObjectType: CostObjectType;
  readonly costObjectId: string;
  readonly costType: Exclude<CostType, 'FRAIS_GENERAUX' | 'PRODUCTION_TRANSFEREE'>;
  readonly occurredAt: Date;
  readonly recordedBy: string;
  readonly commandId: string;
  readonly clientCreatedAt: Date | null;
  readonly capturedOffline: boolean;
  readonly backdatedReason: string | null;
}

export type RecordConsumptionResult =
  | { readonly ok: true; readonly valueXaf: number }
  | { readonly ok: false; readonly outcome: CommandHandlerOutcome };

export async function recordConsumption(
  uow: UnitOfWork,
  deps: { readonly idGenerator: IdGenerator },
  input: RecordConsumptionInput,
): Promise<RecordConsumptionResult> {
  const origin = await loadCommandOrigin(uow, input.commandId);
  const consumptionLocationId = await virtualLocationId(uow, 'V_CONSUMPTION');
  const moveResult = await tryRecordMove(() =>
    recordStockMove(uow, deps, {
      productId: input.productId,
      ...(input.lotId !== undefined ? { lotId: input.lotId } : {}),
      quantityBase: input.quantityBase,
      fromLocationId: input.locationId,
      toLocationId: consumptionLocationId,
      moveType: 'CONSUMPTION',
      occurredAt: input.occurredAt,
      sourceDocType: 'CONSUMPTION',
      sourceDocId: input.consumptionId,
      costObjectType: input.costObjectType,
      costObjectId: input.costObjectId,
      createdBy: input.recordedBy,
      ...(origin.deviceId !== null ? { createdDeviceId: origin.deviceId } : {}),
      commandId: input.commandId,
      capturedOffline: input.capturedOffline,
      allowNegative: input.capturedOffline,
    }),
  );
  if (!moveResult.ok) return { ok: false, outcome: moveResult.outcome };

  const capturedLotId = moveResult.moves[0]?.lotId ?? null;
  const valueXaf = moveResult.moves.reduce((sum, move) => sum + move.valueXaf, 0);

  await uow
    .insertInto('inventory_consumptions')
    .values({
      id: toBin(input.consumptionId),
      location_id: toBin(input.locationId),
      product_id: toBin(input.productId),
      lot_id: toBinOrNull(capturedLotId),
      quantity_base: String(input.quantityBase),
      unit_code: input.unitCode,
      quantity: String(input.quantity),
      cost_object_type: input.costObjectType,
      cost_object_id: toBin(input.costObjectId),
      cost_type: input.costType,
      recorded_by: toBin(input.recordedBy),
      value_xaf: valueXaf,
      status: 'RECORDED',
      occurred_at: input.occurredAt,
      client_created_at: input.clientCreatedAt,
      received_at_server: origin.receivedAt,
      command_id: toBin(input.commandId),
      created_device_id: toBinOrNull(origin.deviceId),
      captured_offline: input.capturedOffline ? 1 : 0,
      clock_suspect: origin.clockSuspect ? 1 : 0,
      backdated_reason: input.backdatedReason,
      created_by: toBin(input.recordedBy),
    })
    .execute();

  for (const move of moveResult.moves) {
    await recordCostEntry(uow, deps, {
      costObjectType: input.costObjectType,
      costObjectId: input.costObjectId,
      costType: input.costType,
      amountXaf: move.valueXaf,
      direction: 'DEBIT',
      sourceType: 'STOCK_MOVE',
      sourceId: move.moveId,
      occurredAt: input.occurredAt,
      createdBy: input.recordedBy,
    });
  }
  return { ok: true, valueXaf };
}
