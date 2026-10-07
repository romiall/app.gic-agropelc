# Dictionnaire — schéma `inventory`

> Stratégie : [`../../02-domain-model/03-strategie-stock.md`](../../02-domain-model/03-strategie-stock.md). Invariants : INV-STK-*.

## inventory.stock_lots

**Responsabilité** : dimension de traçabilité (lot de production, lot d'incubation, lot fournisseur, collecte).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `lot_code` | varchar(40) | Non | — | Code lisible (ex. `L-2026-014`, `INC-2026-007`, `F:ABC123`) |
| `product_id` | uuid → catalog.products | Oui | — | Produit principal (nul si le lot couvre plusieurs produits : œufs et poules d'un lot de pondeuses) |
| `origin_type` | enum(`PRODUCTION_LOT`,`INCUBATION_BATCH`,`SUPPLIER_LOT`,`COLLECTION`,`TRANSFORMATION`) | Non | — | `TRANSFORMATION` ajouté en P7-02 : lot propre d'un abattage (AV-100) ; `COLLECTION` : lot propre d'une collecte d'œufs |
| `origin_id` | uuid | Oui | — | Réf. sans FK (lot de production, lot d'incubation, ligne de réception) |
| `supplier_id` | uuid | Oui | — | Réf. sans FK vers `procurement.suppliers` |
| `supplier_lot_ref` | varchar(60) | Oui | — | Lot indiqué par le fournisseur (CM §28) |
| `expiry_date` | date | Oui | — | Péremption (FEFO) |
| `fifo_rank_at` | ts | Non | — | Date de référence FIFO (création ou mise en place) |
| `status` | enum(`OPEN`,`CLOSED`) | Non | `OPEN` | Fermé quand le lot de production est clôturé |
| `sellable_from_rearing` | boolean | Non | false | DÉDUIT (P4-03) : animaux vendables directement depuis un emplacement d'élevage (BR-PRD-010, lot de production `SELLING`) ; tenu par `production` à chaque passage `ACTIVE` ↔ `SELLING`, lu par `sales` (qui ne peut pas importer `production`) ; modifiable comme `status` |
| `created_at`, `created_by` | | | | |

- **PK** `id`. **UQ** `lot_code`. **IX** `(origin_type, origin_id)`, `(expiry_date)`.
- **Implémentation** (P4-03, migration `20261005090000_alter_stock_lots_sellable_from_rearing.sql`) : colonne ajoutée avec rattrapage des lots de production déjà `SELLING` ; le déclencheur d'immuabilité ne la fige pas. API : `setStockLotSellableFromRearing`, `findStockLot(...).sellableFromRearing`.
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
| `move_type` | enum (D06 §7.7) | Non | — | Cause. P4-02 : `DELIVERY` ajouté (livraison du stock vendu, ADR-028 §2, ADR-029 §7), soit 20 valeurs. Pour une vente, `CUSTOMER_RETURN` n'est plus un inverse mais un mouvement **rattaché** au `SALE` d'origine (`origin_move_id`, ADR-029 §1) |
| `reason_code_id` | uuid → catalog.reason_codes | Oui | — | Motif (pertes, ajustements, rendements) |
| `unit_cost_xaf` | money_xaf | Non | — | Coût unitaire figé (INV-STK-15) ; 0 autorisé pour un service ou une production sans coût. Pour un mouvement rattaché : sa valeur ÷ sa quantité, arrondie (ADR-029 §5), donnée à titre d'information |
| `value_xaf` | money_xaf | Non | calculé | `round(quantity × unit_cost_xaf)`, renseignée par le serveur (colonne ordinaire, non générée). Pour un mouvement rattaché : part de la valeur figée du `SALE` d'origine, F(cumul après) − F(cumul avant) (BR-STK-056 ; fonction pure `settlementValueXaf` de `packages/domain` prévue par ADR-029 §5, pas encore écrite) ; la somme des mouvements rattachés d'une origine soldée égale exactement sa valeur |
| `occurred_at` | ts | Non | — | Heure métier du document |
| `business_date` | date | Non | généré | Jour métier (Douala) |
| `recorded_at` | ts | Non | `now()` | Heure d'application |
| `source_doc_type` | enum(`SALE`,`TRANSFER`,`LOSS`,`CONSUMPTION`,`INVENTORY_COUNT`,`GOODS_RECEIPT`,`EGG_COLLECTION`,`INCUBATION_EVENT`,`LOT_ENTRY`,`SLAUGHTER`,`LOT_TRANSFER`,`SALE_CANCELLATION`,`DELIVERY`) | Non | — | `SLAUGHTER` (abattage, AV-032) et `LOT_TRANSFER` (sevrage et transfert entre lots, AV-111) ajoutés en P7-02 ; `SALE_CANCELLATION` (document d'annulation de vente) et `DELIVERY` (bon de livraison) ajoutés en P4-02 (ADR-029 §7), soit 13 valeurs ; `SALE_CANCELLATION` compte 17 caractères, dans la limite de la colonne (`varchar(20)`). DÉDUIT : un `CUSTOMER_RETURN` de vente porte `SALE_CANCELLATION` et un `DELIVERY` porte `DELIVERY` (`source_doc_id` = `sales.sale_cancellations` ou `sales.delivery_notes`) ; la base ne l'impose pas, le code des ventes (P4-03 et suivants) le fait |
| `source_doc_id` | uuid | Non | — | Document |
| `source_line_id` | uuid | Oui | — | Ligne du document |
| `allocation_id` | uuid → stock_allocations | Oui | — | Quota ou réservation consommé |
| `cost_object_type`, `cost_object_id` | enum, uuid | Oui | — | Pour `CONSUMPTION` : objet de coût |
| `is_reversal` | boolean | Non | false | |
| `reverses_move_id` | uuid → stock_moves | Oui | — | INV-STK-04. Jamais le mouvement d'un `SALE` ni d'un `DELIVERY`, qui ne s'inversent pas (BR-STK-055, garde en base) |
| `origin_move_id` | uuid → stock_moves | Oui | — | P4-02 (ADR-029 §1). Mouvement `SALE` dont ce mouvement consomme une part. Requis pour `CUSTOMER_RETURN` et `DELIVERY`, nul pour tout autre type et pour un inverse |
| `origin_seq` | int | Oui | — | P4-02. Rang du mouvement parmi ceux qui consomment la même origine : 1, 2, 3, sans trou ; ≥ 1 ; nul si et seulement si `origin_move_id` est nul |
| `created_by` | uuid → identity.users | Non | — | Auteur du document |
| `created_device_id` | uuid → identity.devices | Oui | — | |
| `command_id` | uuid | Oui | — | |
| `captured_offline` | boolean | Non | false | |

- **PK** `id`.
- **UQ** `reverses_move_id` (un seul inverse, INV-STK-04 ; inchangé) ; `(origin_move_id, origin_seq)` (P4-02, `uq_inventory_stock_moves_origin_seq`) : deux mouvements ne prennent pas le même rang sur une origine. Cette unicité sert aussi d'index à la clé étrangère `origin_move_id` ; les `NULL` multiples sont admis, comme pour `reverses_move_id`.
- **FK** (P4-02) `origin_move_id` → `stock_moves` (`fk_inventory_stock_moves_origin`, `ON DELETE RESTRICT`).
- **CK** `quantity > 0` ; `from_location_id <> to_location_id` ; `is_reversal` ⇔ `reverses_move_id` non nul ; `value_xaf ≥ 0`. P4-02 :
  - `ck_inventory_stock_moves_origin` : `origin_move_id` et `origin_seq` sont tous deux nuls, ou tous deux renseignés avec `origin_seq ≥ 1`, `is_reversal` faux et `move_type` parmi `CUSTOMER_RETURN` et `DELIVERY` : les colonnes d'origine sont réservées à ces deux types et jamais portées par un inverse ;
  - `ck_inventory_stock_moves_settlement` : un `CUSTOMER_RETURN` ou un `DELIVERY` a une origine (`origin_move_id` non nul) ;
  - `ck_inventory_stock_moves_move_type` (20 types) et `ck_inventory_stock_moves_source_doc_type` (13 types) sont remplacées par les listes actualisées d'après le schéma courant.
- **IX** `(from_location_id, product_id, occurred_at)`, `(to_location_id, product_id, occurred_at)`, `(source_doc_type, source_doc_id)`, `(lot_id)`, `(business_date, move_type)`, `(command_id)` ; `(origin_move_id, origin_seq)` (unicité ci-dessus, P4-02).
- **Partitionnement** Mensuel par `recorded_at` au-delà de 20 millions de lignes (stratégie stock §10).
- **Suppr.** `IMMUABLE` (déclencheurs `trg_inventory_stock_moves_no_update` et `trg_inventory_stock_moves_no_delete`, qui lèvent une erreur).
- **Déclencheur de garde** (P4-02, ADR-029 §3, INV-STK-17) : `trg_inventory_stock_moves_settlement_guard`, `BEFORE INSERT`, en plus des deux précédents. Chaque refus lève `SQLSTATE '45000'` avec un message de 128 caractères au plus. Contrôles, dans cet ordre (le 1 vaut pour un inverse, les 2 à 10 seulement quand `origin_move_id` est renseigné) :
  1. si `reverses_move_id` est renseigné, le mouvement visé n'est ni un `SALE` ni un `DELIVERY` (BR-STK-055) ;
  2. l'origine existe, est de type `SALE` et n'est pas un inverse ;
  3. même produit et même lot que l'origine (comparaison qui tient compte du `NULL` : un mouvement sans lot ne se rattache qu'à une origine sans lot) ;
  4. `from_location_id` est égal à l'arrivée (`to_location_id`) de l'origine ;
  5. `CUSTOMER_RETURN` : `to_location_id` est égal au départ (`from_location_id`) de l'origine ;
  6. `DELIVERY` : l'arrivée de l'origine est un emplacement de type `V_TO_DELIVER` et la destination un emplacement de type `V_CUSTOMER` (types décrits dans [`02-organization.md`](02-organization.md), `organization.locations`) ;
  7. `origin_seq` est égal au nombre de mouvements déjà rattachés à l'origine, plus 1 ;
  8. Σ quantités rattachées (le nouveau mouvement compris) ≤ quantité de l'origine ;
  9. Σ valeurs rattachées (le nouveau mouvement compris) ≤ valeur de l'origine ;
  10. si la Σ des quantités atteint exactement la quantité de l'origine, la Σ des valeurs égale exactement la valeur de l'origine : le dernier mouvement solde le franc (BR-STK-056).

  Le déclencheur ne garantit que les **bornes** de la valeur (9 et 10) : la formule du prorata cumulatif relève de `packages/domain` (ADR-021, ADR-029 §5). Il ne contrôle pas non plus que le `V_TO_DELIVER` de destination d'un `SALE` est celui du site de l'emplacement source (contrôle prévu dans le code, `loadLocation`, ADR-029 Conséquences) ni le choix des origines d'une ligne répartie sur plusieurs lots (BR-STK-057, code prévu).
- **Concurrence et droits** (DÉDUIT, ADR-029 §3 et §4). Le `GRANT` du registre est **inchangé** : `SELECT, INSERT` pour le compte applicatif (`20260927090000_create_inventory_core.sql`), sans `UPDATE` ni `DELETE`. Le déclencheur ne pose **aucune lecture verrouillante** (`FOR UPDATE`, `FOR SHARE`) sur `inventory_stock_moves`, et le code à venir n'en posera pas : MySQL exige le privilège `UPDATE` en plus de `SELECT` pour une lecture verrouillante (précédent : `20260924110000_grant_audit_log_lock.sql`), et ADR-029 §4 refuse de l'accorder pour que le registre reste en ajout seul **aussi au niveau des privilèges** (INV-STK-04, INV-GLO-03), le déclencheur d'immuabilité n'étant pas la seule barrière. La garde reste sûre sans verrou : sous isolation répétable, un mouvement concurrent qui lit un compteur périmé calcule un `origin_seq` déjà pris, et l'unicité `(origin_move_id, origin_seq)` fait échouer son insertion ; un dépassement n'est donc jamais accepté, seule la vivacité baisse. Côté application, un doublon de séquence ou un interblocage est **réessayable** ; un `SIGNAL` du déclencheur est un rejet définitif (ADR-029 §4). La sérialisation courante est confiée au module `sales` (ADR-029 §4 ; module pas encore écrit, P4-03 et suivants) : il verrouillera d'abord la ligne de vente qu'il possède (`sales_sale_lines`) avant d'appeler `inventory` ; le déclencheur et l'unicité ne sont que le filet.
- **Implémentation** (P4-02 2/2) : table physique `inventory_stock_moves` ; migrations `20261003090100_alter_inventory_stock_moves_for_sales.sql` (colonnes, unicité, clé étrangère, contraintes d'appariement, listes de types) `20261003090200_create_inventory_settlement_guard.sql` (déclencheur) et `20261003090800_harden_inventory_settlement.sql` (un retour ne s'inverse pas, « à livrer » du site de la source, `DELIVERY` ⇔ document `DELIVERY`, `SALE_CANCELLATION` ⇒ `CUSTOMER_RETURN`). Le retour arrière de `090100` restaure d'abord les listes de types en un seul `ALTER` : il échoue sans effet de bord s'il existe un mouvement `DELIVERY` ou un document source `SALE_CANCELLATION` ou `DELIVERY` ; ne pas le défaire sur une base qui contient des retours ou des livraisons rattachés (le registre est en ajout seul). Preuve : `db/tests/inventory-settlement.test.ts` (insertions directes qui contournent l'application, une par refus).
- **Audit** L'audit porte sur le **document** source ; le mouvement est lui-même un registre.
- **Offline** SRV : les appareils ne reçoivent que des soldes. Les mouvements sont créés **uniquement** par le serveur.
- **Intégrité** INV-STK-01 à INV-STK-04, INV-STK-12, INV-STK-15, INV-STK-16 (le net d'une vente se lit par mouvements rattachés, via la lecture `soldGoodsPosition` prévue par ADR-029 §7, et non plus par « `SALE` moins inverses »), INV-STK-17 (garde en base ci-dessus), INV-STK-18 (solde de `V_TO_DELIVER` ≥ 0 par site, produit et lot : balayage et réconciliation prévus dans `ledger-reconciliation.ts`, corollaire d'INV-STK-17 ; aucun test de négatif en ligne ne vise un emplacement virtuel). Pas de recalcul du CMUP pour un mouvement rattaché : ni un retour ni une livraison n'est une entrée valorisée (ADR-029 §5).

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
| `incubation_batch_id` | uuid | Oui | — | Réf. sans FK : mortalité de poussins d'un lot d'incubation avant mise en place (AV-113, P7-02) |
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
- **CK** `quantity_base > 0` ; `comment` requis selon la catégorie ; `production_lot_id` ou `incubation_batch_id` requis si `MORTALITE` (P7-02, AV-113). Animaux morts hors d'un lot suivi (marchandise vivante achetée, stock mobile sans lot) : perte simple `DETERIORATION` par défaut (AV-152).
- **Validation** (P7-02) : une perte `MORTALITE` suit la politique `MORTALITY` (AV-048, AV-119) ; son approbation exige une photo `AVAILABLE` rattachée à la déclaration (`attachments`, `owner_type = STOCK_LOSS`) quand la politique la demande (AV-107).
- **IX** `(location_id, occurred_at)`, `(production_lot_id, occurred_at)`, `(category, business_date)`, `(status)` partiel en attente.
- **Suppr.** `ANNULATION`. **Audit** Déclaration, décision, annulation. **Offline** DL (30 j du périmètre), CR ; la perte d'un lot de production (`production_lot_id` renseigné) est servie dans le jeu `production` (`LOT_LOSS`, sans valeur), renvoyée à chaque décision ou retrait (P7-12). **Intégrité** INV-STK-14.

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
| `cost_type` | enum (comme `cost_entries`, hors `FRAIS_GENERAUX` et `PRODUCTION_TRANSFEREE`) | Oui | — | DÉDUIT (P7-02) : nature conservée même quand la consommation vaut 0 XAF (aucune écriture de coût) ; nulle pour les consommations antérieures |
| `recorded_by` | uuid → identity.users | Non | — | |
| `value_xaf` | money_xaf | Non | — | Figée |
| `status` | enum(`RECORDED`,`CANCELLED`) | Non | `RECORDED` | |
| [STD-CANCEL] | | | | |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `command_id`. **IX** `(cost_object_type, cost_object_id, occurred_at)`.
- **Suppr.** `ANNULATION` (mouvement inverse + écriture de coût inverse). **Offline** DL (30 j), CR ; la consommation d'un lot de production (`cost_object_type = PRODUCTION_LOT`) est servie dans le jeu `production` (`LOT_CONSUMPTION`, sans valeur, P7-12).

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
| `cost_type` | enum(`ANIMAUX`,`OEUFS`,`ALIMENT`,`VETERINAIRE`,`AUTRE_INTRANT`,`DEPENSE_DIRECTE`,`AJUSTEMENT`,`FRAIS_GENERAUX`,`PRODUCTION_TRANSFEREE`) | Non | — | P7-02 : `FRAIS_GENERAUX` (ADR-026), `PRODUCTION_TRANSFEREE` (crédit du lot producteur au coût standard, AV-098, ADR-027) |
| `species_group` | enum(`VOLAILLE`,`PORC`) | Oui | — | P7-02 : espèce des frais généraux, obligatoire pour `FRAIS_GENERAUX` (AV-104 : jamais mélangées) |
| `amount_xaf` | money_xaf | Non | — | > 0 (une écriture de 0 XAF n'est pas créée) |
| `direction` | enum(`DEBIT`,`CREDIT`) | Non | `DEBIT` | `CREDIT` = correction, production transférée (AV-098) ou frais généraux répartis (ADR-026) |
| `source_type` | enum(`STOCK_MOVE`,`EXPENSE`,`MANUAL`,`OVERHEAD_ENTRY`,`ALLOCATION`,`PRODUCTION`) | Non | — | P7-02 : saisie de frais généraux, répartition, production transférée |
| `source_id` | uuid | Non | — | |
| `reverses_entry_id` | uuid → cost_entries | Oui | — | |
| `occurred_at` | ts | Non | — | |
| `created_at`, `created_by` | | | | |
| `comment` | text | Oui | — | Requis si `MANUAL` |

- **PK** `id`. **UQ** `(source_type, source_id, cost_object_id)` (idempotence) ; `reverses_entry_id`.
- **IX** `(cost_object_type, cost_object_id, occurred_at)`.
- **CK** `species_group` renseigné si `FRAIS_GENERAUX`.
- **Suppr.** `IMMUABLE`. **Audit** Écritures manuelles. **Offline** SRV. **Intégrité** INV-FIN-08.

## inventory.overhead_entries

**Responsabilité** : saisie des frais généraux d'une ferme (P7-02 ; ADR-026 amendé, AV-103, AV-104) — une en-tête, une ligne par espèce.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `site_id` | uuid → organization.sites | Non | — | Ferme (`site_type = FERME`) |
| `label` | label | Non | — | Nature du frais (gardiennage, électricité…) |
| `total_xaf` | money_xaf | Non | — | Σ des lignes, > 0 |
| `status` | enum(`RECORDED`,`CANCELLED`) | Non | `RECORDED` | |
| `business_date` | date | Non | généré | Jour métier (Douala) de `occurred_at` : mois de la répartition |
| [STD-CANCEL] | | | | |
| [STD-ORIGIN] | | | | |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `command_id`. **IX** `(site_id, business_date)`.
- **Suppr.** `ANNULATION` (écritures inverses) ; refusée si le mois de l'espèce est déjà réparti (`OVERHEAD_ALREADY_ALLOCATED`). **Offline** SRV (en ligne).

## inventory.overhead_entry_lines

**Responsabilité** : ventilation d'une saisie de frais généraux par espèce (AV-104).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `entry_id` | uuid → overhead_entries | Non | — | |
| `species_group` | enum(`VOLAILLE`,`PORC`) | Non | — | |
| `amount_xaf` | money_xaf | Non | — | > 0 |
| `cost_entry_id` | uuid → cost_entries | Non | — | Écriture `SITE` `FRAIS_GENERAUX` (source `OVERHEAD_ENTRY`) |

- **PK** `id`. **UQ** `(entry_id, species_group)`, `cost_entry_id`. **Suppr.** `IMMUABLE`.
