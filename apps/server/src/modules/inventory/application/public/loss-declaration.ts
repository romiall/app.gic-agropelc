/**
 * Déclaration de perte (`inventory.loss_declarations`, SM-LOSS ; D06 BR-STK-030 à 035) : API
 * publique d'`inventory`, appelée par la commande `inventory.loss.declare` et, depuis P7, par
 * `production.mortality.record` (la mortalité n'existe qu'une fois : une perte `MORTALITE`,
 * INV-PRD-03).
 *
 * Politique de contrôle :
 * - catégorie `MORTALITE` → type d'opération **`MORTALITY`** quel que soit le point d'entrée
 *   (AV-119), validé par `production.mortality.approve` (AV-005). La politique est obligatoire
 *   (AV-048 : toute mortalité est validée) : sans politique active, refus
 *   `CONTROL_POLICY_MISSING` (garde de configuration, même précédent que P6). Seuils lus dans la
 *   `condition` de la politique (`relativePct`, `absoluteHeads` ; 0 par défaut = toute mortalité)
 *   et évalués par `mortalityRequiresApproval` (packages/domain, même règle que l'appareil,
 *   BR-PRD-006) sur l'effectif en élevage du lot à `occurred_at` ;
 * - autres catégories → `LOSS_DECLARATION` (P2-04, inchangé).
 *
 * Pièces : les pièces citées par la commande deviennent les pièces requises de la demande de
 * validation (BR-ADM-020). Une mortalité reçue sans photo est enregistrée ; son approbation est
 * refusée tant qu'aucune photo disponible n'est rattachée à la déclaration
 * (`owner_type = STOCK_LOSS`, AV-107 — gestionnaire de décision `MORTALITY`).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { mortalityRequiresApproval, type IdGenerator, businessDayOf } from '@gic/domain';
import type { CommandHandlerOutcome } from '../../../../platform/sync/command-handler-registry.js';
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import type { DocumentSequenceService } from '../../../../platform/document-sequences/document-sequence.service.js';
import {
  fromBin,
  fromBinOrNull,
  toBin,
  toBinOrNull,
} from '../../../../platform/kysely/uuid-columns.js';
import { toDbBool } from '../../../../platform/kysely/bool-column.js';
import { loadCommandOrigin } from '../../../../platform/sync/command-origin.js';
import {
  ApprovalDecisionRefused,
  currentPolicies,
  requestApproval,
  type ActiveControlPolicy,
  type ApprovalDecisionHandlerRegistry,
} from '../../../approvals/application/public/index.js';
import { hasAvailableAttachment } from '../../../attachments/application/public/index.js';
import { recordStockMove } from './record-move.js';
import { lotHeadcount } from './lot-headcount.js';
import { loadLocationSite, tryRecordMove, virtualLocationId } from '../commands/shared.js';

/** `ECART_TRANSFERT` exclu : réservé au mécanisme automatique des transferts. */
export const LOSS_CATEGORIES = [
  'MORTALITE',
  'CASSE',
  'DETERIORATION',
  'IMPROPRE',
  'DESTRUCTION',
  'INEXPLIQUEE',
  'VOL_SUSPECTE',
] as const;
export type LossCategory = (typeof LOSS_CATEGORIES)[number];

/** Propriétaire des pièces d'une déclaration de perte (photos, AV-107). */
export const LOSS_ATTACHMENT_OWNER_TYPE = 'STOCK_LOSS';

export interface DeclareLossInput {
  readonly lossId: string;
  readonly locationId: string;
  readonly productId: string;
  readonly lotId?: string;
  /** Mortalité : lot de production (référence sans clé étrangère) ou lot d'incubation (AV-113). */
  readonly productionLotId?: string;
  readonly incubationBatchId?: string;
  readonly quantityBase: number;
  readonly unitCode: string;
  readonly quantity: number;
  readonly category: LossCategory;
  readonly reasonCodeId?: string;
  readonly comment?: string;
  readonly occurredAt: Date;
  readonly declaredBy: string;
  readonly commandId: string;
  readonly clientCreatedAt: Date | null;
  readonly capturedOffline: boolean;
  readonly backdatedReason: string | null;
  readonly attachmentIds: readonly string[];
  /** Effectif en élevage fourni par l'appelant ; sinon calculé sur `lotId` à `occurred_at`. */
  readonly headcountInRearing?: number;
}

export type DeclareLossResult =
  | {
      readonly ok: true;
      readonly docNumber: string;
      readonly status: 'RECORDED' | 'PENDING_APPROVAL';
      readonly approvalRequestId: string | null;
      readonly lotId: string | null;
      readonly unitCostXaf: number;
      readonly valueXaf: number;
    }
  | { readonly ok: false; readonly outcome: CommandHandlerOutcome };

function rejected(errorCode: string, messageFr: string): DeclareLossResult {
  return { ok: false, outcome: { status: 'REJECTED', errorCode, messageFr } };
}

function thresholdOf(condition: unknown, key: string): number {
  if (condition && typeof condition === 'object' && key in condition) {
    const value = Number((condition as Record<string, unknown>)[key]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return 0;
}

export async function declareLoss(
  uow: UnitOfWork,
  deps: { readonly idGenerator: IdGenerator; readonly documentSequences: DocumentSequenceService },
  input: DeclareLossInput,
): Promise<DeclareLossResult> {
  const isMortality = input.category === 'MORTALITE';
  if (
    (input.category === 'INEXPLIQUEE' || input.category === 'VOL_SUSPECTE') &&
    !input.comment?.trim()
  ) {
    return rejected(
      'COMMENT_REQUIRED',
      'Un commentaire est requis pour les catégories INEXPLIQUEE et VOL_SUSPECTE (D06 §8, dictionnaire).',
    );
  }
  if (isMortality && !input.productionLotId && !input.incubationBatchId) {
    return rejected(
      'LOT_REQUIRED',
      'Une mortalité porte un lot de production ou d’incubation (INV-PRD-03, AV-113).',
    );
  }

  const { siteId, codeSite } = await loadLocationSite(uow, input.locationId);
  const operationType = isMortality ? 'MORTALITY' : 'LOSS_DECLARATION';
  const policy: ActiveControlPolicy | undefined = (
    await currentPolicies(uow, operationType, input.occurredAt)
  )[0];
  let requiresApproval: boolean;
  if (isMortality) {
    if (!policy) {
      return rejected(
        'CONTROL_POLICY_MISSING',
        'Aucune politique de contrôle MORTALITY active (approvals.policy.set) : toute mortalité est validée (AV-048).',
      );
    }
    const headcountInRearing =
      input.headcountInRearing ??
      (input.lotId !== undefined
        ? await lotHeadcount(uow, { lotId: input.lotId, scope: 'REARING', at: input.occurredAt })
        : 0);
    requiresApproval =
      policy.requiresApproval &&
      mortalityRequiresApproval({
        deaths: Math.round(input.quantityBase),
        headcountInRearing,
        thresholds: {
          relativePct: thresholdOf(policy.condition, 'relativePct'),
          absoluteHeads: thresholdOf(policy.condition, 'absoluteHeads'),
        },
      });
  } else {
    // BR-STK-031/032 : sans politique active, pas de validation (valeur par défaut documentée).
    requiresApproval = policy?.requiresApproval ?? false;
  }

  const origin = await loadCommandOrigin(uow, input.commandId);
  const docNumber = await deps.documentSequences.next(uow, {
    docType: 'PRT',
    siteId,
    codeSite,
    year: Number(businessDayOf(input.occurredAt).slice(0, 4)),
  });
  const targetLocationId = await virtualLocationId(
    uow,
    requiresApproval ? 'V_PENDING_LOSS' : 'V_LOSS',
  );
  const moveResult = await tryRecordMove(() =>
    recordStockMove(
      uow,
      { idGenerator: deps.idGenerator },
      {
        productId: input.productId,
        ...(input.lotId !== undefined ? { lotId: input.lotId } : {}),
        quantityBase: input.quantityBase,
        fromLocationId: input.locationId,
        toLocationId: targetLocationId,
        moveType: requiresApproval ? 'LOSS_PENDING' : 'LOSS',
        ...(input.reasonCodeId !== undefined ? { reasonCodeId: input.reasonCodeId } : {}),
        occurredAt: input.occurredAt,
        sourceDocType: 'LOSS',
        sourceDocId: input.lossId,
        createdBy: input.declaredBy,
        ...(origin.deviceId !== null ? { createdDeviceId: origin.deviceId } : {}),
        commandId: input.commandId,
        capturedOffline: input.capturedOffline,
        allowNegative: input.capturedOffline,
      },
    ),
  );
  if (!moveResult.ok) return { ok: false, outcome: moveResult.outcome };

  // Un seul lot capturé sur la ligne si FIFO éclate en plusieurs mouvements (limitation acceptée
  // en P2) ; la valeur perdue est la somme réelle de tous les mouvements.
  const capturedLotId = moveResult.moves[0]?.lotId ?? null;
  const valueXaf = moveResult.moves.reduce((sum, move) => sum + move.valueXaf, 0);
  const unitCostXaf = moveResult.moves[0]?.unitCostXaf ?? 0;

  let approvalRequestId: string | null = null;
  if (requiresApproval && policy) {
    approvalRequestId = deps.idGenerator.newId();
    await requestApproval(uow, {
      requestId: approvalRequestId,
      operationType,
      subjectType: 'STOCK_LOSS',
      subjectId: input.lossId,
      subjectSummary: `${isMortality ? 'Mortalité' : 'Déclaration de perte'} ${docNumber}`,
      siteId,
      amountXaf: valueXaf,
      requestedBy: input.declaredBy,
      requestedAt: input.occurredAt,
      policyId: policy.id,
      policyVersion: policy.version,
      ...(input.attachmentIds.length > 0 ? { requiredAttachmentIds: input.attachmentIds } : {}),
    });
  }

  await uow
    .insertInto('inventory_loss_declarations')
    .values({
      id: toBin(input.lossId),
      doc_number: docNumber,
      site_id: toBin(siteId),
      location_id: toBin(input.locationId),
      product_id: toBin(input.productId),
      lot_id: toBinOrNull(capturedLotId),
      production_lot_id: toBinOrNull(input.productionLotId ?? null),
      incubation_batch_id: toBinOrNull(input.incubationBatchId ?? null),
      quantity_base: String(input.quantityBase),
      unit_code: input.unitCode,
      quantity: String(input.quantity),
      category: input.category,
      reason_code_id: toBinOrNull(input.reasonCodeId ?? null),
      comment: input.comment ?? null,
      declared_by: toBin(input.declaredBy),
      policy_id: policy ? toBin(policy.id) : null,
      policy_version: policy?.version ?? null,
      requires_photo: toDbBool(policy?.requiresPhoto ?? false),
      requires_approval: toDbBool(requiresApproval),
      status: requiresApproval ? 'PENDING_APPROVAL' : 'RECORDED',
      approval_request_id: toBinOrNull(approvalRequestId),
      unit_cost_xaf: unitCostXaf,
      value_xaf: valueXaf,
      occurred_at: input.occurredAt,
      client_created_at: input.clientCreatedAt,
      received_at_server: origin.receivedAt,
      command_id: toBin(input.commandId),
      created_device_id: toBinOrNull(origin.deviceId),
      captured_offline: input.capturedOffline ? 1 : 0,
      clock_suspect: origin.clockSuspect ? 1 : 0,
      backdated_reason: input.backdatedReason,
      created_by: toBin(input.declaredBy),
    })
    .execute();

  return {
    ok: true,
    docNumber,
    status: requiresApproval ? 'PENDING_APPROVAL' : 'RECORDED',
    approvalRequestId,
    lotId: capturedLotId,
    unitCostXaf,
    valueXaf,
  };
}

/**
 * Décisions `LOSS_DECLARATION` et `MORTALITY` (SM-LOSS `PENDING_APPROVAL -> {APPROVED,
 * REJECTED_RETURNED, REJECTED_UNJUSTIFIED}`, BR-STK-033, AV-038 appliquée aussi à la mortalité).
 * `MORTALITY` approuvée exige une photo disponible rattachée à la déclaration quand la politique
 * la demande (AV-107) ; un rejet reste possible sans photo (déclaration erronée).
 */
export function registerLossDecisionHandlers(
  decisionRegistry: ApprovalDecisionHandlerRegistry,
  idGenerator: IdGenerator,
): void {
  for (const operationType of ['LOSS_DECLARATION', 'MORTALITY'] as const) {
    decisionRegistry.register(operationType, async (uow, ctx) => {
      const row = await uow
        .selectFrom('inventory_loss_declarations')
        .select([
          'id',
          'location_id',
          'product_id',
          'lot_id',
          'quantity_base',
          'declared_by',
          'comment',
          'requires_photo',
          'status',
        ])
        .where('id', '=', toBin(ctx.subjectId))
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (row.status !== 'PENDING_APPROVAL') return;
      if (
        operationType === 'MORTALITY' &&
        ctx.decision === 'APPROVED' &&
        row.requires_photo &&
        !(await hasAvailableAttachment(uow, {
          ownerType: LOSS_ATTACHMENT_OWNER_TYPE,
          ownerId: ctx.subjectId,
        }))
      ) {
        throw new ApprovalDecisionRefused(
          'ATTACHMENT_MISSING',
          'Photo de la mortalité non reçue : approbation impossible tant qu’elle n’est pas jointe (AV-107).',
        );
      }
      const deps = { idGenerator };
      const pendingLossLocationId = await virtualLocationId(uow, 'V_PENDING_LOSS');
      const lossLocationId = await virtualLocationId(uow, 'V_LOSS');
      const lotId = fromBinOrNull(row.lot_id);
      const baseMoveInput = {
        productId: fromBin(row.product_id),
        ...(lotId !== null ? { lotId } : {}),
        quantityBase: Number(row.quantity_base),
        occurredAt: ctx.decidedAt,
        sourceDocType: 'LOSS' as const,
        sourceDocId: ctx.subjectId,
        createdBy: ctx.decidedBy,
        capturedOffline: false,
        allowNegative: true,
      };

      if (ctx.decision === 'APPROVED') {
        await recordStockMove(uow, deps, {
          ...baseMoveInput,
          fromLocationId: pendingLossLocationId,
          toLocationId: lossLocationId,
          moveType: 'LOSS_CONFIRMATION',
        });
        await uow
          .updateTable('inventory_loss_declarations')
          .set({
            status: 'APPROVED',
            updated_by: toBin(ctx.decidedBy),
            version: sql`version + 1`,
          })
          .where('id', '=', row.id)
          .execute();
        return;
      }

      // REJETÉ : deux issues portées par `decisionOption` (BR-STK-033, AV-038) ; sans option,
      // ERREUR_DECLARATION (la quantité revient à l'emplacement).
      if (ctx.decisionOption === 'PERTE_NON_JUSTIFIEE') {
        await recordStockMove(uow, deps, {
          ...baseMoveInput,
          fromLocationId: pendingLossLocationId,
          toLocationId: lossLocationId,
          moveType: 'LOSS_CONFIRMATION',
        });
        // ck_inventory_loss_declarations_comment : commentaire non vide pour INEXPLIQUEE.
        const needsComment = !row.comment?.trim();
        await uow
          .updateTable('inventory_loss_declarations')
          .set({
            status: 'REJECTED_UNJUSTIFIED',
            category: 'INEXPLIQUEE',
            responsibility_user_id: row.declared_by,
            ...(needsComment
              ? {
                  comment:
                    'Perte non justifiée : reclassée INEXPLIQUEE lors de la décision (voir la demande de validation pour le motif).',
                }
              : {}),
            updated_by: toBin(ctx.decidedBy),
            version: sql`version + 1`,
          })
          .where('id', '=', row.id)
          .execute();
        return;
      }

      await recordStockMove(uow, deps, {
        ...baseMoveInput,
        fromLocationId: pendingLossLocationId,
        toLocationId: fromBin(row.location_id),
        moveType: 'LOSS_RELEASE',
      });
      await uow
        .updateTable('inventory_loss_declarations')
        .set({
          status: 'REJECTED_RETURNED',
          updated_by: toBin(ctx.decidedBy),
          version: sql`version + 1`,
        })
        .where('id', '=', row.id)
        .execute();
    });
  }
}

/** Mortalité comptée : sortie du stock, validée ou non contestée (hors attente, retour, annulation). */
const COUNTED_LOSS_STATUSES = [
  'RECORDED',
  'APPROVED',
  'REJECTED_UNJUSTIFIED',
  'CANCELLATION_PENDING',
];

export interface LotMortalitySummary {
  /** Déclarations en attente de validation (bloquent la clôture du lot, P7-05). */
  readonly pendingCount: number;
  readonly pendingQuantity: number;
  /** Têtes mortes comptées (indicateurs du lot, BR-PRD-011). */
  readonly countedQuantity: number;
}

/** Mortalités déclarées sur un lot de production ou d'incubation (AV-113). */
export async function lotMortalitySummary(
  executor: Kysely<DB> | Transaction<DB>,
  target: { readonly productionLotId: string } | { readonly incubationBatchId: string },
): Promise<LotMortalitySummary> {
  const rows = await executor
    .selectFrom('inventory_loss_declarations')
    .select([
      'status',
      sql<string>`COUNT(*)`.as('n'),
      sql<string>`COALESCE(SUM(quantity_base), 0)`.as('qty'),
    ])
    .where('category', '=', 'MORTALITE')
    .$if('productionLotId' in target, (qb) =>
      qb.where(
        'production_lot_id',
        '=',
        toBin((target as { productionLotId: string }).productionLotId),
      ),
    )
    .$if('incubationBatchId' in target, (qb) =>
      qb.where(
        'incubation_batch_id',
        '=',
        toBin((target as { incubationBatchId: string }).incubationBatchId),
      ),
    )
    .groupBy('status')
    .execute();
  let pendingCount = 0;
  let pendingQuantity = 0;
  let countedQuantity = 0;
  for (const row of rows) {
    if (row.status === 'PENDING_APPROVAL') {
      pendingCount += Number(row.n);
      pendingQuantity += Number(row.qty);
    } else if (COUNTED_LOSS_STATUSES.includes(row.status)) {
      countedQuantity += Number(row.qty);
    }
  }
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return {
    pendingCount,
    pendingQuantity: round(pendingQuantity),
    countedQuantity: round(countedQuantity),
  };
}

/**
 * Quantité d'un produit sortie d'un lot de stock par des déclarations de perte comptées ou en
 * attente (casse d'œufs en incubateur, P7-08 : pertes accidentelles d'un lot d'incubation,
 * BR-INC-003) ; retours et annulations exclus.
 */
export async function lotLossQuantity(
  executor: Kysely<DB> | Transaction<DB>,
  filter: { readonly lotId: string; readonly productId: string },
): Promise<number> {
  const row = await executor
    .selectFrom('inventory_loss_declarations')
    .select(sql<string>`COALESCE(SUM(quantity_base), 0)`.as('qty'))
    .where('lot_id', '=', toBin(filter.lotId))
    .where('product_id', '=', toBin(filter.productId))
    .where('status', 'in', [...COUNTED_LOSS_STATUSES, 'PENDING_APPROVAL'])
    .executeTakeFirstOrThrow();
  return Math.round(Number(row.qty) * 1000) / 1000;
}

/** Déclaration de perte par identifiant : rejeu d'une commande qui la crée (revue P7). */
export async function findLossDeclaration(
  executor: Kysely<DB> | Transaction<DB>,
  lossId: string,
): Promise<{ readonly docNumber: string; readonly status: string } | undefined> {
  const row = await executor
    .selectFrom('inventory_loss_declarations')
    .select(['doc_number', 'status'])
    .where('id', '=', toBin(lossId))
    .executeTakeFirst();
  return row ? { docNumber: row.doc_number, status: row.status } : undefined;
}
