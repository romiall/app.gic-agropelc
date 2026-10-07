# Dictionnaire — schéma `sales`

> Réécrit d'après les migrations `20261003090400` à `20261003091000` (P4-02 2/2, dont le durcissement `090800` à `091000` après relecture adverse), [ADR-028](../../decisions/ADR-028-commande-vente-livraison-p4.md) et [ADR-029](../../decisions/ADR-029-contre-ecriture-partielle-du-stock.md) ; **les migrations font foi pour le schéma réel**. Règles fonctionnelles : [D04](../../01-functional/domaines/D04-VEN-commandes-ventes.md) (commandes, ventes, livraisons) et D09 §7.1 (encaissements). Décisions du porteur du projet du 30/09/2026 : [A-VALIDER](../../A-VALIDER.md) §3.

**Lecture.**

- **Noms** : le nom logique `sales.<table>` du modèle relationnel correspond au nom physique `sales_<table>` (une seule base MySQL, ADR-023). Les sections portent le nom physique (écart au modèle relationnel, qui titre en nom logique : `sales.sales` donnerait ici `sales_sales`).
- **Blocs standard** `[STD-*]` : [conventions](../01-identifiants-et-conventions.md) §3. Dans ce schéma, la colonne `received_at` de `[STD-ORIGIN]` s'appelle `received_at_server` (convention des migrations).
- **Clés étrangères** : `ON DELETE RESTRICT` partout. Une colonne `uuid` sans « → » n'a pas de clé étrangère. Le compte applicatif `gic_app` n'a jamais `DELETE`, et chaque table refuse la suppression physique par un déclencheur `BEFORE DELETE` (INV-GLO-03).
- **`business_date`** : colonne générée stockée `CAST(CONVERT_TZ(occurred_at, '+00:00', '+01:00') AS DATE)` (jour de Douala, UTC+1 sans heure d'été ; ADR-016). Collation `utf8mb4_0900_as_cs`.
- **Propriété** : le module `sales` est seul propriétaire de ces dix tables (INV-GLO-05). Les mouvements de stock sont créés par `inventory` à sa demande.
- **`command_id`** : unique sur les commandes, les ventes et les bons de livraison ; **unique par vente sur les annulations** (`UNIQUE (command_id, sale_id)`) ; **non unique sur les encaissements** (voir ces sections). Le filet d'idempotence reste `sync.command_inbox` (une commande n'est appliquée qu'une fois).

**Écarts DÉDUITS par rapport à l'ancien dictionnaire (écrit sur ADR-014).** Choix techniques d'ADR-028 et d'ADR-029 ; les décisions métier sous-jacentes (30/09/2026) sont CONFIRMÉES. La plupart des écarts sont aussi décrits dans l'en-tête de leur migration.

| Point | Ancien dictionnaire | Schéma actuel (source) |
|---|---|---|
| Réservation d'une commande | `reservation_status` | Supprimé : aucune réservation `ORDER_RESERVATION` ; la part vendue passe en « à livrer », la part en attente n'a pas de stock (ADR-028 §4) |
| Lignes de commande | `delivered_quantity_base ≤ quantity_base`, `status` de ligne, `quantity > 0` | Compteurs `quantity_base` (commandé en vigueur), `sold_quantity_base`, `delivered_quantity_base`, `withdrawn_quantity_base` ; `0 ≤ livré ≤ vendu ≤ commandé` ; plus de statut de ligne (en attente et à livrer se dérivent) ; commandé pouvant être nul (ADR-028 §4 à 6, AV-130) |
| Clôture du reliquat | `closed_reason` seul | `closed_at` et `closed_by` ajoutés (AV-128) |
| Type de vente | `ORDER_FULFILMENT` (vente créée à la livraison) | `ORDER` (vente à la confirmation, ADR-025) ; `to_deliver_location_id` ajouté ; `delivered_by_user_id` et `recipient_name` déplacés vers le bon de livraison |
| Annulation d'une vente | `[STD-CANCEL]` sur la vente | Documents d'annulation (`sales_sale_cancellations` et leurs lignes) ; la vente porte `cancelled_xaf` ; les lignes portent des compteurs `cancelled_*` (ADR-028 §5, ADR-029) |
| Montants dérivés | `balance_due_xaf` et `payment_status` ordinaires | Colonnes générées `net_total_xaf`, `balance_due_xaf`, `payment_status` (BR-VEN-026) |
| Coût d'une ligne de vente | `unit_cost_xaf` seul | `cost_xaf` ajouté : somme des valeurs figées des mouvements `SALE` (ADR-027) |
| Livraison | aucune table | `sales_delivery_notes` et `sales_delivery_note_lines` (AV-034, ADR-028 §7) |
| Encaissements | `UNIQUE (command_id)` ; unicité de la référence parmi `RECORDED` | `command_id` non unique ; `reference_normalized`, `reference_key` (unicité parmi `RECORDED` et `CANCELLATION_REQUESTED`) ; `duplicate_of_payment_id` (AV-056) |
| Affectations | `reversal_cause` `ORDER_FULFILLED` | `ORDER_CONFIRMED` : un acompte passe à la vente à sa confirmation (ADR-028 §8) |
| Unicités et index partiels | index partiels | Colonnes générées ou index complets (MySQL, conventions §4) |
| Créances | vue `sales.v_receivables` | Aucune vue SQL ; calcul en requête (P4-09), voir la dernière section |
| Durcissement (relecture adverse, migrations `090800` à `091000`) | — | Vente anonyme : plus de `CHECK` sur le reste dû (fait accompli hors ligne, AV-137) ; dérogation de ligne de commande motivée ; référence corrigeable à la décision sur un doublon suspect et cible visée mémorisée (AV-135) ; mouvement de trésorerie unique par encaissement ; gardes figées après décision ; gardes d'insertion de cohérence ; brouillon annulable |

## sales_sales_orders

**Responsabilité** : commande client (SM-ORDER ; D04 §7.1 ; ADR-028). Engagement du client : elle donne lieu à une vente par confirmation (AV-127), porte le reste en attente et reçoit les livraisons.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| [STD-DOC] | | | | Type `CMD` |
| `customer_id` | uuid → crm.customers | Non | — | Client identifié (BR-VEN-001) ; jamais réécrit (une fusion de clients n'est pas une réécriture) |
| `commercial_user_id` | uuid → identity.users | Non | — | Commercial ayant obtenu la commande (BR-VEN-020) ; figé |
| `channel_code` | code → catalog.sales_channels | Non | — | `varchar(20)` ; figé |
| `fulfilment_location_id` | uuid → organization.locations | Non | — | Emplacement de préparation : source des ventes de la commande (ADR-028 §4) ; modifiable |
| `requested_delivery_date` | date | Oui | — | |
| `delivery_address` | text | Oui | — | |
| `status` | enum(`DRAFT`,`CONFIRMED`,`PARTIALLY_FULFILLED`,`FULFILLED`,`CLOSED`,`CANCELLED`) | Non | `CONFIRMED` | Dérivé des lignes (`salesOrderStatusFromLines`), sauf `DRAFT` ; `FULFILLED`, `CLOSED` et `CANCELLED` sont terminaux. Défaut `CONFIRMED` : DÉDUIT de BR-VEN-002 (`place` confirme) |
| `total_estimated_xaf` | money_xaf | Non | 0 | Σ lignes au prix convenu (quantités commandées en vigueur) |
| `advance_paid_xaf` | money_xaf | Non | 0 | Σ affectations actives portant sur la commande (acomptes, ADR-028 §8) ; dénormalisé |
| `external_origin` | enum(`NONE`,`KOMMO`) | Non | `NONE` | Figé |
| `confirmed_at` | ts | Oui | — | Requis dès que le statut n'est plus `DRAFT` |
| `closed_at` | ts | Oui | — | Clôture du reliquat d'une commande partiellement livrée (AV-128) |
| `closed_by` | uuid → identity.users | Oui | — | Idem |
| `closed_reason` | text | Oui | — | Motif de clôture |
| `released_payment_treatment` | enum(`CUSTOMER_CREDIT`,`REFUND`) | Oui | — | DÉDUIT : sort de l'acompte libéré par une commande annulée ou clôturée sans vente (BR-VEN-009, AV-033) ; s'écrit une seule fois |
| [STD-CANCEL] | | | | Annulation avant toute livraison |
| [STD-ORIGIN] | | | | `occurred_at` : heure de la commande |
| [STD-AUDIT] | | | | `version` : concurrence optimiste (BR-VEN-005) |

- **PK** `id`. **UQ** `doc_number` ; `command_id` ; `(created_device_id, local_ref)`.
- **CK** `status` dans la liste ; `external_origin` dans `NONE`, `KOMMO` ; `total_estimated_xaf ≥ 0` et `advance_paid_xaf ≥ 0` ; `confirmed_at` non nul hors `DRAFT` et `CANCELLED` (un brouillon jamais confirmé peut être annulé) ; `released_payment_treatment` nul ou dans `CUSTOMER_CREDIT`, `REFUND` ; `closed_at` et `closed_by` renseignés si et seulement si `CLOSED` ; colonnes d'annulation renseignées si et seulement si `CANCELLED`.
- **IX** `(customer_id, occurred_at)`, `(commercial_user_id, occurred_at)`, `(fulfilment_location_id, status)`, `(status, site_id)` (remplace l'index partiel sur les commandes ouvertes).
- **Garde** `trg_sales_sales_orders_update_guard` : figés le numéro, la référence locale, le site, le client, le commercial, le canal, l'origine externe et toute l'origine (`[STD-ORIGIN]`, création) ; évoluent le lieu de préparation, la date et l'adresse de livraison, les totaux, le statut, la clôture et l'annulation ; une commande `FULFILLED`, `CLOSED` ou `CANCELLED` ne change plus de statut et sa clôture et son annulation sont figées ; une commande confirmée ne redevient pas brouillon ; le sort du paiement libéré s'écrit une seule fois. `trg_sales_sales_orders_no_delete`.
- **Relations** 1 commande → N lignes, N ventes de type `ORDER`, N bons de livraison, N affectations d'acompte.
- **Suppr.** `ANNULATION` (`CANCELLED`) ou clôture du reliquat (`CLOSED`) ; les ventes concernées s'annulent par document d'annulation. **Droits** `SELECT`, `INSERT`, `UPDATE`. **Audit** Toute commande. **Offline** DL (ouvertes du périmètre, jeu `orders`, P4-11), CR.

## sales_sales_order_lines

**Responsabilité** : lignes de commande et leurs compteurs de quantité (`SalesOrderLineQuantities`, `packages/domain/src/sales.ts`).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `order_id` | uuid → sales_sales_orders | Non | — | |
| `line_no` | smallint | Non | — | |
| `product_id` | uuid → catalog.products | Non | — | Figé |
| `product_name_snapshot` | label | Non | — | Libellé figé |
| `quantity` | qty | Non | — | Unité de saisie ; ≥ 0 |
| `unit_code` | code → catalog.units | Non | — | `varchar(20)` ; figé |
| `quantity_base` | qty | Non | — | **Commandé en vigueur**, unité de base, après ajustements (AV-130) ; ≥ 0 (nul pour une ligne entièrement retirée) |
| `withdrawn_quantity_base` | qty | Non | 0 | DÉDUIT : cumul des quantités retirées, pour la traçabilité ; ne diminue jamais |
| `sold_quantity_base` | qty | Non | 0 | **Vendu net** des annulations (ADR-028 §4 et §5) |
| `delivered_quantity_base` | qty | Non | 0 | **Livré** (bons de livraison, ADR-028 §7) ; ne diminue jamais |
| `quoted_unit_price_xaf` | money_xaf | Non | — | Prix convenu (BR-VEN-003) ; figé, y compris pour les lignes déjà vendues (ADR-028 §6) |
| `list_unit_price_xaf` | money_xaf | Oui | — | Prix catalogue résolu à la commande (mesure d'une dérogation) ; figé |
| `price_rule_id` | uuid → pricing.price_rules | Oui | — | Nul si dérogation sans règle |
| `price_rule_version` | int | Oui | — | |
| `price_source` | enum(`RULE`,`MANUAL_OVERRIDE`) | Non | `RULE` | Figé |
| `override_reason_code_id` | uuid → catalog.reason_codes | Oui | — | Requis si `MANUAL_OVERRIDE` (BR-VEN-015, AV-026) ; recopié sur la ligne de vente à chaque confirmation |
| `override_approval_request_id` | uuid → approvals.approval_requests | Oui | — | Validation `PRICE_OVERRIDE` au-delà du plafond |
| `line_total_xaf` | money_xaf | Non | — | Montant estimé de la ligne ; évolue avec la quantité commandée |
| `created_at` | ts | Non | `now()` | |
| `updated_at` | ts | Non | `now()` | Mis à jour à chaque modification |

Dérivés, non stockés : **en attente** = `quantity_base − sold_quantity_base` ; **à livrer** = `sold_quantity_base − delivered_quantity_base` (`salesOrderLineProgress`).

- **PK** `id`. **UQ** `(order_id, line_no)`. **IX** `(product_id)`.
- **CK** `price_source` dans `RULE`, `MANUAL_OVERRIDE` ; `MANUAL_OVERRIDE` ⇒ `override_reason_code_id` non nul ; `quoted_unit_price_xaf ≥ 0`, `list_unit_price_xaf ≥ 0` s'il est renseigné et `line_total_xaf ≥ 0` ; `quantity ≥ 0`, `quantity_base ≥ 0`, `withdrawn_quantity_base ≥ 0` ; `0 ≤ delivered_quantity_base ≤ sold_quantity_base ≤ quantity_base` (INV-VEN-04 étendu par ADR-028).
- **Garde** `trg_sales_sales_order_lines_update_guard` : figés la commande, le numéro de ligne, le produit, le libellé, l'unité, le prix convenu, le prix catalogue, la règle, sa version, la source du prix, le motif et la validation de dérogation ; seules les quantités et le montant estimé évoluent ; `delivered_quantity_base` et `withdrawn_quantity_base` ne diminuent jamais. `trg_sales_sales_order_lines_no_delete`.
- **Limite connue (AV-136)** : un produit vendu au poids (`PER_WEIGHT`) n'est pas exprimable sur une ligne de commande (ni quantité ni unité de tarification) ; défaut : seuls les produits à l'unité se commandent en P4.
- **Suppr.** Suit la commande (une ligne retirée garde sa ligne, commandé nul). **Droits** `SELECT`, `INSERT`, `UPDATE`. **Offline** DL, CR.

## sales_sales

**Responsabilité** : vente, directe ou issue d'une commande (SM-SALE ; D04 §7.2 ; ADR-025, ADR-028). Une vente par confirmation d'une commande (AV-127) : `DIRECT` déplace le stock de l'emplacement source vers `V_CUSTOMER` ; `ORDER` le déplace de l'emplacement de préparation vers l'emplacement « à livrer » du site (ADR-028 §2).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| [STD-DOC] | | | | Type `VTE` |
| `sale_type` | enum(`DIRECT`,`ORDER`) | Non | — | |
| `order_id` | uuid → sales_sales_orders | Oui | — | Requis si `ORDER`, nul si `DIRECT` |
| `customer_id` | uuid → crm.customers | Oui | — | Nul = vente anonyme (AV-027) ; intégralement payée à l'enregistrement en ligne (INV-VEN-07, tenu en TX, pas par un `CHECK` : un fait accompli hors ligne n'est pas rejeté, AV-137) ; requis pour une vente `ORDER` |
| `customer_category_id_snapshot` | uuid | Oui | — | Catégorie du client au moment de la vente (sans clé étrangère) |
| `channel_code` | code → catalog.sales_channels | Non | — | `varchar(20)` ; figé (BR-VEN-021) |
| `from_location_id` | uuid → organization.locations | Non | — | Emplacement source (BR-VEN-017) ; pour `ORDER`, l'emplacement de préparation |
| `to_deliver_location_id` | uuid → organization.locations | Oui | — | Emplacement `V_TO_DELIVER` du site ; requis si `ORDER`, nul si `DIRECT` |
| `zone_id` | uuid → organization.zones | Non | — | Zone figée (BR-VEN-022) |
| `seller_user_id` | uuid → identity.users | Non | — | Vendeur exécutant |
| `commercial_user_id` | uuid → identity.users | Oui | — | Commercial attribué (BR-VEN-020) |
| `work_session_id` | uuid → fieldwork.work_sessions | Oui | — | Vente terrain |
| `cash_session_id` | uuid (réf. `finance.cash_sessions`, sans clé étrangère jusqu'à P5) | Oui | — | Caisse ; seule colonne de rattachement qui évolue (rattachement tardif) |
| `lat`, `lng` | lat, lng | Oui | — | `DECIMAL(9,6)` ; position d'une vente terrain |
| `accuracy_m` | meters | Oui | — | `DECIMAL(8,1)` |
| `status` | enum(`CONFIRMED`,`CANCELLATION_REQUESTED`,`CANCELLED`) | Non | `CONFIRMED` | Valeurs de SM-SALE ; `CANCELLED` quand toutes les lignes sont annulées (ADR-028 §5) |
| `subtotal_xaf` | money_xaf | Non | — | Σ (quantité de tarification × prix appliqué), avant remise |
| `discount_total_xaf` | money_xaf | Non | 0 | |
| `tax_total_xaf` | money_xaf | Non | 0 | Taxes à 0, prix TTC (AV-041, BR-VEN-032) |
| `total_xaf` | money_xaf | Non | — | Total dû = `subtotal_xaf − discount_total_xaf + tax_total_xaf` (BR-VEN-014) |
| `cancelled_xaf` | money_xaf | Non | 0 | Montant annulé cumulé (documents d'annulation appliqués) ; ne diminue jamais |
| `amount_paid_xaf` | money_xaf | Non | 0 | Σ affectations actives (dénormalisé) |
| `net_total_xaf` | money_xaf | Non | généré | `total_xaf − cancelled_xaf` (colonne générée stockée) |
| `balance_due_xaf` | money_xaf | Non | généré | `total_xaf − cancelled_xaf − amount_paid_xaf` (colonne générée stockée) |
| `payment_status` | enum(`UNPAID`,`PARTIALLY_PAID`,`PAID`) | Non | généré | Dérivé, jamais saisi (BR-VEN-026) : `PAID` si le solde dû est nul (donc aussi pour un net nul, y compris une vente entièrement annulée), sinon `UNPAID` si rien n'est payé, sinon `PARTIALLY_PAID` (colonne générée stockée, `varchar(15)`) |
| `due_date` | date | Oui | — | DÉDUIT : échéance de toute vente à un client identifié, même soldée (jour métier de la vente + délai de paiement du client, AV-028, AV-129), pour qu'une créance rouverte (annulation d'un encaissement) ait une échéance ; figée |
| `flags` | json | Non | `[]` | Tableau de codes d'anomalie (conventions §2 : `text[]` stocké en JSON) ; codes écrits par `sales.sale.record` (P4-04) : `PRICE_MISMATCH`, `STOCK_NEGATIVE` (le dictionnaire d'origine disait `STOCK_CONFLICT` : aligné sur le conflit et l'avertissement), `CREDIT_OVER_LIMIT`, `PRODUCT_INACTIVE`, `ANONYMOUS_UNPAID`, `LOT_NOT_SELLABLE`, `PAYMENT_SUSPECT_DUPLICATE`, `OUT_OF_SESSION`, `SESSION_REJECTED` ; `ORDER_OVER_FULFILMENT` suivra avec les livraisons (P4-07) ; ajout possible après la création (`JSON_ARRAY_APPEND`) ; contenu non contraint par la base |
| [STD-ORIGIN] | | | | |
| `business_date` | date | Non | généré | Jour métier de `occurred_at` (voir Lecture) |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `doc_number` ; `command_id` ; `(created_device_id, local_ref)`.
- **CK** `sale_type` dans `DIRECT`, `ORDER` ; `ORDER` ⇒ `order_id` et `to_deliver_location_id` non nuls, `DIRECT` ⇒ les deux nuls ; `status` dans la liste ; `subtotal_xaf`, `discount_total_xaf`, `tax_total_xaf`, `total_xaf` ≥ 0 ; `total_xaf = subtotal_xaf − discount_total_xaf + tax_total_xaf` ; `0 ≤ cancelled_xaf ≤ total_xaf` ; `0 ≤ amount_paid_xaf ≤ total_xaf − cancelled_xaf` (INV-VEN-06) ; `status = CANCELLED` ⇒ `cancelled_xaf = total_xaf` ; `ORDER` ⇒ `customer_id` non nul (BR-VEN-001). Aucun `CHECK` sur le solde d'une vente anonyme (fait accompli hors ligne, AV-137).
- **IX** `(occurred_at)`, `(business_date, from_location_id)`, `(site_id, business_date)`, `(customer_id, occurred_at)`, `(commercial_user_id, business_date)`, `(seller_user_id, business_date)`, `(order_id)`, `(payment_status, due_date)`, `(cash_session_id)`.
- **Garde** `trg_sales_sales_update_guard` (INV-VEN-02, INV-VEN-10) : tout est figé (numéro, site, type, commande, client et sa catégorie, canal, emplacements, zone, vendeur, commercial, session de travail, position, montants de la vente, échéance, `[STD-ORIGIN]`, création) sauf `status`, `cancelled_xaf`, `amount_paid_xaf`, `flags`, `cash_session_id` et les colonnes d'audit ; `cancelled_xaf` ne diminue jamais ; une vente `CANCELLED` ne revient pas en arrière. `trg_sales_sales_insert_guard` : l'emplacement « à livrer » est de type `V_TO_DELIVER` et du site de l'emplacement de préparation (ADR-028 §1). `trg_sales_sales_no_delete`.
- **Relations** 1 vente → N lignes, N annulations, N affectations de paiement. Les mouvements `SALE` référencent la ligne par `inventory.stock_moves.source_line_id`.
- **Suppr.** `ANNULATION` par document d'annulation (contre-écriture, ADR-006) ; la vente elle-même ne change pas. **Hist.** Immuable (INV-VEN-02). **Droits** `SELECT`, `INSERT`, `UPDATE`. **Audit** Enregistrement, demande d'annulation, annulation. **Offline** DL (7 jours de l'utilisateur ou du PDV, jeu `sales_recent`, P4-11), CR.

## sales_sale_lines

**Responsabilité** : lignes de vente, faits figés (BR-VEN-013) ; seuls évoluent les compteurs d'annulation et de livraison et le coût, renseigné une fois par le serveur.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `sale_id` | uuid → sales_sales | Non | — | |
| `line_no` | smallint | Non | — | |
| `order_line_id` | uuid → sales_sales_order_lines | Oui | — | Ligne de commande d'origine (vente `ORDER`) |
| `product_id` | uuid → catalog.products | Non | — | |
| `product_name_snapshot` | label | Non | — | Libellé figé |
| `quantity` | qty | Non | — | Unité de saisie ; > 0 |
| `unit_code` | code → catalog.units | Non | — | `varchar(20)` |
| `quantity_base` | qty | Non | — | Unité de base ; > 0 |
| `pricing_quantity` | qty | Non | — | Quantité de tarification : la quantité en unité de base, ou le poids pesé en kg si `PER_WEIGHT` (AV-031) ; > 0 |
| `pricing_unit_code` | code → catalog.units | Non | — | `varchar(20)` |
| `list_unit_price_xaf` | money_xaf | Oui | — | Prix catalogue résolu |
| `unit_price_xaf` | money_xaf | Non | — | Prix appliqué |
| `price_rule_id` | uuid → pricing.price_rules | Oui | — | |
| `price_rule_version` | int | Oui | — | |
| `price_specificity` | smallint | Oui | — | Explication du choix de la règle |
| `price_source` | enum(`RULE`,`ORDER_QUOTE`,`MANUAL_OVERRIDE`) | Non | — | |
| `override_reason_code_id` | uuid → catalog.reason_codes | Oui | — | Requis si `MANUAL_OVERRIDE` |
| `override_approval_request_id` | uuid → approvals.approval_requests | Oui | — | Au-delà du plafond (AV-026) |
| `discount_xaf` | money_xaf | Non | 0 | |
| `tax_rate` | rate | Non | 0 | AV-041 ; entre 0 et 1 |
| `line_total_xaf` | money_xaf | Non | — | BR-VEN-014, INV-VEN-03 |
| `cancelled_quantity_base` | qty | Non | 0 | Quantité annulée cumulée ; ne diminue jamais |
| `cancelled_xaf` | money_xaf | Non | 0 | Montant annulé cumulé ; ne diminue jamais |
| `delivered_quantity_base` | qty | Non | 0 | Quantité livrée ; ne diminue jamais ; une vente directe n'utilise pas ce compteur |
| `unit_cost_xaf` | money_xaf | Oui | — | Coût unitaire figé, renseigné par le serveur ; ne change plus une fois renseigné |
| `cost_xaf` | money_xaf | Oui | — | DÉDUIT (ADR-027) : somme des valeurs figées des mouvements `SALE` de la ligne ; ce n'est pas quantité × coût unitaire arrondi (dernière sortie d'un lot biologique) ; ne change plus une fois renseigné |
| `allocation_id` | uuid → inventory.stock_allocations | Oui | — | Quota consommé |
| `client_lot_hint` | uuid | Oui | — | Lot proposé par l'appareil, information (sans clé étrangère) |
| `created_at` | ts | Non | `now()` | |

- **PK** `id`. **UQ** `(sale_id, line_no)`. **IX** `(product_id)`, `(order_line_id)`, `(price_rule_id)`.
- **CK** `quantity > 0`, `quantity_base > 0`, `pricing_quantity > 0` ; `price_source` dans la liste ; `MANUAL_OVERRIDE` ⇒ `override_reason_code_id` non nul ; `RULE` ⇒ règle, version et prix catalogue non nuls ; `ORDER_QUOTE` ⇒ `order_line_id` non nul ; `unit_price_xaf ≥ 0`, `discount_xaf ≥ 0`, `0 ≤ tax_rate ≤ 1`, prix catalogue ≥ 0 s'il est renseigné ; `line_total_xaf ≥ 0` et `line_total_xaf = ROUND(pricing_quantity × unit_price_xaf, 0) − discount_xaf` (INV-VEN-03, demi supérieur) ; `0 ≤ cancelled_quantity_base ≤ quantity_base`, `0 ≤ cancelled_xaf ≤ line_total_xaf`, et quand toute la quantité est annulée `cancelled_xaf = line_total_xaf` (la dernière annulation emporte le montant exact, ADR-028 §5) ; un montant annulé exige une quantité annulée ; `0 ≤ delivered_quantity_base ≤ quantity_base − cancelled_quantity_base` ; coûts ≥ 0 s'ils sont renseignés.
- **Garde** `trg_sales_sale_lines_update_guard` : tout est figé sauf `cancelled_quantity_base`, `cancelled_xaf`, `delivered_quantity_base` (jamais décroissants), `unit_cost_xaf` et `cost_xaf` (renseignés une seule fois). `trg_sales_sale_lines_no_delete`.
- **Relations** 1 ligne → N mouvements `SALE` (un par lot), référencés par `stock_moves.source_line_id`. Les retours (`CUSTOMER_RETURN`, document source `SALE_CANCELLATION`) et les livraisons (`DELIVERY`) sont des mouvements rattachés à ces mouvements `SALE` (`origin_move_id`, ADR-029) ; le net d'une ligne se lit par `soldGoodsPosition` (`inventory`).
- **Suppr.** Suit la vente. **Droits** `SELECT`, `INSERT`, `UPDATE`. **Offline** DL, CR.

## sales_sale_cancellations

**Responsabilité** : document d'annulation, totale ou partielle, d'une vente : contre-écriture qui diminue le chiffre d'affaires à sa propre heure métier et remet la marchandise au stock (SM-SALE ; ADR-028 §5 ; ADR-029). Plusieurs annulations possibles par vente.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| [STD-DOC] | | | | Type `ANV` (annulation de vente, conventions §1.4) |
| `sale_id` | uuid → sales_sales | Non | — | Vente annulée |
| `order_id` | uuid → sales_sales_orders | Oui | — | Commande de la vente, dénormalisée ; nul pour une vente directe |
| `cause` | enum(`SALE_CANCELLATION`,`ORDER_CANCELLATION`,`ORDER_CLOSURE`,`ORDER_ADJUSTMENT`) | Non | — | DÉDUIT : annulation d'une vente (AV-030) ; annulation d'une commande ; clôture du reliquat (AV-128) ; baisse d'une commande confirmée (AV-130) |
| `status` | enum(`REQUESTED`,`APPLIED`,`REJECTED`) | Non | — | Une annulation n'est effective qu'une fois `APPLIED` ; `REQUESTED` attend sa validation |
| `reason_code_id` | uuid → catalog.reason_codes | Oui | — | Motif |
| `comment` | text | Oui | — | |
| `requested_by` | uuid → identity.users | Non | — | Demandeur |
| `approval_request_id` | uuid → approvals.approval_requests | Oui | — | Validation `SALE_CANCELLATION` (hors délai direct) |
| `cancelled_total_xaf` | money_xaf | Non | — | Total annulé ; DÉDUIT : égal à Σ des montants des lignes d'annulation (contrôle du code, non de la base) |
| `released_payment_treatment` | enum(`CUSTOMER_CREDIT`,`REFUND`) | Oui | — | DÉDUIT : sort de la part de paiement libérée, crédit client non affecté ou remboursement, au choix de l'approbateur (BR-VEN-027, ADR-028 §8) ; nul tant que non décidé ou sans objet |
| `applied_at` | ts | Oui | — | Heure métier de l'effet sur le chiffre d'affaires et sur le stock ; renseignée si et seulement si `APPLIED` ; figée après décision |
| `applied_business_date` | date | Oui | généré | Jour métier de `applied_at` (colonne générée stockée) : chiffre d'affaires par jour (BR-FIN-042) |
| [STD-ORIGIN] | | | | `occurred_at` : heure de la demande ou de la saisie |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `doc_number` ; `(created_device_id, local_ref)` ; `(command_id, sale_id)`.
- **`command_id` unique par vente** : une modification de commande (`sales.order.update`) peut créer une annulation par vente concernée, donc plusieurs documents pour une même commande de synchronisation, mais au plus un par vente. Écart à INV-SYN-01 (document unique par commande) : l'idempotence est portée par `sync.command_inbox`, `UNIQUE (command_id, sale_id)` et `UNIQUE (created_device_id, local_ref)`.
- **CK** `cause` et `status` dans leurs listes ; `(status = 'APPLIED') = (applied_at IS NOT NULL)` ; `cancelled_total_xaf ≥ 0` ; `released_payment_treatment` nul ou dans `CUSTOMER_CREDIT`, `REFUND` ; une cause de commande (`ORDER_*`) porte `order_id`.
- **IX** `(sale_id, status)`, `(order_id)`, `(applied_at)`, `(site_id, applied_business_date)`.
- **Garde** `trg_sales_sale_cancellations_update_guard` : figés le numéro, le site, la vente, la commande, la cause, le motif, le commentaire, le demandeur, le total annulé, l'heure métier, la commande de synchronisation, les traces d'origine (horloge, hors ligne) et la création ; le statut ne change que depuis `REQUESTED` (une annulation appliquée ou rejetée est terminale) ; après décision, `applied_at` (qui porte la diminution du chiffre d'affaires) et `approval_request_id` sont figés, et `released_payment_treatment` s'écrit une seule fois. Restent modifiables `status`, `approval_request_id` (avant décision), `released_payment_treatment`, `applied_at` (à la décision) et les colonnes d'audit. `trg_sales_sale_cancellations_no_delete`.
- **Suppr.** `IMMUABLE` (contre-écriture). **Droits** `SELECT`, `INSERT`, `UPDATE`. **Audit** Demande, décision, application. **Offline** CR (annulation possible hors ligne, D04 §12) ; DL à fixer avec les jeux de P4-11 (DÉDUIT).

## sales_sale_cancellation_lines

**Responsabilité** : lignes d'un document d'annulation : quantité et montant annulés par ligne de vente. Registre en ajout seul.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `cancellation_id` | uuid → sales_sale_cancellations | Non | — | |
| `sale_line_id` | uuid → sales_sale_lines | Non | — | |
| `quantity_base` | qty | Non | — | Quantité annulée, unité de base ; > 0 |
| `amount_xaf` | money_xaf | Non | — | Montant annulé : prorata de la quantité arrondi au franc (demi supérieur), la dernière annulation de la ligne emportant le reste exact (`lineCancellationAmountXaf`, ADR-028 §5) ; ≥ 0 |
| `created_at` | ts | Non | `now()` | |

- **PK** `id`. **UQ** `(cancellation_id, sale_line_id)`. **IX** `(sale_line_id)`.
- **CK** `quantity_base > 0` ; `amount_xaf ≥ 0`.
- **Garde** `trg_sales_sale_cancellation_lines_insert_guard` (la ligne annulée appartient à la vente du document), `trg_sales_sale_cancellation_lines_no_update` (aucune modification) et `trg_sales_sale_cancellation_lines_no_delete`.
- **Suppr.** `IMMUABLE`. **Droits** `SELECT`, `INSERT`. **Offline** Suit le document.

## sales_delivery_notes

**Responsabilité** : bon de livraison d'une commande (AV-034 ; ADR-028 §7). Chaque livraison, même partielle, est un document ; plusieurs par commande. Fait en ajout seul : ni statut, ni modification, ni suppression. Le retour de marchandise déjà livrée est hors MVP (AV-029) et la correction d'un bon saisi par erreur n'existe pas en V1 (AV-134).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| [STD-DOC] | | | | Type `LIV` |
| `order_id` | uuid → sales_sales_orders | Non | — | |
| `delivered_by_user_id` | uuid → identity.users | Non | — | Livreur |
| `recipient_name` | label | Oui | — | Réceptionnaire |
| `proof_attachment_id` | uuid → attachments.attachments | Oui | — | Preuve de remise éventuelle ; le bon étant en ajout seul, la pièce est créée avant le bon dans la même commande (`depends_on`) ou liée par son propriétaire (`owner_type`, `owner_id`) côté pièces jointes |
| `notes` | text | Oui | — | |
| [STD-ORIGIN] | | | | `occurred_at` : heure réelle de la remise |
| `business_date` | date | Non | généré | Jour métier de `occurred_at` |
| `created_at`, `created_by` | ts, uuid → identity.users | Non | `now()`, — | Insertion serveur et auteur ; pas de `[STD-AUDIT]` complet (ajout seul) |

- **PK** `id`. **UQ** `doc_number` ; `command_id` (une commande de synchronisation ne crée qu'un bon) ; `(created_device_id, local_ref)`.
- **IX** `(order_id, occurred_at)`, `(site_id, business_date)`, `(delivered_by_user_id, business_date)`.
- **Garde** `trg_sales_delivery_notes_no_update` et `trg_sales_delivery_notes_no_delete`.
- **Intégrité** INV-VEN-04 : une livraison ne dépasse pas le vendu non livré. Le plafond est tenu par les compteurs des lignes de vente et de commande et par le mouvement `DELIVERY` rattaché au mouvement `SALE` (INV-STK-17, ADR-029). Une livraison déjà faite n'est jamais rejetée (BR-SYN-007) ; le cas d'une livraison arrivant après l'annulation du reste est AV-133 (défaut : vente directe de régularisation et conflit).
- **Suppr.** `IMMUABLE`. **Droits** `SELECT`, `INSERT`. **Audit** Enregistrement du bon. **Offline** CR (livraison possible hors ligne, D04 §12) ; DL à fixer avec les jeux de P4-11 (DÉDUIT).

## sales_delivery_note_lines

**Responsabilité** : quantités livrées par ligne de vente. Registre en ajout seul.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `delivery_note_id` | uuid → sales_delivery_notes | Non | — | |
| `order_line_id` | uuid → sales_sales_order_lines | Non | — | Ligne de commande dont le livré augmente |
| `sale_line_id` | uuid → sales_sale_lines | Non | — | Ligne de vente livrée (sa marchandise est mise de côté « à livrer ») |
| `quantity_base` | qty | Non | — | Quantité remise, unité de base ; > 0 |
| `created_at` | ts | Non | `now()` | |

- **PK** `id`. **UQ** `(delivery_note_id, sale_line_id)`. **IX** `(order_line_id)`, `(sale_line_id)`.
- **CK** `quantity_base > 0`.
- **Garde** `trg_sales_delivery_note_lines_insert_guard` : la ligne de vente vient de la ligne de commande citée, et la ligne de commande est celle de la commande du bon ; `trg_sales_delivery_note_lines_no_update` et `trg_sales_delivery_note_lines_no_delete`. Le plafond de quantité reste tenu par les compteurs et le mouvement `DELIVERY` rattaché (P4-07).
- **Suppr.** `IMMUABLE`. **Droits** `SELECT`, `INSERT`. **Offline** Suit le document.

## sales_customer_payments

**Responsabilité** : encaissement client (SM-CUSTOMER-PAYMENT ; D09 §7.1 ; AV-056, ADR-028 §8). Un encaissement est un fait : montant, moyen, référence et compte ne changent pas ; évoluent le statut (la décision de la Finance fait passer un suspect à `RECORDED`, le mouvement de trésorerie se renseigne alors), la part non affectée et l'annulation.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| [STD-DOC] | | | | Type `ENC` |
| `customer_id` | uuid → crm.customers | Oui | — | Nul pour une vente anonyme |
| `payment_method_code` | code → finance.payment_methods | Non | — | `varchar(40)` |
| `amount_xaf` | money_xaf | Non | — | > 0 |
| `external_reference` | varchar(80) | Oui | — | Référence mobile money ou virement telle que saisie ; requise pour les moyens qui l'exigent (contrôle du code) |
| `reference_normalized` | varchar(80) | Oui | — | DÉDUIT : référence passée par `normalizePaymentReference` (espaces retirés, majuscules) |
| `reference_key` | varchar(121) | Oui | généré | DÉDUIT, donnée technique (colonne générée stockée) : `moyen:référence normalisée`, renseignée seulement pour les statuts `RECORDED` et `CANCELLATION_REQUESTED`, nulle sinon ; porte l'unicité de la référence (INV-FIN-03). Un `SUSPECT_DUPLICATE` ou un `REJECTED` n'y compte pas, un encaissement annulé libère sa référence |
| `received_by_user_id` | uuid → identity.users | Non | — | |
| `cash_account_id` | uuid → finance.cash_accounts | Non | — | Compte crédité (BR-FIN-002) |
| `cash_session_id` | uuid (réf. `finance.cash_sessions`, sans clé étrangère jusqu'à P5) | Oui | — | Peut être rattaché plus tard |
| `cash_movement_id` | uuid → finance.cash_movements | Oui | — | Mouvement de trésorerie : renseigné pour `RECORDED`, `CANCELLATION_REQUESTED` et `CANCELLED`, nul pour `SUSPECT_DUPLICATE` et `REJECTED` (INV-FIN-09) ; ne change plus une fois posé (INV-FIN-01) |
| `status` | enum(`RECORDED`,`SUSPECT_DUPLICATE`,`REJECTED`,`CANCELLATION_REQUESTED`,`CANCELLED`) | Non | — | `REJECTED` et `CANCELLED` sont terminaux |
| `duplicate_of_payment_id` | uuid → sales_customer_payments | Oui | — | DÉDUIT : encaissement dont celui-ci semble le doublon (décision de la Finance) |
| `intended_sale_id` | uuid → sales_sales | Oui | — | DÉDUIT : vente visée par un encaissement suspect, affectée à la décision de la Finance (AV-135) ; figée ; exclusive de `intended_order_id` |
| `intended_order_id` | uuid → sales_sales_orders | Oui | — | DÉDUIT : commande visée (acompte) ; figée |
| `unallocated_xaf` | money_xaf | Non | — | Crédit client restant, non affecté (dénormalisé) ; nul hors encaissement enregistré d'un client identifié |
| `refunded_xaf` | money_xaf | Non | 0 | DÉDUIT : part remboursée au client (sortie de caisse) ; ne diminue jamais ; `unallocated_xaf + refunded_xaf ≤ amount_xaf` |
| [STD-CANCEL] | | | | Annulation (`PAYMENT_CANCELLATION`) |
| [STD-ORIGIN] | | | | |
| `business_date` | date | Non | généré | Jour métier de `occurred_at` |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `doc_number` ; `(created_device_id, local_ref)` ; `reference_key` (nul exclu par construction) ; `cash_movement_id` (un mouvement de trésorerie par encaissement, INV-FIN-09).
- **`command_id` non unique** (index simple) : une vente enregistrée en une commande crée un encaissement par moyen de paiement (BR-VEN-023). Écart à INV-SYN-01 : l'idempotence est portée par `sync.command_inbox` et par `UNIQUE (created_device_id, local_ref)`.
- **CK** `status` dans la liste ; `amount_xaf > 0` ; `unallocated_xaf ≥ 0`, `refunded_xaf ≥ 0` et leur somme ≤ `amount_xaf` ; crédit client (`unallocated_xaf > 0`) réservé à `RECORDED` et `CANCELLATION_REQUESTED` avec client identifié ; `cash_movement_id` non nul pour `RECORDED`, `CANCELLATION_REQUESTED`, `CANCELLED` et nul pour `SUSPECT_DUPLICATE`, `REJECTED` ; `cancelled_at` et `cancelled_by` renseignés si et seulement si `CANCELLED`, motif, commentaire et validation d'annulation consignés dès `CANCELLATION_REQUESTED` ; vente et commande visées exclusives ; `reference_normalized` en majuscules sans espace, et `external_reference` exige `reference_normalized`.
- **IX** `(customer_id, occurred_at)`, `(cash_session_id)`, `(site_id, business_date)`, `(status, occurred_at)`, `(command_id)`.
- **Garde** `trg_sales_customer_payments_update_guard` : figés le numéro, le site, le client, le moyen, le montant, le receveur, le compte, le doublon et la cible visés, `[STD-ORIGIN]` et la création ; les références ne se corrigent qu'à la décision de la Finance sur un doublon suspect (`SUSPECT_DUPLICATE` vers `RECORDED`, AV-135) ; un encaissement `REJECTED` ou `CANCELLED` ne change plus de statut, de montants ni d'annulation ; la part remboursée ne diminue jamais ; `cash_movement_id` ne change plus une fois renseigné. `trg_sales_customer_payments_no_delete`.
- **Suppr.** `ANNULATION` (contre-écriture de trésorerie). **Intégrité** INV-FIN-01, INV-FIN-03, INV-FIN-04, INV-FIN-09. **Droits** `SELECT`, `INSERT`, `UPDATE`. **Audit** Toute action. **Offline** DL (7 jours), CR ; jeu à fixer en P4-11.

## sales_payment_allocations

**Responsabilité** : affectation d'un encaissement à une vente (règlement) ou à une commande (acompte). Registre d'affectation : immuable, sauf le passage unique de `ACTIVE` à `REVERSED`. Une libération partielle renverse l'affectation et en crée une nouvelle pour la part conservée.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `payment_id` | uuid → sales_customer_payments | Non | — | |
| `sale_id` | uuid → sales_sales | Oui | — | Règlement |
| `order_id` | uuid → sales_sales_orders | Oui | — | Acompte |
| `amount_xaf` | money_xaf | Non | — | > 0 |
| `allocated_at` | ts | Non | — | Heure métier |
| `status` | enum(`ACTIVE`,`REVERSED`) | Non | `ACTIVE` | `varchar(10)` |
| `reversed_at` | ts | Oui | — | Renseignée si et seulement si `REVERSED` |
| `reversal_cause` | enum(`PAYMENT_CANCELLED`,`SALE_CANCELLED`,`REALLOCATED`,`ORDER_CONFIRMED`,`ORDER_CANCELLED`,`ORDER_CLOSED`) | Oui | — | Renseignée si et seulement si `REVERSED` ; `ORDER_CONFIRMED` remplace `ORDER_FULFILLED` (ADR-028 §8) ; `ORDER_CANCELLED` et `ORDER_CLOSED` : acompte libéré par une commande annulée ou clôturée sans vente |
| `command_id` | uuid | Oui | — | Non unique, sans clé étrangère |
| `created_at` | ts | Non | `now()` | |
| `created_by` | uuid → identity.users | Non | — | |

- **PK** `id`. **IX** `(payment_id)`, `(sale_id, status)`, `(order_id, status)`, `(command_id)` (les index partiels `ACTIVE` de l'ancien dictionnaire deviennent des index complets avec `status`).
- **CK** `amount_xaf > 0` ; exactement une cible (`sale_id` xor `order_id`) ; `status` dans la liste ; `ACTIVE` ⇒ `reversed_at` et `reversal_cause` nuls, `REVERSED` ⇒ les deux renseignés ; `reversal_cause` dans la liste.
- **Garde** `trg_sales_payment_allocations_update_guard` : figés l'encaissement, la cible, le montant, l'heure métier, la commande de synchronisation et la création ; une affectation `REVERSED` ne change plus. `trg_sales_payment_allocations_insert_guard` : on n'affecte qu'un encaissement `RECORDED` (INV-FIN-09), à une vente ou une commande non annulée (INV-FIN-10). `trg_sales_payment_allocations_no_delete`.
- **Suppr.** `IMMUABLE` sauf passage à `REVERSED`. **Intégrité** INV-FIN-04 (Σ affectations actives ≤ montant) et INV-VEN-06 (Σ ≤ net de la vente), tenus par le code ; INV-FIN-10. **Droits** `SELECT`, `INSERT`, `UPDATE`. **Offline** DL, CR.

## Créances (pas de vue SQL)

Il n'y a **pas de vue** `sales.v_receivables` : les créances par vente et par client se calculent **en requête** (P4-09), à partir de `sales_sales` (`status <> 'CANCELLED'` et `balance_due_xaf > 0`), avec `due_date`. Les jours de retard et la tranche d'ancienneté (`0-30`, `31-60`, `61-90`, `>90`) viennent de `receivableAging` (`packages/domain`, BR-FIN-007) ; les index d'appui sont `(payment_status, due_date)` et `(customer_id, occurred_at)`. L'encours par client est téléchargé dans le périmètre de l'utilisateur pour le contrôle de crédit hors ligne (jeu `customers`, P4-11).

## Paramètres et politiques utilisés par ces tables

Valeurs par défaut posées par les seeds (`db/seeds/system-settings.ts`, `db/seeds/sales-references.ts`) ; catalogue des clés : [02-organization.md](02-organization.md).

| Clé | Défaut | Visible de l'appareil | Réf. |
|---|---|---|---|
| `sales.direct_cancel_minutes` | 15 | Oui | AV-030 |
| `sales.default_payment_terms_days` | 30 | Non | AV-028 |
| `sales.duplicate_payment_window_minutes` | 10 | Oui | AV-056 |
| `sales.offline_over_allocation_allowed` | `false` (réglable par site) | Oui | AV-025 |
| `sales.undelivered_alert_days` | 7 | Non | AV-132 |

Cinq politiques de contrôle par défaut (validation requise, condition `{}`, portée `ALL`, sans photo) : `PRICE_OVERRIDE_DEFAULT` (`sales.price_override.approve`, AV-026), `SALE_CANCELLATION_DEFAULT` (`sales.sale_cancel.approve`, AV-030), `CREDIT_LIMIT_EXCEEDED_DEFAULT` (`sales.credit_limit_exceed.approve`, AV-028), `PAYMENT_CANCELLATION_DEFAULT` et `PAYMENT_DUPLICATE_DEFAULT` (`sales.payment.cancel`, AV-056).

## Altérations liées dans d'autres modules

Migrations `20261003090100` à `20261003090300` et `20261003090800`, pour les ventes. Portées dans les dictionnaires [06-inventory.md](06-inventory.md), [02-organization.md](02-organization.md) et [10-approvals-attachments-communication.md](10-approvals-attachments-communication.md).

- **`inventory_stock_moves`** : colonnes `origin_move_id` et `origin_seq` (`UNIQUE (origin_move_id, origin_seq)`, réservées à `CUSTOMER_RETURN` et `DELIVERY`, qui en exigent une), type de mouvement `DELIVERY`, documents sources `SALE_CANCELLATION` et `DELIVERY` ; déclencheur `trg_inventory_stock_moves_settlement_guard` (plafond par origine, séquence sans trou, valeur exacte à la dernière opération, ni vente ni livraison ni retour inversés, « à livrer » du site de la source ; INV-STK-17, INV-STK-18, ADR-029) ; `DELIVERY` ⇔ document source `DELIVERY`, `SALE_CANCELLATION` ⇒ `CUSTOMER_RETURN`. DÉDUIT : `source_doc_id` désigne alors le document d'annulation ou le bon de livraison.
- **`organization_locations`** : type virtuel `V_TO_DELIVER` rattaché à un site (un actif par site, colonne générée `active_to_deliver_site`), exception à « virtuel ⇒ sans site » (ADR-028 §1).
- **`approvals_control_policies`** : types d'opération `PAYMENT_CANCELLATION` et `PAYMENT_DUPLICATE`.
