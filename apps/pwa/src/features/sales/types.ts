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
  /** Intrant consommable sur un lot (aliment, produit vétérinaire…). */
  readonly is_consumable?: boolean;
  /** Produit achetable (demande d'achat, BR-APP-001). */
  readonly is_purchasable?: boolean;
  /** Espèce d'un produit biologique (`POULET_CHAIR`, `PONDEUSE`, `PORC`), sinon nulle. */
  readonly species?: string | null;
}

/** (`product_unit`) `factor_to_base` : chaîne `DECIMAL(14,6)`. */
export interface ProductUnitData {
  readonly id: string;
  readonly product_id: string;
  readonly unit_code: string;
  readonly factor_to_base: string;
  readonly is_sales_unit: boolean;
  /** Conditionnement d'achat (demandes et bons de commande). */
  readonly is_purchase_unit?: boolean;
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

/** (`product_category`, repli générique `GLOBAL`) catégorie de produit. */
export interface ProductCategoryData {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly parent_id: string | null;
  readonly is_active?: boolean | number;
}

/** (`production`, `SITE`) lot de production planifié, actif ou en vente. */
export interface ProductionLotData {
  readonly id: string;
  readonly lot_code: string;
  readonly lot_type: string;
  readonly product_id: string;
  readonly stock_lot_id: string;
  readonly site_id: string;
  readonly main_location_id: string;
  /** Lot lié (truies d'un lot de porcelets, bande ; AV-099, AV-111). */
  readonly parent_lot_id?: string | null;
  readonly strain: string | null;
  readonly status: string;
  readonly start_date: string | null;
  readonly planned_end_date: string | null;
  readonly initial_quantity: number | null;
  readonly occurred_at: string;
}

/** (`production`, `SITE`) lot d'incubation (SM-INCUBATION) et ses compteurs. */
export interface IncubationBatchData {
  readonly id: string;
  readonly batch_code: string;
  readonly stock_lot_id: string;
  readonly site_id: string;
  readonly species: string;
  readonly egg_product_id: string;
  readonly chick_product_id: string;
  readonly incubator_location_id: string;
  readonly hatcher_location_id: string | null;
  readonly egg_source: string;
  readonly eggs_set_qty: number;
  readonly set_at: string;
  readonly expected_candling_date: string | null;
  readonly expected_transfer_date: string | null;
  readonly expected_hatch_date: string | null;
  readonly infertile_qty: number;
  readonly early_dead_qty: number;
  readonly accidental_loss_qty: number;
  readonly transferred_qty: number | null;
  /** `INCUBATING`, `IN_HATCHER`, `CLOSED`, `CANCELLED`. */
  readonly status: string;
}

/** (`production`, 30 derniers jours) perte rattachée à un lot (mortalité comprise). */
export interface LotLossData {
  readonly id: string;
  readonly doc_number: string;
  readonly production_lot_id: string;
  readonly location_id: string;
  readonly quantity_base: number | null;
  readonly category: string;
  readonly reason_code_id: string | null;
  readonly comment: string | null;
  readonly status: string;
  readonly occurred_at: string;
}

/** (`production`, 30 derniers jours) consommation d'intrant imputée à un lot. */
export interface LotConsumptionData {
  readonly id: string;
  readonly production_lot_id: string;
  readonly location_id: string;
  readonly product_id: string;
  readonly quantity_base: number | null;
  readonly unit_code: string;
  readonly quantity: number | null;
  readonly cost_type: string;
  readonly status: string;
  readonly occurred_at: string;
}

/** (`production`, 30 derniers jours) pesée d'échantillon. */
export interface LotWeighingData {
  readonly id: string;
  readonly production_lot_id: string;
  readonly sample_size: number;
  readonly avg_weight_g: number;
  readonly total_weight_kg: number | null;
  readonly status: string;
  readonly occurred_at: string;
}

/** (`production`, 30 derniers jours) observation, immuable. */
export interface LotObservationData {
  readonly id: string;
  readonly production_lot_id: string;
  readonly observation_type: string;
  readonly text: string;
  readonly severity: string;
  readonly occurred_at: string;
}

/** (`production`, 30 derniers jours) collecte d'œufs. */
export interface EggCollectionData {
  readonly id: string;
  readonly doc_number: string;
  readonly production_lot_id: string;
  readonly collection_date: string | null;
  readonly storage_location_id: string;
  readonly collected_qty: number;
  readonly broken_qty: number;
  readonly nonconforming_qty: number;
  readonly marketable_qty: number;
  readonly hatching_qty: number;
  readonly status: string;
  readonly occurred_at: string;
  readonly grades: readonly { readonly product_id: string; readonly quantity: number }[];
}

/** (`procurement`, `USER` = demandeur) demande d'achat, tous statuts. */
export interface PurchaseRequestData {
  readonly id: string;
  readonly doc_number: string;
  readonly site_id: string;
  readonly requested_by: string;
  readonly justification: string;
  readonly needed_by_date: string | null;
  readonly status: string;
  readonly estimated_total_xaf: number | null;
  readonly occurred_at: string;
  readonly lines: readonly {
    readonly id: string;
    readonly product_id: string;
    readonly unit_code: string;
    readonly quantity: string | number;
    readonly quantity_base: string | number;
  }[];
}

/** (`procurement`, `GLOBAL`) fournisseur actif. */
export interface SupplierData {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/** (`procurement`, `SITE`) bon de commande envoyé ou reçu en partie ; quantités en unité de base. */
export interface PurchaseOrderData {
  readonly id: string;
  readonly doc_number: string;
  readonly site_id: string;
  readonly supplier_id: string;
  readonly delivery_location_id: string | null;
  readonly expected_delivery_date: string | null;
  readonly status: string;
  readonly sent_at: string | null;
  readonly version: number;
  readonly lines: readonly {
    readonly id: string;
    readonly line_no: number;
    readonly product_id: string;
    readonly unit_code: string;
    readonly ordered_qty_base: string;
    readonly accepted_qty_base: string;
    readonly closed_qty_base: string;
    readonly remaining_qty_base: string;
    readonly status: string;
  }[];
}

/** (`procurement`, `SITE`, 30 derniers jours) réception de marchandise. */
export interface GoodsReceiptData {
  readonly id: string;
  readonly doc_number: string;
  readonly purchase_order_id: string | null;
  readonly supplier_id: string;
  readonly location_id: string;
  readonly supplier_delivery_note_ref: string | null;
  readonly status: string;
  readonly occurred_at: string;
  readonly lines: readonly {
    readonly id: string;
    readonly po_line_id: string | null;
    readonly product_id: string;
    readonly qty_delivered_base: string;
    readonly qty_rejected_base: string;
    readonly qty_accepted_base: string;
    /** Lot de stock créé à la réception (lot fournisseur) ; nul si le produit n'est pas suivi. */
    readonly stock_lot_id?: string | null;
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

/** (`user`) utilisateur publié à l'appareil (S-28 : jeu tiré, pas encore alimenté). */
export interface UserData {
  readonly id: string;
  readonly full_name: string;
  readonly status: string;
}

/** (`team`) équipe commerciale et son responsable. */
export interface TeamData {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly manager_user_id: string;
  readonly is_active: boolean;
}

/**
 * (`team_membership`) appartenance d'un utilisateur à une équipe, sur une période : instants ISO
 * (colonnes `DATETIME`), comparés comme tels (début inclus, fin exclue, comme le serveur).
 */
export interface TeamMembershipData {
  readonly id: string;
  readonly team_id: string;
  readonly user_id: string;
  readonly valid_from: string;
  readonly valid_to: string | null;
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
  /** Solde du registre au dernier mouvement servi (XAF entiers). */
  readonly balance_xaf?: number;
  readonly status: string;
  readonly version?: number;
}

/**
 * (`allocations`, `STOCK_ALLOCATION`, ligne `DEVICE`) quota actif d'un détenteur sur cet appareil
 * (ADR-033) : quantités en chaînes décimales ; un quota libéré ou révoqué sort du jeu (`SCOPE_EXIT`).
 * Sur une tablette partagée, les quotas de tous ses utilisateurs sont servis (AV-194).
 */
export interface AllocationData {
  readonly id: string;
  readonly location_id: string;
  readonly product_id: string;
  /** Indicatif (AV-160) : le quota se consomme au grain emplacement × produit. */
  readonly lot_id: string | null;
  readonly holder_user_id: string | null;
  readonly holder_device_id: string | null;
  readonly quantity_granted: string;
  readonly quantity_remaining: string;
  readonly valid_until: string | null;
  readonly status: string;
  /** Signal de révocation posé (appareil bloqué ou perdu) : le quota ne se consomme plus. */
  readonly revocation_pending: boolean;
  readonly version: number;
}

/**
 * (`cash`, `CASH_SESSION`, ligne `SITE`) session de caisse du PDV, ouverte ou à valider (ADR-032) ;
 * une session validée sort du jeu. Montants en XAF entiers ; `current_*` comprennent les
 * réévaluations par le delta.
 */
export interface CashSessionData {
  readonly id: string;
  readonly cash_account_id: string;
  readonly site_id: string;
  readonly business_date: string | null;
  readonly status: string;
  readonly opened_by: string;
  readonly opened_at: string;
  readonly opening_counted_xaf: number;
  readonly opening_expected_xaf: number;
  readonly opening_variance_xaf: number;
  readonly closed_by: string | null;
  readonly closed_at: string | null;
  readonly closing_counted_xaf: number | null;
  readonly closing_expected_xaf: number | null;
  readonly variance_xaf: number | null;
  readonly current_expected_xaf: number | null;
  readonly current_variance_xaf: number | null;
  readonly force_closed: boolean;
  readonly version: number;
}

/** (`cash`, `CASH_TRANSFER`) remise de fonds envoyée ou en écart ; reçue, close ou annulée, elle sort. */
export interface CashTransferData {
  readonly id: string;
  readonly doc_number: string;
  readonly local_ref: string | null;
  readonly from_account_id: string;
  readonly to_account_id: string;
  readonly amount_sent_xaf: number;
  readonly amount_received_xaf: number | null;
  readonly status: string;
  readonly sent_by: string;
  readonly sent_at: string;
  readonly carrier_user_id: string | null;
  readonly carrier_name: string | null;
  readonly received_at: string | null;
  readonly version: number;
}

/** (`cash`, `CASH_TRANSFER_TARGET`, ligne `GLOBAL`) destination de remise, sans solde (AV-197). */
export interface CashTransferTargetData {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly account_type: string;
  readonly site_id: string | null;
}

/** (`org`, `POINT_OF_SALE`, ligne `SITE`, clé = le site) configuration du PDV (P5-05). */
export interface PointOfSaleData {
  readonly site_id: string;
  readonly sales_location_id: string;
  readonly replenishment_source_location_id: string | null;
  readonly custody_mode: string;
  readonly designated_device_id: string | null;
  readonly opening_hours: unknown;
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
  /** Compte crédité (caisse du PDV pour les espèces au PDV). */
  readonly cash_account_id?: string | null;
  readonly refunded_xaf?: number;
  readonly occurred_at: string;
}
