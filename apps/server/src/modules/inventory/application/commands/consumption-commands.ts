/**
 * `inventory.consumption.{record,cancel}` (BR-STK-036, BR-PRD-007 ; dictionnaire
 * `inventory.consumptions`/`inventory.cost_entries`). Portée de P2-04 : consommation
 * d'intrant imputée à un objet de coût, et son annulation (mouvement inverse +
 * écriture de coût inverse, jamais de suppression physique — INV-GLO-03).
 *
 * `cost_type` vient toujours du payload de la commande (donnée saisie, dictionnaire) : ce
 * module n'a aucun mapping produit → type de coût, un même produit pouvant être consommé
 * pour des raisons différentes (ALIMENT, VETERINAIRE…) selon le contexte de saisie.
 *
 * FIFO multi-lot (BR-STK-050) : contrairement à `transfer-commands.ts` (qui n'affiche que le
 * premier lot sur sa ligne, sans conséquence puisque le stock a bien bougé en entier), une
 * consommation doit pouvoir être **intégralement** annulée même si `recordStockMove` a
 * éclaté l'entrée sur plusieurs lots — `cancel` retrouve donc TOUS les mouvements CONSUMPTION
 * d'origine (par `source_doc_id`) et les inverse tous, avec une écriture de coût inverse par
 * mouvement (contrainte `UNIQUE (source_type, source_id, cost_object_id)`, une ligne par
 * mouvement, jamais une écriture agrégée).
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
import { recordStockMove, type RecordMoveDeps } from '../public/record-move.js';
import { loadCommandOrigin, virtualLocationId, tryRecordMove } from './shared.js';

const COST_OBJECT_TYPES = ['PRODUCTION_LOT', 'INCUBATION_BATCH', 'SITE'] as const;
const COST_TYPES = [
  'ANIMAUX',
  'OEUFS',
  'ALIMENT',
  'VETERINAIRE',
  'AUTRE_INTRANT',
  'DEPENSE_DIRECTE',
  'AJUSTEMENT',
] as const;

const recordPayloadSchema = z.object({
  locationId: z.string().uuid(),
  productId: z.string().uuid(),
  lotId: z.string().uuid().optional(),
  quantityBase: z.number().positive(),
  unitCode: z.string().min(1).max(20),
  quantity: z.number().positive(),
  costObjectType: z.enum(COST_OBJECT_TYPES),
  /** Réf. sans FK (dictionnaire : lot de production/incubation, table propriétaire P7). */
  costObjectId: z.string().uuid(),
  costType: z.enum(COST_TYPES),
});
type RecordPayload = z.infer<typeof recordPayloadSchema>;

const cancelPayloadSchema = z.object({
  consumptionId: z.string().uuid(),
  cancelReasonCodeId: z.string().uuid().optional(),
  cancelComment: z.string().max(2000).optional(),
});
type CancelPayload = z.infer<typeof cancelPayloadSchema>;

function notFound(): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode: 'NOT_FOUND', messageFr: 'Consommation introuvable.' };
}
function badStatus(expected: string): CommandHandlerOutcome {
  return {
    status: 'REJECTED',
    errorCode: 'CONSUMPTION_STATUS_INVALID',
    messageFr: `La consommation doit être au statut ${expected}.`,
  };
}

function buildConsumptionCommands(idGenerator: IdGenerator): {
  record: CommandHandler<RecordPayload>;
  cancel: CommandHandler<CancelPayload>;
} {
  const deps: RecordMoveDeps = { idGenerator };

  const record: CommandHandler<RecordPayload> = async (uow, envelope) => {
    const {
      locationId,
      productId,
      lotId,
      quantityBase,
      unitCode,
      quantity,
      costObjectType,
      costObjectId,
      costType,
    } = envelope.payload;
    const occurredAt = new Date(envelope.occurred_at);
    const origin = await loadCommandOrigin(uow, envelope.command_id);
    const consumptionId = envelope.aggregate_id;
    const consumptionLocationId = await virtualLocationId(uow, 'V_CONSUMPTION');

    const moveResult = await tryRecordMove(() =>
      recordStockMove(uow, deps, {
        productId,
        ...(lotId !== undefined ? { lotId } : {}),
        quantityBase,
        fromLocationId: locationId,
        toLocationId: consumptionLocationId,
        moveType: 'CONSUMPTION',
        occurredAt,
        sourceDocType: 'CONSUMPTION',
        sourceDocId: consumptionId,
        costObjectType,
        costObjectId,
        createdBy: envelope.author_user_id,
        ...(origin.deviceId !== null ? { createdDeviceId: origin.deviceId } : {}),
        commandId: envelope.command_id,
        capturedOffline: envelope.captured_offline,
        allowNegative: envelope.captured_offline,
      }),
    );
    if (!moveResult.ok) return moveResult.outcome;

    const capturedLotId = moveResult.moves[0]?.lotId ?? null;
    const totalValueXaf = moveResult.moves.reduce((sum, move) => sum + move.valueXaf, 0);

    await uow
      .insertInto('inventory_consumptions')
      .values({
        id: toBin(consumptionId),
        location_id: toBin(locationId),
        product_id: toBin(productId),
        lot_id: toBinOrNull(capturedLotId),
        quantity_base: String(quantityBase),
        unit_code: unitCode,
        quantity: String(quantity),
        cost_object_type: costObjectType,
        cost_object_id: toBin(costObjectId),
        recorded_by: toBin(envelope.author_user_id),
        value_xaf: totalValueXaf,
        status: 'RECORDED',
        occurred_at: occurredAt,
        client_created_at: new Date(envelope.client_created_at),
        command_id: toBin(envelope.command_id),
        created_device_id: toBinOrNull(origin.deviceId),
        captured_offline: envelope.captured_offline ? 1 : 0,
        backdated_reason: envelope.backdated_reason,
        created_by: toBin(envelope.author_user_id),
      })
      .execute();

    for (const move of moveResult.moves) {
      await uow
        .insertInto('inventory_cost_entries')
        .values({
          id: toBin(idGenerator.newId()),
          cost_object_type: costObjectType,
          cost_object_id: toBin(costObjectId),
          cost_type: costType,
          amount_xaf: move.valueXaf,
          direction: 'DEBIT',
          source_type: 'STOCK_MOVE',
          source_id: toBin(move.moveId),
          occurred_at: occurredAt,
          created_by: toBin(envelope.author_user_id),
        })
        .execute();
    }

    return { status: 'APPLIED' };
  };

  const cancel: CommandHandler<CancelPayload> = async (uow, envelope) => {
    const row = await uow
      .selectFrom('inventory_consumptions')
      .select(['id', 'status', 'location_id', 'product_id', 'cost_object_type', 'cost_object_id'])
      .where('id', '=', toBin(envelope.payload.consumptionId))
      .executeTakeFirst();
    if (!row) return notFound();
    if (row.status !== 'RECORDED') return badStatus('RECORDED');

    const occurredAt = new Date(envelope.occurred_at);
    const consumptionLocationId = await virtualLocationId(uow, 'V_CONSUMPTION');

    const originMoves = await uow
      .selectFrom('inventory_stock_moves')
      .select(['id', 'lot_id', 'quantity', 'unit_cost_xaf'])
      .where('source_doc_type', '=', 'CONSUMPTION')
      .where('source_doc_id', '=', row.id)
      .where('move_type', '=', 'CONSUMPTION')
      .execute();
    if (originMoves.length === 0) {
      // Garde défensive : `record` insère toujours au moins un mouvement CONSUMPTION avant
      // d'insérer la ligne — ne devrait jamais survenir en pratique.
      return {
        status: 'REJECTED',
        errorCode: 'NOT_FOUND',
        messageFr: 'Mouvement de consommation d’origine introuvable.',
      };
    }

    for (const move of originMoves) {
      const lotId = fromBinOrNull(move.lot_id);
      const reverseResult = await tryRecordMove(() =>
        recordStockMove(uow, deps, {
          productId: fromBin(row.product_id),
          ...(lotId !== null ? { lotId } : {}),
          quantityBase: Number(move.quantity),
          fromLocationId: consumptionLocationId,
          toLocationId: fromBin(row.location_id),
          moveType: 'CONSUMPTION_REVERSAL',
          occurredAt,
          sourceDocType: 'CONSUMPTION',
          sourceDocId: envelope.payload.consumptionId,
          createdBy: envelope.author_user_id,
          commandId: envelope.command_id,
          capturedOffline: envelope.captured_offline,
          allowNegative: true,
          reversesMoveId: fromBin(move.id),
          reversedUnitCostXaf: Number(move.unit_cost_xaf),
        }),
      );
      if (!reverseResult.ok) return reverseResult.outcome;
      const reverseMove = reverseResult.moves[0]!; // toujours 1 (reversal, jamais de FIFO — record-move.ts).

      const originalCostEntry = await uow
        .selectFrom('inventory_cost_entries')
        .select(['id', 'cost_type'])
        .where('source_type', '=', 'STOCK_MOVE')
        .where('source_id', '=', move.id)
        .where('cost_object_id', '=', row.cost_object_id)
        .executeTakeFirstOrThrow();

      await uow
        .insertInto('inventory_cost_entries')
        .values({
          id: toBin(idGenerator.newId()),
          cost_object_type: row.cost_object_type,
          cost_object_id: row.cost_object_id,
          cost_type: originalCostEntry.cost_type,
          amount_xaf: reverseMove.valueXaf,
          direction: 'CREDIT',
          source_type: 'STOCK_MOVE',
          source_id: toBin(reverseMove.moveId),
          reverses_entry_id: originalCostEntry.id,
          occurred_at: occurredAt,
          created_by: toBin(envelope.author_user_id),
        })
        .execute();
    }

    await uow
      .updateTable('inventory_consumptions')
      .set({
        status: 'CANCELLED',
        cancelled_at: occurredAt,
        cancelled_by: toBin(envelope.author_user_id),
        cancel_reason_code_id: toBinOrNull(envelope.payload.cancelReasonCodeId ?? null),
        cancel_comment: envelope.payload.cancelComment ?? null,
        updated_by: toBin(envelope.author_user_id),
        version: sql`version + 1`,
      })
      .where('id', '=', row.id)
      .execute();

    return { status: 'APPLIED' };
  };

  return { record, cancel };
}

export function registerConsumptionCommands(
  registry: CommandHandlerRegistry,
  idGenerator: IdGenerator,
): void {
  const handlers = buildConsumptionCommands(idGenerator);
  registry.register({
    commandType: 'inventory.consumption.record',
    version: 1,
    payloadSchema: recordPayloadSchema,
    permissionCode: 'inventory.consumption.record',
    handler: handlers.record,
  });
  registry.register({
    commandType: 'inventory.consumption.cancel',
    version: 1,
    payloadSchema: cancelPayloadSchema,
    permissionCode: 'inventory.consumption.record',
    handler: handlers.cancel,
  });
}
