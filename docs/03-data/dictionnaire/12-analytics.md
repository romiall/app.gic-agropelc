# Dictionnaire — schéma `analytics`

> Le module `analytics` **lit** les autres modules via des vues ; il n'écrit que ses propres tables (D11 ; BR-ANA-006 à 009).

## analytics.saved_views

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `owner_user_id` | uuid → identity.users | Non | — | |
| `name` | label | Non | — | |
| `dataset` | code | Non | — | Jeu de faits (`f_sales_line`…) |
| `definition` | jsonb | Non | — | Filtres, colonnes, groupements, agrégats, tri (schéma versionné de la couche sémantique) |
| `shared_with_roles` | text[] | Non | `{}` | Partage (BR-ANA-007) |
| `is_default_for_role` | code | Oui | — | Vue par défaut d'un rôle |
| [STD-AUDIT] | | | | |

- **PK** `id`. **Suppr.** Suppression physique autorisée par le propriétaire (objet de confort, non métier), auditée.

## analytics.export_jobs

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| [STD-ID] | | | | |
| `requested_by` | uuid → identity.users | Non | — | |
| `dataset` | code | Non | — | |
| `definition` | jsonb | Non | — | Requête exportée |
| `format` | enum(`CSV`,`XLSX`) | Non | — | AV-067 |
| `row_count` | int | Oui | — | |
| `status` | enum(`QUEUED`,`RUNNING`,`DONE`,`FAILED`,`EXPIRED`) | Non | `QUEUED` | |
| `storage_key` | varchar(200) | Oui | — | Fichier, lien signé valable 24 h |
| `created_at`, `finished_at` | ts | | | |

- **PK** `id`. **Suppr.** Fichier purgé après 30 jours ; ligne conservée (audit, BR-ANA-008).

## analytics.kpi_snapshots

| Colonne | Type logique | Nullable | Défaut | Rôle |
|---|---|---:|---|---|
| `user_id` | uuid → identity.users | Non | — | |
| `scope_key` | varchar(100) | Non | — | Ex. `OWN`, `TEAM:<id>`, `SITE:<id>` |
| `period_key` | varchar(20) | Non | — | `TODAY`, `WEEK`, `MONTH` |
| `payload` | jsonb | Non | — | Valeurs des indicateurs |
| `computed_at` | ts | Non | — | Affiché comme « à jour au » |

- **PK** `(user_id, scope_key, period_key)`. **Suppr.** Écrasé à chaque calcul. **Offline** DL.

## Jeux de faits (vues de lecture)

| Vue | Grain | Dimensions | Mesures | Sources |
|---|---|---|---|---|
| `analytics.f_sales_line` | Ligne de vente × événement (vente +1, annulation −1, daté de son `occurred_at`) | date métier, produit, catégorie, site, PDV, zone (et ancêtres), canal, client, catégorie de client, commercial, vendeur, lot, type de vente, statut de paiement | quantité, CA, remise, coût (`inventory.valuation.read`), marge (`inventory.valuation.read`), nombre de ventes | `sales.sales`, `sales.sale_lines`, `inventory.stock_moves` |
| `analytics.f_orders` | Ligne de commande | date, client, commercial, canal, produit, statut | quantité commandée, livrée, montant | `sales.sales_orders`, lignes |
| `analytics.f_payments` | Encaissement × événement | date, moyen, compte, site, utilisateur, client | montant | `sales.customer_payments` |
| `analytics.f_stock_moves` | Mouvement | date, produit, source, destination, type, motif, lot, site, zone | quantité, valeur | `inventory.stock_moves` |
| `analytics.f_stock_balance` | Solde courant | emplacement, produit, lot, famille calculée (stratégie stock §4), site, zone | solde, réservé, alloué, disponible, valeur | `inventory.stock_balances` |
| `analytics.f_losses` | Déclaration de perte | date, catégorie, motif, produit, lot, lot de production, emplacement, déclarant, statut | quantité, valeur | `inventory.loss_declarations` |
| `analytics.f_prospecting` | Événement commercial (création de compte, visite, conversion) | date, utilisateur, zone, source, stade, résultat | nombres | `crm.customers`, `crm.visits`, `crm.customer_stage_history` |
| `analytics.f_attendance` | Session de travail | date, utilisateur, zone, statut, dérogation | nombre, durée | `fieldwork.work_sessions` |
| `analytics.f_production_daily` | Lot × jour | lot, type, site, bâtiment | mortalité, consommations, œufs par catégorie, poids moyen | production, inventory |
| `analytics.f_costs` | Écriture de coût | objet, type de coût, date | montant | `inventory.cost_entries` |
| `analytics.f_expenses` | Dépense | date, catégorie, objet, site, statut | montant | `finance.expenses` |
| `analytics.f_cash` | Mouvement de trésorerie | date, compte, type, site | entrées, sorties | `finance.cash_movements` |
| `analytics.f_purchases` | Ligne de BC et de réception | fournisseur, produit, site, date | commandé, livré, rejeté, accepté, facturé, montants | procurement, finance |

Chaque vue applique le filtre de périmètre RBAC de l'utilisateur à la requête (BR-ANA-004) par une fonction de sécurité au niveau des lignes (voir sécurité §4). Stratégie de matérialisation : [`../../05-architecture/01-architecture-logicielle.md`](../../05-architecture/01-architecture-logicielle.md) §6.
