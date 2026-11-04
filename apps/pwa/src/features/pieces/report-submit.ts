/**
 * Envoi et suivi des reports de pièces papier (PP-B ; REQ-303, AV-308, AV-312, AV-078).
 * Construit la commande métier correspondante, applique l'heure du carnet, le motif d'antidatage
 * et la référence de la pièce papier (paper_ref / local_ref).
 */

import { clock, idGenerator } from '../../platform/composition.js';
import type { GicDatabase, OutboxCommand } from '../../storage/db.js';
import type { EnqueueInput, NewAttachment } from '../../sync/outbox.js';
import { photoAttachment, type PhotoTarget } from '../attachments/attachments.js';
import type { PreparedPhoto } from '../attachments/photo.js';
import { submitCommand } from '../sales/submit.js';
import { evaluateBackdating, normalizeSlipRef } from './registre-carnets.js';

export type ReportableSlipType = 'BV' | 'RE' | 'BD' | 'RF' | 'CC' | 'BL' | 'BR' | 'BT' | 'FP';

export interface ReportSlipDraft {
  readonly slipType: ReportableSlipType;
  readonly paperSlipRef: string;
  /** "YYYY-MM-DDTHH:mm" */
  readonly occurredAt: string;
  readonly backdatedReason: string;
  readonly siteId?: string | undefined;

  // Spécifique Bon de Vente (BV)
  readonly customerId?: string | undefined;
  readonly customerName?: string | undefined;
  readonly productId?: string | undefined;
  readonly quantity?: number | undefined;
  readonly unitPriceXaf?: number | undefined;
  readonly totalAmountXaf?: number | undefined;
  readonly paymentMethod?: 'CASH' | 'MOMO' | 'OM' | 'BANK_TRANSFER' | 'CREDIT' | undefined;
  readonly cashAccountId?: string | undefined;

  // Spécifique Reçu d'encaissement (RE)
  readonly rePaymentMethod?: 'CASH' | 'MOMO' | 'OM' | 'BANK_TRANSFER' | undefined;
  readonly reAmountXaf?: number | undefined;
  readonly reNotes?: string | undefined;

  // Spécifique Bon de Décaissement / Dépense (BD)
  readonly bdPayeeName?: string | undefined;
  readonly bdAmountXaf?: number | undefined;
  readonly bdDescription?: string | undefined;
  readonly bdCategoryId?: string | undefined;

  // Spécifique Remise de Fonds (RF)
  readonly rfSourceAccountId?: string | undefined;
  readonly rfDestinationAccountId?: string | undefined;
  readonly rfAmountXaf?: number | undefined;

  // Spécifique Commande Client (CC)
  readonly ccDeliveryDate?: string | undefined;

  // Spécifique Transfert (BT)
  readonly btSourceLocationId?: string | undefined;
  readonly btTargetLocationId?: string | undefined;

  // Spécifique Perte (FP)
  readonly fpReasonCodeId?: string | undefined;
  readonly fpNotes?: string | undefined;
}

export interface ReportedSlipRecord {
  readonly commandId: string;
  readonly slipType: ReportableSlipType;
  readonly paperSlipRef: string;
  readonly occurredAt: string;
  readonly submittedAt: string;
  readonly authorUserId: string;
  readonly description: string;
  readonly amountXaf?: number | null;
  readonly status: OutboxCommand['status'];
  readonly hasAttachment: boolean;
  readonly backdatedReason?: string | null;
}

/** Cible photo adaptée selon le type de pièce. */
function photoTargetFor(slipType: ReportableSlipType, aggregateId: string): PhotoTarget {
  switch (slipType) {
    case 'BD':
      return { kind: 'RECEIPT', ownerType: 'EXPENSE', cited: true, ownerId: aggregateId };
    case 'FP':
      return { kind: 'PHOTO', ownerType: 'STOCK_LOSS', cited: true, ownerId: aggregateId };
    case 'BR':
      return {
        kind: 'DELIVERY_NOTE',
        ownerType: 'GOODS_RECEIPT',
        cited: true,
        ownerId: aggregateId,
      };
    default:
      return { kind: 'RECEIPT', ownerType: 'EXPENSE', cited: true, ownerId: aggregateId };
  }
}

/**
 * Construit l'enveloppe de commande pour l'outbox à partir du brouillon de report.
 */
export function buildPaperSlipCommandInput(
  draft: ReportSlipDraft,
  authorUserId: string,
  photo?: PreparedPhoto | null,
  assignedAggregateId?: string,
): Omit<EnqueueInput, 'capturedOffline' | 'commandVersion'> {
  const aggregateId = assignedAggregateId ?? idGenerator.newId();
  const cleanRef = normalizeSlipRef(draft.paperSlipRef);
  const occurredIso = draft.occurredAt
    ? new Date(draft.occurredAt).toISOString()
    : clock.now().toISOString();

  const evalBackdate = evaluateBackdating(occurredIso, clock.now());
  const effectiveReason =
    draft.backdatedReason.trim() ||
    (evalBackdate.isBackdated ? `Report de pièce papier ${cleanRef} (AV-078)` : null);

  const localFlags = ['PAPER_SLIP', `SLIP_TYPE:${draft.slipType}`, `PAPER_REF:${cleanRef}`];

  const attachments: NewAttachment[] = [];
  if (photo) {
    attachments.push(photoAttachment(photo, photoTargetFor(draft.slipType, aggregateId)));
  }

  let commandType: string;
  let aggregateType: string;
  let payload: unknown;

  switch (draft.slipType) {
    case 'BV': {
      commandType = 'sales.sale.create';
      aggregateType = 'SALE';
      const qty = draft.quantity ?? 1;
      const unitPrice = draft.unitPriceXaf ?? 0;
      const total = draft.totalAmountXaf ?? qty * unitPrice;
      payload = {
        saleId: aggregateId,
        customerId: draft.customerId ?? null,
        saleChannel: 'TERRAIN',
        siteId: draft.siteId ?? null,
        localRef: cleanRef,
        paperSlipRef: cleanRef,
        items: draft.productId
          ? [
              {
                productId: draft.productId,
                quantity: qty,
                unitPriceXaf: unitPrice,
                lineTotalXaf: total,
                notes: `Pièce ${cleanRef}`,
              },
            ]
          : [],
        totalAmountXaf: total,
        payment:
          draft.paymentMethod && draft.paymentMethod !== 'CREDIT'
            ? {
                method: draft.paymentMethod,
                amountXaf: total,
                cashAccountId: draft.cashAccountId ?? null,
              }
            : null,
      };
      break;
    }
    case 'RE': {
      commandType = 'sales.payment.record';
      aggregateType = 'PAYMENT';
      payload = {
        paymentId: aggregateId,
        customerId: draft.customerId ?? null,
        amountXaf: draft.reAmountXaf ?? draft.totalAmountXaf ?? 0,
        paymentMethod: draft.rePaymentMethod ?? 'CASH',
        cashAccountId: draft.cashAccountId ?? null,
        localRef: cleanRef,
        paperSlipRef: cleanRef,
        notes: draft.reNotes ?? `Reçu papier ${cleanRef}`,
      };
      break;
    }
    case 'BD': {
      commandType = 'finance.expense.record';
      aggregateType = 'EXPENSE';
      payload = {
        expenseId: aggregateId,
        siteId: draft.siteId ?? null,
        cashAccountId: draft.cashAccountId ?? null,
        amountXaf: draft.bdAmountXaf ?? 0,
        payeeName: draft.bdPayeeName ?? 'Bénéficiaire sur pièce',
        description: draft.bdDescription ?? `Dépense sur pièce papier ${cleanRef}`,
        expenseCategoryId: draft.bdCategoryId ?? null,
        localRef: cleanRef,
        paperSlipRef: cleanRef,
      };
      break;
    }
    case 'RF': {
      commandType = 'finance.cash_transfer.create';
      aggregateType = 'CASH_TRANSFER';
      payload = {
        transferId: aggregateId,
        sourceAccountId: draft.rfSourceAccountId ?? null,
        destinationAccountId: draft.rfDestinationAccountId ?? null,
        amountXaf: draft.rfAmountXaf ?? 0,
        localRef: cleanRef,
        paperSlipRef: cleanRef,
        notes: `Remise de fonds papier ${cleanRef}`,
      };
      break;
    }
    case 'CC': {
      commandType = 'sales.sales_order.create';
      aggregateType = 'ORDER';
      payload = {
        orderId: aggregateId,
        customerId: draft.customerId ?? null,
        expectedDeliveryDate: draft.ccDeliveryDate ?? null,
        localRef: cleanRef,
        paperSlipRef: cleanRef,
        items: draft.productId
          ? [{ productId: draft.productId, quantity: draft.quantity ?? 1 }]
          : [],
      };
      break;
    }
    case 'BL': {
      commandType = 'sales.delivery_note.create';
      aggregateType = 'DELIVERY_NOTE';
      payload = {
        deliveryNoteId: aggregateId,
        customerId: draft.customerId ?? null,
        localRef: cleanRef,
        paperSlipRef: cleanRef,
        items: draft.productId
          ? [{ productId: draft.productId, quantity: draft.quantity ?? 1 }]
          : [],
      };
      break;
    }
    case 'BR': {
      commandType = 'procurement.goods_receipt.create';
      aggregateType = 'GOODS_RECEIPT';
      payload = {
        goodsReceiptId: aggregateId,
        siteId: draft.siteId ?? null,
        localRef: cleanRef,
        paperSlipRef: cleanRef,
        items: draft.productId
          ? [{ productId: draft.productId, quantity: draft.quantity ?? 1 }]
          : [],
      };
      break;
    }
    case 'BT': {
      commandType = 'inventory.stock_transfer.create';
      aggregateType = 'STOCK_TRANSFER';
      payload = {
        transferId: aggregateId,
        sourceLocationId: draft.btSourceLocationId ?? null,
        targetLocationId: draft.btTargetLocationId ?? null,
        localRef: cleanRef,
        paperSlipRef: cleanRef,
        items: draft.productId
          ? [{ productId: draft.productId, quantity: draft.quantity ?? 1 }]
          : [],
      };
      break;
    }
    case 'FP': {
      commandType = 'inventory.loss_declaration.create';
      aggregateType = 'STOCK_LOSS';
      payload = {
        lossDeclarationId: aggregateId,
        reasonCodeId: draft.fpReasonCodeId ?? null,
        localRef: cleanRef,
        paperSlipRef: cleanRef,
        notes: draft.fpNotes ?? `Perte sur fiche papier ${cleanRef}`,
        items: draft.productId
          ? [{ productId: draft.productId, quantity: draft.quantity ?? 1 }]
          : [],
      };
      break;
    }
  }

  return {
    authorUserId,
    commandType,
    aggregateType,
    aggregateId,
    payload,
    occurredAt: occurredIso,
    backdatedReason: effectiveReason,
    attachments: attachments.length > 0 ? attachments : undefined,
    localFlags,
  };
}

/** Enregistre le report de pièce papier dans l'outbox locale. */
export async function submitPaperSlipReport(
  draft: ReportSlipDraft,
  authorUserId: string,
  photo?: PreparedPhoto | null,
): Promise<OutboxCommand> {
  const input = buildPaperSlipCommandInput(draft, authorUserId, photo);
  return submitCommand(input);
}

/**
 * Charge les pièces papier reportées sur cet appareil à partir de l'outbox Dexie.
 */
export async function loadReportedSlipsFromDb(db: GicDatabase): Promise<ReportedSlipRecord[]> {
  const commands = await db.outbox.toArray();
  const reported: ReportedSlipRecord[] = [];

  for (const cmd of commands) {
    const flags = cmd.local_flags ?? [];
    if (!flags.includes('PAPER_SLIP')) continue;

    let slipType: ReportableSlipType = 'BV';
    let paperSlipRef = '';

    for (const flag of flags) {
      if (flag.startsWith('SLIP_TYPE:')) {
        slipType = flag.slice('SLIP_TYPE:'.length) as ReportableSlipType;
      } else if (flag.startsWith('PAPER_REF:')) {
        paperSlipRef = flag.slice('PAPER_REF:'.length);
      }
    }

    if (!paperSlipRef && typeof cmd.payload === 'object' && cmd.payload !== null) {
      const p = cmd.payload as Record<string, unknown>;
      paperSlipRef = String(p.paperSlipRef ?? p.localRef ?? '');
    }

    // Description et montant selon le type
    let description = `${slipType} ${paperSlipRef}`;
    let amountXaf: number | null = null;

    if (typeof cmd.payload === 'object' && cmd.payload !== null) {
      const p = cmd.payload as Record<string, unknown>;
      if (typeof p.totalAmountXaf === 'number') amountXaf = p.totalAmountXaf;
      else if (typeof p.amountXaf === 'number') amountXaf = p.amountXaf;

      if (typeof p.description === 'string') description = p.description;
      else if (typeof p.notes === 'string') description = p.notes;
      else if (typeof p.payeeName === 'string') description = `À : ${p.payeeName}`;
    }

    reported.push({
      commandId: cmd.command_id,
      slipType,
      paperSlipRef,
      occurredAt: cmd.occurred_at,
      submittedAt: cmd.client_created_at,
      authorUserId: cmd.author_user_id,
      description,
      amountXaf,
      status: cmd.status,
      hasAttachment: (cmd.attachment_ids ?? []).length > 0,
      backdatedReason: cmd.backdated_reason,
    });
  }

  // Tri anti-chronologique
  return reported.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
}
