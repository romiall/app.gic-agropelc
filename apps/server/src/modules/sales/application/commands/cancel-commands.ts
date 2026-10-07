/**
 * Annulation d'une vente (D04 UC-VEN-07, UC-VEN-08 ; BR-VEN-027, BR-VEN-028 ; AV-030 ; SM-SALE) :
 *
 * - `sales.sale.cancel` : annulation **directe** par le vendeur de la vente, au plus
 *   `sales.direct_cancel_minutes` (15) après l'heure de la vente (la condition « caisse ouverte »
 *   est réputée remplie jusqu'aux sessions de caisse, P5). Hors délai ou par une autre personne
 *   autorisée, elle est **transformée en demande** (avertissement `CANCEL_WINDOW_EXCEEDED`, matrice
 *   des conflits) ;
 * - `sales.sale.request_cancellation` : demande soumise à validation `SALE_CANCELLATION`
 *   (la vente passe `CANCELLATION_REQUESTED`) ; l'approbateur choisit le sort de l'argent payé
 *   (`decisionOption` : `REFUND` ou `CUSTOMER_CREDIT`, AV-146) ; un rejet remet la vente `CONFIRMED`.
 *
 * Une annulation, directe ou décidée, est un document `ANV` : voir `sale-cancellation.ts` pour son
 * effet (stock, chiffre d'affaires à l'heure d'application, paiements libérés, conversion du prospect).
 * La validation hors ligne n'est jamais rejetée pour un état métier : la demande se crée toujours.
 */
import { z } from 'zod';
import { withinCancellationWindow, type IdGenerator } from '@gic/domain';
import type {
  CommandHandler,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { loadCommandOrigin } from '../../../../platform/sync/command-origin.js';
import type { DocumentSequenceService } from '../../../../platform/document-sequences/document-sequence.service.js';
import { fromBin, toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import {
  ApprovalDecisionRefused,
  requestApproval,
  type ApprovalDecisionHandlerRegistry,
} from '../../../approvals/application/public/index.js';
import { findReasonCode } from '../../../catalog/application/public/index.js';
import { evaluateAccess } from '../../../identity/application/public/index.js';
import {
  CONTROL_POLICY_MISSING,
  FORBIDDEN_SCOPE,
  activePolicy,
  businessRejection,
  documentYear,
  loadSite,
  numberSetting,
  rejected,
  type Uow,
} from './shared.js';
import {
  PAYMENT_TREATMENTS,
  applyCancellation,
  lockSale,
  planFullCancellation,
  type CancellationLine,
  type PaymentTreatment,
} from './sale-cancellation.js';
import { lockOrderOfSale, syncOrderAfterSaleCancellation } from './order-adjust.js';
import {
  withSalesChanges,
  withSalesDecisionChanges,
  type SalesDecisionRegistry,
} from '../sync-changes.js';

const cancelPayloadSchema = z.object({
  saleId: z.string().uuid(),
  reasonCodeId: z.string().uuid().optional(),
  comment: z.string().trim().min(1).max(2000).optional(),
  /** Sort de l'argent payé libéré : exigé pour l'annulation directe d'une vente en partie payée. */
  paymentTreatment: z.enum(['REFUND', 'CUSTOMER_CREDIT']).optional(),
});
type CancelPayload = z.infer<typeof cancelPayloadSchema>;

const NOT_FOUND = rejected('NOT_FOUND', 'Vente introuvable.');

function buildHandlers(idGenerator: IdGenerator, documentSequences: DocumentSequenceService) {
  const deps = { idGenerator };

  /** `directAllowed` : `sales.sale.cancel` tente d'abord l'annulation directe. */
  const start =
    (directAllowed: boolean): CommandHandler<CancelPayload> =>
    async (uow, envelope) => {
      const cancellationId = envelope.aggregate_id;
      const replay = await uow
        .selectFrom('sales_sale_cancellations')
        .select('doc_number')
        .where('id', '=', toBin(cancellationId))
        .executeTakeFirst();
      if (replay) return { status: 'APPLIED', serverRefs: { docNumber: replay.doc_number } };
      try {
        return await startCancellation(uow, envelope, cancellationId, directAllowed);
      } catch (error) {
        return businessRejection(error);
      }
    };

  async function startCancellation(
    uow: Uow,
    envelope: Parameters<CommandHandler<CancelPayload>>[1],
    cancellationId: string,
    directAllowed: boolean,
  ): ReturnType<CommandHandler<CancelPayload>> {
    const p = envelope.payload;
    const author = envelope.author_user_id;
    const at = new Date(envelope.occurred_at);
    const offline = envelope.captured_offline;
    const origin = await loadCommandOrigin(uow, envelope.command_id);

    // Ordre de verrous commun : la commande d'une vente sur commande avant la vente (order-adjust.ts).
    await lockOrderOfSale(uow, p.saleId);
    const locked = await lockSale(uow, p.saleId);
    if (!locked) return NOT_FOUND;
    const { sale } = locked;
    const site = await loadSite(uow, fromBin(sale.site_id));
    if (!site) return rejected('REFERENCE_INVALID', 'Site de la vente inconnu.');
    const sellerId = fromBin(sale.seller_user_id);
    const commercialId = sale.commercial_user_id ? fromBin(sale.commercial_user_id) : null;
    const access = await evaluateAccess(uow, {
      userId: author,
      permissionCode: 'sales.sale.cancel',
      occurredAt: at,
      resource: {
        ownerUserId: author === commercialId ? commercialId : sellerId,
        siteId: site.id,
        zoneId: fromBin(sale.zone_id),
      },
    });
    if (!access.allowed) return FORBIDDEN_SCOPE;
    if (sale.status === 'CANCELLED') {
      return rejected('SALE_ALREADY_CANCELLED', 'Cette vente est déjà annulée.');
    }
    if (sale.status !== 'CONFIRMED') {
      return rejected('SALE_STATUS_INVALID', 'Une demande d’annulation est déjà en cours.');
    }
    if (p.reasonCodeId !== undefined && !(await findReasonCode(uow, p.reasonCodeId))) {
      return rejected('REFERENCE_INVALID', 'Motif d’annulation inconnu.');
    }

    const plan = planFullCancellation(idGenerator, locked);
    if (!plan.ok) return plan.outcome;
    const saleOccurredAt = sale.occurred_at;
    const windowMinutes = await numberSetting(uow, 'sales.direct_cancel_minutes', at, 15);
    const direct =
      directAllowed &&
      author === sellerId &&
      withinCancellationWindow({ saleOccurredAt, cancelAt: at, windowMinutes });

    const docNumber = await documentSequences.next(uow, {
      docType: 'ANV',
      siteId: site.id,
      codeSite: site.code,
      year: documentYear(at),
    });
    const baseDoc = {
      id: toBin(cancellationId),
      doc_number: docNumber,
      site_id: toBin(site.id),
      sale_id: sale.id,
      // Commande de la vente, dénormalisée ; nulle pour une vente directe (dictionnaire 05-sales).
      order_id: sale.order_id,
      cause: 'SALE_CANCELLATION',
      reason_code_id: toBinOrNull(p.reasonCodeId ?? null),
      comment: p.comment ?? null,
      requested_by: toBin(author),
      cancelled_total_xaf: plan.totalXaf,
      occurred_at: at,
      client_created_at: new Date(envelope.client_created_at),
      received_at_server: origin.receivedAt,
      command_id: toBin(envelope.command_id),
      created_device_id: toBinOrNull(origin.deviceId),
      captured_offline: offline ? (1 as const) : (0 as const),
      clock_suspect: origin.clockSuspect ? (1 as const) : (0 as const),
      backdated_reason: envelope.backdated_reason,
      created_by: toBin(author),
    };
    const insertLines = async (lines: readonly CancellationLine[]) => {
      for (const line of lines) {
        await uow
          .insertInto('sales_sale_cancellation_lines')
          .values({
            id: toBin(line.id),
            cancellation_id: toBin(cancellationId),
            sale_line_id: toBin(line.saleLineId),
            quantity_base: String(line.quantityBase),
            amount_xaf: line.amountXaf,
          })
          .execute();
      }
    };

    if (direct) {
      const applied = await applyCancellation(uow, deps, {
        cancellationId,
        locked,
        lines: plan.lines,
        appliedAt: at,
        treatment: p.paymentTreatment ?? null,
        actorUserId: author,
        deviceId: origin.deviceId,
        commandId: envelope.command_id,
        offline,
        siteId: site.id,
      });
      if (!applied.ok) return applied.outcome;
      await uow
        .insertInto('sales_sale_cancellations')
        .values({
          ...baseDoc,
          status: 'APPLIED',
          applied_at: at,
          released_payment_treatment: applied.treatment,
        })
        .execute();
      await insertLines(plan.lines);
      const order = await syncOrderAfterSaleCancellation(uow, deps, {
        locked,
        lines: plan.lines,
        at,
        actorUserId: author,
        reasonCodeId: p.reasonCodeId ?? null,
        comment: p.comment ?? null,
        treatment: applied.treatment ?? p.paymentTreatment ?? null,
        deviceId: origin.deviceId,
        commandId: envelope.command_id,
        offline,
      });
      if (!order.ok) return order.outcome;
      return { status: 'APPLIED', serverRefs: { docNumber } };
    }

    // Demande soumise à validation (hors délai, ou demande explicite).
    const policy = await activePolicy(
      uow,
      'SALE_CANCELLATION',
      at,
      offline ? origin.receivedAt : undefined,
    );
    if (!policy) return CONTROL_POLICY_MISSING('SALE_CANCELLATION');
    const requestId = idGenerator.newId();
    await requestApproval(uow, {
      requestId,
      operationType: 'SALE_CANCELLATION',
      subjectType: 'SALE_CANCELLATION',
      subjectId: cancellationId,
      subjectSummary: `Annulation de la vente ${sale.doc_number} (${plan.totalXaf} XAF)${
        p.comment ? ` : ${p.comment}` : ''
      }`,
      siteId: site.id,
      zoneId: fromBin(sale.zone_id),
      amountXaf: plan.totalXaf,
      requestedBy: author,
      requestedAt: at,
      policyId: policy.id,
      policyVersion: policy.version,
    });
    await uow
      .insertInto('sales_sale_cancellations')
      .values({ ...baseDoc, status: 'REQUESTED', approval_request_id: toBin(requestId) })
      .execute();
    await insertLines(plan.lines);
    await uow
      .updateTable('sales_sales')
      .set({ status: 'CANCELLATION_REQUESTED' })
      .where('id', '=', sale.id)
      .execute();
    return directAllowed
      ? {
          status: 'APPLIED_WITH_WARNINGS',
          warnings: ['CANCEL_WINDOW_EXCEEDED'],
          serverRefs: { docNumber },
        }
      : { status: 'APPLIED', serverRefs: { docNumber } };
  }

  return { cancel: start(true), requestCancellation: start(false) };
}

/** Décision de la validation `SALE_CANCELLATION` : application de l'annulation, ou rejet. */
function registerDecision(decisionRegistry: SalesDecisionRegistry, idGenerator: IdGenerator): void {
  const deps = { idGenerator };
  decisionRegistry.register('SALE_CANCELLATION', async (uow, ctx) => {
    const doc = await uow
      .selectFrom('sales_sale_cancellations')
      .selectAll()
      .where('id', '=', toBin(ctx.subjectId))
      .forUpdate()
      .executeTakeFirst();
    if (!doc) throw new ApprovalDecisionRefused('NOT_FOUND', 'Annulation introuvable.');
    if (doc.status !== 'REQUESTED') {
      throw new ApprovalDecisionRefused(
        'CANCELLATION_STATUS_INVALID',
        'Cette annulation a déjà été décidée.',
      );
    }
    await lockOrderOfSale(uow, fromBin(doc.sale_id));
    const locked = await lockSale(uow, fromBin(doc.sale_id));
    if (!locked) throw new ApprovalDecisionRefused('NOT_FOUND', 'Vente introuvable.');

    if (ctx.decision === 'REJECTED') {
      await uow
        .updateTable('sales_sale_cancellations')
        .set({ status: 'REJECTED' })
        .where('id', '=', doc.id)
        .execute();
      if (locked.sale.status === 'CANCELLATION_REQUESTED') {
        await uow
          .updateTable('sales_sales')
          .set({ status: 'CONFIRMED' })
          .where('id', '=', locked.sale.id)
          .execute();
      }
      return;
    }

    const docLines = await uow
      .selectFrom('sales_sale_cancellation_lines')
      .selectAll()
      .where('cancellation_id', '=', doc.id)
      .orderBy('id', 'asc')
      .execute();
    const lines: CancellationLine[] = docLines.map((line) => ({
      id: fromBin(line.id),
      saleLineId: fromBin(line.sale_line_id),
      quantityBase: Number(line.quantity_base),
      amountXaf: Number(line.amount_xaf),
    }));
    const option = PAYMENT_TREATMENTS.find((candidate) => candidate === ctx.decisionOption);
    const result = await applyCancellation(uow, deps, {
      cancellationId: ctx.subjectId,
      locked,
      lines,
      appliedAt: ctx.decidedAt,
      treatment: (option ?? null) as PaymentTreatment | null,
      actorUserId: ctx.decidedBy,
      deviceId: null,
      commandId: null,
      offline: false,
      siteId: fromBin(doc.site_id),
    });
    if (!result.ok) {
      const refusal = result.outcome.status === 'REJECTED' ? result.outcome : undefined;
      throw new ApprovalDecisionRefused(
        refusal?.errorCode ?? 'CANCELLATION_REFUSED',
        refusal?.messageFr ?? 'Annulation impossible.',
      );
    }
    await uow
      .updateTable('sales_sale_cancellations')
      .set({
        status: 'APPLIED',
        applied_at: ctx.decidedAt,
        released_payment_treatment: result.treatment,
      })
      .where('id', '=', doc.id)
      .execute();
    const order = await syncOrderAfterSaleCancellation(uow, deps, {
      locked,
      lines,
      at: ctx.decidedAt,
      actorUserId: ctx.decidedBy,
      reasonCodeId: doc.reason_code_id ? fromBin(doc.reason_code_id) : null,
      comment: doc.comment,
      treatment: result.treatment ?? option ?? null,
      deviceId: null,
      commandId: null,
      offline: false,
    });
    if (!order.ok) {
      const refusal = order.outcome.status === 'REJECTED' ? order.outcome : undefined;
      throw new ApprovalDecisionRefused(
        refusal?.errorCode ?? 'CANCELLATION_REFUSED',
        refusal?.messageFr ?? 'Annulation impossible.',
      );
    }
  });
}

export function registerCancelCommands(
  baseRegistry: CommandHandlerRegistry,
  baseDecisionRegistry: ApprovalDecisionHandlerRegistry,
  idGenerator: IdGenerator,
  documentSequences: DocumentSequenceService,
): void {
  // P4-11 : chaque commande publie ses changements (jeux `orders`, `sales_recent`, `customers`).
  const registry = withSalesChanges(baseRegistry);
  const decisionRegistry = withSalesDecisionChanges(baseDecisionRegistry);
  const handlers = buildHandlers(idGenerator, documentSequences);
  registry.register({
    commandType: 'sales.sale.cancel',
    version: 1,
    payloadSchema: cancelPayloadSchema,
    permissionCode: 'sales.sale.cancel',
    handler: handlers.cancel,
  });
  registry.register({
    commandType: 'sales.sale.request_cancellation',
    version: 1,
    payloadSchema: cancelPayloadSchema,
    permissionCode: 'sales.sale.cancel',
    handler: handlers.requestCancellation,
  });
  registerDecision(decisionRegistry, idGenerator);
}
