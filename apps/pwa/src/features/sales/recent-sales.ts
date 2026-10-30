/**
 * Ventes récentes vues par l'appareil (ECR-VEN-05) : les ventes du jeu `sales_recent` (7 derniers
 * jours, servies par le serveur) complétées par les ventes enregistrées sur l'appareil que le serveur
 * n'a pas encore renvoyées — en attente d'envoi, refusées, en conflit, ou acceptées mais pas encore
 * retéléchargées. Une annulation en attente sur l'appareil est signalée sur la vente visée.
 */
import { lineAmountXaf, quantityFromDecimal, xaf } from '@gic/domain';
import type { OutboxCommand } from '../../storage/db.js';
import type { SalesReferences } from './references.js';
import type { SaleData } from './types.js';

const WAITING: ReadonlySet<string> = new Set(['LOCAL_ONLY', 'PENDING_SYNC', 'SYNCING']);

export type SaleViewStatus =
  | SaleData['status']
  /** Enregistrée sur l'appareil, pas encore acceptée par le serveur. */
  | 'PENDING'
  | 'REJECTED'
  | 'IN_CONFLICT';

export interface SaleViewLine {
  readonly productId: string;
  readonly productName: string;
  readonly quantity: number;
  readonly unitCode: string;
  readonly unitPriceXaf: number;
  readonly discountXaf: number;
  readonly lineTotalXaf: number;
  readonly cancelledXaf: number;
}

export interface SaleView {
  readonly id: string;
  readonly docNumber: string | null;
  readonly status: SaleViewStatus;
  readonly paymentStatus: SaleData['payment_status'] | null;
  readonly occurredAt: string;
  readonly customerId: string | null;
  readonly sellerUserId: string;
  readonly fromLocationId: string;
  readonly siteId: string | null;
  readonly netTotalXaf: number;
  readonly amountPaidXaf: number;
  readonly balanceDueXaf: number;
  readonly capturedOffline: boolean;
  readonly flags: readonly string[];
  readonly lines: readonly SaleViewLine[];
  /** Commande de l'outbox d'une vente saisie sur l'appareil (`depends_on` d'une annulation). */
  readonly commandId: string | null;
  readonly rejection: string | null;
  /** Une annulation saisie sur l'appareil attend l'envoi ou la réponse du serveur. */
  readonly cancellationPending: boolean;
}

interface RecordPayload {
  readonly fromLocationId: string;
  readonly customerId?: string;
  readonly lines: readonly {
    readonly productId: string;
    readonly quantity: number;
    readonly unitCode: string;
    readonly quantityBase: number;
    readonly weightKg?: number;
    readonly unitPriceXaf: number;
    readonly discountXaf?: number;
  }[];
  readonly payments?: readonly { readonly amountXaf: number }[];
}

function fromProjection(sale: SaleData, cancellationPending: boolean): SaleView {
  return {
    id: sale.id,
    docNumber: sale.doc_number,
    status: sale.status,
    paymentStatus: sale.payment_status,
    occurredAt: sale.occurred_at,
    customerId: sale.customer_id,
    sellerUserId: sale.seller_user_id,
    fromLocationId: sale.from_location_id,
    siteId: sale.site_id,
    netTotalXaf: sale.net_total_xaf,
    amountPaidXaf: sale.amount_paid_xaf,
    balanceDueXaf: sale.balance_due_xaf,
    capturedOffline: sale.captured_offline,
    flags: sale.flags,
    lines: sale.lines.map((line) => ({
      productId: line.product_id,
      productName: line.product_name,
      quantity: line.quantity,
      unitCode: line.unit_code,
      unitPriceXaf: line.unit_price_xaf,
      discountXaf: line.discount_xaf,
      lineTotalXaf: line.line_total_xaf,
      cancelledXaf: line.cancelled_xaf,
    })),
    commandId: null,
    rejection: null,
    cancellationPending,
  };
}

function fromCommand(
  command: OutboxCommand,
  refs: Pick<SalesReferences, 'products' | 'locations'>,
  cancellationPending: boolean,
): SaleView {
  const payload = command.payload as RecordPayload;
  const names = new Map(refs.products.map((product) => [product.id, product.name]));
  const lines = (payload.lines ?? []).map((line) => {
    const gross = lineAmountXaf(
      quantityFromDecimal(line.weightKg ?? line.quantityBase),
      xaf(line.unitPriceXaf),
    );
    const discount = line.discountXaf ?? 0;
    return {
      productId: line.productId,
      productName: names.get(line.productId) ?? line.productId,
      quantity: line.quantity,
      unitCode: line.unitCode,
      unitPriceXaf: line.unitPriceXaf,
      discountXaf: discount,
      lineTotalXaf: gross - discount,
      cancelledXaf: 0,
    };
  });
  const total = lines.reduce((sum, line) => sum + line.lineTotalXaf, 0);
  const paid = (payload.payments ?? []).reduce((sum, payment) => sum + payment.amountXaf, 0);
  const status: SaleViewStatus =
    command.status === 'REJECTED'
      ? 'REJECTED'
      : command.status === 'CONFLICT'
        ? 'IN_CONFLICT'
        : WAITING.has(command.status)
          ? 'PENDING'
          : 'CONFIRMED';
  return {
    id: command.aggregate_id,
    docNumber: command.server_refs?.docNumber ?? null,
    status,
    paymentStatus: paid >= total ? 'PAID' : paid > 0 ? 'PARTIALLY_PAID' : 'UNPAID',
    occurredAt: command.occurred_at,
    customerId: payload.customerId ?? null,
    sellerUserId: command.author_user_id,
    fromLocationId: payload.fromLocationId,
    siteId:
      refs.locations.find((location) => location.id === payload.fromLocationId)?.site_id ?? null,
    netTotalXaf: total,
    amountPaidXaf: paid,
    balanceDueXaf: Math.max(0, total - paid),
    capturedOffline: command.captured_offline,
    flags: [],
    lines,
    commandId: command.command_id,
    rejection: command.last_error?.message_fr ?? null,
    cancellationPending,
  };
}

/** Ventes récentes, la plus récente d'abord. */
export function recentSales(
  refs: Pick<SalesReferences, 'sales' | 'outbox' | 'products' | 'locations'>,
): SaleView[] {
  const cancelling = new Set(
    refs.outbox
      .filter(
        (command) =>
          (command.command_type === 'sales.sale.cancel' ||
            command.command_type === 'sales.sale.request_cancellation') &&
          WAITING.has(command.status),
      )
      .map((command) => (command.payload as { saleId?: string }).saleId)
      .filter((id): id is string => typeof id === 'string'),
  );
  const views = new Map<string, SaleView>();
  for (const sale of refs.sales) views.set(sale.id, fromProjection(sale, cancelling.has(sale.id)));
  for (const command of refs.outbox) {
    if (command.command_type !== 'sales.sale.record' || views.has(command.aggregate_id)) continue;
    views.set(
      command.aggregate_id,
      fromCommand(command, refs, cancelling.has(command.aggregate_id)),
    );
  }
  return [...views.values()].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
}

export type SaleTone = 'ok' | 'warn' | 'bad' | 'info' | 'muted';

/** Teinte du badge de statut d’une vente. */
export function saleStatusTone(status: SaleViewStatus): SaleTone {
  switch (status) {
    case 'CONFIRMED':
      return 'ok';
    case 'PENDING':
      return 'info';
    case 'CANCELLED':
      return 'muted';
    default:
      return 'warn';
  }
}

const PAYMENT_TONE: Record<NonNullable<SaleView['paymentStatus']>, SaleTone> = {
  PAID: 'ok',
  PARTIALLY_PAID: 'warn',
  UNPAID: 'bad',
};

/**
 * Pastille d’une vente dans une liste : une vente confirmée montre son paiement (« Non payée » est une
 * alerte, pas un état neutre) ; sinon son état (en attente d’envoi, annulée, refusée…).
 */
export function saleListBadge(sale: Pick<SaleView, 'status' | 'paymentStatus'>): {
  readonly tone: SaleTone;
  readonly labelKey: string;
} {
  if (sale.status === 'CONFIRMED' && sale.paymentStatus) {
    return {
      tone: PAYMENT_TONE[sale.paymentStatus],
      labelKey: `sales.payment_status.${sale.paymentStatus}`,
    };
  }
  return { tone: saleStatusTone(sale.status), labelKey: `sales.status.${sale.status}` };
}
