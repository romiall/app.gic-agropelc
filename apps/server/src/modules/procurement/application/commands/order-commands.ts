/**
 * Bons de commande fournisseur (D08-APP ; SM-PURCHASE-ORDER) : `procurement.order.create`,
 * `.update`, `.submit`, `.mark_sent`, `.close_remaining`, `.cancel` et la décision
 * `PURCHASE_ORDER` — commandes en ligne (le BC est un document de bureau).
 *
 * - Création depuis des lignes de DA approuvées (quantité ≤ reste à commander, même produit) ou
 *   directe ; fournisseur actif (`SUPPLIER_INACTIVE`) ; emplacement de livraison physique, dont le
 *   site porte le numéro `BC` ; montants arrondis au franc (`orderAmounts`, packages/domain).
 * - Brouillon seul modifiable (date prévue, quantités et prix, ajout ou annulation de lignes) :
 *   la couverture des DA suit (request-ordering.ts).
 * - Soumission : au-delà du paramètre `procurement.po_approval_threshold_xaf` (strictement),
 *   validation `PURCHASE_ORDER` de la Direction ; sinon approuvé d'office (BR-APP-005, AV-051).
 *   Rejet : retour en brouillon, à corriger.
 * - Envoyé, un BC n'est plus augmenté (BR-APP-006, INV-APP-04) : seules la clôture du reliquat
 *   (motif) et l'annulation sans réception restent possibles ; l'annulation rétablit la
 *   couverture des DA.
 */
import { z } from 'zod';
import { sql } from 'kysely';
import {
  addQuantity,
  orderAmounts,
  orderLineRemaining,
  orderRequiresApproval,
  quantityFromDecimal,
  quantityToDecimal,
  xaf,
  type IdGenerator,
  businessDayOf,
} from '@gic/domain';
import type {
  CommandHandler,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import type { DocumentSequenceService } from '../../../../platform/document-sequences/document-sequence.service.js';
import { fromBin, toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import {
  cancelApprovalRequest,
  requestApproval,
  type ApprovalDecisionHandlerRegistry,
} from '../../../approvals/application/public/index.js';
import { findReasonCode } from '../../../catalog/application/public/index.js';
import {
  CONTROL_POLICY_MISSING,
  DATE_ONLY,
  FORBIDDEN_SCOPE,
  activePolicy,
  baseQuantity,
  domainRejection,
  isAllowed,
  loadPhysicalLocation,
  nonPurchasableProducts,
  numberSetting,
  rejected,
  unknownUnits,
  type Uow,
} from './shared.js';
import {
  adjustRequestLine,
  refreshRequestStatuses,
  reserveRequestLine,
} from './request-ordering.js';
import { emitPurchaseOrderChange } from '../sync-changes.js';

const lineSchema = z.object({
  productId: z.string().uuid(),
  unitCode: z.string().min(1).max(20),
  orderedQtyBase: z.number().positive(),
  unitPriceXaf: z.number().int().nonnegative(),
  requestLineId: z.string().uuid().optional(),
});
type LineInput = z.infer<typeof lineSchema>;

const createPayloadSchema = z.object({
  supplierId: z.string().uuid(),
  deliveryLocationId: z.string().uuid(),
  expectedDeliveryDate: z.string().regex(DATE_ONLY).optional(),
  lines: z.array(lineSchema).min(1).max(200),
});
type CreatePayload = z.infer<typeof createPayloadSchema>;

const updatePayloadSchema = z.object({
  expectedDeliveryDate: z.string().regex(DATE_ONLY).nullable().optional(),
  /** Lignes existantes modifiées (quantité, prix) ou annulées. */
  lines: z
    .array(
      z.object({
        lineNo: z.number().int().positive(),
        orderedQtyBase: z.number().positive().optional(),
        unitPriceXaf: z.number().int().nonnegative().optional(),
        cancel: z.boolean().optional(),
      }),
    )
    .max(200)
    .optional(),
  addLines: z.array(lineSchema).max(200).optional(),
});
type UpdatePayload = z.infer<typeof updatePayloadSchema>;

const emptyPayloadSchema = z.object({});
const reasonPayloadSchema = z.object({ reason: z.string().trim().min(1).max(2000) });
const cancelPayloadSchema = z.object({
  reasonCodeId: z.string().uuid().optional(),
  comment: z.string().trim().min(1).max(2000),
});

const NOT_FOUND = rejected('NOT_FOUND', 'Bon de commande introuvable.');
const statusInvalid = (expected: string) =>
  rejected('ORDER_STATUS_INVALID', `Le bon de commande doit être au statut ${expected}.`);

async function lockOrder(uow: Uow, orderId: string) {
  return uow
    .selectFrom('procurement_purchase_orders')
    .selectAll()
    .where('id', '=', toBin(orderId))
    .forUpdate()
    .executeTakeFirst();
}

async function orderLines(uow: Uow, orderId: Buffer) {
  return uow
    .selectFrom('procurement_purchase_order_lines')
    .selectAll()
    .where('order_id', '=', orderId)
    .orderBy('line_no', 'asc')
    .forUpdate()
    .execute();
}

async function supplierActive(uow: Uow, supplierId: string): Promise<boolean> {
  const row = await uow
    .selectFrom('procurement_suppliers')
    .select('status')
    .where('id', '=', toBin(supplierId))
    .executeTakeFirst();
  return row?.status === 'ACTIVE';
}

const SUPPLIER_INACTIVE = rejected(
  'SUPPLIER_INACTIVE',
  'Fournisseur inconnu ou inactif : aucun nouveau bon de commande (BR-APP-001).',
);

/** Lignes nouvelles : produits achetables, unités connues, montants ; `undefined` si valides. */
async function checkNewLines(uow: Uow, lines: readonly LineInput[]) {
  const refused = await nonPurchasableProducts(
    uow,
    lines.map((line) => line.productId),
  );
  if (refused.length > 0) {
    return rejected(
      'PRODUCT_NOT_PURCHASABLE',
      `Produit inconnu, inactif ou non achetable : ${refused.join(', ')}.`,
    );
  }
  const units = await unknownUnits(
    uow,
    lines.map((line) => line.unitCode),
  );
  if (units.length > 0)
    return rejected('REFERENCE_INVALID', `Unité inconnue : ${units.join(', ')}.`);
  return undefined;
}

/** Montant d'une ligne (arrondi au franc) ; `DomainError` pour une quantité ou un prix invalide. */
function lineTotal(orderedQtyBase: number, unitPriceXaf: number): number {
  return orderAmounts([{ quantity: baseQuantity(orderedQtyBase), unitPriceXaf }]).lineTotals[0]!;
}

async function recomputeTotal(uow: Uow, orderId: Buffer): Promise<number> {
  const lines = await uow
    .selectFrom('procurement_purchase_order_lines')
    .select(['line_total_xaf', 'status'])
    .where('order_id', '=', orderId)
    .execute();
  return lines
    .filter((line) => line.status !== 'CANCELLED')
    .reduce((sum, line) => sum + Number(line.line_total_xaf), 0);
}

function buildHandlers(idGenerator: IdGenerator, documentSequences: DocumentSequenceService) {
  const create: CommandHandler<CreatePayload> = async (uow, envelope) => {
    const orderId = envelope.aggregate_id;
    const replay = await uow
      .selectFrom('procurement_purchase_orders')
      .select('id')
      .where('id', '=', toBin(orderId))
      .executeTakeFirst();
    if (replay) return { status: 'APPLIED' };
    const p = envelope.payload;
    const author = envelope.author_user_id;
    const at = new Date(envelope.occurred_at);
    if (!(await supplierActive(uow, p.supplierId))) return SUPPLIER_INACTIVE;
    const location = await loadPhysicalLocation(uow, p.deliveryLocationId);
    if (!location || !location.isActive || !location.site.isActive) {
      return rejected('REFERENCE_INVALID', 'Emplacement de livraison inconnu, virtuel ou inactif.');
    }
    if (
      !(await isAllowed(uow, author, 'procurement.order.manage', at, { siteId: location.site.id }))
    ) {
      return FORBIDDEN_SCOPE;
    }
    const invalid = await checkNewLines(uow, p.lines);
    if (invalid) return invalid;
    let totals: { lineTotals: readonly number[]; total: number };
    try {
      const amounts = orderAmounts(
        p.lines.map((line) => ({
          quantity: baseQuantity(line.orderedQtyBase),
          unitPriceXaf: line.unitPriceXaf,
        })),
      );
      totals = { lineTotals: amounts.lineTotals, total: amounts.total };
    } catch (error) {
      return domainRejection(error);
    }

    // BR-APP-004 : couverture des lignes de DA référencées.
    const touchedRequests: string[] = [];
    for (const line of p.lines) {
      if (line.requestLineId === undefined) continue;
      const reserved = await reserveRequestLine(uow, {
        requestLineId: line.requestLineId,
        productId: line.productId,
        quantityBase: line.orderedQtyBase,
      });
      if ('rejected' in reserved) return reserved.rejected;
      touchedRequests.push(reserved.requestId);
    }

    const docNumber = await documentSequences.next(uow, {
      docType: 'BC',
      siteId: location.site.id,
      codeSite: location.site.code,
      year: Number(businessDayOf(at).slice(0, 4)),
    });
    await uow
      .insertInto('procurement_purchase_orders')
      .values({
        id: toBin(orderId),
        doc_number: docNumber,
        site_id: toBin(location.site.id),
        supplier_id: toBin(p.supplierId),
        delivery_location_id: toBin(location.id),
        expected_delivery_date: p.expectedDeliveryDate
          ? sql<Date>`${p.expectedDeliveryDate}`
          : null,
        total_xaf: totals.total,
        status: 'DRAFT',
        occurred_at: at,
        command_id: toBin(envelope.command_id),
        created_by: toBin(author),
      })
      .execute();
    let lineNo = 0;
    for (const [index, line] of p.lines.entries()) {
      lineNo += 1;
      await uow
        .insertInto('procurement_purchase_order_lines')
        .values({
          id: toBin(idGenerator.newId()),
          order_id: toBin(orderId),
          line_no: lineNo,
          request_line_id: toBinOrNull(line.requestLineId ?? null),
          product_id: toBin(line.productId),
          unit_code: line.unitCode,
          ordered_qty_base: String(line.orderedQtyBase),
          unit_price_xaf: line.unitPriceXaf,
          line_total_xaf: totals.lineTotals[index]!,
        })
        .execute();
    }
    await refreshRequestStatuses(uow, touchedRequests, author);
    await emitPurchaseOrderChange(uow, orderId);
    return { status: 'APPLIED', serverRefs: { docNumber } };
  };

  const update: CommandHandler<UpdatePayload> = async (uow, envelope) => {
    const order = await lockOrder(uow, envelope.aggregate_id);
    if (!order) return NOT_FOUND;
    if (order.status !== 'DRAFT') return statusInvalid('DRAFT');
    const author = envelope.author_user_id;
    const at = new Date(envelope.occurred_at);
    if (
      !(await isAllowed(uow, author, 'procurement.order.manage', at, {
        siteId: fromBin(order.site_id),
      }))
    ) {
      return FORBIDDEN_SCOPE;
    }
    const p = envelope.payload;
    const lines = await orderLines(uow, order.id);
    const byNo = new Map(lines.map((line) => [line.line_no, line]));
    const touchedRequests: string[] = [];
    try {
      for (const change of p.lines ?? []) {
        const line = byNo.get(change.lineNo);
        if (!line || line.status === 'CANCELLED') {
          return rejected('PO_LINE_MISMATCH', `Ligne ${change.lineNo} inconnue ou annulée.`);
        }
        const oldQty = Number(line.ordered_qty_base);
        const newQty = change.cancel ? 0 : (change.orderedQtyBase ?? oldQty);
        const delta = (Math.round(newQty * 1000) - Math.round(oldQty * 1000)) / 1000;
        const newPrice = change.unitPriceXaf ?? Number(line.unit_price_xaf);
        if (line.request_line_id && delta !== 0) {
          if (delta > 0) {
            const reserved = await reserveRequestLine(uow, {
              requestLineId: fromBin(line.request_line_id),
              productId: fromBin(line.product_id),
              quantityBase: delta,
            });
            if ('rejected' in reserved) return reserved.rejected;
            touchedRequests.push(reserved.requestId);
          } else {
            await adjustRequestLine(uow, line.request_line_id, delta);
            touchedRequests.push(await requestIdOfLine(uow, line.request_line_id));
          }
        }
        await uow
          .updateTable('procurement_purchase_order_lines')
          .set(
            change.cancel
              ? { status: 'CANCELLED' }
              : {
                  ordered_qty_base: String(newQty),
                  unit_price_xaf: newPrice,
                  line_total_xaf: lineTotal(newQty, newPrice),
                },
          )
          .where('id', '=', line.id)
          .execute();
      }
      if (p.addLines && p.addLines.length > 0) {
        const invalid = await checkNewLines(uow, p.addLines);
        if (invalid) return invalid;
        let lineNo = lines.reduce((max, line) => Math.max(max, line.line_no), 0);
        for (const line of p.addLines) {
          if (line.requestLineId !== undefined) {
            const reserved = await reserveRequestLine(uow, {
              requestLineId: line.requestLineId,
              productId: line.productId,
              quantityBase: line.orderedQtyBase,
            });
            if ('rejected' in reserved) return reserved.rejected;
            touchedRequests.push(reserved.requestId);
          }
          lineNo += 1;
          await uow
            .insertInto('procurement_purchase_order_lines')
            .values({
              id: toBin(idGenerator.newId()),
              order_id: order.id,
              line_no: lineNo,
              request_line_id: toBinOrNull(line.requestLineId ?? null),
              product_id: toBin(line.productId),
              unit_code: line.unitCode,
              ordered_qty_base: String(line.orderedQtyBase),
              unit_price_xaf: line.unitPriceXaf,
              line_total_xaf: lineTotal(line.orderedQtyBase, line.unitPriceXaf),
            })
            .execute();
        }
      }
    } catch (error) {
      return domainRejection(error);
    }
    const total = await recomputeTotal(uow, order.id);
    await uow
      .updateTable('procurement_purchase_orders')
      .set({
        total_xaf: total,
        ...(p.expectedDeliveryDate !== undefined
          ? {
              expected_delivery_date:
                p.expectedDeliveryDate === null ? null : sql<Date>`${p.expectedDeliveryDate}`,
            }
          : {}),
        updated_by: toBin(author),
        version: sql`version + 1`,
      })
      .where('id', '=', order.id)
      .execute();
    await refreshRequestStatuses(uow, touchedRequests, author);
    await emitPurchaseOrderChange(uow, envelope.aggregate_id);
    return {
      status: 'APPLIED',
      audit: { before: { totalXaf: Number(order.total_xaf) }, after: { ...p, totalXaf: total } },
    };
  };

  const submit: CommandHandler<z.infer<typeof emptyPayloadSchema>> = async (uow, envelope) => {
    const order = await lockOrder(uow, envelope.aggregate_id);
    if (!order) return NOT_FOUND;
    if (order.status !== 'DRAFT') return statusInvalid('DRAFT');
    const author = envelope.author_user_id;
    const at = new Date(envelope.occurred_at);
    const siteId = fromBin(order.site_id);
    if (!(await isAllowed(uow, author, 'procurement.order.manage', at, { siteId }))) {
      return FORBIDDEN_SCOPE;
    }
    if (!(await supplierActive(uow, fromBin(order.supplier_id)))) return SUPPLIER_INACTIVE;
    const active = (await orderLines(uow, order.id)).filter((line) => line.status !== 'CANCELLED');
    if (active.length === 0) return rejected('ORDER_EMPTY', 'Bon de commande sans ligne active.');
    const total = Number(order.total_xaf);
    const threshold = await numberSetting(
      uow,
      'procurement.po_approval_threshold_xaf',
      at,
      500_000,
    );
    if (!orderRequiresApproval(xaf(total), threshold)) {
      await uow
        .updateTable('procurement_purchase_orders')
        .set({
          status: 'APPROVED',
          approved_at: at,
          updated_by: toBin(author),
          version: sql`version + 1`,
        })
        .where('id', '=', order.id)
        .execute();
      await emitPurchaseOrderChange(uow, envelope.aggregate_id);
      return { status: 'APPLIED' };
    }
    const policy = await activePolicy(uow, 'PURCHASE_ORDER', at);
    if (!policy) return CONTROL_POLICY_MISSING('PURCHASE_ORDER');
    const approvalRequestId = idGenerator.newId();
    await requestApproval(uow, {
      requestId: approvalRequestId,
      operationType: 'PURCHASE_ORDER',
      subjectType: 'PURCHASE_ORDER',
      subjectId: envelope.aggregate_id,
      subjectSummary: `Bon de commande ${order.doc_number} (${total} XAF)`,
      siteId,
      amountXaf: total,
      requestedBy: author,
      requestedAt: at,
      policyId: policy.id,
      policyVersion: policy.version,
    });
    await uow
      .updateTable('procurement_purchase_orders')
      .set({
        status: 'PENDING_APPROVAL',
        approval_request_id: toBin(approvalRequestId),
        updated_by: toBin(author),
        version: sql`version + 1`,
      })
      .where('id', '=', order.id)
      .execute();
    await emitPurchaseOrderChange(uow, envelope.aggregate_id);
    return { status: 'APPLIED' };
  };

  const markSent: CommandHandler<z.infer<typeof emptyPayloadSchema>> = async (uow, envelope) => {
    const order = await lockOrder(uow, envelope.aggregate_id);
    if (!order) return NOT_FOUND;
    if (order.status !== 'APPROVED') return statusInvalid('APPROVED');
    const at = new Date(envelope.occurred_at);
    if (
      !(await isAllowed(uow, envelope.author_user_id, 'procurement.order.manage', at, {
        siteId: fromBin(order.site_id),
      }))
    ) {
      return FORBIDDEN_SCOPE;
    }
    await uow
      .updateTable('procurement_purchase_orders')
      .set({
        status: 'SENT',
        sent_at: at,
        updated_by: toBin(envelope.author_user_id),
        version: sql`version + 1`,
      })
      .where('id', '=', order.id)
      .execute();
    await emitPurchaseOrderChange(uow, envelope.aggregate_id);
    return { status: 'APPLIED' };
  };

  /** BR-APP-009 : reliquat clôturé manuellement (motif) ; le BC passe `CLOSED`. */
  const closeRemaining: CommandHandler<z.infer<typeof reasonPayloadSchema>> = async (
    uow,
    envelope,
  ) => {
    const order = await lockOrder(uow, envelope.aggregate_id);
    if (!order) return NOT_FOUND;
    if (order.status !== 'PARTIALLY_RECEIVED') return statusInvalid('PARTIALLY_RECEIVED');
    const at = new Date(envelope.occurred_at);
    if (
      !(await isAllowed(uow, envelope.author_user_id, 'procurement.order.manage', at, {
        siteId: fromBin(order.site_id),
      }))
    ) {
      return FORBIDDEN_SCOPE;
    }
    for (const line of await orderLines(uow, order.id)) {
      if (line.status !== 'OPEN') continue;
      const remaining = orderLineRemaining({
        ordered: quantityFromDecimal(Number(line.ordered_qty_base)),
        accepted: quantityFromDecimal(Number(line.accepted_qty_base)),
        closed: quantityFromDecimal(Number(line.closed_qty_base)),
      });
      const closed = addQuantity(quantityFromDecimal(Number(line.closed_qty_base)), remaining);
      await uow
        .updateTable('procurement_purchase_order_lines')
        .set({
          closed_qty_base: String(quantityToDecimal(closed)),
          status: quantityToDecimal(remaining) > 0 ? 'CLOSED' : 'RECEIVED',
        })
        .where('id', '=', line.id)
        .execute();
    }
    await uow
      .updateTable('procurement_purchase_orders')
      .set({
        status: 'CLOSED',
        closed_reason: envelope.payload.reason,
        updated_by: toBin(envelope.author_user_id),
        version: sql`version + 1`,
      })
      .where('id', '=', order.id)
      .execute();
    await emitPurchaseOrderChange(uow, envelope.aggregate_id);
    return { status: 'APPLIED' };
  };

  /** Annulation sans aucune réception (SM-PURCHASE-ORDER) ; couverture des DA rétablie. */
  const cancel: CommandHandler<z.infer<typeof cancelPayloadSchema>> = async (uow, envelope) => {
    const order = await lockOrder(uow, envelope.aggregate_id);
    if (!order) return NOT_FOUND;
    if (!['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT'].includes(order.status)) {
      return statusInvalid('DRAFT, PENDING_APPROVAL, APPROVED ou SENT');
    }
    const author = envelope.author_user_id;
    const at = new Date(envelope.occurred_at);
    if (
      !(await isAllowed(uow, author, 'procurement.order.manage', at, {
        siteId: fromBin(order.site_id),
      }))
    ) {
      return FORBIDDEN_SCOPE;
    }
    const receipt = await uow
      .selectFrom('procurement_goods_receipts')
      .select('id')
      .where('purchase_order_id', '=', order.id)
      .where('status', 'not in', ['REJECTED', 'CANCELLED'])
      .executeTakeFirst();
    if (receipt) {
      return rejected(
        'ORDER_HAS_RECEIPTS',
        'Bon de commande déjà réceptionné : clôturer le reliquat plutôt que l’annuler.',
      );
    }
    const reasonCodeId = envelope.payload.reasonCodeId;
    if (reasonCodeId !== undefined) {
      const reason = await findReasonCode(uow, reasonCodeId);
      if (!reason || reason.category !== 'CANCELLATION') {
        return rejected(
          'REFERENCE_INVALID',
          "Motif d'annulation inconnu (catégorie CANCELLATION).",
        );
      }
    }
    const touchedRequests: string[] = [];
    for (const line of await orderLines(uow, order.id)) {
      if (line.status === 'CANCELLED') continue;
      if (line.request_line_id) {
        await adjustRequestLine(uow, line.request_line_id, -Number(line.ordered_qty_base));
        touchedRequests.push(await requestIdOfLine(uow, line.request_line_id));
      }
      await uow
        .updateTable('procurement_purchase_order_lines')
        .set({ status: 'CANCELLED' })
        .where('id', '=', line.id)
        .execute();
    }
    if (order.status === 'PENDING_APPROVAL' && order.approval_request_id) {
      await cancelApprovalRequest(uow, {
        requestId: fromBin(order.approval_request_id),
        cancelledBy: author,
      });
    }
    await uow
      .updateTable('procurement_purchase_orders')
      .set({
        status: 'CANCELLED',
        cancelled_at: at,
        cancelled_by: toBin(author),
        cancel_reason_code_id: toBinOrNull(reasonCodeId ?? null),
        cancel_comment: envelope.payload.comment,
        updated_by: toBin(author),
        version: sql`version + 1`,
      })
      .where('id', '=', order.id)
      .execute();
    await refreshRequestStatuses(uow, touchedRequests, author);
    await emitPurchaseOrderChange(uow, envelope.aggregate_id);
    return { status: 'APPLIED' };
  };

  return { create, update, submit, markSent, closeRemaining, cancel };
}

async function requestIdOfLine(uow: Uow, requestLineId: Buffer): Promise<string> {
  const row = await uow
    .selectFrom('procurement_purchase_request_lines')
    .select('request_id')
    .where('id', '=', requestLineId)
    .executeTakeFirstOrThrow();
  return fromBin(row.request_id);
}

/** Décision `PURCHASE_ORDER` : approuvé ; rejeté → retour en brouillon, à corriger. */
function registerOrderDecision(decisionRegistry: ApprovalDecisionHandlerRegistry): void {
  decisionRegistry.register('PURCHASE_ORDER', async (uow, ctx) => {
    const order = await lockOrder(uow, ctx.subjectId);
    if (!order || order.status !== 'PENDING_APPROVAL') return;
    await uow
      .updateTable('procurement_purchase_orders')
      .set(
        ctx.decision === 'APPROVED'
          ? {
              status: 'APPROVED',
              approved_by: toBin(ctx.decidedBy),
              approved_at: ctx.decidedAt,
              updated_by: toBin(ctx.decidedBy),
              version: sql`version + 1`,
            }
          : { status: 'DRAFT', updated_by: toBin(ctx.decidedBy), version: sql`version + 1` },
      )
      .where('id', '=', order.id)
      .execute();
    await emitPurchaseOrderChange(uow, ctx.subjectId);
  });
}

export function registerOrderCommands(
  registry: CommandHandlerRegistry,
  decisionRegistry: ApprovalDecisionHandlerRegistry,
  idGenerator: IdGenerator,
  documentSequences: DocumentSequenceService,
): void {
  const handlers = buildHandlers(idGenerator, documentSequences);
  const manage = 'procurement.order.manage';
  registry.register({
    commandType: 'procurement.order.create',
    version: 1,
    payloadSchema: createPayloadSchema,
    permissionCode: manage,
    handler: handlers.create,
  });
  registry.register({
    commandType: 'procurement.order.update',
    version: 1,
    payloadSchema: updatePayloadSchema,
    permissionCode: manage,
    handler: handlers.update,
  });
  registry.register({
    commandType: 'procurement.order.submit',
    version: 1,
    payloadSchema: emptyPayloadSchema,
    permissionCode: manage,
    handler: handlers.submit,
  });
  registry.register({
    commandType: 'procurement.order.mark_sent',
    version: 1,
    payloadSchema: emptyPayloadSchema,
    permissionCode: manage,
    handler: handlers.markSent,
  });
  registry.register({
    commandType: 'procurement.order.close_remaining',
    version: 1,
    payloadSchema: reasonPayloadSchema,
    permissionCode: manage,
    handler: handlers.closeRemaining,
  });
  registry.register({
    commandType: 'procurement.order.cancel',
    version: 1,
    payloadSchema: cancelPayloadSchema,
    permissionCode: manage,
    handler: handlers.cancel,
  });
  registerOrderDecision(decisionRegistry);
}
