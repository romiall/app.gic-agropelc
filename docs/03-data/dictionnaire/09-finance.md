# Dictionnaire — schéma `finance`

> Périmètre du module `finance` : trésorerie, dépenses, dettes fournisseurs. Les encaissements clients sont dans `sales`, le registre de coûts dans `inventory` (D09, en-tête).

## finance.payment_methods

**Responsabilité** : moyens de paiement.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `code` | code | Non | — | PK : `ESPECES`, `MOBILE_MONEY_ORANGE`, `MOBILE_MONEY_MTN`, `VIREMENT`, `CHEQUE` (AV-056) |
| `label` | label | Non | — | |
| `requires_reference` | boolean | Non | false | Référence externe obligatoire |
| `default_account_type` | enum(types de compte) | Non | — | Compte crédité par défaut |
| `is_active` | boolean | Non | true | |

- **PK** `code`. **Suppr.** `DESACTIVATION`. **Offline** DL.

## finance.cash_accounts

**Responsabilité** : réceptacle d'argent avec un responsable (BR-FIN-010).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `code` | code | Non | — | |
| `name` | label | Non | — | |
| `account_type` | enum(`CAISSE_PDV`,`CAISSE_UTILISATEUR`,`CAISSE_CENTRALE`,`MOBILE_MONEY`,`BANQUE`) | Non | — | |
| `site_id` | uuid → organization.sites | Oui | — | Requis pour `CAISSE_PDV` |
| `holder_user_id` | uuid → identity.users | Oui | — | Requis pour `CAISSE_UTILISATEUR` |
| `responsible_user_id` | uuid → identity.users | Non | — | Responsable |
| `external_ref` | varchar(60) | Oui | — | Numéro de compte ou numéro marchand |
| `balance_xaf` | bigint | Non | 0 | Projection (INV-FIN-02) |
| `status` | enum(`ACTIVE`,`INACTIVE`) | Non | `ACTIVE` | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `code` ; une `CAISSE_PDV` active par site ; une `CAISSE_UTILISATEUR` active par utilisateur.
- **Suppr.** `DESACTIVATION` (solde nul). **Offline** DL (comptes de l'utilisateur, avec solde au téléchargement).

## finance.cash_sessions

**Responsabilité** : session de caisse d'un PDV (SM-CASH-SESSION ; BR-DIS-005 à 008).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `cash_account_id` | uuid → cash_accounts | Non | — | |
| `opened_by` | uuid → identity.users | Non | — | |
| `opened_at` | ts | Non | — | Heure métier |
| `opening_counted_xaf` | money_xaf | Non | — | Fonds compté |
| `opening_expected_xaf` | bigint | Non | — | Solde du compte à l'ouverture |
| `closed_by` | uuid → identity.users | Oui | — | |
| `closed_at` | ts | Oui | — | |
| `closing_counted_xaf` | money_xaf | Oui | — | |
| `closing_expected_xaf` | bigint | Oui | — | Recalculé lors d'une réévaluation |
| `variance_xaf` | bigint | Oui | — | Compté − attendu |
| `status` | enum(`OPEN`,`PENDING_VALIDATION`,`VALIDATED`) | Non | `OPEN` | |
| `force_closed` | boolean | Non | false | |
| `validated_by`, `validated_at` | uuid, ts | Oui | — | |
| `variance_reason` | text | Oui | — | |
| `approval_request_id` | uuid → approvals.approval_requests | Oui | — | |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** une session `OPEN` par `cash_account_id` (INV-FIN-06) ; `command_id`.
- **Suppr.** `IMMUABLE` après `VALIDATED` (INV-FIN-05). **Audit** Ouverture, clôture, validation, réévaluation. **Offline** DL (session ouverte), CR.

## finance.cash_movements

**Responsabilité** : registre de trésorerie en ajout seul (BR-FIN-011).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `cash_account_id` | uuid → cash_accounts | Non | — | |
| `direction` | enum(`IN`,`OUT`) | Non | — | |
| `amount_xaf` | money_xaf | Non | — | > 0 |
| `movement_type` | enum(`CUSTOMER_PAYMENT`,`REFUND`,`SUPPLIER_PAYMENT`,`EXPENSE`,`TRANSFER_OUT`,`TRANSFER_IN`,`SESSION_VARIANCE`,`OPENING_BALANCE`) | Non | — | |
| `source_doc_type` | enum(`CUSTOMER_PAYMENT`,`SALE_REFUND`,`SUPPLIER_PAYMENT`,`EXPENSE`,`CASH_TRANSFER`,`CASH_SESSION`) | Non | — | |
| `source_doc_id` | uuid | Non | — | |
| `cash_session_id` | uuid → cash_sessions | Oui | — | |
| `occurred_at` | ts | Non | — | |
| `business_date` | date | Non | généré | |
| `recorded_at` | ts | Non | `now()` | |
| `is_reversal` | boolean | Non | false | |
| `reverses_movement_id` | uuid → cash_movements | Oui | — | Unique |
| `created_by`, `created_device_id`, `command_id`, `captured_offline` | | | | Origine |

- **PK** `id`. **UQ** `reverses_movement_id`. **CK** `amount_xaf > 0`.
- **IX** `(cash_account_id, occurred_at)`, `(source_doc_type, source_doc_id)`, `(cash_session_id)`.
- **Suppr.** `IMMUABLE`. **Offline** SRV (le solde du compte est téléchargé). **Intégrité** INV-FIN-01, INV-FIN-02.

## finance.cash_transfers

**Responsabilité** : remise de fonds entre comptes (SM-CASH-TRANSFER).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| [STD-DOC] | | | | Type `RMF` |
| `from_account_id`, `to_account_id` | uuid → cash_accounts | Non | — | Distincts |
| `amount_sent_xaf` | money_xaf | Non | — | |
| `amount_received_xaf` | money_xaf | Oui | — | |
| `sent_by`, `sent_at` | uuid, ts | Non | — | |
| `received_by`, `received_at` | uuid, ts | Oui | — | |
| `carrier_name` | label | Oui | — | Porteur |
| `status` | enum(`SENT`,`RECEIVED`,`DISCREPANCY_PENDING`,`CLOSED`,`CANCELLED`) | Non | `SENT` | |
| `approval_request_id` | uuid → approvals.approval_requests | Oui | — | |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `doc_number`, `command_id`. **CK** `from_account_id <> to_account_id`. **Suppr.** `ANNULATION`. **Offline** DL (en cours), CR.

## finance.expense_categories

**Responsabilité** : catégories de dépenses.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `code` | code | Non | — | AV-058 |
| `label` | label | Non | — | |
| `default_cost_type` | enum(types de coût) | Oui | — | Type de coût si imputée à un objet |
| `allowed_on_pos` | boolean | Non | false | Petite dépense de caisse PDV (BR-DIS-013) |
| `is_active` | boolean | Non | true | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `code`. **Suppr.** `DESACTIVATION`. **Offline** DL.

## finance.expenses

**Responsabilité** : dépense (SM-EXPENSE ; D09 §7.3).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| [STD-DOC] | | | | Type `DEP` |
| `category_id` | uuid → expense_categories | Non | — | |
| `amount_xaf` | money_xaf | Non | — | > 0 |
| `payee_name` | label | Oui | — | Bénéficiaire |
| `supplier_id` | uuid → procurement.suppliers | Oui | — | |
| `description` | text | Non | — | |
| `cost_object_type` | enum(`PRODUCTION_LOT`,`INCUBATION_BATCH`,`SITE`) | Oui | — | |
| `cost_object_id` | uuid | Oui | — | |
| `paid_now` | boolean | Non | — | |
| `paid_from_account_id` | uuid → cash_accounts | Oui | — | Requis si payée |
| `paid_at` | ts | Oui | — | |
| `status` | enum(`RECORDED`,`PENDING_APPROVAL`,`APPROVED`,`REJECTED`,`PAID`,`PAID_PENDING_APPROVAL`,`PAID_REJECTED`,`CANCELLED`) | Non | — | |
| `approval_request_id` | uuid → approvals.approval_requests | Oui | — | |
| `reclassified_category_id` | uuid → expense_categories | Oui | — | `NON_JUSTIFIEE` (BR-FIN-022) |
| [STD-CANCEL] | | | | |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `doc_number`, `command_id`. **CK** Objet de coût : type et identifiant ensemble ; payée ⇒ compte et date.
- **IX** `(category_id, business_date)`, `(cost_object_type, cost_object_id)`.
- **Suppr.** `ANNULATION`. **Audit** Toute transition. **Offline** DL (30 j), CR.

## finance.supplier_invoices

**Responsabilité** : facture fournisseur (SM-SUPPLIER-INVOICE).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| [STD-DOC] | | | | Type `FF` (numéro interne) |
| `supplier_id` | uuid → procurement.suppliers | Non | — | |
| `supplier_invoice_ref` | varchar(60) | Non | — | Numéro du fournisseur |
| `invoice_date` | date | Non | — | |
| `due_date` | date | Oui | — | |
| `purchase_order_id` | uuid → procurement.purchase_orders | Oui | — | |
| `total_xaf` | money_xaf | Non | — | |
| `tax_total_xaf` | money_xaf | Non | 0 | AV-041 |
| `paid_xaf` | money_xaf | Non | 0 | Dénormalisé |
| `status` | enum(`MISMATCH`,`DISPUTED`,`APPROVED`,`PARTIALLY_PAID`,`PAID`,`CANCELLED`) | Non | — | |
| `mismatch_details` | jsonb | Oui | — | Écarts de rapprochement (technique, affichage) |
| `approval_request_id` | uuid → approvals.approval_requests | Oui | — | |
| [STD-CANCEL] | | | | |
| [STD-AUDIT] | | | | |
| `occurred_at` | ts | Non | — | Date d'enregistrement métier |

- **PK** `id`. **UQ** `(supplier_id, supplier_invoice_ref)` ; `doc_number`. **CK** `paid_xaf ≤ total_xaf` (INV-FIN-07).
- **Suppr.** `ANNULATION`. **Offline** SRV.

## finance.supplier_invoice_lines

**Responsabilité** : lignes de facture.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `invoice_id` | uuid → supplier_invoices | Non | — | |
| `po_line_id` | uuid → procurement.purchase_order_lines | Oui | — | |
| `receipt_line_id` | uuid → procurement.goods_receipt_lines | Oui | — | |
| `product_id` | uuid → catalog.products | Oui | — | Nul pour une ligne de service ou de frais |
| `description` | label | Non | — | |
| `quantity_base` | qty | Oui | — | |
| `unit_price_xaf` | money_xaf | Oui | — | |
| `line_total_xaf` | money_xaf | Non | — | |

- **PK** `id`. **Suppr.** Suit la facture.

## finance.supplier_payments

**Responsabilité** : paiements fournisseurs.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| [STD-DOC] | | | | Type `PF` |
| `supplier_id` | uuid → procurement.suppliers | Non | — | |
| `amount_xaf` | money_xaf | Non | — | |
| `payment_method_code` | code → payment_methods | Non | — | |
| `from_account_id` | uuid → cash_accounts | Non | — | |
| `external_reference` | varchar(80) | Oui | — | |
| `status` | enum(`PENDING_APPROVAL`,`RECORDED`,`REJECTED`,`CANCELLED`) | Non | — | |
| `cash_movement_id` | uuid → cash_movements | Oui | — | Après décaissement |
| `unallocated_xaf` | money_xaf | Non | — | Avance |
| `approval_request_id` | uuid → approvals.approval_requests | Oui | — | |
| [STD-CANCEL] | | | | |
| [STD-AUDIT] | | | | |
| `occurred_at` | ts | Non | — | |

- **PK** `id`. **UQ** `doc_number`. **Suppr.** `ANNULATION`. **Offline** SRV.

## finance.supplier_payment_allocations

**Responsabilité** : affectations aux factures.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `payment_id` | uuid → supplier_payments | Non | — | |
| `invoice_id` | uuid → supplier_invoices | Non | — | |
| `amount_xaf` | money_xaf | Non | — | |
| `status` | enum(`ACTIVE`,`REVERSED`) | Non | `ACTIVE` | |
| `created_at`, `created_by` | | | | |

- **PK** `id`. **Suppr.** `IMMUABLE` sauf `REVERSED`. **Intégrité** INV-FIN-07.

## finance.v_payables (vue)

Dette par facture et par fournisseur : `supplier_id`, `invoice_id`, `due_date`, `total_xaf`, `paid_xaf`, `balance_xaf`, `days_overdue`. Source : factures `APPROVED` et `PARTIALLY_PAID`.
