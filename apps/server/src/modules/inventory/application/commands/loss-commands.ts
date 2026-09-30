/**
 * `inventory.loss.{declare,withdraw}` (SM-LOSS, `docs/04-workflows/machines-a-etats/
 * 03-stock.md`) + les gestionnaires de décision `LOSS_DECLARATION` et `MORTALITY`. Depuis P7-02,
 * la déclaration et les décisions vivent dans l'API publique (`public/loss-declaration.ts`),
 * partagée avec `production.mortality.record`. Portée de
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
import { toBin, fromBin, fromBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import { emitLotLossChange } from '../sync-changes.js';
import { DocumentSequenceService } from '../../../../platform/document-sequences/document-sequence.service.js';
import {
  cancelApprovalRequest,
  type ApprovalDecisionHandlerRegistry,
} from '../../../approvals/application/public/index.js';
import { recordStockMove, type RecordMoveDeps } from '../public/record-move.js';
import {
  LOSS_CATEGORIES,
  declareLoss,
  registerLossDecisionHandlers,
} from '../public/loss-declaration.js';
import { virtualLocationId, tryRecordMove } from './shared.js';

const declarePayloadSchema = z
  .object({
    locationId: z.string().uuid(),
    productId: z.string().uuid(),
    lotId: z.string().uuid().optional(),
    /** Réf. sans FK (dictionnaire) : lot de production, ou lot d'incubation (AV-113). */
    productionLotId: z.string().uuid().optional(),
    incubationBatchId: z.string().uuid().optional(),
    quantityBase: z.number().positive(),
    unitCode: z.string().min(1).max(20),
    quantity: z.number().positive(),
    category: z.enum(LOSS_CATEGORIES),
    reasonCodeId: z.string().uuid().optional(),
    comment: z.string().max(2000).optional(),
  })
  .superRefine((data, ctx) => {
    // Commentaire requis pour INEXPLIQUEE/VOL_SUSPECTE : contrôlé par le gestionnaire, qui
    // renvoie le code documenté `COMMENT_REQUIRED` (D06 §8), pas un VALIDATION_ERROR générique.
    if (
      data.category === 'MORTALITE' &&
      data.productionLotId === undefined &&
      data.incubationBatchId === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'productionLotId ou incubationBatchId est requis pour la catégorie MORTALITE (CK, dictionnaire).',
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
    const p = envelope.payload;
    const result = await declareLoss(
      uow,
      { idGenerator, documentSequences },
      {
        lossId: envelope.aggregate_id,
        locationId: p.locationId,
        productId: p.productId,
        ...(p.lotId !== undefined ? { lotId: p.lotId } : {}),
        ...(p.productionLotId !== undefined ? { productionLotId: p.productionLotId } : {}),
        ...(p.incubationBatchId !== undefined ? { incubationBatchId: p.incubationBatchId } : {}),
        quantityBase: p.quantityBase,
        unitCode: p.unitCode,
        quantity: p.quantity,
        category: p.category,
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
    return { status: 'APPLIED', serverRefs: { docNumber: result.docNumber } };
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
    await emitLotLossChange(uow, envelope.payload.lossId);
    return { status: 'APPLIED' };
  };

  return { declare, withdraw };
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
  registerLossDecisionHandlers(decisionRegistry, idGenerator);
}
