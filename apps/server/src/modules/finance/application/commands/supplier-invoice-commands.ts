/**
 * Factures fournisseurs (P8-07 ; ADR-043 ; SM-SUPPLIER-INVOICE ; WF-09 ; D09 BR-FIN-030, BR-FIN-031 ;
 * AV-053, AV-271 à AV-274) : enregistrement avec rapprochement, contestation, approbation (façade de la
 * décision `INVOICE_MISMATCH`, ou approbation directe d'une facture contestée), annulation (avoir,
 * AV-272). Toutes en ligne (SM : aucune transition hors ligne), `ONLINE_REQUIRED` sinon.
 *
 * - **Rapprochement** (`matchSupplierInvoice`, `packages/domain`) sous le verrou du BC
 *   (`lockOrderForInvoicing`, `procurement`) : deux factures concurrentes sur les mêmes lignes se
 *   rapprochent l'une après l'autre. Conforme : `APPROVED`, quantités facturées écrites tout de suite ;
 *   sinon `MISMATCH` (détail dans `mismatch_details`) et demande `INVOICE_MISMATCH` si une politique
 *   est active.
 * - **Référence fournisseur** unique parmi les factures non annulées (`INVOICE_DUPLICATE`) ; la
 *   rectificative d'un avoir reprend la référence de la facture annulée (AV-272).
 * - **Verrous** (ADR-043 §9) : facture, puis BC (en-tête puis lignes) ; demande (N11) avant le numéro
 *   `FF` (N12).
 */
import {
  matchSupplierInvoice,
  normalizedInvoiceRef,
  quantityFromDecimal,
  supplierInvoiceDueDate,
  supplierInvoiceTransition,
  type IdGenerator,
  type InvoiceWithoutPoMode,
  type MatchedOrderLine,
} from '@gic/domain';
import {
  supplierInvoiceDecisionPayloadSchema,
  supplierInvoiceRecordPayloadSchema,
  type SupplierInvoiceDecisionPayload,
  type SupplierInvoiceRecordPayload,
} from '@gic/contracts';
import { sql, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import type {
  CommandHandler,
  CommandHandlerOutcome,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import type { DocumentSequenceService } from '../../../../platform/document-sequences/document-sequence.service.js';
import { jsonValue } from '../../../../platform/kysely/json-value.js';
import { toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import {
  ApprovalDecisionRefused,
  cancelApprovalRequest,
  decideApprovalRequest,
  requestApproval,
  type ApprovalDecisionHandlerRegistry,
} from '../../../approvals/application/public/index.js';
import { findProduct } from '../../../catalog/application/public/index.js';
import {
  findSupplier,
  lockOrderForInvoicing,
  receiptLinesForInvoicing,
} from '../../../procurement/application/public/index.js';
import { financeBusinessRejection, rejected } from '../cash-transfer-support.js';
import {
  INVOICE_APPROVE_PERMISSION,
  INVOICE_RECORD_PERMISSION,
  SUPPLIER_INVOICE_DOC_TYPE,
  applyInvoiceQuantities,
  approveSupplierInvoice,
  decisionPolicy,
  disputeSupplierInvoice,
  insertSupplierEvent,
  loadSupplierInvoice,
  nextSupplierDocNumber,
  numberSettingAt,
  quantityExcessSinceRequest,
  settingAt,
} from '../supplier-ledger-support.js';

type Uow = Transaction<DB>;
type Envelope<P> = Parameters<CommandHandler<P>>[1];

const ONLINE_REQUIRED = rejected(
  'ONLINE_REQUIRED',
  'Les factures fournisseurs se gèrent en ligne.',
);
const NOT_FOUND = rejected('NOT_FOUND', 'Facture fournisseur introuvable.');

export function registerSupplierInvoiceCommands(
  registry: CommandHandlerRegistry,
  decisionRegistry: ApprovalDecisionHandlerRegistry,
  idGenerator: IdGenerator,
  documentSequences: DocumentSequenceService,
): void {
  // --- finance.supplier_invoice.record -----------------------------------------------------------

  const record: CommandHandler<SupplierInvoiceRecordPayload> = async (uow, envelope) => {
    if (envelope.captured_offline) return ONLINE_REQUIRED;
    const existing = await uow
      .selectFrom('finance_supplier_invoices')
      .select(['doc_number', 'status'])
      .where('id', '=', toBin(envelope.aggregate_id))
      .executeTakeFirst();
    if (existing) {
      return {
        status: 'APPLIED',
        serverRefs: { docNumber: existing.doc_number, status: existing.status },
      };
    }
    try {
      return await recordInvoice(uow, envelope);
    } catch (error) {
      return financeBusinessRejection(error);
    }
  };

  async function recordInvoice(
    uow: Uow,
    envelope: Envelope<SupplierInvoiceRecordPayload>,
  ): Promise<CommandHandlerOutcome> {
    const p = envelope.payload;
    const invoiceId = envelope.aggregate_id;
    const author = envelope.author_user_id;
    const at = new Date(envelope.occurred_at);

    const supplier = await findSupplier(uow, p.supplierId);
    if (!supplier) return rejected('NOT_FOUND', 'Fournisseur inconnu.');
    for (const line of p.lines) {
      if (line.productId !== undefined && !(await findProduct(uow, line.productId))) {
        return rejected('NOT_FOUND', 'Produit inconnu sur une ligne de facture.');
      }
    }
    const receiptLineIds = p.lines.flatMap((line) =>
      line.receiptLineId !== undefined ? [line.receiptLineId] : [],
    );
    const receiptLines = await receiptLinesForInvoicing(uow, receiptLineIds);
    for (const line of p.lines) {
      if (line.receiptLineId === undefined) continue;
      const receiptLine = receiptLines.get(line.receiptLineId);
      if (
        !receiptLine ||
        receiptLine.supplierId !== p.supplierId ||
        (line.poLineId !== undefined && receiptLine.poLineId !== line.poLineId)
      ) {
        return rejected(
          'PO_LINE_MISMATCH',
          'Une ligne de réception citée n’appartient pas à ce fournisseur ou à cette ligne de bon de commande.',
        );
      }
      // Revue de P8-14 : seule une réception comptabilisée se facture.
      if (receiptLine.receiptStatus !== 'POSTED') {
        return rejected(
          'PO_LINE_MISMATCH',
          `Une ligne de réception citée n’est pas comptabilisée (réception ${receiptLine.receiptStatus}).`,
        );
      }
    }

    // Référence unique parmi les factures non annulées (BR-FIN-030, AV-272), comparée sans la casse
    // ni la ponctuation : « FA-0012 », « fa 0012 » et « FA0012 » sont la même facture (revue de P8-14).
    const duplicate = await uow
      .selectFrom('finance_supplier_invoices')
      .select('doc_number')
      .where('supplier_id', '=', toBin(p.supplierId))
      .where(
        sql<string>`REGEXP_REPLACE(UPPER(supplier_invoice_ref), '[^A-Z0-9]', '')`,
        '=',
        normalizedInvoiceRef(p.supplierInvoiceRef),
      )
      .where('status', '<>', 'CANCELLED')
      .executeTakeFirst();
    if (duplicate) {
      return rejected(
        'INVOICE_DUPLICATE',
        `Cette référence fournisseur est déjà enregistrée (${duplicate.doc_number}).`,
      );
    }

    // Rapprochement sous le verrou du BC (ADR-043 §9).
    const order =
      p.purchaseOrderId !== undefined
        ? await lockOrderForInvoicing(uow, p.purchaseOrderId)
        : undefined;
    if (p.purchaseOrderId !== undefined && !order)
      return rejected('NOT_FOUND', 'Bon de commande introuvable.');
    const withoutOrderMode: InvoiceWithoutPoMode =
      (await settingAt(uow, 'finance.invoice_without_po_mode', at)) === 'APPROVE'
        ? 'APPROVE'
        : 'REVIEW';
    const lines = p.lines.map((line) => ({
      poLineId: line.poLineId ?? null,
      productId: line.productId ?? null,
      quantity: line.quantity !== undefined ? quantityFromDecimal(line.quantity) : null,
      unitPriceXaf: line.unitPriceXaf ?? null,
      lineTotalXaf: line.lineTotalXaf,
    }));
    const match = matchSupplierInvoice({
      supplierId: p.supplierId,
      order: order
        ? {
            supplierId: order.supplierId,
            lines: order.lines.map((line): MatchedOrderLine => ({
              poLineId: line.poLineId,
              productId: line.productId,
              unitPriceXaf: line.unitPriceXaf,
              accepted: quantityFromDecimal(line.acceptedQtyBase),
              invoiced: quantityFromDecimal(line.invoicedQtyBase),
            })),
          }
        : null,
      lines,
      printedTotalXaf: p.printedTotalXaf ?? null,
      qtyTolerancePct: await numberSettingAt(uow, 'finance.invoice_match_qty_tolerance_pct', at, 0),
      priceToleranceXaf: await numberSettingAt(
        uow,
        'finance.invoice_match_price_tolerance_xaf',
        at,
        0,
      ),
      withoutOrderMode,
    });
    const dueDate = supplierInvoiceDueDate({
      invoiceDate: p.invoiceDate,
      dueDate: p.dueDate ?? null,
      paymentTermsDays: supplier.paymentTermsDays,
    });
    const status = match.conforming ? 'APPROVED' : 'MISMATCH';

    // Demande (N11) avant le numéro (N12), ADR-038.
    let approvalRequestId: string | null = null;
    if (status === 'MISMATCH') {
      const policy = await decisionPolicy(uow, 'INVOICE_MISMATCH', at);
      if (policy) {
        approvalRequestId = idGenerator.newId();
        await requestApproval(uow, {
          requestId: approvalRequestId,
          operationType: 'INVOICE_MISMATCH',
          subjectType: 'SUPPLIER_INVOICE',
          subjectId: invoiceId,
          subjectSummary: `Facture ${p.supplierInvoiceRef} de ${supplier.name} — ${match.totalXaf as number} XAF — écart : ${match.details.map((detail) => detail.reason).join(', ')}`,
          ...(order ? { siteId: order.siteId } : {}),
          amountXaf: match.totalXaf as number,
          requestedBy: author,
          requestedAt: at,
          policyId: policy.id,
          policyVersion: policy.version,
          ...(envelope.attachment_ids.length > 0
            ? { requiredAttachmentIds: envelope.attachment_ids }
            : {}),
        });
      }
    }
    const docNumber = await nextSupplierDocNumber(uow, documentSequences, {
      docType: SUPPLIER_INVOICE_DOC_TYPE,
      at,
    });

    await uow
      .insertInto('finance_supplier_invoices')
      .values({
        id: toBin(invoiceId),
        doc_number: docNumber,
        site_id: toBinOrNull(order?.siteId ?? null),
        supplier_id: toBin(p.supplierId),
        supplier_invoice_ref: p.supplierInvoiceRef,
        invoice_date: sql<Date>`${p.invoiceDate}`,
        due_date: sql<Date>`${dueDate}`,
        purchase_order_id: toBinOrNull(p.purchaseOrderId ?? null),
        total_xaf: match.totalXaf as number,
        printed_total_xaf: p.printedTotalXaf ?? null,
        status,
        mismatch_details: match.details.length > 0 ? jsonValue(match.details) : null,
        approval_request_id: toBinOrNull(approvalRequestId),
        ...(status === 'APPROVED'
          ? {
              approved_by: toBin(author),
              approved_at: at,
              approval_reason: 'Rapprochement conforme',
            }
          : {}),
        comment: p.comment ?? null,
        occurred_at: at,
        command_id: toBin(envelope.command_id),
        created_by: toBin(author),
      })
      .execute();
    await uow
      .insertInto('finance_supplier_invoice_lines')
      .values(
        p.lines.map((line, index) => ({
          id: toBin(idGenerator.newId()),
          invoice_id: toBin(invoiceId),
          line_no: index + 1,
          po_line_id: toBinOrNull(line.poLineId ?? null),
          receipt_line_id: toBinOrNull(line.receiptLineId ?? null),
          product_id: toBinOrNull(line.productId ?? null),
          description: line.description,
          quantity_base: line.quantity !== undefined ? line.quantity.toFixed(3) : null,
          unit_price_xaf: line.unitPriceXaf ?? null,
          line_total_xaf: line.lineTotalXaf,
        })),
      )
      .execute();

    const invoice = await loadSupplierInvoice(uow, invoiceId);
    // Conforme : les quantités facturées comptent tout de suite (SM : `[*]` → `APPROVED`).
    if (status === 'APPROVED') await applyInvoiceQuantities(uow, invoice!, 1);
    await insertSupplierEvent(uow, idGenerator, {
      eventType: 'SupplierInvoiceRecorded',
      aggregateType: 'SUPPLIER_INVOICE',
      aggregateId: invoiceId,
      occurredAt: at,
      commandId: envelope.command_id,
      payload: {
        docNumber,
        supplierId: p.supplierId,
        supplierInvoiceRef: p.supplierInvoiceRef,
        totalXaf: match.totalXaf,
        status,
      },
    });
    await insertSupplierEvent(uow, idGenerator, {
      eventType:
        status === 'APPROVED' ? 'SupplierInvoiceApproved' : 'SupplierInvoiceMismatchDetected',
      aggregateType: 'SUPPLIER_INVOICE',
      aggregateId: invoiceId,
      occurredAt: at,
      commandId: envelope.command_id,
      payload: { docNumber, details: match.details },
    });
    return {
      status: 'APPLIED',
      serverRefs: {
        docNumber,
        status,
        ...(approvalRequestId !== null ? { approvalRequestId } : {}),
      },
      audit: {
        after: {
          status,
          docNumber,
          supplierId: p.supplierId,
          supplierInvoiceRef: p.supplierInvoiceRef,
          totalXaf: match.totalXaf,
          dueDate,
          purchaseOrderId: p.purchaseOrderId ?? null,
          mismatch: match.details,
          approvalRequestId,
        },
      },
    };
  }

  // --- finance.supplier_invoice.dispute, .approve, .cancel ---------------------------------------

  const withInvoice =
    (
      action: (
        uow: Uow,
        envelope: Envelope<SupplierInvoiceDecisionPayload>,
        invoice: NonNullable<Awaited<ReturnType<typeof loadSupplierInvoice>>>,
      ) => Promise<CommandHandlerOutcome>,
    ): CommandHandler<SupplierInvoiceDecisionPayload> =>
    async (uow, envelope) => {
      if (envelope.captured_offline) return ONLINE_REQUIRED;
      const invoice = await loadSupplierInvoice(uow, envelope.aggregate_id, { lock: 'update' });
      if (!invoice) return NOT_FOUND;
      try {
        return await action(uow, envelope, invoice);
      } catch (error) {
        return financeBusinessRejection(error);
      }
    };

  const dispute = withInvoice(async (uow, envelope, invoice) => {
    const at = new Date(envelope.occurred_at);
    await disputeSupplierInvoice(uow, {
      invoice,
      by: envelope.author_user_id,
      at,
      reason: envelope.payload.reason,
    });
    if (invoice.approvalRequestId !== null) {
      await cancelApprovalRequest(uow, {
        requestId: invoice.approvalRequestId,
        cancelledBy: envelope.author_user_id,
      });
    }
    return {
      status: 'APPLIED',
      serverRefs: { docNumber: invoice.docNumber, status: 'DISPUTED' },
      audit: {
        before: { status: invoice.status },
        after: { status: 'DISPUTED', reason: envelope.payload.reason },
      },
    };
  });

  const approve = withInvoice(async (uow, envelope, invoice) => {
    const at = new Date(envelope.occurred_at);
    const author = envelope.author_user_id;
    // Demande en attente : façade de la décision (permission, portée, auto-approbation, pièces).
    if (invoice.status === 'MISMATCH' && invoice.approvalRequestId !== null) {
      const decided = await decideApprovalRequest(uow, decisionRegistry, {
        requestId: invoice.approvalRequestId,
        decision: 'APPROVED',
        decidedBy: author,
        decidedAt: at,
        comment: envelope.payload.reason,
      });
      if (!decided.ok) return rejected(decided.errorCode, decided.messageFr);
    } else {
      // Facture contestée (demande retirée) ou écart sans politique : approbation directe.
      if (invoice.createdBy === author) {
        return rejected(
          'SELF_APPROVAL_FORBIDDEN',
          'Celui qui a saisi la facture ne peut pas l’approuver.',
        );
      }
      await approveSupplierInvoice(uow, idGenerator, {
        invoice,
        approvedBy: author,
        approvedAt: at,
        reason: envelope.payload.reason,
        commandId: envelope.command_id,
      });
    }
    return {
      status: 'APPLIED',
      serverRefs: { docNumber: invoice.docNumber, status: 'APPROVED' },
      audit: {
        before: { status: invoice.status },
        after: { status: 'APPROVED', reason: envelope.payload.reason },
      },
    };
  });

  const cancel = withInvoice(async (uow, envelope, invoice) => {
    const at = new Date(envelope.occurred_at);
    const author = envelope.author_user_id;
    const next = supplierInvoiceTransition(invoice.status, 'CANCEL', invoice.paidXaf);
    // Facture approuvée : ses quantités facturées sont retirées du BC (avoir, AV-272).
    if (invoice.status === 'APPROVED') {
      await applyInvoiceQuantities(uow, invoice, -1);
    }
    if (invoice.approvalRequestId !== null) {
      await cancelApprovalRequest(uow, {
        requestId: invoice.approvalRequestId,
        cancelledBy: author,
      });
    }
    await uow
      .updateTable('finance_supplier_invoices')
      .set({
        status: next,
        cancel_reason: envelope.payload.reason,
        cancelled_by: toBin(author),
        cancelled_at: at,
        updated_by: toBin(author),
        version: sql`version + 1`,
      })
      .where('id', '=', toBin(invoice.id))
      .execute();
    return {
      status: 'APPLIED',
      serverRefs: { docNumber: invoice.docNumber, status: next },
      audit: {
        before: { status: invoice.status },
        after: { status: next, reason: envelope.payload.reason },
      },
    };
  });

  // --- Décision INVOICE_MISMATCH ------------------------------------------------------------------

  decisionRegistry.register('INVOICE_MISMATCH', async (uow, ctx) => {
    const invoice = await loadSupplierInvoice(uow, ctx.subjectId, { lock: 'update' });
    if (!invoice)
      throw new ApprovalDecisionRefused('NOT_FOUND', 'Facture fournisseur introuvable.');
    if (invoice.status !== 'MISMATCH') {
      throw new ApprovalDecisionRefused(
        'INVOICE_STATUS_INVALID',
        `Facture ${invoice.status} : aucune décision attendue.`,
      );
    }
    if (ctx.decision === 'APPROVED') {
      // Revue de P8-14 (ADR-043 §5) : approbateur ≠ auteur, même par la commande générique.
      if (ctx.decidedBy === ctx.requestedBy) {
        throw new ApprovalDecisionRefused(
          'SELF_APPROVAL_FORBIDDEN',
          'Celui qui a saisi la facture ne peut pas approuver son écart.',
        );
      }
      // Revue de P8-14 (ADR-043 §3) : une décision informée — l'écart ne s'est pas aggravé depuis.
      const excess = await quantityExcessSinceRequest(uow, invoice, ctx.decidedAt);
      if (excess.length > 0) {
        throw new ApprovalDecisionRefused(
          'INVOICE_MATCHING_CHANGED',
          `Depuis la demande, une autre facture approuvée porte le facturé de ${excess.length} ligne(s) du bon de commande au-delà de l’accepté : rejetez la demande, puis approuvez directement la facture contestée en motivant.`,
        );
      }
      await approveSupplierInvoice(uow, idGenerator, {
        invoice,
        approvedBy: ctx.decidedBy,
        approvedAt: ctx.decidedAt,
        reason: 'Écart de rapprochement accepté (demande INVOICE_MISMATCH)',
        commandId: null,
      });
    } else {
      await disputeSupplierInvoice(uow, {
        invoice,
        by: ctx.decidedBy,
        at: ctx.decidedAt,
        reason: 'Écart de rapprochement refusé (demande INVOICE_MISMATCH)',
      });
    }
  });
  decisionRegistry.registerWithdrawalGuard('INVOICE_MISMATCH', async () => {
    throw new ApprovalDecisionRefused(
      'INVOICE_NOT_WITHDRAWABLE',
      'Une facture en écart se conteste ou s’annule ; sa demande ne se retire pas.',
    );
  });

  registry.register({
    commandType: 'finance.supplier_invoice.record',
    version: 1,
    payloadSchema: supplierInvoiceRecordPayloadSchema,
    permissionCode: INVOICE_RECORD_PERMISSION,
    handler: record,
  });
  for (const [verb, handler] of [
    ['dispute', dispute],
    ['approve', approve],
    ['cancel', cancel],
  ] as const) {
    registry.register({
      commandType: `finance.supplier_invoice.${verb}`,
      version: 1,
      payloadSchema: supplierInvoiceDecisionPayloadSchema,
      permissionCode: INVOICE_APPROVE_PERMISSION,
      handler,
    });
  }
}
