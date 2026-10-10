/**
 * Formes des projections hors ligne lues par les écrans de vente, telles que les sert
 * `apps/server/src/sync/entity-projections.ts` (jeu entre parenthèses). Montants en XAF entiers ;
 * quantités du stock en chaînes décimales, celles des commandes et des ventes en nombres.
 */

/** (`product`) */
export interface ProductData {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly category_id: string;
  readonly base_unit_code: string;
  readonly is_sellable: boolean;
  readonly pricing_mode: 'PER_UNIT' | 'PER_WEIGHT';
  readonly status: string;
}

/** (`product_unit`) `factor_to_base` : chaîne `DECIMAL(14,6)`. */
export interface ProductUnitData {
  readonly id: string;
  readonly product_id: string;
  readonly unit_code: string;
  readonly factor_to_base: string;
  readonly is_sales_unit: boolean;
  readonly is_active: boolean;
}

/** (`price_rule`, règles actives seulement) */
export interface PriceRuleData {
  readonly id: string;
  readonly code: string;
  readonly version: number;
  readonly product_id: string;
  readonly unit_price_xaf: number;
  readonly pricing_unit_code: string;
  readonly zone_id: string | null;
  readonly site_id: string | null;
  readonly customer_category_id: string | null;
  readonly channel_code: string | null;
  readonly min_quantity: string | null;
  readonly commercial_campaign_id: string | null;
  readonly priority: number;
  readonly valid_from: string;
  readonly valid_to: string | null;
  readonly status: string;
}

/** (`commercial_campaign`) */
export interface CampaignData {
  readonly id: string;
  readonly valid_from: string;
  readonly valid_to: string;
  readonly status: string;
}

/** (`zone`) */
export interface ZoneData {
  readonly id: string;
  readonly parent_id: string | null;
  readonly name: string;
  readonly depth: number;
}

/** (`site`) */
export interface SiteData {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly site_type: string;
  readonly zone_id: string;
  readonly status: string;
}

/** (`location`) */
export interface LocationData {
  readonly id: string;
  readonly site_id: string | null;
  readonly code: string;
  readonly name: string;
  readonly location_type: string;
  readonly is_virtual: boolean;
  readonly custody_mode: 'EXCLUSIVE_USER' | 'EXCLUSIVE_DEVICE' | 'SHARED' | null;
  readonly custodian_user_id: string | null;
  readonly designated_device_id: string | null;
  readonly status: string;
}

/** (`stock`, portée `LOCATION`) quantités en unité de base, chaînes décimales. */
export interface StockBalanceData {
  readonly location_id: string;
  readonly product_id: string;
  readonly qty_on_hand: string;
  readonly qty_reserved: string;
  readonly qty_allocated: string;
}

/** (`customers`) */
export interface CustomerData {
  readonly id: string;
  readonly stage: string;
  readonly display_name: string;
  readonly contact_name: string | null;
  readonly category_id: string | null;
  readonly phone_primary: string | null;
  readonly zone_id: string;
  readonly owner_user_id: string | null;
  readonly home_site_id: string | null;
  readonly merged_into_id: string | null;
  readonly credit_allowed: boolean;
  readonly credit_limit_xaf: number | null;
  readonly payment_terms_days: number | null;
  readonly outstanding_xaf: number;
  readonly version: number;
}

/** (`catalog`, `PAYMENT_METHOD`) */
export interface PaymentMethodData {
  readonly id: string;
  readonly code: string;
  readonly label: string;
  readonly requires_reference: boolean;
  readonly default_account_type: string;
  readonly is_active: boolean;
}

/** (`reason_code`) */
export interface ReasonCodeData {
  readonly id: string;
  readonly category: string;
  readonly code: string;
  readonly label: string;
  readonly requires_comment: boolean;
  readonly is_active: boolean;
}

/** (`setting`, paramètres visibles du client, historisés) */
export interface SettingData {
  readonly id: string;
  readonly key: string;
  readonly value: unknown;
  readonly scope_type: string;
  readonly scope_id: string | null;
  readonly valid_from: string;
}

/** (`orders`) commande ouverte, prix devisés, sans coût. */
export interface SalesOrderData {
  readonly id: string;
  readonly doc_number: string;
  readonly local_ref: string | null;
  readonly status: 'DRAFT' | 'CONFIRMED' | 'PARTIALLY_FULFILLED';
  readonly site_id: string;
  readonly customer_id: string;
  readonly commercial_user_id: string | null;
  readonly created_by: string;
  readonly fulfilment_location_id: string;
  readonly requested_delivery_date: string | null;
  readonly delivery_address: string | null;
  readonly total_estimated_xaf: number;
  readonly advance_paid_xaf: number;
  readonly occurred_at: string;
  readonly version: number;
  readonly lines: readonly SalesOrderLineData[];
}

export interface SalesOrderLineData {
  readonly id: string;
  readonly line_no: number;
  readonly product_id: string;
  readonly product_name: string;
  readonly quantity: number;
  readonly unit_code: string;
  readonly quantity_base: number;
  readonly withdrawn_quantity_base: number;
  readonly sold_quantity_base: number;
  readonly delivered_quantity_base: number;
  readonly quoted_unit_price_xaf: number;
  readonly line_total_xaf: number;
}

/** (`sales_recent`) vente des 7 derniers jours, prix appliqués, sans coût. */
export interface SaleData {
  readonly id: string;
  readonly doc_number: string;
  readonly local_ref: string | null;
  readonly sale_type: 'DIRECT' | 'ORDER';
  readonly order_id: string | null;
  readonly status: 'CONFIRMED' | 'CANCELLATION_REQUESTED' | 'CANCELLED';
  readonly payment_status: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';
  readonly customer_id: string | null;
  readonly site_id: string;
  readonly from_location_id: string;
  readonly seller_user_id: string;
  readonly commercial_user_id: string | null;
  readonly total_xaf: number;
  readonly discount_total_xaf: number;
  readonly cancelled_xaf: number;
  readonly net_total_xaf: number;
  readonly amount_paid_xaf: number;
  readonly balance_due_xaf: number;
  readonly due_date: string | null;
  readonly flags: readonly string[];
  readonly captured_offline: boolean;
  readonly occurred_at: string;
  readonly version: number;
  readonly lines: readonly SaleLineData[];
  readonly payments: readonly {
    readonly allocation_id: string;
    readonly payment_id: string;
    readonly amount_xaf: number;
    readonly status: 'ACTIVE' | 'REVERSED';
  }[];
}

export interface SaleLineData {
  readonly id: string;
  readonly line_no: number;
  readonly product_id: string;
  readonly product_name: string;
  readonly quantity: number;
  readonly unit_code: string;
  readonly quantity_base: number;
  readonly unit_price_xaf: number;
  readonly discount_xaf: number;
  readonly line_total_xaf: number;
  readonly cancelled_quantity_base: number;
  readonly cancelled_xaf: number;
  readonly delivered_quantity_base: number;
}

/** (`sales_recent`) encaissement des 7 derniers jours. */
export interface CustomerPaymentData {
  readonly id: string;
  readonly doc_number: string;
  readonly status: string;
  readonly customer_id: string | null;
  readonly site_id: string;
  readonly payment_method_code: string;
  readonly amount_xaf: number;
  readonly external_reference: string | null;
  readonly received_by_user_id: string;
  readonly unallocated_xaf: number;
  readonly occurred_at: string;
}
