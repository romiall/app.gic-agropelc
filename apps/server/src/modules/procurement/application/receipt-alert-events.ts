/**
 * Détection d'alertes d'achats (P9-09 ; D13 §7.1 `RECEIPT_INCOMPLETE` et `DUPLICATE_SUSPECTED` côté
 * réception ; BR-APP-015, BR-APP-012 ; ADR-061 §2, §3 ; AV-360, AV-414, AV-415).
 *
 * - **`RECEIPT_INCOMPLETE`** : un bon de commande (BC) avec un reliquat, dont la date prévue est dépassée
 *   de plus de `procurement.receipt_incomplete_alert_days` jours **ou** dont une réception comptée porte une
 *   quantité rejetée (règle pure `receiptIncompleteState`). Deux producteurs d'une même alerte d'état :
 *   la tâche quotidienne (`receipt-incomplete-job.ts`, passe à identité) et la détection **sur réception**
 *   ci-dessous, qui publie l'état du BC à chaque changement de ses quantités acceptées (réception
 *   comptabilisée, quarantaine approuvée, annulation de réception) : `ReceiptIncompleteDetected` si le BC
 *   est incomplet, `ReceiptIncompleteCleared` sinon (sujet : le BC dans les deux cas).
 * - **`GoodsReceiptQuarantined`** : publié à la mise en quarantaine d'une réception (doublon du bon de
 *   livraison, dépassement hors ligne, BC non réceptionnable hors ligne), avec ses raisons ;
 *   **`GoodsReceiptQuarantineDecided`** à la décision de validation (approuvée ou rejetée) ferme l'alerte.
 *
 * Aucune fonction ne lève sur une donnée : ces publications s'exécutent dans la transaction d'un fait
 * accompli (BR-SYN-007). Aucune valeur au coût n'entre dans une charge utile (RC-05).
 */
import {
  businessDayOf,
  receiptIncompleteAlertDaysOrDefault,
  receiptIncompleteState,
  type Clock,
  type IdGenerator,
  type ReceiptIncompleteLine,
  type ReceiptIncompleteState,
} from '@gic/domain';
import {
  detectionPassId,
  publishDetectionEvent,
} from '../../../platform/events/detection-events.js';
import { fromBin, toBin } from '../../../platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../../../platform/unit-of-work.js';
import { findProduct } from '../../catalog/application/public/index.js';
import { currentSettingValue } from '../../organization/application/public/index.js';

const PRODUCER = 'procurement';

/** Réceptions dont les quantités comptent au BC (stock entré) ; SM-RECEIPT. */
export const COUNTED_RECEIPT_STATUSES = [
  'POSTED',
  'POSTED_PENDING_REVIEW',
  'REVIEW_REJECTED',
  'CANCELLATION_PENDING',
] as const;

/** Statuts d'un BC en cours de réception (candidats de la passe quotidienne). */
export const RECEIVING_ORDER_STATUSES = ['SENT', 'PARTIALLY_RECEIVED'] as const;

export interface ProcurementAlertDeps {
  readonly idGenerator: IdGenerator;
  readonly clock?: Clock | undefined;
}

/** Instant de détection : horloge de l'appelant, à défaut celle du serveur (AV-407). */
function detectionInstant(deps: { readonly clock?: Clock | undefined }): Date {
  return deps.clock?.now() ?? new Date();
}

/** Délai d'alerte de réception incomplète (réglage global, repli du domaine). */
export async function receiptIncompleteThresholdDays(uow: UnitOfWork, at: Date): Promise<number> {
  return receiptIncompleteAlertDaysOrDefault(
    await currentSettingValue(uow, {
      key: 'procurement.receipt_incomplete_alert_days',
      scopeType: 'GLOBAL',
      scopeId: null,
      at,
    }),
  );
}

export interface OrderIncompleteInfo {
  readonly orderId: string;
  readonly docNumber: string;
  readonly siteId: string;
  readonly supplierId: string;
  readonly supplierLabel: string;
  readonly expectedDeliveryDay: string | null;
  readonly status: string;
  readonly state: ReceiptIncompleteState;
}

/** Identifiants des BC en cours de réception (`SENT`, `PARTIALLY_RECEIVED`), dans l'ordre des identifiants. */
export async function listOpenOrderIds(uow: UnitOfWork): Promise<readonly string[]> {
  const rows = await uow
    .selectFrom('procurement_purchase_orders')
    .select('id')
    .where('status', 'in', [...RECEIVING_ORDER_STATUSES])
    .orderBy('id', 'asc')
    .execute();
  return rows.map((row) => fromBin(row.id));
}

const dayOfDateColumn = (value: Date | null): string | null =>
  value === null ? null : value.toISOString().slice(0, 10);

/**
 * État de réception incomplète de bons de commande (lectures en lot). `excludeReceiptId` écarte une
 * réception du rejeté cumulé (celle qu'on est en train d'annuler). `lockLines` relit les lignes du bon
 * `FOR UPDATE` (lecture courante : la transaction du fait les tient déjà, aucun verrou nouveau) pour que
 * l'évaluation sur réception ne lise pas un instantané antérieur au verrou du bon. Les BC inconnus sont
 * absents.
 */
export async function evaluateOrders(
  uow: UnitOfWork,
  orderIds: readonly string[],
  options: {
    readonly today: string;
    readonly thresholdDays: number;
    readonly excludeReceiptId?: string;
    readonly lockLines?: boolean;
  },
): Promise<readonly OrderIncompleteInfo[]> {
  const infos: OrderIncompleteInfo[] = [];
  for (let offset = 0; offset < orderIds.length; offset += 500) {
    const ids = orderIds.slice(offset, offset + 500).map((id) => toBin(id));
    const orders = await uow
      .selectFrom('procurement_purchase_orders')
      .select(['id', 'doc_number', 'site_id', 'supplier_id', 'expected_delivery_date', 'status'])
      .where('id', 'in', ids)
      .orderBy('id', 'asc')
      .execute();
    if (orders.length === 0) continue;
    const suppliers = new Map(
      (
        await uow
          .selectFrom('procurement_suppliers')
          .select(['id', 'name'])
          .where('id', 'in', [
            ...new Map(
              orders.map((order) => [fromBin(order.supplier_id), order.supplier_id]),
            ).values(),
          ])
          .execute()
      ).map((row) => [fromBin(row.id), row.name]),
    );
    const poLines = await uow
      .selectFrom('procurement_purchase_order_lines')
      .select([
        'id',
        'order_id',
        'product_id',
        'ordered_qty_base',
        'accepted_qty_base',
        'closed_qty_base',
        'status',
      ])
      .where('order_id', 'in', ids)
      .$if(options.lockLines === true, (qb) => qb.forUpdate())
      .execute();
    const rejectedRows = await uow
      .selectFrom('procurement_goods_receipt_lines as rl')
      .innerJoin('procurement_goods_receipts as r', 'r.id', 'rl.receipt_id')
      .select(['rl.po_line_id as po_line_id', 'rl.qty_rejected_base as rejected'])
      .where('r.purchase_order_id', 'in', ids)
      .where('r.status', 'in', [...COUNTED_RECEIPT_STATUSES])
      .where('rl.qty_rejected_base', '>', '0')
      .$if(options.excludeReceiptId !== undefined, (qb) =>
        qb.where('r.id', '<>', toBin(options.excludeReceiptId!)),
      )
      .execute();
    const rejectedByLine = new Map<string, number>();
    for (const row of rejectedRows) {
      if (row.po_line_id === null) continue;
      const key = fromBin(row.po_line_id);
      rejectedByLine.set(
        key,
        Math.round((rejectedByLine.get(key) ?? 0) * 1000 + Number(row.rejected) * 1000) / 1000,
      );
    }
    // L'unité ne sert qu'à additionner des quantités rejetées : seuls les produits des lignes rejetées
    // sont résolus (aucune lecture de catalogue pour un bon sans rejet, chemin chaud de la réception).
    const unitOfProduct = new Map<string, string>();
    for (const line of poLines) {
      if ((rejectedByLine.get(fromBin(line.id)) ?? 0) <= 0) continue;
      const productId = fromBin(line.product_id);
      if (unitOfProduct.has(productId)) continue;
      unitOfProduct.set(productId, (await findProduct(uow, productId))?.baseUnitCode ?? productId);
    }
    for (const order of orders) {
      const lines: ReceiptIncompleteLine[] = poLines
        .filter((line) => line.order_id.equals(order.id))
        .map((line) => ({
          ordered: Number(line.ordered_qty_base),
          accepted: Number(line.accepted_qty_base),
          closed: Number(line.closed_qty_base),
          cancelled: line.status === 'CANCELLED',
          rejected: rejectedByLine.get(fromBin(line.id)) ?? 0,
          unitCode: unitOfProduct.get(fromBin(line.product_id)) ?? '',
        }));
      const expectedDeliveryDay = dayOfDateColumn(order.expected_delivery_date);
      infos.push({
        orderId: fromBin(order.id),
        docNumber: order.doc_number,
        siteId: fromBin(order.site_id),
        supplierId: fromBin(order.supplier_id),
        supplierLabel: suppliers.get(fromBin(order.supplier_id)) ?? fromBin(order.supplier_id),
        expectedDeliveryDay,
        status: order.status,
        state: receiptIncompleteState({
          lines,
          expectedDeliveryDay,
          today: options.today,
          thresholdDays: options.thresholdDays,
        }),
      });
    }
  }
  return infos;
}

export type ReceiptIncompleteTrigger = 'PASS' | 'RECEIPT' | 'RECEIPT_CANCELLATION';

/** Charge utile de `ReceiptIncompleteDetected` (aucune valeur au coût). */
export function receiptIncompletePayload(
  info: OrderIncompleteInfo,
  extra: {
    readonly thresholdDays: number;
    readonly trigger: ReceiptIncompleteTrigger;
    readonly today: string;
  },
): Record<string, unknown> {
  return {
    po_id: info.orderId,
    doc_number: info.docNumber,
    supplier_id: info.supplierId,
    supplier_label: info.supplierLabel,
    site_id: info.siteId,
    expected_delivery_date: info.expectedDeliveryDay,
    days_late: info.state.daysLate,
    threshold_days: extra.thresholdDays,
    reason: info.state.reason,
    rejected: info.state.rejectedQuantity,
    remaining_lines: info.state.remainingLines,
    po_status: info.status,
    trigger: extra.trigger,
    business_day: extra.today,
  };
}

/**
 * Détection **sur réception** : à appeler après la mise à jour des quantités acceptées du BC. Publie
 * `ReceiptIncompleteDetected` (BC incomplet) ou `ReceiptIncompleteCleared`.
 */
export async function signalReceiptIncomplete(
  uow: UnitOfWork,
  deps: ProcurementAlertDeps,
  input: {
    readonly orderId: string;
    readonly trigger: Exclude<ReceiptIncompleteTrigger, 'PASS'>;
    readonly excludeReceiptId?: string;
  },
): Promise<void> {
  const now = detectionInstant(deps);
  const today = businessDayOf(now);
  const thresholdDays = await receiptIncompleteThresholdDays(uow, now);
  const [info] = await evaluateOrders(uow, [input.orderId], {
    today,
    thresholdDays,
    lockLines: true,
    ...(input.excludeReceiptId !== undefined ? { excludeReceiptId: input.excludeReceiptId } : {}),
  });
  if (info === undefined) return;
  // Un BC reçu en entier, clôturé ou annulé n'est plus à relancer, quel que soit son reliquat (D13 :
  // « reliquat nul ou clôturé ») ; seuls les bons en cours de réception peuvent être incomplets.
  const open = (RECEIVING_ORDER_STATUSES as readonly string[]).includes(info.status);
  if (open && info.state.incomplete) {
    await publishDetectionEvent(uow, deps.idGenerator, {
      eventType: 'ReceiptIncompleteDetected',
      producerModule: PRODUCER,
      aggregateType: 'PURCHASE_ORDER',
      aggregateId: info.orderId,
      occurredAt: now,
      payload: receiptIncompletePayload(info, {
        thresholdDays,
        trigger: input.trigger,
        today,
      }),
    });
    return;
  }
  await publishDetectionEvent(uow, deps.idGenerator, {
    eventType: 'ReceiptIncompleteCleared',
    producerModule: PRODUCER,
    aggregateType: 'PURCHASE_ORDER',
    aggregateId: info.orderId,
    occurredAt: now,
    payload: { po_id: info.orderId, trigger: input.trigger, business_day: today },
  });
}

/** Identité de passe de la tâche quotidienne (le type et le créneau). */
export const receiptIncompletePassId = (slot: string): string =>
  detectionPassId('RECEIPT_INCOMPLETE', slot);

/** Libellé français d'une raison de quarantaine (message de l'alerte). */
const QUARANTINE_REASON_LABELS: Readonly<Record<string, string>> = {
  DUPLICATE_DELIVERY_NOTE: 'Bon de livraison déjà reçu',
  OVER_RECEIPT: 'Dépassement du reliquat',
  PO_NOT_RECEIVABLE: 'Bon de commande non réceptionnable',
};

/** Libellé d'un ensemble de raisons de quarantaine (« A ; B »). */
export function quarantineReasonLabel(reasons: readonly string[]): string {
  return reasons.map((reason) => QUARANTINE_REASON_LABELS[reason] ?? reason).join(' ; ');
}

export interface QuarantineEventInput {
  readonly receiptId: string;
  readonly docNumber: string;
  readonly purchaseOrderId: string | null;
  readonly supplierId: string;
  readonly supplierLabel: string;
  readonly siteId: string;
  readonly reasons: readonly string[];
  readonly approvalRequestId: string | null;
  readonly supplierDeliveryNoteRef: string | null;
  readonly occurredAt: Date;
  readonly capturedOffline: boolean;
  readonly commandId: string;
}

/** Libellé de l'objet de l'alerte `DUPLICATE_SUSPECTED` pour une réception (comme « Encaissement »). */
export const DUPLICATE_KIND_RECEIPT = 'Réception';

/** `GoodsReceiptQuarantined` : réception mise en quarantaine (aucun effet de stock jusqu'à décision). */
export async function publishGoodsReceiptQuarantined(
  uow: UnitOfWork,
  deps: ProcurementAlertDeps,
  input: QuarantineEventInput,
): Promise<boolean> {
  return publishDetectionEvent(uow, deps.idGenerator, {
    eventType: 'GoodsReceiptQuarantined',
    producerModule: PRODUCER,
    aggregateType: 'GOODS_RECEIPT',
    aggregateId: input.receiptId,
    occurredAt: detectionInstant(deps),
    commandId: input.commandId,
    payload: {
      kind: DUPLICATE_KIND_RECEIPT,
      reference: input.docNumber,
      receipt_id: input.receiptId,
      doc_number: input.docNumber,
      purchase_order_id: input.purchaseOrderId,
      supplier_id: input.supplierId,
      supplier_label: input.supplierLabel,
      site_id: input.siteId,
      reasons: input.reasons,
      reason_label: quarantineReasonLabel(input.reasons),
      approval_request_id: input.approvalRequestId,
      supplier_delivery_note_ref: input.supplierDeliveryNoteRef,
      business_day: businessDayOf(input.occurredAt),
      captured_offline: input.capturedOffline,
    },
  });
}

/** `GoodsReceiptQuarantineDecided` : décision sur la quarantaine ; ferme l'alerte de la réception. */
export async function publishGoodsReceiptQuarantineDecided(
  uow: UnitOfWork,
  deps: ProcurementAlertDeps,
  input: {
    readonly receiptId: string;
    readonly decision: 'APPROVED' | 'REJECTED';
    readonly decidedBy: string;
    readonly decidedAt: Date;
  },
): Promise<boolean> {
  return publishDetectionEvent(uow, deps.idGenerator, {
    eventType: 'GoodsReceiptQuarantineDecided',
    producerModule: PRODUCER,
    aggregateType: 'GOODS_RECEIPT',
    aggregateId: input.receiptId,
    occurredAt: input.decidedAt,
    payload: {
      receipt_id: input.receiptId,
      decision: input.decision,
      decided_by: input.decidedBy,
    },
  });
}
