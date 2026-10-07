/**
 * Lignes de flux de changements émises par `sales` (P4-11 ; 01-architecture-offline.md §3.1) :
 * - jeu `orders` : commandes ouvertes, pour leur titulaire (commercial attributaire, à défaut
 *   l'auteur : `USER`), les équipes du titulaire (`TEAM`, responsable commercial) et l'emplacement
 *   de préparation (`LOCATION`, magasinier, vendeur du PDV) ; une commande livrée, clôturée ou
 *   annulée sort du jeu (`SCOPE_EXIT`), comme l'ancien emplacement d'une commande déplacée ;
 * - jeu `sales_recent` : ventes et encaissements, pour le vendeur et le commercial attributaire,
 *   ou le receveur (`USER`), et pour le site (`SITE`, PDV) ; la fenêtre de 7 jours est appliquée
 *   par la projection, l'appareil purge localement au-delà ;
 * - jeu `customers` (`crm`) : le compte de chaque document touché, dont l'encours a pu changer
 *   (compte absorbé : celui qui l'a absorbé, BR-CRM-007).
 *
 * Publication en fin de commande (`withSalesChanges`, `withSalesDecisionChanges`) plutôt qu'à
 * chacune des écritures : on part de l'agrégat et de ce que la commande a écrit (`command_id` des
 * ventes, commandes, encaissements, affectations, annulations et livraisons), puis on suit les liens
 * commande ↔ ventes ↔ affectations ↔ encaissements. Un document republié sans changement est sans
 * effet (upsert idempotent). Les types d'entité sont des clés de `sync/entity-projections.ts`, qui
 * ne servent jamais le repli générique `GLOBAL` du pipeline.
 */
import type { Transaction } from 'kysely';
import type { DB } from '../../../platform/kysely/database.js';
import { recordChanges, type ChangeFeedEntry } from '../../../platform/sync/change-feed.js';
import type {
  CommandHandlerRegistry,
  RegisterCommandInput,
} from '../../../platform/sync/command-handler-registry.js';
import { fromBin, fromBinOrNull, toBin } from '../../../platform/kysely/uuid-columns.js';
import { listTeamsOfUserAt } from '../../organization/application/public/index.js';
import { emitCustomerChange, getCustomer } from '../../crm/application/public/index.js';
import type {
  ApprovalDecisionHandler,
  ApprovalDecisionHandlerRegistry,
} from '../../approvals/application/public/index.js';

export const ORDERS_DATASET = 'orders';
export const SALES_RECENT_DATASET = 'sales_recent';

/** Statuts d'une commande qui reste dans le jeu `orders`. */
const OPEN_ORDER_STATUSES: readonly string[] = ['DRAFT', 'CONFIRMED', 'PARTIALLY_FULFILLED'];

type Uow = Transaction<DB>;

export interface SalesChangeSeed {
  readonly aggregateType: string;
  readonly aggregateId: string;
  /** Commande dont on relit les écritures (`command_id`). */
  readonly commandId?: string;
  /** Emplacement de préparation d'une commande avant la commande (déplacement : sortie). */
  readonly previousOrderLocationId?: string;
}

interface Touched {
  readonly sales: Set<string>;
  readonly orders: Set<string>;
  readonly payments: Set<string>;
}

const binIds = (ids: Iterable<string>): Buffer[] => [...ids].map((id) => toBin(id));

function addAll(target: Set<string>, ids: readonly (Buffer | null)[]): void {
  for (const id of ids) if (id !== null) target.add(fromBin(id));
}

/** Documents touchés : l'agrégat, les écritures de la commande, puis leurs liens. */
async function touchedBy(uow: Uow, seed: SalesChangeSeed): Promise<Touched> {
  const touched: Touched = { sales: new Set(), orders: new Set(), payments: new Set() };
  const aggregate = toBin(seed.aggregateId);
  switch (seed.aggregateType) {
    case 'SALE':
      touched.sales.add(seed.aggregateId);
      break;
    case 'SALES_ORDER':
      touched.orders.add(seed.aggregateId);
      break;
    case 'CUSTOMER_PAYMENT':
      touched.payments.add(seed.aggregateId);
      break;
    case 'DELIVERY_NOTE': {
      const note = await uow
        .selectFrom('sales_delivery_notes')
        .select('order_id')
        .where('id', '=', aggregate)
        .executeTakeFirst();
      if (note) addAll(touched.orders, [note.order_id]);
      break;
    }
    case 'SALE_CANCELLATION': {
      const cancellation = await uow
        .selectFrom('sales_sale_cancellations')
        .select(['sale_id', 'order_id'])
        .where('id', '=', aggregate)
        .executeTakeFirst();
      if (cancellation) {
        addAll(touched.sales, [cancellation.sale_id]);
        addAll(touched.orders, [cancellation.order_id]);
      }
      break;
    }
  }

  if (seed.commandId !== undefined) {
    const command = toBin(seed.commandId);
    const sales = await uow
      .selectFrom('sales_sales')
      .select(['id', 'order_id'])
      .where('command_id', '=', command)
      .execute();
    addAll(
      touched.sales,
      sales.map((row) => row.id),
    );
    addAll(
      touched.orders,
      sales.map((row) => row.order_id),
    );
    const orders = await uow
      .selectFrom('sales_sales_orders')
      .select('id')
      .where('command_id', '=', command)
      .execute();
    addAll(
      touched.orders,
      orders.map((row) => row.id),
    );
    const payments = await uow
      .selectFrom('sales_customer_payments')
      .select('id')
      .where('command_id', '=', command)
      .execute();
    addAll(
      touched.payments,
      payments.map((row) => row.id),
    );
    const allocations = await uow
      .selectFrom('sales_payment_allocations')
      .select(['payment_id', 'sale_id', 'order_id'])
      .where('command_id', '=', command)
      .execute();
    addAll(
      touched.payments,
      allocations.map((row) => row.payment_id),
    );
    addAll(
      touched.sales,
      allocations.map((row) => row.sale_id),
    );
    addAll(
      touched.orders,
      allocations.map((row) => row.order_id),
    );
    const cancellations = await uow
      .selectFrom('sales_sale_cancellations')
      .select(['sale_id', 'order_id'])
      .where('command_id', '=', command)
      .execute();
    addAll(
      touched.sales,
      cancellations.map((row) => row.sale_id),
    );
    addAll(
      touched.orders,
      cancellations.map((row) => row.order_id),
    );
    const notes = await uow
      .selectFrom('sales_delivery_notes')
      .select('order_id')
      .where('command_id', '=', command)
      .execute();
    addAll(
      touched.orders,
      notes.map((row) => row.order_id),
    );
  }

  // Liens : commande ↔ ventes, puis encaissements affectés, puis leurs cibles.
  if (touched.orders.size > 0) {
    const ofOrders = await uow
      .selectFrom('sales_sales')
      .select('id')
      .where('order_id', 'in', binIds(touched.orders))
      .execute();
    addAll(
      touched.sales,
      ofOrders.map((row) => row.id),
    );
  }
  if (touched.sales.size > 0) {
    const ofSales = await uow
      .selectFrom('sales_sales')
      .select('order_id')
      .where('id', 'in', binIds(touched.sales))
      .execute();
    addAll(
      touched.orders,
      ofSales.map((row) => row.order_id),
    );
  }
  if (touched.sales.size > 0 || touched.orders.size > 0) {
    const allocated = await uow
      .selectFrom('sales_payment_allocations')
      .select('payment_id')
      .where((eb) =>
        eb.or([
          ...(touched.sales.size > 0 ? [eb('sale_id', 'in', binIds(touched.sales))] : []),
          ...(touched.orders.size > 0 ? [eb('order_id', 'in', binIds(touched.orders))] : []),
        ]),
      )
      .execute();
    addAll(
      touched.payments,
      allocated.map((row) => row.payment_id),
    );
  }
  if (touched.payments.size > 0) {
    const targets = await uow
      .selectFrom('sales_payment_allocations')
      .select(['sale_id', 'order_id'])
      .where('payment_id', 'in', binIds(touched.payments))
      .execute();
    addAll(
      touched.sales,
      targets.map((row) => row.sale_id),
    );
    addAll(
      touched.orders,
      targets.map((row) => row.order_id),
    );
  }
  return touched;
}

/** Équipes courantes des utilisateurs (sans doublon). */
async function teamsOf(uow: Uow, userIds: readonly string[], at: Date): Promise<Set<string>> {
  const teams = new Set<string>();
  for (const userId of new Set(userIds)) {
    for (const team of await listTeamsOfUserAt(uow, userId, at)) teams.add(team);
  }
  return teams;
}

/**
 * Publie les commandes, ventes, encaissements et comptes clients touchés par une commande ou une
 * décision (voir l'en-tête).
 */
export async function emitSalesChanges(uow: Uow, seed: SalesChangeSeed, at: Date): Promise<void> {
  const touched = await touchedBy(uow, seed);
  const entries: ChangeFeedEntry[] = [];
  const customers = new Set<string>();

  if (touched.orders.size > 0) {
    const orders = await uow
      .selectFrom('sales_sales_orders')
      .select([
        'id',
        'status',
        'customer_id',
        'commercial_user_id',
        'created_by',
        'fulfilment_location_id',
        'version',
      ])
      .where('id', 'in', binIds(touched.orders))
      .execute();
    for (const order of orders) {
      const entityId = fromBin(order.id);
      const owner = fromBinOrNull(order.commercial_user_id) ?? fromBin(order.created_by);
      const location = fromBin(order.fulfilment_location_id);
      const changeType = OPEN_ORDER_STATUSES.includes(order.status) ? 'UPSERT' : 'SCOPE_EXIT';
      const base = {
        dataset: ORDERS_DATASET,
        entityType: 'SALES_ORDER',
        entityId,
        changeType,
        rowVersion: order.version,
      } as const;
      entries.push({ ...base, scopeType: 'USER', scopeId: owner });
      for (const team of await teamsOf(uow, [owner], at)) {
        entries.push({ ...base, scopeType: 'TEAM', scopeId: team });
      }
      entries.push({ ...base, scopeType: 'LOCATION', scopeId: location });
      if (
        seed.aggregateType === 'SALES_ORDER' &&
        seed.aggregateId === entityId &&
        seed.previousOrderLocationId !== undefined &&
        seed.previousOrderLocationId !== location
      ) {
        entries.push({
          ...base,
          changeType: 'SCOPE_EXIT',
          scopeType: 'LOCATION',
          scopeId: seed.previousOrderLocationId,
        });
      }
      customers.add(fromBin(order.customer_id));
    }
  }

  if (touched.sales.size > 0) {
    const sales = await uow
      .selectFrom('sales_sales')
      .select(['id', 'customer_id', 'seller_user_id', 'commercial_user_id', 'site_id', 'version'])
      .where('id', 'in', binIds(touched.sales))
      .execute();
    for (const sale of sales) {
      const base = {
        dataset: SALES_RECENT_DATASET,
        entityType: 'SALE',
        entityId: fromBin(sale.id),
        rowVersion: sale.version,
      } as const;
      for (const user of new Set([
        fromBin(sale.seller_user_id),
        ...(sale.commercial_user_id ? [fromBin(sale.commercial_user_id)] : []),
      ])) {
        entries.push({ ...base, scopeType: 'USER', scopeId: user });
      }
      entries.push({ ...base, scopeType: 'SITE', scopeId: fromBin(sale.site_id) });
      if (sale.customer_id) customers.add(fromBin(sale.customer_id));
    }
  }

  if (touched.payments.size > 0) {
    const payments = await uow
      .selectFrom('sales_customer_payments')
      .select(['id', 'customer_id', 'received_by_user_id', 'site_id', 'version'])
      .where('id', 'in', binIds(touched.payments))
      .execute();
    for (const payment of payments) {
      const base = {
        dataset: SALES_RECENT_DATASET,
        entityType: 'CUSTOMER_PAYMENT',
        entityId: fromBin(payment.id),
        rowVersion: payment.version,
      } as const;
      entries.push({ ...base, scopeType: 'USER', scopeId: fromBin(payment.received_by_user_id) });
      entries.push({ ...base, scopeType: 'SITE', scopeId: fromBin(payment.site_id) });
      if (payment.customer_id) customers.add(fromBin(payment.customer_id));
    }
  }

  await recordChanges(uow, entries);

  // Encours : le compte conservé d'un compte absorbé (BR-CRM-007).
  const kept = new Set<string>();
  for (const customerId of customers) {
    const customer = await getCustomer(uow, customerId);
    if (customer) kept.add(customer.mergedIntoId ?? customer.id);
  }
  for (const customerId of kept) await emitCustomerChange(uow, customerId, at);
}

/** Emplacement de préparation d'une commande existante (avant la commande). */
async function orderLocationOf(uow: Uow, orderId: string): Promise<string | undefined> {
  const row = await uow
    .selectFrom('sales_sales_orders')
    .select('fulfilment_location_id')
    .where('id', '=', toBin(orderId))
    .executeTakeFirst();
  return row ? fromBin(row.fulfilment_location_id) : undefined;
}

export interface SalesCommandRegistry {
  register<P>(input: RegisterCommandInput<P>): void;
}

/** Registre dont chaque gestionnaire publie ses changements en fin de commande (sauf refus). */
export function withSalesChanges(
  registry: Pick<CommandHandlerRegistry, 'register'>,
): SalesCommandRegistry {
  return {
    register<P>(input: RegisterCommandInput<P>): void {
      registry.register<P>({
        ...input,
        handler: async (uow, envelope) => {
          const previousOrderLocationId =
            envelope.aggregate_type === 'SALES_ORDER'
              ? await orderLocationOf(uow, envelope.aggregate_id)
              : undefined;
          const outcome = await input.handler(uow, envelope);
          if (outcome.status !== 'REJECTED') {
            await emitSalesChanges(
              uow,
              {
                aggregateType: envelope.aggregate_type,
                aggregateId: envelope.aggregate_id,
                commandId: envelope.command_id,
                ...(previousOrderLocationId !== undefined ? { previousOrderLocationId } : {}),
              },
              new Date(envelope.occurred_at),
            );
          }
          return outcome;
        },
      });
    },
  };
}

export interface SalesDecisionRegistry {
  register(operationType: string, handler: ApprovalDecisionHandler): void;
}

/** Registre de décisions dont chaque gestionnaire publie les documents de son sujet. */
export function withSalesDecisionChanges(
  registry: Pick<ApprovalDecisionHandlerRegistry, 'register'>,
): SalesDecisionRegistry {
  return {
    register(operationType: string, handler: ApprovalDecisionHandler): void {
      registry.register(operationType, async (uow, ctx) => {
        await handler(uow, ctx);
        await emitSalesChanges(
          uow,
          { aggregateType: ctx.subjectType, aggregateId: ctx.subjectId },
          ctx.decidedAt,
        );
      });
    },
  };
}
