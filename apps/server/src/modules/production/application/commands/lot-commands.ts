/**
 * Lots de production (D07-PRD ; SM-PRODUCTION-LOT ; P7-05) :
 * `production.lot.create`, `.cancel`, `.set_status`, `.record_entry`, `.cancel_entry`, `.close`.
 *
 * - Création (BR-PRD-001, BR-PRD-002) : produit biologique de l'espèce du type de lot, suivi par
 *   lot ; emplacement principal d'élevage (`BUILDING`, `PEN`) d'une ferme ; numéro `LOT-…` qui
 *   sert aussi de code au lot de traçabilité (`inventory.stock_lots`, origine `PRODUCTION_LOT`) ;
 *   lot parent facultatif de la même ferme et de la même espèce (AV-099 : bande).
 * - Entrées (BR-PRD-004, BR-POR-002 ; AV-111, AV-112 ; ADR-027) — la première fait passer le lot
 *   `PLANNED` → `ACTIVE` :
 *   - mise en place depuis le stock ou depuis une réception d'achat (même lot de commandes que
 *     `procurement.receipt.record`) : reclassement `PRODUCTION_INPUT` des animaux d'origine
 *     (valeur = CMUP, ou coût par tête d'un lot d'incubation) puis `PRODUCTION_OUTPUT` du produit
 *     du lot vers l'élevage à cette valeur ; écriture de coût `ANIMAUX` du même montant ;
 *   - naissance (lot de porcelets lié au lot de truies) : `PRODUCTION_OUTPUT` au coût standard du
 *     porcelet (AV-098), `ANIMAUX` au lot de porcelets et crédit `PRODUCTION_TRANSFEREE` du même
 *     montant au lot de truies ; mort-nés comptés, hors stock ;
 *   - transfert et sevrage : sortie du lot d'origine au coût par tête (coût restant, AV-097),
 *     entrée dans le lot de destination à cette valeur.
 *   Hors ligne, une entrée sur un lot clôturé ou annulé est appliquée (BR-SYN-007) avec le
 *   conflit informatif `LOT_CLOSED` (matrice des conflits, Resp. production).
 * - Annulation d'une entrée (ADR-006 ; Responsable production seul, AV-123) : mouvements inverses au coût d'origine et écritures de
 *   coût contrepassées ; refusée si les animaux sont déjà sortis (`STOCK_UNAVAILABLE`, AV-120).
 * - Clôture (BR-PRD-011) : effectif non vendu nul (`LOT_NOT_EMPTY`), aucune tête en attente de
 *   validation d'une perte (`LOT_HAS_PENDING_LOSS`), aucune tête vendue non livrée
 *   (`LOT_HAS_UNDELIVERED`, ADR-029 §9 : une annulation ou une livraison la rendrait au lot ou la
 *   sortirait d'un lot clôturé) ; part estimée des frais généraux de chaque
 *   mois non encore réparti (AV-105, ADR-026) ; indicateurs figés dans `closing_summary` ; lot
 *   de traçabilité clôturé (INV-PRD-02).
 */
import { z } from 'zod';
import { sql } from 'kysely';
import {
  DomainError,
  PRODUCTION_LOT_TYPES,
  acceptsDailyEntries,
  acceptsLotEntries,
  businessDayOf,
  checkLotEntry,
  lotAcceptsProductSpecies,
  lotTypeProfile,
  mortalityRate,
  quantityFromDecimal,
  speciesGroupOfProduct,
  unitCostXaf,
  type IdGenerator,
  type LotEntrySourceKind,
} from '@gic/domain';
import type {
  CommandHandler,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import type { DocumentSequenceService } from '../../../../platform/document-sequences/document-sequence.service.js';
import { loadCommandOrigin } from '../../../../platform/sync/command-origin.js';
import { jsonValue } from '../../../../platform/kysely/json-value.js';
import { hasConflict } from '../../../../platform/sync/conflicts.js';
import { fromBin, toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import {
  findProduct,
  findReasonCode,
  findStandardUnitCostXaf,
} from '../../../catalog/application/public/index.js';
import {
  biologicalLotRemainingCostXaf,
  InventoryMoveError,
  costObjectBalance,
  findStockLot,
  lotLostQuantity,
  stockLotBalance,
  createStockLot,
  lotHeadcount,
  lotMortalitySummary,
  recordCostEntry,
  recordStockMove,
  reverseCostEntries,
  reverseDocumentMoves,
  setStockLotSellableFromRearing,
  setStockLotStatus,
  virtualLocationId,
  type RecordedMove,
} from '../../../inventory/application/public/index.js';
import {
  PLACEABLE_RECEIPT_STATUSES,
  findReceiptForPlacement,
} from '../../../procurement/application/public/index.js';
import {
  DATE_ONLY,
  FORBIDDEN_SCOPE,
  REARING_LOCATION_TYPES,
  businessRejection,
  documentYear,
  fromMilli,
  isAllowed,
  loadLocation,
  loadLot,
  milli,
  recordLotClosedConflict,
  rejected,
  type LotRow,
  type Uow,
} from './shared.js';
import { emitProductionLotChange, emitProductionRecordChange } from '../sync-changes.js';
import { allocateOverheads } from '../overhead-allocation.js';

const MANAGE = 'production.lot.manage';
const DAILY = 'production.daily.record';

const NOT_FOUND = rejected('NOT_FOUND', 'Lot de production introuvable.');

const createPayloadSchema = z.object({
  lotType: z.enum(PRODUCTION_LOT_TYPES),
  productId: z.string().uuid(),
  mainLocationId: z.string().uuid(),
  parentLotId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
  strain: z.string().trim().min(1).max(100).optional(),
  plannedStartDate: z.string().regex(DATE_ONLY).optional(),
  plannedEndDate: z.string().regex(DATE_ONLY).optional(),
  notes: z.string().trim().max(4000).optional(),
});

const cancelPayloadSchema = z.object({
  comment: z.string().trim().min(1).max(2000),
  reasonCodeId: z.string().uuid().optional(),
});

const statusPayloadSchema = z.object({ status: z.enum(['ACTIVE', 'SELLING']) });

const SOURCE_KINDS = ['PURCHASE', 'INTERNAL_STOCK', 'BIRTH', 'TRANSFER', 'WEANING'] as const;

const entryPayloadSchema = z.object({
  productionLotId: z.string().uuid(),
  sourceKind: z.enum(SOURCE_KINDS),
  /** Têtes (unité de base des produits biologiques, comptée). */
  quantity: z.number().int().positive(),
  /** Emplacement d'élevage de destination ; à défaut, l'emplacement principal du lot. */
  toLocationId: z.string().uuid().optional(),
  /** Stock, transfert, sevrage : emplacement où se trouvent les animaux d'origine. */
  sourceLocationId: z.string().uuid().optional(),
  /** Stock, achat : produit d'origine (poussins, porcelets achetés…). */
  sourceProductId: z.string().uuid().optional(),
  /** Stock : lot de stock d'origine (lot d'incubation, lot fournisseur) ; sinon FIFO. */
  sourceStockLotId: z.string().uuid().optional(),
  /** Achat : réception enregistrée dans le même lot de commandes (AV-112). */
  goodsReceiptId: z.string().uuid().optional(),
  /** Transfert, sevrage : lot de production d'origine. */
  sourceProductionLotId: z.string().uuid().optional(),
  /** Naissance : mort-nés (comptés, hors stock ; AV-111). */
  stillbornQty: z.number().int().nonnegative().optional(),
  avgWeightG: z.number().positive().max(1_000_000).optional(),
});
type EntryPayload = z.infer<typeof entryPayloadSchema>;

const closePayloadSchema = z.object({});

const cancelEntryPayloadSchema = z.object({
  comment: z.string().trim().min(1).max(2000),
  reasonCodeId: z.string().uuid().optional(),
});

function entryTypeOf(kind: LotEntrySourceKind): 'PLACEMENT' | 'BIRTH' | 'TRANSFER_IN' {
  if (kind === 'PURCHASE' || kind === 'INTERNAL_STOCK') return 'PLACEMENT';
  return kind === 'BIRTH' ? 'BIRTH' : 'TRANSFER_IN';
}

/** Colonne `DATE` au jour métier de l'opération (`AAAA-MM-JJ` converti par MySQL). */
function dateOf(value: string) {
  return sql<Date>`${value}`;
}

/**
 * Bâtiment ou case de la ferme ; actif exigé en ligne seulement : un emplacement désactivé après
 * une saisie hors ligne ne rejette pas le fait (BR-SYN-007, revue P7).
 */
async function rearingLocation(
  uow: Uow,
  locationId: string,
  siteId: string,
  offline: boolean,
): Promise<boolean> {
  const location = await loadLocation(uow, locationId);
  return (
    location !== undefined &&
    (location.isActive || offline) &&
    location.siteId === siteId &&
    REARING_LOCATION_TYPES.includes(location.locationType)
  );
}

/** Mois métier `AAAA-MM` de la vie d'un lot, du démarrage au jour de l'opération. */
function lotPeriods(startDate: Date | null, at: Date): readonly string[] {
  const last = businessDayOf(at).slice(0, 7);
  if (startDate === null) return [last];
  // Colonne `DATE` lue par mysql2 : minuit local.
  let year = startDate.getFullYear();
  let month = startDate.getMonth() + 1;
  const periods: string[] = [];
  for (;;) {
    const period = `${year}-${String(month).padStart(2, '0')}`;
    if (period > last) break;
    periods.push(period);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return periods.length > 0 ? periods : [last];
}

function buildHandlers(idGenerator: IdGenerator, documentSequences: DocumentSequenceService) {
  const deps = { idGenerator };

  const create: CommandHandler<z.infer<typeof createPayloadSchema>> = async (uow, envelope) => {
    const lotId = envelope.aggregate_id;
    const replay = await uow
      .selectFrom('production_production_lots')
      .select('lot_code')
      .where('id', '=', toBin(lotId))
      .executeTakeFirst();
    if (replay) return { status: 'APPLIED', serverRefs: { lotCode: replay.lot_code } };

    const p = envelope.payload;
    const at = new Date(envelope.occurred_at);
    const author = envelope.author_user_id;
    const offline = envelope.captured_offline;
    const location = await loadLocation(uow, p.mainLocationId);
    if (
      !location ||
      (!location.isActive && !offline) ||
      location.siteType !== 'FERME' ||
      !REARING_LOCATION_TYPES.includes(location.locationType)
    ) {
      return rejected(
        'LOCATION_INVALID',
        'L’emplacement principal est un bâtiment ou une case actif d’une ferme.',
      );
    }
    if (!(await isAllowed(uow, author, MANAGE, at, location.siteId))) return FORBIDDEN_SCOPE;

    const product = await findProduct(uow, p.productId);
    if (
      !product ||
      (product.status !== 'ACTIVE' && !offline) ||
      product.stockFamily !== 'BIOLOGIQUE' ||
      product.lotTracking === 'NONE' ||
      !lotAcceptsProductSpecies(p.lotType, product.species)
    ) {
      return rejected(
        'PRODUCT_INVALID',
        'Le produit d’un lot est un produit biologique actif, suivi par lot, de l’espèce du type de lot (BR-PRD-001).',
      );
    }
    if (p.parentLotId !== undefined) {
      const parent = await loadLot(uow, p.parentLotId);
      if (
        !parent ||
        parent.siteId !== location.siteId ||
        (!offline && (parent.status === 'CLOSED' || parent.status === 'CANCELLED')) ||
        lotTypeProfile(parent.lotType).species !== lotTypeProfile(p.lotType).species
      ) {
        return rejected(
          'PARENT_LOT_INVALID',
          'Le lot lié est un lot ouvert de la même ferme et de la même espèce (AV-099).',
        );
      }
    }
    if (p.supplierId !== undefined) {
      const supplier = await uow
        .selectFrom('procurement_suppliers')
        .select('id')
        .where('id', '=', toBin(p.supplierId))
        .executeTakeFirst();
      if (!supplier) return rejected('REFERENCE_INVALID', 'Fournisseur inconnu.');
    }
    if (
      p.plannedStartDate !== undefined &&
      p.plannedEndDate !== undefined &&
      p.plannedEndDate < p.plannedStartDate
    ) {
      return rejected('DATES_INVALID', 'La fin prévue précède le démarrage prévu.');
    }

    const origin = await loadCommandOrigin(uow, envelope.command_id);
    const lotCode = await documentSequences.next(uow, {
      docType: 'LOT',
      siteId: location.siteId,
      codeSite: location.siteCode,
      year: documentYear(at),
    });
    const stockLotId = await createStockLot(uow, deps, {
      originType: 'PRODUCTION_LOT',
      originId: lotId,
      lotCode,
      productId: p.productId,
      fifoRankAt: at,
      expiryDate: null,
      createdBy: author,
    });
    await uow
      .insertInto('production_production_lots')
      .values({
        id: toBin(lotId),
        lot_code: lotCode,
        lot_type: p.lotType,
        product_id: toBin(p.productId),
        stock_lot_id: toBin(stockLotId),
        site_id: toBin(location.siteId),
        main_location_id: toBin(location.id),
        parent_lot_id: toBinOrNull(p.parentLotId ?? null),
        supplier_id: toBinOrNull(p.supplierId ?? null),
        strain: p.strain ?? null,
        planned_start_date: p.plannedStartDate ? dateOf(p.plannedStartDate) : null,
        planned_end_date: p.plannedEndDate ? dateOf(p.plannedEndDate) : null,
        notes: p.notes ?? null,
        occurred_at: at,
        client_created_at: new Date(envelope.client_created_at),
        received_at_server: origin.receivedAt,
        command_id: toBin(envelope.command_id),
        created_device_id: toBinOrNull(origin.deviceId),
        captured_offline: envelope.captured_offline ? 1 : 0,
        clock_suspect: origin.clockSuspect ? 1 : 0,
        backdated_reason: envelope.backdated_reason,
        created_by: toBin(author),
      })
      .execute();
    await emitProductionLotChange(uow, lotId);
    return { status: 'APPLIED', serverRefs: { lotCode, stockLotId } };
  };

  const cancel: CommandHandler<z.infer<typeof cancelPayloadSchema>> = async (uow, envelope) => {
    const lot = await loadLot(uow, envelope.aggregate_id);
    if (!lot) return NOT_FOUND;
    const at = new Date(envelope.occurred_at);
    if (!(await isAllowed(uow, envelope.author_user_id, MANAGE, at, lot.siteId))) {
      return FORBIDDEN_SCOPE;
    }
    if (lot.status === 'CANCELLED') return { status: 'APPLIED' };
    if (lot.status !== 'PLANNED') {
      return rejected(
        'LOT_NOT_CANCELLABLE',
        'Seul un lot planifié, sans aucune entrée, peut être annulé (BR-PRD-009).',
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
    await uow
      .updateTable('production_production_lots')
      .set({
        status: 'CANCELLED',
        cancelled_at: at,
        cancelled_by: toBin(envelope.author_user_id),
        cancel_reason_code_id: toBinOrNull(envelope.payload.reasonCodeId ?? null),
        cancel_comment: envelope.payload.comment,
        updated_by: toBin(envelope.author_user_id),
        version: sql`version + 1`,
      })
      .where('id', '=', toBin(lot.id))
      .execute();
    await setStockLotStatus(uow, lot.stockLotId, 'CLOSED');
    await emitProductionLotChange(uow, lot.id);
    return { status: 'APPLIED' };
  };

  const setStatus: CommandHandler<z.infer<typeof statusPayloadSchema>> = async (uow, envelope) => {
    const lot = await loadLot(uow, envelope.aggregate_id);
    if (!lot) return NOT_FOUND;
    const at = new Date(envelope.occurred_at);
    if (!(await isAllowed(uow, envelope.author_user_id, MANAGE, at, lot.siteId))) {
      return FORBIDDEN_SCOPE;
    }
    const target = envelope.payload.status;
    if (lot.status === target) return { status: 'APPLIED' };
    if (!acceptsDailyEntries(lot.status)) {
      return rejected(
        'LOT_STATUS_INVALID',
        'Seul un lot actif passe en vente, et inversement (SM-PRODUCTION-LOT).',
      );
    }
    if (target === 'SELLING') {
      const rearing = await lotHeadcount(uow, { lotId: lot.stockLotId, scope: 'REARING' });
      if (rearing <= 0) {
        return rejected('LOT_EMPTY', 'Aucun animal en élevage : rien à déclarer prêt à la vente.');
      }
    }
    await uow
      .updateTable('production_production_lots')
      .set({
        status: target,
        updated_by: toBin(envelope.author_user_id),
        version: sql`version + 1`,
      })
      .where('id', '=', toBin(lot.id))
      .execute();
    // BR-PRD-010 : l'état « en vente » est porté par le lot de stock pour que `sales` le lise
    // sans importer `production`.
    await setStockLotSellableFromRearing(uow, lot.stockLotId, target === 'SELLING');
    await emitProductionLotChange(uow, lot.id);
    return { status: 'APPLIED' };
  };

  /**
   * Sorties `PRODUCTION_INPUT` des animaux d'origine ; valeur totale sortie. Une mise en place
   * ne prend jamais les animaux d'un lot de production (le sien ou un autre) : c'est un
   * transfert, avec ses contrôles (`LOT_ENTRY_INVALID`, revue P7).
   */
  async function takeSource(
    uow: Uow,
    envelope: Parameters<CommandHandler<EntryPayload>>[1],
    lot: LotRow,
    entryId: string,
    source: {
      readonly productId: string;
      readonly locationId: string;
      readonly portions: readonly { readonly lotId: string | null; readonly quantity: number }[];
      readonly docType: 'LOT_ENTRY' | 'LOT_TRANSFER';
      /** Origines de lot de stock refusées (lots d'animaux ou d'incubation, revue P7). */
      readonly refusedOrigins: readonly string[];
    },
  ): Promise<number> {
    const productionLocation = await virtualLocationId(uow, 'V_PRODUCTION');
    const at = new Date(envelope.occurred_at);
    let value = 0;
    for (const portion of source.portions) {
      let moves: readonly RecordedMove[];
      try {
        moves = await recordStockMove(uow, deps, {
          productId: source.productId,
          ...(portion.lotId !== null ? { lotId: portion.lotId } : {}),
          quantityBase: portion.quantity,
          fromLocationId: source.locationId,
          toLocationId: productionLocation,
          moveType: 'PRODUCTION_INPUT',
          occurredAt: at,
          sourceDocType: source.docType,
          sourceDocId: entryId,
          costObjectType: 'PRODUCTION_LOT',
          costObjectId: lot.id,
          createdBy: envelope.author_user_id,
          commandId: envelope.command_id,
          capturedOffline: envelope.captured_offline,
          allowNegative: envelope.captured_offline,
        });
      } catch (error) {
        // Aucun lot désigné et aucun lot en solde à cet emplacement : il n'y a pas d'animaux.
        if (
          error instanceof InventoryMoveError &&
          error.code === 'LOT_REQUIRED' &&
          portion.lotId === null
        ) {
          throw new InventoryMoveError(
            'Aucun animal d’origine en stock à cet emplacement.',
            'INSUFFICIENT_STOCK',
          );
        }
        throw error;
      }
      value += moves.reduce((sum, move) => sum + move.valueXaf, 0);
      for (const move of moves) {
        if (source.refusedOrigins.length === 0 || move.lotId === null) continue;
        const stockLot = await findStockLot(uow, move.lotId);
        if (stockLot && source.refusedOrigins.includes(stockLot.originType)) {
          throw new DomainError(
            stockLot.originType === 'PRODUCTION_LOT'
              ? 'Ces animaux appartiennent à un lot de production : les faire entrer par un transfert.'
              : 'Une mise en place par achat ne prend que les animaux de la réception, pas ceux d’un lot d’incubation.',
            'LOT_ENTRY_INVALID',
          );
        }
      }
    }
    return value;
  }

  const recordEntry: CommandHandler<EntryPayload> = async (uow, envelope) => {
    const entryId = envelope.aggregate_id;
    const replay = await uow
      .selectFrom('production_lot_entries')
      .select('id')
      .where('id', '=', toBin(entryId))
      .executeTakeFirst();
    if (replay) return { status: 'APPLIED' };

    const p = envelope.payload;
    const at = new Date(envelope.occurred_at);
    const author = envelope.author_user_id;
    const offline = envelope.captured_offline;
    const lot = await loadLot(uow, p.productionLotId);
    if (!lot) return NOT_FOUND;
    if (!(await isAllowed(uow, author, DAILY, at, lot.siteId))) return FORBIDDEN_SCOPE;
    const closedLot = !acceptsLotEntries(lot.status);
    if (closedLot && !offline) {
      return rejected('LOT_NOT_ACTIVE', 'Lot clôturé ou annulé : aucune entrée possible.');
    }

    const toLocationId = p.toLocationId ?? lot.mainLocationId;
    if (!(await rearingLocation(uow, toLocationId, lot.siteId, offline))) {
      return rejected(
        'LOCATION_INVALID',
        'Destination : un bâtiment ou une case actif de la ferme du lot.',
      );
    }

    const parent =
      p.sourceKind === 'BIRTH' && lot.parentLotId ? await loadLot(uow, lot.parentLotId) : undefined;
    const sourceLot =
      (p.sourceKind === 'TRANSFER' || p.sourceKind === 'WEANING') && p.sourceProductionLotId
        ? await loadLot(uow, p.sourceProductionLotId)
        : undefined;
    try {
      checkLotEntry({
        lotType: lot.lotType,
        sourceKind: p.sourceKind,
        parentLotType: parent?.lotType ?? null,
        sourceLotType: sourceLot?.lotType ?? null,
        sameLot: sourceLot?.id === lot.id,
      });
    } catch (error) {
      return businessRejection(error);
    }
    if (p.stillbornQty !== undefined && p.stillbornQty > 0 && p.sourceKind !== 'BIRTH') {
      return rejected('LOT_ENTRY_INVALID', 'Des mort-nés ne se déclarent qu’avec une naissance.');
    }

    let sourceLocationId: string | null = null;
    let sourceProductId: string | null = null;
    let sourceStockLotId: string | null = null;
    let valueXaf = 0;
    try {
      if (p.sourceKind === 'INTERNAL_STOCK' || p.sourceKind === 'PURCHASE') {
        if (!p.sourceProductId) {
          return rejected('SOURCE_REQUIRED', 'Produit d’origine requis pour une mise en place.');
        }
        const [sourceProduct, lotProduct] = await Promise.all([
          findProduct(uow, p.sourceProductId),
          findProduct(uow, lot.productId),
        ]);
        if (
          !sourceProduct ||
          sourceProduct.stockFamily !== 'BIOLOGIQUE' ||
          speciesGroupOfProduct(sourceProduct.species) !==
            speciesGroupOfProduct(lotProduct?.species ?? null)
        ) {
          return rejected(
            'SOURCE_PRODUCT_INVALID',
            'Les animaux d’origine sont un produit biologique de la même espèce que le lot.',
          );
        }
        sourceProductId = p.sourceProductId;
        let portions: { lotId: string | null; quantity: number }[];
        if (p.sourceKind === 'INTERNAL_STOCK') {
          if (!p.sourceLocationId) {
            return rejected('SOURCE_REQUIRED', 'Emplacement d’origine requis.');
          }
          const location = await loadLocation(uow, p.sourceLocationId);
          if (!location || location.siteId !== lot.siteId) {
            return rejected('SITE_MISMATCH', 'Les animaux d’origine sont sur la ferme du lot.');
          }
          sourceLocationId = location.id;
          sourceStockLotId = p.sourceStockLotId ?? null;
          portions = [{ lotId: sourceStockLotId, quantity: p.quantity }];
          if (sourceStockLotId !== null) {
            const stockLot = await findStockLot(uow, sourceStockLotId);
            if (!stockLot) return rejected('REFERENCE_INVALID', 'Lot de stock d’origine inconnu.');
            if (stockLot.originType === 'PRODUCTION_LOT') {
              return rejected(
                'LOT_ENTRY_INVALID',
                'Ces animaux appartiennent à un lot de production : les faire entrer par un transfert.',
              );
            }
          }
        } else {
          if (!p.goodsReceiptId) {
            return rejected('SOURCE_REQUIRED', 'Réception d’achat requise (AV-112).');
          }
          const receipt = await findReceiptForPlacement(uow, p.goodsReceiptId);
          if (!receipt) return rejected('REFERENCE_INVALID', 'Réception introuvable.');
          if (receipt.siteId !== lot.siteId) {
            return rejected(
              'RECEIPT_SITE_MISMATCH',
              'La réception doit être livrée sur la ferme du lot (AV-112).',
            );
          }
          sourceLocationId = receipt.locationId;
          portions = [];
          let remaining = milli(p.quantity);
          if (PLACEABLE_RECEIPT_STATUSES.includes(receipt.status)) {
            // Têtes encore disponibles sur chaque lot fournisseur de la réception : une mise en
            // place précédente depuis la même réception a déjà pu en prendre (revue P7).
            for (const line of receipt.lines) {
              if (remaining <= 0) break;
              if (line.productId !== p.sourceProductId || milli(line.acceptedBase) <= 0) continue;
              const available =
                line.stockLotId === null
                  ? milli(line.acceptedBase)
                  : Math.min(
                      milli(line.acceptedBase),
                      milli(
                        await stockLotBalance(uow, {
                          locationId: receipt.locationId,
                          productId: line.productId,
                          lotId: line.stockLotId,
                        }),
                      ),
                    );
              const take = Math.min(remaining, Math.max(0, available));
              if (take <= 0) continue;
              portions.push({ lotId: line.stockLotId, quantity: fromMilli(take) });
              sourceStockLotId ??= line.stockLotId;
              remaining -= take;
            }
          } else if (!offline) {
            return rejected(
              'RECEIPT_NOT_POSTED',
              'Réception en quarantaine, rejetée ou annulée : aucune tête à mettre en place.',
            );
          }
          if (remaining > 0) {
            if (!offline) {
              return rejected(
                'PLACEMENT_EXCEEDS_RECEIPT',
                'Mise en place supérieure aux têtes de la réception encore en stock.',
              );
            }
            // Hors ligne : le fait physique est appliqué (BR-SYN-007), le reste en FIFO.
            portions.push({ lotId: null, quantity: fromMilli(remaining) });
          }
        }
        valueXaf = await takeSource(uow, envelope, lot, entryId, {
          productId: p.sourceProductId,
          locationId: sourceLocationId,
          portions,
          docType: 'LOT_ENTRY',
          refusedOrigins:
            p.sourceKind === 'PURCHASE'
              ? ['PRODUCTION_LOT', 'INCUBATION_BATCH']
              : ['PRODUCTION_LOT'],
        });
      } else if (p.sourceKind === 'TRANSFER' || p.sourceKind === 'WEANING') {
        if (!sourceLot || !p.sourceLocationId) {
          return rejected('SOURCE_REQUIRED', 'Lot et emplacement d’origine requis.');
        }
        if (sourceLot.siteId !== lot.siteId) {
          return rejected('SITE_MISMATCH', 'Transfert entre lots d’une même ferme.');
        }
        if (!acceptsDailyEntries(sourceLot.status) && !offline) {
          return rejected('SOURCE_LOT_NOT_ACTIVE', 'Le lot d’origine n’est plus actif.');
        }
        const location = await loadLocation(uow, p.sourceLocationId);
        if (!location || location.siteId !== lot.siteId) {
          return rejected('SITE_MISMATCH', 'Les animaux d’origine sont sur la ferme du lot.');
        }
        sourceLocationId = location.id;
        sourceProductId = sourceLot.productId;
        sourceStockLotId = sourceLot.stockLotId;
        valueXaf = await takeSource(uow, envelope, lot, entryId, {
          productId: sourceLot.productId,
          locationId: location.id,
          portions: [{ lotId: sourceLot.stockLotId, quantity: p.quantity }],
          docType: 'LOT_TRANSFER',
          refusedOrigins: [],
        });
      } else {
        // Naissance : coût standard du porcelet (AV-098) ; absent, entrée à 0 XAF (le coût
        // réel reste au lot de truies ; alerte à l'administrateur en P9, AV-124).
        if (!parent) return rejected('LOT_ENTRY_INVALID', 'Lot de truies introuvable.');
        if (!acceptsDailyEntries(parent.status) && !offline) {
          return rejected('SOURCE_LOT_NOT_ACTIVE', 'Le lot de truies n’est plus actif.');
        }
        const standard = (await findStandardUnitCostXaf(uow, lot.productId, at)) ?? 0;
        valueXaf = standard * p.quantity;
      }

      const productionLocation = await virtualLocationId(uow, 'V_PRODUCTION');
      const [output] = await recordStockMove(uow, deps, {
        productId: lot.productId,
        lotId: lot.stockLotId,
        quantityBase: p.quantity,
        fromLocationId: productionLocation,
        toLocationId,
        moveType: 'PRODUCTION_OUTPUT',
        declaredValueXaf: valueXaf,
        occurredAt: at,
        sourceDocType:
          p.sourceKind === 'TRANSFER' || p.sourceKind === 'WEANING' ? 'LOT_TRANSFER' : 'LOT_ENTRY',
        sourceDocId: entryId,
        costObjectType: 'PRODUCTION_LOT',
        costObjectId: lot.id,
        createdBy: author,
        commandId: envelope.command_id,
        capturedOffline: offline,
        allowNegative: offline,
      });
      await recordCostEntry(uow, deps, {
        costObjectType: 'PRODUCTION_LOT',
        costObjectId: lot.id,
        costType: 'ANIMAUX',
        amountXaf: valueXaf,
        direction: 'DEBIT',
        sourceType: 'STOCK_MOVE',
        sourceId: output!.moveId,
        occurredAt: at,
        createdBy: author,
      });
      if (p.sourceKind === 'BIRTH' && parent) {
        await recordCostEntry(uow, deps, {
          costObjectType: 'PRODUCTION_LOT',
          costObjectId: parent.id,
          costType: 'PRODUCTION_TRANSFEREE',
          amountXaf: valueXaf,
          direction: 'CREDIT',
          sourceType: 'PRODUCTION',
          sourceId: entryId,
          occurredAt: at,
          createdBy: author,
          comment: `Naissances ${lot.lotCode}`,
        });
      }
    } catch (error) {
      return businessRejection(error);
    }

    const origin = await loadCommandOrigin(uow, envelope.command_id);
    const entryType = entryTypeOf(p.sourceKind);
    await uow
      .insertInto('production_lot_entries')
      .values({
        id: toBin(entryId),
        production_lot_id: toBin(lot.id),
        entry_type: entryType,
        product_id: toBin(lot.productId),
        quantity_base: String(p.quantity),
        to_location_id: toBin(toLocationId),
        source_kind: p.sourceKind,
        source_location_id: toBinOrNull(sourceLocationId),
        source_product_id: toBinOrNull(sourceProductId),
        source_stock_lot_id: toBinOrNull(sourceStockLotId),
        source_production_lot_id: toBinOrNull(sourceLot?.id ?? parent?.id ?? null),
        goods_receipt_id: toBinOrNull(p.goodsReceiptId ?? null),
        stillborn_qty: p.stillbornQty ?? 0,
        avg_weight_g: p.avgWeightG === undefined ? null : String(p.avgWeightG),
        unit_cost_xaf: unitCostXaf(valueXaf, quantityFromDecimal(p.quantity)),
        value_xaf: valueXaf,
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
    await emitProductionRecordChange(uow, 'LOT_ENTRY', entryId);

    // Hors ligne, le lot d'origine (transfert, sevrage) ou de truies (naissance) a pu être clos
    // entre-temps : le fait est appliqué, et chaque lot clos touché reçoit un conflit LOT_CLOSED.
    const closedLots = [
      ...(closedLot ? [lot] : []),
      ...[sourceLot, parent].filter(
        (other): other is LotRow => other !== undefined && !acceptsDailyEntries(other.status),
      ),
    ];
    for (const closed of closedLots) {
      await recordLotClosedConflict(uow, deps, {
        commandId: envelope.command_id,
        lot: closed,
        details: { entryId, entryType, quantity: p.quantity, destinationLotId: lot.id },
      });
    }
    if (!closedLot) {
      // Première entrée : PLANNED → ACTIVE. Date de démarrage = jour de l'entrée la plus ancienne
      // (une entrée hors ligne antérieure peut arriver après). Effectif initial = total des têtes
      // entrées (mises en place, naissances, transferts ; base du taux de mortalité, AV-116).
      const day = businessDayOf(at);
      await uow
        .updateTable('production_production_lots')
        .set({
          ...(lot.status === 'PLANNED' ? { status: 'ACTIVE' } : {}),
          start_date: sql<Date>`LEAST(COALESCE(start_date, ${day}), ${day})`,
          initial_quantity: String(fromMilli(milli(lot.initialQuantity ?? 0) + milli(p.quantity))),
          updated_by: toBin(author),
          version: sql`version + 1`,
        })
        .where('id', '=', toBin(lot.id))
        .execute();
      await emitProductionLotChange(uow, lot.id);
    }
    return closedLots.length > 0
      ? { status: 'APPLIED_WITH_WARNINGS', warnings: ['LOT_CLOSED'] }
      : { status: 'APPLIED' };
  };

  const cancelEntry: CommandHandler<z.infer<typeof cancelEntryPayloadSchema>> = async (
    uow,
    envelope,
  ) => {
    const entryId = envelope.aggregate_id;
    const entry = await uow
      .selectFrom('production_lot_entries')
      .selectAll()
      .where('id', '=', toBin(entryId))
      .forUpdate()
      .executeTakeFirst();
    if (!entry) return rejected('NOT_FOUND', 'Entrée de lot introuvable.');
    const lot = await loadLot(uow, fromBin(entry.production_lot_id));
    if (!lot) return NOT_FOUND;
    const at = new Date(envelope.occurred_at);
    const author = envelope.author_user_id;
    if (!(await isAllowed(uow, author, MANAGE, at, lot.siteId))) return FORBIDDEN_SCOPE;
    if (entry.status === 'CANCELLED') return { status: 'APPLIED' };
    if (!acceptsDailyEntries(lot.status)) {
      // Seule exception : une entrée appliquée hors ligne après la fermeture du lot (conflit
      // LOT_CLOSED consigné sur ce lot) s'annule, sinon ses animaux resteraient bloqués dans un
      // lot clos (revue P7).
      const receivedAfterClosure =
        entry.command_id !== null &&
        (await hasConflict(uow, {
          commandId: fromBin(entry.command_id),
          conflictType: 'LOT_CLOSED',
          entityId: lot.id,
        }));
      if (!receivedAfterClosure) {
        return rejected('LOT_NOT_ACTIVE', 'Lot clôturé ou annulé : entrée non annulable.');
      }
    }
    // L'annulation rend les animaux au lot d'origine (transfert, sevrage) ou reprend le crédit du
    // lot de truies (naissance) : jamais sur un lot déjà clos, dont le coût est figé (revue P7).
    if (entry.source_production_lot_id !== null) {
      const source = await loadLot(uow, fromBin(entry.source_production_lot_id));
      if (source && !acceptsDailyEntries(source.status)) {
        return rejected(
          'SOURCE_LOT_NOT_ACTIVE',
          'Le lot d’origine (ou le lot de truies) est clôturé : son coût est figé, l’entrée ne s’annule plus.',
        );
      }
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
        sourceDocType: entry.entry_type === 'TRANSFER_IN' ? 'LOT_TRANSFER' : 'LOT_ENTRY',
        sourceDocId: entryId,
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
          'Les animaux de cette entrée ne sont plus tous en stock : annulation impossible (AV-120).',
        );
      }
      return outcome;
    }
    await reverseCostEntries(uow, deps, {
      sourceType: 'PRODUCTION',
      sourceIds: [entryId],
      occurredAt: at,
      createdBy: author,
      comment: envelope.payload.comment,
    });
    await uow
      .updateTable('production_lot_entries')
      .set({
        status: 'CANCELLED',
        cancelled_at: at,
        cancelled_by: toBin(author),
        cancel_reason_code_id: toBinOrNull(envelope.payload.reasonCodeId ?? null),
        cancel_comment: envelope.payload.comment,
        updated_by: toBin(author),
        version: sql`version + 1`,
      })
      .where('id', '=', entry.id)
      .execute();
    await emitProductionRecordChange(uow, 'LOT_ENTRY', fromBin(entry.id));
    // Une entrée appliquée après la fermeture du lot n'a jamais été comptée dans l'effectif
    // initial : l'annuler ne le diminue pas (INV-PRD-01, revue P7).
    if (acceptsDailyEntries(lot.status)) {
      await uow
        .updateTable('production_production_lots')
        .set({
          initial_quantity: String(
            Math.max(
              0,
              fromMilli(milli(lot.initialQuantity ?? 0) - milli(Number(entry.quantity_base))),
            ),
          ),
          updated_by: toBin(author),
          version: sql`version + 1`,
        })
        .where('id', '=', toBin(lot.id))
        .execute();
    }
    await emitProductionLotChange(uow, lot.id);
    return { status: 'APPLIED' };
  };

  const close: CommandHandler<z.infer<typeof closePayloadSchema>> = async (uow, envelope) => {
    const lot = await loadLot(uow, envelope.aggregate_id);
    if (!lot) return NOT_FOUND;
    const at = new Date(envelope.occurred_at);
    const author = envelope.author_user_id;
    if (!(await isAllowed(uow, author, MANAGE, at, lot.siteId))) return FORBIDDEN_SCOPE;
    if (lot.status === 'CLOSED') return { status: 'APPLIED' };
    if (!acceptsDailyEntries(lot.status)) {
      return rejected('LOT_STATUS_INVALID', 'Seul un lot actif ou en vente se clôture.');
    }
    const unsold = await lotHeadcount(uow, { lotId: lot.stockLotId, scope: 'UNSOLD' });
    if (unsold !== 0) {
      return rejected(
        'LOT_NOT_EMPTY',
        `Effectif non vendu de ${unsold} : vendre, transférer ou déclarer les animaux restants (BR-PRD-011).`,
      );
    }
    // Têtes en attente de validation d'une perte (mortalité ou autre catégorie) : un rejet les
    // rendrait au lot après sa clôture (revue P7).
    const pendingLoss = await lotHeadcount(uow, { lotId: lot.stockLotId, scope: 'PENDING_LOSS' });
    if (pendingLoss > 0) {
      return rejected(
        'LOT_HAS_PENDING_LOSS',
        `${pendingLoss} têtes attendent la validation d’une mortalité ou d’une perte : la traiter avant de clôturer.`,
      );
    }
    // Têtes vendues sur commande et mises de côté « à livrer » : le lot ne se clôt pas avant leur
    // remise (ou l'annulation de la vente, qui les rendrait à un lot déjà clôturé).
    const toDeliver = await lotHeadcount(uow, { lotId: lot.stockLotId, scope: 'TO_DELIVER' });
    if (toDeliver > 0) {
      return rejected(
        'LOT_HAS_UNDELIVERED',
        `${toDeliver} têtes sont vendues et attendent leur livraison : les livrer ou annuler la vente avant de clôturer.`,
      );
    }
    const mortality = await lotMortalitySummary(uow, { productionLotId: lot.id });
    // Toutes les pertes du lot (mortalité comprise) ; une mortalité rejetée « non justifiée »
    // n'est plus une mortalité mais reste une perte (catégorie INEXPLIQUEE).
    const lostQuantity = await lotLostQuantity(uow, {
      lotId: lot.stockLotId,
      productId: lot.productId,
    });
    const entries = await uow
      .selectFrom('production_lot_entries')
      .select([
        sql<string>`COALESCE(SUM(quantity_base), 0)`.as('qty'),
        sql<string>`COALESCE(SUM(stillborn_qty), 0)`.as('stillborn'),
      ])
      .where('production_lot_id', '=', toBin(lot.id))
      .where('status', '=', 'RECORDED')
      .executeTakeFirstOrThrow();
    const entered = Number(entries.qty);
    // Part estimée des frais généraux (AV-105) : pour chaque mois de la vie du lot dont une
    // partie reste non répartie, sa part sur les frais déjà connus (têtes × jours écoulés) ;
    // les exécutions suivantes de ces mois l'excluent. Aucun frais : aucune écriture.
    let overheadEstimateXaf = 0;
    const speciesGroup = lotTypeProfile(lot.lotType).species;
    for (const period of lotPeriods(lot.startDate, at)) {
      const estimate = await allocateOverheads(uow, deps, {
        runId: idGenerator.newId(),
        siteId: lot.siteId,
        speciesGroup,
        period,
        closingLotId: lot.id,
        occurredAt: at,
        createdBy: author,
        commandId: null,
      });
      if (estimate.ok) overheadEstimateXaf += estimate.allocatedXaf;
    }
    const cost = await costObjectBalance(uow, {
      costObjectType: 'PRODUCTION_LOT',
      costObjectId: lot.id,
    });
    const overheads = await costObjectBalance(uow, {
      costObjectType: 'PRODUCTION_LOT',
      costObjectId: lot.id,
      costTypes: ['FRAIS_GENERAUX'],
    });
    const remaining = (await biologicalLotRemainingCostXaf(uow, lot.stockLotId)) ?? 0;
    const summary = {
      closedAt: at.toISOString(),
      initialQuantity: lot.initialQuantity ?? 0,
      enteredQuantity: entered,
      stillbornQuantity: Number(entries.stillborn),
      mortalityQuantity: mortality.countedQuantity,
      mortalityRate: mortalityRate(mortality.countedQuantity, entered),
      otherLossQuantity: Math.max(
        0,
        fromMilli(milli(lostQuantity) - milli(mortality.countedQuantity)),
      ),
      costDebitXaf: cost.debitXaf,
      costCreditXaf: cost.creditXaf,
      costNetXaf: cost.netXaf,
      // Frais généraux du lot (ADR-026), dont la part estimée à la clôture (AV-105).
      overheadXaf: overheads.netXaf,
      overheadEstimateXaf,
      // Coût que les sorties n'ont pas emporté (mortalité en fin de lot, part estimée des frais
      // généraux, ADR-027).
      unrecoveredCostXaf: remaining,
    };
    await uow
      .updateTable('production_production_lots')
      .set({
        status: 'CLOSED',
        closed_at: at,
        closing_summary: jsonValue(summary),
        updated_by: toBin(author),
        version: sql`version + 1`,
      })
      .where('id', '=', toBin(lot.id))
      .execute();
    await setStockLotStatus(uow, lot.stockLotId, 'CLOSED');
    await emitProductionLotChange(uow, lot.id);
    return { status: 'APPLIED', audit: { after: summary } };
  };

  return { create, cancel, setStatus, recordEntry, cancelEntry, close };
}

export function registerLotCommands(
  registry: CommandHandlerRegistry,
  idGenerator: IdGenerator,
  documentSequences: DocumentSequenceService,
): void {
  const handlers = buildHandlers(idGenerator, documentSequences);
  registry.register({
    commandType: 'production.lot.create',
    version: 1,
    payloadSchema: createPayloadSchema,
    permissionCode: MANAGE,
    handler: handlers.create,
  });
  registry.register({
    commandType: 'production.lot.cancel',
    version: 1,
    payloadSchema: cancelPayloadSchema,
    permissionCode: MANAGE,
    handler: handlers.cancel,
  });
  registry.register({
    commandType: 'production.lot.set_status',
    version: 1,
    payloadSchema: statusPayloadSchema,
    permissionCode: MANAGE,
    handler: handlers.setStatus,
  });
  registry.register({
    commandType: 'production.lot.record_entry',
    version: 1,
    payloadSchema: entryPayloadSchema,
    permissionCode: DAILY,
    handler: handlers.recordEntry,
  });
  registry.register({
    commandType: 'production.lot.cancel_entry',
    version: 1,
    payloadSchema: cancelEntryPayloadSchema,
    permissionCode: MANAGE,
    handler: handlers.cancelEntry,
  });
  registry.register({
    commandType: 'production.lot.close',
    version: 1,
    payloadSchema: closePayloadSchema,
    permissionCode: MANAGE,
    handler: handlers.close,
  });
}
