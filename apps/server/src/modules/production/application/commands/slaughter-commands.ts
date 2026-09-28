/**
 * Abattage (P7-09 ; AV-032, AV-100, AV-101, AV-102 ; défauts AV-114, AV-115, AV-125) :
 * `production.slaughter.record` (saisie du jour, hors ligne possible) et `.cancel`.
 *
 * - À la ferme (AV-101) : emplacement `SLAUGHTERHOUSE` de la ferme du lot ; animaux pris sur un
 *   bâtiment ou une case ; type de lot abattable (`production.slaughterable_lot_types`,
 *   `LOT_NOT_SLAUGHTERABLE`).
 * - Transformation (AV-032) : les têtes abattues (saisies comprises, AV-114 : consommées sans
 *   produit) sortent du lot vers `V_PRODUCTION` au coût par tête du lot (coût restant,
 *   ADR-027) ; les produits obtenus (poulet entier à la pièce, découpes et abats au kilo,
 *   AV-102) entrent sous le **lot de stock propre** de l'abattage (origine `TRANSFORMATION`,
 *   code `ABT-…`, péremption = jour de l'abattage + `production.slaughter_shelf_life_days`),
 *   chacun avec sa part de la valeur répartie au prorata du poids, au franc près (ADR-026).
 * - Rendement = poids des produits ÷ poids vif (AV-049) ; bilan `checkSlaughter`
 *   (`SLAUGHTER_INVALID`).
 * - Annulation (Responsable production, comme une entrée de lot, AV-123) : mouvements inverses
 *   au coût d'origine, animaux rendus au lot ; produits déjà sortis : `STOCK_UNAVAILABLE`
 *   (défaut AV-120) ; lot de stock de l'abattage clôturé.
 */
import { z } from 'zod';
import { sql } from 'kysely';
import {
  addBusinessDays,
  allocateByWeight,
  businessDayOf,
  checkSlaughter,
  quantityFromDecimal,
  unitCostXaf,
  type IdGenerator,
} from '@gic/domain';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import type { DocumentSequenceService } from '../../../../platform/document-sequences/document-sequence.service.js';
import { loadCommandOrigin } from '../../../../platform/sync/command-origin.js';
import { fromBin, toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import {
  findProduct,
  findReasonCode,
  type ProductSummary,
} from '../../../catalog/application/public/index.js';
import {
  createStockLot,
  recordStockMove,
  reverseDocumentMoves,
  setStockLotStatus,
  virtualLocationId,
} from '../../../inventory/application/public/index.js';
import {
  FORBIDDEN_SCOPE,
  LOT_NOT_FOUND,
  businessRejection,
  dailyLot,
  documentYear,
  farmLocation,
  isAllowed,
  loadLocation,
  loadLot,
  numberSetting,
  recordLotClosedConflict,
  recordProductionInput,
  rejected,
  settingValue,
} from './shared.js';

const MANAGE = 'production.lot.manage';
const DAILY = 'production.daily.record';

/** Défaut AV-115 : poulet de chair seul, si le paramètre est absent. */
const DEFAULT_SLAUGHTERABLE = ['POULET_CHAIR'];

const recordPayloadSchema = z.object({
  productionLotId: z.string().uuid(),
  /** Bâtiment ou case d'où viennent les animaux. */
  sourceLocationId: z.string().uuid(),
  /** Abattoir de la ferme (AV-101). */
  slaughterhouseLocationId: z.string().uuid(),
  heads: z.number().int().positive(),
  condemnedHeads: z.number().int().nonnegative().default(0),
  liveWeightG: z.number().int().positive(),
  outputs: z
    .array(
      z.object({
        productId: z.string().uuid(),
        /** Emplacement de stockage (chambre froide, magasin de la ferme). */
        toLocationId: z.string().uuid(),
        /** Quantité en unité de base du produit (pièces pour l'entier, kg pour les découpes). */
        quantityBase: z.number().positive(),
        weightG: z.number().int().positive(),
      }),
    )
    .min(1)
    .max(20),
});
type RecordPayload = z.infer<typeof recordPayloadSchema>;

const cancelPayloadSchema = z.object({
  comment: z.string().trim().min(1).max(2000),
  reasonCodeId: z.string().uuid().optional(),
});

function buildHandlers(idGenerator: IdGenerator, documentSequences: DocumentSequenceService) {
  const deps = { idGenerator };

  const record: CommandHandler<RecordPayload> = async (uow, envelope) => {
    const slaughterId = envelope.aggregate_id;
    const replay = await uow
      .selectFrom('production_slaughter_batches')
      .select(['doc_number', 'stock_lot_id'])
      .where('id', '=', toBin(slaughterId))
      .executeTakeFirst();
    if (replay) {
      return {
        status: 'APPLIED',
        serverRefs: { docNumber: replay.doc_number, stockLotId: fromBin(replay.stock_lot_id) },
      };
    }
    const p = envelope.payload;
    const at = new Date(envelope.occurred_at);
    const author = envelope.author_user_id;
    const offline = envelope.captured_offline;
    const configured = await settingValue(uow, 'production.slaughterable_lot_types', at);
    const slaughterable = Array.isArray(configured)
      ? configured.filter((v): v is string => typeof v === 'string')
      : DEFAULT_SLAUGHTERABLE;
    const guard = await dailyLot(uow, envelope, (lot) =>
      slaughterable.includes(lot.lotType)
        ? undefined
        : rejected(
            'LOT_NOT_SLAUGHTERABLE',
            'Ce type de lot n’est pas abattable (production.slaughterable_lot_types, AV-115).',
          ),
    );
    if (!guard.ok) return guard.outcome;
    const { lot, closed } = guard;
    const house = await loadLocation(uow, p.slaughterhouseLocationId);
    if (
      !house ||
      !house.isActive ||
      house.siteId !== lot.siteId ||
      house.locationType !== 'SLAUGHTERHOUSE'
    ) {
      return rejected('LOCATION_INVALID', 'L’abattoir de la ferme du lot est attendu (AV-101).');
    }
    const invalidSource = await farmLocation(uow, lot, p.sourceLocationId, { rearingOnly: true });
    if (invalidSource) return invalidSource;

    let outputWeightG: number;
    let yieldRate: number | null;
    try {
      ({ outputWeightG, yieldRate } = checkSlaughter({
        heads: p.heads,
        condemnedHeads: p.condemnedHeads,
        liveWeightG: p.liveWeightG,
        outputs: p.outputs.map((output) => ({ key: output.productId, weightG: output.weightG })),
      }));
    } catch (error) {
      return businessRejection(error);
    }
    const products = new Map<string, ProductSummary>();
    for (const output of p.outputs) {
      const product = await findProduct(uow, output.productId);
      if (
        !product ||
        product.stockFamily === 'BIOLOGIQUE' ||
        (!offline && product.status !== 'ACTIVE')
      ) {
        return rejected(
          'OUTPUT_PRODUCT_INVALID',
          'Produit d’abattage inconnu, inactif ou biologique (entier, découpe, abat).',
        );
      }
      const invalidTarget = await farmLocation(uow, lot, output.toLocationId);
      if (invalidTarget) return invalidTarget;
      products.set(output.productId, product);
    }

    const docNumber = await documentSequences.next(uow, {
      docType: 'ABT',
      siteId: lot.siteId,
      codeSite: house.siteCode,
      year: documentYear(at),
    });
    const shelfLifeDays = Math.trunc(
      await numberSetting(uow, 'production.slaughter_shelf_life_days', at, 5),
    );
    const stockLotId = await createStockLot(uow, deps, {
      originType: 'TRANSFORMATION',
      originId: slaughterId,
      lotCode: docNumber,
      productId: p.outputs.length === 1 ? p.outputs[0]!.productId : null,
      fifoRankAt: at,
      expiryDate: shelfLifeDays > 0 ? addBusinessDays(businessDayOf(at), shelfLifeDays) : null,
      createdBy: author,
    });

    const outputRows: {
      id: string;
      productId: string;
      toLocationId: string;
      quantityBase: number;
      weightG: number;
      valueXaf: number;
      unitCostXaf: number;
    }[] = [];
    let inputValue: number;
    try {
      // Les têtes abattues (saisies comprises) sortent du lot au coût par tête (ADR-027).
      inputValue = await recordProductionInput(uow, deps, {
        productId: lot.productId,
        lotId: lot.stockLotId,
        quantityBase: p.heads,
        fromLocationId: p.sourceLocationId,
        occurredAt: at,
        sourceDocType: 'SLAUGHTER',
        sourceDocId: slaughterId,
        costObjectType: 'PRODUCTION_LOT',
        costObjectId: lot.id,
        createdBy: author,
        commandId: envelope.command_id,
        capturedOffline: offline,
        allowNegative: offline,
      });
      const shares = allocateByWeight(
        inputValue,
        p.outputs.map((output) => ({ key: output.productId, weightG: output.weightG })),
      );
      const shareOf = new Map(shares.map((share) => [share.key, share.amountXaf as number]));
      const productionLocation = await virtualLocationId(uow, 'V_PRODUCTION');
      for (const output of p.outputs) {
        const product = products.get(output.productId)!;
        const valueXaf = shareOf.get(output.productId) ?? 0;
        const lineId = idGenerator.newId();
        await recordStockMove(uow, deps, {
          productId: output.productId,
          ...(product.lotTracking !== 'NONE' ? { lotId: stockLotId } : {}),
          quantityBase: output.quantityBase,
          fromLocationId: productionLocation,
          toLocationId: output.toLocationId,
          moveType: 'PRODUCTION_OUTPUT',
          declaredValueXaf: valueXaf,
          occurredAt: at,
          sourceDocType: 'SLAUGHTER',
          sourceDocId: slaughterId,
          sourceLineId: lineId,
          costObjectType: 'PRODUCTION_LOT',
          costObjectId: lot.id,
          createdBy: author,
          commandId: envelope.command_id,
          capturedOffline: offline,
          allowNegative: offline,
        });
        outputRows.push({
          id: lineId,
          productId: output.productId,
          toLocationId: output.toLocationId,
          quantityBase: output.quantityBase,
          weightG: output.weightG,
          valueXaf,
          unitCostXaf: unitCostXaf(valueXaf, quantityFromDecimal(output.quantityBase)),
        });
      }
    } catch (error) {
      return businessRejection(error);
    }

    const origin = await loadCommandOrigin(uow, envelope.command_id);
    await uow
      .insertInto('production_slaughter_batches')
      .values({
        id: toBin(slaughterId),
        doc_number: docNumber,
        production_lot_id: toBin(lot.id),
        site_id: toBin(lot.siteId),
        source_location_id: toBin(p.sourceLocationId),
        location_id: toBin(house.id),
        input_product_id: toBin(lot.productId),
        heads_qty: p.heads,
        condemned_heads: p.condemnedHeads,
        live_weight_g: p.liveWeightG,
        output_weight_g: outputWeightG,
        total_input_value_xaf: inputValue,
        yield_rate: yieldRate === null ? null : yieldRate.toFixed(4),
        stock_lot_id: toBin(stockLotId),
        occurred_at: at,
        client_created_at: new Date(envelope.client_created_at),
        received_at_server: origin.receivedAt,
        command_id: toBin(envelope.command_id),
        created_device_id: toBinOrNull(origin.deviceId),
        captured_offline: offline ? 1 : 0,
        clock_suspect: origin.clockSuspect ? 1 : 0,
        backdated_reason: envelope.backdated_reason,
        created_by: toBin(author),
      })
      .execute();
    await uow
      .insertInto('production_slaughter_outputs')
      .values(
        outputRows.map((row) => ({
          id: toBin(row.id),
          slaughter_id: toBin(slaughterId),
          product_id: toBin(row.productId),
          to_location_id: toBin(row.toLocationId),
          quantity_base: String(row.quantityBase),
          weight_g: row.weightG,
          allocated_value_xaf: row.valueXaf,
          unit_cost_xaf: row.unitCostXaf,
        })),
      )
      .execute();
    const serverRefs = { docNumber, stockLotId };
    if (closed) {
      const outcome = await recordLotClosedConflict(uow, deps, {
        commandId: envelope.command_id,
        lot,
        details: { slaughterId, docNumber, heads: p.heads },
      });
      return { ...outcome, serverRefs } as CommandHandlerOutcome;
    }
    return { status: 'APPLIED', serverRefs };
  };

  const cancel: CommandHandler<z.infer<typeof cancelPayloadSchema>> = async (uow, envelope) => {
    const slaughterId = envelope.aggregate_id;
    const row = await uow
      .selectFrom('production_slaughter_batches')
      .select(['id', 'production_lot_id', 'stock_lot_id', 'status'])
      .where('id', '=', toBin(slaughterId))
      .forUpdate()
      .executeTakeFirst();
    if (!row) return rejected('NOT_FOUND', 'Abattage introuvable.');
    const lot = await loadLot(uow, fromBin(row.production_lot_id));
    if (!lot) return LOT_NOT_FOUND;
    const at = new Date(envelope.occurred_at);
    const author = envelope.author_user_id;
    if (!(await isAllowed(uow, author, MANAGE, at, lot.siteId))) return FORBIDDEN_SCOPE;
    if (row.status === 'CANCELLED') return { status: 'APPLIED' };
    if (lot.status === 'CLOSED' || lot.status === 'CANCELLED') {
      return rejected(
        'LOT_NOT_ACTIVE',
        'Lot clôturé : son coût est figé, l’abattage ne s’annule plus.',
      );
    }
    if (envelope.payload.reasonCodeId !== undefined) {
      const reason = await findReasonCode(uow, envelope.payload.reasonCodeId);
      if (!reason || reason.category !== 'CANCELLATION') {
        return rejected(
          'REFERENCE_INVALID',
          'Motif d’annulation inconnu (catégorie CANCELLATION).',
        );
      }
    }
    try {
      await reverseDocumentMoves(uow, deps, {
        sourceDocType: 'SLAUGHTER',
        sourceDocId: slaughterId,
        occurredAt: at,
        createdBy: author,
        commandId: envelope.command_id,
        capturedOffline: envelope.captured_offline,
        allowNegative: false,
      });
    } catch (error) {
      const outcome = businessRejection(error);
      if (outcome.status === 'REJECTED' && outcome.errorCode === 'INSUFFICIENT_STOCK') {
        return rejected(
          'STOCK_UNAVAILABLE',
          'Des produits de cet abattage sont déjà sortis du stock : annulation impossible (AV-120).',
        );
      }
      return outcome;
    }
    await uow
      .updateTable('production_slaughter_batches')
      .set({
        status: 'CANCELLED',
        cancelled_at: at,
        cancelled_by: toBin(author),
        cancel_reason_code_id: toBinOrNull(envelope.payload.reasonCodeId ?? null),
        cancel_comment: envelope.payload.comment,
        updated_by: toBin(author),
        version: sql`version + 1`,
      })
      .where('id', '=', row.id)
      .execute();
    await setStockLotStatus(uow, fromBin(row.stock_lot_id), 'CLOSED');
    return { status: 'APPLIED' };
  };

  return { record, cancel };
}

export function registerSlaughterCommands(
  registry: CommandHandlerRegistry,
  idGenerator: IdGenerator,
  documentSequences: DocumentSequenceService,
): void {
  const handlers = buildHandlers(idGenerator, documentSequences);
  registry.register({
    commandType: 'production.slaughter.record',
    version: 1,
    payloadSchema: recordPayloadSchema as unknown as z.ZodType<RecordPayload>,
    permissionCode: DAILY,
    handler: handlers.record,
  });
  registry.register({
    commandType: 'production.slaughter.cancel',
    version: 1,
    payloadSchema: cancelPayloadSchema,
    permissionCode: MANAGE,
    handler: handlers.cancel,
  });
}
