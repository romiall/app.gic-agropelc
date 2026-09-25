# Dictionnaire — schéma `inventory`

> Stratégie : [`../../02-domain-model/03-strategie-stock.md`](../../02-domain-model/03-strategie-stock.md). Invariants : INV-STK-*.

## inventory.stock_lots

**Responsabilité** : dimension de traçabilité (lot de production, lot d'incubation, lot fournisseur, collecte).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `lot_code` | varchar(40) | Non | — | Code lisible (ex. `L-2026-014`, `INC-2026-007`, `F:ABC123`) |
| `product_id` | uuid → catalog.products | Oui | — | Produit principal (nul si le lot couvre plusieurs produits : œufs et poules d'un lot de pondeuses) |
| `origin_type` | enum(`PRODUCTION_LOT`,`INCUBATION_BATCH`,`SUPPLIER_LOT`,`COLLECTION`) | Non | — | |
| `origin_id` | uuid | Oui | — | Réf. sans FK (lot de production, lot d'incubation, ligne de réception) |
| `supplier_id` | uuid | Oui | — | Réf. sans FK vers `procurement.suppliers` |
| `supplier_lot_ref` | varchar(60) | Oui | — | Lot indiqué par le fournisseur (CM §28) |
| `expiry_date` | date | Oui | — | Péremption (FEFO) |
| `fifo_rank_at` | ts | Non | — | Date de référence FIFO (création ou mise en place) |
| `status` | enum(`OPEN`,`CLOSED`) | Non | `OPEN` | Fermé quand le lot de production est clôturé |
| `created_at`, `created_by` | | | | |

- **PK** `id`. **UQ** `lot_code`. **IX** `(origin_type, origin_id)`, `(expiry_date)`.
- **Suppr.** `IMMUABLE` (statut seulement). **Offline** DL (lots en solde dans le périmètre).

## inventory.stock_moves

**Responsabilité** : registre des mouvements en partie double (ADR-003). **Source de vérité du stock.**

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | Généré par le serveur |
| `product_id` | uuid → catalog.products | Non | — | |
| `lot_id` | uuid → stock_lots | Oui | — | INV-STK-13 |
| `quantity` | qty | Non | — | > 0, unité de base |
| `from_location_id` | uuid → organization.locations | Non | — | Source |
| `to_location_id` | uuid → organization.locations | Non | — | Destination |
| `move_type` | enum (D06 §7.7) | Non | — | Cause |
| `reason_code_id` | uuid → catalog.reason_codes | Oui | — | Motif (pertes, ajustements, rendements) |
| `unit_cost_xaf` | money_xaf | Non | — | Coût unitaire figé (INV-STK-15) ; 0 autorisé pour un service ou une production sans coût |
| `value_xaf` | money_xaf | Non | calculé | `round(quantity × unit_cost_xaf)` |
| `occurred_at` | ts | Non | — | Heure métier du document |
| `business_date` | date | Non | généré | Jour métier (Douala) |
| `recorded_at` | ts | Non | `now()` | Heure d'application |
| `source_doc_type` | enum(`SALE`,`TRANSFER`,`LOSS`,`CONSUMPTION`,`INVENTORY_COUNT`,`GOODS_RECEIPT`,`EGG_COLLECTION`,`INCUBATION_EVENT`,`LOT_ENTRY`) | Non | — | |
| `source_doc_id` | uuid | Non | — | Document |
| `source_line_id` | uuid | Oui | — | Ligne du document |
| `allocation_id` | uuid → stock_allocations | Oui | — | Quota ou réservation consommé |
| `cost_object_type`, `cost_object_id` | enum, uuid | Oui | — | Pour `CONSUMPTION` : objet de coût |
| `is_reversal` | boolean | Non | false | |
| `reverses_move_id` | uuid → stock_moves | Oui | — | INV-STK-04 |
| `created_by` | uuid → identity.users | Non | — | Auteur du document |
| `created_device_id` | uuid → identity.devices | Oui | — | |
| `command_id` | uuid | Oui | — | |
| `captured_offline` | boolean | Non | false | |

- **PK** `id`.
- **UQ** `reverses_move_id` (un seul inverse).
- **CK** `quantity > 0` ; `from_location_id <> to_location_id` ; `is_reversal` ⇔ `reverses_move_id` non nul ; `value_xaf ≥ 0`.
- **IX** `(from_location_id, product_id, occurred_at)`, `(to_location_id, product_id, occurred_at)`, `(source_doc_type, source_doc_id)`, `(lot_id)`, `(business_date, move_type)`, `(command_id)`.
- **Partitionnement** Mensuel par `recorded_at` au-delà de 20 millions de lignes (stratégie stock §10).
- **Suppr.** `IMMUABLE` (déclencheur `BEFORE UPDATE OR DELETE` qui lève une erreur).
- **Audit** L'audit porte sur le **document** source ; le mouvement est lui-même un registre.
- **Offline** SRV : les appareils ne reçoivent que des soldes. Les mouvements sont créés **uniquement** par le serveur.
- **Intégrité** INV-STK-01 à INV-STK-04, INV-STK-12, INV-STK-15, INV-STK-16.

## inventory.stock_balances

**Responsabilité** : projection des soldes (reconstructible).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `location_id` | uuid → organization.locations | Non | — | |
| `product_id` | uuid → catalog.products | Non | — | |
| `lot_key` | uuid | Non | UUID nul | `lot_id` ou UUID nul |
| `qty_on_hand` | qty (signé) | Non | 0 | Peut être négatif seulement dans le cas INV-STK-05 |
| `qty_reserved` | qty | Non | 0 | Σ réservations actives |
| `qty_allocated` | qty | Non | 0 | Σ restes de quotas actifs |
| `value_xaf` | bigint | Non | 0 | Valeur au coût courant (mise à jour par la valorisation) |
| `last_move_at` | ts | Oui | — | |
| `updated_at` | ts | Non | `now()` | |
| `row_version` | bigint | Non | 0 | Incrément à chaque mise à jour (flux de changements) |

- **PK** `(location_id, product_id, lot_key)`.
- **CK** `qty_reserved ≥ 0`, `qty_allocated ≥ 0`.
- **IX** `(product_id, location_id)`.
- **Suppr.** Projection : lignes à zéro conservées. Reconstruction complète possible (procédure `rebuild_stock_balances`).
- **Offline** DL (emplacements du périmètre).

## inventory.stock_balance_snapshots (optionnelle)

**Responsabilité** : instantané de fin de jour métier par (emplacement, produit, lot), pour accélérer les soldes à date (stratégie stock §3.2).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `snapshot_date` | date | Non | — | |
| `location_id`, `product_id`, `lot_key` | uuid | Non | — | |
| `qty_on_hand` | qty | Non | — | Solde à la fin du jour |
| `value_xaf` | bigint | Non | — | |
| `computed_at` | ts | Non | — | Recalculé si un mouvement tardif antérieur arrive |

- **PK** `(snapshot_date, location_id, product_id, lot_key)`. **Suppr.** Projection. **Offline** SRV.

## inventory.stock_transfers

**Responsabilité** : transfert entre emplacements (SM-TRANSFER).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| [STD-DOC] | | | | Type `TRF` ; `site_id` = site source |
| `transfer_kind` | enum(`STANDARD`,`INTERNAL`,`BLIND_RECEIPT`) | Non | `STANDARD` | |
| `from_location_id` | uuid → organization.locations | Non | — | |
| `to_location_id` | uuid → organization.locations | Non | — | |
| `status` | enum(`REQUESTED`,`DECLINED`,`CANCELLED`,`DISPATCHED`,`RECEIVED`,`DISCREPANCY_PENDING`,`CLOSED`,`RETURNED`,`COMPLETED`,`UNMATCHED`,`MATCHED`) | Non | — | |
| `requested_by`, `requested_at` | uuid, ts | Oui | — | |
| `dispatched_by`, `dispatched_at` | uuid, ts | Oui | — | Heure métier d'expédition |
| `carrier_user_id` | uuid → identity.users | Oui | — | Transporteur (CM §22 « par qui ») |
| `carrier_name` | label | Oui | — | Transporteur externe |
| `received_by`, `received_at` | uuid, ts | Oui | — | Heure métier de réception |
| `matched_transfer_id` | uuid → stock_transfers | Oui | — | `BLIND_RECEIPT` rapproché |
| `sales_order_id` | uuid | Oui | — | Réf. sans FK : transfert préparé pour une commande (BR-VEN-010) |
| `approval_request_id` | uuid → approvals.approval_requests | Oui | — | Écart |
| `notes` | text | Oui | — | |
| [STD-ORIGIN] | | | | Pour la commande qui a créé le document |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `doc_number`, `command_id`.
- **CK** `from_location_id <> to_location_id` ; `INTERNAL` ⇒ même site ; horodatages cohérents avec le statut.
- **IX** `(to_location_id, status)` partiel ouverts, `(from_location_id, status)`, `(dispatched_at)`.
- **Suppr.** `ANNULATION` (avant expédition) / transfert retour. **Audit** Chaque transition. **Offline** DL (ouverts du périmètre), CR.
- **Intégrité** INV-STK-08.

## inventory.stock_transfer_lines

**Responsabilité** : lignes de transfert.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `transfer_id` | uuid → stock_transfers | Non | — | |
| `product_id` | uuid → catalog.products | Non | — | |
| `lot_id` | uuid → stock_lots | Oui | — | Choisi par FIFO serveur à l'expédition |
| `unit_code` | code → catalog.units | Non | — | |
| `requested_qty_base` | qty | Oui | — | |
| `dispatched_qty_base` | qty | Oui | — | |
| `received_qty_base` | qty | Oui | — | |
| `discrepancy_qty_base` | qty | Oui | calculé | `dispatched − received` |
| `discrepancy_reason_code_id` | uuid → catalog.reason_codes | Oui | — | |
| `returned_qty_base` | qty | Non | 0 | |

- **PK** `id`. **CK** quantités ≥ 0 ; `received ≤ dispatched` en ligne (TX).
- **Suppr.** Suit le transfert.

## inventory.stock_allocations

**Responsabilité** : quota hors ligne d'un appareil ou réservation d'une commande (ADR-004 ; SM-ALLOCATION).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `allocation_type` | enum(`DEVICE_QUOTA`,`ORDER_RESERVATION`) | Non | — | |
| `location_id` | uuid → organization.locations | Non | — | |
| `product_id` | uuid → catalog.products | Non | — | |
| `lot_id` | uuid → stock_lots | Oui | — | |
| `holder_user_id` | uuid → identity.users | Oui | — | Requis si `DEVICE_QUOTA` |
| `holder_device_id` | uuid → identity.devices | Oui | — | Requis si `DEVICE_QUOTA` |
| `sales_order_line_id` | uuid | Oui | — | Réf. sans FK ; requis si `ORDER_RESERVATION` |
| `quantity_granted` | qty | Non | — | Cumul des octrois (information) |
| `quantity_remaining` | qty | Non | — | Σ entrées signées (dénormalisé) |
| `valid_until` | ts | Oui | — | Fin d'usage local (quota) |
| `status` | enum(`ACTIVE`,`CLOSED`,`REVOKED`) | Non | `ACTIVE` | |
| `close_cause` | enum(`RELEASED`,`CONSUMED`,`CANCELLED`,`TRANSFERRED`,`EXPIRED_RELEASED`) | Oui | — | |
| `revocation_pending` | boolean | Non | false | Appareil bloqué ou perdu |
| `granted_by` | uuid → identity.users | Non | — | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **CK** colonnes du détenteur cohérentes avec le type ; `quantity_remaining ≥ 0` (sauf conflit tracé).
- **UQ** un quota `ACTIVE` par (holder_user_id, holder_device_id, location_id, product_id, lot) ; les augmentations passent par des entrées.
- **IX** `(location_id, product_id, status)`, `(holder_device_id, status)`.
- **Suppr.** `IMMUABLE` sauf transitions. **Audit** Octroi, augmentation, libération, révocation. **Offline** DL (les quotas de l'appareil).

## inventory.stock_allocation_entries

**Responsabilité** : registre des quotas.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `allocation_id` | uuid → stock_allocations | Non | — | |
| `entry_type` | enum(`GRANT`,`INCREASE`,`CONSUME`,`RELEASE`,`REVOKE`,`TRANSFER`,`ADJUST`) | Non | — | |
| `quantity` | qty (signé) | Non | — | Positif pour `GRANT`/`INCREASE`, négatif sinon |
| `stock_move_id` | uuid → stock_moves | Oui | — | Pour `CONSUME` |
| `occurred_at` | ts | Non | — | |
| `command_id` | uuid | Oui | — | |
| `created_at`, `created_by` | | | | |

- **PK** `id`. **Suppr.** `IMMUABLE`. **Intégrité** INV-STK-10, INV-STK-11.

## inventory.loss_declarations

**Responsabilité** : déclaration de perte, y compris la mortalité (SM-LOSS ; tension C-09).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| [STD-DOC] | | | | Type `PRT` |
| `location_id` | uuid → organization.locations | Non | — | |
| `product_id` | uuid → catalog.products | Non | — | Un seul produit (BR-STK-030) |
| `lot_id` | uuid → stock_lots | Oui | — | |
| `production_lot_id` | uuid | Oui | — | Réf. sans FK (mortalité d'un lot) |
| `quantity_base` | qty | Non | — | > 0 |
| `unit_code`, `quantity` | code, qty | Non | — | Saisie |
| `category` | enum(`MORTALITE`,`CASSE`,`DETERIORATION`,`IMPROPRE`,`DESTRUCTION`,`INEXPLIQUEE`,`VOL_SUSPECTE`,`ECART_TRANSFERT`) | Non | — | |
| `reason_code_id` | uuid → catalog.reason_codes | Oui | — | Cause précise |
| `comment` | text | Oui | — | Requis pour `INEXPLIQUEE`, `VOL_SUSPECTE` |
| `declared_by` | uuid → identity.users | Non | — | |
| `policy_id`, `policy_version` | uuid, int | Oui | — | Politique figée |
| `requires_photo`, `requires_approval` | boolean | Non | — | Résultat de la politique (serveur) |
| `status` | enum(`RECORDED`,`PENDING_APPROVAL`,`APPROVED`,`REJECTED_RETURNED`,`REJECTED_UNJUSTIFIED`,`CANCELLATION_PENDING`,`CANCELLED`) | Non | — | |
| `approval_request_id` | uuid → approvals.approval_requests | Oui | — | |
| `unit_cost_xaf`, `value_xaf` | money_xaf | Non | — | Valeur figée |
| `responsibility_user_id` | uuid → identity.users | Oui | — | Imputation en cas de `REJECTED_UNJUSTIFIED` |
| [STD-CANCEL] | | | | |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `doc_number`, `command_id`.
- **CK** `quantity_base > 0` ; `comment` requis selon la catégorie ; `production_lot_id` requis si `MORTALITE`.
- **IX** `(location_id, occurred_at)`, `(production_lot_id, occurred_at)`, `(category, business_date)`, `(status)` partiel en attente.
- **Suppr.** `ANNULATION`. **Audit** Déclaration, décision, annulation. **Offline** DL (30 j du périmètre), CR. **Intégrité** INV-STK-14.

## inventory.consumptions

**Responsabilité** : consommation d'intrant imputée à un objet de coût (BR-STK-036, BR-PRD-007).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `location_id` | uuid → organization.locations | Non | — | Emplacement de l'intrant |
| `product_id` | uuid → catalog.products | Non | — | Intrant consommable |
| `lot_id` | uuid → stock_lots | Oui | — | Lot fournisseur (FEFO) |
| `quantity_base` | qty | Non | — | |
| `unit_code`, `quantity` | | Non | — | |
| `cost_object_type` | enum(`PRODUCTION_LOT`,`INCUBATION_BATCH`,`SITE`) | Non | — | |
| `cost_object_id` | uuid | Non | — | Réf. sans FK |
| `recorded_by` | uuid → identity.users | Non | — | |
| `value_xaf` | money_xaf | Non | — | Figée |
| `status` | enum(`RECORDED`,`CANCELLED`) | Non | `RECORDED` | |
| [STD-CANCEL] | | | | |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `command_id`. **IX** `(cost_object_type, cost_object_id, occurred_at)`.
- **Suppr.** `ANNULATION` (mouvement inverse + écriture de coût inverse). **Offline** DL (30 j), CR.

## inventory.inventory_counts

**Responsabilité** : inventaire d'un emplacement (SM-INVENTORY-COUNT).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| [STD-DOC] | | | | Type `INV` |
| `location_id` | uuid → organization.locations | Non | — | |
| `count_type` | enum(`FULL`,`PARTIAL`,`SPOT`,`OPENING`) | Non | — | |
| `status` | enum(`IN_PROGRESS`,`SUBMITTED`,`PENDING_APPROVAL`,`POSTED`,`REJECTED`,`CANCELLED`) | Non | — | |
| `opened_by`, `submitted_by` | uuid → identity.users | Oui | — | |
| `submitted_at` | ts | Oui | — | |
| `variance_value_xaf` | bigint | Oui | — | Somme signée des écarts valorisés |
| `abs_variance_value_xaf` | money_xaf | Oui | — | Base du seuil |
| `net_variance_after_reconciliation_xaf` | bigint | Oui | — | Après rapprochements tardifs (BR-STK-044) |
| `approval_request_id` | uuid → approvals.approval_requests | Oui | — | |
| `posted_at` | ts | Oui | — | |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** un inventaire `IN_PROGRESS` par `location_id` (index unique partiel) ; un seul `OPENING` `POSTED` par emplacement.
- **Suppr.** `ANNULATION` (`CANCELLED`, `REJECTED`). **Audit** Chaque transition. **Offline** DL (ouverts), CR.

## inventory.inventory_count_lines

**Responsabilité** : lignes d'inventaire.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `count_id` | uuid → inventory_counts | Non | — | |
| `product_id` | uuid → catalog.products | Non | — | |
| `lot_id` | uuid → stock_lots | Oui | — | |
| `counted_at` | ts | Non | — | Instant de référence (BR-STK-040) |
| `counted_qty_base` | qty | Non | — | ≥ 0 |
| `theoretical_qty_base` | qty | Oui | — | Calculé par le serveur à la soumission |
| `variance_qty_base` | qty | Oui | — | Compté − théorique |
| `reconciled_adjustment_qty_base` | qty | Non | 0 | Cumul des rapprochements tardifs |
| `unit_cost_xaf` | money_xaf | Oui | — | |
| `variance_reason_code_id` | uuid → catalog.reason_codes | Oui | — | Requis si écart ≠ 0 à la comptabilisation |
| `declared_unit_cost_xaf` | money_xaf | Oui | — | Pour `OPENING` |
| `comment` | text | Oui | — | |
| `command_id` | uuid | Oui | — | |

- **PK** `id`. **UQ** `(count_id, product_id, lot_id)`. **Suppr.** Suit l'inventaire. **Intégrité** INV-STK-09.

## inventory.stock_thresholds

**Responsabilité** : seuils de réapprovisionnement.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `location_id` | uuid → organization.locations | Non | — | |
| `product_id` | uuid → catalog.products | Non | — | |
| `min_qty_base`, `target_qty_base` | qty | Non | — | `target ≥ min ≥ 0` |
| `is_active` | boolean | Non | true | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `(location_id, product_id)` parmi actifs. **Suppr.** `DESACTIVATION`. **Audit** Modification. **Offline** DL.

## inventory.product_valuations

**Responsabilité** : état courant du CMUP par produit (projection, ADR-015).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `product_id` | uuid → catalog.products | Non | — | PK |
| `avg_unit_cost_xaf` | DECIMAL(14,2) | Non | 0 | CMUP (précision interne ; arrondi au franc à l'usage) |
| `qty_basis` | qty | Non | 0 | Quantité de référence |
| `last_entry_move_id` | uuid → stock_moves | Oui | — | Dernière entrée valorisée |
| `updated_at` | ts | Non | `now()` | |

- **PK** `product_id`. **Suppr.** Projection (reconstructible en rejouant les entrées valorisées dans l'ordre d'application). **Offline** SRV.

## inventory.cost_entries

**Responsabilité** : registre de coûts par objet de coût (règles BR-FIN-040, BR-FIN-041).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `cost_object_type` | enum(`PRODUCTION_LOT`,`INCUBATION_BATCH`,`SITE`) | Non | — | |
| `cost_object_id` | uuid | Non | — | |
| `cost_type` | enum(`ANIMAUX`,`OEUFS`,`ALIMENT`,`VETERINAIRE`,`AUTRE_INTRANT`,`DEPENSE_DIRECTE`,`AJUSTEMENT`) | Non | — | |
| `amount_xaf` | money_xaf | Non | — | > 0 |
| `direction` | enum(`DEBIT`,`CREDIT`) | Non | `DEBIT` | `CREDIT` = correction |
| `source_type` | enum(`STOCK_MOVE`,`EXPENSE`,`MANUAL`) | Non | — | |
| `source_id` | uuid | Non | — | |
| `reverses_entry_id` | uuid → cost_entries | Oui | — | |
| `occurred_at` | ts | Non | — | |
| `created_at`, `created_by` | | | | |
| `comment` | text | Oui | — | Requis si `MANUAL` |

- **PK** `id`. **UQ** `(source_type, source_id, cost_object_id)` (idempotence) ; `reverses_entry_id`.
- **IX** `(cost_object_type, cost_object_id, occurred_at)`.
- **Suppr.** `IMMUABLE`. **Audit** Écritures manuelles. **Offline** SRV. **Intégrité** INV-FIN-08.
