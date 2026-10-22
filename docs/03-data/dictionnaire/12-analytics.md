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
| `catalog_version` | int | Non | — | Version du catalogue à la sauvegarde ; un champ disparu rend la vue `OUTDATED` (ADR-077 §2) |
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
| `storage_key` | varchar(200) | Oui | — | Fichier ; téléchargement authentifié du demandeur, valable 24 h (ADR-077 §5) |
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
| `scope_key` | varchar(100) | Non | — | Code du tableau (`direction`, `commercial`, `stock`, `production`, `finance`, `distribution`) : le périmètre est celui, exact, de l'utilisateur (ADR-076 §5) |
| `period_key` | varchar(20) | Non | — | `TODAY`, `WEEK`, `MONTH` |
| `payload` | json | Non | — | Valeurs des indicateurs |
| `computed_at` | ts | Non | — | Affiché comme « à jour au » |

- **PK** `(user_id, scope_key, period_key)`. **IX** `(computed_at)` (reprise de la tâche par ancienneté). **Suppr.** Écrasé à chaque calcul ; supprimé (avec publication d'un `DELETE` au flux) à la perte du droit du tableau ou de l'appareil actif. **Offline** DL (jeu `kpi`, portée `USER`).

## analytics.query_log

**Responsabilité** : journal technique des requêtes de l'explorateur ([ADR-074](../../decisions/ADR-074-couche-semantique-et-explorateur.md) §8) ; l'export a, lui, sa ligne d'audit (BR-ANA-008).

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

- **PK** `id`. **IX** `(created_at)`, `(user_id, created_at)`. **Ajout seul** (déclencheur contre les modifications). **Suppr.** `PURGE_TECHNIQUE` après 90 jours (AV-437).

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

Sous MySQL, les vues s'appellent `analytics_f_*`. Le périmètre RBAC (BR-ANA-004) est appliqué par le compilateur de l'explorateur : une clause de portée en union (site, zone, personne) construite depuis l'étendue de la permission de lecture du domaine du jeu, MySQL n'ayant pas de sécurité au niveau des lignes ([ADR-074](../../decisions/ADR-074-couche-semantique-et-explorateur.md) §4). Stratégie de matérialisation : [`../../05-architecture/01-architecture-logicielle.md`](../../05-architecture/01-architecture-logicielle.md) §6.
