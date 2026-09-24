# D11 — Analytics et tableaux de bord (ANA)

> Module de code : `analytics` (lecture seule sur les données des autres modules, via des vues et projections dédiées).
> Principe : **quelques jeux de faits bien modélisés plutôt que cent rapports figés** (PM §19).

---

## 1. Objectif

Donner à chaque rôle une vue de son activité, et à la direction une **tour de contrôle** lisible en quelques dizaines de secondes (CM §53). Permettre une analyse flexible de type tableau croisé dynamique : filtrer, trier, grouper, choisir les colonnes, agréger, exporter, sauvegarder la vue (CM §35). Tout indicateur est **calculé** à partir des opérations (CM §9).

## 2. Acteurs

Tous les rôles, chacun dans son périmètre. `DIRECTION` (vue globale), `FINANCE` (mesures financières), `ADMIN` (supervision technique).

## 3. Principales entités

| Entité | Support | Rôle |
|---|---|---|
| Jeux de faits (datasets) | Vues SQL ou projections dans le schéma `analytics` (voir [`../../03-data/dictionnaire/15-analytics.md`](../../03-data/dictionnaire/15-analytics.md)) | Couche sémantique unique |
| Vue sauvegardée | `analytics.saved_views` | Définition d'une analyse (filtres, colonnes, groupements, agrégats, tri) |
| Export | `analytics.export_jobs` | Export asynchrone audité |
| Instantané d'indicateurs | `analytics.kpi_snapshots` | Indicateurs personnels précalculés, téléchargés pour la consultation hors ligne |

## 4. Cas d'usage

| ID | Cas d'usage | Mécanisme | Acteur | Hors ligne |
|---|---|---|---|---|
| UC-ANA-01 | Tour de contrôle Direction | ECR-ANA-01 | DIRECTION | Partiel (dernier instantané) |
| UC-ANA-02 | Tableaux de bord par rôle | ECR-ANA-02 à 05, ECR-CRM-05, ECR-DIS-04 | Selon rôle | Partiel |
| UC-ANA-03 | Explorer un jeu de faits (filtrer, trier, grouper, colonnes, agréger) | `POST /api/v1/analytics/query` | Selon permissions | Non |
| UC-ANA-04 | Sauvegarder et partager une vue | `analytics.view.save`, `analytics.view.share` | Utilisateurs autorisés | Non |
| UC-ANA-05 | Exporter (CSV, XLSX) | `analytics.export.request` | Titulaires de `analytics.export` | Non |
| UC-ANA-06 | Remonter d'un indicateur jusqu'aux opérations sources | liens vers les documents, le registre de stock et le registre de trésorerie | Responsables | Non |

## 5. Entrées

Toutes les tables transactionnelles et les registres (en lecture) ; horodatage de synchronisation des appareils (fraîcheur).

## 6. Sorties

Indicateurs, tableaux, graphiques, exports, vues sauvegardées, instantanés personnels.

## 7. Règles métier

| ID | Règle | Statut |
|---|---|---|
| BR-ANA-001 | Aucun indicateur n'est saisi. Tous sont calculés à partir des opérations enregistrées. | C (CM §9) |
| BR-ANA-002 | La date d'analyse d'une opération est son `occurred_at`, ramenée au **jour métier** en fuseau `Africa/Douala`. Périodes proposées : aujourd'hui, hier, cette semaine (lundi à dimanche), ce mois, cette année, plage personnalisée. | C (CM §9, §38) |
| BR-ANA-003 | Annulations : les vues « par période d'activité » comptent la contre-écriture à la date d'annulation (BR-FIN-042). Une vue « net par date de vente » est proposée explicitement, avec un libellé distinct. | D |
| BR-ANA-004 | Le RBAC s'applique aux analyses **au niveau des lignes** (portée : OWN, TEAM, SITE, ZONE, ALL) et **au niveau des mesures** : coût, marge et valeur de stock exigent `inventory.valuation.read`. | C (CM §48) |
| BR-ANA-005 | Chaque tableau de bord affiche la **fraîcheur** : heure du dernier calcul, et nombre d'appareils du périmètre dont la dernière synchronisation date de plus de 2 h (paramètre). | C (CM §36) / D |
| BR-ANA-006 | L'explorateur n'accepte que des jeux, dimensions, mesures et filtres **déclarés** dans la couche sémantique ; aucune requête libre. Limites : 10 000 lignes affichées, 100 000 lignes exportées, 15 s d'exécution. | D (sécurité, performance) |
| BR-ANA-007 | Une vue sauvegardée partagée ne donne aucun droit supplémentaire : chaque lecteur la voit restreinte à son propre périmètre. | D |
| BR-ANA-008 | Tout export est audité : utilisateur, jeu de faits, filtres, colonnes, nombre de lignes, format. | C (CM §40) / AV-067 |
| BR-ANA-009 | Tableaux de bord, explorateur et instantanés utilisent **les mêmes définitions** d'indicateurs (§7.1). Deux écrans ne peuvent pas afficher deux valeurs différentes pour un même indicateur, sur une même période et un même périmètre. | C (CM §60) |
| BR-ANA-010 | Tout indicateur de la tour de contrôle mène en au plus deux niveaux aux opérations sources. | C (CM §53, §60) |

### 7.1 Dictionnaire des indicateurs

Notation : P = période, S = périmètre. Toutes les sommes portent sur des documents non annulés, sauf mention.

| Code | Indicateur | Définition / formule | Jeu source | Statut |
|---|---|---|---|---|
| KPI-COM-01 | Prospects créés | Nombre de comptes créés dans P (quel que soit leur stade actuel), par acquéreur | `f_prospecting` | C (CM §9) |
| KPI-COM-02 | Prospects visités | Nombre de comptes distincts au stade `PROSPECT` au moment de leur visite dans P | `f_prospecting` | C (CM §7) |
| KPI-COM-03 | Visites | Nombre de visites non annulées dans P | `f_prospecting` | C (CM §9) |
| KPI-COM-04 | Contacts collectés | Prospects créés dans P avec un téléphone renseigné | `f_prospecting` | C (CM §9) / D |
| KPI-COM-05 | Nouveaux clients | Conversions (`converted_at` dans P), par titulaire à la conversion | `f_prospecting` | C (CM §9) |
| KPI-COM-06 | Commandes | Commandes confirmées dans P | `f_orders` | C (CM §9) |
| KPI-COM-07 | Ventes | Nombre de ventes dans P | `f_sales_line` | C (CM §9) |
| KPI-COM-08 | CA | Σ montants des ventes dans P − Σ montants des ventes annulées dans P (BR-FIN-042) | `f_sales_line` | C (CM §9) |
| KPI-COM-09 | Quantité vendue | Σ quantités (unité de base) nettes | `f_sales_line` | C (CM §9) |
| KPI-COM-10 | Panier moyen | KPI-COM-08 ÷ KPI-COM-07 | dérivé | C (CM §9) |
| KPI-COM-11 | Taux de conversion (cohorte) | Prospects créés dans P et convertis à ce jour ÷ prospects créés dans P | `f_prospecting` | C (CM §9) / D (formule) |
| KPI-COM-12 | Taux visite → commande | Visites de résultat `COMMANDE_PRISE` ÷ visites | `f_prospecting` | D |
| KPI-COM-13 | Clients actifs | Clients avec au moins une vente dans les N derniers jours à la fin de P (N = 30) | `f_sales_line` | C (CM §9) / AV-013 |
| KPI-COM-14 | Clients inactifs | Clients sans vente depuis N jours à la fin de P | `f_sales_line` | C (CM §9) / AV-013 |
| KPI-COM-15 | Taux de réachat | Clients ayant ≥ 2 ventes dans P ÷ clients ayant ≥ 1 vente dans P | `f_sales_line` | C (CM §9) / D |
| KPI-COM-16 | Atteinte d'objectif | Valeur réalisée de la métrique ÷ valeur cible | `crm.sales_targets` + faits | C (CM §34.3) |
| KPI-COM-17 | Jours de présence | Jours distincts avec une session de travail acceptée | `f_attendance` | C (CM §10) |
| KPI-COM-18 | CA du portefeuille acquis | CA des ventes aux clients dont l'acquéreur est l'utilisateur | `f_sales_line` | C (CM §7) |
| KPI-STK-01 | Stock disponible | BR-STK-011, à l'instant ou à une date | `f_stock_balance` | C (CM §2) |
| KPI-STK-02 | Valeur du stock | Σ solde × coût unitaire courant | `f_stock_balance` | C (CM §31) |
| KPI-STK-03 | Pertes | Σ quantités et Σ valeurs vers `V_LOSS`, par catégorie, motif, lot, emplacement | `f_losses` | C (CM §35) |
| KPI-STK-04 | Écarts d'inventaire | Σ écarts nets comptabilisés, en quantité et en valeur | `f_stock_moves` | C (CM §25) |
| KPI-STK-05 | Couverture | Disponible ÷ ventes moyennes journalières des 14 derniers jours | dérivé | D |
| KPI-STK-06 | Ruptures | Nombre de couples emplacement × produit à disponible ≤ 0 alors qu'un seuil existe | `f_stock_balance` | C (CM §54) |
| KPI-DIS-01..07 | Envoyé, reçu, vendu, perdu, restant, encaissé, à réapprovisionner par PDV | BR-DIS-010 | `f_stock_moves`, `f_sales_line`, `f_payments` | C (CM §12) |
| KPI-PRD-01 | Effectif | BR-PRD-003 (en élevage / non vendu) | `f_stock_balance` | C (CM §2) |
| KPI-PRD-02 | Mortalité | Σ quantités des pertes `MORTALITE` reconnues ou en attente | `f_losses` | C (CM §16) |
| KPI-PRD-03 | Taux de mortalité cumulé | Mortalité cumulée ÷ (effectif initial + entrées) | dérivé | D / AV-049 |
| KPI-PRD-04 | Consommation d'aliment | Σ consommations d'intrants de famille aliment, imputées au lot | `f_stock_moves` | C (CM §15) |
| KPI-PRD-05 | Poids moyen | Dernière pesée du lot | `production.lot_weighings` | C (CM §15) |
| KPI-PRD-06 | Œufs collectés, commercialisables, à couver, cassés, non conformes | Σ par lot et par jour | `f_production_daily` | C (CM §17) |
| KPI-PRD-07 | Taux d'œufs commercialisables | Commercialisables ÷ collectés | dérivé | D |
| KPI-PRD-08 | Taux d'éclosion | BR-INC-007 | `production.incubation_batches` | C (CM §18) |
| KPI-PRD-09 | Coût par tête | BR-PRD-012 | `f_costs` | C (CM §33) |
| KPI-PRD-10 | Marge du lot | BR-PRD-014 | `f_costs`, `f_sales_line` | C (CM §33) |
| KPI-FIN-01 | Encaissé | Σ encaissements confirmés dans P − annulations dans P | `f_payments` | C (CM §31) |
| KPI-FIN-02 | Créances | Σ soldes dus à la fin de P, par âge (0-30, 31-60, 61-90, > 90 jours) | `sales.v_receivables` | C (CM §31) |
| KPI-FIN-03 | Créances en retard | Créances dont l'échéance est dépassée | `sales.v_receivables` | C (CM §54) |
| KPI-FIN-04 | Dépenses | Σ dépenses approuvées ou payées dans P, par catégorie et objet de coût | `f_expenses` | C (CM §31) |
| KPI-FIN-05 | Dettes fournisseurs | BR-FIN-032 | `finance.v_payables` | C (CM §31) |
| KPI-FIN-06 | Trésorerie | Solde par compte de trésorerie | `f_cash` | C (CM §31) |
| KPI-FIN-07 | Coût des ventes, marge brute | BR-FIN-043 | `f_sales_line` | C (CM §31) |
| KPI-FIN-08 | Valeur des pertes | BR-FIN-044 | `f_losses` | C (CM §32) |
| KPI-APP-01 | Taux de service fournisseur | Σ acceptées ÷ Σ commandées (BC clôturés dans P) | `f_purchases` | C (CM §26) / D |
| KPI-APP-02 | Taux de rejet | Σ rejetées ÷ Σ livrées | `f_purchases` | C (CM §28) / D |
| KPI-OPS-01 | Fraîcheur de synchronisation | Délai depuis la dernière synchronisation réussie de chaque appareil | `sync.device_sync_state` | C (CM §36) |
| KPI-OPS-02 | Opérations en attente et conflits ouverts | Comptage | `sync.*` | C (PM §29) |

### 7.2 Contenu de la tour de contrôle (ECR-ANA-01)

| Bloc | Indicateurs | Alerte associée |
|---|---|---|
| PRODUCTION | Effectifs par type de lot, mortalité du jour et de 7 jours, œufs du jour, incubations en cours | `HIGH_MORTALITY`, `DAILY_ENTRY_MISSING` |
| STOCK | Disponible des produits clés par zone (dont « poulets vendables à Douala »), valeur du stock, ruptures | `STOCK_OUT`, `STOCK_NEGATIVE` |
| DISTRIBUTION | Tableau des PDV : vendu, restant, perdu, encaissé, fraîcheur | `POS_REPLENISH` |
| VENTES | CA et nombre de ventes du jour et de la semaine vs période précédente, par canal, top commerciaux | — |
| FINANCES | Encaissé du jour, créances et retards, dépenses, trésorerie | `OVERDUE_RECEIVABLE`, `CASH_VARIANCE` |
| ÉQUIPES | Commerciaux en service, sans activité, visites du jour | `INACTIVE_COMMERCIAL` |
| ALERTES | Alertes ouvertes par gravité ; validations en attente | toutes |

## 8. Validations

| Contrôle | Erreur |
|---|---|
| Jeu, dimension, mesure et filtre déclarés | `ANALYTICS_FIELD_UNKNOWN` |
| Mesure financière sans la permission requise | `FORBIDDEN_MEASURE` |
| Période ≤ 3 ans pour une requête détaillée | `PERIOD_TOO_LONG` |
| Dépassement des limites (BR-ANA-006) | `QUERY_LIMIT_EXCEEDED` |

## 9. Dépendances

Lecture de tous les modules, via des vues de lecture publiées par chaque module propriétaire. `analytics` n'écrit dans aucune table d'un autre module (ADR-011).

## 10. Événements produits

`AnalyticsExportRequested`, `AnalyticsExportCompleted` (audit), `SavedViewShared`.

## 11. Événements consommés

Événements métier des autres modules, pour rafraîchir les projections et instantanés (voir la stratégie analytique dans [`../../05-architecture/01-architecture-logicielle.md`](../../05-architecture/01-architecture-logicielle.md)).

## 12. Fonctionnement hors ligne

- Les tableaux de bord personnels (commercial, vendeur, ferme) affichent : les **indicateurs locaux** calculés sur les opérations de l'appareil (ventes et visites du jour, stock local) ; le **dernier instantané serveur** (`kpi_snapshots`) avec sa date.
- La tour de contrôle et l'explorateur sont en ligne ; le dernier affichage reste consultable en cache avec la mention de sa date.

## 13. Permissions

`analytics.dashboard.direction`, `analytics.dashboard.commercial`, `analytics.dashboard.distribution`, `analytics.dashboard.stock`, `analytics.dashboard.production`, `analytics.dashboard.finance`, `analytics.explore`, `analytics.view.share`, `analytics.export`, plus les permissions de lecture des domaines (portée des lignes) et `inventory.valuation.read` (mesures).

## 14. Exceptions

| Cas | Traitement |
|---|---|
| Données incomplètes (appareils non synchronisés) | Indicateur de fraîcheur (BR-ANA-005) ; aucune extrapolation. |
| Chiffre contesté | Remontée jusqu'aux opérations sources (BR-ANA-010), registre de stock (ECR-STK-07), audit. |
| Requête trop lourde | Refus explicite avec suggestion d'affiner ; exports lourds en asynchrone. |
