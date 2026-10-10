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

- **PK** `code`. **Suppr.** `DESACTIVATION`. **Offline** DL (jeu `catalog`, type `PAYMENT_METHOD`, clé dérivée du code, ADR-031 ; publié par le seed, une ligne par `version`, P4-11).
- **Implémentation** (P4-02, migration `20261003090000_create_finance_core.sql`) : colonnes `created_at`, `updated_at`, `version` ; `CHECK` sur `default_account_type` ; suppression refusée par déclencheur. Données initiales : les cinq moyens d'AV-056 (seed).

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
- **Suppr.** `DESACTIVATION` (solde nul, et aucune remise de fonds `SENT` depuis ou vers le compte : `CASH_ACCOUNT_TRANSFER_IN_TRANSIT`, P5-15). **Offline** DL (comptes de l'utilisateur, avec solde au téléchargement) — jeu `cash` (P4-11) : comptes actifs du détenteur, à défaut du responsable, et caisse du PDV de son site ; republié à chaque mouvement ; un compte désactivé sort du jeu.
- **Commandes** (P4-03, permission `finance.cash_account.manage`) : `finance.cash_account.create` (site requis pour une caisse de PDV, détenteur pour une caisse d'utilisateur, responsable actif ; unicité « une active par site / par détenteur » contrôlée avant l'insertion, `CASH_ACCOUNT_DUPLICATE`), `.update` (nom, responsable, référence externe), `.deactivate` (refusée tant que le solde n'est pas nul, `CASH_ACCOUNT_NOT_EMPTY`). Réconciliation quotidienne `finance.cash.reconcile_daily` (solde projeté = Σ entrées − Σ sorties du registre) ; `rebuildCashBalances` est une procédure de maintenance.
- **Implémentation** (P4-02) : unicités « une active par… » portées par les colonnes générées `active_pos_site` et `active_user_holder` (index uniques, conventions §4 MySQL) ; `CHECK` site requis pour `CAISSE_PDV` et détenteur requis pour `CAISSE_UTILISATEUR` ; pas de `CHECK balance_xaf ≥ 0` (solde négatif admis hors ligne, `CASH_NEGATIVE`, BR-FIN-012) ; suppression refusée par déclencheur.

## finance.cash_sessions

**Responsabilité** : session de caisse d'un PDV (SM-CASH-SESSION ; BR-DIS-005 à 008 ; ADR-032). Implémentée en P5-03 ; commandes en P5-12 et P5-13.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `cash_account_id` | uuid → cash_accounts | Non | — | Caisse de PDV |
| `site_id` | uuid → organization.sites | Non | — | Site de la caisse, copié à l'ouverture |
| `opened_by`, `opened_device_id` | uuid → identity | Non, Oui | — | Ouvreur et appareil |
| `opened_at` | ts | Non | — | Heure métier ; début de la **fenêtre** |
| `business_date` | date | Non | généré | Jour métier de l'ouverture (Africa/Douala) |
| `opening_counted_xaf` | money_xaf | Non | — | Fonds compté |
| `opening_expected_xaf` | bigint | Non | — | Solde du registre à l'ouverture (somme ordonnée par `occurred_at`), signé |
| `opening_variance_xaf` | bigint | Non | — | Écart d'ouverture = compté − attendu ; période précédente, **exclu** de l'attendu |
| `closed_by`, `closed_device_id` | uuid → identity | Oui | — | |
| `closed_at` | ts | Oui | — | Fin de la fenêtre |
| `closing_counted_xaf` | money_xaf | Oui | — | |
| `closing_expected_xaf` | bigint | Oui | — | Attendu par fenêtre à la clôture (ADR-032 §3) ; valeur de clôture, jamais réécrite |
| `variance_xaf` | bigint | Oui | — | Compté − attendu à la clôture (exact, `CHECK`) |
| `status` | enum(`OPEN`,`PENDING_VALIDATION`,`VALIDATED`) | Non | `OPEN` | |
| `force_closed`, `forced_by` | boolean, uuid | Non, Oui | false | Clôture forcée par un responsable (AV-155) |
| `auto_validated` | boolean | Non | false | Écart nul ou toléré : validé d'office, sans valideur |
| `validated_by`, `validated_at` | uuid, ts | Oui | — | |
| `variance_reason` | varchar(500) | Oui | — | |
| `approval_request_id` | uuid → approvals.approval_requests | Oui | — | Demande `CASH_VARIANCE` |
| `open_account` | uuid | Oui | généré | `cash_account_id` si `OPEN` : index unique (INV-FIN-06) |
| `command_id`, `client_created_at`, `received_at_server`, `captured_offline`, `clock_suspect`, `backdated_reason` | | | | Origine de l'ouverture |
| `close_command_id`, `close_captured_offline` | uuid, boolean | Oui, Non | | Origine de la clôture |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `open_account` (une session `OPEN` par compte, INV-FIN-06), `command_id`, `close_command_id`. **IX** `(cash_account_id, opened_at)`, `(site_id, business_date)`, `(status, opened_at)`.
- **CK** `ck_finance_cash_sessions_opening` (écart d'ouverture = compté − attendu), `_closing` (ouverte ⇒ aucune donnée de clôture ; close ⇒ toutes, écart exact), `_validation` (`VALIDATED` ⇒ date et valideur ou validation d'office), `_forced`.
- **Déclencheurs** : `insert_guard` et `update_guard` (non-chevauchement des fenêtres d'un compte, **filet** : le code l'assure, ADR-032 §2) ; `update_guard` : identité et ouverture immuables, session close ne se rouvre pas, **session `VALIDATED` figée** (INV-FIN-05) ; `no_delete`.
- **Suppr.** `IMMUABLE` après `VALIDATED` ; correction par ajustement (ADR-006). **Audit** Ouverture, clôture, validation, réévaluation. **Offline** DL (session ouverte du PDV, jeu `cash`, P5-18), CR. **Remarque** : aucune clé étrangère de la session vers le registre (le mouvement d'écart cite la session, pas l'inverse).

## finance.cash_session_adjustments

**Responsabilité** : réévaluation d'une session close après une opération tardive (ADR-032 §6 ; BR-DIS-008). Implémentée en P5-03 ; écrite en P5-13.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `session_id` | uuid → cash_sessions | Non | — | |
| `movement_id` | uuid → cash_movements | Non | — | Mouvement compensatoire `SESSION_VARIANCE` (unique) |
| `trigger_movement_id` | uuid → cash_movements | Oui | — | Mouvement tardif déclencheur |
| `cause` | enum(`LATE_OPERATION`,`REVERSAL`) | Non | — | |
| `variance_before_xaf`, `variance_after_xaf`, `delta_xaf` | bigint | Non | — | Σ des écarts posés avant, écart courant après ; `delta = après − avant ≠ 0` (INV-FIN-11) |
| `expected_after_xaf` | bigint | Non | — | Attendu recalculé |
| `treatment` | enum(`INCLUDED_IN_VALIDATION`,`OWN_APPROVAL`) | Non | — | Session `PENDING_VALIDATION` : validé avec elle ; `VALIDATED` : demande propre |
| `status` | enum(`PENDING`,`VALIDATED`) | Non | `PENDING` | |
| `applied_at` | ts | Non | — | |
| `approval_request_id`, `validated_by`, `validated_at`, `variance_reason` | | Oui | — | Validation |
| `command_id` | uuid | Oui | — | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `movement_id`. **IX** `(session_id, applied_at)`, `(status, applied_at)`. **Déclencheurs** : ajustement immuable hors validation, figé une fois `VALIDATED`, jamais supprimé.

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
- **Écriture** (P4-03) : seul `recordCashMovement` (module `finance`) écrit ce registre, dans la transaction du document appelant ; il verrouille la ligne du compte, insère le mouvement et met à jour `balance_xaf` (INV-FIN-02). Sens et document source suivent le type (`CUSTOMER_PAYMENT` : entrée, `CUSTOMER_PAYMENT` ; `REFUND` : sortie, `SALE_REFUND` ; `SUPPLIER_PAYMENT`, `EXPENSE` : sorties ; `TRANSFER_OUT`/`TRANSFER_IN` : `CASH_TRANSFER` ; `SESSION_VARIANCE` : `CASH_SESSION`, dans les deux sens ; `OPENING_BALANCE` : entrée citant `CASH_SESSION`, **DÉDUIT** faute de document propre). Un inverse reprend compte, montant, type et document de l'original en sens opposé, une seule fois ; un remboursement partiel n'est pas un inverse mais un mouvement `REFUND`. BR-FIN-012 : en ligne, une sortie ne rend pas négatif le solde d'une caisse physique (`CASH_INSUFFICIENT`) ; hors ligne elle est appliquée et signalée (`negativeBalance`, anomalie `CASH_NEGATIVE` à ouvrir par l'appelant). Un compte inactif refuse un mouvement en ligne, l'accepte hors ligne (fait accompli). Un inverse porte en général l'`occurred_at` de l'original ; **exception** : l'inverse de la sortie d'une remise annulée est daté de l'annulation, fait physique nouveau (ADR-032 §2 dernière phrase, AV-157 (a) ; D09 §16) — la session d'un mouvement se détermine par son `occurred_at`, jamais par `reverses_movement_id`.
- **Implémentation** (P4-02) : `CHECK is_reversal ⇔ reverses_movement_id` non nul ; modification et suppression refusées par déclencheurs ; droits `SELECT`, `INSERT` seulement ; `cash_session_id` est un **index dénormalisé** de la session de la fenêtre (clé étrangère depuis P5-03) : l'attendu et INV-FIN-11 se calculent par fenêtre de temps, jamais par ce pointeur (ADR-032 §2).

## finance.cash_transfers

**Responsabilité** : remise de fonds entre comptes (SM-CASH-TRANSFER ; ADR-032 §7). Implémentée en P5-03 ; commandes livrées en P5-15 (D09 §16).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| [STD-DOC] | | | | Type `RMF` ; `site_id` de numérotation facultatif (le compte source n'a pas toujours de site) |
| `from_account_id`, `to_account_id` | uuid → cash_accounts | Non | — | Distincts (`CHECK`) |
| `amount_sent_xaf` | money_xaf | Non | — | > 0 |
| `amount_received_xaf` | money_xaf | Oui | — | ≥ 0 |
| `discrepancy_xaf` | bigint | Oui | — | Reçu − envoyé (comparaison null-safe) : négatif = manque, positif = excédent |
| `status` | enum(`SENT`,`RECEIVED`,`DISCREPANCY_PENDING`,`CLOSED`,`CANCELLED`) | Non | `SENT` | Cohérence état/données par `CHECK` |
| `sent_by`, `sent_device_id`, `sent_at` | uuid, uuid, ts | Non, Oui, Non | — | |
| `carrier_user_id`, `carrier_name` | uuid, label | Oui | — | Porteur : utilisateur connu ou nom libre (AV-158) |
| `received_by`, `received_device_id`, `received_at` | | Oui | — | Réception (`received_at`, `received_by` et montant reçu vont ensemble) |
| `out_movement_id` | uuid → cash_movements | Non | — | `TRANSFER_OUT` (unique) |
| `in_movement_id` | uuid → cash_movements | Oui | — | `TRANSFER_IN` du montant reçu |
| `cancel_movement_id` | uuid → cash_movements | Oui | — | Inverse de l'annulation |
| `imputation` | enum(`SENDER`,`CARRIER`,`RECEIVER`,`COMPANY`) | Oui | — | Imputation d'un écart clos (AV-153), **sans écriture de trésorerie** |
| `closing_reason`, `closed_by`, `closed_at`, `approval_request_id` | | Oui | — | Clôture de l'écart (type `CASH_TRANSFER_DISCREPANCY`) |
| `cancel_reason`, `cancelled_by`, `cancelled_at` | | Oui | — | |
| `occurred_at`, `command_id`, `receive_command_id`, `cancel_command_id`, [STD-ORIGIN] | | | | Origine de chaque étape |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `doc_number`, `(created_device_id, local_ref)`, `command_id`, `receive_command_id`, `cancel_command_id`, `out_movement_id`. **IX** `(from_account_id, status)`, `(to_account_id, status)`, `(status, sent_at)`.
- **Déclencheurs** : l'envoi est immuable ; une remise `RECEIVED`, `CLOSED` ou `CANCELLED` ne change plus ; `CLOSED` et `CANCELLED` sont terminaux ; `no_delete`. **Suppr.** `ANNULATION`. **Offline** DL (en cours, jeu `cash`, P5-18), CR.
- **Commandes** (P5-15, permission `finance.cash_transfer.record` sur le compte concerné) : `finance.cash_transfer.send` (sortie `TRANSFER_OUT`, numéro `RMF` : site du compte source, sinon du destinataire, sinon série globale `finance.cash_transfer_series_code`, AV-179 ; paires `finance.cash_transfer_allowed_pairs`, AV-158 ; `CASH_NEGATIVE` hors ligne ; commentaire d'envoi tracé par l'audit, sans colonne), `.receive` (entrée du montant reçu, aucune pour 0 ; écart → demande `CASH_TRANSFER_DISCREPANCY`, `approval_request_id` ; récepteur ≠ expéditeur), `.cancel` (expéditeur seul, inverse daté de l'annulation, `cancel_movement_id`) ; décision `CASH_TRANSFER_DISCREPANCY` → `CLOSED` (`imputation`, `closing_reason`, `closed_by`, `closed_at`, aucun mouvement) ; courses hors ligne conservées en conflit informatif (AV-176) ; `cash_session_id` des mouvements laissé à P5-12. Lectures : `findCashTransfer`, `cashTransfersInTransit`, `verifyCashTransfers`.
- **Implémentation** (migration `20261010092000`, P5-15) : `ck_finance_cash_transfers_state` remplacé — `DISCREPANCY_PENDING` et `CLOSED` exigent l'entrée si le montant reçu est > 0 et l'interdisent s'il est nul (AV-178), `CLOSED` exige aussi le motif, `CANCELLED` n'a aucune entrée ; nouveau `ck_finance_cash_transfers_in_movement` (entrée ⇒ reçu > 0). Le code applique ces règles avant l'écriture.

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
| `mismatch_details` | json | Oui | — | Écarts de rapprochement (technique, affichage) |
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
