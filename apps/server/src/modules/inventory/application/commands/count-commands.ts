/**
 * `inventory.count.{open,record_lines,submit,cancel}` (SM-INVENTORY-COUNT) + gestionnaires de
 * décision `INVENTORY_ADJUSTMENT` et `ANIMAL_COUNT_ADJUSTMENT` (P7-02, AV-108 : tout écart sur des
 * animaux est validé par le Responsable production). Portée de P2-04 : natures
 * `FULL`/`PARTIAL`/`SPOT`.
 *
 * Inventaire d'ouverture (`count_type = 'OPENING'`, `inventory.opening.post`, BR-STK-046, AV-517) : une seule
 * commande pose le document avec ses lignes (théorique nul, coût unitaire déclaré par ligne) et demande sa
 * validation (toujours : le stock initial valorise le bilan) ; la décision l'approuve en comptabilisant un mouvement
 * `OPENING_BALANCE` (`V_OPENING` vers l'emplacement) par ligne, ou le rejette sans mouvement. Hors périmètre,
 * documenté et non simulé : BR-STK-044
 * (rapprochement tardif d'un mouvement dont `occurred_at <= counted_at` arrive après la
 * comptabilisation — `net_variance_after_reconciliation_xaf`/`reconciled_adjustment_qty_base`
 * restent NULL/0, jamais mis à jour ici) ; BR-STK-045 (répartition FIFO inverse de l'écart
 * d'un produit compté sans lot désigné — chaque ligne comptée porte au plus un `lot_id`,
 * l'écart est donc toujours imputé à CE lot, ou à « sans lot » si aucun n'est désigné, jamais
 * réparti automatiquement sur plusieurs lots).
 *
 * `variance_reason_code_id` "Requis si écart ≠ 0 à la comptabilisation" (dictionnaire) n'est
 * **pas** un CK SQL (contrairement à `comment` sur `inventory_loss_declarations`) : ce fichier
 * accepte la valeur si fournie par `record_lines` (saisie prévisionnelle par le compteur),
 * mais ne bloque jamais `submit` si elle manque malgré un écart — règle documentée, non
 * appliquée strictement, pas un oubli silencieux (CLAUDE.md règle 2).
 *
 * Seuil de validation (AV-039) : paramètre système `inventory.count_approval_threshold_xaf`
 * (`organization.system_settings`, déjà seedé à 25 000 XAF, `db/seeds/system-settings.ts`),
 * lu via l'API publique `organization` (`currentSettingValue`) — jamais codé en dur en
 * fonctionnement normal ; repli à 25 000 XAF documenté seulement si la clé n'existe pas
 * encore dans une base donnée (CLAUDE.md règle 2, même esprit que le reste du projet).
 *
 * `CONTROL_POLICY_MISSING` pour `INVENTORY_ADJUSTMENT` : même garde de configuration
 * inconditionnelle que `TRANSFER_DISCREPANCY` (§5, transfer-commands.ts) — quand le seuil
 * décide qu'une validation est requise, l'absence de politique active refuse l'opération
 * plutôt que de l'appliquer sans contrôle ou de sauter la validation.
 */
import { z } from 'zod';
import { positiveQuantitySchema, receivedQuantitySchema } from '@gic/contracts';
import { sql, type Transaction } from 'kysely';
import type { CountLotBalance, IdGenerator } from '@gic/domain';
import {
  DomainError,
  businessDayOf,
  distributeLotLessVariance,
  lineAmountXaf,
  quantityFromDecimal,
  reconciliationDelta,
  resolveCountLineScope,
  roundCmupToXaf,
  xaf,
} from '@gic/domain';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import type { DB } from '../../../../platform/kysely/database.js';
import {
  toBin,
  toBinOrNull,
  fromBin,
  fromBinOrNull,
} from '../../../../platform/kysely/uuid-columns.js';
import { DocumentSequenceService } from '../../../../platform/document-sequences/document-sequence.service.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';
import {
  requestApproval,
  decidablePolicyFor,
  type ApprovalDecisionHandlerRegistry,
} from '../../../approvals/application/public/index.js';
import { recordChanges } from '../../../../platform/sync/change-feed.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import {
  biologicalLotUnitCostXaf,
  lockPhysicalStockCouples,
  reconcileCountLine,
  recordStockMove,
  type RecordMoveDeps,
} from '../public/record-move.js';
import {
  bucketBalance,
  bucketsHaveLots,
  ledgerBucketsAt,
  lotBalancesOf,
  type PostedCountLine,
} from '../count-ledger.js';
import { inventoryCountChange } from '../sync-changes.js';
import { closeStockNegativeConflicts } from '../stock-negative-conflicts.js';
import {
  publishInventoryAdjustedEvent,
  publishInventoryVarianceEvent,
} from '../inventory-alert-events.js';
import {
  loadCommandOrigin,
  loadLocationSite,
  virtualLocationId,
  documentLocation,
  withStockScope,
} from './shared.js';

const COUNT_APPROVAL_THRESHOLD_KEY = 'inventory.count_approval_threshold_xaf';
/** AV-039 : repli documenté, utilisé seulement si la clé n'existe pas encore dans la base. */
const COUNT_APPROVAL_THRESHOLD_FALLBACK_XAF = 25_000;

// `OPENING` n'est pas ouvert par `inventory.count.open` : il a sa propre commande (`inventory.opening.post`).
const COUNT_TYPES = ['FULL', 'PARTIAL', 'SPOT'] as const;

/** Lignes d'un stock d'ouverture au plus par document (un chargement plus gros se découpe par emplacement). */
const OPENING_MAX_LINES = 500;

/** Coût unitaire déclaré le plus haut accepté (francs par unité de base) : au-delà, c'est une faute de frappe. */
const OPENING_MAX_UNIT_COST_XAF = 1_000_000_000;

const openingLineSchema = z.object({
  productId: z.string().uuid(),
  /** Quantité en unité de base du produit, strictement positive (bornée à `numeric(14,3)`). */
  quantityBase: positiveQuantitySchema,
  /** Coût unitaire déclaré (XAF entiers par unité de base) : il valorise le stock initial (CMUP). */
  unitCostXaf: z.number().int().nonnegative().max(OPENING_MAX_UNIT_COST_XAF),
});
const openingPostPayloadSchema = z.object({
  locationId: z.string().uuid(),
  lines: z.array(openingLineSchema).min(1).max(OPENING_MAX_LINES),
  comment: z.string().max(2000).optional(),
});
type OpeningPostPayload = z.infer<typeof openingPostPayloadSchema>;

const openPayloadSchema = z.object({
  locationId: z.string().uuid(),
  countType: z.enum(COUNT_TYPES),
  /** Numéro de la fiche d'inventaire papier reportée (PP-B, AV-308). */
  localRef: z.string().trim().min(1).max(20).optional(),
});
type OpenPayload = z.infer<typeof openPayloadSchema>;

const countLineInputSchema = z.object({
  productId: z.string().uuid(),
  lotId: z.string().uuid().optional(),
  countedAt: z.string().datetime({ offset: true }),
  // Bornée à `numeric(14,3)` (P5-23).
  countedQtyBase: receivedQuantitySchema,
  varianceReasonCodeId: z.string().uuid().optional(),
  comment: z.string().max(2000).optional(),
});
const recordLinesPayloadSchema = z.object({
  countId: z.string().uuid(),
  lines: z.array(countLineInputSchema).min(1),
});
type RecordLinesPayload = z.infer<typeof recordLinesPayloadSchema>;

const submitPayloadSchema = z.object({ countId: z.string().uuid() });
type SubmitPayload = z.infer<typeof submitPayloadSchema>;

const cancelPayloadSchema = z.object({ countId: z.string().uuid() });
type CancelPayload = z.infer<typeof cancelPayloadSchema>;

function notFound(): CommandHandlerOutcome {
  return { status: 'REJECTED', errorCode: 'NOT_FOUND', messageFr: 'Inventaire introuvable.' };
}
function badStatus(expected: string): CommandHandlerOutcome {
  return {
    status: 'REJECTED',
    errorCode: 'COUNT_STATUS_INVALID',
    messageFr: `L'inventaire doit être au statut ${expected}.`,
  };
}

/**
 * Solde théorique d'une ligne à `counted_at` (BR-STK-042), lu dans le registre sans verrou de ligne mais en lecture
 * verrouillante des mouvements (un fait validé par une transaction concurrente pendant l'attente des soldes est vu), et
 * portée de la ligne (BR-STK-045) : un lot désigné, le seul solde sans lot, ou tous les lots du produit quand le
 * compteur a donné un total sans détail (aucune autre ligne du même inventaire ne compte un lot de ce produit).
 */
async function theoreticalOfLine(
  uow: Transaction<DB>,
  params: {
    readonly locationId: string;
    readonly line: {
      readonly id: Buffer;
      readonly product_id: Buffer;
      readonly lot_id: Buffer | null;
      readonly counted_at: Date;
    };
    readonly siblings: readonly {
      readonly id: Buffer;
      readonly product_id: Buffer;
      readonly lot_id: Buffer | null;
    }[];
  },
): Promise<{
  readonly theoretical: number;
  readonly allLots: boolean;
  readonly lotBalances: readonly CountLotBalance[];
}> {
  const lotId = fromBinOrNull(params.line.lot_id);
  const buckets = await ledgerBucketsAt(uow, {
    locationId: params.locationId,
    productId: fromBin(params.line.product_id),
    at: params.line.counted_at,
    lock: true,
  });
  const scope = resolveCountLineScope({
    lotId,
    hasSiblingLotLine: params.siblings.some(
      (other) =>
        !other.id.equals(params.line.id) &&
        other.lot_id !== null &&
        other.product_id.equals(params.line.product_id),
    ),
    productHasLots: bucketsHaveLots(buckets),
  });
  const allLots = scope === 'ALL_LOTS';
  return {
    theoretical: bucketBalance(buckets, scope, lotId),
    allLots,
    lotBalances: allLots ? await lotBalancesOf(uow, buckets) : [],
  };
}

async function currentUnitCostXaf(
  uow: Transaction<DB>,
  productId: Buffer,
  lotId: Buffer | null = null,
): Promise<number> {
  // P7-03 : un lot d'animaux se valorise au coût par tête (ADR-027), jamais au CMUP.
  if (lotId !== null) {
    const perHead = await biologicalLotUnitCostXaf(uow, fromBin(lotId));
    if (perHead !== null) return perHead;
  }
  const valuation = await uow
    .selectFrom('inventory_product_valuations')
    .select('avg_unit_cost_xaf')
    .where('product_id', '=', productId)
    .executeTakeFirst();
  return valuation ? roundCmupToXaf(Number(valuation.avg_unit_cost_xaf)) : 0;
}

/** Applique le mouvement d'ajustement d'une ligne en écart (INVENTORY_GAIN/LOSS, daté de
 * `countedAt` — BR-STK-042/043) ; no-op si `variance === 0`. */
async function applyLineAdjustment(
  uow: Transaction<DB>,
  deps: RecordMoveDeps,
  params: {
    readonly countId: string;
    readonly locationId: string;
    readonly line: {
      readonly id: Buffer;
      readonly product_id: Buffer;
      readonly lot_id: Buffer | null;
      readonly counted_at: Date;
    };
    readonly variance: number;
    readonly unitCostXaf: number;
    readonly decidedBy: string;
    /** Instant de la comptabilisation (soumission ou décision) : date de clôture des conflits. */
    readonly postedAt: Date;
    /**
     * Lots du produit et leurs soldes à `counted_at`, pour une ligne qui porte sur tous les lots (BR-STK-045) : l'écart
     * se répartit alors en FIFO inverse, un mouvement par lot. Absent : un seul mouvement, sur le lot de la ligne.
     */
    readonly lotBalances?: readonly CountLotBalance[];
  },
): Promise<void> {
  if (params.variance === 0) return;
  const adjustmentLocationId = await virtualLocationId(uow, 'V_ADJUSTMENT');
  const parts =
    params.lotBalances !== undefined
      ? distributeLotLessVariance(params.variance, params.lotBalances)
      : [
          {
            lotId: fromBinOrNull(params.line.lot_id),
            quantity: Math.abs(params.variance),
            direction: params.variance > 0 ? ('GAIN' as const) : ('LOSS' as const),
          },
        ];
  for (const part of parts) {
    const isGain = part.direction === 'GAIN';
    await recordStockMove(uow, deps, {
      productId: fromBin(params.line.product_id),
      // Toujours explicite (BR-STK-045) : `null` est « sans lot », jamais résolu par le FIFO du serveur ; sinon la perte
      // d'une ligne sans lot irait aux lots, et le solde sans lot compté resterait faux (INV-STK-09).
      lotId: part.lotId,
      quantityBase: part.quantity,
      fromLocationId: isGain ? adjustmentLocationId : params.locationId,
      toLocationId: isGain ? params.locationId : adjustmentLocationId,
      moveType: isGain ? 'INVENTORY_GAIN' : 'INVENTORY_LOSS',
      occurredAt: params.line.counted_at,
      sourceDocType: 'INVENTORY_COUNT',
      sourceDocId: params.countId,
      sourceLineId: fromBin(params.line.id),
      // INVENTORY_GAIN est une entrée valorisée (record-move.ts, VALUATION_ENTRY_MOVE_TYPES) :
      // coût figé à la soumission. INVENTORY_LOSS n'en est pas une : le CMUP courant (au moment
      // où le mouvement est réellement appliqué, immédiat ou différé à la décision) s'applique
      // — écart de conception déjà présent dans record-move.ts, pas introduit ici.
      // Lot d'animaux : jamais de coût déclaré, le coût par tête s'applique (P7-03, ADR-027).
      ...(isGain &&
      (part.lotId === null || (await biologicalLotUnitCostXaf(uow, part.lotId)) === null)
        ? { declaredUnitCostXaf: params.unitCostXaf }
        : {}),
      createdBy: params.decidedBy,
      capturedOffline: false,
      allowNegative: true,
    });
  }
  // AT-049 : l'inventaire régularise un solde négatif né d'un fait hors ligne (INV-STK-05).
  await closeStockNegativeConflicts(uow, {
    locationId: params.locationId,
    productId: fromBin(params.line.product_id),
    resolvedBy: params.decidedBy,
    resolvedAt: params.postedAt,
    countId: params.countId,
  });
}

/**
 * BR-STK-044, INV-STK-09 : une fois l'inventaire comptabilisé, le solde de chaque ligne à son instant de comptage est la
 * quantité comptée. Entre la soumission et la décision d'un inventaire à valider, ou sous une écriture concurrente
 * validée pendant l'attente des soldes, un mouvement daté d'avant le comptage a pu s'enregistrer : le même ajustement
 * compensatoire que pour un mouvement tardif (motif `RAPPROCHEMENT_INVENTAIRE`) rétablit le solde, ligne par ligne.
 * Sans dérive (le cas courant), aucune écriture.
 */
async function reconcilePostedCount(
  uow: Transaction<DB>,
  deps: RecordMoveDeps,
  params: {
    readonly countId: string;
    readonly locationId: string;
    readonly siteId: string;
    readonly decidedBy: string;
  },
): Promise<void> {
  const lines = await uow
    .selectFrom('inventory_inventory_count_lines')
    .selectAll()
    .where('count_id', '=', toBin(params.countId))
    .orderBy('id', 'asc')
    .execute();
  for (const line of lines) {
    const posted: PostedCountLine = {
      lineId: fromBin(line.id),
      countId: params.countId,
      locationId: params.locationId,
      siteId: params.siteId,
      productId: fromBin(line.product_id),
      lotId: fromBinOrNull(line.lot_id),
      allLots: Boolean(line.all_lots),
      countedAt: line.counted_at,
      countedQtyBase: Number(line.counted_qty_base),
    };
    await reconcileCountLine(uow, deps, posted, { kind: 'POSTING', createdBy: params.decidedBy });
  }
}

function buildCountCommands(
  idGenerator: IdGenerator,
  documentSequences: DocumentSequenceService,
): {
  open: CommandHandler<OpenPayload>;
  recordLines: CommandHandler<RecordLinesPayload>;
  submit: CommandHandler<SubmitPayload>;
  cancel: CommandHandler<CancelPayload>;
  openingPost: CommandHandler<OpeningPostPayload>;
} {
  const deps: RecordMoveDeps = { idGenerator };

  const open: CommandHandler<OpenPayload> = async (uow, envelope) => {
    const { locationId, countType } = envelope.payload;
    const existing = await uow
      .selectFrom('inventory_inventory_counts')
      .select('id')
      .where('location_id', '=', toBin(locationId))
      .where('status', '=', 'IN_PROGRESS')
      .executeTakeFirst();
    if (existing) {
      return {
        status: 'REJECTED',
        errorCode: 'COUNT_ALREADY_OPEN',
        messageFr: 'Un inventaire est déjà en cours sur cet emplacement.',
      };
    }

    const occurredAt = new Date(envelope.occurred_at);
    const { siteId, codeSite } = await loadLocationSite(uow, locationId);
    const origin = await loadCommandOrigin(uow, envelope.command_id);
    // La référence locale est unique par appareil : déjà prise, l'ouverture est refusée en ligne ; hors ligne (une fiche
    // papier reportée est un fait accompli, BR-SYN-007) elle est appliquée sans la référence, avec l'avertissement
    // `LOCAL_REF_DUPLICATE` (sans ce contrôle, la clé unique ferait rejouer la commande sans fin).
    let localRef = envelope.payload.localRef ?? null;
    let localRefReused = false;
    if (localRef !== null && origin.deviceId !== null) {
      const sameRef = await uow
        .selectFrom('inventory_inventory_counts')
        .select('id')
        .where('created_device_id', '=', toBin(origin.deviceId))
        .where('local_ref', '=', localRef)
        .executeTakeFirst();
      if (sameRef) {
        if (!envelope.captured_offline) {
          return {
            status: 'REJECTED',
            errorCode: 'LOCAL_REF_DUPLICATE',
            messageFr: 'Référence locale déjà utilisée par cet appareil.',
          };
        }
        localRef = null;
        localRefReused = true;
      }
    }
    const docNumber = await documentSequences.next(uow, {
      docType: 'INV',
      siteId,
      codeSite,
      year: Number(businessDayOf(occurredAt).slice(0, 4)),
    });
    const countId = envelope.aggregate_id;

    await uow
      .insertInto('inventory_inventory_counts')
      .values({
        id: toBin(countId),
        doc_number: docNumber,
        local_ref: localRef,
        site_id: toBin(siteId),
        location_id: toBin(locationId),
        count_type: countType,
        status: 'IN_PROGRESS',
        opened_by: toBin(envelope.author_user_id),
        occurred_at: occurredAt,
        client_created_at: new Date(envelope.client_created_at),
        command_id: toBin(envelope.command_id),
        created_device_id: toBinOrNull(origin.deviceId),
        captured_offline: envelope.captured_offline ? 1 : 0,
        backdated_reason: envelope.backdated_reason,
        created_by: toBin(envelope.author_user_id),
      })
      .execute();

    await recordChanges(uow, [inventoryCountChange(countId, locationId)]);
    return localRefReused
      ? { status: 'APPLIED_WITH_WARNINGS', warnings: ['LOCAL_REF_DUPLICATE'] }
      : { status: 'APPLIED' };
  };

  const recordLines: CommandHandler<RecordLinesPayload> = async (uow, envelope) => {
    const row = await uow
      .selectFrom('inventory_inventory_counts')
      .select(['id', 'status', 'location_id'])
      .where('id', '=', toBin(envelope.payload.countId))
      .executeTakeFirst();
    if (!row) return notFound();
    if (row.status !== 'IN_PROGRESS') return badStatus('IN_PROGRESS');

    for (const line of envelope.payload.lines) {
      const values = {
        product_id: toBin(line.productId),
        lot_id: toBinOrNull(line.lotId ?? null),
        counted_at: new Date(line.countedAt),
        counted_qty_base: String(line.countedQtyBase),
        variance_reason_code_id: toBinOrNull(line.varianceReasonCodeId ?? null),
        comment: line.comment ?? null,
        command_id: toBin(envelope.command_id),
      };
      // Upsert par (count_id, product_id, lot_key) — colonne générée, UNIQUE (migration
      // P2-02) : une ligne déjà saisie pour ce (produit, lot) est corrigée, jamais dupliquée.
      await uow
        .insertInto('inventory_inventory_count_lines')
        .values({ id: toBin(idGenerator.newId()), count_id: row.id, ...values })
        .onDuplicateKeyUpdate(values)
        .execute();
    }

    await recordCountChange(uow, row);
    return { status: 'APPLIED' };
  };

  const submit: CommandHandler<SubmitPayload> = async (uow, envelope) => {
    const row = await uow
      .selectFrom('inventory_inventory_counts')
      .select(['id', 'status', 'site_id', 'location_id', 'doc_number'])
      .where('id', '=', toBin(envelope.payload.countId))
      .executeTakeFirst();
    if (!row) return notFound();
    if (row.status !== 'IN_PROGRESS') return badStatus('IN_PROGRESS');

    const lines = await uow
      .selectFrom('inventory_inventory_count_lines')
      .selectAll()
      .where('count_id', '=', row.id)
      .execute();
    if (lines.length === 0) {
      return {
        status: 'REJECTED',
        errorCode: 'COUNT_NO_LINES',
        messageFr: 'Au moins une ligne comptée est requise.',
      };
    }

    const occurredAt = new Date(envelope.occurred_at);
    const locationId = fromBin(row.location_id);
    let varianceValueXaf = 0;
    const computed: Array<{
      readonly line: (typeof lines)[number];
      readonly theoretical: number;
      readonly variance: number;
      readonly unitCostXaf: number;
      /** Lots à répartir (BR-STK-045), seulement pour une ligne qui porte sur tous les lots. */
      readonly lotBalances: readonly CountLotBalance[] | undefined;
    }> = [];

    // ADR-038 N5 : soldes de tous les produits comptés, triés, avant le premier mouvement.
    await lockPhysicalStockCouples(
      uow,
      lines.map((line) => ({ locationId, productId: fromBin(line.product_id) })),
    );
    for (const line of lines) {
      const { theoretical, allLots, lotBalances } = await theoreticalOfLine(uow, {
        locationId,
        line,
        siblings: lines,
      });
      const variance = reconciliationDelta(Number(line.counted_qty_base), theoretical);
      const unitCostXaf = await currentUnitCostXaf(uow, line.product_id, line.lot_id);
      varianceValueXaf += variance * unitCostXaf;
      computed.push({
        line,
        theoretical,
        variance,
        unitCostXaf,
        lotBalances: allLots ? lotBalances : undefined,
      });

      await uow
        .updateTable('inventory_inventory_count_lines')
        .set({
          theoretical_qty_base: String(theoretical),
          variance_qty_base: String(variance),
          unit_cost_xaf: unitCostXaf,
          all_lots: allLots ? 1 : 0,
        })
        .where('id', '=', line.id)
        .execute();
    }

    const absVarianceValueXaf = Math.abs(varianceValueXaf);
    // AV-108 (28/09/2026) : tout écart sur des animaux (produits BIOLOGIQUE) exige la validation
    // du Responsable production, quel que soit le seuil en valeur — un inventaire en baisse ne
    // doit pas contourner la validation systématique des mortalités (AV-048).
    const animalVariance = await hasBiologicalVariance(uow, computed);
    const thresholdSetting = await currentSettingValue(uow, {
      key: COUNT_APPROVAL_THRESHOLD_KEY,
      scopeType: 'GLOBAL',
      scopeId: null,
      at: occurredAt,
    });
    const threshold =
      thresholdSetting !== undefined
        ? Number(thresholdSetting)
        : COUNT_APPROVAL_THRESHOLD_FALLBACK_XAF;
    const requiresApproval = animalVariance || absVarianceValueXaf >= threshold;
    const operationType = animalVariance ? 'ANIMAL_COUNT_ADJUSTMENT' : 'INVENTORY_ADJUSTMENT';

    if (!requiresApproval) {
      for (const entry of computed) {
        await applyLineAdjustment(uow, deps, {
          countId: envelope.payload.countId,
          locationId,
          line: entry.line,
          variance: entry.variance,
          unitCostXaf: entry.unitCostXaf,
          decidedBy: envelope.author_user_id,
          postedAt: occurredAt,
          ...(entry.lotBalances !== undefined ? { lotBalances: entry.lotBalances } : {}),
        });
      }
      await uow
        .updateTable('inventory_inventory_counts')
        .set({
          status: 'POSTED',
          submitted_by: toBin(envelope.author_user_id),
          submitted_at: occurredAt,
          variance_value_xaf: varianceValueXaf,
          abs_variance_value_xaf: absVarianceValueXaf,
          posted_at: occurredAt,
          updated_by: toBin(envelope.author_user_id),
          version: sql`version + 1`,
        })
        .where('id', '=', row.id)
        .execute();
      await reconcilePostedCount(uow, deps, {
        countId: envelope.payload.countId,
        locationId,
        siteId: fromBin(row.site_id),
        decidedBy: envelope.author_user_id,
      });
      await recordCountChange(uow, row);
      await publishInventoryAdjustedEvent(uow, deps, {
        countId: envelope.payload.countId,
        locationId,
        siteId: fromBin(row.site_id),
        varianceQuantity: netVarianceQuantity(computed),
        varianceValueXaf,
        factAt: occurredAt,
        commandId: envelope.command_id,
      });
      return { status: 'APPLIED' };
    }

    // Hors ligne, une politique révisée entre le comptage et l'envoi ne rend pas le fait refusé.
    const policy = await decidablePolicyFor(
      uow,
      operationType,
      occurredAt,
      envelope.captured_offline
        ? (await loadCommandOrigin(uow, envelope.command_id)).receivedAt
        : undefined,
    );
    if (!policy) {
      return {
        status: 'REJECTED',
        errorCode: 'CONTROL_POLICY_MISSING',
        messageFr: `Aucune politique de contrôle ${operationType} configurée (approvals.policy.set).`,
      };
    }

    const approvalRequestId = idGenerator.newId();
    await requestApproval(uow, {
      requestId: approvalRequestId,
      operationType,
      subjectType: 'INVENTORY_COUNT',
      subjectId: envelope.payload.countId,
      // RC-05 (MP-11, revue adverse) : aucune valeur au coût dans le résumé, servi tel quel au demandeur
      // (projection APPROVAL_REQUEST) ; le montant reste dans `amount_xaf`, masqué sans droit de
      // valorisation.
      subjectSummary:
        operationType === 'ANIMAL_COUNT_ADJUSTMENT'
          ? `Écart de comptage d'animaux ${row.doc_number}`
          : `Écart d'inventaire ${row.doc_number}`,
      siteId: fromBin(row.site_id),
      amountXaf: absVarianceValueXaf,
      requestedBy: envelope.author_user_id,
      requestedAt: occurredAt,
      policyId: policy.id,
      policyVersion: policy.version,
    });

    await uow
      .updateTable('inventory_inventory_counts')
      .set({
        status: 'PENDING_APPROVAL',
        submitted_by: toBin(envelope.author_user_id),
        submitted_at: occurredAt,
        variance_value_xaf: varianceValueXaf,
        abs_variance_value_xaf: absVarianceValueXaf,
        approval_request_id: toBin(approvalRequestId),
        updated_by: toBin(envelope.author_user_id),
        version: sql`version + 1`,
      })
      .where('id', '=', row.id)
      .execute();

    await recordCountChange(uow, row);
    // P9-08 (AV-406) : l'alerte accompagne la demande de validation ; un inventaire sans écart n'en lève pas.
    const linesWithVariance = computed.filter((entry) => Math.abs(entry.variance) >= 0.0005).length;
    if (linesWithVariance > 0) {
      await publishInventoryVarianceEvent(uow, deps, {
        countId: envelope.payload.countId,
        locationId,
        siteId: fromBin(row.site_id),
        varianceQuantity: netVarianceQuantity(computed),
        varianceValueXaf,
        absVarianceValueXaf,
        linesWithVariance,
        animalVariance,
        thresholdXaf: threshold,
        approvalRequestId,
        factAt: occurredAt,
        commandId: envelope.command_id,
      });
    }
    return { status: 'APPLIED' };
  };

  const cancel: CommandHandler<CancelPayload> = async (uow, envelope) => {
    const row = await uow
      .selectFrom('inventory_inventory_counts')
      .select(['id', 'status', 'location_id'])
      .where('id', '=', toBin(envelope.payload.countId))
      .executeTakeFirst();
    if (!row) return notFound();
    if (row.status !== 'IN_PROGRESS') return badStatus('IN_PROGRESS');

    await uow
      .updateTable('inventory_inventory_counts')
      .set({
        status: 'CANCELLED',
        updated_by: toBin(envelope.author_user_id),
        version: sql`version + 1`,
      })
      .where('id', '=', row.id)
      .execute();
    await recordCountChange(uow, row);
    return { status: 'APPLIED' };
  };

  /**
   * Pose un inventaire d'ouverture et demande sa validation (BR-STK-046, AV-517). Un seul par emplacement tant
   * qu'il n'est pas rejeté ou annulé ; des produits distincts ; ni produit biologique ni produit suivi par lot
   * obligatoire (leurs lots naissent des commandes de production et de réception). Le document reste
   * `PENDING_APPROVAL` jusqu'à la décision (`registerInventoryAdjustmentDecisionHandler`) : aucun mouvement avant.
   */
  const openingPost: CommandHandler<OpeningPostPayload> = async (uow, envelope) => {
    const countId = envelope.aggregate_id;
    const { locationId, lines, comment } = envelope.payload;
    const refuse = (errorCode: string, messageFr: string): CommandHandlerOutcome => ({
      status: 'REJECTED',
      errorCode,
      messageFr,
    });
    const already = await uow
      .selectFrom('inventory_inventory_counts')
      .select(['id', 'status'])
      .where('id', '=', toBin(countId))
      .executeTakeFirst();
    if (already) {
      // Le rejeu d'un document vivant ne fait rien de plus. Un document refusé par l'approbateur ou annulé n'est pas
      // « fait » : répondre « appliqué » sans rien créer laisserait croire à un stock posé (AV-517 (4) : un refus libère
      // l'emplacement, pour une nouvelle tentative sous un autre identifiant).
      if (already.status === 'REJECTED' || already.status === 'CANCELLED') {
        return refuse(
          'OPENING_ID_TAKEN',
          'Ce stock d’ouverture a déjà été posé puis refusé : corrigez-le (une quantité, un coût) ou reposez-le comme un nouveau document.',
        );
      }
      return { status: 'APPLIED' };
    }

    // L'emplacement est verrouillé d'abord : deux stocks d'ouverture simultanés pour le même emplacement se suivent, le
    // second voit le premier et reçoit un refus propre (et non une violation d'unicité à l'approbation).
    const location = await uow
      .selectFrom('organization_locations')
      .select(['site_id', 'is_virtual', 'status'])
      .where('id', '=', toBin(locationId))
      .forUpdate()
      .executeTakeFirst();
    if (!location) return refuse('NOT_FOUND', 'Emplacement introuvable.');
    if (Boolean(location.is_virtual) || location.site_id === null || location.status !== 'ACTIVE') {
      return refuse(
        'OPENING_LOCATION_INVALID',
        'Le stock d’ouverture se pose sur un emplacement physique actif.',
      );
    }
    const existing = await uow
      .selectFrom('inventory_inventory_counts')
      .select('status')
      .where('location_id', '=', toBin(locationId))
      .where('count_type', '=', 'OPENING')
      .where('status', 'in', ['PENDING_APPROVAL', 'POSTED'])
      .forUpdate()
      .executeTakeFirst();
    if (existing) {
      return refuse(
        'OPENING_ALREADY_EXISTS',
        existing.status === 'POSTED'
          ? 'Cet emplacement a déjà son stock d’ouverture (BR-STK-046).'
          : 'Le stock d’ouverture de cet emplacement attend sa validation.',
      );
    }

    const productIds = lines.map((line) => line.productId);
    if (new Set(productIds).size !== productIds.length) {
      return refuse(
        'OPENING_DUPLICATE_PRODUCT',
        'Un produit ne figure qu’une fois au stock d’ouverture.',
      );
    }
    const products = await uow
      .selectFrom('catalog_products')
      .select(['id', 'status', 'stock_family', 'lot_tracking'])
      .where(
        'id',
        'in',
        productIds.map((id) => toBin(id)),
      )
      .execute();
    if (products.length !== productIds.length) return refuse('NOT_FOUND', 'Produit introuvable.');
    for (const product of products) {
      if (product.status !== 'ACTIVE') {
        return refuse('PRODUCT_INACTIVE', 'Un produit du stock d’ouverture est désactivé.');
      }
      if (
        product.stock_family === 'BIOLOGIQUE' ||
        product.stock_family === 'SERVICE' ||
        product.lot_tracking === 'REQUIRED'
      ) {
        return refuse(
          'OPENING_PRODUCT_NOT_ALLOWED',
          'Les animaux, les services et les produits suivis par lot obligatoire ne se chargent pas ici : leurs lots naissent des commandes de production et de réception.',
        );
      }
    }

    // Le théorique d'un stock d'ouverture est nul : sur un emplacement qui a déjà des mouvements pour l'un de ces
    // produits, les quantités comptées s'ajouteraient au stock existant (50 reçus le 03/11 + 80 comptés le 05/11 dont
    // les 50 = 130). Un stock d'ouverture se pose avant tout mouvement ; ensuite, c'est un inventaire.
    const alreadyMoved = await uow
      .selectFrom('inventory_stock_moves')
      .select('product_id')
      .where(
        'product_id',
        'in',
        productIds.map((id) => toBin(id)),
      )
      .where((eb) =>
        eb.or([
          eb('from_location_id', '=', toBin(locationId)),
          eb('to_location_id', '=', toBin(locationId)),
        ]),
      )
      .limit(1)
      .executeTakeFirst();
    if (alreadyMoved) {
      return refuse(
        'OPENING_LOCATION_NOT_EMPTY',
        'Cet emplacement a déjà des mouvements pour l’un de ces produits : un stock d’ouverture se pose avant tout mouvement (ensuite, corrigez par un inventaire).',
      );
    }

    // Valeur du document : somme des valeurs de ligne arrondies au franc, en arithmétique entière — la même qu'à la
    // comptabilisation (une valeur par mouvement) ; jamais de flottant sur des montants.
    let totalValueXaf = 0;
    try {
      for (const line of lines) {
        totalValueXaf += lineAmountXaf(
          quantityFromDecimal(line.quantityBase),
          xaf(line.unitCostXaf),
        );
      }
      if (!Number.isSafeInteger(totalValueXaf))
        throw new DomainError('Valeur du document hors limites.', 'OUT_OF_RANGE');
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return refuse(
        'OPENING_VALUE_TOO_LARGE',
        'La valeur d’une ligne ou du document dépasse la limite : vérifiez la quantité et le coût unitaire.',
      );
    }

    const occurredAt = new Date(envelope.occurred_at);
    const policy = await decidablePolicyFor(
      uow,
      'INVENTORY_ADJUSTMENT',
      occurredAt,
      envelope.captured_offline
        ? (await loadCommandOrigin(uow, envelope.command_id)).receivedAt
        : undefined,
    );
    if (!policy) {
      return refuse(
        'CONTROL_POLICY_MISSING',
        'Aucune politique de contrôle INVENTORY_ADJUSTMENT configurée (approvals.policy.set).',
      );
    }

    const { siteId, codeSite } = await loadLocationSite(uow, locationId);
    const origin = await loadCommandOrigin(uow, envelope.command_id);
    const docNumber = await documentSequences.next(uow, {
      docType: 'INV',
      siteId,
      codeSite,
      year: Number(businessDayOf(occurredAt).slice(0, 4)),
    });
    const valueXaf = totalValueXaf;
    const approvalRequestId = idGenerator.newId();

    await uow
      .insertInto('inventory_inventory_counts')
      .values({
        id: toBin(countId),
        doc_number: docNumber,
        site_id: toBin(siteId),
        location_id: toBin(locationId),
        count_type: 'OPENING',
        status: 'PENDING_APPROVAL',
        opened_by: toBin(envelope.author_user_id),
        submitted_by: toBin(envelope.author_user_id),
        submitted_at: occurredAt,
        variance_value_xaf: valueXaf,
        abs_variance_value_xaf: valueXaf,
        occurred_at: occurredAt,
        client_created_at: new Date(envelope.client_created_at),
        command_id: toBin(envelope.command_id),
        created_device_id: toBinOrNull(origin.deviceId),
        captured_offline: envelope.captured_offline ? 1 : 0,
        backdated_reason: envelope.backdated_reason,
        created_by: toBin(envelope.author_user_id),
      })
      .execute();
    // La demande de validation référence le document : elle vient après lui, le document la référence ensuite.
    await requestApproval(uow, {
      requestId: approvalRequestId,
      operationType: 'INVENTORY_ADJUSTMENT',
      subjectType: 'INVENTORY_COUNT',
      subjectId: countId,
      // Aucune valeur au coût dans le résumé (RC-05) : le montant reste dans `amount_xaf`.
      subjectSummary: `Stock d’ouverture ${docNumber}`,
      siteId,
      amountXaf: valueXaf,
      requestedBy: envelope.author_user_id,
      requestedAt: occurredAt,
      policyId: policy.id,
      policyVersion: policy.version,
    });
    await uow
      .updateTable('inventory_inventory_counts')
      .set({ approval_request_id: toBin(approvalRequestId) })
      .where('id', '=', toBin(countId))
      .execute();
    for (const line of lines) {
      await uow
        .insertInto('inventory_inventory_count_lines')
        .values({
          id: toBin(idGenerator.newId()),
          count_id: toBin(countId),
          product_id: toBin(line.productId),
          lot_id: null,
          counted_at: occurredAt,
          counted_qty_base: String(line.quantityBase),
          theoretical_qty_base: '0',
          variance_qty_base: String(line.quantityBase),
          unit_cost_xaf: line.unitCostXaf,
          declared_unit_cost_xaf: line.unitCostXaf,
          comment: comment ?? null,
          command_id: toBin(envelope.command_id),
        })
        .execute();
    }
    await recordChanges(uow, [inventoryCountChange(countId, locationId)]);
    return {
      status: 'APPLIED',
      audit: {
        after: { countType: 'OPENING', lines: lines.length, valueXaf, status: 'PENDING_APPROVAL' },
      },
    };
  };

  return { open, recordLines, submit, cancel, openingPost };
}

/** Décision `INVENTORY_ADJUSTMENT` (SM-INVENTORY-COUNT `PENDING_APPROVAL -> {POSTED,
 * REJECTED}`) : approuvée = comptabilise les écarts déjà figés à la soumission (théorique,
 * variance, coût — jamais recalculés ici) ; rejetée = aucun mouvement, recomptage demandé
 * par une nouvelle ouverture (pas de transition automatique documentée). */
function registerInventoryAdjustmentDecisionHandler(
  decisionRegistry: ApprovalDecisionHandlerRegistry,
  idGenerator: IdGenerator,
): void {
  const deps: RecordMoveDeps = { idGenerator };
  // AV-108 : même décision pour un écart portant sur des animaux (validation du Resp. production).
  for (const operationType of ['INVENTORY_ADJUSTMENT', 'ANIMAL_COUNT_ADJUSTMENT'] as const)
    decisionRegistry.register(operationType, async (uow, ctx) => {
      const row = await uow
        .selectFrom('inventory_inventory_counts')
        .select(['id', 'location_id', 'site_id', 'variance_value_xaf', 'count_type'])
        .where('id', '=', toBin(ctx.subjectId))
        .executeTakeFirstOrThrow();

      if (ctx.decision === 'APPROVED') {
        const locationId = fromBin(row.location_id);
        const lines = await uow
          .selectFrom('inventory_inventory_count_lines')
          .selectAll()
          .where('count_id', '=', row.id)
          .execute();
        await lockPhysicalStockCouples(
          uow,
          lines.map((line) => ({ locationId, productId: fromBin(line.product_id) })),
        );
        if (row.count_type === 'OPENING') {
          // Stock d'ouverture (AV-517) : un `OPENING_BALANCE` par ligne, depuis `V_OPENING`, au coût déclaré.
          const openingLocationId = await virtualLocationId(uow, 'V_OPENING');
          for (const line of lines) {
            await recordStockMove(uow, deps, {
              productId: fromBin(line.product_id),
              quantityBase: Number(line.counted_qty_base),
              fromLocationId: openingLocationId,
              toLocationId: locationId,
              moveType: 'OPENING_BALANCE',
              occurredAt: line.counted_at,
              sourceDocType: 'INVENTORY_COUNT',
              sourceDocId: ctx.subjectId,
              sourceLineId: fromBin(line.id),
              declaredUnitCostXaf: Number(line.unit_cost_xaf ?? 0),
              createdBy: ctx.decidedBy,
              capturedOffline: false,
              allowNegative: false,
            });
          }
          await uow
            .updateTable('inventory_inventory_counts')
            .set({
              status: 'POSTED',
              posted_at: ctx.decidedAt,
              updated_by: toBin(ctx.decidedBy),
              version: sql`version + 1`,
            })
            .where('id', '=', row.id)
            .execute();
          await recordCountChange(uow, row);
          return;
        }
        for (const line of lines) {
          const variance = line.variance_qty_base !== null ? Number(line.variance_qty_base) : 0;
          // BR-STK-045 : l'écart figé d'une ligne sur tous les lots se répartit sur les soldes par lot d'aujourd'hui à
          // `counted_at` (un fait tardif a pu s'enregistrer entre la soumission et la décision).
          const lotBalances = Boolean(line.all_lots)
            ? await lotBalancesOf(
                uow,
                await ledgerBucketsAt(uow, {
                  locationId,
                  productId: fromBin(line.product_id),
                  at: line.counted_at,
                  lock: true,
                }),
              )
            : undefined;
          await applyLineAdjustment(uow, deps, {
            countId: ctx.subjectId,
            locationId,
            line,
            variance,
            unitCostXaf: line.unit_cost_xaf !== null ? Number(line.unit_cost_xaf) : 0,
            decidedBy: ctx.decidedBy,
            postedAt: ctx.decidedAt,
            ...(lotBalances !== undefined ? { lotBalances } : {}),
          });
        }
        await uow
          .updateTable('inventory_inventory_counts')
          .set({
            status: 'POSTED',
            posted_at: ctx.decidedAt,
            updated_by: toBin(ctx.decidedBy),
            version: sql`version + 1`,
          })
          .where('id', '=', row.id)
          .execute();
        // BR-STK-044 : ce qui s'est enregistré entre la soumission et la décision, daté d'avant le comptage.
        await reconcilePostedCount(uow, deps, {
          countId: ctx.subjectId,
          locationId,
          siteId: fromBin(row.site_id),
          decidedBy: ctx.decidedBy,
        });
        await recordCountChange(uow, row);
        // P9-08 : ferme l'alerte `INVENTORY_VARIANCE` du même inventaire (AV-406).
        await publishInventoryAdjustedEvent(uow, deps, {
          countId: ctx.subjectId,
          locationId,
          siteId: fromBin(row.site_id),
          varianceQuantity: lines.reduce(
            (sum, line) =>
              sum + (line.variance_qty_base !== null ? Number(line.variance_qty_base) : 0),
            0,
          ),
          varianceValueXaf: row.variance_value_xaf !== null ? Number(row.variance_value_xaf) : 0,
          factAt: ctx.decidedAt,
        });
        return;
      }

      await uow
        .updateTable('inventory_inventory_counts')
        .set({ status: 'REJECTED', updated_by: toBin(ctx.decidedBy), version: sql`version + 1` })
        .where('id', '=', row.id)
        .execute();
      await recordCountChange(uow, row);
    });
}

/** Écart net signé des lignes comptées (quantités d'unités différentes : indicateur grossier, AV-406). */
function netVarianceQuantity(computed: readonly { readonly variance: number }[]): number {
  return Math.round(computed.reduce((sum, entry) => sum + entry.variance, 0) * 1000) / 1000;
}

/** AV-108 : vrai si un écart non nul porte sur un produit de famille `BIOLOGIQUE`. */
async function hasBiologicalVariance(
  uow: UnitOfWork,
  computed: readonly {
    readonly line: { readonly product_id: Buffer };
    readonly variance: number;
  }[],
): Promise<boolean> {
  const productIds = computed
    .filter((entry) => Math.abs(entry.variance) >= 0.0005)
    .map((entry) => entry.line.product_id);
  if (productIds.length === 0) return false;
  const row = await uow
    .selectFrom('catalog_products')
    .select('id')
    .where('id', 'in', productIds)
    .where('stock_family', '=', 'BIOLOGIQUE')
    .executeTakeFirst();
  return row !== undefined;
}

/** Jeu `counts` (P2-06) : à chaque changement d'état ou de lignes de l'inventaire. */
async function recordCountChange(
  uow: UnitOfWork,
  row: { readonly id: Buffer; readonly location_id: Buffer },
): Promise<void> {
  await recordChanges(uow, [inventoryCountChange(fromBin(row.id), fromBin(row.location_id))]);
}

export function registerCountCommands(
  registry: CommandHandlerRegistry,
  decisionRegistry: ApprovalDecisionHandlerRegistry,
  idGenerator: IdGenerator,
  documentSequences: DocumentSequenceService,
): void {
  const handlers = buildCountCommands(idGenerator, documentSequences);
  registry.register({
    commandType: 'inventory.count.open',
    version: 1,
    payloadSchema: openPayloadSchema,
    permissionCode: 'inventory.count.perform',
    // AV-182 (P5-23) : portée de l'emplacement compté.
    handler: withStockScope(
      'inventory.count.perform',
      async (_uow, envelope) => [envelope.payload.locationId],
      handlers.open,
    ),
  });
  registry.register({
    commandType: 'inventory.count.record_lines',
    version: 1,
    payloadSchema: recordLinesPayloadSchema,
    permissionCode: 'inventory.count.perform',
    handler: withStockScope(
      'inventory.count.perform',
      (uow, envelope) =>
        documentLocation(uow, 'inventory_inventory_counts', envelope.payload.countId),
      handlers.recordLines,
    ),
  });
  registry.register({
    commandType: 'inventory.count.submit',
    version: 1,
    payloadSchema: submitPayloadSchema,
    permissionCode: 'inventory.count.perform',
    handler: withStockScope(
      'inventory.count.perform',
      (uow, envelope) =>
        documentLocation(uow, 'inventory_inventory_counts', envelope.payload.countId),
      handlers.submit,
    ),
  });
  registry.register({
    commandType: 'inventory.count.cancel',
    version: 1,
    payloadSchema: cancelPayloadSchema,
    permissionCode: 'inventory.count.perform',
    handler: withStockScope(
      'inventory.count.perform',
      (uow, envelope) =>
        documentLocation(uow, 'inventory_inventory_counts', envelope.payload.countId),
      handlers.cancel,
    ),
  });
  registry.register({
    commandType: 'inventory.opening.post',
    version: 1,
    payloadSchema: openingPostPayloadSchema,
    permissionCode: 'inventory.opening.post',
    // Portée de l'emplacement chargé (comme `inventory.count.open`, AV-182).
    handler: withStockScope(
      'inventory.opening.post',
      async (_uow, envelope) => [envelope.payload.locationId],
      handlers.openingPost,
    ),
  });
  registerInventoryAdjustmentDecisionHandler(decisionRegistry, idGenerator);
}
