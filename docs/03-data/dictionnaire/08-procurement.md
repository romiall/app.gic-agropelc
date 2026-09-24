# Dictionnaire — schéma `procurement`

## procurement.suppliers

**Responsabilité** : fournisseur (CM §26).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `code` | code | Non | — | |
| `name` | label | Non | — | |
| `supplied_categories` | text[] | Non | `{}` | Codes de catégories de produits fournies |
| `contact_name` | label | Oui | — | |
| `phone` | phone | Oui | — | |
| `email` | varchar(200) | Oui | — | |
| `address` | text | Oui | — | |
| `tax_id` | varchar(40) | Oui | — | Identifiant fiscal (optionnel) |
| `payment_terms_days` | smallint | Oui | — | |
| `status` | enum(`ACTIVE`,`INACTIVE`) | Non | `ACTIVE` | |
| `notes` | text | Oui | — | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `code`. **IX** plein texte `ngram` sur `name` (MySQL — ADR-023). **Suppr.** `DESACTIVATION`. **Audit** Toute modification. **Offline** DL (actifs : id, code, nom).

## procurement.purchase_requests

**Responsabilité** : demande d'achat (SM-PURCHASE-REQUEST).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| [STD-DOC] | | | | Type `DA` |
| `requested_by` | uuid → identity.users | Non | — | |
| `needed_by_date` | date | Oui | — | |
| `justification` | text | Non | — | |
| `estimated_total_xaf` | money_xaf | Non | 0 | |
| `status` | enum(`SUBMITTED`,`APPROVED`,`REJECTED`,`CANCELLED`,`PARTIALLY_ORDERED`,`ORDERED`,`CLOSED`) | Non | `SUBMITTED` | |
| `approval_request_id` | uuid → approvals.approval_requests | Oui | — | |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `doc_number`, `command_id`. **Suppr.** `ANNULATION`. **Offline** DL (les siennes), CR.

## procurement.purchase_request_lines

**Responsabilité** : lignes de DA.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `request_id` | uuid → purchase_requests | Non | — | |
| `product_id` | uuid → catalog.products | Non | — | Achetable |
| `quantity_base` | qty | Non | — | |
| `unit_code`, `quantity` | | Non | — | |
| `estimated_unit_price_xaf` | money_xaf | Oui | — | |
| `ordered_qty_base` | qty | Non | 0 | Dénormalisé |
| `notes` | text | Oui | — | |

- **PK** `id`. **CK** `quantity_base > 0` ; `ordered_qty_base ≤ quantity_base`.

## procurement.purchase_orders

**Responsabilité** : bon de commande fournisseur (SM-PURCHASE-ORDER).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| [STD-DOC] | | | | Type `BC` ; `site_id` = site de livraison |
| `supplier_id` | uuid → suppliers | Non | — | |
| `delivery_location_id` | uuid → organization.locations | Non | — | |
| `expected_delivery_date` | date | Oui | — | |
| `total_xaf` | money_xaf | Non | — | |
| `status` | enum(`DRAFT`,`PENDING_APPROVAL`,`APPROVED`,`SENT`,`PARTIALLY_RECEIVED`,`RECEIVED`,`CLOSED`,`CANCELLED`) | Non | `DRAFT` | |
| `approval_request_id` | uuid → approvals.approval_requests | Oui | — | |
| `approved_by`, `approved_at` | uuid, ts | Oui | — | |
| `sent_at` | ts | Oui | — | |
| `closed_reason` | text | Oui | — | |
| [STD-CANCEL] | | | | |
| [STD-AUDIT] | | | | Créé en ligne (pas de STD-ORIGIN d'appareil) ; `occurred_at` = date du BC |
| `occurred_at` | ts | Non | — | |

- **PK** `id`. **UQ** `doc_number`. **IX** `(supplier_id, status)`, `(delivery_location_id, status)`.
- **Suppr.** `ANNULATION`. **Audit** Chaque transition. **Offline** DL (`SENT` et `PARTIALLY_RECEIVED` livrables sur le site de l'utilisateur).

## procurement.purchase_order_lines

**Responsabilité** : lignes de BC.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `order_id` | uuid → purchase_orders | Non | — | |
| `line_no` | smallint | Non | — | |
| `request_line_id` | uuid → purchase_request_lines | Oui | — | |
| `product_id` | uuid → catalog.products | Non | — | |
| `unit_code` | code | Non | — | |
| `ordered_qty_base` | qty | Non | — | |
| `unit_price_xaf` | money_xaf | Non | — | Par unité de base |
| `line_total_xaf` | money_xaf | Non | — | |
| `accepted_qty_base` | qty | Non | 0 | Σ acceptés des réceptions `POSTED` (dénormalisé) |
| `invoiced_qty_base` | qty | Non | 0 | Σ facturés (dénormalisé) |
| `closed_qty_base` | qty | Non | 0 | Reliquat clôturé |
| `status` | enum(`OPEN`,`RECEIVED`,`CLOSED`,`CANCELLED`) | Non | `OPEN` | |

- **PK** `id`. **UQ** `(order_id, line_no)`.
- **CK** `ordered_qty_base > 0` ; `accepted_qty_base + closed_qty_base ≤ ordered_qty_base`, sauf excédent tracé (INV-APP-02).
- **Intégrité** INV-APP-04 (déclencheur : pas d'augmentation de `ordered_qty_base` ni de `unit_price_xaf` si le BC est `SENT` ou au-delà).

## procurement.goods_receipts

**Responsabilité** : réception (SM-RECEIPT ; CM §28).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| [STD-DOC] | | | | Type `REC` |
| `purchase_order_id` | uuid → purchase_orders | Oui | — | Nul pour une réception sans BC |
| `supplier_id` | uuid → suppliers | Non | — | |
| `location_id` | uuid → organization.locations | Non | — | Emplacement de réception |
| `received_by` | uuid → identity.users | Non | — | Magasinier |
| `supplier_delivery_note_ref` | varchar(60) | Oui | — | Numéro du bon de livraison (détection de doublon) |
| `observations` | text | Oui | — | |
| `status` | enum(`POSTED`,`POSTED_PENDING_REVIEW`,`REVIEW_REJECTED`,`QUARANTINED`,`REJECTED`,`CANCELLATION_PENDING`,`CANCELLED`) | Non | — | |
| `approval_request_id` | uuid → approvals.approval_requests | Oui | — | |
| `total_accepted_value_xaf` | money_xaf | Non | 0 | |
| [STD-CANCEL] | | | | |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `doc_number`, `command_id` ; `(supplier_id, supplier_delivery_note_ref)` parmi les réceptions comptabilisées (index unique partiel, BR-APP-012).
- **IX** `(purchase_order_id)`, `(location_id, occurred_at)`.
- **Suppr.** `ANNULATION`. **Audit** Chaque transition. **Offline** DL (30 j du site), CR. **Intégrité** INV-APP-03.

## procurement.goods_receipt_lines

**Responsabilité** : lignes de réception.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `receipt_id` | uuid → goods_receipts | Non | — | |
| `po_line_id` | uuid → purchase_order_lines | Oui | — | |
| `product_id` | uuid → catalog.products | Non | — | |
| `unit_code` | code | Non | — | |
| `qty_delivered_base` | qty | Non | — | Livré |
| `qty_rejected_base` | qty | Non | 0 | Rejeté |
| `qty_accepted_base` | qty | Non | calculé | = livré − rejeté |
| `rejection_reason_code_id` | uuid → catalog.reason_codes | Oui | — | Requis si rejet > 0 |
| `unit_cost_xaf` | money_xaf | Non | — | Prix du BC ou déclaré |
| `supplier_lot_ref` | varchar(60) | Oui | — | |
| `expiry_date` | date | Oui | — | |
| `stock_lot_id` | uuid → inventory.stock_lots | Oui | — | Lot créé pour le lot fournisseur |

- **PK** `id`. **CK** `0 ≤ qty_rejected_base ≤ qty_delivered_base` ; `qty_accepted_base = qty_delivered_base − qty_rejected_base` (colonne générée, INV-APP-01).
- **Intégrité** INV-STK-12.
