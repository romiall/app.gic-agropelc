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
  /** `REQUIRED`, `OPTIONAL` ou `NONE` (BR-STK-050). */
  readonly lot_tracking: string;
  /** `SERVICE` : aucun effet de stock (BR-VEN-031). */
  readonly stock_family: string;
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
  /** Booléen, ou 0/1 selon la sérialisation de la ligne ; absent : active. */
  readonly is_active?: boolean | number;
  /** Géorepère de prise de service (chaînes décimales), absent ou nul s'il n'y en a pas. */
  readonly geofence_lat?: string | number | null;
  readonly geofence_lng?: string | number | null;
  readonly geofence_radius_m?: string | number | null;
  readonly max_gps_accuracy_m?: string | number | null;
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
  readonly lots?: readonly StockLotData[];
}

/** (`stock`, portée `LOCATION`) lot d'un solde. */
export interface StockLotData {
  readonly lot_id: string | null;
  readonly lot_code: string | null;
  readonly expiry_date: string | null;
  readonly qty_on_hand: string;
  readonly qty_reserved: string;
  readonly qty_allocated: string;
  readonly last_move_at: string | null;
}

/** (`stock`, portée `LOCATION`) seuil d'un produit sur un emplacement (BR-STK-051). */
export interface StockThresholdData {
  readonly id: string;
  readonly location_id: string;
  readonly product_id: string;
  readonly min_qty_base: string;
  readonly target_qty_base: string;
  readonly is_active: boolean;
}

/** (`customers`) */
export interface CustomerData {
  readonly id: string;
  readonly stage: string;
  readonly display_name: string;
  readonly contact_name: string | null;
  readonly category_id: string | null;
  readonly phone_primary: string | null;
  readonly address_text: string | null;
  readonly zone_id: string;
  readonly owner_user_id: string | null;
  readonly home_site_id: string | null;
  readonly merged_into_id: string | null;
  readonly credit_allowed: boolean;
  readonly credit_limit_xaf: number | null;
  readonly payment_terms_days: number | null;
  readonly outstanding_xaf: number;
  /** Acquisition du compte (BR-CRM-003) : qui l'a créé, et quand (instant ISO). */
  readonly acquired_by_user_id?: string | null;
  readonly acquired_at?: string | null;
  /** Position du compte (chaînes décimales), absente tant qu'aucune n'est enregistrée. */
  readonly lat?: string | null;
  readonly lng?: string | null;
  readonly version: number;
  /**
   * Compte créé sur l'appareil et pas encore retéléchargé : commande `crm.customer.create` dont une
   * vente, une commande ou un encaissement de ce client doit dépendre (`depends_on`).
   */
  readonly pending_command_id?: string;
}

/** (`transfers`, portée `LOCATION`) transfert de stock ; quantités en chaînes décimales. */
export interface StockTransferData {
  readonly id: string;
  readonly doc_number: string;
  readonly transfer_kind: 'STANDARD' | 'INTERNAL' | 'BLIND_RECEIPT';
  readonly from_location_id: string;
  readonly to_location_id: string;
  readonly status: string;
  readonly dispatched_at: string | null;
  readonly carrier_name: string | null;
  readonly notes: string | null;
  readonly occurred_at: string;
  readonly version: number;
  readonly lines: readonly {
    readonly id: string;
    readonly product_id: string;
    readonly lot_id: string | null;
    readonly unit_code: string;
    readonly requested_qty_base: string | null;
    readonly dispatched_qty_base: string | null;
    readonly received_qty_base: string | null;
  }[];
}

/** (`counts`) inventaire d'un emplacement ; quantités en unité de base, chaînes décimales. */
export interface InventoryCountData {
  readonly id: string;
  readonly doc_number: string;
  readonly location_id: string;
  readonly count_type: 'FULL' | 'PARTIAL' | 'SPOT' | 'OPENING';
  readonly status: string;
  readonly occurred_at: string;
  readonly submitted_at: string | null;
  readonly posted_at: string | null;
  readonly version: number;
  readonly lines: readonly {
    readonly id: string;
    readonly product_id: string;
    readonly lot_id: string | null;
    readonly counted_at: string;
    readonly counted_qty_base: string;
    readonly theoretical_qty_base: string | null;
    readonly variance_qty_base: string | null;
    readonly variance_reason_code_id: string | null;
    readonly comment: string | null;
  }[];
}

/** (`crm_activity`) objectif commercial ; `target_value` : chaîne décimale. */
export interface SalesTargetData {
  readonly id: string;
  readonly target_type: 'USER' | 'TEAM' | 'SITE';
  readonly user_id: string | null;
  readonly team_id: string | null;
  readonly site_id: string | null;
  readonly metric: string;
  readonly product_id: string | null;
  readonly period_start: string;
  readonly period_end: string;
  readonly target_value: string;
  readonly status: string;
}

/** (`crm_activity`, 90 derniers jours) visite d'un compte. */
export interface VisitData {
  readonly id: string;
  readonly customer_id: string;
  readonly user_id: string;
  readonly outcome_reason_code_id: string | null;
  readonly notes: string | null;
  readonly next_action_at: string | null;
  readonly next_action_note: string | null;
  readonly flags: readonly string[];
  readonly status: string;
  readonly occurred_at: string;
  /** Visite saisie sur l'appareil, pas encore retéléchargée : sa commande `crm.visit.record`. */
  readonly pending_command_id?: string;
}

/** (`crm_activity`, 90 derniers jours) appel, SMS, courriel… */
export interface InteractionData {
  readonly id: string;
  readonly customer_id: string;
  readonly user_id: string;
  readonly channel: 'APPEL' | 'SMS' | 'EMAIL' | 'AUTRE';
  readonly direction: 'ENTRANT' | 'SORTANT';
  readonly summary: string | null;
  readonly next_action_at: string | null;
  readonly next_action_note: string | null;
  readonly status: string;
  readonly occurred_at: string;
  /** Échange saisi sur l'appareil, pas encore retéléchargé : sa commande `crm.interaction.record`. */
  readonly pending_command_id?: string;
}

/** (`customer_category`, repli générique `GLOBAL`) */
export interface CustomerCategoryData {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly is_active: boolean;
}

/** (`fieldwork`, portée `USER`) session de travail de l'agent. */
export interface WorkSessionData {
  readonly id: string;
  readonly user_id: string;
  readonly declared_zone_id: string;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly status: string;
  /** Dérogation de prise de service : `NOT_REQUIRED`, `PENDING`, `APPROVED` ou `REJECTED`. */
  readonly override_status?: string;
  /** Session ouverte sur l'appareil, pas encore retéléchargée : la commande qui l'ouvre. */
  readonly pending_command_id?: string;
  /** Fin calculée sur l'appareil : clôture automatique à 23:59 (BR-TER-008). */
  readonly auto_close?: boolean;
}

/** (`cash`) compte de trésorerie actif du détenteur, du responsable ou du site. */
export interface CashAccountData {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly account_type: string;
  readonly site_id: string | null;
  readonly holder_user_id: string | null;
  readonly responsible_user_id: string;
  readonly status: string;
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
  /** Pour un motif de perte (`LOSS`) : catégorie de perte liée, ou aucune. */
  readonly loss_category: string | null;
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
