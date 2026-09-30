/**
 * Saisie du jour d'un lot (D07-PRD, UC-PRD-03 à 06 ; BR-PRD-008 : commandes indépendantes, un
 * échec de l'une n'annule pas les autres ; P7-06), sous `production.daily.record`, hors ligne
 * possible :
 * - `production.mortality.record` : déclaration de perte `MORTALITE` rattachée au lot, à son lot
 *   de traçabilité et à l'emplacement (BR-PRD-005) ; photo et validation selon la politique
 *   `MORTALITY` (AV-048 : toute mortalité validée ; AV-107 : reçue sans photo, elle est
 *   enregistrée et sa validation attend la photo) — `inventory.declareLoss` ;
 * - `production.input.record` : consommation d'intrant imputée au lot (BR-PRD-007), nature
 *   conservée pour l'indice de consommation (AV-049) — `inventory.recordConsumption` ;
 * - `production.weighing.record` et `.cancel` : pesée d'échantillon, sans effet de stock
 *   (BR-PRD-015) ;
 * - `production.observation.record` : observation immuable (« RAS » possible, AV-117).
 *
 * Lot `ACTIVE` ou `SELLING` exigé en ligne (`LOT_NOT_ACTIVE`, D07 §8) ; hors ligne, la saisie
 * est appliquée avec le conflit informatif `LOT_CLOSED` (BR-SYN-007).
 */
import { z } from 'zod';
import { sql } from 'kysely';
import { checkWeighing, type IdGenerator } from '@gic/domain';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import type { DocumentSequenceService } from '../../../../platform/document-sequences/document-sequence.service.js';
import { loadCommandOrigin } from '../../../../platform/sync/command-origin.js';
import { fromBin, toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import { findProduct, findReasonCode } from '../../../catalog/application/public/index.js';
import {
  consumptionExists,
  declareLoss,
  findLossDeclaration,
  recordConsumption,
} from '../../../inventory/application/public/index.js';
import {
  DAILY,
  FORBIDDEN_SCOPE,
  LOT_NOT_FOUND as NOT_FOUND,
  businessRejection,
  dailyLot,
  farmLocation,
  isAllowed,
  loadLot,
  recordLotClosedConflict,
  rejected,
} from './shared.js';
import { emitProductionRecordChange } from '../sync-changes.js';

const mortalityPayloadSchema = z.object({
  productionLotId: z.string().uuid(),
  /** Emplacement de la ferme où les animaux sont morts ; à défaut, l'emplacement principal. */
  locationId: z.string().uuid().optional(),
  quantity: z.number().int().positive(),
  /** Cause (motif de catégorie `LOSS`), facultative (BR-PRD-005). */
  reasonCodeId: z.string().uuid().optional(),
  comment: z.string().trim().max(2000).optional(),
});

/** Natures d'une consommation de lot (BR-PRD-007 ; AV-049 : aliment pour l'indice). */
const INPUT_COST_TYPES = ['ALIMENT', 'VETERINAIRE', 'AUTRE_INTRANT'] as const;

const inputPayloadSchema = z.object({
  productionLotId: z.string().uuid(),
  /** Emplacement de la ferme d'où l'intrant est pris (magasin, bâtiment). */
  locationId: z.string().uuid(),
  productId: z.string().uuid(),
  lotId: z.string().uuid().optional(),
  quantityBase: z.number().positive(),
  unitCode: z.string().min(1).max(20),
  quantity: z.number().positive(),
  costType: z.enum(INPUT_COST_TYPES),
});

const weighingPayloadSchema = z.object({
  productionLotId: z.string().uuid(),
  locationId: z.string().uuid().optional(),
  sampleSize: z.number().int().positive(),
  avgWeightG: z.number().positive().max(1_000_000),
  totalWeightKg: z.number().positive().max(1_000_000_000).optional(),
  source: z.enum(['MANUAL', 'DEVICE']).optional(),
});

const weighingCancelPayloadSchema = z.object({
  comment: z.string().trim().min(1).max(2000),
  reasonCodeId: z.string().uuid().optional(),
});

const OBSERVATION_TYPES = [
  'SANITAIRE',
  'COMPORTEMENT',
  'ENVIRONNEMENT',
  'INCIDENT',
  'AUTRE',
] as const;

const observationPayloadSchema = z.object({
  productionLotId: z.string().uuid(),
  observationType: z.enum(OBSERVATION_TYPES),
  text: z.string().trim().min(1).max(4000),
  severity: z.enum(['INFO', 'WARNING', 'CRITICAL']).optional(),
});

function buildHandlers(idGenerator: IdGenerator, documentSequences: DocumentSequenceService) {
  const deps = { idGenerator };

  const mortality: CommandHandler<z.infer<typeof mortalityPayloadSchema>> = async (
    uow,
    envelope,
  ) => {
    const replay = await findLossDeclaration(uow, envelope.aggregate_id);
    if (replay) {
      return {
        status: 'APPLIED',
        serverRefs: { docNumber: replay.docNumber, status: replay.status },
      };
    }
    const guard = await dailyLot(uow, envelope);
    if (!guard.ok) return guard.outcome;
    const { lot, closed } = guard;
    const p = envelope.payload;
    const locationId = p.locationId ?? lot.mainLocationId;
    const invalidLocation = await farmLocation(uow, lot, locationId);
    if (invalidLocation) return invalidLocation;
    if (p.reasonCodeId !== undefined) {
      const reason = await findReasonCode(uow, p.reasonCodeId);
      if (!reason || reason.category !== 'LOSS') {
        return rejected(
          'REFERENCE_INVALID',
          'Cause de mortalité inconnue (motif de catégorie LOSS).',
        );
      }
    }
    const product = await findProduct(uow, lot.productId);
    const result = await declareLoss(
      uow,
      { idGenerator, documentSequences },
      {
        lossId: envelope.aggregate_id,
        locationId,
        productId: lot.productId,
        lotId: lot.stockLotId,
        productionLotId: lot.id,
        quantityBase: p.quantity,
        unitCode: product!.baseUnitCode,
        quantity: p.quantity,
        category: 'MORTALITE',
        ...(p.reasonCodeId !== undefined ? { reasonCodeId: p.reasonCodeId } : {}),
        ...(p.comment !== undefined ? { comment: p.comment } : {}),
        occurredAt: new Date(envelope.occurred_at),
        declaredBy: envelope.author_user_id,
        commandId: envelope.command_id,
        clientCreatedAt: new Date(envelope.client_created_at),
        capturedOffline: envelope.captured_offline,
        backdatedReason: envelope.backdated_reason,
        attachmentIds: envelope.attachment_ids,
      },
    );
    if (!result.ok) return result.outcome;
    const serverRefs = { docNumber: result.docNumber, status: result.status };
    if (closed) {
      const outcome = await recordLotClosedConflict(uow, deps, {
        commandId: envelope.command_id,
        lot,
        details: { lossId: envelope.aggregate_id, quantity: p.quantity },
      });
      return { ...outcome, serverRefs } as CommandHandlerOutcome;
    }
    return { status: 'APPLIED', serverRefs };
  };

  const input: CommandHandler<z.infer<typeof inputPayloadSchema>> = async (uow, envelope) => {
    if (await consumptionExists(uow, envelope.aggregate_id)) return { status: 'APPLIED' };
    const guard = await dailyLot(uow, envelope);
    if (!guard.ok) return guard.outcome;
    const { lot, closed } = guard;
    const p = envelope.payload;
    const invalidLocation = await farmLocation(uow, lot, p.locationId);
    if (invalidLocation) return invalidLocation;
    const product = await findProduct(uow, p.productId);
    if (!product || !product.isConsumable || product.stockFamily === 'BIOLOGIQUE') {
      return rejected(
        'PRODUCT_NOT_CONSUMABLE',
        'Seul un intrant consommable (aliment, produit vétérinaire…) se consomme sur un lot.',
      );
    }
    const result = await recordConsumption(uow, deps, {
      consumptionId: envelope.aggregate_id,
      locationId: p.locationId,
      productId: p.productId,
      ...(p.lotId !== undefined ? { lotId: p.lotId } : {}),
      quantityBase: p.quantityBase,
      unitCode: p.unitCode,
      quantity: p.quantity,
      costObjectType: 'PRODUCTION_LOT',
      costObjectId: lot.id,
      costType: p.costType,
      occurredAt: new Date(envelope.occurred_at),
      recordedBy: envelope.author_user_id,
      commandId: envelope.command_id,
      clientCreatedAt: new Date(envelope.client_created_at),
      capturedOffline: envelope.captured_offline,
      backdatedReason: envelope.backdated_reason,
    });
    if (!result.ok) return result.outcome;
    if (closed) {
      return recordLotClosedConflict(uow, deps, {
        commandId: envelope.command_id,
        lot,
        details: { consumptionId: envelope.aggregate_id, valueXaf: result.valueXaf },
      });
    }
    return { status: 'APPLIED' };
  };

  const weighing: CommandHandler<z.infer<typeof weighingPayloadSchema>> = async (uow, envelope) => {
    const weighingId = envelope.aggregate_id;
    const replay = await uow
      .selectFrom('production_lot_weighings')
      .select('id')
      .where('id', '=', toBin(weighingId))
      .executeTakeFirst();
    if (replay) return { status: 'APPLIED' };
    const guard = await dailyLot(uow, envelope);
    if (!guard.ok) return guard.outcome;
    const { lot, closed } = guard;
    const p = envelope.payload;
    if (p.locationId !== undefined) {
      const invalidLocation = await farmLocation(uow, lot, p.locationId, { rearingOnly: true });
      if (invalidLocation) return invalidLocation;
    }
    try {
      checkWeighing({
        sampleSize: p.sampleSize,
        avgWeightG: p.avgWeightG,
        totalWeightKg: p.totalWeightKg ?? null,
      });
    } catch (error) {
      return businessRejection(error);
    }
    const origin = await loadCommandOrigin(uow, envelope.command_id);
    await uow
      .insertInto('production_lot_weighings')
      .values({
        id: toBin(weighingId),
        production_lot_id: toBin(lot.id),
        location_id: toBinOrNull(p.locationId ?? null),
        sample_size: p.sampleSize,
        avg_weight_g: p.avgWeightG.toFixed(1),
        total_weight_kg: p.totalWeightKg === undefined ? null : p.totalWeightKg.toFixed(3),
        source: p.source ?? 'MANUAL',
        occurred_at: new Date(envelope.occurred_at),
        client_created_at: new Date(envelope.client_created_at),
        received_at_server: origin.receivedAt,
        command_id: toBin(envelope.command_id),
        created_device_id: toBinOrNull(origin.deviceId),
        captured_offline: envelope.captured_offline ? 1 : 0,
        clock_suspect: origin.clockSuspect ? 1 : 0,
        backdated_reason: envelope.backdated_reason,
        created_by: toBin(envelope.author_user_id),
      })
      .execute();
    await emitProductionRecordChange(uow, 'LOT_WEIGHING', weighingId);
    if (closed) {
      return recordLotClosedConflict(uow, deps, {
        commandId: envelope.command_id,
        lot,
        details: { weighingId },
      });
    }
    return { status: 'APPLIED' };
  };

  const cancelWeighing: CommandHandler<z.infer<typeof weighingCancelPayloadSchema>> = async (
    uow,
    envelope,
  ) => {
    const row = await uow
      .selectFrom('production_lot_weighings')
      .select(['id', 'production_lot_id', 'status'])
      .where('id', '=', toBin(envelope.aggregate_id))
      .forUpdate()
      .executeTakeFirst();
    if (!row) return rejected('NOT_FOUND', 'Pesée introuvable.');
    const lot = await loadLot(uow, fromBin(row.production_lot_id));
    if (!lot) return NOT_FOUND;
    const at = new Date(envelope.occurred_at);
    if (!(await isAllowed(uow, envelope.author_user_id, DAILY, at, lot.siteId))) {
      return FORBIDDEN_SCOPE;
    }
    if (row.status === 'CANCELLED') return { status: 'APPLIED' };
    if (envelope.payload.reasonCodeId !== undefined) {
      const reason = await findReasonCode(uow, envelope.payload.reasonCodeId);
      if (!reason || reason.category !== 'CANCELLATION') {
        return rejected(
          'REFERENCE_INVALID',
          'Motif d’annulation inconnu (catégorie CANCELLATION).',
        );
      }
    }
    await uow
      .updateTable('production_lot_weighings')
      .set({
        status: 'CANCELLED',
        cancelled_at: at,
        cancelled_by: toBin(envelope.author_user_id),
        cancel_reason_code_id: toBinOrNull(envelope.payload.reasonCodeId ?? null),
        cancel_comment: envelope.payload.comment,
        updated_by: toBin(envelope.author_user_id),
        version: sql`version + 1`,
      })
      .where('id', '=', row.id)
      .execute();
    await emitProductionRecordChange(uow, 'LOT_WEIGHING', fromBin(row.id));
    return { status: 'APPLIED' };
  };

  const observation: CommandHandler<z.infer<typeof observationPayloadSchema>> = async (
    uow,
    envelope,
  ) => {
    const observationId = envelope.aggregate_id;
    const replay = await uow
      .selectFrom('production_lot_observations')
      .select('id')
      .where('id', '=', toBin(observationId))
      .executeTakeFirst();
    if (replay) return { status: 'APPLIED' };
    const guard = await dailyLot(uow, envelope);
    if (!guard.ok) return guard.outcome;
    const { lot, closed } = guard;
    const p = envelope.payload;
    const origin = await loadCommandOrigin(uow, envelope.command_id);
    await uow
      .insertInto('production_lot_observations')
      .values({
        id: toBin(observationId),
        production_lot_id: toBin(lot.id),
        observation_type: p.observationType,
        text: p.text,
        severity: p.severity ?? 'INFO',
        occurred_at: new Date(envelope.occurred_at),
        client_created_at: new Date(envelope.client_created_at),
        received_at_server: origin.receivedAt,
        command_id: toBin(envelope.command_id),
        created_device_id: toBinOrNull(origin.deviceId),
        captured_offline: envelope.captured_offline ? 1 : 0,
        clock_suspect: origin.clockSuspect ? 1 : 0,
        backdated_reason: envelope.backdated_reason,
        created_by: toBin(envelope.author_user_id),
      })
      .execute();
    await emitProductionRecordChange(uow, 'LOT_OBSERVATION', observationId);
    if (closed) {
      return recordLotClosedConflict(uow, deps, {
        commandId: envelope.command_id,
        lot,
        details: { observationId },
      });
    }
    return { status: 'APPLIED' };
  };

  return { mortality, input, weighing, cancelWeighing, observation };
}

export function registerDailyCommands(
  registry: CommandHandlerRegistry,
  idGenerator: IdGenerator,
  documentSequences: DocumentSequenceService,
): void {
  const handlers = buildHandlers(idGenerator, documentSequences);
  registry.register({
    commandType: 'production.mortality.record',
    version: 1,
    payloadSchema: mortalityPayloadSchema,
    permissionCode: DAILY,
    handler: handlers.mortality,
  });
  registry.register({
    commandType: 'production.input.record',
    version: 1,
    payloadSchema: inputPayloadSchema,
    permissionCode: DAILY,
    handler: handlers.input,
  });
  registry.register({
    commandType: 'production.weighing.record',
    version: 1,
    payloadSchema: weighingPayloadSchema,
    permissionCode: DAILY,
    handler: handlers.weighing,
  });
  registry.register({
    commandType: 'production.weighing.cancel',
    version: 1,
    payloadSchema: weighingCancelPayloadSchema,
    permissionCode: DAILY,
    handler: handlers.cancelWeighing,
  });
  registry.register({
    commandType: 'production.observation.record',
    version: 1,
    payloadSchema: observationPayloadSchema,
    permissionCode: DAILY,
    handler: handlers.observation,
  });
}
