/**
 * Demandes d'achat (D08-APP ; SM-PURCHASE-REQUEST) : `procurement.request.submit`, `.cancel`,
 * `.close` et la décision `PURCHASE_REQUEST`.
 *
 * - Soumission possible hors ligne (identifiant d'appareil) : lignes de produits achetables,
 *   justification, site bénéficiaire dans le périmètre du demandeur ; numéro `DA` ; montant
 *   estimé informatif (Σ quantité × prix estimé, arrondi au franc).
 * - Toute demande exige une validation, par un approbateur distinct du demandeur (BR-APP-003,
 *   AV-051, AV-010) : sans politique `PURCHASE_REQUEST` active, la soumission est refusée
 *   (`CONTROL_POLICY_MISSING`, même principe que `TRANSFER_DISCREPANCY` en P2 : validation
 *   inconditionnelle, jamais sautée).
 * - Retrait par le demandeur tant qu'elle est soumise ; abandon d'une demande approuvée et
 *   clôture du reste d'une demande partiellement commandée par un valideur, avec motif.
 */
import { z } from 'zod';
import { sql } from 'kysely';
import { lineAmountXaf, xaf, type IdGenerator, businessDayOf } from '@gic/domain';
import type {
  CommandHandler,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { loadCommandOrigin } from '../../../../platform/sync/command-origin.js';
import type { DocumentSequenceService } from '../../../../platform/document-sequences/document-sequence.service.js';
import { fromBin, toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import {
  cancelApprovalRequest,
  requestApproval,
  type ApprovalDecisionHandlerRegistry,
} from '../../../approvals/application/public/index.js';
import {
  CONTROL_POLICY_MISSING,
  DATE_ONLY,
  FORBIDDEN_SCOPE,
  activePolicy,
  baseQuantity,
  domainRejection,
  isAllowed,
  loadSite,
  nonPurchasableProducts,
  rejected,
  unknownUnits,
  type Uow,
} from './shared.js';
import { emitPurchaseRequestChange } from '../sync-changes.js';

const lineSchema = z.object({
  productId: z.string().uuid(),
  quantityBase: z.number().positive(),
  unitCode: z.string().min(1).max(20),
  quantity: z.number().positive(),
  estimatedUnitPriceXaf: z.number().int().nonnegative().optional(),
  notes: z.string().trim().max(2000).optional(),
});

const submitPayloadSchema = z.object({
  siteId: z.string().uuid(),
  neededByDate: z.string().regex(DATE_ONLY).optional(),
  justification: z.string().trim().min(1).max(4000),
  lines: z.array(lineSchema).min(1).max(100),
  localRef: z.string().trim().min(1).max(20).optional(),
});
type SubmitPayload = z.infer<typeof submitPayloadSchema>;

const reasonPayloadSchema = z.object({ reason: z.string().trim().min(1).max(2000).optional() });
type ReasonPayload = z.infer<typeof reasonPayloadSchema>;

const NOT_FOUND = rejected('NOT_FOUND', "Demande d'achat introuvable.");
const statusInvalid = (expected: string) =>
  rejected('REQUEST_STATUS_INVALID', `La demande d'achat doit être au statut ${expected}.`);
const REASON_REQUIRED = rejected('REASON_REQUIRED', 'Un motif est requis.');

async function lockRequest(uow: Uow, requestId: string) {
  return uow
    .selectFrom('procurement_purchase_requests')
    .select(['id', 'site_id', 'requested_by', 'status', 'approval_request_id', 'doc_number'])
    .where('id', '=', toBin(requestId))
    .forUpdate()
    .executeTakeFirst();
}

function buildHandlers(idGenerator: IdGenerator, documentSequences: DocumentSequenceService) {
  const submit: CommandHandler<SubmitPayload> = async (uow, envelope) => {
    const requestId = envelope.aggregate_id;
    const replay = await uow
      .selectFrom('procurement_purchase_requests')
      .select('id')
      .where('id', '=', toBin(requestId))
      .executeTakeFirst();
    if (replay) return { status: 'APPLIED' };

    const p = envelope.payload;
    const author = envelope.author_user_id;
    const at = new Date(envelope.occurred_at);
    const site = await loadSite(uow, p.siteId);
    if (!site || !site.isActive) {
      return rejected('REFERENCE_INVALID', 'Site bénéficiaire inconnu ou fermé.');
    }
    if (
      !(await isAllowed(uow, author, 'procurement.request.create', at, {
        siteId: site.id,
        ownerUserId: author,
      }))
    ) {
      return FORBIDDEN_SCOPE;
    }
    const refused = await nonPurchasableProducts(
      uow,
      p.lines.map((line) => line.productId),
    );
    if (refused.length > 0) {
      return rejected(
        'PRODUCT_NOT_PURCHASABLE',
        `Produit inconnu, inactif ou non achetable : ${refused.join(', ')}.`,
      );
    }
    const units = await unknownUnits(
      uow,
      p.lines.map((line) => line.unitCode),
    );
    if (units.length > 0)
      return rejected('REFERENCE_INVALID', `Unité inconnue : ${units.join(', ')}.`);
    let estimatedTotal = 0;
    try {
      for (const line of p.lines) {
        baseQuantity(line.quantity);
        const quantity = baseQuantity(line.quantityBase);
        if (line.estimatedUnitPriceXaf !== undefined) {
          estimatedTotal += lineAmountXaf(quantity, xaf(line.estimatedUnitPriceXaf));
        }
      }
    } catch (error) {
      return domainRejection(error);
    }
    const policy = await activePolicy(uow, 'PURCHASE_REQUEST', at);
    if (!policy) return CONTROL_POLICY_MISSING('PURCHASE_REQUEST');

    const origin = await loadCommandOrigin(uow, envelope.command_id);
    const docNumber = await documentSequences.next(uow, {
      docType: 'DA',
      siteId: site.id,
      codeSite: site.code,
      year: Number(businessDayOf(at).slice(0, 4)),
    });
    // BR-APP-003 : validation obligatoire, par un approbateur distinct du demandeur (BR-ADM-017).
    const approvalRequestId = idGenerator.newId();
    await requestApproval(uow, {
      requestId: approvalRequestId,
      operationType: 'PURCHASE_REQUEST',
      subjectType: 'PURCHASE_REQUEST',
      subjectId: requestId,
      subjectSummary: `Demande d'achat ${docNumber}`,
      siteId: site.id,
      amountXaf: estimatedTotal,
      requestedBy: author,
      requestedAt: at,
      policyId: policy.id,
      policyVersion: policy.version,
    });
    await uow
      .insertInto('procurement_purchase_requests')
      .values({
        id: toBin(requestId),
        doc_number: docNumber,
        local_ref: p.localRef ?? null,
        site_id: toBin(site.id),
        requested_by: toBin(author),
        needed_by_date: p.neededByDate ? sql<Date>`${p.neededByDate}` : null,
        justification: p.justification,
        estimated_total_xaf: estimatedTotal,
        status: 'SUBMITTED',
        approval_request_id: toBin(approvalRequestId),
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
    for (const line of p.lines) {
      await uow
        .insertInto('procurement_purchase_request_lines')
        .values({
          id: toBin(idGenerator.newId()),
          request_id: toBin(requestId),
          product_id: toBin(line.productId),
          quantity_base: String(line.quantityBase),
          unit_code: line.unitCode,
          quantity: String(line.quantity),
          estimated_unit_price_xaf: line.estimatedUnitPriceXaf ?? null,
          notes: line.notes ?? null,
        })
        .execute();
    }
    await emitPurchaseRequestChange(uow, requestId);
    return { status: 'APPLIED', serverRefs: { docNumber } };
  };

  /** Retrait (demandeur, `SUBMITTED`) ou abandon (valideur, `APPROVED`, motif). */
  const cancel: CommandHandler<ReasonPayload> = async (uow, envelope) => {
    const request = await lockRequest(uow, envelope.aggregate_id);
    if (!request) return NOT_FOUND;
    const author = envelope.author_user_id;
    const at = new Date(envelope.occurred_at);
    if (request.status === 'SUBMITTED') {
      if (fromBin(request.requested_by) !== author) {
        return rejected('FORBIDDEN', 'Seul le demandeur peut retirer sa demande soumise.');
      }
      if (request.approval_request_id) {
        await cancelApprovalRequest(uow, {
          requestId: fromBin(request.approval_request_id),
          cancelledBy: author,
        });
      }
    } else if (request.status === 'APPROVED') {
      if (!envelope.payload.reason) return REASON_REQUIRED;
      if (
        !(await isAllowed(uow, author, 'procurement.request.approve', at, {
          siteId: fromBin(request.site_id),
        }))
      ) {
        return rejected('FORBIDDEN', "Abandon d'une demande approuvée réservé à un valideur.");
      }
    } else {
      return statusInvalid('SUBMITTED ou APPROVED');
    }
    await uow
      .updateTable('procurement_purchase_requests')
      .set({ status: 'CANCELLED', updated_by: toBin(author), version: sql`version + 1` })
      .where('id', '=', request.id)
      .execute();
    await emitPurchaseRequestChange(uow, envelope.aggregate_id);
    return {
      status: 'APPLIED',
      audit: {
        before: { status: request.status },
        after: { status: 'CANCELLED', reason: envelope.payload.reason ?? null },
      },
    };
  };

  /** Clôture du reste d'une demande partiellement commandée (SM-PURCHASE-REQUEST, motif). */
  const close: CommandHandler<ReasonPayload> = async (uow, envelope) => {
    const request = await lockRequest(uow, envelope.aggregate_id);
    if (!request) return NOT_FOUND;
    if (request.status !== 'PARTIALLY_ORDERED') return statusInvalid('PARTIALLY_ORDERED');
    if (!envelope.payload.reason) return REASON_REQUIRED;
    const at = new Date(envelope.occurred_at);
    if (
      !(await isAllowed(uow, envelope.author_user_id, 'procurement.request.approve', at, {
        siteId: fromBin(request.site_id),
      }))
    ) {
      return FORBIDDEN_SCOPE;
    }
    await uow
      .updateTable('procurement_purchase_requests')
      .set({
        status: 'CLOSED',
        updated_by: toBin(envelope.author_user_id),
        version: sql`version + 1`,
      })
      .where('id', '=', request.id)
      .execute();
    await emitPurchaseRequestChange(uow, envelope.aggregate_id);
    return {
      status: 'APPLIED',
      audit: {
        before: { status: request.status },
        after: { status: 'CLOSED', reason: envelope.payload.reason },
      },
    };
  };

  return { submit, cancel, close };
}

/** Décision `PURCHASE_REQUEST` (SM-PURCHASE-REQUEST : `SUBMITTED → APPROVED | REJECTED`). */
function registerRequestDecision(decisionRegistry: ApprovalDecisionHandlerRegistry): void {
  decisionRegistry.register('PURCHASE_REQUEST', async (uow, ctx) => {
    const request = await lockRequest(uow, ctx.subjectId);
    if (!request || request.status !== 'SUBMITTED') return;
    await uow
      .updateTable('procurement_purchase_requests')
      .set({
        status: ctx.decision === 'APPROVED' ? 'APPROVED' : 'REJECTED',
        updated_by: toBin(ctx.decidedBy),
        version: sql`version + 1`,
      })
      .where('id', '=', request.id)
      .execute();
    await emitPurchaseRequestChange(uow, ctx.subjectId);
  });
}

export function registerRequestCommands(
  registry: CommandHandlerRegistry,
  decisionRegistry: ApprovalDecisionHandlerRegistry,
  idGenerator: IdGenerator,
  documentSequences: DocumentSequenceService,
): void {
  const handlers = buildHandlers(idGenerator, documentSequences);
  registry.register({
    commandType: 'procurement.request.submit',
    version: 1,
    payloadSchema: submitPayloadSchema,
    permissionCode: 'procurement.request.create',
    handler: handlers.submit,
  });
  registry.register({
    commandType: 'procurement.request.cancel',
    version: 1,
    payloadSchema: reasonPayloadSchema,
    permissionCode: 'procurement.request.create',
    handler: handlers.cancel,
  });
  registry.register({
    commandType: 'procurement.request.close',
    version: 1,
    payloadSchema: reasonPayloadSchema,
    permissionCode: 'procurement.request.approve',
    handler: handlers.close,
  });
  registerRequestDecision(decisionRegistry);
}
