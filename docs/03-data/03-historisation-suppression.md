# Historisation, versionnement et suppression

> Réponse aux PM §7 (historisation) et §8 (suppressions et annulations). Décisions : ADR-005 (prix), ADR-006 (annulation vs suppression).

---

## 1. Principe

> Aucune modification ultérieure ne réécrit silencieusement l'histoire (PM §7). Les opérations sensibles ne sont jamais supprimées physiquement (PM §8 ; CM §40, §41).

Quatre techniques, choisies selon la nature de la donnée :

| Technique | Définition | Quand l'utiliser |
|---|---|---|
| **Snapshot** (figé dans la transaction) | La transaction recopie la valeur utilisée au moment où elle a lieu | La valeur passée doit rester lisible sans recalcul : prix, libellé, attribution, coût, zone, catégorie de client |
| **Historisation par périodes** | Lignes avec `valid_from` / `valid_to` | Relations qui changent dans le temps et qu'on interroge « à la date t » : titulaire d'un client, rôles, équipes |
| **Versionnement** | Nouvelle version immuable ; l'ancienne est retirée avec une date de fin | Règles de gestion dont l'application passée doit être explicable : règles tarifaires, politiques de contrôle, paramètres, coût standard |
| **Référence dynamique** | Clé étrangère vers l'état courant | Données dont seul l'état courant importe ou dont le changement n'altère pas le sens passé : nom d'un site, libellé d'une zone, coordonnées d'un utilisateur (l'audit garde l'historique) |

## 2. Que faire de chaque donnée ?

| Donnée | Technique | Où | Justification |
|---|---|---|---|
| Prix appliqué d'une vente | Snapshot | `sale_lines.unit_price_xaf`, `list_unit_price_xaf`, `price_rule_id`, `price_rule_version`, `price_source` | CM §30 |
| Prix convenu d'une commande | Snapshot | `sales_order_lines.quoted_unit_price_xaf` | AV-087 |
| Règle tarifaire | Versionnement | `pricing.price_rules` | PM §9 |
| Libellé du produit sur une transaction | Snapshot | `*_lines.product_name_snapshot` | PM §7 « modification d'un produit » |
| Unité de base d'un produit | Immuable après usage | `catalog.products.base_unit_code` | INV-CAT-01 |
| Facteur de conditionnement | Snapshot (`quantity_base`) + immuable après usage | lignes, `product_units` | BR-CAT-004 |
| Coût unitaire d'un mouvement | Snapshot | `stock_moves.unit_cost_xaf` | CM §32 |
| CMUP courant | Projection (reconstructible) | `product_valuations` | ADR-015 |
| Coût standard | Versionnement | `catalog.product_standard_costs` | BR-CAT-011 |
| Titulaire d'un client | Historisation par périodes | `crm.customer_assignments` | CM §8 |
| Commercial attribué à une vente | Snapshot | `sales.sales.commercial_user_id` | BR-VEN-020 |
| Acquéreur d'un client | Immuable | `crm.customers.acquired_by_user_id` | CM §7 |
| Stade et étape d'un prospect | Historisation (journal) | `crm.customer_stage_history` | CM §7 |
| Zone d'une vente | Snapshot | `sales.sales.zone_id` | PM §7 « changement de zone » |
| Géorepère utilisé au pointage | Snapshot | `fieldwork.geo_checkins.geofence_*` | BR-ADM-013 |
| Catégorie du client à la vente | Snapshot | `sales.sales.customer_category_id_snapshot` | Tarification et analyse |
| Rôles d'un utilisateur | Historisation par périodes | `identity.user_role_assignments` | PM §7 « changement de responsable » |
| Rôles actifs au moment d'une action | Snapshot | `audit.audit_log.actor_roles` | CM §40 |
| Appartenance à une équipe | Historisation par périodes | `organization.team_memberships` | BR-ADM-014 |
| Paramètres système | Versionnement | `organization.system_settings` | BR-ADM-015 |
| Politique de contrôle appliquée | Versionnement + snapshot (`policy_id`, `policy_version`) | `approvals.*`, documents | BR-ADM-016 |
| Coordonnées client, nom de site, libellé de zone | Référence dynamique + audit avant/après | tables de référence, `audit_log` | Pas d'impact sur le sens des transactions passées |
| Permissions d'un rôle | Référence dynamique + audit | `identity.role_permissions` | Les décisions passées gardent `actor_roles` |

## 3. Politique de suppression par table

Codes : `IMMUABLE` (ni modification ni suppression, correction par écriture inverse) ; `ANNULATION` (statut + contre-écriture) ; `DESACTIVATION` (statut inactif) ; `VERSIONNEMENT` ; `PURGE_TECHNIQUE` (suppression physique après rétention, sans valeur métier) ; `LIBRE` (objet de confort).

| Table(s) | Politique | Mécanisme d'annulation / correction |
|---|---|---|
| `inventory.stock_moves`, `finance.cash_movements`, `inventory.cost_entries`, `inventory.stock_allocation_entries` | IMMUABLE | Écriture inverse référencée (`reverses_*_id`, unique) |
| `sales.payment_allocations`, `finance.supplier_payment_allocations` | IMMUABLE (sauf passage à `REVERSED`) | Désactivation datée et motivée |
| `sales.sales`, `sales.sales_orders`, `sales.customer_payments` | ANNULATION | Statut `CANCELLED` + contre-écritures (stock, trésorerie, affectations) |
| `inventory.stock_transfers`, `inventory.loss_declarations`, `inventory.consumptions`, `inventory.inventory_counts` | ANNULATION | Statut + mouvements inverses |
| `procurement.purchase_requests`, `procurement.purchase_orders`, `procurement.goods_receipts` | ANNULATION | Statut + mouvements inverses (réception) |
| `finance.expenses`, `finance.supplier_invoices`, `finance.supplier_payments`, `finance.cash_transfers`, `finance.cash_sessions` | ANNULATION | Statut + mouvements de trésorerie inverses |
| `production.*` (entrées, collectes, pesées, incubations) | ANNULATION | Statut + mouvements inverses |
| `crm.visits`, `crm.interactions` | ANNULATION | Statut `CANCELLED` |
| `fieldwork.geo_checkins`, `fieldwork.work_sessions` | IMMUABLE | — (transitions de statut seulement) |
| `approvals.approval_requests` | IMMUABLE après décision | Nouvelle opération |
| `attachments.attachments` | IMMUABLE | Remplacement (`SUPERSEDED`) ; fichier purgé après la rétention, métadonnées conservées |
| `audit.audit_log`, `platform.domain_events`, `sync.command_inbox` | IMMUABLE | — |
| `crm.customer_assignments`, `crm.customer_stage_history`, `identity.user_role_assignments`, `organization.team_memberships` | IMMUABLE (fermeture de période) | — |
| `pricing.price_rules`, `approvals.control_policies`, `organization.system_settings`, `catalog.product_standard_costs` | VERSIONNEMENT | Nouvelle version |
| `identity.users`, `identity.devices`, `crm.customers`, `procurement.suppliers`, `catalog.*`, `organization.*` (hors historiques), `finance.cash_accounts`, `finance.payment_methods`, `finance.expense_categories`, référentiels CRM | DESACTIVATION | Statut ; fusion pour les doublons de clients |
| `identity.role_permissions` | Modification autorisée, **auditée** | — |
| `sync.change_feed`, `identity.auth_sessions`, `communication.notifications`, `communication.push_subscriptions`, `integrations.inbox_messages` / `outbox_messages` (traités), fichiers d'`analytics.export_jobs` | PURGE_TECHNIQUE | Rétentions : 60 j, 90 j, 90 j, à la révocation, 180 j, 30 j |
| `analytics.saved_views` | LIBRE | Suppression par le propriétaire, auditée |
| `analytics.kpi_snapshots`, `inventory.stock_balances`, `inventory.product_valuations`, `inventory.stock_balance_snapshots` | Projection | Recalcul |

## 4. Mise en œuvre

1. **Privilèges** : le rôle de base de données de l'application n'a pas le privilège `DELETE` sur les tables `IMMUABLE`, `ANNULATION`, `DESACTIVATION` et `VERSIONNEMENT`. Il ne l'a que sur les tables `PURGE_TECHNIQUE` et `LIBRE`. Les purges sont exécutées par un rôle de maintenance distinct.
2. **Déclencheurs** : `BEFORE UPDATE` avec la liste blanche des colonnes modifiables par table (statut, colonnes d'annulation, dérivées) ; `BEFORE DELETE` qui lève une erreur sur les tables protégées.
3. **Tests** : chaque table protégée a un test d'intégration qui vérifie le refus d'un `DELETE` et d'un `UPDATE` interdit (INV-GLO-03).
4. **Données personnelles** : une demande d'effacement est traitée par **pseudonymisation** (remplacement des champs identifiants par un jeton), jamais par suppression de la transaction. La procédure est auditée et soumise à l'approbation de la Direction (AV-073).
