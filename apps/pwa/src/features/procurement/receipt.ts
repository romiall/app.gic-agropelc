/**
 * ECR-APP-04 « RÉCEPTIONNER » sur bon de commande (UC-APP-07 ; BR-APP-007 à 014) : logique pure.
 *
 * - Bons de commande envoyés ou reçus en partie (jeu `procurement`), livrés sur un emplacement tenu
 *   par l'appareil ou sur son site ; reliquat du serveur diminué des réceptions de l'appareil en vol.
 * - Par ligne : livré, rejeté (motif `REJECTION` exigé, BR-APP-007), accepté = livré − rejeté
 *   (`receiptLineQuantities`, même calcul que le serveur) ; lot fournisseur et péremption facultatifs.
 * - Au-delà du reliquat (tolérance `procurement.receipt_over_tolerance_pct`, 0 par défaut,
 *   `overReceiptQuantity`) : refusé en ligne (`OVER_RECEIPT`), mis en quarantaine hors ligne
 *   (BR-APP-010, AV-095).
 * - Sans bon de commande : non proposé, la photo du bon de livraison y est toujours exigée et
 *   l'application ne sait pas encore la joindre (S-16, S-24).
 */
import {
  DomainError,
  overReceiptQuantity,
  quantityFromDecimal,
  quantityToDecimal,
  receiptLineQuantities,
} from '@gic/domain';
import type { OutboxCommand } from '../../storage/db.js';
import { stillInFlight } from '../sales/pending.js';
import { MAX_QUANTITY } from '../sales/sale-form.js';
import type { LocationData, PurchaseOrderData } from '../sales/types.js';

export const DEFAULT_OVER_TOLERANCE_PCT = 0;
export const MAX_DELIVERY_NOTE_REF = 60;
export const MAX_OBSERVATIONS = 4000;
export const MAX_LOT_REF = 60;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

interface ReceiptPayload {
  readonly purchaseOrderId?: string;
  readonly lines?: readonly {
    readonly poLineId?: string;
    readonly qtyDeliveredBase?: number;
    readonly qtyRejectedBase?: number;
  }[];
}

/** Acceptations des réceptions de l'appareil pas encore retéléchargées, par ligne de bon de commande. */
export function inFlightAccepted(
  outbox: readonly OutboxCommand[],
  pulledAt: string | undefined,
): Map<string, number> {
  const milli = new Map<string, number>();
  for (const command of outbox) {
    if (command.command_type !== 'procurement.receipt.record') continue;
    if (!stillInFlight(command, pulledAt)) continue;
    for (const line of (command.payload as ReceiptPayload).lines ?? []) {
      if (!line.poLineId || !line.qtyDeliveredBase) continue;
      const accepted =
        Math.round(line.qtyDeliveredBase * 1000) - Math.round((line.qtyRejectedBase ?? 0) * 1000);
      milli.set(line.poLineId, (milli.get(line.poLineId) ?? 0) + Math.max(0, accepted));
    }
  }
  return new Map([...milli].map(([id, value]) => [id, value / 1000]));
}

/** Bons de commande à recevoir sur les emplacements (ou les sites) de l'appareil. */
export function receivableOrders(
  orders: readonly PurchaseOrderData[],
  held: readonly LocationData[],
): PurchaseOrderData[] {
  const locations = new Set(held.map((location) => location.id));
  const sites = new Set(held.map((location) => location.site_id).filter(Boolean));
  return orders
    .filter(
      (order) =>
        (order.status === 'SENT' || order.status === 'PARTIALLY_RECEIVED') &&
        ((order.delivery_location_id !== null && locations.has(order.delivery_location_id)) ||
          sites.has(order.site_id)),
    )
    .sort(
      (a, b) =>
        (a.expected_delivery_date ?? '9999').localeCompare(b.expected_delivery_date ?? '9999') ||
        a.doc_number.localeCompare(b.doc_number),
    );
}

export interface ReceiptLineDraft {
  readonly deliveredText: string;
  readonly rejectedText: string;
  readonly reasonId: string;
  readonly lotRef: string;
  readonly expiryDate: string;
}

export const EMPTY_LINE: ReceiptLineDraft = {
  deliveredText: '',
  rejectedText: '',
  reasonId: '',
  lotRef: '',
  expiryDate: '',
};

export type ReceiptLineIssue =
  'QUANTITY_INVALID' | 'REJECTED_OVER_DELIVERED' | 'REASON_REQUIRED' | 'EXPIRY_INVALID';

export interface ReceiptLineCheck {
  /** `null` : ligne non livrée (laissée vide), non envoyée. */
  readonly delivered: number | null;
  readonly rejected: number;
  readonly accepted: number;
  /** Part acceptée au-delà de ce que la ligne admet (reliquat et tolérance). */
  readonly over: number;
  readonly issues: readonly ReceiptLineIssue[];
}

const parseQty = (text: string): number | null => {
  const normalized = text.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,3})?$/.test(normalized)) return null;
  const value = Number(normalized);
  return value <= MAX_QUANTITY ? value : null;
};

export function checkReceiptLine(
  line: PurchaseOrderData['lines'][number],
  draft: ReceiptLineDraft,
  inFlight: number,
  tolerancePct: number,
): ReceiptLineCheck {
  const issues: ReceiptLineIssue[] = [];
  if (draft.deliveredText.trim() === '') {
    return { delivered: null, rejected: 0, accepted: 0, over: 0, issues };
  }
  const delivered = parseQty(draft.deliveredText);
  const rejected = draft.rejectedText.trim() === '' ? 0 : parseQty(draft.rejectedText);
  if (delivered === null || delivered <= 0 || rejected === null) {
    return { delivered: null, rejected: 0, accepted: 0, over: 0, issues: ['QUANTITY_INVALID'] };
  }
  let accepted = 0;
  try {
    accepted = quantityToDecimal(
      receiptLineQuantities({
        delivered: quantityFromDecimal(delivered),
        rejected: quantityFromDecimal(rejected),
      }).accepted,
    );
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    issues.push('REJECTED_OVER_DELIVERED');
  }
  if (rejected > 0 && !draft.reasonId) issues.push('REASON_REQUIRED');
  if (draft.expiryDate && !DATE_ONLY.test(draft.expiryDate)) issues.push('EXPIRY_INVALID');
  let over = 0;
  try {
    over = quantityToDecimal(
      overReceiptQuantity(
        {
          ordered: quantityFromDecimal(Number(line.ordered_qty_base)),
          accepted: quantityFromDecimal(
            Math.round((Number(line.accepted_qty_base) + inFlight) * 1000) / 1000,
          ),
          closed: quantityFromDecimal(Number(line.closed_qty_base)),
        },
        quantityFromDecimal(accepted),
        tolerancePct,
      ),
    );
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
  }
  return { delivered, rejected, accepted, over, issues };
}

/** Reliquat local de la ligne : celui du serveur, diminué des réceptions de l'appareil en vol. */
export const localRemaining = (
  line: PurchaseOrderData['lines'][number],
  inFlight: number,
): number => Math.max(0, Math.round((Number(line.remaining_qty_base) - inFlight) * 1000) / 1000);

const optionalText = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

/** Charge utile de `procurement.receipt.record` sur bon de commande (sans `localRef`). */
export function receiptPayload(input: {
  readonly order: PurchaseOrderData;
  readonly locationId: string;
  readonly deliveryNoteRef: string;
  readonly observations: string;
  readonly lines: readonly {
    readonly line: PurchaseOrderData['lines'][number];
    readonly draft: ReceiptLineDraft;
    readonly check: ReceiptLineCheck;
  }[];
}) {
  const deliveryNote = optionalText(input.deliveryNoteRef);
  const observations = optionalText(input.observations);
  return {
    purchaseOrderId: input.order.id,
    supplierId: input.order.supplier_id,
    locationId: input.locationId,
    ...(deliveryNote ? { supplierDeliveryNoteRef: deliveryNote } : {}),
    ...(observations ? { observations } : {}),
    lines: input.lines
      .filter(({ check }) => check.delivered !== null)
      .map(({ line, draft, check }) => {
        const lotRef = optionalText(draft.lotRef);
        return {
          poLineId: line.id,
          productId: line.product_id,
          unitCode: line.unit_code,
          qtyDeliveredBase: check.delivered as number,
          ...(check.rejected > 0
            ? { qtyRejectedBase: check.rejected, rejectionReasonCodeId: draft.reasonId }
            : {}),
          ...(lotRef ? { supplierLotRef: lotRef } : {}),
          ...(draft.expiryDate ? { expiryDate: draft.expiryDate } : {}),
        };
      }),
  };
}
