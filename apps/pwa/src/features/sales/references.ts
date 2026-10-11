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
import { deviceWorkSessions } from '../fieldwork/service.js';
import { toPriceRules } from './pricing.js';
import { stillInFlight } from './pending.js';
import { pendingConsumption, stockKey } from './stock.js';
import type {
  CashAccountData,
  CampaignData,
  CustomerCategoryData,
  InteractionData,
  EggCollectionData,
  GoodsReceiptData,
  InventoryCountData,
  LotConsumptionData,
  LotLossData,
  LotObservationData,
  LotWeighingData,
  ProductCategoryData,
  ProductionLotData,
  PurchaseOrderData,
  PurchaseRequestData,
  SalesTargetData,
  SupplierData,
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
  /**
   * Visites et interactions enregistrées des 90 derniers jours (jeu `crm_activity`), et celles
   * saisies sur l'appareil pas encore retéléchargées.
   */
  readonly visits: readonly VisitData[];
  readonly interactions: readonly InteractionData[];
  /**
   * Comptes fusionnés connus de l'appareil : identifiant absorbé → compte conservé (racine de la chaîne
   * de fusion, BR-CRM-007). Leurs ventes, commandes et visites se rattachent au compte conservé.
   */
  readonly customerAlias: ReadonlyMap<string, string>;
  /** Catégories de produit (jeu `product_category`). */
  readonly productCategories: readonly ProductCategoryData[];
  /** Production (jeu `production`) : lots et saisies des 30 derniers jours. */
  readonly productionLots: readonly ProductionLotData[];
  readonly lotLosses: readonly LotLossData[];
  readonly lotConsumptions: readonly LotConsumptionData[];
  readonly lotWeighings: readonly LotWeighingData[];
  readonly lotObservations: readonly LotObservationData[];
  readonly eggCollections: readonly EggCollectionData[];
  readonly productionPulledAt: string | undefined;
  /** Heure du dernier tirage complet du jeu `stock` (soldes, effectif des lots). */
  readonly stockPulledAt: string | undefined;
  /** Achats (jeu `procurement`) : bons de commande à recevoir, réceptions récentes, fournisseurs. */
  readonly purchaseOrders: readonly PurchaseOrderData[];
  readonly purchaseRequests: readonly PurchaseRequestData[];
  readonly goodsReceipts: readonly GoodsReceiptData[];
  readonly suppliers: ReadonlyMap<string, SupplierData>;
  readonly procurementPulledAt: string | undefined;
  /** Objectifs commerciaux servis (jeu `crm_activity`). */
  readonly targets: readonly SalesTargetData[];
  /** Inventaires des emplacements du périmètre (jeu `counts`) et heure de leur dernier tirage. */
  readonly counts: readonly InventoryCountData[];
  readonly countsPulledAt: string | undefined;
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

/** Compte absorbé → compte conservé, en suivant la chaîne `merged_into_id` (garde contre un cycle). */
export function mergeAliases(customers: readonly CustomerData[]): Map<string, string> {
  const into = new Map(
    customers
      .filter((customer) => customer.merged_into_id !== null)
      .map((customer) => [customer.id, customer.merged_into_id as string]),
  );
  const alias = new Map<string, string>();
  for (const id of into.keys()) {
    let root = id;
    const seen = new Set<string>();
    while (into.has(root) && !seen.has(root)) {
      seen.add(root);
      root = into.get(root) as string;
    }
    alias.set(id, root);
  }
  return alias;
}

/** Identifiant du compte conservé pour un compte éventuellement absorbé. */
export const rootCustomerId = (alias: ReadonlyMap<string, string>, id: string): string =>
  alias.get(id) ?? id;

interface CreatePayload {
  readonly displayName?: string;
  readonly contactName?: string;
  readonly categoryId?: string | null;
  readonly phonePrimary?: string | null;
  readonly addressText?: string;
  readonly zoneId?: string;
  readonly homeSiteId?: string;
  readonly position?: { readonly lat: number; readonly lng: number } | null;
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
        lat: payload.position ? String(payload.position.lat) : null,
        lng: payload.position ? String(payload.position.lng) : null,
        credit_allowed: false,
        credit_limit_xaf: null,
        payment_terms_days: null,
        outstanding_xaf: 0,
        version: 0,
        pending_command_id: command.command_id,
      };
    });
}

interface ActivityPayload {
  readonly customerId?: string;
  readonly outcomeReasonCodeId?: string;
  readonly notes?: string | null;
  readonly channel?: InteractionData['channel'];
  readonly direction?: InteractionData['direction'];
  readonly summary?: string | null;
  readonly nextActionAt?: string | null;
  readonly nextActionNote?: string | null;
}

/** Commandes d'activité de l'appareil que le jeu `crm_activity` ne sert pas encore (ADR-051 §3). */
function pendingActivity(
  outbox: readonly OutboxCommand[],
  commandType: string,
  downloaded: ReadonlySet<string>,
  pulledAt: string | undefined,
): { readonly command: OutboxCommand; readonly payload: ActivityPayload }[] {
  return outbox
    .filter(
      (command) =>
        command.command_type === commandType &&
        !downloaded.has(command.aggregate_id) &&
        stillInFlight(command, pulledAt),
    )
    .map((command) => ({ command, payload: command.payload as ActivityPayload }));
}

/** Visites saisies sur l'appareil, affichées dans l'activité du compte dès la saisie. */
export function pendingVisits(
  outbox: readonly OutboxCommand[],
  downloaded: readonly VisitData[],
  pulledAt: string | undefined,
): VisitData[] {
  return pendingActivity(
    outbox,
    'crm.visit.record',
    new Set(downloaded.map((visit) => visit.id)),
    pulledAt,
  ).map(({ command, payload }) => ({
    id: command.aggregate_id,
    customer_id: payload.customerId ?? '',
    user_id: command.author_user_id,
    outcome_reason_code_id: payload.outcomeReasonCodeId ?? null,
    notes: payload.notes ?? null,
    next_action_at: payload.nextActionAt ?? null,
    next_action_note: payload.nextActionNote ?? null,
    flags: [],
    status: 'RECORDED',
    occurred_at: command.occurred_at,
    pending_command_id: command.command_id,
  }));
}

/** Échanges (appel, SMS…) saisis sur l'appareil, affichés dès la saisie. */
export function pendingInteractions(
  outbox: readonly OutboxCommand[],
  downloaded: readonly InteractionData[],
  pulledAt: string | undefined,
): InteractionData[] {
  return pendingActivity(
    outbox,
    'crm.interaction.record',
    new Set(downloaded.map((interaction) => interaction.id)),
    pulledAt,
  ).map(({ command, payload }) => ({
    id: command.aggregate_id,
    customer_id: payload.customerId ?? '',
    user_id: command.author_user_id,
    channel: payload.channel ?? 'AUTRE',
    direction: payload.direction ?? 'SORTANT',
    summary: payload.summary ?? null,
    next_action_at: payload.nextActionAt ?? null,
    next_action_note: payload.nextActionNote ?? null,
    status: 'RECORDED',
    occurred_at: command.occurred_at,
    pending_command_id: command.command_id,
  }));
}

export async function loadSalesReferences(db: GicDatabase): Promise<SalesReferences> {
  const [
    productCategories,
    productionLots,
    lotLosses,
    lotConsumptions,
    lotWeighings,
    lotObservations,
    eggCollections,
    productionCursor,
    purchaseRequests,
    purchaseOrders,
    goodsReceipts,
    suppliers,
    procurementCursor,
    targets,
    counts,
    countsCursor,
    visits,
    interactions,
    transfers,
    customerCategories,
    thresholds,
    cashAccounts,
    stockCursor,
    ordersCursor,
    customersCursor,
    activityCursor,
    fieldworkCursor,
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
    listProjected<ProductCategoryData>(db, 'product_category', 'PRODUCT_CATEGORY'),
    listProjected<ProductionLotData>(db, 'production', 'PRODUCTION_LOT'),
    listProjected<LotLossData>(db, 'production', 'LOT_LOSS'),
    listProjected<LotConsumptionData>(db, 'production', 'LOT_CONSUMPTION'),
    listProjected<LotWeighingData>(db, 'production', 'LOT_WEIGHING'),
    listProjected<LotObservationData>(db, 'production', 'LOT_OBSERVATION'),
    listProjected<EggCollectionData>(db, 'production', 'EGG_COLLECTION'),
    db.syncCursors.get('production'),
    listProjected<PurchaseRequestData>(db, 'procurement', 'PURCHASE_REQUEST'),
    listProjected<PurchaseOrderData>(db, 'procurement', 'PURCHASE_ORDER'),
    listProjected<GoodsReceiptData>(db, 'procurement', 'GOODS_RECEIPT'),
    listProjected<SupplierData>(db, 'procurement', 'SUPPLIER'),
    db.syncCursors.get('procurement'),
    listProjected<SalesTargetData>(db, 'crm_activity', 'SALES_TARGET'),
    listProjected<InventoryCountData>(db, 'counts', 'INVENTORY_COUNT'),
    db.syncCursors.get('counts'),
    listProjected<VisitData>(db, 'crm_activity', 'VISIT'),
    listProjected<InteractionData>(db, 'crm_activity', 'INTERACTION'),
    listProjected<StockTransferData>(db, 'transfers', 'STOCK_TRANSFER'),
    listProjected<CustomerCategoryData>(db, 'customer_category', 'CUSTOMER_CATEGORY'),
    listProjected<StockThresholdData>(db, 'stock', 'STOCK_THRESHOLD'),
    listProjected<CashAccountData>(db, 'cash', 'CASH_ACCOUNT'),
    db.syncCursors.get('stock'),
    db.syncCursors.get('orders'),
    db.syncCursors.get('customers'),
    db.syncCursors.get('crm_activity'),
    db.syncCursors.get('fieldwork'),
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
          command.command_type.startsWith('crm.') ||
          command.command_type.startsWith('fieldwork.') ||
          command.command_type.startsWith('procurement.') ||
          command.command_type.startsWith('production.') ||
          command.command_type.startsWith('pricing.') ||
          command.command_type.startsWith('catalog.'),
      )
      .toArray(),
  ]);
  const zoneMap = byId(zones);
  const transferMap = byId(transfers);
  // Tablette partagée : seules les créations de l'utilisateur détenteur des données sont proposées.
  // Une opération qui dépendrait de la commande d'un autre auteur attendrait sa reconnexion.
  const owner = meta?.data_user_id;
  const ownOutbox = owner ? outbox.filter((command) => command.author_user_id === owner) : outbox;
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
    pending: pendingConsumption(outbox, stockCursor?.pulled_at, transferMap, byId(productionLots)),
    customers: [
      ...customers.filter((customer) => customer.merged_into_id === null),
      ...pendingCustomers(ownOutbox, customers, customersCursor?.pulled_at),
    ],
    paymentMethods: paymentMethods.filter((method) => method.is_active),
    reasonCodes: reasonCodes.filter((reason) => reason.is_active),
    settings,
    workSessions: deviceWorkSessions(workSessions, ownOutbox, fieldworkCursor?.pulled_at),
    orders: orderMap,
    sales,
    payments,
    visits: [
      ...visits.filter((visit) => visit.status === 'RECORDED'),
      ...pendingVisits(ownOutbox, visits, activityCursor?.pulled_at),
    ],
    interactions: [
      ...interactions.filter((interaction) => interaction.status === 'RECORDED'),
      ...pendingInteractions(ownOutbox, interactions, activityCursor?.pulled_at),
    ],
    customerAlias: mergeAliases(customers),
    productCategories: [...productCategories].sort((a, b) => a.name.localeCompare(b.name, 'fr')),
    productionLots,
    lotLosses,
    lotConsumptions,
    lotWeighings,
    lotObservations,
    eggCollections,
    productionPulledAt: productionCursor?.pulled_at,
    stockPulledAt: stockCursor?.pulled_at,
    purchaseOrders,
    purchaseRequests,
    goodsReceipts,
    suppliers: byId(suppliers),
    procurementPulledAt: procurementCursor?.pulled_at,
    targets,
    counts,
    countsPulledAt: countsCursor?.pulled_at,
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
