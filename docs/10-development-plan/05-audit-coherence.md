# Audit de cohérence du cahier des charges

> Section finale exigée par le PM §50, placée après les 39 sections du format final. Elle résulte d'un contrôle réalisé sur **l'ensemble** de `docs/` en fin de cadrage : relecture croisée et contrôles automatisés (§3).
> Chaque constat renvoie à une preuve dans les documents. Les corrections faites pendant l'audit sont déjà appliquées dans le dépôt.

---

## 1. Contrôles demandés par le PM §50

| # | Contrôle | Verdict | Preuve | Réserve |
|---|---|---|---|---|
| 1 | Chaque besoin majeur a une réponse architecturale | **Conforme** | Matrice de traçabilité : 99 exigences, 0 sans règle ni décision ([`02-matrice-tracabilite.md`](02-matrice-tracabilite.md) §16) | 9 exigences sont vérifiées par une mesure de NFR ou par une revue plutôt que par un AT |
| 2 | Chaque module possède les entités nécessaires | **Conforme** | Les 19 modules ont leurs tables ([`../03-data/02-modele-relationnel.md`](../03-data/02-modele-relationnel.md) §2 ; [`../05-architecture/02-modules.md`](../05-architecture/02-modules.md)) | — |
| 3 | Chaque entité a une responsabilité claire | **Conforme après correction** | Catalogue des tables (colonne « Responsabilité ») ; 35 fiches du dictionnaire complétées pendant l'audit (I-11) | — |
| 4 | Aucune table fondamentale n'a plusieurs sources de vérité contradictoires | **Conforme** | Un module propriétaire par table (INV-GLO-05) ; soldes, valorisations, créances et dettes sont des **projections** de registres en ajout seul ; les colonnes dénormalisées sont déclarées comme telles, avec leur source (§2.4) | Les projections exigent une réconciliation quotidienne (NFR-38, étendue pendant l'audit) |
| 5 | Le stock reste traçable | **Conforme** | Registre en partie double, emplacements virtuels, conservation (ADR-003 ; BR-STK-001 à 006 ; INV-STK-01 à 04) ; AT-022, AT-043 | — |
| 6 | Les prix sont historisés | **Conforme** | Règles immuables et versionnées, prix figés sur chaque ligne (ADR-005 ; BR-PRX-007, 008, 014 ; INV-PRX-01, 03 ; INV-VEN-05) ; AT-007 | — |
| 7 | Les ventes restent auditables | **Conforme** | Vente immuable, annulation par contre-écriture, audit dans la même transaction, chaînage (INV-VEN-02 ; BR-AUD-003, 005, 006 ; INV-AUD-01) ; AT-045 | — |
| 8 | L'offline ne permet pas facilement la double consommation de stock | **Conforme, sous réserve d'AV-025** | Garde exclusive, quotas d'appareil, réservations (ADR-004 ; BR-STK-010 à 018 ; INV-STK-10, 11) ; AT-003, AT-004, AT-018 | Le comportement au-delà de l'allocation dépend d'AV-025 (**bloquant P4**). Un fait accompli n'est jamais rejeté ; un solde négatif reste possible et visible (INV-STK-05 ; AT-049) |
| 9 | Les timestamps offline sont conservés | **Conforme** | Quatre horodatages distincts, écart d'horloge mesuré (ADR-016 ; INV-GLO-01, 02 ; BR-SYN-011, 012) ; AT-001, AT-036 | — |
| 10 | Les synchronisations sont idempotentes | **Conforme** | `command_id`, empreinte, séquence d'appareil (INV-SYN-01 à 04 ; BR-SYN-002 à 004) ; AT-002 ; harnais de synchronisation | — |
| 11 | Les rôles sont cohérents | **Conforme** | 11 rôles du CM (C-01), 117 permissions, matrice unique ([`../07-security-rbac/01-rbac.md`](../07-security-rbac/01-rbac.md)) ; contrôle croisé domaines ↔ RBAC sans écart après correction (I-08) | Rôles additionnels (opérateur de ferme, livreur, caissier) : AV-004 |
| 12 | Kommo et AGROPELC ne se disputent pas la même responsabilité | **Conforme** | Propriété par donnée, anti-boucle, idempotence (ADR-009 ; BR-KOM-001, 003, 005 ; INV-KOM-03) ; AT-044 | Capacités réelles du compte Kommo : AV-068 |
| 13 | Les anciennes données ne changent pas après un changement de paramétrage | **Conforme** | Paramètres historisés (BR-ADM-015) ; politique évaluée à `occurred_at` (BR-ADM-016) ; géorepère sans effet rétroactif (BR-ADM-013) ; libellés, prix, attribution et coûts figés (BR-CAT-007 ; BR-PRX-014 ; BR-VEN-020 ; BR-STK-052) ; unité de base immuable (INV-CAT-01) | — |
| 14 | Le MVP reste exploitable sans les fonctionnalités futures | **Conforme** | Releases R1 à R5 utilisables chacune ; extensions F-* hors MVP et sans dépendance entrante ([`../01-functional/02-perimetre.md`](../01-functional/02-perimetre.md)) ; R1 = P0 à P3, sans AV bloquant | — |

---

# AUDIT DE COHÉRENCE DU CAHIER DES CHARGES

## 2.1 Incohérences détectées

### A. Entre les deux sources (Contexte métier ↔ Prompt maître)

Douze écarts ont été identifiés et résolus selon la règle « le CM décide du quoi, le PM décide du comment » ([`../00-reference/01-compte-rendu-comprehension.md`](../00-reference/01-compte-rendu-comprehension.md) §3) :

| ID | Écart | Résolution |
|---|---|---|
| C-01 | Rôles de la matrice RBAC du PM ≠ 11 rôles du CM | 11 rôles du CM |
| C-02 | Le PM omet l'étape « livré » | Réception en livré / rejeté / accepté |
| C-03 | « Campagne » = lot de production (CM) ou période commerciale (PM) | Deux termes distincts dans le glossaire |
| C-04 | Vente avant livraison : le stock baisserait avant la sortie physique | Sortie à la remise physique (ADR-014, **AV-024**) |
| C-05 | États de vente mêlant cycle de vie et paiement | Deux dimensions (`status`, `payment_status`) |
| C-06 | PWA et Android absents du CM | Contraintes du PM, tracées comme telles |
| C-07 | MVP large vs « pas d'usine à gaz » | Tranches verticales R1 à R5 |
| C-08 | « Prioritairement » (CM) vs « empêcher » (PM) la double consommation | Blocage par défaut au-delà de l'allocation (**AV-025**) |
| C-09 | Mortalité : événement de production ou perte ? | Un seul objet : perte `MORTALITE` rattachée au lot |
| C-10 | Pas de domaine « Commandes et ventes » dans le PM | Domaine VEN créé |
| C-11 | Responsable ferme « si pertinent » (PM) | Rôle conservé ; répartition AV-005 |
| C-12 | Document unique (PM §48) vs arborescence `docs/` | Un fichier par section + index maître dans l'ordre exact |

### B. Incohérences internes détectées et corrigées pendant le cadrage

| ID | Incohérence | Correction appliquée | Documents touchés |
|---|---|---|---|
| I-01 | **Cycle de dépendances** `sales` ↔ `finance` ↔ `inventory` (encaissements dans `finance` mais créances calculées depuis `sales` ; coûts dans `finance` mais valorisation dans `inventory`) | Encaissements, affectations et créances déplacés dans `sales` ; registre de coûts dans `inventory.cost_entries` ; permissions renommées (`sales.payment.*`, `sales.receivable.read`, `inventory.valuation.read`, `inventory.cost_entry.record`) | D04, D06, D09, ERD, stratégie finance, dictionnaire, RBAC, API |
| I-02 | **Cycles de clés étrangères** (`points_of_sale` → `cash_accounts` → `sites` ; `inventory` → modules de niveau supérieur ; `document_sequences` → `sites`) | Références « sans FK » explicitement déclarées ; intégrité vérifiée par le gestionnaire de commande ; `identity.users` et `identity.devices` déclarées références universelles | Modèle relationnel §3, dictionnaire, graphe de dépendances |
| I-03 | Catégories de client et canaux de vente dans `crm`/`sales`, alors que `pricing` (P1) en dépend | Déplacés dans `catalog` | D02, D03, D10, dictionnaire, plan (P1) |
| I-04 | Décisions de validation traitées comme événements asynchrones : l'effet métier (ex. perte approuvée) pouvait être différé ou perdu | Effets appliqués **dans la transaction de décision** via des gestionnaires enregistrés par module ; les événements ne servent plus qu'aux réactions secondaires | SM-APPROVAL, catalogue d'événements, ADR-018 |
| I-05 | Ordre du PM §39 : production (P6) avant approvisionnement (P7), alors que `production` dépend de `procurement` | Phases inversées : P6 Approvisionnement, P7 Production | Plan, écrans, registre AV |
| I-06 | Pointage : résultat de la tentative et statut de dérogation confondus dans une seule colonne | Deux dimensions (`status`, `override_status`) | BR-TER-005, dictionnaire (`fieldwork.geo_checkins`) |
| I-07 | Formule du « disponible » du glossaire différente de BR-STK-011 | Alignée sur BR-STK-011 | Glossaire |
| I-08 | Permissions : saisie du jour rattachée à une permission de lot ; 4 permissions de lecture absentes ; 3 d'entre elles non reprises dans les domaines | `production.daily.record` ; ajout de `finance.payable.read`, `finance.cash.read`, `finance.expense.read`, `procurement.order.read`, reprises dans D08 et D09 **pendant l'audit** | RBAC, D07, D08, D09 |
| I-09 | Section dupliquée dans D11 ; table `integrations.settings` au nom ambigu | Dédoublonnage ; `integrations.integration_settings` | D11, D15, dictionnaire |
| I-10 | *(audit)* Prérequis de P0 incomplets par rapport aux AV du registre marqués « P0 » (AV-001, 004, 007, 074, 084, 086) ; AV-003 (zones, dimension de prix) absent de P1 | Prérequis alignés | Plan §4, checklist |
| I-11 | *(audit)* 37 fiches du dictionnaire sans ligne « Responsabilité » | Ligne reportée depuis le catalogue pour 35 fiches ; les 2 restantes (extension `production.animals`, vue `finance.v_payables`) sont décrites en prose | Dictionnaire (05 à 12) |
| I-12 | *(audit)* Total annoncé « 105 tables dont 3 vues » inexact | 105 tables et 2 vues | Modèle relationnel §2 |
| I-13 | *(audit)* Exigences sans test d'acceptation : visites (REQ-009), porcs (REQ-034, 035), catégories d'œufs (REQ-032), cohérence des indicateurs (REQ-017, 055, 056, 059), frontières de modules (REQ-082, 214) | AT-051 à AT-055 ajoutés et rattachés aux phases | Plan de tests §6, plan §2 et §4, matrice |
| I-14 | *(audit)* AV-068 classé IMPORTANTE au registre, mais « bloquant » dans le plan pour P10 | Pas de contradiction de fond : P10 ne peut être construite sans connaître le compte Kommo, mais l'intégration n'est pas une partie fondamentale (définition PM §45). Classe conservée ; précision portée dans la checklist | Checklist §2 |
| I-15 | *(audit)* Colonnes dénormalisées sans contrôle de cohérence (seuls les soldes de stock et de trésorerie étaient réconciliés) | NFR-38 étendue à toutes les colonnes listées au §2.4 | NFR-38 |

## 2.2 Ambiguïtés restantes

**Décisions bloquantes** (la phase concernée ne peut pas être livrée sans elles ; le reste du travail continue) :

| AV | Question | Défaut documenté | Phase |
|---|---|---|---|
| AV-024 | Quand une vente sur commande est-elle reconnue et quand le stock sort-il ? | À la remise physique (livraison) | P4 |
| AV-025 | Que faire d'une vente hors ligne au-delà de l'allocation ? | Blocage sur l'appareil | P4/P5 |

**Décisions importantes à fort impact structurel** (défaut implémentable, mais un changement tardif coûterait cher) :

| AV | Sujet | Pourquoi structurant |
|---|---|---|
| AV-042 | Méthode de valorisation (CMUP par défaut) | Coût figé sur chaque mouvement ; changer de méthode après P2 impose un recalcul historique |
| AV-043 | Coûts incorporés au coût d'un lot | Contenu du registre de coûts et marge de lot |
| AV-036 | Traçabilité par lot jusqu'à la vente | Mode de suivi par lot des produits (`REQUIRED` / `OPTIONAL`) et ergonomie de vente |
| AV-009 | Autonomie hors ligne (7 jours par défaut) | Durée des jetons, taille des jeux locaux, sécurité |
| AV-012 | Règle de conversion prospect → client | KPI d'acquisition et attribution |
| AV-004 | Rôles additionnels | Seed RBAC de P0 |
| AV-073 | Hébergement et localisation des données | Choix du fournisseur (P0) |
| AV-086 | Volumétrie à 3 ans | Partitionnement et paliers analytiques |
| AV-068 | Capacités du compte Kommo | Faisabilité de P10 |

**Formulations du CM interprétées par le cadrage** (statut DÉDUIT, paramétrables) :

| Formulation du CM | Interprétation retenue | Où |
|---|---|---|
| « Quasi immédiat » (tableaux de bord) | ≤ 60 s après application | NFR-16 |
| « Tolérance de quelques centaines de mètres » | Rayon paramétrable par géorepère (AV-022) | BR-TER-002 |
| « Prioritairement » (stock dont on est responsable) | Blocage par défaut (C-08) | AV-025 |
| « Saison » (variation de prix) | Campagne commerciale ou période de validité | BR-PRX-016 |
| « Selon la nature ou le niveau de la perte » | Politiques par catégorie, quantité et valeur | BR-STK-031, AV-037 |

Les seuils chiffrés proposés (500 000 XAF pour un paiement fournisseur, 15 min pour l'annulation directe, 500 m pour une visite, 72 h de saisie rétroactive…) sont **tous des paramètres** (`organization.system_settings`), jamais des constantes de code ; ils restent à confirmer via leurs AV respectifs.

## 2.3 Points fragiles

Points où une implémentation approximative casserait un invariant. Chacun a un test dédié.

| # | Point fragile | Pourquoi | Garde-fou prévu | Test |
|---|---|---|---|---|
| PF-01 | Faits accomplis hors ligne qui rendent un solde négatif | Un fait n'est jamais rejeté (BR-SYN-007) : le négatif est possible | Signal `STOCK_NEGATIVE`, tableau des soldes négatifs, résolution par inventaire ou transfert (INV-STK-05) | AT-049 |
| PF-02 | Mouvements tardifs après un inventaire | Un mouvement antérieur au comptage arrive après sa validation | Rapprochement tardif par ajustement compensatoire (BR-STK-044 ; INV-STK-09) | AT-021 |
| PF-03 | Valorisation CMUP avec des opérations tardives | Le CMUP suit l'ordre d'**application** serveur, pas `occurred_at` : le coût d'une vente tardive peut différer du coût « théorique » | Choix assumé (ADR-015 : pas de revalorisation rétroactive) ; écart visible entre marge des ventes et marge de lot ; correction par écriture d'ajustement tracée | AT-026, RISK-24 |
| PF-04 | Quotas sur un PDV partagé entre plusieurs appareils | Octroi, consommation hors ligne, libération et révocation concurrentes | Octroi en ligne uniquement, sous verrou ; somme des restes ≤ disponible (INV-STK-10, 11) | AT-004 (WF-18) |
| PF-05 | Vente tardive rattachée à une session de caisse déjà validée | La session validée est immuable (INV-FIN-05) | Mouvement compensatoire rattaché et tracé (BR-DIS-008) | AT-031 |
| PF-06 | Horloge d'appareil fausse | `occurred_at` mal daté fausse stock à date, KPI, caisse | Mesure de l'écart à chaque envoi, `clock_suspect`, refus des dates futures (BR-SYN-011, 012) | AT-036 |
| PF-07 | Même prospect créé sur deux appareils hors ligne | Doublon, attribution d'acquisition disputée | Conflit `DUPLICATE_CUSTOMER`, fusion, acquéreur le plus ancien (BR-CRM-006, 007) | AT-012 |
| PF-08 | Chaîne de hachage de l'audit | Point de sérialisation des écritures | Verrou court ; passage au chaînage par partition si la latence p99 se dégrade | RISK-25, NFR-10 |
| PF-09 | Stockage local (éviction, iOS, arrêt brutal) | Perte de l'outbox = perte de faits | Stockage persistant, outbox écrite avant confirmation, somme de contrôle, séquence d'appareil | RISK-01, RISK-16, AT-037 |
| PF-10 | Montée de version avec des commandes anciennes en attente | Un appareil longtemps hors ligne envoie des commandes N-1 | Support N-1 pendant 30 jours ; activation du nouveau service worker après vidage de l'outbox (BR-SYN-016) | AT-050 |
| PF-11 | Références inter-modules sans clé étrangère | L'intégrité n'est plus garantie par la base | Vérification par le gestionnaire de commande ; contrôle de réconciliation quotidien | NFR-38 |
| PF-12 | Références polymorphes (pièces jointes, validations, objets de coût, audit, sources de mouvement) | Pas de clé étrangère possible | Registre des types cibles par module ; validation à l'écriture ; test de propriété sur chaque type déclaré | Plan de tests §4 |

## 2.4 Risques de dette technique

| # | Risque | Mesure préventive dès P0 |
|---|---|---|
| DT-01 | **Projections et colonnes dénormalisées** qui divergent de leur source | Réconciliation quotidienne (NFR-38) de : `inventory.stock_balances`, `inventory.product_valuations`, `inventory.stock_allocations.quantity_remaining`, `finance.cash_accounts.balance_xaf`, `finance.supplier_invoices.paid_xaf`, `sales.sales.amount_paid_xaf` et `payment_status`, `sales.sales_orders.advance_paid_xaf`, `sales.sales_order_lines.delivered_quantity_base`, `sales.customer_payments.unallocated_xaf`, `crm.customers.owner_user_id` et `last_sale_at`, `procurement.purchase_request_lines.ordered_qty_base`, `procurement.purchase_order_lines.accepted_qty_base` et `invoiced_qty_base`, compteurs de `production.incubation_batches`. Chaque projection est reconstructible depuis sa source |
| DT-02 | Écart entre le dictionnaire de données et les migrations SQL | Toute migration met à jour la fiche du dictionnaire dans le même commit ; revue obligatoire ; à terme, génération d'un rapport de schéma comparé en CI |
| DT-03 | Évolution des contrats de commandes | Version par `command_type` ; support N-1 pendant 30 jours ; tests de contrat appareil ⇄ serveur en CI |
| DT-04 | Partitionnement ajouté trop tard (difficile sur des tables volumineuses) | `audit.audit_log`, `inventory.stock_moves`, `sync.command_inbox`, `sync.change_feed`, `platform.domain_events` créées **partitionnées dès P0/P2** |
| DT-05 | Analytique sur la base transactionnelle | Paliers définis (ADR-011) ; seuils de bascule = dépassement de NFR-12 ou NFR-13 |
| DT-06 | Bibliothèque métier partagée contaminée par des dépendances d'exécution | Règle : aucune entrée-sortie dans `packages/domain` (horloge, identifiants, accès aux données injectés) ; contrôle des imports en CI |
| DT-07 | Double maintenance de la matrice RBAC (documentation et code) | Une seule source versionnée (fichier de seed) dont la documentation et les tests RBAC sont générés |
| DT-08 | Seuils codés en dur | Tout seuil métier est un paramètre historisé ; revue de code dédiée |
| DT-09 | Documentation qui dérive du code | `check_refs.py` en CI ; mise à jour de la matrice de traçabilité à chaque fin de phase ; nouvel ADR pour toute décision structurante |
| DT-10 | Changements de l'API Kommo | Intégration isolée dans `integrations`, derrière un adaptateur ; aucune autre dépendance à Kommo |

## 2.5 Éléments suffisamment stabilisés pour commencer le développement

| Élément | Références | Phase | Stabilité |
|---|---|---|---|
| Conventions, identifiants, temps métier, monnaie et quantités | ADR-002, 013, 016 ; [`../03-data/01-identifiants-et-conventions.md`](../03-data/01-identifiants-et-conventions.md) | P0 | Stable |
| Pipeline de commande, outbox, inbox, flux de changements, états et conflits | ADR-001, 007 ; [`../06-offline-sync/`](../06-offline-sync/) | P0 | Stable |
| Identité, appareils, sessions, RBAC, sécurité | ADR-008 ; [`../07-security-rbac/`](../07-security-rbac/) | P0 | Stable (rôles additionnels : AV-004) |
| Organisation : sites, emplacements, zones, équipes, paramètres | D01 ; dictionnaire `organization` | P0 | Stable |
| Audit chaîné | BR-AUD-* ; [`../07-security-rbac/03-audit.md`](../07-security-rbac/03-audit.md) | P0 | Stable |
| Validations et pièces jointes génériques | ADR-012, 018 | P0 | Stable |
| Catalogue et moteur de prix partagé | ADR-005 ; D10, D16 ; [`../02-domain-model/04-strategie-pricing.md`](../02-domain-model/04-strategie-pricing.md) | P1 | Stable |
| Registre de stock, transferts, pertes, inventaires | ADR-003 ; D06 ; [`../02-domain-model/03-strategie-stock.md`](../02-domain-model/03-strategie-stock.md) | P2 | Stable ; valorisation paramétrable (AV-042) |
| CRM terrain et pointage | D02, D03 | P3 | Stable |
| Commandes, ventes, encaissements | D04, D09 ; ADR-014 | P4 | Spécifié ; **AV-024 et AV-025 à trancher avant livraison** |
| Distribution, approvisionnement, production, finance, analytics, Kommo | D05, D07, D08, D09, D11, D15 | P5 à P10 | Spécifiés ; AV de chaque phase à confirmer avant son démarrage |

**Conclusion** : les fondations (P0) et la release R1 (P0 à P3) peuvent être développées **sans improvisation métier**, avec les valeurs par défaut documentées. Le seul prérequis non documentaire est la validation humaine résumée dans la [checklist de démarrage](04-checklist-demarrage.md).

---

## 3. Contrôles automatisés réalisés pendant l'audit

| Contrôle | Méthode | Résultat |
|---|---|---|
| Références orphelines (AV, BR, INV, ADR, REQ, ECR, SM, NFR, RISK, AT, C) | `python3 docs/_tools/check_refs.py` | 0 orpheline |
| Événements cités dans les domaines (produits et consommés) ↔ catalogue d'événements | Extraction des sections 10 et 11 des 16 domaines | 0 écart |
| Permissions citées dans les domaines ↔ matrice RBAC | Extraction des sections 13 et de la matrice | 0 écart après I-08 ; 0 permission orpheline |
| Tables citées ↔ catalogue du modèle relationnel ↔ dictionnaire | Extraction des noms `schéma.table` | 0 écart (hors paramètres, permissions et extensions futures explicitement marquées) |
| Fiches du dictionnaire avec responsabilité | Recherche de la ligne « Responsabilité » | 106 des 107 objets du catalogue après I-11 ; la vue `finance.v_payables` est décrite en prose |
| Couverture de la matrice de traçabilité | Analyse des 99 lignes | 0 exigence sans règle ; 9 sans AT, toutes justifiées (§1, contrôle 1) |
