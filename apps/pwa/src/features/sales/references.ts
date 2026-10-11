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
import { pendingConsumption, stockKey } from './stock.js';
import type {
  CashAccountData,
  CampaignData,
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

export async function loadSalesReferences(db: GicDatabase): Promise<SalesReferences> {
  const [
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
    db.outbox.filter((command) => command.command_type.startsWith('sales.')).toArray(),
  ]);
  const zoneMap = byId(zones);
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
    pending: pendingConsumption(outbox, stockCursor?.pulled_at),
    customers: customers.filter((customer) => customer.merged_into_id === null),
    paymentMethods: paymentMethods.filter((method) => method.is_active),
    reasonCodes: reasonCodes.filter((reason) => reason.is_active),
    settings,
    workSessions,
    orders: orderMap,
    sales,
    payments,
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
