/**
 * Réceptions de marchandises (D08-APP ; SM-RECEIPT ; CM §28 « livré ≠ rejeté ≠ accepté ») :
 * `procurement.receipt.record` (hors ligne possible), `.request_cancellation` et les décisions
 * `RECEIPT_WITHOUT_PO`, `RECEIPT_QUARANTINE`, `RECEIPT_CANCELLATION`.
 *
 * - Seule la quantité **acceptée** entre en stock (BR-APP-007, INV-STK-12), par un mouvement
 *   `PURCHASE_RECEIPT` `V_SUPPLIER` → emplacement de réception, au prix de la ligne de BC ou au
 *   prix déclaré sans BC (BR-APP-008 ; CMUP recalculé par `inventory`) ; lot fournisseur créé ou
 *   retrouvé pour un produit suivi par lot (`ensureSupplierLot`).
 * - Sur BC : lignes rattachées au même BC et au même produit (`PO_LINE_MISMATCH`), emplacement du
 *   site de livraison (`RECEIPT_LOCATION_INVALID`), BC envoyé ou partiellement reçu
 *   (`PO_NOT_RECEIVABLE` en ligne) ; reliquats et statut du BC suivent (`orderStatusFromLines`).
 *   Acceptation au-delà du commandé (tolérance `procurement.receipt_over_tolerance_pct`) :
 *   refusée en ligne (`OVER_RECEIPT`, BR-APP-010) ; hors ligne, selon
 *   `procurement.offline_over_receipt_mode` (AV-095) — quarantaine, ou application avec excédent
 *   tracé (`excess_qty_base`) et conflit informatif.
 * - Sans BC : fournisseur actif, prix déclaré ; stock immédiat, `POSTED_PENDING_REVIEW` jusqu'à la
 *   décision du responsable des achats (BR-APP-011).
 * - Doublon suspecté (bon de livraison déjà comptabilisé pour ce fournisseur, BR-APP-012) :
 *   `QUARANTINED`, **aucun effet stock** jusqu'à décision (INV-APP-03).
 * - Photo du bon de livraison exigée sans BC ou au-delà du paramètre de valeur (BR-APP-014) :
 *   pièce jointe citée dans la commande (`attachment_ids`, `PHOTO_REQUIRED`).
 * - Annulation d'une réception comptabilisée : validation, puis inverses des entrées au coût
 *   d'origine — impossible si le stock a déjà été consommé (BR-APP-013, `STOCK_UNAVAILABLE`).
 */
import { z } from 'zod';
import { sql } from 'kysely';
import {
  orderStatusFromLines,
  overReceiptQuantity,
  quantityFromDecimal,
  quantityToDecimal,
  receiptAcceptedValueXaf,
  receiptLineQuantities,
  receiptPhotoRequired,
  type IdGenerator,
  type OrderLineProgress,
} from '@gic/domain';
import type {
  CommandHandler,
  CommandHandlerRegistry,
} from '../../../../platform/sync/command-handler-registry.js';
import { loadCommandOrigin } from '../../../../platform/sync/command-origin.js';
import { recordConflict } from '../../../../platform/sync/conflicts.js';
import type { DocumentSequenceService } from '../../../../platform/document-sequences/document-sequence.service.js';
import { fromBin, toBin, toBinOrNull } from '../../../../platform/kysely/uuid-columns.js';
import { currentSettingValue } from '../../../organization/application/public/index.js';
import {
  ApprovalDecisionRefused,
  requestApproval,
  type ApprovalDecisionHandlerRegistry,
  type OperationType,
} from '../../../approvals/application/public/index.js';
import {
  findProductLotTracking,
  findReasonCode,
} from '../../../catalog/application/public/index.js';
import {
  InventoryMoveError,
  ensureSupplierLot,
  recordStockMove,
  virtualLocationId,
} from '../../../inventory/application/public/index.js';
import {
  CONTROL_POLICY_MISSING,
  DATE_ONLY,
  FORBIDDEN_SCOPE,
  activePolicy,
  domainRejection,
  isAllowed,
  loadPhysicalLocation,
  nonPurchasableProducts,
  numberSetting,
  rejected,
  unknownUnits,
  type Uow,
} from './shared.js';
import { emitGoodsReceiptChange, emitPurchaseOrderChange } from '../sync-changes.js';

const lineSchema = z.object({
  poLineId: z.string().uuid().optional(),
  productId: z.string().uuid(),
  unitCode: z.string().min(1).max(20),
  qtyDeliveredBase: z.number().positive(),
  qtyRejectedBase: z.number().nonnegative().optional(),
  rejectionReasonCodeId: z.string().uuid().optional(),
  /** Prix déclaré (réception sans BC) ; ignoré sur BC (prix de la ligne de BC, BR-APP-008). */
  unitCostXaf: z.number().int().nonnegative().optional(),
  supplierLotRef: z.string().trim().min(1).max(60).optional(),
  expiryDate: z.string().regex(DATE_ONLY).optional(),
});
type LineInput = z.infer<typeof lineSchema>;

const recordPayloadSchema = z.object({
  purchaseOrderId: z.string().uuid().optional(),
  supplierId: z.string().uuid(),
  locationId: z.string().uuid(),
  supplierDeliveryNoteRef: z.string().trim().min(1).max(60).optional(),
  observations: z.string().trim().max(4000).optional(),
  lines: z.array(lineSchema).min(1).max(200),
  localRef: z.string().trim().min(1).max(20).optional(),
});
type RecordPayload = z.infer<typeof recordPayloadSchema>;

const cancellationPayloadSchema = z.object({ reason: z.string().trim().min(1).max(2000) });

const NOT_FOUND = rejected('NOT_FOUND', 'Réception introuvable.');
const RECEIVABLE = ['SENT', 'PARTIALLY_RECEIVED'];
/** Réceptions comptabilisées (stock entré) : la clé d'unicité du bon de livraison les couvre. */
const POSTED_STATUSES = [
  'POSTED',
  'POSTED_PENDING_REVIEW',
  'REVIEW_REJECTED',
  'CANCELLATION_PENDING',
];

interface ResolvedLine {
  readonly id: string;
  readonly input: LineInput;
  readonly acceptedBase: number;
  readonly unitCostXaf: number;
  readonly poLineId: string | null;
}

async function stringSetting(uow: Uow, key: string, at: Date, fallback: string): Promise<string> {
  const value = await currentSettingValue(uow, { key, scopeType: 'GLOBAL', scopeId: null, at });
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function progressOf(line: {
  readonly ordered_qty_base: string;
  readonly accepted_qty_base: string;
  readonly closed_qty_base: string;
  readonly status: string;
}): OrderLineProgress {
  return {
    ordered: quantityFromDecimal(Number(line.ordered_qty_base)),
    accepted: quantityFromDecimal(Number(line.accepted_qty_base)),
    closed: quantityFromDecimal(Number(line.closed_qty_base)),
    cancelled: line.status === 'CANCELLED',
  };
}

const milli = (value: number) => Math.round(value * 1000);
const fromMilli = (value: number) => value / 1000;

/**
 * Comptabilise une réception : entrées en stock des quantités acceptées (lots fournisseur) et,
 * sur BC, quantités acceptées, excédent tracé et statuts des lignes et du BC.
 */
async function postReceipt(
  uow: Uow,
  deps: { readonly idGenerator: IdGenerator },
  input: {
    readonly receiptId: string;
    readonly occurredAt: Date;
    readonly createdBy: string;
    readonly createdDeviceId: string | null;
    readonly commandId: string | null;
    readonly capturedOffline: boolean;
  },
): Promise<void> {
  const receipt = await uow
    .selectFrom('procurement_goods_receipts')
    .select(['id', 'purchase_order_id', 'supplier_id', 'location_id', 'doc_number'])
    .where('id', '=', toBin(input.receiptId))
    .executeTakeFirstOrThrow();
  const lines = await uow
    .selectFrom('procurement_goods_receipt_lines')
    .selectAll()
    .where('receipt_id', '=', receipt.id)
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();
  const supplierLocation = await virtualLocationId(uow, 'V_SUPPLIER');
  let lineIndex = 0;
  for (const line of lines) {
    lineIndex += 1;
    const accepted = Number(line.qty_delivered_base) - Number(line.qty_rejected_base);
    if (milli(accepted) <= 0) continue;
    const productId = fromBin(line.product_id);
    const tracking = await findProductLotTracking(uow, productId);
    let lotId: string | null = null;
    if (tracking === 'REQUIRED' || (tracking === 'OPTIONAL' && line.supplier_lot_ref)) {
      lotId = await ensureSupplierLot(uow, deps, {
        productId,
        supplierId: fromBin(receipt.supplier_id),
        supplierLotRef: line.supplier_lot_ref,
        fallbackCode: `F:${receipt.doc_number}-${lineIndex}`,
        expiryDate: line.expiry_date ? formatDate(line.expiry_date) : null,
        originId: fromBin(line.id),
        fifoRankAt: input.occurredAt,
        createdBy: input.createdBy,
      });
      await uow
        .updateTable('procurement_goods_receipt_lines')
        .set({ stock_lot_id: toBin(lotId) })
        .where('id', '=', line.id)
        .execute();
    }
    await recordStockMove(uow, deps, {
      productId,
      ...(lotId !== null ? { lotId } : {}),
      quantityBase: fromMilli(milli(accepted)),
      fromLocationId: supplierLocation,
      toLocationId: fromBin(receipt.location_id),
      moveType: 'PURCHASE_RECEIPT',
      declaredUnitCostXaf: Number(line.unit_cost_xaf),
      occurredAt: input.occurredAt,
      sourceDocType: 'GOODS_RECEIPT',
      sourceDocId: input.receiptId,
      sourceLineId: fromBin(line.id),
      createdBy: input.createdBy,
      ...(input.createdDeviceId !== null ? { createdDeviceId: input.createdDeviceId } : {}),
      ...(input.commandId !== null ? { commandId: input.commandId } : {}),
      capturedOffline: input.capturedOffline,
      allowNegative: false,
    });
  }
  if (receipt.purchase_order_id) {
    await applyToOrder(uow, receipt.purchase_order_id, lines, +1);
  }
}

/** Ajoute (`sign` = 1) ou retire (−1) les quantités acceptées des lignes de BC ; statuts suivent. */
async function applyToOrder(
  uow: Uow,
  orderId: Buffer,
  receiptLines: readonly {
    readonly po_line_id: Buffer | null;
    readonly qty_delivered_base: string;
    readonly qty_rejected_base: string;
  }[],
  sign: 1 | -1,
): Promise<void> {
  const order = await uow
    .selectFrom('procurement_purchase_orders')
    .select(['id', 'status'])
    .where('id', '=', orderId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const acceptedByLine = new Map<string, number>();
  for (const line of receiptLines) {
    if (!line.po_line_id) continue;
    const key = fromBin(line.po_line_id);
    const accepted = milli(Number(line.qty_delivered_base)) - milli(Number(line.qty_rejected_base));
    acceptedByLine.set(key, (acceptedByLine.get(key) ?? 0) + accepted);
  }
  const lines = await uow
    .selectFrom('procurement_purchase_order_lines')
    .selectAll()
    .where('order_id', '=', order.id)
    .forUpdate()
    .execute();
  // Statuts suivis seulement pour un BC en réception : un BC clôturé ou annulé le reste (une
  // réception confirmée ou annulée après coup ne rouvre pas ses lignes).
  const receiving = ['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED'].includes(order.status);
  const progress: OrderLineProgress[] = [];
  for (const line of lines) {
    const delta = acceptedByLine.get(fromBin(line.id)) ?? 0;
    let accepted = milli(Number(line.accepted_qty_base));
    const ordered = milli(Number(line.ordered_qty_base));
    const closed = milli(Number(line.closed_qty_base));
    if (delta !== 0) {
      accepted = Math.max(0, accepted + sign * delta);
      // INV-APP-02 : tout dépassement du commandé est tracé comme excédent.
      const excess = Math.max(0, accepted + closed - ordered);
      const remaining = Math.max(0, ordered - accepted - closed);
      await uow
        .updateTable('procurement_purchase_order_lines')
        .set({
          accepted_qty_base: String(fromMilli(accepted)),
          excess_qty_base: String(fromMilli(excess)),
          ...(receiving && line.status !== 'CANCELLED'
            ? { status: remaining === 0 ? (closed > 0 ? 'CLOSED' : 'RECEIVED') : 'OPEN' }
            : {}),
        })
        .where('id', '=', line.id)
        .execute();
    }
    progress.push({
      ordered: quantityFromDecimal(fromMilli(ordered)),
      accepted: quantityFromDecimal(fromMilli(accepted)),
      closed: quantityFromDecimal(fromMilli(closed)),
      cancelled: line.status === 'CANCELLED',
    });
  }
  // Nouvelle version du BC à chaque changement de ses lignes (reliquats du jeu hors ligne).
  const status = receiving ? orderStatusFromLines(progress) : order.status;
  await uow
    .updateTable('procurement_purchase_orders')
    .set({ status, version: sql`version + 1` })
    .where('id', '=', order.id)
    .execute();
  await emitPurchaseOrderChange(uow, fromBin(order.id));
}

/** Forme `AAAA-MM-JJ` d'une colonne `DATE` lue (mysql2 : minuit local). */
function formatDate(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

function buildHandlers(idGenerator: IdGenerator, documentSequences: DocumentSequenceService) {
  const deps = { idGenerator };

  const record: CommandHandler<RecordPayload> = async (uow, envelope) => {
    const receiptId = envelope.aggregate_id;
    const replay = await uow
      .selectFrom('procurement_goods_receipts')
      .select('id')
      .where('id', '=', toBin(receiptId))
      .executeTakeFirst();
    if (replay) return { status: 'APPLIED' };

    const p = envelope.payload;
    const author = envelope.author_user_id;
    const at = new Date(envelope.occurred_at);
    const offline = envelope.captured_offline;
    const location = await loadPhysicalLocation(uow, p.locationId);
    if (!location || !location.isActive) {
      return rejected('REFERENCE_INVALID', 'Emplacement de réception inconnu, virtuel ou inactif.');
    }
    if (
      !(await isAllowed(uow, author, 'procurement.receipt.record', at, {
        siteId: location.site.id,
      }))
    ) {
      return FORBIDDEN_SCOPE;
    }
    const supplier = await uow
      .selectFrom('procurement_suppliers')
      .select(['id', 'status'])
      .where('id', '=', toBin(p.supplierId))
      .executeTakeFirst();
    if (!supplier) return rejected('REFERENCE_INVALID', 'Fournisseur inconnu.');

    const quarantineReasons: string[] = [];
    const order = p.purchaseOrderId
      ? await uow
          .selectFrom('procurement_purchase_orders')
          .selectAll()
          .where('id', '=', toBin(p.purchaseOrderId))
          .forUpdate()
          .executeTakeFirst()
      : undefined;
    const orderLines = new Map<string, Awaited<ReturnType<typeof loadOrderLines>>[number]>();
    if (p.purchaseOrderId) {
      if (!order) return rejected('REFERENCE_INVALID', 'Bon de commande introuvable.');
      if (fromBin(order.supplier_id) !== p.supplierId) {
        return rejected('SUPPLIER_MISMATCH', 'Fournisseur différent de celui du bon de commande.');
      }
      if (fromBin(order.site_id) !== location.site.id) {
        return rejected(
          'RECEIPT_LOCATION_INVALID',
          'Emplacement de réception hors du site de livraison du bon de commande.',
        );
      }
      if (!RECEIVABLE.includes(order.status)) {
        if (!offline) {
          return rejected('PO_NOT_RECEIVABLE', 'Bon de commande non envoyé, clôturé ou annulé.');
        }
        quarantineReasons.push('PO_NOT_RECEIVABLE');
      }
      for (const line of await loadOrderLines(uow, order.id))
        orderLines.set(fromBin(line.id), line);
    } else if (supplier.status !== 'ACTIVE') {
      return rejected('SUPPLIER_INACTIVE', 'Fournisseur inactif : réception sans BC impossible.');
    }

    const units = await unknownUnits(
      uow,
      p.lines.map((line) => line.unitCode),
    );
    if (units.length > 0)
      return rejected('REFERENCE_INVALID', `Unité inconnue : ${units.join(', ')}.`);
    if (!order) {
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
    }

    // Lignes : quantités (INV-APP-01), motif de rejet, rattachement au BC, coût figé.
    const resolved: ResolvedLine[] = [];
    const acceptingByPoLine = new Map<string, number>();
    try {
      for (const line of p.lines) {
        const quantities = receiptLineQuantities({
          delivered: quantityFromDecimal(line.qtyDeliveredBase),
          rejected: quantityFromDecimal(line.qtyRejectedBase ?? 0),
        });
        if (quantities.hasRejection) {
          if (!line.rejectionReasonCodeId) {
            return rejected(
              'REJECTION_REASON_REQUIRED',
              'Un motif est requis pour une quantité rejetée.',
            );
          }
          const reason = await findReasonCode(uow, line.rejectionReasonCodeId);
          if (!reason || reason.category !== 'REJECTION') {
            return rejected('REFERENCE_INVALID', 'Motif de rejet inconnu (catégorie REJECTION).');
          }
        }
        let unitCostXaf: number;
        let poLineId: string | null = null;
        if (order) {
          const poLine = line.poLineId ? orderLines.get(line.poLineId) : undefined;
          if (
            !poLine ||
            poLine.status === 'CANCELLED' ||
            fromBin(poLine.product_id) !== line.productId
          ) {
            return rejected(
              'PO_LINE_MISMATCH',
              'Chaque ligne doit se rattacher à une ligne active du même BC, pour le même produit.',
            );
          }
          poLineId = line.poLineId!;
          unitCostXaf = Number(poLine.unit_price_xaf);
        } else {
          if (line.unitCostXaf === undefined) {
            return rejected(
              'PRICE_REQUIRED',
              'Prix déclaré requis pour une réception sans BC (BR-APP-011).',
            );
          }
          unitCostXaf = line.unitCostXaf;
        }
        const acceptedBase = quantityToDecimal(quantities.accepted);
        if (poLineId !== null) {
          acceptingByPoLine.set(
            poLineId,
            (acceptingByPoLine.get(poLineId) ?? 0) + milli(acceptedBase),
          );
        }
        resolved.push({
          id: idGenerator.newId(),
          input: line,
          acceptedBase,
          unitCostXaf,
          poLineId,
        });
      }
    } catch (error) {
      return domainRejection(error);
    }

    // BR-APP-010 : acceptation au-delà du commandé (tolérance paramétrée).
    let applyExcess = false;
    const excessByPoLine = new Map<string, number>();
    if (order) {
      const tolerance = await numberSetting(uow, 'procurement.receipt_over_tolerance_pct', at, 0);
      for (const [poLineId, accepting] of acceptingByPoLine) {
        const over = overReceiptQuantity(
          progressOf(orderLines.get(poLineId)!),
          quantityFromDecimal(fromMilli(accepting)),
          tolerance,
        );
        if (quantityToDecimal(over) > 0)
          excessByPoLine.set(poLineId, milli(quantityToDecimal(over)));
      }
      if (excessByPoLine.size > 0) {
        if (!offline) {
          return rejected(
            'OVER_RECEIPT',
            'Acceptation supérieure à la quantité commandée : réceptionner le reliquat seulement (BR-APP-010).',
          );
        }
        const mode = await stringSetting(
          uow,
          'procurement.offline_over_receipt_mode',
          at,
          'QUARANTINE',
        );
        if (mode === 'APPLY_WITH_REVIEW') applyExcess = true;
        else quarantineReasons.push('OVER_RECEIPT');
      }
    }

    // BR-APP-012 : bon de livraison déjà comptabilisé pour ce fournisseur.
    if (p.supplierDeliveryNoteRef) {
      const duplicate = await uow
        .selectFrom('procurement_goods_receipts')
        .select('id')
        .where('supplier_id', '=', toBin(p.supplierId))
        .where('supplier_delivery_note_ref', '=', p.supplierDeliveryNoteRef)
        .where('status', 'in', POSTED_STATUSES)
        .executeTakeFirst();
      if (duplicate) quarantineReasons.push('DUPLICATE_DELIVERY_NOTE');
    }

    const acceptedValue = receiptAcceptedValueXaf(
      resolved.map((line) => ({
        accepted: quantityFromDecimal(line.acceptedBase),
        unitCostXaf: line.unitCostXaf,
      })),
    );
    const photoThreshold = await numberSetting(
      uow,
      'procurement.receipt_photo_threshold_xaf',
      at,
      100_000,
    );
    if (
      receiptPhotoRequired({
        withoutOrder: !order,
        acceptedValueXaf: acceptedValue,
        thresholdXaf: photoThreshold,
      }) &&
      envelope.attachment_ids.length === 0
    ) {
      return rejected('PHOTO_REQUIRED', 'Photo du bon de livraison requise (BR-APP-014).');
    }

    const status =
      quarantineReasons.length > 0 ? 'QUARANTINED' : order ? 'POSTED' : 'POSTED_PENDING_REVIEW';
    const operationType: OperationType | null =
      status === 'QUARANTINED'
        ? 'RECEIPT_QUARANTINE'
        : status === 'POSTED_PENDING_REVIEW'
          ? 'RECEIPT_WITHOUT_PO'
          : null;
    const policy = operationType ? await activePolicy(uow, operationType, at) : undefined;
    if (operationType && !policy) return CONTROL_POLICY_MISSING(operationType);

    const origin = await loadCommandOrigin(uow, envelope.command_id);
    const docNumber = await documentSequences.next(uow, {
      docType: 'REC',
      siteId: location.site.id,
      codeSite: location.site.code,
      year: at.getUTCFullYear(),
    });
    let approvalRequestId: string | null = null;
    if (operationType && policy) {
      approvalRequestId = idGenerator.newId();
      await requestApproval(uow, {
        requestId: approvalRequestId,
        operationType,
        subjectType: 'GOODS_RECEIPT',
        subjectId: receiptId,
        subjectSummary:
          status === 'QUARANTINED'
            ? `Réception ${docNumber} en quarantaine (${quarantineReasons.join(', ')})`
            : `Réception sans bon de commande ${docNumber}`,
        siteId: location.site.id,
        amountXaf: acceptedValue,
        requestedBy: author,
        requestedAt: at,
        policyId: policy.id,
        policyVersion: policy.version,
        // BR-ADM-020 : la photo du bon de livraison doit être reçue avant la décision.
        ...(envelope.attachment_ids.length > 0
          ? { requiredAttachmentIds: envelope.attachment_ids }
          : {}),
      });
    }
    await uow
      .insertInto('procurement_goods_receipts')
      .values({
        id: toBin(receiptId),
        doc_number: docNumber,
        local_ref: p.localRef ?? null,
        site_id: toBin(location.site.id),
        purchase_order_id: toBinOrNull(p.purchaseOrderId ?? null),
        supplier_id: toBin(p.supplierId),
        location_id: toBin(location.id),
        received_by: toBin(author),
        supplier_delivery_note_ref: p.supplierDeliveryNoteRef ?? null,
        observations: p.observations ?? null,
        status,
        approval_request_id: toBinOrNull(approvalRequestId),
        total_accepted_value_xaf: acceptedValue,
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
    // Excédent constaté à la saisie (BR-APP-010), réparti sur les lignes de réception du même
    // BC dans l'ordre de saisie — appliqué (APPLY_WITH_REVIEW) ou en quarantaine.
    const remainingExcess = new Map(excessByPoLine);
    for (const line of resolved) {
      let over = 0;
      if (line.poLineId !== null && remainingExcess.has(line.poLineId)) {
        const left = remainingExcess.get(line.poLineId) ?? 0;
        over = Math.min(left, milli(line.acceptedBase));
        remainingExcess.set(line.poLineId, left - over);
      }
      await uow
        .insertInto('procurement_goods_receipt_lines')
        .values({
          id: toBin(line.id),
          receipt_id: toBin(receiptId),
          po_line_id: toBinOrNull(line.poLineId),
          product_id: toBin(line.input.productId),
          unit_code: line.input.unitCode,
          qty_delivered_base: String(line.input.qtyDeliveredBase),
          qty_rejected_base: String(line.input.qtyRejectedBase ?? 0),
          over_receipt_qty_base: String(fromMilli(over)),
          rejection_reason_code_id: toBinOrNull(line.input.rejectionReasonCodeId ?? null),
          unit_cost_xaf: line.unitCostXaf,
          supplier_lot_ref: line.input.supplierLotRef ?? null,
          expiry_date: line.input.expiryDate ? sql<Date>`${line.input.expiryDate}` : null,
        })
        .execute();
    }

    if (status !== 'QUARANTINED') {
      await postReceipt(uow, deps, {
        receiptId,
        occurredAt: at,
        createdBy: author,
        createdDeviceId: origin.deviceId,
        commandId: envelope.command_id,
        capturedOffline: offline,
      });
    }
    await emitGoodsReceiptChange(uow, receiptId);

    if (status === 'QUARANTINED') {
      return {
        status: 'APPLIED_WITH_WARNINGS',
        warnings: ['RECEIPT_QUARANTINED'],
        serverRefs: { docNumber },
      };
    }
    if (applyExcess) {
      await recordConflict(uow, {
        id: idGenerator.newId(),
        commandId: envelope.command_id,
        conflictType: 'OVER_RECEIPT',
        entityType: 'GOODS_RECEIPT',
        entityId: receiptId,
        siteId: location.site.id,
        ownerRole: 'RESP_ACHATS',
        applied: true,
        details: {
          purchaseOrderId: p.purchaseOrderId,
          excessBaseByPoLine: Object.fromEntries(
            [...excessByPoLine].map(([poLineId, excess]) => [poLineId, fromMilli(excess)]),
          ),
        },
      });
      return {
        status: 'APPLIED_WITH_WARNINGS',
        warnings: ['OVER_RECEIPT'],
        serverRefs: { docNumber },
      };
    }
    return { status: 'APPLIED', serverRefs: { docNumber } };
  };

  /** BR-APP-013 : demande d'annulation d'une réception comptabilisée (validation). */
  const requestCancellation: CommandHandler<z.infer<typeof cancellationPayloadSchema>> = async (
    uow,
    envelope,
  ) => {
    const receipt = await uow
      .selectFrom('procurement_goods_receipts')
      .select(['id', 'status', 'site_id', 'doc_number', 'total_accepted_value_xaf'])
      .where('id', '=', toBin(envelope.aggregate_id))
      .forUpdate()
      .executeTakeFirst();
    if (!receipt) return NOT_FOUND;
    if (receipt.status !== 'POSTED') {
      return rejected(
        'RECEIPT_STATUS_INVALID',
        'Seule une réception comptabilisée peut être annulée.',
      );
    }
    const at = new Date(envelope.occurred_at);
    const siteId = fromBin(receipt.site_id);
    if (
      !(await isAllowed(uow, envelope.author_user_id, 'procurement.receipt.record', at, { siteId }))
    ) {
      return FORBIDDEN_SCOPE;
    }
    const policy = await activePolicy(uow, 'RECEIPT_CANCELLATION', at);
    if (!policy) return CONTROL_POLICY_MISSING('RECEIPT_CANCELLATION');
    const approvalRequestId = idGenerator.newId();
    await requestApproval(uow, {
      requestId: approvalRequestId,
      operationType: 'RECEIPT_CANCELLATION',
      subjectType: 'GOODS_RECEIPT',
      subjectId: envelope.aggregate_id,
      subjectSummary: envelope.payload.reason,
      siteId,
      amountXaf: Number(receipt.total_accepted_value_xaf),
      requestedBy: envelope.author_user_id,
      requestedAt: at,
      policyId: policy.id,
      policyVersion: policy.version,
    });
    await uow
      .updateTable('procurement_goods_receipts')
      .set({
        status: 'CANCELLATION_PENDING',
        approval_request_id: toBin(approvalRequestId),
        updated_by: toBin(envelope.author_user_id),
        version: sql`version + 1`,
      })
      .where('id', '=', receipt.id)
      .execute();
    await emitGoodsReceiptChange(uow, envelope.aggregate_id);
    return { status: 'APPLIED' };
  };

  return { record, requestCancellation };
}

async function loadOrderLines(uow: Uow, orderId: Buffer) {
  return uow
    .selectFrom('procurement_purchase_order_lines')
    .selectAll()
    .where('order_id', '=', orderId)
    .forUpdate()
    .execute();
}

async function lockReceipt(uow: Uow, receiptId: string) {
  return uow
    .selectFrom('procurement_goods_receipts')
    .selectAll()
    .where('id', '=', toBin(receiptId))
    .forUpdate()
    .executeTakeFirst();
}

function registerReceiptDecisions(
  decisionRegistry: ApprovalDecisionHandlerRegistry,
  idGenerator: IdGenerator,
): void {
  const deps = { idGenerator };
  const setStatus = async (
    uow: Uow,
    receiptId: Buffer,
    status: string,
    decidedBy: string,
    extra = {},
  ) => {
    await uow
      .updateTable('procurement_goods_receipts')
      .set({ status, ...extra, updated_by: toBin(decidedBy), version: sql`version + 1` })
      .where('id', '=', receiptId)
      .execute();
  };

  // BR-APP-011 : réception sans BC — validée (POSTED) ou rejetée (le stock reste : fait physique).
  decisionRegistry.register('RECEIPT_WITHOUT_PO', async (uow, ctx) => {
    const receipt = await lockReceipt(uow, ctx.subjectId);
    if (!receipt || receipt.status !== 'POSTED_PENDING_REVIEW') return;
    await setStatus(
      uow,
      receipt.id,
      ctx.decision === 'APPROVED' ? 'POSTED' : 'REVIEW_REJECTED',
      ctx.decidedBy,
    );
    await emitGoodsReceiptChange(uow, ctx.subjectId);
  });

  // BR-APP-012 : quarantaine — réception distincte confirmée (comptabilisée) ou doublon (REJECTED).
  decisionRegistry.register('RECEIPT_QUARANTINE', async (uow, ctx) => {
    const receipt = await lockReceipt(uow, ctx.subjectId);
    if (!receipt || receipt.status !== 'QUARANTINED') return;
    if (ctx.decision === 'REJECTED') {
      await setStatus(uow, receipt.id, 'REJECTED', ctx.decidedBy);
      await emitGoodsReceiptChange(uow, ctx.subjectId);
      return;
    }
    if (receipt.purchase_order_id) {
      const order = await uow
        .selectFrom('procurement_purchase_orders')
        .select('status')
        .where('id', '=', receipt.purchase_order_id)
        .executeTakeFirstOrThrow();
      // BC envoyé (ou reçu, ou clôturé : l'acceptation part alors en excédent tracé) ; un BC
      // non envoyé se marque d'abord envoyé, un BC annulé impose une réception sans BC.
      if (!['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'].includes(order.status)) {
        throw new ApprovalDecisionRefused(
          'PO_NOT_RECEIVABLE',
          'Bon de commande non envoyé ou annulé : le marquer envoyé, ou rejeter cette réception et la ressaisir sans BC.',
        );
      }
    }
    // Confirmée distincte : retirée de la clé d'unicité du bon de livraison avant comptabilisation.
    await setStatus(uow, receipt.id, 'POSTED', ctx.decidedBy, {
      distinct_note_confirmed: receipt.supplier_delivery_note_ref !== null ? 1 : 0,
    });
    await postReceipt(uow, deps, {
      receiptId: ctx.subjectId,
      occurredAt: receipt.occurred_at,
      createdBy: ctx.decidedBy,
      createdDeviceId: null,
      commandId: null,
      capturedOffline: false,
    });
    await emitGoodsReceiptChange(uow, ctx.subjectId);
  });

  // BR-APP-013 : annulation — inverses des entrées au coût d'origine, reliquats rétablis.
  decisionRegistry.register('RECEIPT_CANCELLATION', async (uow, ctx) => {
    const receipt = await lockReceipt(uow, ctx.subjectId);
    if (!receipt || receipt.status !== 'CANCELLATION_PENDING') return;
    if (ctx.decision === 'REJECTED') {
      await setStatus(uow, receipt.id, 'POSTED', ctx.decidedBy);
      await emitGoodsReceiptChange(uow, ctx.subjectId);
      return;
    }
    const supplierLocation = await virtualLocationId(uow, 'V_SUPPLIER');
    const moves = await uow
      .selectFrom('inventory_stock_moves')
      .select(['id', 'product_id', 'lot_id', 'quantity', 'source_line_id'])
      .where('source_doc_type', '=', 'GOODS_RECEIPT')
      .where('source_doc_id', '=', receipt.id)
      .where('move_type', '=', 'PURCHASE_RECEIPT')
      .execute();
    for (const move of moves) {
      try {
        await recordStockMove(uow, deps, {
          productId: fromBin(move.product_id),
          ...(move.lot_id ? { lotId: fromBin(move.lot_id) } : {}),
          quantityBase: Number(move.quantity),
          fromLocationId: fromBin(receipt.location_id),
          toLocationId: supplierLocation,
          moveType: 'SUPPLIER_RETURN',
          reversesMoveId: fromBin(move.id),
          occurredAt: ctx.decidedAt,
          sourceDocType: 'GOODS_RECEIPT',
          sourceDocId: ctx.subjectId,
          ...(move.source_line_id ? { sourceLineId: fromBin(move.source_line_id) } : {}),
          createdBy: ctx.decidedBy,
          allowNegative: false,
        });
      } catch (error) {
        if (error instanceof InventoryMoveError && error.code === 'INSUFFICIENT_STOCK') {
          throw new ApprovalDecisionRefused(
            'STOCK_UNAVAILABLE',
            'Stock de la réception déjà consommé : annulation impossible, passer par un retour fournisseur (BR-APP-013).',
          );
        }
        throw error;
      }
    }
    if (receipt.purchase_order_id) {
      const lines = await uow
        .selectFrom('procurement_goods_receipt_lines')
        .select(['po_line_id', 'qty_delivered_base', 'qty_rejected_base'])
        .where('receipt_id', '=', receipt.id)
        .execute();
      await applyToOrder(uow, receipt.purchase_order_id, lines, -1);
    }
    // [STD-CANCEL] : auteur et motif de la demande d'annulation, validation qui l'autorise.
    await setStatus(uow, receipt.id, 'CANCELLED', ctx.decidedBy, {
      cancelled_at: ctx.decidedAt,
      cancelled_by: toBin(ctx.requestedBy),
      cancel_comment: ctx.subjectSummary,
      cancel_approval_request_id: toBin(ctx.requestId),
    });
    await emitGoodsReceiptChange(uow, ctx.subjectId);
  });
}

export function registerReceiptCommands(
  registry: CommandHandlerRegistry,
  decisionRegistry: ApprovalDecisionHandlerRegistry,
  idGenerator: IdGenerator,
  documentSequences: DocumentSequenceService,
): void {
  const handlers = buildHandlers(idGenerator, documentSequences);
  registry.register({
    commandType: 'procurement.receipt.record',
    version: 1,
    payloadSchema: recordPayloadSchema,
    permissionCode: 'procurement.receipt.record',
    handler: handlers.record,
  });
  registry.register({
    commandType: 'procurement.receipt.request_cancellation',
    version: 1,
    payloadSchema: cancellationPayloadSchema,
    permissionCode: 'procurement.receipt.record',
    handler: handlers.requestCancellation,
  });
  registerReceiptDecisions(decisionRegistry, idGenerator);
}
