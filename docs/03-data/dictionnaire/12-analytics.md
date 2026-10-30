# Dictionnaire — schéma `analytics`

> Le module `analytics` **lit** les autres modules via des vues ; il n'écrit que ses propres tables (D11 ; BR-ANA-006 à 009).
> Sous MySQL les tables s'appellent `analytics_saved_views`, `analytics_export_jobs`, `analytics_kpi_snapshots` et `analytics_query_log` (migration `20261201090300`, P9-13).

## analytics.saved_views

**Responsabilité** : vues sauvegardées.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `owner_user_id` | uuid → identity.users | Non | — | |
| `name` | label | Non | — | |
| `name` | label | Non | — | Unique par propriétaire |
| `dataset` | code | Non | — | Jeu de faits (`f_sales_line`…), de la forme `f_*` |
| `definition` | json | Non | — | Objet : filtres, colonnes, groupements, agrégats, tri (schéma versionné de la couche sémantique) |
| `catalog_version` | int | Non | — | Version du catalogue à la sauvegarde ; un champ disparu rend la vue `OUTDATED` (ADR-067 §2) |
| `shared_with_roles` | json (tableau de codes de rôle) | Non | `[]` | Partage (BR-ANA-007) |
| `is_default_for_role` | code | Oui | — | Vue par défaut d'un rôle : une seule vue par rôle |
| [STD-AUDIT] | | | | |

- **PK** `id`. **UQ** `(owner_user_id, name)`, `(is_default_for_role)` (les valeurs nulles ne se heurtent pas). **IX** `(dataset)`. **Suppr.** Suppression physique autorisée par le propriétaire (objet de confort, non métier), auditée. Le propriétaire et l'identité sont immuables (déclencheur).

## analytics.export_jobs

**Responsabilité** : exports.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `requested_by` | uuid → identity.users | Non | — | |
| `dataset` | code | Non | — | |
| `definition` | json | Non | — | Requête exportée |
| `format` | enum(`CSV`,`XLSX`) | Non | — | AV-067 |
| `row_count` | int | Oui | — | Nombre de lignes exportées (renseigné pour `DONE` et `EXPIRED`) |
| `duration_ms` | int | Oui | — | Durée du calcul (audit, BR-ANA-008) |
| `command_id` | uuid | Oui | — | Commande de demande : un rejeu ne crée pas un second export (unique) |
| `status` | enum(`QUEUED`,`RUNNING`,`DONE`,`FAILED`,`EXPIRED`) | Non | `QUEUED` | |
| `storage_key` | varchar(200) | Oui | — | Fichier ; téléchargement authentifié du demandeur, valable 24 h (ADR-067 §5) |
| `catalog_version` | int | Non | — | Version du catalogue figée à la demande |
| `error_code` | varchar(60) | Oui | — | Motif d'un `FAILED` (droit retiré, limite, durée) |
| `expires_at` | ts | Non | — | Fin de validité du téléchargement |
| `created_at`, `finished_at` | ts | | | |

- **PK** `id`. **UQ** `(command_id)`. **IX** `(requested_by, created_at)`, `(status, created_at)`. **Contraintes** : tant que l'export est `QUEUED` ou `RUNNING` il n'a pas de `finished_at`, terminé il en a une ; `DONE` a son `storage_key` et son `row_count` ; `FAILED` a son `error_code`. **Immuabilité** (déclencheur) : demandeur, jeu, définition, format, version du catalogue et échéance ne changent jamais ; un export `FAILED` ou `EXPIRED` est figé ; un export `DONE` ne peut qu'expirer. **Suppr.** Fichier purgé après 30 jours ; ligne conservée (audit, BR-ANA-008) — aucune suppression (déclencheur), et l'application n'a pas le privilège `DELETE`.

## analytics.kpi_snapshots

**Responsabilité** : instantanés d'indicateurs personnels.

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `user_id` | uuid → identity.users | Non | — | |
| `scope_key` | varchar(100) | Non | — | Code du tableau (`direction`, `commercial`, `stock`, `production`, `finance`, `distribution`) : le périmètre est celui, exact, de l'utilisateur (ADR-066 §5) |
| `period_key` | varchar(20) | Non | — | `TODAY`, `WEEK`, `MONTH` |
| `payload` | json | Non | — | Valeurs des indicateurs (codes du registre `kpi-catalog.ts`, ADR-065) ; pour `distribution` : quatre indicateurs d'origine, KPI-OPS-02 (P9-27, AV-480) et, avec `sync.conflict.resolve`, `KPI-OPS-02-CONFLICTS` |
| `computed_at` | ts | Non | — | Instant de la dernière publication : écrit quand le contenu change et, pour la date seule, au plus toutes les heures ; affiché comme « à jour au » |

- **PK** `(user_id, scope_key, period_key)`. **IX** `(computed_at)` (reprise de la tâche par ancienneté). **Suppr.** Écrasé à chaque calcul ; supprimé (avec publication d'un `DELETE` au flux) à la perte du droit du tableau ou de l'appareil actif ; la lecture revérifie le droit avant la suppression par la tâche (P9-25, TB-7). **Offline** DL (jeu `kpi`, portée `USER`).

**Registre des indicateurs** (hors base, `packages/domain/src/kpi-catalog.ts`, ADR-065) : depuis P9-27 (AV-462), les cinq indicateurs KPI-COM-16, KPI-PRD-04, KPI-PRD-05, KPI-PRD-09 et KPI-OPS-02 sont à l'état `EXISTING` ; aucune table ni colonne nouvelle, seul KPI-PRD-04 a un lien d'exploration (`f_production_daily` / `feed_consumed`).

## analytics.query_log

**Responsabilité** : journal technique des requêtes de l'explorateur ([ADR-064](../../decisions/ADR-064-couche-semantique-et-explorateur.md) §8) ; l'export a, lui, sa ligne d'audit (BR-ANA-008).

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `user_id` | uuid → identity.users | Non | — | |
| `dataset` | code | Non | — | |
| `definition` | json | Non | — | Requête telle que validée |
| `outcome` | enum(`OK`,`REFUSED`,`LIMIT`,`ERROR`) | Non | — | |
| `error_code` | varchar(60) | Oui | — | |
| `row_count` | int | Oui | — | |
| `duration_ms` | int | Oui | — | |
| `created_at` | ts | Non | `now()` | |

- **PK** `id`. **IX** `(created_at)`, `(user_id, created_at)`. **Ajout seul** (déclencheur contre les modifications). **Suppr.** `PURGE_TECHNIQUE` après 90 jours (AV-387).

## Jeux de faits (vues de lecture)

Treize vues `analytics_f_*` (migrations `20261201090400`, `20261201090500`, `20261201090600`, P9-13), déclarées par le catalogue de `packages/domain` (`analytics-catalog.ts`) ; les essais du serveur (`apps/server/test/analytics-catalog-views.test.ts`) vérifient que chaque colonne citée par le catalogue existe dans la vue, avec un type qui convient à son usage, et que chaque permission citée existe.

**Règles communes** ([ADR-064](../../decisions/ADR-064-couche-semantique-et-explorateur.md) §2 et sa révision de P9-13) : lecture seule (`SQL SECURITY INVOKER`, `ALGORITHM = TEMPTABLE` : une vue fusionnée à table unique ou une jointure se laisserait écrire avec les droits de l'application sur la table de base, aucune vue n'est modifiable) ; `business_day` est l'alias de la colonne de jour métier générée de la table source quand elle existe, sinon `CAST(CONVERT_TZ(…, '+00:00', '+01:00') AS DATE)` (Africa/Douala, décalage fixe) ; les colonnes de portée sont dérivées une fois dans la vue, **comme le module propriétaire évalue sa propre lecture** (l'explorateur ne rend jamais plus que `evaluateAccess` sur le document) ; un document annulé ne compte pas, sauf quand l'annulation est elle-même un événement daté (vente, encaissement : ligne négative à sa propre date) ; quand une table mêle des lignes comptées et d'autres à part, des colonnes de mesure distinctes séparent le constaté, l'en attente et le non justifié (pertes, dépenses : comme `lossValueSummary` et `expensesSummary`) ; les libellés constants (`event_kind`) portent explicitement la collation de la base (`utf8mb4_0900_as_cs`), sans quoi la requête échoue (`Illegal mix of collations`) ; une somme ou un compte vide n'est pas un zéro : le compilateur additionne avec `COALESCE(…, 0)`, mais une moyenne, un minimum ou un maximum vide reste `NULL` ; un filtre « différent de » ou « hors de » se compile toujours avec `IS NULL OR` (logique à trois valeurs).

| Vue | Grain | Dimensions | Mesures | Portée (colonnes) | Sources et définition |
|---|---|---|---|---|---|
| `analytics_f_sales_line` | Ligne de vente (`SALE`, au jour de la vente) ou ligne d'annulation **appliquée** (`CANCELLATION`, négative, au jour d'application) | `business_day`, `sale_day`, `event_kind`, `product_id`, `product_category_id`, `site_id`, `pos_id` (emplacement de vente), `zone_id`, `channel`, `customer_id`, `customer_category_id`, `commercial_user_id`, `seller_user_id`, `sale_type`, `payment_status` | `quantity_base`, `amount_xaf`, `discount_xaf`, `counted_sale_id` (vente non annulée en totalité), `cost_xaf` et `margin_xaf` (protégées) | site, zone, `owner_user_id` (le commercial, à défaut le vendeur : `GET /sales`) | `sales_sales`, `sales_sale_lines`, `sales_sale_cancellations` et lignes ; coût d'une vente : `sales_sale_lines.cost_xaf` (somme des mouvements `SALE` de la ligne, figée à la vente) ; coût d'une annulation : retours `CUSTOMER_RETURN` de sa ligne. Comme `saleActivityArms` ; AV-438 |
| `analytics_f_orders` | Ligne de commande engagée (ni brouillon ni annulée), au jour de sa confirmation | `business_day`, `customer_id`, `commercial_user_id`, `channel`, `product_id`, `status`, `site_id`, `zone_id` (celle du site) | `order_id` (distinct), `ordered_quantity`, `delivered_quantity` (cumul livré à ce jour), `amount_xaf` | site, zone, `commercial_user_id` | `sales_sales_orders` et lignes ; `confirmed_at`, à défaut `occurred_at` (KPI-COM-06 « confirmées dans P ») |
| `analytics_f_payments` | Encaissement confirmé (`PAYMENT`, à son jour) ou annulé (`CANCELLATION`, négatif, au jour de l'annulation) | `business_day`, `event_kind`, `payment_method`, `cash_account_id`, `site_id`, `received_by_user_id`, `customer_id` | `amount_xaf` | site, receveur | `sales_customer_payments`. Comme `cashedActivity` (les remboursements ne sont pas retranchés, AV-244) |
| `analytics_f_stock_moves` | Mouvement de stock (les contre-écritures en sont : `is_reversal` ; leur `move_type` n'est pas toujours celui du mouvement défait) | `business_day`, `product_id`, `from_location_id`, `to_location_id`, `move_type`, `is_reversal`, `source_doc_type`, `reason_code`, `stock_lot_id`, `from_site_id`, `to_site_id` | `quantity_base`, `value_xaf` (protégée) | sites d'origine ou de destination, titulaires des emplacements mobiles | `inventory_stock_moves`, `organization_locations`. Soldes et flux comme `locationFlows` |
| `analytics_f_stock_balance` | Solde courant (jeu d'état) des emplacements physiques, du transit, des pertes en attente et de l'à-livrer (soldes entièrement à zéro omis) | `location_id`, `location_type`, `product_id`, `stock_lot_id` (vide sans suivi par lot), `family`, `site_id` | `balance_base`, `allocated_base` (nul : ADR-033 §3), `available_base` (nul hors emplacement physique), `value_xaf` (protégée) | site, titulaire | `inventory_stock_balances`, `inventory_product_valuations`. Comme `GET /stock` (disponible selon le mode de garde, valeur = solde × coût unitaire moyen arrondi ; AV-437) ; les sources et puits de mouvement (fournisseur, client, perte, production, consommation, ajustement, ouverture) n'ont pas de stock ; le solde et la valeur sans filtre d'emplacement additionnent physique, transit, pertes en attente et à-livrer (filtrer `location_type`, AV-444) |
| `analytics_f_losses` | Déclaration de perte non annulée | `business_day`, `category`, `reason_code`, `product_id`, `stock_lot_id`, `production_lot_id`, `location_id`, `declared_by`, `status`, `site_id` | `quantity_base` et `value_xaf` (constatées, protégée), `pending_quantity_base` et `pending_value_xaf` (en attente de validation, protégée) | site, déclarant | `inventory_loss_declarations`. Statuts comptés comme `lossValueSummary` ; une perte rejetée et rendue n'est pas une perte |
| `analytics_f_prospecting` | Événement : compte créé (`ACCOUNT`, hors fusionné), visite enregistrée (`VISIT`), conversion (`CONVERSION`, au titulaire à l'instant de la conversion ; sans titulaire : `user_id` vide, comptée) | `business_day`, `event_kind`, `user_id`, `zone_id` (celle du compte), `source`, `stage`, `result` | `created_customer_id`, `visited_prospect_id`, `visit_id`, `contact_customer_id` (compte créé avec téléphone), `converted_customer_id` (comptes distincts) | zone, `user_id` (l'acteur : acquéreur, auteur de la visite, titulaire à la conversion ; non le titulaire courant : AV-441) | `crm_customers`, `crm_visits`, `crm_customer_assignments`. Comme `commercialEffort`, sauf les comptes fusionnés, ni créés ni convertis (AV-442) |
| `analytics_f_attendance` | Session de travail, au jour de son début | `business_day`, `user_id`, `zone_id` (zone déclarée au pointage), `status`, `override` | `accepted_day_key` (jours de présence distincts : sans dérogation exigée, ou approuvée), `session_count` et `duration_minutes` (toutes les sessions, dérogations comprises) | zone déclarée, personne | `fieldwork_work_sessions` (règle fermée pour la portée de site, AV-374) |
| `analytics_f_production_daily` | Fait de production d'un lot et d'un jour : mortalité, aliment, œufs, pesée (colonnes des mesures non portées : vides) | `business_day`, `lot_id`, `lot_type`, `site_id`, `building_id` | `mortality_heads`, `feed_quantity`, `eggs_collected`, `eggs_sellable`, `average_weight_kg` (moyenne des pesées, non pondérée) | site | `inventory_loss_declarations` (mortalité, AV-436), `inventory_consumptions` (nature `ALIMENT` ; mesure `feed_consumed` = KPI-PRD-04, indicateur du registre à l'état `EXISTING` depuis P9-27, AV-476), `production_egg_collections`, `production_lot_weighings` |
| `analytics_f_costs` | Écriture de coût (débit positif, crédit négatif) | `business_day`, `cost_object_type`, `cost_object_id`, `cost_type`, `site_id` (du site, du lot de production ou du lot d'incubation) | `amount_xaf` (protégée) | site | `inventory_cost_entries`. Net par objet et nature comme `costObjectBreakdown` |
| `analytics_f_expenses` | Dépense vivante (ni annulée ni refusée avant paiement) | `business_day`, `category_id`, `cost_object_type`, `site_id`, `status` | `amount_xaf` (valides : enregistrées, approuvées, payées), `pending_xaf` (en attente de validation), `unjustified_xaf` (payées puis refusées) | site, auteur | `finance_expenses`. Comme `expensesSummary` |
| `analytics_f_cash` | Mouvement de trésorerie | `business_day`, `cash_account_id`, `movement_type`, `is_reversal`, `site_id` | `inflow_xaf`, `outflow_xaf` (flux bruts : virements, écarts de caisse et contre-écritures compris, AV-444) | site du compte, titulaire du compte (à défaut son responsable : `cash-account-query`) | `finance_cash_movements`, `finance_cash_accounts`. Solde = entrées − sorties, comme `cashAccountBalance` |
| `analytics_f_purchases` | Ligne non annulée d'un bon de commande engagé (ni brouillon, ni en attente d'approbation, ni annulé), au jour de son approbation (AV-443), ou ligne d'une réception comptabilisée, au jour de la réception | `business_day`, `supplier_id`, `product_id`, `site_id` | `ordered_quantity`, `delivered_quantity`, `rejected_quantity`, `accepted_quantity`, `amount_xaf` (montant commandé, protégé) | site | `procurement_purchase_orders`, `procurement_goods_receipts` et lignes. Comme `purchaseOrderMatching` ; AV-439 |

Sous MySQL, le périmètre RBAC (BR-ANA-004) est appliqué par le compilateur de l'explorateur : une clause de portée en union (site, zone, personne) construite depuis l'étendue de la permission de lecture du domaine du jeu, MySQL n'ayant pas de sécurité au niveau des lignes ([ADR-064](../../decisions/ADR-064-couche-semantique-et-explorateur.md) §4). Un site couvre aussi les droits de portée zone quand la zone de la ligne se déduit de celle du site ; les jeux dont la ligne porte sa propre zone (ventes, commandes) ou n'a pas de site (prospection, présences) ont une colonne de zone, lue en propre par l'étendue exacte. Stratégie de matérialisation : [`../../05-architecture/01-architecture-logicielle.md`](../../05-architecture/01-architecture-logicielle.md) §6. **Index** : aucun index n'est ajouté par P9-13 ; à l'échelle de la base d'essai (au plus quelques dizaines de milliers de lignes par table) le plan `EXPLAIN` choisit le parcours complet avec ou sans index, et un essai d'index fonctionnel sur le jour métier calculé n'a pas été utilisé par l'optimiseur ; les index qu'un volume réel justifie sont ceux de P9-22 ; P9-22 n'en a ajouté aucun (AV-450), les jeux dont la vue date par une expression restent à mesurer ([ADR-068](../../decisions/ADR-068-charge-paliers-analytiques-et-retention.md) §4).
