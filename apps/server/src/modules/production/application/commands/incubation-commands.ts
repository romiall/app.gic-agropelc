/**
 * Incubation (D07-PRD §7.4 ; SM-INCUBATION ; P7-08) : `production.incubation.start`,
 * `.record_candling`, `.transfer_to_hatcher`, `.record_hatch`, `.cancel`, sous
 * `production.incubation.record`, hors ligne possible.
 *
 * - Démarrage (BR-INC-001, BR-INC-002) : œufs à couver internes ou achetés (AV-047), sortis de
 *   leur lot (`PRODUCTION_INPUT`, valeur = CMUP ou coût du lot) et entrés dans l'incubateur sous
 *   le **lot de stock propre** du lot d'incubation (origine `INCUBATION_BATCH`, code `INC-…`) à la
 *   même valeur ; écriture de coût `OEUFS` au lot d'incubation (ADR-027). Échéancier = jour du
 *   démarrage + durées `production.incubation_durations` de l'espèce (BR-INC-008).
 * - Mirage (BR-INC-003) : infertiles et mortalité embryonnaire sortent vers `V_PRODUCTION` au
 *   coût 0 avec leurs motifs de rendement — le coût reste porté par les œufs restants.
 * - Transfert (BR-INC-004) : déplacement interne des œufs restants vers l'éclosoir.
 * - Éclosion (BR-INC-005, 006, 009) : les œufs restants sortent au coût 0 (non éclos, non
 *   viables, éclos) ; les poussins viables entrent sous le même lot au coût restant du lot
 *   d'incubation — coût d'un poussin = coût du lot ÷ poussins viables ; taux d'éclosion figé
 *   (BR-INC-007) ; lot clôturé (INV-INC-01 vérifié en base).
 * - Pertes accidentelles : déclarations de perte d'inventaire sur le lot de stock (D06) ; le
 *   compteur `accidental_loss_qty` les reprend à chaque étape.
 * - Annulation (perte totale) : plus aucun œuf du lot en stock (`INCUBATION_NOT_EMPTY`).
 *
 * États : en ligne, chaque étape exige son état (`INCUBATION_STATUS_INVALID`) ; hors ligne, une
 * étape arrivée après une autre saisie sur un autre appareil s'applique là où sont les œufs, une
 * éclosion incomplète est complétée en non éclos (`INCUBATION_BALANCE_ADJUSTED`), et une étape
 * sur un lot déjà clos est conservée en conflit `INCUBATION_CLOSED` sans effet (BR-SYN-007 : le
 * fait n'est pas perdu, un responsable l'arbitre).
 */
import { z } from 'zod';
import { sql } from 'kysely';
import {
  addBusinessDays,
  businessDayOf,
  checkCandling,
  checkHatch,
  eggsRemaining,
  hatchRates,
  speciesGroupOfProduct,
  type IdGenerator,
  type IncubationCounters,
} from '@gic/domain';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import type { CommandEnvelope } from '@gic/contracts';
import type { DocumentSequenceService } from '../../../../platform/document-sequences/document-sequence.service.js';
import { loadCommandOrigin } from '../../../../platform/sync/command-origin.js';
import { recordConflict } from '../../../../platform/sync/conflicts.js';
import {
  fromBin,
  fromBinOrNull,
  toBin,
  toBinOrNull,
} from '../../../../platform/kysely/uuid-columns.js';
import {
  findProduct,
  findReasonCode,
  findReasonCodeByCode,
} from '../../../catalog/application/public/index.js';
import {
  biologicalLotRemainingCostXaf,
  createStockLot,
  lotHeadcount,
  lotLossQuantity,
  recordCostEntry,
  recordStockMove,
  setStockLotStatus,
  virtualLocationId,
} from '../../../inventory/application/public/index.js';
import {
  FORBIDDEN_SCOPE,
  businessRejection,
  documentYear,
  farmLocation,
  isAllowed,
  loadLocation,
  recordProductionInput,
  rejected,
  settingValue,
  type Uow,
} from './shared.js';
import { emitIncubationBatchChange } from '../sync-changes.js';

const INCUBATION = 'production.incubation.record';

const NOT_FOUND = rejected('NOT_FOUND', 'Lot d’incubation introuvable.');

const startPayloadSchema = z.object({
  /** Espèce : clé des durées `production.incubation_durations` (AV-047). */
  species: z.string().trim().min(1).max(20),
  eggProductId: z.string().uuid(),
  chickProductId: z.string().uuid(),
  incubatorLocationId: z.string().uuid(),
  eggSource: z.enum(['INTERNAL', 'PURCHASED']),
  eggsSet: z.number().int().positive(),
  /** Emplacement de stockage des œufs à couver. */
  sourceLocationId: z.string().uuid(),
  /** Lot de stock des œufs (collecte, lot fournisseur) ; sinon FIFO. */
  sourceStockLotId: z.string().uuid().optional(),
});

const candlingPayloadSchema = z.object({
  batchId: z.string().uuid(),
  infertile: z.number().int().nonnegative(),
  earlyDead: z.number().int().nonnegative(),
});

const transferPayloadSchema = z.object({
  batchId: z.string().uuid(),
  hatcherLocationId: z.string().uuid(),
});

const hatchPayloadSchema = z.object({
  batchId: z.string().uuid(),
  unhatched: z.number().int().nonnegative(),
  hatchedViable: z.number().int().nonnegative(),
  hatchedNonviable: z.number().int().nonnegative(),
  /** Destination des poussins (éclosoir, poussinière…) ; à défaut, l'éclosoir du lot. */
  outputLocationId: z.string().uuid().optional(),
});

const cancelPayloadSchema = z.object({
  batchId: z.string().uuid(),
  comment: z.string().trim().min(1).max(2000),
  reasonCodeId: z.string().uuid().optional(),
});

interface BatchRow {
  readonly id: string;
  readonly batchCode: string;
  readonly stockLotId: string;
  readonly siteId: string;
  readonly eggProductId: string;
  readonly chickProductId: string;
  readonly incubatorLocationId: string;
  readonly hatcherLocationId: string | null;
  readonly status: 'INCUBATING' | 'IN_HATCHER' | 'CLOSED' | 'CANCELLED';
  readonly counters: IncubationCounters;
}

async function loadBatch(uow: Uow, batchId: string): Promise<BatchRow | undefined> {
  const row = await uow
    .selectFrom('production_incubation_batches')
    .selectAll()
    .where('id', '=', toBin(batchId))
    .forUpdate()
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    id: fromBin(row.id),
    batchCode: row.batch_code,
    stockLotId: fromBin(row.stock_lot_id),
    siteId: fromBin(row.site_id),
    eggProductId: fromBin(row.egg_product_id),
    chickProductId: fromBin(row.chick_product_id),
    incubatorLocationId: fromBin(row.incubator_location_id),
    hatcherLocationId: fromBinOrNull(row.hatcher_location_id),
    status: row.status as BatchRow['status'],
    counters: {
      eggsSet: row.eggs_set_qty,
      infertile: row.infertile_qty,
      earlyDead: row.early_dead_qty,
      accidentalLoss: row.accidental_loss_qty,
      unhatched: row.unhatched_qty,
      hatchedViable: row.hatched_viable_qty,
      hatchedNonviable: row.hatched_nonviable_qty,
    },
  };
}

/** Compteurs avec les pertes accidentelles déclarées à ce jour sur le lot de stock. */
async function currentCounters(uow: Uow, batch: BatchRow): Promise<IncubationCounters> {
  const accidentalLoss = Math.round(
    await lotLossQuantity(uow, { lotId: batch.stockLotId, productId: batch.eggProductId }),
  );
  return { ...batch.counters, accidentalLoss };
}

/** Emplacement où se trouvent les œufs du lot selon son état. */
function eggLocationOf(batch: BatchRow): string {
  return batch.status === 'IN_HATCHER' && batch.hatcherLocationId
    ? batch.hatcherLocationId
    : batch.incubatorLocationId;
}

async function yieldReason(uow: Uow, code: string): Promise<string | undefined> {
  return (await findReasonCodeByCode(uow, 'PRODUCTION_YIELD', code))?.id;
}

/** Durées d'incubation de l'espèce (jours depuis la mise en incubateur), si paramétrées. */
async function durationsOf(
  uow: Uow,
  species: string,
  at: Date,
): Promise<
  | { readonly candlingDay: number; readonly transferDay: number; readonly hatchDay: number }
  | undefined
> {
  const value = await settingValue(uow, 'production.incubation_durations', at);
  const entry =
    value && typeof value === 'object' ? (value as Record<string, unknown>)[species] : undefined;
  if (!entry || typeof entry !== 'object') return undefined;
  const e = entry as Record<string, unknown>;
  const day = (key: string) => (Number.isInteger(e[key]) ? (e[key] as number) : null);
  const candlingDay = day('candlingDay');
  const transferDay = day('transferDay');
  const hatchDay = day('hatchDay');
  return candlingDay !== null && transferDay !== null && hatchDay !== null
    ? { candlingDay, transferDay, hatchDay }
    : undefined;
}

function buildHandlers(idGenerator: IdGenerator, documentSequences: DocumentSequenceService) {
  const deps = { idGenerator };

  /** Lot d'incubation de l'étape : portée, puis état (en ligne) ou conflit (hors ligne). */
  async function stepBatch(
    uow: Uow,
    envelope: CommandEnvelope<{ readonly batchId: string }>,
    allowed: readonly BatchRow['status'][],
  ): Promise<
    | { readonly ok: true; readonly batch: BatchRow }
    | { readonly ok: false; readonly outcome: CommandHandlerOutcome }
  > {
    const batch = await loadBatch(uow, envelope.payload.batchId);
    if (!batch) return { ok: false, outcome: NOT_FOUND };
    const at = new Date(envelope.occurred_at);
    if (!(await isAllowed(uow, envelope.author_user_id, INCUBATION, at, batch.siteId))) {
      return { ok: false, outcome: FORBIDDEN_SCOPE };
    }
    if (allowed.includes(batch.status)) return { ok: true, batch };
    const closed = batch.status === 'CLOSED' || batch.status === 'CANCELLED';
    if (envelope.captured_offline && closed) {
      const conflictId = idGenerator.newId();
      await recordConflict(uow, {
        id: conflictId,
        commandId: envelope.command_id,
        conflictType: 'INCUBATION_CLOSED',
        entityType: 'INCUBATION_BATCH',
        entityId: batch.id,
        siteId: batch.siteId,
        ownerRole: 'RESP_PRODUCTION',
        applied: false,
        details: {
          commandType: envelope.command_type,
          payload: envelope.payload,
          batchStatus: batch.status,
        },
      });
      return { ok: false, outcome: { status: 'CONFLICT', conflictId } };
    }
    if (envelope.captured_offline) return { ok: true, batch };
    return {
      ok: false,
      outcome: rejected(
        'INCUBATION_STATUS_INVALID',
        `Étape impossible sur un lot d’incubation au statut ${batch.status} (SM-INCUBATION).`,
      ),
    };
  }

  async function insertEvent(
    uow: Uow,
    envelope: CommandEnvelope<unknown>,
    event: {
      readonly id: string;
      readonly batchId: string;
      readonly type: 'SET' | 'CANDLING' | 'TRANSFER_TO_HATCHER' | 'HATCH' | 'CANCEL';
      readonly infertile?: number;
      readonly earlyDead?: number;
      readonly transferred?: number;
      readonly hatchedViable?: number;
      readonly hatchedNonviable?: number;
      readonly unhatched?: number;
      readonly outputLocationId?: string | null;
    },
  ): Promise<void> {
    const origin = await loadCommandOrigin(uow, envelope.command_id);
    await uow
      .insertInto('production_incubation_events')
      .values({
        id: toBin(event.id),
        batch_id: toBin(event.batchId),
        event_type: event.type,
        qty_infertile: event.infertile ?? null,
        qty_early_dead: event.earlyDead ?? null,
        qty_transferred: event.transferred ?? null,
        qty_hatched_viable: event.hatchedViable ?? null,
        qty_hatched_nonviable: event.hatchedNonviable ?? null,
        qty_unhatched: event.unhatched ?? null,
        output_location_id: toBinOrNull(event.outputLocationId ?? null),
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
  }

  async function eventReplay(uow: Uow, eventId: string): Promise<boolean> {
    const row = await uow
      .selectFrom('production_incubation_events')
      .select('id')
      .where('id', '=', toBin(eventId))
      .executeTakeFirst();
    return row !== undefined;
  }

  const start: CommandHandler<z.infer<typeof startPayloadSchema>> = async (uow, envelope) => {
    const batchId = envelope.aggregate_id;
    const replay = await uow
      .selectFrom('production_incubation_batches')
      .select(['batch_code', 'stock_lot_id'])
      .where('id', '=', toBin(batchId))
      .executeTakeFirst();
    if (replay) {
      return {
        status: 'APPLIED',
        serverRefs: { batchCode: replay.batch_code, stockLotId: fromBin(replay.stock_lot_id) },
      };
    }
    const p = envelope.payload;
    const at = new Date(envelope.occurred_at);
    const author = envelope.author_user_id;
    const offline = envelope.captured_offline;
    const incubator = await loadLocation(uow, p.incubatorLocationId);
    if (
      !incubator ||
      !incubator.isActive ||
      incubator.siteType !== 'FERME' ||
      incubator.locationType !== 'INCUBATOR'
    ) {
      return rejected('LOCATION_INVALID', 'Un incubateur actif d’une ferme est attendu.');
    }
    if (!(await isAllowed(uow, author, INCUBATION, at, incubator.siteId))) return FORBIDDEN_SCOPE;
    const source = await loadLocation(uow, p.sourceLocationId);
    if (!source || source.siteId !== incubator.siteId) {
      return rejected('SITE_MISMATCH', 'Les œufs à couver sont sur la ferme de l’incubateur.');
    }
    const [eggProduct, chickProduct] = await Promise.all([
      findProduct(uow, p.eggProductId),
      findProduct(uow, p.chickProductId),
    ]);
    if (!eggProduct || eggProduct.stockFamily === 'BIOLOGIQUE') {
      return rejected('EGG_PRODUCT_INVALID', 'Produit d’œuf à couver inconnu ou biologique.');
    }
    if (
      !chickProduct ||
      chickProduct.stockFamily !== 'BIOLOGIQUE' ||
      speciesGroupOfProduct(chickProduct.species) !== 'VOLAILLE' ||
      chickProduct.lotTracking === 'NONE'
    ) {
      return rejected(
        'CHICK_PRODUCT_INVALID',
        'Le poussin produit est un produit biologique de volaille suivi par lot.',
      );
    }
    const durations = await durationsOf(uow, p.species, at);
    if (!durations && !offline) {
      return rejected(
        'SPECIES_UNKNOWN',
        'Espèce sans durées d’incubation paramétrées (production.incubation_durations, AV-047).',
      );
    }

    const batchCode = await documentSequences.next(uow, {
      docType: 'INC',
      siteId: incubator.siteId,
      codeSite: incubator.siteCode,
      year: documentYear(at),
    });
    const stockLotId = await createStockLot(uow, deps, {
      originType: 'INCUBATION_BATCH',
      originId: batchId,
      lotCode: batchCode,
      productId: null,
      fifoRankAt: at,
      expiryDate: null,
      createdBy: author,
    });
    const setEventId = idGenerator.newId();
    let valueXaf: number;
    try {
      valueXaf = await recordProductionInput(uow, deps, {
        productId: p.eggProductId,
        ...(p.sourceStockLotId !== undefined ? { lotId: p.sourceStockLotId } : {}),
        quantityBase: p.eggsSet,
        fromLocationId: p.sourceLocationId,
        occurredAt: at,
        sourceDocType: 'INCUBATION_EVENT',
        sourceDocId: setEventId,
        costObjectType: 'INCUBATION_BATCH',
        costObjectId: batchId,
        createdBy: author,
        commandId: envelope.command_id,
        capturedOffline: offline,
        allowNegative: offline,
      });
      const [output] = await recordStockMove(uow, deps, {
        productId: p.eggProductId,
        lotId: stockLotId,
        quantityBase: p.eggsSet,
        fromLocationId: await virtualLocationId(uow, 'V_PRODUCTION'),
        toLocationId: p.incubatorLocationId,
        moveType: 'PRODUCTION_OUTPUT',
        declaredValueXaf: valueXaf,
        occurredAt: at,
        sourceDocType: 'INCUBATION_EVENT',
        sourceDocId: setEventId,
        costObjectType: 'INCUBATION_BATCH',
        costObjectId: batchId,
        createdBy: author,
        commandId: envelope.command_id,
        capturedOffline: offline,
        allowNegative: offline,
      });
      await recordCostEntry(uow, deps, {
        costObjectType: 'INCUBATION_BATCH',
        costObjectId: batchId,
        costType: 'OEUFS',
        amountXaf: valueXaf,
        direction: 'DEBIT',
        sourceType: 'STOCK_MOVE',
        sourceId: output!.moveId,
        occurredAt: at,
        createdBy: author,
      });
    } catch (error) {
      return businessRejection(error);
    }

    const setDay = businessDayOf(at);
    const origin = await loadCommandOrigin(uow, envelope.command_id);
    await uow
      .insertInto('production_incubation_batches')
      .values({
        id: toBin(batchId),
        batch_code: batchCode,
        stock_lot_id: toBin(stockLotId),
        site_id: toBin(incubator.siteId),
        species: p.species,
        egg_product_id: toBin(p.eggProductId),
        chick_product_id: toBin(p.chickProductId),
        incubator_location_id: toBin(p.incubatorLocationId),
        egg_source: p.eggSource,
        eggs_set_qty: p.eggsSet,
        set_at: at,
        expected_candling_date: durations
          ? sql<Date>`${addBusinessDays(setDay, durations.candlingDay)}`
          : null,
        expected_transfer_date: durations
          ? sql<Date>`${addBusinessDays(setDay, durations.transferDay)}`
          : null,
        expected_hatch_date: durations
          ? sql<Date>`${addBusinessDays(setDay, durations.hatchDay)}`
          : null,
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
    await insertEvent(uow, envelope, {
      id: setEventId,
      batchId,
      type: 'SET',
      outputLocationId: p.incubatorLocationId,
    });
    await emitIncubationBatchChange(uow, batchId);
    return { status: 'APPLIED', serverRefs: { batchCode, stockLotId } };
  };

  const candling: CommandHandler<z.infer<typeof candlingPayloadSchema>> = async (uow, envelope) => {
    if (await eventReplay(uow, envelope.aggregate_id)) return { status: 'APPLIED' };
    const guard = await stepBatch(uow, envelope, ['INCUBATING']);
    if (!guard.ok) return guard.outcome;
    const { batch } = guard;
    const p = envelope.payload;
    const at = new Date(envelope.occurred_at);
    const counters = await currentCounters(uow, batch);
    try {
      checkCandling(counters, { infertile: p.infertile, earlyDead: p.earlyDead });
      for (const [quantity, reason] of [
        [p.infertile, 'INFERTILE'],
        [p.earlyDead, 'MORTALITE_EMBRYONNAIRE'],
      ] as const) {
        if (quantity === 0) continue;
        const reasonCodeId = await yieldReason(uow, reason);
        await recordProductionInput(uow, deps, {
          productId: batch.eggProductId,
          lotId: batch.stockLotId,
          quantityBase: quantity,
          fromLocationId: eggLocationOf(batch),
          ...(reasonCodeId !== undefined ? { reasonCodeId } : {}),
          declaredUnitCostXaf: 0,
          occurredAt: at,
          sourceDocType: 'INCUBATION_EVENT',
          sourceDocId: envelope.aggregate_id,
          costObjectType: 'INCUBATION_BATCH',
          costObjectId: batch.id,
          createdBy: envelope.author_user_id,
          commandId: envelope.command_id,
          capturedOffline: envelope.captured_offline,
          allowNegative: envelope.captured_offline,
        });
      }
    } catch (error) {
      return businessRejection(error);
    }
    await uow
      .updateTable('production_incubation_batches')
      .set({
        infertile_qty: counters.infertile + p.infertile,
        early_dead_qty: counters.earlyDead + p.earlyDead,
        accidental_loss_qty: counters.accidentalLoss,
        updated_by: toBin(envelope.author_user_id),
        version: sql`version + 1`,
      })
      .where('id', '=', toBin(batch.id))
      .execute();
    await insertEvent(uow, envelope, {
      id: envelope.aggregate_id,
      batchId: batch.id,
      type: 'CANDLING',
      infertile: p.infertile,
      earlyDead: p.earlyDead,
    });
    await emitIncubationBatchChange(uow, batch.id);
    return { status: 'APPLIED' };
  };

  const transfer: CommandHandler<z.infer<typeof transferPayloadSchema>> = async (uow, envelope) => {
    if (await eventReplay(uow, envelope.aggregate_id)) return { status: 'APPLIED' };
    const guard = await stepBatch(uow, envelope, ['INCUBATING']);
    if (!guard.ok) return guard.outcome;
    const { batch } = guard;
    const p = envelope.payload;
    const at = new Date(envelope.occurred_at);
    if (batch.status === 'IN_HATCHER') {
      // Hors ligne : transfert déjà enregistré par un autre appareil (une seule fois par lot).
      return { status: 'APPLIED' };
    }
    const hatcher = await loadLocation(uow, p.hatcherLocationId);
    if (
      !hatcher ||
      !hatcher.isActive ||
      hatcher.siteId !== batch.siteId ||
      hatcher.locationType !== 'HATCHER'
    ) {
      return rejected('LOCATION_INVALID', 'Un éclosoir actif de la ferme du lot est attendu.');
    }
    const counters = await currentCounters(uow, batch);
    const quantity = Math.max(0, eggsRemaining(counters));
    try {
      if (quantity > 0) {
        await recordStockMove(uow, deps, {
          productId: batch.eggProductId,
          lotId: batch.stockLotId,
          quantityBase: quantity,
          fromLocationId: batch.incubatorLocationId,
          toLocationId: hatcher.id,
          moveType: 'INTERNAL_MOVE',
          occurredAt: at,
          sourceDocType: 'INCUBATION_EVENT',
          sourceDocId: envelope.aggregate_id,
          createdBy: envelope.author_user_id,
          commandId: envelope.command_id,
          capturedOffline: envelope.captured_offline,
          allowNegative: envelope.captured_offline,
        });
      }
    } catch (error) {
      return businessRejection(error);
    }
    await uow
      .updateTable('production_incubation_batches')
      .set({
        status: 'IN_HATCHER',
        hatcher_location_id: toBin(hatcher.id),
        transferred_qty: quantity,
        accidental_loss_qty: counters.accidentalLoss,
        updated_by: toBin(envelope.author_user_id),
        version: sql`version + 1`,
      })
      .where('id', '=', toBin(batch.id))
      .execute();
    await insertEvent(uow, envelope, {
      id: envelope.aggregate_id,
      batchId: batch.id,
      type: 'TRANSFER_TO_HATCHER',
      transferred: quantity,
      outputLocationId: hatcher.id,
    });
    await emitIncubationBatchChange(uow, batch.id);
    return { status: 'APPLIED' };
  };

  const hatch: CommandHandler<z.infer<typeof hatchPayloadSchema>> = async (uow, envelope) => {
    if (await eventReplay(uow, envelope.aggregate_id)) return { status: 'APPLIED' };
    const guard = await stepBatch(uow, envelope, ['IN_HATCHER']);
    if (!guard.ok) return guard.outcome;
    const { batch } = guard;
    const p = envelope.payload;
    const at = new Date(envelope.occurred_at);
    const author = envelope.author_user_id;
    const offline = envelope.captured_offline;
    const outputLocationId =
      p.outputLocationId ?? batch.hatcherLocationId ?? batch.incubatorLocationId;
    const invalidLocation = await farmLocation(uow, batch, outputLocationId);
    if (invalidLocation) return invalidLocation;
    const counters = await currentCounters(uow, batch);
    const remaining = eggsRemaining(counters);
    const outcomeCount = p.unhatched + p.hatchedViable + p.hatchedNonviable;
    let unhatched = p.unhatched;
    let adjusted = false;
    try {
      if (offline && outcomeCount < remaining) {
        // Hors ligne : les œufs non comptés sont des œufs non éclos (INV-INC-01 tenu).
        unhatched += remaining - outcomeCount;
        adjusted = true;
      }
      checkHatch(counters, {
        unhatched,
        hatchedViable: p.hatchedViable,
        hatchedNonviable: p.hatchedNonviable,
      });
      const from = eggLocationOf(batch);
      for (const [quantity, reason] of [
        [unhatched, 'NON_ECLOS'],
        [p.hatchedNonviable, 'POUSSIN_NON_VIABLE'],
        [p.hatchedViable, null],
      ] as const) {
        if (quantity === 0) continue;
        const reasonCodeId = reason ? await yieldReason(uow, reason) : undefined;
        await recordProductionInput(uow, deps, {
          productId: batch.eggProductId,
          lotId: batch.stockLotId,
          quantityBase: quantity,
          fromLocationId: from,
          ...(reasonCodeId !== undefined ? { reasonCodeId } : {}),
          declaredUnitCostXaf: 0,
          occurredAt: at,
          sourceDocType: 'INCUBATION_EVENT',
          sourceDocId: envelope.aggregate_id,
          costObjectType: 'INCUBATION_BATCH',
          costObjectId: batch.id,
          createdBy: author,
          commandId: envelope.command_id,
          capturedOffline: offline,
          allowNegative: offline,
        });
      }
      if (p.hatchedViable > 0) {
        // BR-INC-009 : les poussins viables emportent tout le coût du lot d'incubation.
        const remainingCost = (await biologicalLotRemainingCostXaf(uow, batch.stockLotId)) ?? 0;
        await recordStockMove(uow, deps, {
          productId: batch.chickProductId,
          lotId: batch.stockLotId,
          quantityBase: p.hatchedViable,
          fromLocationId: await virtualLocationId(uow, 'V_PRODUCTION'),
          toLocationId: outputLocationId,
          moveType: 'PRODUCTION_OUTPUT',
          declaredValueXaf: Math.max(0, remainingCost),
          occurredAt: at,
          sourceDocType: 'INCUBATION_EVENT',
          sourceDocId: envelope.aggregate_id,
          costObjectType: 'INCUBATION_BATCH',
          costObjectId: batch.id,
          createdBy: author,
          commandId: envelope.command_id,
          capturedOffline: offline,
          allowNegative: offline,
        });
      }
    } catch (error) {
      return businessRejection(error);
    }
    const final: IncubationCounters = {
      ...counters,
      unhatched,
      hatchedViable: p.hatchedViable,
      hatchedNonviable: p.hatchedNonviable,
    };
    const rates = hatchRates(final);
    await uow
      .updateTable('production_incubation_batches')
      .set({
        status: 'CLOSED',
        accidental_loss_qty: final.accidentalLoss,
        unhatched_qty: final.unhatched,
        hatched_viable_qty: final.hatchedViable,
        hatched_nonviable_qty: final.hatchedNonviable,
        hatch_rate: rates.hatchRate === null ? null : rates.hatchRate.toFixed(4),
        updated_by: toBin(author),
        version: sql`version + 1`,
      })
      .where('id', '=', toBin(batch.id))
      .execute();
    await insertEvent(uow, envelope, {
      id: envelope.aggregate_id,
      batchId: batch.id,
      type: 'HATCH',
      unhatched,
      hatchedViable: p.hatchedViable,
      hatchedNonviable: p.hatchedNonviable,
      outputLocationId,
    });
    await emitIncubationBatchChange(uow, batch.id);
    const serverRefs = { hatchRate: String(rates.hatchRate ?? '') };
    if (adjusted) {
      await recordConflict(uow, {
        id: idGenerator.newId(),
        commandId: envelope.command_id,
        conflictType: 'INCUBATION_BALANCE',
        entityType: 'INCUBATION_BATCH',
        entityId: batch.id,
        siteId: batch.siteId,
        ownerRole: 'RESP_PRODUCTION',
        applied: true,
        details: { declared: outcomeCount, remaining, addedUnhatched: remaining - outcomeCount },
      });
      return {
        status: 'APPLIED_WITH_WARNINGS',
        warnings: ['INCUBATION_BALANCE_ADJUSTED'],
        serverRefs,
      };
    }
    return { status: 'APPLIED', serverRefs };
  };

  const cancel: CommandHandler<z.infer<typeof cancelPayloadSchema>> = async (uow, envelope) => {
    const batch = await loadBatch(uow, envelope.payload.batchId);
    if (!batch) return NOT_FOUND;
    const at = new Date(envelope.occurred_at);
    const author = envelope.author_user_id;
    if (!(await isAllowed(uow, author, INCUBATION, at, batch.siteId))) return FORBIDDEN_SCOPE;
    if (batch.status === 'CANCELLED') return { status: 'APPLIED' };
    if (batch.status === 'CLOSED') {
      return rejected('INCUBATION_STATUS_INVALID', 'Lot d’incubation déjà éclos : non annulable.');
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
    const inStock = await lotHeadcount(uow, { lotId: batch.stockLotId, scope: 'UNSOLD' });
    if (inStock > 0) {
      return rejected(
        'INCUBATION_NOT_EMPTY',
        `${inStock} œufs du lot sont encore en stock : déclarer leur perte avant l’annulation.`,
      );
    }
    const counters = await currentCounters(uow, batch);
    await uow
      .updateTable('production_incubation_batches')
      .set({
        status: 'CANCELLED',
        accidental_loss_qty: counters.accidentalLoss,
        cancelled_at: at,
        cancelled_by: toBin(author),
        cancel_reason_code_id: toBinOrNull(envelope.payload.reasonCodeId ?? null),
        cancel_comment: envelope.payload.comment,
        updated_by: toBin(author),
        version: sql`version + 1`,
      })
      .where('id', '=', toBin(batch.id))
      .execute();
    await insertEvent(uow, envelope, {
      id: envelope.aggregate_id,
      batchId: batch.id,
      type: 'CANCEL',
    });
    await setStockLotStatus(uow, batch.stockLotId, 'CLOSED');
    await emitIncubationBatchChange(uow, batch.id);
    return { status: 'APPLIED' };
  };

  return { start, candling, transfer, hatch, cancel };
}

export function registerIncubationCommands(
  registry: CommandHandlerRegistry,
  idGenerator: IdGenerator,
  documentSequences: DocumentSequenceService,
): void {
  const handlers = buildHandlers(idGenerator, documentSequences);
  registry.register({
    commandType: 'production.incubation.start',
    version: 1,
    payloadSchema: startPayloadSchema,
    permissionCode: INCUBATION,
    handler: handlers.start,
  });
  registry.register({
    commandType: 'production.incubation.record_candling',
    version: 1,
    payloadSchema: candlingPayloadSchema,
    permissionCode: INCUBATION,
    handler: handlers.candling,
  });
  registry.register({
    commandType: 'production.incubation.transfer_to_hatcher',
    version: 1,
    payloadSchema: transferPayloadSchema,
    permissionCode: INCUBATION,
    handler: handlers.transfer,
  });
  registry.register({
    commandType: 'production.incubation.record_hatch',
    version: 1,
    payloadSchema: hatchPayloadSchema,
    permissionCode: INCUBATION,
    handler: handlers.hatch,
  });
  registry.register({
    commandType: 'production.incubation.cancel',
    version: 1,
    payloadSchema: cancelPayloadSchema,
    permissionCode: INCUBATION,
    handler: handlers.cancel,
  });
}
