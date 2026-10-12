/**
 * Commandes ouvertes vues par l'appareil (ECR-VEN-03, ECR-VEN-04) : le jeu `orders` (brouillons,
 * commandes confirmées ou partiellement livrées du périmètre), complété par les commandes passées
 * sur l'appareil que le serveur n'a pas encore renvoyées, et par les livraisons saisies sur
 * l'appareil et pas encore confirmées (la quantité « à livrer » en tient compte, pour ne pas livrer
 * deux fois la même marchandise hors ligne).
 *
 * Quantités en unité de base : en attente = commandé − vendu, à livrer = vendu − livré
 * (`salesOrderLineProgress`, ADR-028, INV-VEN-04 ; même calcul que la lecture `GET /orders/:id`).
 */
import { quantityFromDecimal, quantityToDecimal, salesOrderLineProgress } from '@gic/domain';
import type { OutboxCommand } from '../../storage/db.js';
import { isAccepted, isWaiting, stillInFlight } from './pending.js';
import type { SalesReferences } from './references.js';
import type { SalesOrderData } from './types.js';

/** Opérations sur une commande existante qui en changent les suites possibles. */
const ORDER_ACTIONS: ReadonlySet<string> = new Set([
  'sales.order.cancel',
  'sales.order.close_remaining',
  'sales.order.confirm_remaining',
  'sales.order.update',
]);

export type OrderViewStatus = SalesOrderData['status'] | 'PENDING' | 'REJECTED' | 'IN_CONFLICT';

export interface OrderViewLine {
  /** Identifiant de la ligne côté serveur ; `null` tant que la commande n'est pas confirmée. */
  readonly id: string | null;
  readonly productId: string;
  readonly productName: string;
  readonly quantity: number;
  readonly unitCode: string;
  readonly orderedBase: number;
  readonly soldBase: number;
  readonly deliveredBase: number;
  /** Livré sur l'appareil, en attente de confirmation par le serveur. */
  readonly deliveringBase: number;
  readonly pendingBase: number;
  /** Vendu − livré − livraisons de l'appareil en attente. */
  readonly toDeliverBase: number;
  readonly quotedUnitPriceXaf: number;
  readonly lineTotalXaf: number;
}

export interface OrderView {
  readonly id: string;
  readonly docNumber: string | null;
  readonly status: OrderViewStatus;
  readonly customerId: string;
  readonly fulfilmentLocationId: string;
  readonly siteId: string | null;
  readonly requestedDeliveryDate: string | null;
  readonly deliveryAddress: string | null;
  readonly totalEstimatedXaf: number;
  readonly advancePaidXaf: number;
  readonly occurredAt: string;
  readonly version: number | null;
  readonly lines: readonly OrderViewLine[];
  readonly commandId: string | null;
  readonly rejection: string | null;
  /** Opérations sur cette commande saisies sur l'appareil et pas encore envoyées. */
  readonly pendingActions: readonly string[];
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

function progress(ordered: number, sold: number, delivered: number) {
  try {
    const result = salesOrderLineProgress({
      ordered: quantityFromDecimal(ordered),
      sold: quantityFromDecimal(sold),
      delivered: quantityFromDecimal(delivered),
    });
    return {
      pending: quantityToDecimal(result.pending),
      undelivered: quantityToDecimal(result.undelivered),
    };
  } catch {
    // Ligne incohérente (ne devrait pas arriver, INV-VEN-04) : rien à livrer ni en attente.
    return { pending: 0, undelivered: 0 };
  }
}

/**
 * Quantités livrées sur l'appareil et pas encore retrouvées dans le jeu `orders`, par ligne de
 * commande : en attente d'envoi, ou acceptées mais pas encore retéléchargées (ADR-037 §3).
 */
export function deliveringByLine(
  commands: readonly OutboxCommand[],
  ordersPulledAt: string | undefined,
): Map<string, number> {
  const milli = new Map<string, number>();
  for (const command of commands) {
    if (command.command_type !== 'sales.order.fulfil') continue;
    if (!stillInFlight(command, ordersPulledAt)) continue;
    const payload = command.payload as {
      readonly lines?: readonly { readonly orderLineId?: string; readonly quantityBase?: number }[];
    };
    for (const line of payload.lines ?? []) {
      if (!line.orderLineId || !line.quantityBase) continue;
      milli.set(
        line.orderLineId,
        (milli.get(line.orderLineId) ?? 0) + Math.round(line.quantityBase * 1000),
      );
    }
  }
  return new Map([...milli].map(([id, value]) => [id, value / 1000]));
}

function pendingActionsOf(outbox: readonly OutboxCommand[], orderId: string): string[] {
  return outbox
    .filter(
      (command) =>
        command.aggregate_id === orderId &&
        ORDER_ACTIONS.has(command.command_type) &&
        isWaiting(command),
    )
    .map((command) => command.command_type);
}

function fromProjection(
  order: SalesOrderData,
  delivering: ReadonlyMap<string, number>,
  pendingActions: readonly string[],
): OrderView {
  return {
    id: order.id,
    docNumber: order.doc_number,
    status: order.status,
    customerId: order.customer_id,
    fulfilmentLocationId: order.fulfilment_location_id,
    siteId: order.site_id,
    requestedDeliveryDate: order.requested_delivery_date,
    deliveryAddress: order.delivery_address,
    totalEstimatedXaf: order.total_estimated_xaf,
    advancePaidXaf: order.advance_paid_xaf,
    occurredAt: order.occurred_at,
    version: order.version,
    lines: order.lines.map((line) => {
      const { pending, undelivered } = progress(
        line.quantity_base,
        line.sold_quantity_base,
        line.delivered_quantity_base,
      );
      const deliveringBase = delivering.get(line.id) ?? 0;
      return {
        id: line.id,
        productId: line.product_id,
        productName: line.product_name,
        quantity: line.quantity,
        unitCode: line.unit_code,
        orderedBase: line.quantity_base,
        soldBase: line.sold_quantity_base,
        deliveredBase: line.delivered_quantity_base,
        deliveringBase,
        pendingBase: pending,
        toDeliverBase: Math.max(0, round3(undelivered - deliveringBase)),
        quotedUnitPriceXaf: line.quoted_unit_price_xaf,
        lineTotalXaf: line.line_total_xaf,
      };
    }),
    commandId: null,
    rejection: null,
    pendingActions,
  };
}

interface PlacePayload {
  readonly customerId: string;
  readonly fulfilmentLocationId: string;
  readonly requestedDeliveryDate?: string;
  readonly deliveryAddress?: string;
  readonly lines?: readonly {
    readonly productId: string;
    readonly quantity: number;
    readonly unitCode: string;
    readonly quantityBase: number;
    readonly unitPriceXaf: number;
  }[];
  readonly advancePayments?: readonly { readonly amountXaf: number }[];
}

function fromCommand(
  command: OutboxCommand,
  refs: Pick<SalesReferences, 'products' | 'locations'>,
): OrderView {
  const payload = command.payload as PlacePayload;
  const names = new Map(refs.products.map((product) => [product.id, product.name]));
  const status: OrderViewStatus =
    command.status === 'REJECTED'
      ? 'REJECTED'
      : command.status === 'CONFLICT'
        ? 'IN_CONFLICT'
        : isWaiting(command)
          ? 'PENDING'
          : 'CONFIRMED';
  // Refusée ou en conflit : rien n'attend du stock.
  const live = status === 'PENDING' || status === 'CONFIRMED';
  const lines = (payload.lines ?? []).map((line) => {
    const lineTotalXaf = Math.round(line.quantityBase * line.unitPriceXaf);
    return {
      id: null,
      productId: line.productId,
      productName: names.get(line.productId) ?? line.productId,
      quantity: line.quantity,
      unitCode: line.unitCode,
      orderedBase: line.quantityBase,
      soldBase: 0,
      deliveredBase: 0,
      deliveringBase: 0,
      pendingBase: live ? line.quantityBase : 0,
      toDeliverBase: 0,
      quotedUnitPriceXaf: line.unitPriceXaf,
      lineTotalXaf,
    };
  });
  return {
    id: command.aggregate_id,
    docNumber: command.server_refs?.docNumber ?? null,
    status,
    customerId: payload.customerId,
    fulfilmentLocationId: payload.fulfilmentLocationId,
    siteId:
      refs.locations.find((location) => location.id === payload.fulfilmentLocationId)?.site_id ??
      null,
    requestedDeliveryDate: payload.requestedDeliveryDate ?? null,
    deliveryAddress: payload.deliveryAddress ?? null,
    totalEstimatedXaf: lines.reduce((sum, line) => sum + line.lineTotalXaf, 0),
    advancePaidXaf: (payload.advancePayments ?? []).reduce((sum, p) => sum + p.amountXaf, 0),
    occurredAt: command.occurred_at,
    version: null,
    lines,
    commandId: command.command_id,
    rejection: command.last_error?.message_fr ?? null,
    pendingActions: [],
  };
}

/** Commandes ouvertes, la plus récente d'abord. */
export function openOrders(
  refs: Pick<SalesReferences, 'orders' | 'outbox' | 'products' | 'locations' | 'ordersPulledAt'>,
): OrderView[] {
  const delivering = deliveringByLine(refs.outbox, refs.ordersPulledAt);
  const views = new Map<string, OrderView>();
  for (const order of refs.orders.values()) {
    views.set(order.id, fromProjection(order, delivering, pendingActionsOf(refs.outbox, order.id)));
  }
  for (const command of refs.outbox) {
    if (command.command_type !== 'sales.order.place' || views.has(command.aggregate_id)) continue;
    // Acceptée et déjà retéléchargée sans revenir : livrée, close ou annulée, le jeu ne la sert plus.
    if (isAccepted(command) && !stillInFlight(command, refs.ordersPulledAt)) continue;
    views.set(command.aggregate_id, fromCommand(command, refs));
  }
  return [...views.values()].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

/** Teinte du badge de statut d'une commande. */
export function orderStatusTone(status: OrderViewStatus): string {
  switch (status) {
    case 'CONFIRMED':
    case 'PARTIALLY_FULFILLED':
      return 'ok';
    case 'PENDING':
    case 'DRAFT':
      return 'info';
    default:
      return 'warn';
  }
}

export const hasSomethingToDeliver = (order: OrderView): boolean =>
  order.lines.some((line) => line.id !== null && line.toDeliverBase > 0);

export const hasPendingStock = (order: OrderView): boolean =>
  order.lines.some((line) => line.pendingBase > 0);
