/**
 * `inventory.loss.{declare,withdraw}` (SM-LOSS, `docs/04-workflows/machines-a-etats/
 * 03-stock.md`) + le gestionnaire de décision d'approbation `LOSS_DECLARATION`. Portée de
 * P2-04 : déclaration, retrait avant décision, et les deux issues de rejet documentées
 * (BR-STK-033, AV-038). Hors périmètre, documenté et non simulé :
 * `inventory.loss.request_cancellation` (transition `RECORDED -> CANCELLATION_PENDING`) —
 * exigerait d'ajouter `LOSS_CANCELLATION` au catalogue fermé `OPERATION_TYPES` (et les deux
 * `CHECK` associés en migration) ; laissé de côté faute de besoin réel actuel, pas oublié.
 *
 * Contrairement à `TRANSFER_DISCREPANCY` (transfer-commands.ts), l'absence de politique
 * active pour `LOSS_DECLARATION` n'est **jamais** un rejet : c'est la valeur par défaut
 * documentée par BR-STK-032 (« pas de validation requise » ⇒ `RECORDED` direct). AV-037
 * (seuils de preuve/validation par catégorie et montant) reste `OUVERT` — ce fichier ne lit
 * que `requiresApproval`/`requiresPhoto` de la politique trouvée (comme `currentPolicies`
 * le permet déjà), jamais `condition` : la granularité par catégorie/montant est un point
 * non couvert par cette session, pas un oubli silencieux (CLAUDE.md règle 2).
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
import { toDbBool } from '../../../../platform/kysely/bool-column.js';
import { DocumentSequenceService } from '../../../../platform/document-sequences/document-sequence.service.js';
import {
  requestApproval,
  cancelApprovalRequest,
  currentPolicies,
  type ApprovalDecisionHandlerRegistry,
} from '../../../approvals/application/public/index.js';
import { recordStockMove, type RecordMoveDeps } from '../public/record-move.js';
import { loadCommandOrigin, loadLocationSite, virtualLocationId, tryRecordMove } from './shared.js';

// `ECART_TRANSFERT` exclu : catégorie réservée au mécanisme automatique de
// `transfer-commands.ts`, jamais saisie manuellement par un déclarant.
const LOSS_CATEGORIES = [
  'MORTALITE',
  'CASSE',
  'DETERIORATION',
  'IMPROPRE',
  'DESTRUCTION',
  'INEXPLIQUEE',
  'VOL_SUSPECTE',
] as const;

const declarePayloadSchema = z
  .object({
    locationId: z.string().uuid(),
    productId: z.string().uuid(),
    lotId: z.string().uuid().optional(),
    /** Réf. sans FK (dictionnaire) : la table `production` propriétaire n'existe pas encore (P7). */
    productionLotId: z.string().uuid().optional(),
    quantityBase: z.number().positive(),
    unitCode: z.string().min(1).max(20),
    quantity: z.number().positive(),
    category: z.enum(LOSS_CATEGORIES),
    reasonCodeId: z.string().uuid().optional(),
    comment: z.string().max(2000).optional(),
  })
  .superRefine((data, ctx) => {
    if (
      (data.category === 'INEXPLIQUEE' || data.category === 'VOL_SUSPECTE') &&
      !data.comment?.trim()
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Un commentaire est requis pour les catégories INEXPLIQUEE et VOL_SUSPECTE (CK, dictionnaire).',
      });
    }
    if (data.category === 'MORTALITE' && data.productionLotId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'productionLotId est requis pour la catégorie MORTALITE (CK, dictionnaire).',
      });
    }
  });
type DeclarePayload = z.infer<typeof declarePayloadSchema>;

const withdrawPayloadSchema = z.object({ lossId: z.string().uuid() });
type WithdrawPayload = z.infer<typeof withdrawPayloadSchema>;

function notFound(): CommandHandlerOutcome {
  return {
    status: 'REJECTED',
    errorCode: 'NOT_FOUND',
    messageFr: 'Déclaration de perte introuvable.',
  };
}
function badStatus(expected: string): CommandHandlerOutcome {
  return {
    status: 'REJECTED',
    errorCode: 'LOSS_STATUS_INVALID',
    messageFr: `La déclaration doit être au statut ${expected}.`,
  };
}

function buildLossCommands(
  idGenerator: IdGenerator,
  documentSequences: DocumentSequenceService,
): {
  declare: CommandHandler<DeclarePayload>;
  withdraw: CommandHandler<WithdrawPayload>;
} {
  const deps: RecordMoveDeps = { idGenerator };

  const declare: CommandHandler<DeclarePayload> = async (uow, envelope) => {
    const {
      locationId,
      productId,
      lotId,
      productionLotId,
      quantityBase,
      unitCode,
      quantity,
      category,
      reasonCodeId,
      comment,
    } = envelope.payload;
    const occurredAt = new Date(envelope.occurred_at);
    const { siteId, codeSite } = await loadLocationSite(uow, locationId);
    const origin = await loadCommandOrigin(uow, envelope.command_id);
    const docNumber = await documentSequences.next(uow, {
      docType: 'PRT',
      siteId,
      codeSite,
      year: occurredAt.getUTCFullYear(),
    });
    const lossId = envelope.aggregate_id;

    // BR-STK-031/032 : la politique en vigueur décide RECORDED (pas de validation, valeur par
    // défaut) ou PENDING_APPROVAL — jamais de rejet pour politique absente (contrairement à
    // TRANSFER_DISCREPANCY, §5 transfer-commands.ts).
    const policies = await currentPolicies(uow, 'LOSS_DECLARATION', occurredAt);
    const policy = policies[0];
    const requiresApproval = policy?.requiresApproval ?? false;

    const targetLocationId = await virtualLocationId(
      uow,
      requiresApproval ? 'V_PENDING_LOSS' : 'V_LOSS',
    );
    const moveResult = await tryRecordMove(() =>
      recordStockMove(uow, deps, {
        productId,
        ...(lotId !== undefined ? { lotId } : {}),
        quantityBase,
        fromLocationId: locationId,
        toLocationId: targetLocationId,
        moveType: requiresApproval ? 'LOSS_PENDING' : 'LOSS',
        ...(reasonCodeId !== undefined ? { reasonCodeId } : {}),
        occurredAt,
        sourceDocType: 'LOSS',
        sourceDocId: lossId,
        createdBy: envelope.author_user_id,
        ...(origin.deviceId !== null ? { createdDeviceId: origin.deviceId } : {}),
        commandId: envelope.command_id,
        capturedOffline: envelope.captured_offline,
        allowNegative: envelope.captured_offline,
      }),
    );
    if (!moveResult.ok) return moveResult.outcome;

    // Un seul lot capturé sur la ligne si FIFO éclate en plusieurs mouvements (limitation déjà
    // acceptée pour les transferts, §5 transfer-commands.ts) ; la valeur perdue, elle, est
    // toujours la somme réelle de tous les mouvements produits.
    const capturedLotId = moveResult.moves[0]?.lotId ?? null;
    const totalValueXaf = moveResult.moves.reduce((sum, move) => sum + move.valueXaf, 0);
    const unitCostXaf = moveResult.moves[0]?.unitCostXaf ?? 0;

    let approvalRequestId: string | null = null;
    if (requiresApproval && policy) {
      approvalRequestId = idGenerator.newId();
      await requestApproval(uow, {
        requestId: approvalRequestId,
        operationType: 'LOSS_DECLARATION',
        subjectType: 'STOCK_LOSS',
        subjectId: lossId,
        subjectSummary: `Déclaration de perte ${docNumber}`,
        siteId,
        amountXaf: totalValueXaf,
        requestedBy: envelope.author_user_id,
        requestedAt: occurredAt,
        policyId: policy.id,
        policyVersion: policy.version,
      });
    }

    await uow
      .insertInto('inventory_loss_declarations')
      .values({
        id: toBin(lossId),
        doc_number: docNumber,
        site_id: toBin(siteId),
        location_id: toBin(locationId),
        product_id: toBin(productId),
        lot_id: toBinOrNull(capturedLotId),
        production_lot_id: toBinOrNull(productionLotId ?? null),
        quantity_base: String(quantityBase),
        unit_code: unitCode,
        quantity: String(quantity),
        category,
        reason_code_id: toBinOrNull(reasonCodeId ?? null),
        comment: comment ?? null,
        declared_by: toBin(envelope.author_user_id),
        policy_id: policy ? toBin(policy.id) : null,
        policy_version: policy?.version ?? null,
        requires_photo: toDbBool(policy?.requiresPhoto ?? false),
        requires_approval: toDbBool(requiresApproval),
        status: requiresApproval ? 'PENDING_APPROVAL' : 'RECORDED',
        approval_request_id: toBinOrNull(approvalRequestId),
        unit_cost_xaf: unitCostXaf,
        value_xaf: totalValueXaf,
        occurred_at: occurredAt,
        client_created_at: new Date(envelope.client_created_at),
        command_id: toBin(envelope.command_id),
        created_device_id: toBinOrNull(origin.deviceId),
        captured_offline: envelope.captured_offline ? 1 : 0,
        backdated_reason: envelope.backdated_reason,
        created_by: toBin(envelope.author_user_id),
      })
      .execute();

    return { status: 'APPLIED' };
  };

  const withdraw: CommandHandler<WithdrawPayload> = async (uow, envelope) => {
    const row = await uow
      .selectFrom('inventory_loss_declarations')
      .select([
        'id',
        'status',
        'declared_by',
        'location_id',
        'product_id',
        'lot_id',
        'quantity_base',
        'approval_request_id',
      ])
      .where('id', '=', toBin(envelope.payload.lossId))
      .executeTakeFirst();
    if (!row) return notFound();
    if (row.status !== 'PENDING_APPROVAL') return badStatus('PENDING_APPROVAL');
    if (fromBinOrNull(row.declared_by) !== envelope.author_user_id) {
      return {
        status: 'REJECTED',
        errorCode: 'FORBIDDEN',
        messageFr: 'Seul le déclarant peut retirer sa demande.',
      };
    }

    const occurredAt = new Date(envelope.occurred_at);
    const pendingLossLocationId = await virtualLocationId(uow, 'V_PENDING_LOSS');
    const lotId = fromBinOrNull(row.lot_id);
    const moveResult = await tryRecordMove(() =>
      recordStockMove(uow, deps, {
        productId: fromBin(row.product_id),
        ...(lotId !== null ? { lotId } : {}),
        quantityBase: Number(row.quantity_base),
        fromLocationId: pendingLossLocationId,
        toLocationId: fromBin(row.location_id),
        moveType: 'LOSS_RELEASE',
        occurredAt,
        sourceDocType: 'LOSS',
        sourceDocId: envelope.payload.lossId,
        createdBy: envelope.author_user_id,
        commandId: envelope.command_id,
        capturedOffline: envelope.captured_offline,
        allowNegative: true,
      }),
    );
    if (!moveResult.ok) return moveResult.outcome;

    // `requestApproval` a garanti `approval_request_id` non nul pour atteindre PENDING_APPROVAL.
    await cancelApprovalRequest(uow, {
      requestId: fromBin(row.approval_request_id!),
      cancelledBy: envelope.author_user_id,
    });

    await uow
      .updateTable('inventory_loss_declarations')
      .set({
        status: 'CANCELLED',
        updated_by: toBin(envelope.author_user_id),
        version: sql`version + 1`,
      })
      .where('id', '=', row.id)
      .execute();
    return { status: 'APPLIED' };
  };

  return { declare, withdraw };
}

/** Décision `LOSS_DECLARATION` (SM-LOSS `PENDING_APPROVAL -> {APPROVED, REJECTED_RETURNED,
 * REJECTED_UNJUSTIFIED}`, BR-STK-033/AV-038). */
function registerLossDeclarationDecisionHandler(
  decisionRegistry: ApprovalDecisionHandlerRegistry,
  idGenerator: IdGenerator,
): void {
  decisionRegistry.register('LOSS_DECLARATION', async (uow, ctx) => {
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
      ])
      .where('id', '=', toBin(ctx.subjectId))
      .executeTakeFirstOrThrow();
    const deps: RecordMoveDeps = { idGenerator };
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
        .set({ status: 'APPROVED', updated_by: toBin(ctx.decidedBy), version: sql`version + 1` })
        .where('id', '=', row.id)
        .execute();
      return;
    }

    // REJETÉ : deux issues distinctes portées par `decisionOption` (BR-STK-033, AV-038).
    // Absence de `decisionOption` -> ERREUR_DECLARATION (repli le moins pénalisant pour le
    // déclarant, DÉDUIT ; AV-038 reste OUVERT sur le traitement du rejet en général).
    if (ctx.decisionOption === 'PERTE_NON_JUSTIFIEE') {
      await recordStockMove(uow, deps, {
        ...baseMoveInput,
        fromLocationId: pendingLossLocationId,
        toLocationId: lossLocationId,
        moveType: 'LOSS_CONFIRMATION',
      });
      // ck_inventory_loss_declarations_comment exige un commentaire non vide pour la
      // catégorie INEXPLIQUEE : si la déclaration d'origine n'en portait pas (catégorie qui ne
      // l'exigeait pas), on en fournit un — le commentaire de décision (obligatoire au rejet,
      // request-commands.ts) reste la trace complète du motif, dans `decision_comment`.
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

export function registerLossCommands(
  registry: CommandHandlerRegistry,
  decisionRegistry: ApprovalDecisionHandlerRegistry,
  idGenerator: IdGenerator,
  documentSequences: DocumentSequenceService,
): void {
  const handlers = buildLossCommands(idGenerator, documentSequences);
  registry.register({
    commandType: 'inventory.loss.declare',
    version: 1,
    payloadSchema: declarePayloadSchema,
    permissionCode: 'inventory.loss.declare',
    handler: handlers.declare,
  });
  registry.register({
    commandType: 'inventory.loss.withdraw',
    version: 1,
    payloadSchema: withdrawPayloadSchema,
    permissionCode: 'inventory.loss.declare',
    handler: handlers.withdraw,
  });
  registerLossDeclarationDecisionHandler(decisionRegistry, idGenerator);
}
