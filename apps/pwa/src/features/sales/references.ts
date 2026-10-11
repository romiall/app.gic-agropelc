/**
 * Référentiels des écrans de vente, lus sur l'appareil (projections téléchargées et outbox) en une
 * seule lecture suivie : catalogue, prix, organisation, stock, portefeuille, moyens de paiement,
 * motifs, paramètres, commandes ouvertes, ventes et encaissements récents. Tout est disponible hors
 * ligne ; rien n'est demandé au réseau.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import type { PriceRule } from '@gic/domain';
import { getDb, type GicDatabase, type OutboxCommand } from '../../storage/db.js';
import { listProjected } from '../../storage/projections.js';
import { toPriceRules } from './pricing.js';
import { stillInFlight } from './pending.js';
import { pendingConsumption, stockKey } from './stock.js';
import type {
  CashAccountData,
  CampaignData,
  CustomerCategoryData,
  InteractionData,
  VisitData,
  CustomerData,
  CustomerPaymentData,
  LocationData,
  PaymentMethodData,
  PriceRuleData,
  ProductData,
  ProductUnitData,
  ReasonCodeData,
  SaleData,
  SalesOrderData,
  SettingData,
  SiteData,
  WorkSessionData,
  StockBalanceData,
  StockThresholdData,
  StockTransferData,
  ZoneData,
} from './types.js';

export interface SalesReferences {
  readonly products: readonly ProductData[];
  readonly productUnits: readonly ProductUnitData[];
  readonly priceRules: readonly PriceRule[];
  readonly campaigns: readonly CampaignData[];
  readonly zones: ReadonlyMap<string, ZoneData>;
  readonly sites: ReadonlyMap<string, SiteData>;
  readonly locations: readonly LocationData[];
  /** Soldes par `emplacement:produit`. */
  readonly stock: ReadonlyMap<string, StockBalanceData>;
  /** Quantités déjà retirées par l'appareil, en attente de confirmation, par `emplacement:produit`. */
  readonly pending: ReadonlyMap<string, number>;
  readonly customers: readonly CustomerData[];
  readonly paymentMethods: readonly PaymentMethodData[];
  readonly reasonCodes: readonly ReasonCodeData[];
  readonly settings: readonly SettingData[];
  readonly workSessions: readonly WorkSessionData[];
  readonly orders: ReadonlyMap<string, SalesOrderData>;
  readonly sales: readonly SaleData[];
  readonly payments: readonly CustomerPaymentData[];
  /** Visites et interactions enregistrées des 90 derniers jours (jeu `crm_activity`). */
  readonly visits: readonly VisitData[];
  readonly interactions: readonly InteractionData[];
  /** Transferts du périmètre (jeu `transfers`), tous statuts reçus. */
  readonly transfers: ReadonlyMap<string, StockTransferData>;
  /** Catégories de client actives (jeu `customer_category`). */
  readonly customerCategories: readonly CustomerCategoryData[];
  /** Seuils de stock actifs des emplacements du périmètre (jeu `stock`). */
  readonly thresholds: readonly StockThresholdData[];
  /** Comptes de trésorerie actifs servis à l'appareil (jeu `cash`). */
  readonly cashAccounts: readonly CashAccountData[];
  /** Dernière synchronisation complète (tous les jeux tirés), pour la fraîcheur des prix. */
  readonly lastSyncAt: string | null;
  /** Heure du dernier tirage complet des jeux `orders` et `customers` (ADR-051 §3). */
  readonly ordersPulledAt: string | undefined;
  readonly customersPulledAt: string | undefined;
  /** Commandes de vente de l'outbox, tous statuts (affichage des opérations en attente). */
  readonly outbox: readonly OutboxCommand[];
}

const byId = <T extends { readonly id: string }>(rows: readonly T[]): Map<string, T> =>
  new Map(rows.map((row) => [row.id, row]));

interface CreatePayload {
  readonly displayName?: string;
  readonly contactName?: string;
  readonly categoryId?: string | null;
  readonly phonePrimary?: string | null;
  readonly addressText?: string;
  readonly zoneId?: string;
  readonly homeSiteId?: string;
}

/**
 * Comptes créés sur l'appareil que le jeu `customers` ne sert pas encore (en attente d'envoi, ou
 * acceptés mais pas encore retéléchargés, ADR-051 §3) : proposés à la vente, à la commande et à
 * l'encaissement, qui dépendront de leur création.
 */
export function pendingCustomers(
  outbox: readonly OutboxCommand[],
  downloaded: readonly CustomerData[],
  customersPulledAt: string | undefined,
): CustomerData[] {
  const known = new Set(downloaded.map((customer) => customer.id));
  return outbox
    .filter(
      (command) =>
        command.command_type === 'crm.customer.create' &&
        !known.has(command.aggregate_id) &&
        stillInFlight(command, customersPulledAt),
    )
    .map((command) => {
      const payload = command.payload as CreatePayload;
      return {
        id: command.aggregate_id,
        stage: 'PROSPECT',
        display_name: payload.displayName ?? '',
        contact_name: payload.contactName ?? null,
        category_id: payload.categoryId ?? null,
        phone_primary: payload.phonePrimary ?? null,
        address_text: payload.addressText ?? null,
        zone_id: payload.zoneId ?? '',
        owner_user_id: command.author_user_id,
        home_site_id: payload.homeSiteId ?? null,
        merged_into_id: null,
        credit_allowed: false,
        credit_limit_xaf: null,
        payment_terms_days: null,
        outstanding_xaf: 0,
        version: 0,
        pending_command_id: command.command_id,
      };
    });
}

export async function loadSalesReferences(db: GicDatabase): Promise<SalesReferences> {
  const [
    visits,
    interactions,
    transfers,
    customerCategories,
    thresholds,
    cashAccounts,
    stockCursor,
    ordersCursor,
    customersCursor,
    meta,
    products,
    productUnits,
    priceRules,
    campaigns,
    zones,
    sites,
    locations,
    balances,
    customers,
    paymentMethods,
    reasonCodes,
    settings,
    workSessions,
    orders,
    sales,
    payments,
    outbox,
  ] = await Promise.all([
    listProjected<VisitData>(db, 'crm_activity', 'VISIT'),
    listProjected<InteractionData>(db, 'crm_activity', 'INTERACTION'),
    listProjected<StockTransferData>(db, 'transfers', 'STOCK_TRANSFER'),
    listProjected<CustomerCategoryData>(db, 'customer_category', 'CUSTOMER_CATEGORY'),
    listProjected<StockThresholdData>(db, 'stock', 'STOCK_THRESHOLD'),
    listProjected<CashAccountData>(db, 'cash', 'CASH_ACCOUNT'),
    db.syncCursors.get('stock'),
    db.syncCursors.get('orders'),
    db.syncCursors.get('customers'),
    db.syncMeta.get('device'),
    listProjected<ProductData>(db, 'product', 'PRODUCT'),
    listProjected<ProductUnitData>(db, 'product_unit', 'PRODUCT_UNIT'),
    listProjected<PriceRuleData>(db, 'price_rule', 'PRICE_RULE'),
    listProjected<CampaignData>(db, 'commercial_campaign', 'COMMERCIAL_CAMPAIGN'),
    listProjected<ZoneData>(db, 'zone', 'ZONE'),
    listProjected<SiteData>(db, 'site', 'SITE'),
    listProjected<LocationData>(db, 'location', 'LOCATION'),
    listProjected<StockBalanceData>(db, 'stock', 'STOCK_BALANCE'),
    listProjected<CustomerData>(db, 'customers', 'CUSTOMER'),
    listProjected<PaymentMethodData>(db, 'catalog', 'PAYMENT_METHOD'),
    listProjected<ReasonCodeData>(db, 'reason_code', 'REASON_CODE'),
    listProjected<SettingData>(db, 'setting', 'SETTING'),
    listProjected<WorkSessionData>(db, 'fieldwork', 'WORK_SESSION'),
    listProjected<SalesOrderData>(db, 'orders', 'SALES_ORDER'),
    listProjected<SaleData>(db, 'sales_recent', 'SALE'),
    listProjected<CustomerPaymentData>(db, 'sales_recent', 'CUSTOMER_PAYMENT'),
    db.outbox
      .filter(
        (command) =>
          command.command_type.startsWith('sales.') ||
          command.command_type.startsWith('inventory.') ||
          command.command_type === 'crm.customer.create',
      )
      .toArray(),
  ]);
  const zoneMap = byId(zones);
  const transferMap = byId(transfers);
  const orderMap = byId(orders);
  return {
    products,
    productUnits,
    priceRules: toPriceRules(priceRules, zoneMap),
    campaigns,
    zones: zoneMap,
    sites: byId(sites),
    locations,
    stock: new Map(
      balances.map((balance) => [stockKey(balance.location_id, balance.product_id), balance]),
    ),
    pending: pendingConsumption(outbox, stockCursor?.pulled_at, transferMap),
    customers: [
      ...customers.filter((customer) => customer.merged_into_id === null),
      ...pendingCustomers(outbox, customers, customersCursor?.pulled_at),
    ],
    paymentMethods: paymentMethods.filter((method) => method.is_active),
    reasonCodes: reasonCodes.filter((reason) => reason.is_active),
    settings,
    workSessions,
    orders: orderMap,
    sales,
    payments,
    visits: visits.filter((visit) => visit.status === 'RECORDED'),
    interactions: interactions.filter((interaction) => interaction.status === 'RECORDED'),
    transfers: transferMap,
    customerCategories: customerCategories
      .filter((category) => category.is_active)
      .sort((a, b) => a.name.localeCompare(b.name, 'fr')),
    thresholds: thresholds.filter((threshold) => threshold.is_active),
    cashAccounts,
    lastSyncAt: meta?.last_sync_at ?? null,
    ordersPulledAt: ordersCursor?.pulled_at,
    customersPulledAt: customersCursor?.pulled_at,
    outbox,
  };
}

/** Référentiels suivis en direct ; `undefined` pendant la première lecture. */
export function useSalesReferences(): SalesReferences | undefined {
  return useLiveQuery(() => loadSalesReferences(getDb()), []);
}
