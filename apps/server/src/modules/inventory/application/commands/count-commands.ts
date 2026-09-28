/**
 * `inventory.count.{open,record_lines,submit,cancel}` (SM-INVENTORY-COUNT) + gestionnaires de
 * décision `INVENTORY_ADJUSTMENT` et `ANIMAL_COUNT_ADJUSTMENT` (P7-02, AV-108 : tout écart sur des
 * animaux est validé par le Responsable production). Portée de P2-04 : natures
 * `FULL`/`PARTIAL`/`SPOT`.
 *
 * Hors périmètre, documenté et non simulé : inventaire d'ouverture (`count_type = 'OPENING'`,
 * `inventory.opening.post`) — `OPENING_BALANCE` reste utilisable directement via
 * `recordStockMove` (déjà testé en P2-03), sans passer par ce workflow ; BR-STK-044
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
import { sql, type Transaction } from 'kysely';
import type { IdGenerator } from '@gic/domain';
import { roundCmupToXaf, businessDayOf } from '@gic/domain';
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
  currentPolicies,
  type ApprovalDecisionHandlerRegistry,
} from '../../../approvals/application/public/index.js';
import { recordChanges } from '../../../../platform/sync/change-feed.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import {
  biologicalLotUnitCostXaf,
  recordStockMove,
  type RecordMoveDeps,
} from '../public/record-move.js';
import { inventoryCountChange } from '../sync-changes.js';
import { loadCommandOrigin, loadLocationSite, virtualLocationId } from './shared.js';

const COUNT_APPROVAL_THRESHOLD_KEY = 'inventory.count_approval_threshold_xaf';
/** AV-039 : repli documenté, utilisé seulement si la clé n'existe pas encore dans la base. */
const COUNT_APPROVAL_THRESHOLD_FALLBACK_XAF = 25_000;

// `OPENING` exclu : hors périmètre (`inventory.opening.post`, non implémenté ici).
const COUNT_TYPES = ['FULL', 'PARTIAL', 'SPOT'] as const;

const openPayloadSchema = z.object({
  locationId: z.string().uuid(),
  countType: z.enum(COUNT_TYPES),
});
type OpenPayload = z.infer<typeof openPayloadSchema>;

const countLineInputSchema = z.object({
  productId: z.string().uuid(),
  lotId: z.string().uuid().optional(),
  countedAt: z.string().datetime({ offset: true }),
  countedQtyBase: z.number().nonnegative(),
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

/** Solde théorique d'un (produit, lot) à `at`, en rejouant `inventory_stock_moves` sur
 * l'emplacement (BR-STK-042) : entrées reçues moins sorties, `occurred_at <= at`. */
async function computeTheoreticalQtyBase(
  uow: Transaction<DB>,
  params: {
    readonly locationId: string;
    readonly productId: string;
    readonly lotId: string | null;
    readonly at: Date;
  },
): Promise<number> {
  const inflow = await uow
    .selectFrom('inventory_stock_moves')
    .select(({ fn }) => fn.sum('quantity').as('total'))
    .where('to_location_id', '=', toBin(params.locationId))
    .where('product_id', '=', toBin(params.productId))
    .$if(params.lotId !== null, (qb) => qb.where('lot_id', '=', toBin(params.lotId as string)))
    .$if(params.lotId === null, (qb) => qb.where('lot_id', 'is', null))
    .where('occurred_at', '<=', params.at)
    .executeTakeFirst();
  const outflow = await uow
    .selectFrom('inventory_stock_moves')
    .select(({ fn }) => fn.sum('quantity').as('total'))
    .where('from_location_id', '=', toBin(params.locationId))
    .where('product_id', '=', toBin(params.productId))
    .$if(params.lotId !== null, (qb) => qb.where('lot_id', '=', toBin(params.lotId as string)))
    .$if(params.lotId === null, (qb) => qb.where('lot_id', 'is', null))
    .where('occurred_at', '<=', params.at)
    .executeTakeFirst();
  return Number(inflow?.total ?? 0) - Number(outflow?.total ?? 0);
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
  },
): Promise<void> {
  if (params.variance === 0) return;
  const lotId = fromBinOrNull(params.line.lot_id);
  const adjustmentLocationId = await virtualLocationId(uow, 'V_ADJUSTMENT');
  const isGain = params.variance > 0;
  await recordStockMove(uow, deps, {
    productId: fromBin(params.line.product_id),
    ...(lotId !== null ? { lotId } : {}),
    quantityBase: Math.abs(params.variance),
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
    ...(isGain && (lotId === null || (await biologicalLotUnitCostXaf(uow, lotId)) === null)
      ? { declaredUnitCostXaf: params.unitCostXaf }
      : {}),
    createdBy: params.decidedBy,
    capturedOffline: false,
    allowNegative: true,
  });
}

function buildCountCommands(
  idGenerator: IdGenerator,
  documentSequences: DocumentSequenceService,
): {
  open: CommandHandler<OpenPayload>;
  recordLines: CommandHandler<RecordLinesPayload>;
  submit: CommandHandler<SubmitPayload>;
  cancel: CommandHandler<CancelPayload>;
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
    return { status: 'APPLIED' };
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
      .select(['id', 'status', 'site_id', 'location_id'])
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
    }> = [];

    for (const line of lines) {
      const lotId = fromBinOrNull(line.lot_id);
      const theoretical = await computeTheoreticalQtyBase(uow, {
        locationId,
        productId: fromBin(line.product_id),
        lotId,
        at: line.counted_at,
      });
      const variance = Number(line.counted_qty_base) - theoretical;
      const unitCostXaf = await currentUnitCostXaf(uow, line.product_id, line.lot_id);
      varianceValueXaf += variance * unitCostXaf;
      computed.push({ line, theoretical, variance, unitCostXaf });

      await uow
        .updateTable('inventory_inventory_count_lines')
        .set({
          theoretical_qty_base: String(theoretical),
          variance_qty_base: String(variance),
          unit_cost_xaf: unitCostXaf,
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
      await recordCountChange(uow, row);
      return { status: 'APPLIED' };
    }

    const policies = await currentPolicies(uow, operationType, occurredAt);
    const policy = policies[0];
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
      subjectSummary: `Écart d'inventaire de ${absVarianceValueXaf} XAF`,
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

  return { open, recordLines, submit, cancel };
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
        .select(['id', 'location_id'])
        .where('id', '=', toBin(ctx.subjectId))
        .executeTakeFirstOrThrow();

      if (ctx.decision === 'APPROVED') {
        const locationId = fromBin(row.location_id);
        const lines = await uow
          .selectFrom('inventory_inventory_count_lines')
          .selectAll()
          .where('count_id', '=', row.id)
          .execute();
        for (const line of lines) {
          const variance = line.variance_qty_base !== null ? Number(line.variance_qty_base) : 0;
          await applyLineAdjustment(uow, deps, {
            countId: ctx.subjectId,
            locationId,
            line,
            variance,
            unitCostXaf: line.unit_cost_xaf !== null ? Number(line.unit_cost_xaf) : 0,
            decidedBy: ctx.decidedBy,
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

      await uow
        .updateTable('inventory_inventory_counts')
        .set({ status: 'REJECTED', updated_by: toBin(ctx.decidedBy), version: sql`version + 1` })
        .where('id', '=', row.id)
        .execute();
      await recordCountChange(uow, row);
    });
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
    handler: handlers.open,
  });
  registry.register({
    commandType: 'inventory.count.record_lines',
    version: 1,
    payloadSchema: recordLinesPayloadSchema,
    permissionCode: 'inventory.count.perform',
    handler: handlers.recordLines,
  });
  registry.register({
    commandType: 'inventory.count.submit',
    version: 1,
    payloadSchema: submitPayloadSchema,
    permissionCode: 'inventory.count.perform',
    handler: handlers.submit,
  });
  registry.register({
    commandType: 'inventory.count.cancel',
    version: 1,
    payloadSchema: cancelPayloadSchema,
    permissionCode: 'inventory.count.perform',
    handler: handlers.cancel,
  });
  registerInventoryAdjustmentDecisionHandler(decisionRegistry, idGenerator);
}
