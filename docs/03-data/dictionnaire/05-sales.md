# Dictionnaire — schéma `sales`

## sales.sales_orders

**Responsabilité** : commande client (SM-ORDER ; D04 §7.1).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| [STD-DOC] | | | | Type `CMD` |
| `customer_id` | uuid → crm.customers | Non | — | Client identifié (BR-VEN-001) |
| `commercial_user_id` | uuid → identity.users | Non | — | Commercial ayant obtenu la commande (attribution) |
| `channel_code` | code → catalog.sales_channels | Non | — | |
| `fulfilment_location_id` | uuid → organization.locations | Non | — | Emplacement de préparation (réservation) |
| `requested_delivery_date` | date | Oui | — | |
| `delivery_address` | text | Oui | — | |
| `status` | enum(`DRAFT`,`CONFIRMED`,`PARTIALLY_FULFILLED`,`FULFILLED`,`CLOSED`,`CANCELLED`) | Non | — | |
| `reservation_status` | enum(`NONE`,`PARTIAL`,`FULL`,`RELEASED`) | Non | `NONE` | Mis à jour sur réponse d'`inventory` |
| `total_estimated_xaf` | money_xaf | Non | 0 | Σ lignes au prix convenu |
| `advance_paid_xaf` | money_xaf | Non | 0 | Acomptes actifs (dénormalisé) |
| `external_origin` | enum(`NONE`,`KOMMO`) | Non | `NONE` | |
| `confirmed_at` | ts | Oui | — | |
| `closed_reason` | text | Oui | — | Clôture du reliquat |
| [STD-CANCEL] | | | | |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | `version` : concurrence optimiste (BR-VEN-005) |

- **PK** `id`. **UQ** `doc_number` ; `command_id` ; `(created_device_id, local_ref)`.
- **CK** Cohérence statut / colonnes d'annulation ; `total_estimated_xaf ≥ 0`.
- **IX** `(customer_id, occurred_at)`, `(commercial_user_id, occurred_at)`, `(status)` partiel sur les ouvertes, `(fulfilment_location_id, status)`.
- **Suppr.** `ANNULATION`. **Audit** Toute commande. **Offline** DL (ouvertes du périmètre), CR.

## sales.sales_order_lines

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `order_id` | uuid → sales_orders | Non | — | |
| `line_no` | smallint | Non | — | |
| `product_id` | uuid → catalog.products | Non | — | |
| `product_name_snapshot` | label | Non | — | Libellé figé |
| `quantity` | qty | Non | — | Dans l'unité de saisie |
| `unit_code` | code → catalog.units | Non | — | |
| `quantity_base` | qty | Non | — | Unité de base |
| `quoted_unit_price_xaf` | money_xaf | Non | — | Prix convenu (BR-VEN-003) |
| `price_rule_id` | uuid → pricing.price_rules | Oui | — | Nul si dérogation sans règle |
| `price_rule_version` | int | Oui | — | |
| `price_source` | enum(`RULE`,`MANUAL_OVERRIDE`) | Non | `RULE` | |
| `line_total_xaf` | money_xaf | Non | — | |
| `delivered_quantity_base` | qty | Non | 0 | Dénormalisé (INV-VEN-04) |
| `status` | enum(`OPEN`,`FULFILLED`,`CLOSED`,`CANCELLED`) | Non | `OPEN` | |

- **PK** `id`. **UQ** `(order_id, line_no)`. **CK** `quantity > 0` ; `delivered_quantity_base ≤ quantity_base` (INV-VEN-04).
- **Suppr.** Suit la commande. **Offline** DL, CR.

## sales.sales

**Responsabilité** : vente, directe ou sur commande (SM-SALE ; D04 §7.2 ; ADR-014).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| [STD-DOC] | | | | Type `VTE` |
| `sale_type` | enum(`DIRECT`,`ORDER_FULFILMENT`) | Non | — | |
| `order_id` | uuid → sales_orders | Oui | — | Requis si `ORDER_FULFILMENT` |
| `customer_id` | uuid → crm.customers | Oui | — | Nul = vente anonyme (AV-027) |
| `customer_category_id_snapshot` | uuid | Oui | — | Catégorie au moment de la vente |
| `channel_code` | code → catalog.sales_channels | Non | — | Figé (BR-VEN-021) |
| `from_location_id` | uuid → organization.locations | Non | — | Emplacement source (BR-VEN-017) |
| `zone_id` | uuid → organization.zones | Non | — | Zone figée (BR-VEN-022) |
| `seller_user_id` | uuid → identity.users | Non | — | Vendeur exécutant |
| `commercial_user_id` | uuid → identity.users | Oui | — | Commercial attribué (BR-VEN-020) |
| `work_session_id` | uuid → fieldwork.work_sessions | Oui | — | Vente terrain |
| `cash_session_id` | uuid → finance.cash_sessions | Oui | — | Caisse (PDV) |
| `lat`, `lng`, `accuracy_m` | | Oui | — | Position pour une vente terrain |
| `delivered_by_user_id` | uuid → identity.users | Oui | — | Livreur (`ORDER_FULFILMENT`) |
| `recipient_name` | label | Oui | — | Réceptionnaire (livraison) |
| `status` | enum(`CONFIRMED`,`CANCELLATION_REQUESTED`,`CANCELLED`) | Non | `CONFIRMED` | |
| `subtotal_xaf` | money_xaf | Non | — | Σ (quantité × prix appliqué) |
| `discount_total_xaf` | money_xaf | Non | 0 | |
| `tax_total_xaf` | money_xaf | Non | 0 | AV-041 |
| `total_xaf` | money_xaf | Non | — | Total dû |
| `amount_paid_xaf` | money_xaf | Non | 0 | Σ affectations actives (dénormalisé) |
| `balance_due_xaf` | money_xaf | Non | — | `total − paid` |
| `payment_status` | enum(`UNPAID`,`PARTIALLY_PAID`,`PAID`) | Non | — | Dérivé (BR-VEN-026) |
| `due_date` | date | Oui | — | Si reste dû |
| `flags` | text[] | Non | `{}` | `PRICE_MISMATCH`, `STOCK_CONFLICT`, `CREDIT_OVER_LIMIT`, `PRODUCT_INACTIVE`, `OUT_OF_SESSION`, `ORDER_OVER_FULFILMENT` |
| [STD-CANCEL] | | | | |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `doc_number`, `command_id`, `(created_device_id, local_ref)`.
- **CK** `total_xaf = subtotal_xaf − discount_total_xaf + tax_total_xaf` ; `balance_due_xaf = total_xaf − amount_paid_xaf` ; `amount_paid_xaf ≤ total_xaf` (INV-VEN-06) ; `customer_id` nul ⇒ `payment_status = PAID` à la création (INV-VEN-07) ; `ORDER_FULFILMENT` ⇔ `order_id` non nul.
- **IX** `(occurred_at)`, colonne générée `business_date` + `(business_date, from_location_id)`, `(customer_id, occurred_at)`, `(commercial_user_id, business_date)`, `(seller_user_id, business_date)`, `(order_id)`, `(payment_status)` partiel sur les impayées.
- **Suppr.** `ANNULATION` (contre-écritures). **Hist.** Immuable (INV-VEN-02), seules les colonnes d'annulation et de paiement dérivé évoluent.
- **Audit** Enregistrement, demande d'annulation, annulation. **Offline** DL (7 jours de l'utilisateur ou du PDV), CR.

## sales.sale_lines

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `sale_id` | uuid → sales | Non | — | |
| `line_no` | smallint | Non | — | |
| `order_line_id` | uuid → sales_order_lines | Oui | — | Livraison |
| `product_id` | uuid → catalog.products | Non | — | |
| `product_name_snapshot` | label | Non | — | |
| `quantity` | qty | Non | — | Unité de saisie |
| `unit_code` | code → catalog.units | Non | — | |
| `quantity_base` | qty | Non | — | |
| `pricing_quantity` | qty | Non | — | = quantité, ou poids si `PER_WEIGHT` |
| `pricing_unit_code` | code | Non | — | |
| `list_unit_price_xaf` | money_xaf | Oui | — | Prix catalogue résolu |
| `unit_price_xaf` | money_xaf | Non | — | Prix appliqué |
| `price_rule_id` | uuid → pricing.price_rules | Oui | — | |
| `price_rule_version` | int | Oui | — | |
| `price_specificity` | smallint | Oui | — | Explication du choix |
| `price_source` | enum(`RULE`,`ORDER_QUOTE`,`MANUAL_OVERRIDE`) | Non | — | |
| `override_reason_code_id` | uuid → catalog.reason_codes | Oui | — | Requis si `MANUAL_OVERRIDE` |
| `override_approval_request_id` | uuid → approvals.approval_requests | Oui | — | Au-delà du plafond |
| `discount_xaf` | money_xaf | Non | 0 | |
| `tax_rate` | rate | Non | 0 | AV-041 |
| `line_total_xaf` | money_xaf | Non | — | BR-VEN-014 |
| `unit_cost_xaf` | money_xaf | Oui | — | Coût moyen pondéré des mouvements de la ligne (renseigné par le serveur) |
| `allocation_id` | uuid → inventory.stock_allocations | Oui | — | Quota consommé |
| `client_lot_hint` | uuid | Oui | — | Lot proposé par l'appareil (information) |

- **PK** `id`. **UQ** `(sale_id, line_no)`.
- **CK** `quantity > 0` ; `line_total_xaf = round(pricing_quantity × unit_price_xaf) − discount_xaf` (INV-VEN-03) ; `MANUAL_OVERRIDE` ⇒ motif.
- **IX** `(product_id)`, `(price_rule_id)`.
- **Relations** 1 ligne → N mouvements `SALE` (un par lot), référencés par `stock_moves.source_line_id`.
- **Suppr.** Suit la vente. **Offline** DL, CR.

## sales.customer_payments

**Responsabilité** : encaissement client (SM-CUSTOMER-PAYMENT ; règles D09 §7.1).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| [STD-DOC] | | | | Type `ENC` |
| `customer_id` | uuid → crm.customers | Oui | — | Nul pour une vente anonyme |
| `payment_method_code` | code → finance.payment_methods | Non | — | |
| `amount_xaf` | money_xaf | Non | — | > 0 |
| `external_reference` | varchar(80) | Oui | — | Référence mobile money ou virement |
| `received_by_user_id` | uuid → identity.users | Non | — | |
| `cash_account_id` | uuid → finance.cash_accounts | Non | — | Compte crédité (BR-FIN-002) |
| `cash_session_id` | uuid → finance.cash_sessions | Oui | — | |
| `cash_movement_id` | uuid (réf. vers `finance.cash_movements`) | Oui | — | Nul tant que `SUSPECT_DUPLICATE` |
| `status` | enum(`RECORDED`,`SUSPECT_DUPLICATE`,`REJECTED`,`CANCELLATION_REQUESTED`,`CANCELLED`) | Non | — | |
| `unallocated_xaf` | money_xaf | Non | — | Crédit client restant (dénormalisé) |
| [STD-CANCEL] | | | | |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `doc_number`, `command_id` ; `(payment_method_code, external_reference)` parmi `status = 'RECORDED'` (INV-FIN-03).
- **CK** `amount_xaf > 0` ; `external_reference` requis pour les moyens qui l'exigent (TX).
- **IX** `(customer_id, occurred_at)`, `(cash_session_id)`.
- **Suppr.** `ANNULATION`. **Audit** Toute action. **Offline** DL (7 j), CR.

## sales.payment_allocations

**Responsabilité** : affectation d'un encaissement à une vente (règlement) ou à une commande (acompte).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `payment_id` | uuid → customer_payments | Non | — | |
| `sale_id` | uuid → sales | Oui | — | |
| `order_id` | uuid → sales_orders | Oui | — | Acompte |
| `amount_xaf` | money_xaf | Non | — | > 0 |
| `allocated_at` | ts | Non | — | Heure métier |
| `status` | enum(`ACTIVE`,`REVERSED`) | Non | `ACTIVE` | |
| `reversed_at` | ts | Oui | — | |
| `reversal_cause` | enum(`PAYMENT_CANCELLED`,`SALE_CANCELLED`,`REALLOCATED`,`ORDER_FULFILLED`) | Oui | — | |
| `command_id` | uuid | Oui | — | |
| `created_at`, `created_by` | | | | |

- **PK** `id`. **CK** exactement une cible (`sale_id` xor `order_id`) ; `amount_xaf > 0`.
- **IX** `(sale_id)` partiel `ACTIVE`, `(order_id)` partiel `ACTIVE`, `(payment_id)`.
- **Suppr.** `IMMUABLE` sauf passage à `REVERSED` (registre d'affectation). **Intégrité** INV-FIN-04, INV-VEN-06, INV-FIN-10. **Offline** DL, CR.

## sales.v_receivables (vue)

**Responsabilité** : créances par vente et par client (BR-FIN-007).

Colonnes : `sale_id`, `customer_id`, `commercial_user_id`, `site_id`, `occurred_at`, `due_date`, `total_xaf`, `amount_paid_xaf`, `balance_due_xaf`, `days_overdue`, `aging_bucket` (`0-30`, `31-60`, `61-90`, `>90`).

Source : `sales.sales` (`status <> 'CANCELLED'`, `balance_due_xaf > 0`). Téléchargée sous forme matérialisée (encours par client) dans le périmètre de l'utilisateur, pour le contrôle de crédit hors ligne.
