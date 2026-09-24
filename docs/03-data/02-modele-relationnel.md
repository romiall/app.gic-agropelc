# Modèle relationnel (Livrable n°5)

> Section 14 du format final (PM §48). Construit à partir du modèle conceptuel ([`../02-domain-model/02-modele-conceptuel-erd.md`](../02-domain-model/02-modele-conceptuel-erd.md)). Le détail colonne par colonne est dans le [dictionnaire](dictionnaire/README.md) (section 15).
> SGBD : **MySQL 8** ([ADR-023](../decisions/ADR-023-mysql.md), remplace PostgreSQL — recadrage Hostinger sans VPS). **Un espace de noms logique par module** (« schéma » ci-dessous), et chaque espace de noms n'est écrit que par son module (INV-GLO-05). Physiquement : une seule base MySQL, tables préfixées par module, `GRANT` par table (au lieu d'un schéma PostgreSQL par module) — voir [`../05-architecture/05-stack.md`](../05-architecture/05-stack.md) §3.2.

---

## 1. Catégories de tables (PM §27)

| Code | Catégorie | Caractéristiques | Politique de suppression |
|---|---|---|---|
| `REF` | Référentiel | Petites listes administrées (produits, unités, zones, sites, motifs) | `DESACTIVATION` : statut inactif, jamais de suppression |
| `MASTER` | Master data | Entités métier vivantes et modifiables (clients, fournisseurs, utilisateurs, appareils) | `DESACTIVATION` (statut) ; fusion pour les doublons |
| `TX` | Transaction / document | Documents métier avec cycle de vie (ventes, commandes, transferts…) | `ANNULATION` : statut + contre-écriture, jamais de suppression |
| `LEDGER` | Journal / registre | Écritures en ajout seul (mouvements de stock, de trésorerie, de coûts, de quota, affectations) | `IMMUABLE` : ni modification ni suppression ; correction par écriture inverse |
| `LINK` | Liaison | Associations N-M | Selon la table (voir le dictionnaire) |
| `HIST` | Historisation | Périodes et versions (affectations, historiques de stade, coûts standard) | `IMMUABLE` (fermeture de période par date de fin) |
| `CONF` | Configuration | Paramètres, politiques, règles d'alerte | `VERSIONNEMENT` : nouvelle version datée |
| `PROJ` | Projection | Données dérivées, reconstructibles (soldes, valorisations, instantanés) | Reconstructible ; jamais une source de vérité |
| `SYNC` | Synchronisation | Commandes reçues, conflits, flux de changements, états d'appareil | `IMMUABLE` pour les journaux ; `PURGE_TECHNIQUE` après rétention pour le flux |
| `INTEG` | Intégration externe | Liens et messages Kommo | `IMMUABLE` pour les messages, avec purge technique après rétention |
| `AUD` | Audit | Journal d'audit | `IMMUABLE` |
| `PLAT` | Plateforme | Événements métier, positions des consommateurs, séquences | `IMMUABLE` (événements) ; technique |
| `TECH` | Technique éphémère | Notifications lues, abonnements push, jobs d'export | `PURGE_TECHNIQUE` |

## 2. Catalogue des tables

Colonnes : schéma.table | catégorie | responsabilité métier | principales références | hors ligne (`DL` = téléchargée sur l'appareil, `CR` = créée sur l'appareil, `SRV` = serveur uniquement) | détail.

### 2.1 `identity`

| Table | Cat. | Responsabilité | Références | Hors ligne | Détail |
|---|---|---|---|---|---|
| `identity.users` | MASTER | Comptes utilisateurs | — | DL (soi-même ; noms des collègues du périmètre) | [dict](dictionnaire/01-identity.md) |
| `identity.roles` | REF | Rôles métier | — | DL | idem |
| `identity.permissions` | REF | Catalogue des permissions | — | DL | idem |
| `identity.role_permissions` | LINK | Permissions d'un rôle, avec portée maximale | roles, permissions | DL | idem |
| `identity.user_role_assignments` | HIST | Rôle × utilisateur × périmètre × période | users, roles, sites, zones, teams | DL (soi-même) | idem |
| `identity.devices` | MASTER | Appareils enrôlés | users | DL (soi-même) | idem |
| `identity.auth_sessions` | TECH | Sessions et jetons de rafraîchissement (hachés) | users, devices | SRV | idem |

### 2.2 `organization`

| Table | Cat. | Responsabilité | Références | Hors ligne | Détail |
|---|---|---|---|---|---|
| `organization.zones` | REF | Hiérarchie de zones, géorepères | zones (parent) | DL (périmètre + ancêtres) | [dict](dictionnaire/02-organization.md) |
| `organization.zone_ancestors` | REF | Fermeture transitive de la hiérarchie des zones (recherche d'appartenance, remplace `path` + GIN de la version PostgreSQL — ADR-023) | zones ×2 | DL (dérivée des zones téléchargées) | idem |
| `organization.sites` | REF | Sites (ferme, magasin, PDV, bureau) | zones | DL | idem |
| `organization.points_of_sale` | REF | Configuration d'un PDV | sites, locations, devices (appareil désigné) — la caisse du PDV se retrouve par `finance.cash_accounts (site_id, type CAISSE_PDV)` pour éviter une dépendance organization → finance | DL (son PDV) | idem |
| `organization.locations` | REF | Emplacements physiques et virtuels | sites, locations (parent), users (détenteur), devices (appareil désigné) | DL (périmètre) | idem |
| `organization.teams` | REF | Équipes commerciales | users (responsable) | DL (son équipe) | idem |
| `organization.team_memberships` | HIST | Appartenances datées | teams, users | DL (son équipe) | idem |
| `organization.system_settings` | CONF | Paramètres historisés | — | DL (paramètres client) | idem |

### 2.3 `catalog`

| Table | Cat. | Responsabilité | Références | Hors ligne | Détail |
|---|---|---|---|---|---|
| `catalog.product_categories` | REF | Arborescence de produits | parent | DL | [dict](dictionnaire/03-catalog-pricing.md) |
| `catalog.units` | REF | Unités de mesure | — | DL | idem |
| `catalog.products` | REF | Produits | categories, units | DL (actifs) | idem |
| `catalog.product_units` | REF | Conditionnements par produit | products, units | DL | idem |
| `catalog.reason_codes` | REF | Motifs par catégorie | — | DL | idem |
| `catalog.product_standard_costs` | HIST | Coût standard historisé | products | SRV | idem |
| `catalog.customer_categories` | REF | Catégories de clients (référentiel commercial partagé) | — | DL | [dict](dictionnaire/04-crm-fieldwork.md) |
| `catalog.sales_channels` | REF | Canaux de vente (référentiel commercial partagé) | — | DL | idem |

### 2.4 `pricing`

| Table | Cat. | Responsabilité | Références | Hors ligne | Détail |
|---|---|---|---|---|---|
| `pricing.commercial_campaigns` | REF | Campagnes commerciales | — | DL (actives et futures) | [dict](dictionnaire/03-catalog-pricing.md) |
| `pricing.price_rules` | CONF/HIST | Règles tarifaires versionnées | products, zones, sites, customer_categories (catalog), sales_channels (catalog), campaigns, price_rules (remplacée) | DL (actives et futures du périmètre) | idem |

### 2.5 `crm`

| Table | Cat. | Responsabilité | Références | Hors ligne | Détail |
|---|---|---|---|---|---|
| `crm.lead_sources` | REF | Sources de prospects | — | DL | [dict](dictionnaire/04-crm-fieldwork.md) |
| `crm.pipeline_steps` | REF | Étapes configurables | — | DL | idem |
| `crm.customers` | MASTER | Comptes clients | users (acquéreur, titulaire), zones, categories, steps, sites (rattachement PDV), customers (fusion) | DL (portefeuille), CR | idem |
| `crm.customer_assignments` | HIST | Titulaires successifs | customers, users | DL (portefeuille) | idem |
| `crm.customer_stage_history` | HIST | Évolution des stades et étapes | customers, users | SRV (consultation en ligne) | idem |
| `crm.visits` | TX | Visites | customers, users, work_sessions (fieldwork), reason_codes | DL (90 j), CR | idem |
| `crm.interactions` | TX | Interactions hors Kommo | customers, users | DL (90 j), CR | idem |
| `crm.sales_targets` | TX | Objectifs | users, teams, sites, products | DL (les siens) | idem |

### 2.6 `fieldwork`

| Table | Cat. | Responsabilité | Références | Hors ligne | Détail |
|---|---|---|---|---|---|
| `fieldwork.geo_checkins` | TX (journal) | Tentatives de pointage | users, devices, zones, work_sessions | CR | [dict](dictionnaire/04-crm-fieldwork.md) |
| `fieldwork.work_sessions` | TX | Sessions de travail | users, devices, zones, approval_requests | DL (la session ouverte), CR | idem |

### 2.7 `sales`

| Table | Cat. | Responsabilité | Références | Hors ligne | Détail |
|---|---|---|---|---|---|
| `sales.sales_orders` | TX | Commandes clients | customers, users, sites, locations, sales_channels | DL (ouvertes du périmètre), CR | [dict](dictionnaire/05-sales.md) |
| `sales.sales_order_lines` | TX | Lignes de commande | orders, products, units, price_rules | DL, CR | idem |
| `sales.sales` | TX | Ventes | customers, orders, users, sites, locations, zones, work_sessions, cash_sessions (finance) | DL (7 j), CR | idem |
| `sales.sale_lines` | TX | Lignes de vente | sales, products, stock_lots (inventory), price_rules, reason_codes, stock_allocations | DL (7 j), CR | idem |
| `sales.customer_payments` | TX | Encaissements clients | customers, payment_methods (finance), cash_accounts (finance), users | DL (7 j), CR | idem |
| `sales.payment_allocations` | LEDGER | Affectations d'encaissements (vente ou commande) | customer_payments, sales, sales_orders | DL, CR | idem |
| `sales.v_receivables` (vue) | PROJ | Créances par vente et par client | sales, payment_allocations | DL (encours du périmètre, sous forme matérialisée) | idem |

### 2.8 `inventory`

| Table | Cat. | Responsabilité | Références | Hors ligne | Détail |
|---|---|---|---|---|---|
| `inventory.stock_lots` | MASTER | Lots de traçabilité | products, supplier_id (réf. sans FK) ; origine polymorphe | DL (lots en solde du périmètre) | [dict](dictionnaire/06-inventory.md) |
| `inventory.stock_moves` | LEDGER | Registre des mouvements | products, locations ×2, stock_lots, reason_codes, stock_allocations, stock_moves (inverse) ; document source polymorphe | SRV (l'appareil ne télécharge que des soldes) | idem |
| `inventory.stock_balances` | PROJ | Soldes par emplacement × produit × lot | locations, products, stock_lots | DL (périmètre) | idem |
| `inventory.stock_balance_snapshots` | PROJ | Instantanés quotidiens optionnels | idem | SRV | idem |
| `inventory.stock_transfers` | TX | Transferts | locations ×2, users, sales_order_id (réf. sans FK) | DL (ouverts du périmètre), CR | idem |
| `inventory.stock_transfer_lines` | TX | Lignes de transfert | transfers, products, stock_lots, reason_codes | DL, CR | idem |
| `inventory.stock_allocations` | TX | Quotas et réservations | locations, products, stock_lots, users, devices, sales_order_line_id (réf. sans FK) | DL (les siennes) | idem |
| `inventory.stock_allocation_entries` | LEDGER | Registre des quotas | stock_allocations | SRV (le reste est recalculé et téléchargé) | idem |
| `inventory.loss_declarations` | TX | Pertes, y compris mortalité | locations, products, stock_lots, production_lot_id (réf. sans FK), reason_codes, approval_requests | DL (30 j), CR | idem |
| `inventory.consumptions` | TX | Consommations d'intrants | locations, products, stock_lots ; objet de coût polymorphe | DL (30 j), CR | idem |
| `inventory.inventory_counts` | TX | Inventaires | locations, users, approval_requests | DL (ouverts), CR | idem |
| `inventory.inventory_count_lines` | TX | Lignes d'inventaire | counts, products, stock_lots, reason_codes | DL, CR | idem |
| `inventory.stock_thresholds` | CONF | Seuils de réapprovisionnement | locations, products | DL (périmètre) | idem |
| `inventory.product_valuations` | PROJ | CMUP courant par produit | products | SRV | idem |
| `inventory.cost_entries` | LEDGER | Registre de coûts par objet de coût | objet polymorphe, stock_moves | SRV | idem |

### 2.9 `production`

| Table | Cat. | Responsabilité | Références | Hors ligne | Détail |
|---|---|---|---|---|---|
| `production.production_lots` | MASTER/TX | Lots de production | sites, locations, products, stock_lots (inventory), suppliers (procurement) | DL (actifs du site), CR | [dict](dictionnaire/07-production.md) |
| `production.lot_entries` | TX | Entrées de lot | production_lots, locations, suppliers | DL (30 j), CR | idem |
| `production.lot_weighings` | TX | Pesées | production_lots | DL (30 j), CR | idem |
| `production.lot_observations` | TX | Observations | production_lots | DL (30 j), CR | idem |
| `production.egg_collections` | TX | Collectes d'œufs | production_lots, locations | DL (30 j), CR | idem |
| `production.incubation_batches` | TX | Lots d'incubation | locations ×2, stock_lots | DL (en cours), CR | idem |
| `production.incubation_events` | TX | Étapes d'incubation | incubation_batches | DL, CR | idem |

### 2.10 `procurement`

| Table | Cat. | Responsabilité | Références | Hors ligne | Détail |
|---|---|---|---|---|---|
| `procurement.suppliers` | MASTER | Fournisseurs | — | DL (actifs, liste courte) | [dict](dictionnaire/08-procurement.md) |
| `procurement.purchase_requests` | TX | Demandes d'achat | users, sites, approval_requests | DL (les siennes), CR | idem |
| `procurement.purchase_request_lines` | TX | Lignes de DA | requests, products | DL, CR | idem |
| `procurement.purchase_orders` | TX | Bons de commande | suppliers, sites, locations, approval_requests | DL (envoyés, livrables sur le site) | idem |
| `procurement.purchase_order_lines` | TX | Lignes de BC | orders, products, request_lines | DL | idem |
| `procurement.goods_receipts` | TX | Réceptions | orders, suppliers, locations, users, approval_requests | DL (30 j), CR | idem |
| `procurement.goods_receipt_lines` | TX | Lignes de réception | receipts, order_lines, products, reason_codes, stock_lots | DL, CR | idem |

### 2.11 `finance`

| Table | Cat. | Responsabilité | Références | Hors ligne | Détail |
|---|---|---|---|---|---|
| `finance.payment_methods` | REF | Moyens de paiement | — | DL | [dict](dictionnaire/09-finance.md) |
| `finance.cash_accounts` | MASTER | Comptes de trésorerie | sites, users | DL (les siens) | idem |
| `finance.cash_sessions` | TX | Sessions de caisse | cash_accounts, users, approval_requests | DL (ouverte), CR | idem |
| `finance.cash_movements` | LEDGER | Registre de trésorerie | cash_accounts, cash_sessions ; document source polymorphe | SRV (solde téléchargé) | idem |
| `finance.cash_transfers` | TX | Remises de fonds | cash_accounts ×2, users | DL (en cours), CR | idem |
| `finance.expense_categories` | REF | Catégories de dépenses | — | DL | idem |
| `finance.expenses` | TX | Dépenses | categories, cash_accounts, suppliers (procurement) ; objet de coût polymorphe | DL (30 j), CR | idem |
| `finance.supplier_invoices` | TX | Factures fournisseurs | suppliers, purchase_orders (procurement) | SRV | idem |
| `finance.supplier_invoice_lines` | TX | Lignes de facture | invoices, purchase_order_lines, goods_receipt_lines, products | SRV | idem |
| `finance.supplier_payments` | TX | Paiements fournisseurs | suppliers, cash_accounts, payment_methods, approval_requests | SRV | idem |
| `finance.supplier_payment_allocations` | LEDGER | Affectations aux factures | payments, invoices | SRV | idem |
| `finance.v_payables` (vue) | PROJ | Dettes fournisseurs | invoices, allocations | SRV | idem |

### 2.12 `approvals`, `attachments`, `communication`

| Table | Cat. | Responsabilité | Références | Hors ligne | Détail |
|---|---|---|---|---|---|
| `approvals.control_policies` | CONF | Politiques de contrôle versionnées | reason_codes, products | DL (politiques actives) | [dict](dictionnaire/10-approvals-attachments-communication.md) |
| `approvals.approval_requests` | TX | Demandes de validation | users ; sujet polymorphe | DL (celles de l'utilisateur, en lecture) | idem |
| `attachments.attachments` | TX | Pièces justificatives | users, devices ; propriétaire polymorphe | CR (fichier local jusqu'à l'upload) | idem |
| `communication.alert_rules` | CONF | Règles d'alerte | — | SRV | idem |
| `communication.alerts` | TX | Alertes | alert_rules ; sujet polymorphe | DL (50 dernières ouvertes) | idem |
| `communication.notifications` | TECH | Notifications par utilisateur | users, alerts, internal_notes | DL | idem |
| `communication.push_subscriptions` | TECH | Abonnements Web Push | users, devices | SRV | idem |
| `communication.internal_notes` | TX | Notes de direction | users | DL (non expirées, ciblées) | idem |
| `communication.note_audiences` | LINK | Audience d'une note | notes ; cible polymorphe | SRV | idem |
| `communication.note_acknowledgements` | TX | Lectures et accusés | notes, users | CR | idem |

### 2.13 `audit`, `sync`, `integrations`, `platform`, `analytics`

| Table | Cat. | Responsabilité | Références | Hors ligne | Détail |
|---|---|---|---|---|---|
| `audit.audit_log` | AUD | Journal d'audit chaîné | users, devices ; entité polymorphe | SRV | [dict](dictionnaire/11-audit-sync-integrations-platform.md) |
| `sync.command_inbox` | SYNC | Commandes reçues et résultats | devices, users | SRV | idem |
| `sync.sync_conflicts` | SYNC | Conflits | command_inbox, users | DL (ceux de l'utilisateur, en lecture) | idem |
| `sync.change_feed` | SYNC | Flux de changements par périmètre | entité polymorphe | SRV (servi via `/sync/pull`) | idem |
| `sync.device_sync_state` | SYNC | Curseurs et état par appareil | devices | SRV | idem |
| `integrations.external_links` | INTEG | Correspondances d'identifiants | entité polymorphe | DL (liens Kommo des comptes du portefeuille) | idem |
| `integrations.inbox_messages` | INTEG | Webhooks reçus | — | SRV | idem |
| `integrations.outbox_messages` | INTEG | Appels sortants | — | SRV | idem |
| `integrations.integration_settings` | CONF | Paramètres Kommo | — | SRV | idem |
| `platform.domain_events` | PLAT | Événements métier (outbox transactionnelle) | — | SRV | idem |
| `platform.event_consumer_offsets` | PLAT | Position de chaque consommateur | — | SRV | idem |
| `platform.document_sequences` | PLAT | Compteurs de numérotation | sites | SRV | idem |
| `platform.jobs` | PLAT | File de tâches maison (P0-08) | — | SRV | idem |
| `analytics.saved_views` | TX | Vues sauvegardées | users | SRV | [dict](dictionnaire/12-analytics.md) |
| `analytics.export_jobs` | TECH | Exports | users, attachments | SRV | idem |
| `analytics.kpi_snapshots` | PROJ | Instantanés d'indicateurs personnels | users | DL (les siens) | idem |

Total : **109 objets** : 107 tables et 2 vues (`sales.v_receivables`, `finance.v_payables`). Les jeux de faits analytiques (`analytics.f_*`) sont des vues de lecture, décrites dans le dictionnaire analytics. La table `organization.zone_ancestors` (fermeture transitive) a été ajoutée lors du recadrage base de données (ADR-023), en remplacement de la colonne `path` + index GIN de la version PostgreSQL. `platform.jobs` (file de tâches maison) a été ajoutée en P0-08, non prévue au décompte initial (ADR-011/ADR-023 ne documentaient que le mécanisme, pas le schéma).

## 3. Références inter-schémas autorisées

Une clé étrangère inter-schéma n'est permise que dans le sens du graphe de dépendances ([`../05-architecture/03-graphe-dependances.md`](../05-architecture/03-graphe-dependances.md)) :

**Références universelles** : `identity.users` et `identity.devices` peuvent être référencées par clé étrangère depuis **tous** les schémas (`created_by`, détenteurs, appareils). Ce sont des tables de référence d'identité, sans dépendance de code. Le module `identity` (rôles, affectations, droits) se situe lui-même **au-dessus** d'`organization`, car ses affectations référencent sites, zones et équipes.

| De (schéma) | Vers (schémas lus) |
|---|---|
| `organization` | (références universelles seulement) |
| `identity` | `organization` |
| `catalog` | — (et `identity` pour `created_by`) |
| `crm` | `identity`, `organization`, `catalog`, `fieldwork` |
| `fieldwork` | `identity`, `organization`, `approvals` |
| `pricing` | `organization`, `catalog` |
| `inventory` | `identity`, `organization`, `catalog`, `approvals` |
| `production` | `inventory`, `organization`, `catalog`, `procurement` (fournisseurs), `approvals` |
| `procurement` | `inventory`, `organization`, `catalog`, `approvals` |
| `finance` | `organization`, `identity`, `catalog`, `procurement`, `inventory` (appel : imputation de coût d'une dépense), `approvals` |
| `sales` | `crm`, `pricing`, `inventory`, `finance`, `organization`, `catalog`, `fieldwork`, `approvals` |
| `approvals`, `attachments`, `communication`, `audit`, `sync`, `platform` | `identity`, `organization` |
| `integrations` | `crm`, `identity` |
| `analytics` | tous (lecture seule, via des vues) |

Pour éviter tout cycle, les références d'`inventory` vers des modules qui en dépendent (`procurement.suppliers` pour un lot fournisseur, `sales.sales_order_lines` pour une réservation, `sales.sales_orders` pour un transfert préparé pour une commande, `production.production_lots` pour une perte de mortalité) sont des colonnes **sans contrainte de clé étrangère**, validées par l'API du module appelant. Le dictionnaire le signale par la mention « réf. sans FK ».

## 4. Références polymorphes

| Table | Colonnes | Cibles possibles | Contrôle |
|---|---|---|---|
| `inventory.stock_moves` | `source_doc_type`, `source_doc_id`, `source_line_id` | `SALE`, `TRANSFER`, `LOSS`, `CONSUMPTION`, `INVENTORY_COUNT`, `GOODS_RECEIPT`, `EGG_COLLECTION`, `INCUBATION_EVENT`, `LOT_ENTRY` | API d'`inventory` appelée par le module propriétaire du document ; job de réconciliation |
| `inventory.consumptions`, `inventory.cost_entries`, `finance.expenses` | `cost_object_type`, `cost_object_id` | `PRODUCTION_LOT`, `INCUBATION_BATCH`, `SITE` | idem |
| `inventory.stock_lots` | `origin_type`, `origin_id` | `PRODUCTION_LOT`, `INCUBATION_BATCH`, `SUPPLIER_LOT`, `COLLECTION` | idem |
| `finance.cash_movements` | `source_doc_type`, `source_doc_id` | `CUSTOMER_PAYMENT`, `SUPPLIER_PAYMENT`, `EXPENSE`, `CASH_TRANSFER`, `CASH_SESSION`, `SALE_REFUND` | idem |
| `approvals.approval_requests` | `subject_type`, `subject_id` | Tout document soumis à validation | idem |
| `attachments.attachments` | `owner_type`, `owner_id` | Tout document | idem |
| `communication.alerts` | `subject_type`, `subject_id` | Toute entité | idem |
| `audit.audit_log` | `entity_type`, `entity_id` | Toute entité | idem |
| `sync.change_feed` | `entity_type`, `entity_id` | Toute entité synchronisée | idem |
| `integrations.external_links` | `entity_type`, `entity_id` | `CUSTOMER`, `SALES_ORDER`, `USER` | idem |

## 5. Politiques de suppression par table

Voir [`03-historisation-suppression.md`](03-historisation-suppression.md) (réponse détaillée aux PM §7 et §8).
