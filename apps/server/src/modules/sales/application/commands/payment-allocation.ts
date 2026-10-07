/**
 * Affectation des encaissements aux ventes et aux commandes (D09 §7.1 : BR-FIN-003, BR-FIN-004,
 * BR-FIN-008 ; INV-FIN-04 ; ADR-028 §8) : verrous, répartition, écriture du registre d'affectation
 * et des compteurs dénormalisés.
 *
 * - Le registre d'affectation (`sales_payment_allocations`) est **immuable**, sauf le passage unique
 *   de `ACTIVE` à `REVERSED` : libérer une part d'une affectation renverse l'affectation entière et
 *   recrée la part conservée par une nouvelle ligne ; le montant d'une ligne ne change jamais.
 * - Les compteurs `sales_sales.amount_paid_xaf` et `sales_sales_orders.advance_paid_xaf` sont la
 *   somme des affectations actives : ils se mettent à jour dans la transaction qui écrit ou renverse
 *   l'affectation, **en un seul `UPDATE` par vente ou commande** (les `CHECK` sont immédiats).
 * - Ordre de verrous : ventes (identifiant croissant), commandes, encaissement, affectations, comptes
 *   de trésorerie. C'est celui de l'annulation d'une vente (`sale-cancellation.ts`) : deux
 *   opérations sur la même vente ou le même encaissement se sérialisent sans s'interbloquer.
 * - Une lecture simple (isolation répétable) voit l'instantané du début de la transaction : toute
 *   décision qui dépend d'un solde se prend sur la lecture **verrouillante** de ce module.
 */
import { sql } from 'kysely';
import { allocatePayment, xaf, type IdGenerator } from '@gic/domain';
import { fromBin, fromBinOrNull, toBin } from '../../../../platform/kysely/uuid-columns.js';
import {
  absorbedCustomerIds,
  getCustomer,
  type CustomerSummary,
} from '../../../crm/application/public/index.js';
import type { Uow } from './shared.js';

export type ReversalCause =
  | 'PAYMENT_CANCELLED'
  | 'SALE_CANCELLED'
  | 'REALLOCATED'
  | 'ORDER_CONFIRMED'
  | 'ORDER_CANCELLED'
  | 'ORDER_CLOSED';

// --- Comptes d'un client (fusion) ---------------------------------------------------------------------

export interface CustomerAccounts {
  /** Compte nommé par la commande (peut être un compte fusionné, saisi hors ligne). */
  readonly customer: CustomerSummary;
  /** Compte conservé (identique à `customer` hors fusion). */
  readonly keptId: string;
  /** Compte nommé, compte conservé et comptes absorbés par lui : les ventes du client (BR-CRM-007). */
  readonly accountIds: readonly string[];
}

export async function customerAccountsOf(
  uow: Uow,
  customerId: string,
): Promise<CustomerAccounts | undefined> {
  const customer = await getCustomer(uow, customerId);
  if (!customer) return undefined;
  let kept: CustomerSummary | undefined = customer;
  if (customer.stage === 'MERGED') {
    kept = customer.mergedIntoId ? await getCustomer(uow, customer.mergedIntoId) : undefined;
    if (!kept) return undefined;
  }
  const absorbed = await absorbedCustomerIds(uow, kept.id);
  return {
    customer,
    keptId: kept.id,
    accountIds: [...new Set([customer.id, kept.id, ...absorbed])],
  };
}

// --- Ventes et commandes verrouillées -----------------------------------------------------------------

export interface SaleForPayment {
  readonly id: string;
  readonly customerId: string | null;
  readonly siteId: string;
  readonly status: string;
  readonly balanceDueXaf: number;
  /** Échéance `AAAA-MM-JJ` ; `null` pour une vente sans client. */
  readonly dueDate: string | null;
  readonly occurredAt: Date;
}

/** Une vente reçoit un règlement tant qu'elle est confirmée (ni annulée, ni en cours d'annulation) et due. */
export function isPayableSale(sale: SaleForPayment): boolean {
  return sale.status === 'CONFIRMED' && sale.balanceDueXaf > 0;
}

/** BR-FIN-004 : de l'échéance la plus ancienne à la plus récente, puis de la vente la plus ancienne. */
export function compareByDue(a: SaleForPayment, b: SaleForPayment): number {
  if (a.dueDate !== b.dueDate) {
    if (a.dueDate === null) return 1;
    if (b.dueDate === null) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  const byTime = a.occurredAt.getTime() - b.occurredAt.getTime();
  return byTime !== 0 ? byTime : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Verrouille les ventes (`FOR UPDATE`, identifiant croissant) et renvoie leur état **le plus
 * récent**. Une vente inconnue est absente du résultat.
 */
export async function lockSalesForPayment(
  uow: Uow,
  saleIds: readonly string[],
): Promise<Map<string, SaleForPayment>> {
  const result = new Map<string, SaleForPayment>();
  const ids = [...new Set(saleIds)].sort();
  if (ids.length === 0) return result;
  const rows = await uow
    .selectFrom('sales_sales')
    .select([
      'id',
      'customer_id',
      'site_id',
      'status',
      'balance_due_xaf',
      'occurred_at',
      sql<string | null>`DATE_FORMAT(due_date, '%Y-%m-%d')`.as('due'),
    ])
    .where(
      'id',
      'in',
      ids.map((id) => toBin(id)),
    )
    .orderBy('id', 'asc')
    .forUpdate()
    .execute();
  for (const row of rows) {
    result.set(fromBin(row.id), {
      id: fromBin(row.id),
      customerId: fromBinOrNull(row.customer_id),
      siteId: fromBin(row.site_id),
      status: row.status,
      balanceDueXaf: Number(row.balance_due_xaf ?? 0),
      dueDate: row.due,
      occurredAt: row.occurred_at,
    });
  }
  return result;
}

export interface OrderForPayment {
  readonly id: string;
  readonly customerId: string;
  readonly siteId: string;
  readonly status: string;
  readonly advancePaidXaf: number;
}

/**
 * Statuts d'une commande qui peut recevoir un acompte (AV-033, ADR-028 §8) : tant qu'elle n'est
 * ni livrée en totalité, ni clôturée, ni annulée. DÉDUIT : un brouillon peut aussi en recevoir un.
 */
export const ADVANCE_ORDER_STATUSES: readonly string[] = [
  'DRAFT',
  'CONFIRMED',
  'PARTIALLY_FULFILLED',
];

export function isAdvanceOrder(order: OrderForPayment): boolean {
  return ADVANCE_ORDER_STATUSES.includes(order.status);
}

export async function lockOrdersForPayment(
  uow: Uow,
  orderIds: readonly string[],
): Promise<Map<string, OrderForPayment>> {
  const result = new Map<string, OrderForPayment>();
  const ids = [...new Set(orderIds)].sort();
  if (ids.length === 0) return result;
  const rows = await uow
    .selectFrom('sales_sales_orders')
    .select(['id', 'customer_id', 'site_id', 'status', 'advance_paid_xaf'])
    .where(
      'id',
      'in',
      ids.map((id) => toBin(id)),
    )
    .orderBy('id', 'asc')
    .forUpdate()
    .execute();
  for (const row of rows) {
    result.set(fromBin(row.id), {
      id: fromBin(row.id),
      customerId: fromBin(row.customer_id),
      siteId: fromBin(row.site_id),
      status: row.status,
      advancePaidXaf: Number(row.advance_paid_xaf),
    });
  }
  return result;
}

/** Ventes ouvertes d'un client (lecture simple, à reconfirmer sous verrou) : candidats à l'affectation automatique. */
export async function openSaleIdsOf(
  uow: Uow,
  accountIds: readonly string[],
): Promise<readonly string[]> {
  const rows = await uow
    .selectFrom('sales_sales')
    .select('id')
    .where(
      'customer_id',
      'in',
      accountIds.map((id) => toBin(id)),
    )
    .where('status', '=', 'CONFIRMED')
    .where('balance_due_xaf', '>', 0)
    .execute();
  return rows.map((row) => fromBin(row.id));
}

// --- Répartition ------------------------------------------------------------------------------------

export interface PlannedAllocation {
  readonly kind: 'SALE' | 'ORDER';
  readonly targetId: string;
  readonly amountXaf: number;
}

export interface AllocationPlan {
  readonly allocations: readonly PlannedAllocation[];
  /** Reste non affecté : crédit client (BR-FIN-003). */
  readonly unallocatedXaf: number;
}

/**
 * BR-FIN-004 : répartit `amountXaf` sur les ventes **payables**, dans l'ordre reçu (l'appelant trie
 * de l'échéance la plus ancienne à la plus récente, ou suit le choix explicite) ; le reste est un
 * crédit client. Les ventes non payables sont ignorées.
 */
export function planSaleAllocations(
  amountXaf: number,
  sales: readonly SaleForPayment[],
): AllocationPlan {
  const result = allocatePayment(
    xaf(amountXaf),
    sales
      .filter(isPayableSale)
      .map((sale) => ({ targetId: sale.id, balanceXaf: xaf(sale.balanceDueXaf) })),
  );
  return {
    allocations: result.allocations.map((allocation) => ({
      kind: 'SALE' as const,
      targetId: allocation.targetId,
      amountXaf: allocation.amountXaf,
    })),
    unallocatedXaf: result.unallocatedXaf,
  };
}

// --- Écriture du registre ---------------------------------------------------------------------------

/** Variation signée des compteurs dénormalisés, par vente (`amount_paid_xaf`) et par commande (`advance_paid_xaf`). */
export interface CounterDeltas {
  readonly sales: Map<string, number>;
  readonly orders: Map<string, number>;
}

export function newCounterDeltas(): CounterDeltas {
  return { sales: new Map(), orders: new Map() };
}

function addTo(map: Map<string, number>, key: string, delta: number): void {
  map.set(key, (map.get(key) ?? 0) + delta);
}

export function addDelta(
  deltas: CounterDeltas,
  kind: 'SALE' | 'ORDER',
  targetId: string,
  delta: number,
): void {
  addTo(kind === 'SALE' ? deltas.sales : deltas.orders, targetId, delta);
}

/**
 * Applique les variations : **un seul `UPDATE` par vente et par commande** (les `CHECK` sont
 * immédiats), ventes d'abord, identifiant croissant.
 */
export async function applyCounterDeltas(uow: Uow, deltas: CounterDeltas): Promise<void> {
  for (const [saleId, delta] of [...deltas.sales].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (delta === 0) continue;
    await uow
      .updateTable('sales_sales')
      .set({ amount_paid_xaf: sql<number>`amount_paid_xaf + ${delta}` })
      .where('id', '=', toBin(saleId))
      .execute();
  }
  for (const [orderId, delta] of [...deltas.orders].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (delta === 0) continue;
    await uow
      .updateTable('sales_sales_orders')
      .set({ advance_paid_xaf: sql<number>`advance_paid_xaf + ${delta}` })
      .where('id', '=', toBin(orderId))
      .execute();
  }
}

/** Crée les affectations (l'encaissement doit déjà être `RECORDED`, INV-FIN-09) ; compteurs à appliquer par l'appelant. */
export async function insertAllocations(
  uow: Uow,
  deps: { readonly idGenerator: IdGenerator },
  input: {
    readonly paymentId: string;
    readonly allocations: readonly PlannedAllocation[];
    readonly allocatedAt: Date;
    readonly actorUserId: string;
    readonly commandId: string | null;
  },
  deltas: CounterDeltas,
): Promise<void> {
  for (const allocation of input.allocations) {
    await uow
      .insertInto('sales_payment_allocations')
      .values({
        id: toBin(deps.idGenerator.newId()),
        payment_id: toBin(input.paymentId),
        sale_id: allocation.kind === 'SALE' ? toBin(allocation.targetId) : null,
        order_id: allocation.kind === 'ORDER' ? toBin(allocation.targetId) : null,
        amount_xaf: allocation.amountXaf,
        allocated_at: input.allocatedAt,
        ...(input.commandId !== null ? { command_id: toBin(input.commandId) } : {}),
        created_by: toBin(input.actorUserId),
      })
      .execute();
    addDelta(deltas, allocation.kind, allocation.targetId, allocation.amountXaf);
  }
}

export interface ActiveAllocation {
  readonly id: Buffer;
  readonly saleId: string | null;
  readonly orderId: string | null;
  readonly amountXaf: number;
  readonly allocatedAt: Date;
}

/** Affectations actives d'un encaissement, verrouillées, la plus récente d'abord. */
export async function lockActiveAllocations(
  uow: Uow,
  paymentId: string,
  target: { readonly saleId?: string; readonly orderId?: string } = {},
): Promise<readonly ActiveAllocation[]> {
  const rows = await uow
    .selectFrom('sales_payment_allocations')
    .select(['id', 'sale_id', 'order_id', 'amount_xaf', 'allocated_at'])
    .where('payment_id', '=', toBin(paymentId))
    .where('status', '=', 'ACTIVE')
    .$if(target.saleId !== undefined, (qb) => qb.where('sale_id', '=', toBin(target.saleId!)))
    .$if(target.orderId !== undefined, (qb) => qb.where('order_id', '=', toBin(target.orderId!)))
    .orderBy('allocated_at', 'desc')
    .orderBy('id', 'desc')
    .forUpdate()
    .execute();
  return rows.map((row) => ({
    id: row.id,
    saleId: fromBinOrNull(row.sale_id),
    orderId: fromBinOrNull(row.order_id),
    amountXaf: Number(row.amount_xaf),
    allocatedAt: row.allocated_at,
  }));
}

/**
 * Libère `amountXaf` des affectations données (la plus récente d'abord) : chacune est renversée en
 * entier ; la part conservée d'une affectation partiellement libérée est recréée par une nouvelle
 * ligne qui garde l'heure métier d'origine. Les compteurs diminuent de la part libérée
 * (`deltas`, à appliquer par l'appelant). Renvoie le total effectivement libéré.
 */
export async function releaseAllocations(
  uow: Uow,
  deps: { readonly idGenerator: IdGenerator },
  input: {
    readonly allocations: readonly ActiveAllocation[];
    readonly amountXaf: number;
    readonly cause: ReversalCause;
    readonly reversedAt: Date;
    readonly paymentId: string;
    readonly actorUserId: string;
    readonly commandId: string | null;
  },
  deltas: CounterDeltas,
): Promise<number> {
  let remaining = input.amountXaf;
  for (const allocation of input.allocations) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, allocation.amountXaf);
    await uow
      .updateTable('sales_payment_allocations')
      .set({ status: 'REVERSED', reversed_at: input.reversedAt, reversal_cause: input.cause })
      .where('id', '=', allocation.id)
      .execute();
    if (take < allocation.amountXaf) {
      await uow
        .insertInto('sales_payment_allocations')
        .values({
          id: toBin(deps.idGenerator.newId()),
          payment_id: toBin(input.paymentId),
          sale_id: allocation.saleId !== null ? toBin(allocation.saleId) : null,
          order_id: allocation.orderId !== null ? toBin(allocation.orderId) : null,
          amount_xaf: allocation.amountXaf - take,
          allocated_at: allocation.allocatedAt,
          ...(input.commandId !== null ? { command_id: toBin(input.commandId) } : {}),
          created_by: toBin(input.actorUserId),
        })
        .execute();
    }
    if (allocation.saleId !== null) addDelta(deltas, 'SALE', allocation.saleId, -take);
    else if (allocation.orderId !== null) addDelta(deltas, 'ORDER', allocation.orderId, -take);
    remaining -= take;
  }
  return input.amountXaf - remaining;
}
