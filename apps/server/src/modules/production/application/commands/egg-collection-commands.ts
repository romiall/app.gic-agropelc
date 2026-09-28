/**
 * Collectes d'œufs (D07-PRD §7.3 ; SM-EGG-COLLECTION ; P7-07) :
 * `production.egg_collection.record` et `.cancel`, sous `production.daily.record`, hors ligne
 * possible.
 *
 * - Lot pondeuse ou reproducteur (AV-044 : le reproducteur est suivi comme une pondeuse),
 *   `LOT_NOT_LAYING` sinon ; plusieurs collectes par jour (AV-110).
 * - Bilan INV-OEU-01 : collectés = cassés + non conformes + Σ calibres commercialisables + à
 *   couver (`EGG_BALANCE_INVALID`) ; cassés et non conformes n'entrent pas en stock (BR-OEU-002).
 * - Calibres (AV-046) : produits dont le code figure dans `production.egg_grade_product_codes`
 *   (en ligne, `EGG_GRADE_INVALID` ; hors ligne, tout produit non biologique connu est accepté,
 *   la liste ayant pu changer) ; œufs à couver : produit `production.hatching_egg_product_code`
 *   (`HATCHING_PRODUCT_MISSING` s'il n'est pas paramétré).
 * - Lot de stock propre de la collecte (AV-100, origine `COLLECTION`, code = numéro `COL-…`),
 *   péremption = date de collecte + `production.egg_shelf_life_days` (AV-122).
 * - Valeur (AV-098, ADR-027) : `PRODUCTION_OUTPUT` au coût standard en vigueur de chaque produit
 *   (entrée valorisée, CMUP recalculé) — à défaut de coût standard, au CMUP courant, l'alerte à
 *   l'administrateur étant déduite en P9 (AV-124) ; le lot
 *   producteur est crédité (`PRODUCTION_TRANSFEREE`) de la valeur totale.
 * - Annulation (BR-OEU-004) : mouvements inverses au coût d'origine, crédit contrepassé, lot de
 *   stock clôturé ; œufs déjà sortis : refus en ligne (`STOCK_UNAVAILABLE`, défaut AV-120),
 *   appliquée hors ligne avec `STOCK_NEGATIVE` (SM-EGG-COLLECTION).
 */
import { z } from 'zod';
import { sql } from 'kysely';
import {
  addBusinessDays,
  businessDayOf,
  eggCollectionBalance,
  lotTypeProfile,
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
  findProductByCode,
  findReasonCode,
  findStandardUnitCostXaf,
  type ProductSummary,
} from '../../../catalog/application/public/index.js';
import {
  createStockLot,
  recordCostEntry,
  recordStockMove,
  reverseCostEntries,
  reverseDocumentMoves,
  setStockLotStatus,
  virtualLocationId,
} from '../../../inventory/application/public/index.js';
import {
  DAILY,
  DATE_ONLY,
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
  rejected,
  stringListSetting,
  stringSetting,
} from './shared.js';

const recordPayloadSchema = z.object({
  productionLotId: z.string().uuid(),
  /** Jour de la collecte ; à défaut, le jour métier de l'opération. */
  collectionDate: z.string().regex(DATE_ONLY).optional(),
  /** Emplacement de stockage des œufs de la ferme. */
  storageLocationId: z.string().uuid(),
  collected: z.number().int().nonnegative(),
  broken: z.number().int().nonnegative().default(0),
  nonconforming: z.number().int().nonnegative().default(0),
  hatching: z.number().int().nonnegative().default(0),
  /** Œufs commercialisables par calibre (un produit par calibre, AV-046). */
  grades: z
    .array(z.object({ productId: z.string().uuid(), quantity: z.number().int().nonnegative() }))
    .max(20)
    .default([]),
});
type RecordPayload = z.infer<typeof recordPayloadSchema>;

const cancelPayloadSchema = z.object({
  comment: z.string().trim().min(1).max(2000),
  reasonCodeId: z.string().uuid().optional(),
});

interface OutputLine {
  readonly id: string;
  readonly product: ProductSummary;
  readonly quantity: number;
}

function buildHandlers(idGenerator: IdGenerator, documentSequences: DocumentSequenceService) {
  const deps = { idGenerator };

  const record: CommandHandler<RecordPayload> = async (uow, envelope) => {
    const collectionId = envelope.aggregate_id;
    const replay = await uow
      .selectFrom('production_egg_collections')
      .select(['doc_number', 'stock_lot_id'])
      .where('id', '=', toBin(collectionId))
      .executeTakeFirst();
    if (replay) {
      return {
        status: 'APPLIED',
        serverRefs: { docNumber: replay.doc_number, stockLotId: fromBin(replay.stock_lot_id) },
      };
    }
    const guard = await dailyLot(uow, envelope, (candidate) =>
      lotTypeProfile(candidate.lotType).laysEggs
        ? undefined
        : rejected(
            'LOT_NOT_LAYING',
            'Collecte d’œufs sur un lot de pondeuses ou de reproducteurs seulement.',
          ),
    );
    if (!guard.ok) return guard.outcome;
    const { lot, closed } = guard;
    const p = envelope.payload;
    const at = new Date(envelope.occurred_at);
    const offline = envelope.captured_offline;
    const invalidLocation = await farmLocation(uow, lot, p.storageLocationId);
    if (invalidLocation) return invalidLocation;
    const today = businessDayOf(at);
    const collectionDate = p.collectionDate ?? today;
    if (collectionDate > today) {
      return rejected(
        'COLLECTION_DATE_INVALID',
        'La date de collecte est postérieure à la saisie.',
      );
    }
    const grades = p.grades.filter((line) => line.quantity > 0);
    let marketable: number;
    try {
      addBusinessDays(collectionDate, 0); // date du calendrier (INVALID_BUSINESS_DAY)
      marketable = eggCollectionBalance({
        collected: p.collected,
        broken: p.broken,
        nonconforming: p.nonconforming,
        hatching: p.hatching,
        marketableByGrade: grades.map((line) => ({
          grade: line.productId,
          quantity: line.quantity,
        })),
      }).marketable;
    } catch (error) {
      return businessRejection(error);
    }

    // Calibres paramétrés (AV-046) et produit des œufs à couver.
    const gradeCodes = await stringListSetting(uow, 'production.egg_grade_product_codes', at);
    const lines: OutputLine[] = [];
    for (const grade of grades) {
      const product = await findProduct(uow, grade.productId);
      if (
        !product ||
        product.stockFamily === 'BIOLOGIQUE' ||
        (!offline && (!gradeCodes.includes(product.code) || product.status !== 'ACTIVE'))
      ) {
        return rejected(
          'EGG_GRADE_INVALID',
          'Calibre inconnu ou non paramétré (production.egg_grade_product_codes, AV-046).',
        );
      }
      lines.push({ id: idGenerator.newId(), product, quantity: grade.quantity });
    }
    let hatchingProduct: ProductSummary | undefined;
    if (p.hatching > 0) {
      const code = await stringSetting(uow, 'production.hatching_egg_product_code', at);
      hatchingProduct = code ? await findProductByCode(uow, code) : undefined;
      if (!hatchingProduct) {
        return rejected(
          'HATCHING_PRODUCT_MISSING',
          'Produit des œufs à couver non paramétré (production.hatching_egg_product_code).',
        );
      }
      if (lines.some((line) => line.product.id === hatchingProduct!.id)) {
        return rejected(
          'EGG_GRADE_INVALID',
          'Le produit des œufs à couver ne peut pas être un calibre commercialisable.',
        );
      }
      lines.push({ id: idGenerator.newId(), product: hatchingProduct, quantity: p.hatching });
    }

    const storage = (await loadLocation(uow, p.storageLocationId))!;
    const docNumber = await documentSequences.next(uow, {
      docType: 'COL',
      siteId: lot.siteId,
      codeSite: storage.siteCode,
      year: documentYear(at),
    });
    const shelfLifeDays = Math.trunc(
      await numberSetting(uow, 'production.egg_shelf_life_days', at, 28),
    );
    const stockLotId = await createStockLot(uow, deps, {
      originType: 'COLLECTION',
      originId: collectionId,
      lotCode: docNumber,
      productId: lines.length === 1 ? lines[0]!.product.id : null,
      fifoRankAt: at,
      expiryDate: shelfLifeDays > 0 ? addBusinessDays(collectionDate, shelfLifeDays) : null,
      createdBy: envelope.author_user_id,
    });

    const productionLocation = await virtualLocationId(uow, 'V_PRODUCTION');
    const unitCosts = new Map<string, number>();
    let totalValue = 0;
    try {
      for (const line of lines) {
        const standard = await findStandardUnitCostXaf(uow, line.product.id, at);
        const moves = await recordStockMove(uow, deps, {
          productId: line.product.id,
          ...(line.product.lotTracking !== 'NONE' ? { lotId: stockLotId } : {}),
          quantityBase: line.quantity,
          fromLocationId: productionLocation,
          toLocationId: p.storageLocationId,
          moveType: 'PRODUCTION_OUTPUT',
          ...(standard !== undefined ? { declaredUnitCostXaf: standard } : {}),
          occurredAt: at,
          sourceDocType: 'EGG_COLLECTION',
          sourceDocId: collectionId,
          sourceLineId: line.id,
          costObjectType: 'PRODUCTION_LOT',
          costObjectId: lot.id,
          createdBy: envelope.author_user_id,
          commandId: envelope.command_id,
          capturedOffline: offline,
          allowNegative: offline,
        });
        unitCosts.set(line.id, moves[0]?.unitCostXaf ?? 0);
        totalValue += moves.reduce((sum, move) => sum + move.valueXaf, 0);
      }
    } catch (error) {
      return businessRejection(error);
    }

    const origin = await loadCommandOrigin(uow, envelope.command_id);
    await uow
      .insertInto('production_egg_collections')
      .values({
        id: toBin(collectionId),
        doc_number: docNumber,
        production_lot_id: toBin(lot.id),
        site_id: toBin(lot.siteId),
        collection_date: sql<Date>`${collectionDate}`,
        storage_location_id: toBin(p.storageLocationId),
        stock_lot_id: toBin(stockLotId),
        hatching_product_id: toBinOrNull(hatchingProduct?.id ?? null),
        collected_qty: p.collected,
        broken_qty: p.broken,
        nonconforming_qty: p.nonconforming,
        marketable_qty: marketable,
        hatching_qty: p.hatching,
        standard_value_xaf: totalValue,
        occurred_at: at,
        client_created_at: new Date(envelope.client_created_at),
        received_at_server: origin.receivedAt,
        command_id: toBin(envelope.command_id),
        created_device_id: toBinOrNull(origin.deviceId),
        captured_offline: offline ? 1 : 0,
        clock_suspect: origin.clockSuspect ? 1 : 0,
        backdated_reason: envelope.backdated_reason,
        created_by: toBin(envelope.author_user_id),
      })
      .execute();
    const gradeLines = lines.filter((line) => line.product.id !== hatchingProduct?.id);
    if (gradeLines.length > 0) {
      await uow
        .insertInto('production_egg_collection_lines')
        .values(
          gradeLines.map((line) => ({
            id: toBin(line.id),
            collection_id: toBin(collectionId),
            product_id: toBin(line.product.id),
            quantity: line.quantity,
            unit_cost_xaf: unitCosts.get(line.id) ?? 0,
          })),
        )
        .execute();
    }
    // AV-098 : le lot producteur est crédité de la valeur des œufs entrés en stock.
    await recordCostEntry(uow, deps, {
      costObjectType: 'PRODUCTION_LOT',
      costObjectId: lot.id,
      costType: 'PRODUCTION_TRANSFEREE',
      amountXaf: totalValue,
      direction: 'CREDIT',
      sourceType: 'PRODUCTION',
      sourceId: collectionId,
      occurredAt: at,
      createdBy: envelope.author_user_id,
      comment: `Collecte ${docNumber}`,
    });
    const serverRefs = { docNumber, stockLotId };
    if (closed) {
      const outcome = await recordLotClosedConflict(uow, deps, {
        commandId: envelope.command_id,
        lot,
        details: { collectionId, docNumber, collected: p.collected },
      });
      return { ...outcome, serverRefs } as CommandHandlerOutcome;
    }
    return { status: 'APPLIED', serverRefs };
  };

  const cancel: CommandHandler<z.infer<typeof cancelPayloadSchema>> = async (uow, envelope) => {
    const collectionId = envelope.aggregate_id;
    const row = await uow
      .selectFrom('production_egg_collections')
      .select(['id', 'production_lot_id', 'stock_lot_id', 'status', 'doc_number'])
      .where('id', '=', toBin(collectionId))
      .forUpdate()
      .executeTakeFirst();
    if (!row) return rejected('NOT_FOUND', 'Collecte introuvable.');
    const lot = await loadLot(uow, fromBin(row.production_lot_id));
    if (!lot) return LOT_NOT_FOUND;
    const at = new Date(envelope.occurred_at);
    const author = envelope.author_user_id;
    const offline = envelope.captured_offline;
    if (!(await isAllowed(uow, author, DAILY, at, lot.siteId))) return FORBIDDEN_SCOPE;
    if (row.status === 'CANCELLED') return { status: 'APPLIED' };
    const closedLot = lot.status === 'CLOSED' || lot.status === 'CANCELLED';
    if (closedLot && !offline) {
      return rejected(
        'LOT_NOT_ACTIVE',
        'Lot producteur clôturé : son coût est figé, la collecte ne s’annule plus.',
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
    let negative = false;
    try {
      const reversed = await reverseDocumentMoves(uow, deps, {
        sourceDocType: 'EGG_COLLECTION',
        sourceDocId: collectionId,
        occurredAt: at,
        createdBy: author,
        commandId: envelope.command_id,
        capturedOffline: offline,
        allowNegative: offline,
      });
      negative = reversed.some((move) => move.negativeBalance);
    } catch (error) {
      const outcome = businessRejection(error);
      if (outcome.status === 'REJECTED' && outcome.errorCode === 'INSUFFICIENT_STOCK') {
        return rejected(
          'STOCK_UNAVAILABLE',
          'Des œufs de cette collecte sont déjà sortis du stock : annulation impossible (AV-120).',
        );
      }
      return outcome;
    }
    await reverseCostEntries(uow, deps, {
      sourceType: 'PRODUCTION',
      sourceIds: [collectionId],
      occurredAt: at,
      createdBy: author,
      comment: envelope.payload.comment,
    });
    await uow
      .updateTable('production_egg_collections')
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
    if (closedLot) {
      const outcome = await recordLotClosedConflict(uow, deps, {
        commandId: envelope.command_id,
        lot,
        details: { collectionId, docNumber: row.doc_number, cancelled: true },
      });
      return negative
        ? { status: 'APPLIED_WITH_WARNINGS', warnings: ['LOT_CLOSED', 'STOCK_NEGATIVE'] }
        : outcome;
    }
    return negative
      ? { status: 'APPLIED_WITH_WARNINGS', warnings: ['STOCK_NEGATIVE'] }
      : { status: 'APPLIED' };
  };

  return { record, cancel };
}

export function registerEggCollectionCommands(
  registry: CommandHandlerRegistry,
  idGenerator: IdGenerator,
  documentSequences: DocumentSequenceService,
): void {
  const handlers = buildHandlers(idGenerator, documentSequences);
  registry.register({
    commandType: 'production.egg_collection.record',
    version: 1,
    payloadSchema: recordPayloadSchema as unknown as z.ZodType<RecordPayload>,
    permissionCode: DAILY,
    handler: handlers.record,
  });
  registry.register({
    commandType: 'production.egg_collection.cancel',
    version: 1,
    payloadSchema: cancelPayloadSchema,
    permissionCode: DAILY,
    handler: handlers.cancel,
  });
}
