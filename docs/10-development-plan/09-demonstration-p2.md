# Démonstration de sortie de phase P2

> Plan §4 (P2 — Stock et mouvements). Critère : « Magasin et PDV gèrent réceptions d'ouverture, transferts, pertes et inventaires, hors ligne ». État arrêté le 26/09/2026, à la fin des éléments de code de P2 (P2-01 à P2-07). Développement local (MySQL 8.4 sur le poste, ADR-024 §5) ; commits locaux, rien n'est poussé vers le dépôt distant à cette date.

---

## 1. Aucun AV bloquant

P2 n'a aucun AV **bloquant** (checklist §2). Les AV listés en prérequis restent `OUVERT` ; leur valeur par défaut est implémentée de façon **paramétrable** ou réversible, sans être présentée comme une décision :

| AV | Défaut implémenté | Où |
|---|---|---|
| AV-035 (partiel) | Table des allocations créée (P2-02), jamais alimentée : `qty_allocated` reste à 0 jusqu'à P5 | migration `inventory_allocations` |
| AV-036 | FIFO automatique pour une sortie sans lot (BR-STK-050) ; lot obligatoire pour un produit `REQUIRED`, interdit pour `NONE` (`LOT_REQUIRED`, `LOT_MISMATCH`, P2-07) | `record-move.ts` |
| AV-037 | Politique active `LOSS_DECLARATION` : sa validation et sa photo requises s'appliquent ; sans politique, perte `RECORDED` directe (BR-STK-032). La `condition` (seuils par catégorie et montant) n'est pas encore évaluée — voir §4 | `loss-commands.ts` |
| AV-038 (**TRANCHÉ** le 26/09/2026) | Deux issues de rejet (`ERREUR_DECLARATION` → retour en stock ; `PERTE_NON_JUSTIFIEE` → perte confirmée, reclassée `INEXPLIQUEE`). Responsabilité imputée **au déclarant**. Rejet sans option : traité comme `ERREUR_DECLARATION`. Comportement confirmé par le porteur du projet | `loss-commands.ts` |
| AV-039 | Seuil de validation d'un écart d'inventaire : paramètre `inventory.count_approval_threshold_xaf` (25 000 XAF, seed), repli documenté si absent. La fréquence des inventaires reste une procédure, non contrainte | `count-commands.ts` |
| AV-040 | Un couple (minimum, cible) par emplacement × produit, sans valeur par défaut ; versionné par désactivation | `threshold-commands.ts` |
| AV-042 | CMUP perpétuel par produit, recalculé à chaque entrée valorisée ; un inverse reprend le coût d'origine. Coût par tête d'un lot biologique : P7 | `record-move.ts`, ADR-015 |
| AV-081 | Aucune validation préalable : une demande est acceptée par l'expédition ; expédition directe sans demande possible | `transfer-commands.ts` |
| AV-082 | Écart de réception = perte en transit en attente (`V_PENDING_LOSS`), validée selon la politique `TRANSFER_DISCREPANCY` (portée : site expéditeur) ; sans politique active, refus `CONTROL_POLICY_MISSING` (validation inconditionnelle, jamais sautée) ; réception supérieure à l'expédition refusée (`TRANSFER_OVER_RECEIVED`) | `transfer-commands.ts` |

Un point nouveau, **AV-094** (permission de lecture des documents de stock), a été ouvert puis **tranché** le 26/09/2026 : la lecture des pertes est réservée à l'encadrement dans son périmètre (nouvelle permission `inventory.loss.read`, 119 permissions et 491 octrois au seed), un déclarant de terrain ne lit que ses propres pertes ; les demandes de validation ne descendent hors ligne que sur l'appareil de leur demandeur. Voir [`../A-VALIDER.md`](../A-VALIDER.md).

## 2. Tests d'acceptation et invariants

### 2.1 Tests d'acceptation de la phase (plan §4 : AT-016, 017, 019, 020, 021, 022, 047, 049)

| AT | Scénario | Où | État |
|---|---|---|---|
| AT-016 | 58 plateaux expédiés, 57 reçus : perte en transit validée, conservation | `inventory-invariants.test.ts` | Vert |
| AT-017 | Réception sans document, puis rapprochement automatique | — | Non construit (§4) |
| AT-019 | Perte au-dessus du seuil : `V_PENDING_LOSS`, photo, validation | `inventory-loss-commands.test.ts` | Partiel : quantité indisponible et validation vertes ; photo exigée avant approbation non construite (§4) |
| AT-020 | Rejet pour erreur de déclaration : retour en stock | `inventory-loss-commands.test.ts` | Vert |
| AT-021 | Inventaire avec vente tardive antérieure : rapprochement | `inventory-count-commands.test.ts` | Partiel : écart −3 visible et justifiable, validation au-dessus du seuil ; rapprochement tardif (BR-STK-044) non construit (§4) |
| AT-022 | Modifier un solde directement | `inventory-invariants.test.ts` | Vert : aucune API d'écriture de solde ; `UPDATE`/`DELETE` du registre refusés en base ; une altération directe de la projection est détectée par la réconciliation et corrigée par la reconstruction |
| AT-047 | Stock sous le seuil : une alerte, résolue automatiquement | `inventory-read.e2e.test.ts` (état `STOCK_LOW` calculé) | Partiel : état du seuil et quantité suggérée (BR-STK-051) ; alerte `communication.alerts` non construite (§4) |
| AT-049 | Solde négatif par une vente hors ligne : conflit `STOCK_NEGATIVE` | — | Non construit : la vente est en P4 ; l'ouverture du conflit informatif aussi (§4) |

Tests d'acceptation d'autres phases, déjà démontrables sur la part stock : AT-038 (disponible par zone et sous-zones, `GET /stock/availability`) et AT-043 (du mouvement au document, à l'auteur, à l'appareil et à la commande, `GET /stock-moves`) — `inventory-read.e2e.test.ts`.

### 2.2 Invariants `INV-STK-*`

| INV | Où | État |
|---|---|---|
| INV-STK-01 | `inventory-invariants.test.ts` (réconciliation, reconstruction) ; tâche `inventory.ledger.reconcile_daily` | Vert |
| INV-STK-02 | `inventory-record-move.test.ts` (couple par type) ; `inventory-invariants.test.ts` (contraintes en base) | Vert |
| INV-STK-03 | `inventory-record-move.test.ts`, `inventory-invariants.test.ts` (AT-016, réconciliation) | Vert |
| INV-STK-04 | `inventory-invariants.test.ts` (immuabilité ; inverse conforme, unique, au coût d'origine) | Vert |
| INV-STK-05 | `inventory-record-move.test.ts` (fait hors ligne appliqué malgré un solde négatif) | Partiel : le conflit `STOCK_NEGATIVE` n'est pas ouvert (§4) |
| INV-STK-06 | `inventory-record-move.test.ts` (refus en ligne, BR-STK-017) | Vert |
| INV-STK-07 | — | Non construit : `organization` (désactivation d'emplacement) ne dépend pas d'`inventory` ; contrôle à placer dans une composition transport ou une commande d'`inventory` (§4) |
| INV-STK-08 | `inventory-invariants.test.ts` (AT-016 : expédié = reçu + écart + retourné ; transit nul) | Vert |
| INV-STK-09 | `inventory-count-commands.test.ts` (ajustement daté de `counted_at`) | Partiel : sans rapprochement tardif (BR-STK-044) |
| INV-STK-10, 11 | — | P5 (allocations) |
| INV-STK-12 | — | P6 (réceptions) |
| INV-STK-13 | `inventory-invariants.test.ts` | Vert (exception hors ligne documentée, §3) |
| INV-STK-14 | `inventory-loss-commands.test.ts` (attente > 0 ; nulle après approbation, rejets, retrait) | Vert |
| INV-STK-15 | `inventory-invariants.test.ts` (contrainte en base) ; coût toujours fixé par le serveur (`record-move.ts`) | Vert |
| INV-STK-16 | — | P4 (annulation de vente) |

### 2.3 Suites complètes (26/09/2026)

`packages/domain` 108 tests ; `apps/server` 276 tests (43 fichiers, exécution séquentielle `vitest run --no-file-parallelism`) ; `db` 47 tests. `typecheck`, `check:boundaries` (219 modules), `lint`, `format:check`, `python3 docs/_tools/check_refs.py` verts.

Notes d'exécution :

- Le MySQL de XAMPP est un MariaDB 10.4 : inutilisable (collation `utf8mb4_0900_as_cs`, `CHECK`, colonnes générées). Les tests tournent sur un MySQL Community Server 8.4 installé à part (port 3307).
- Le verrou mortel InnoDB intermittent sur `record-audit.test.ts` (insertions d'audit concurrentes), noté depuis P0 ([`07-demonstration-p0.md`](07-demonstration-p0.md) §1), est devenu fréquent avec la taille de la suite : sa cause était structurelle (verrou d'intervalle posé en verrouillant « la dernière ligne » du journal). Corrigé à la clôture de P2 : le chaînage se sérialise désormais sur une ligne unique `audit.chain_head` (migration `20260929090000`), sans verrou d'intervalle — en production, les commandes concurrentes ne s'interbloquent plus sur l'audit.

## 3. Ce qui est livré

| Élément | Contenu |
|---|---|
| P2-01 `packages/domain` | Disponible (§3.3), sélection FIFO/FEFO, CMUP ; puis (P2-05) `stockValueXaf` (BR-STK-054) et `evaluateStockThreshold` (BR-STK-051), partagés appareil/serveur |
| P2-02 `db` | Migrations `inventory.*` (registre, soldes, lots, transferts, pertes, consommations, inventaires, seuils, valorisation, registre de coûts, allocations) ; immuabilité du registre en base |
| P2-03 registre | `recordStockMove` : partie double, conformité du couple par type, verrou de solde, FIFO, CMUP, coût figé ; puis (P2-07) contrôle du lot et de l'inverse |
| P2-04 commandes | Transferts (`request`, `decline`, `cancel`, `dispatch`, `receive`, `move_internal`, décision `TRANSFER_DISCREPANCY`) ; pertes (`declare`, `withdraw`, décision `LOSS_DECLARATION`) ; consommations (`record`, `cancel`, écritures de coût) ; seuils (`set`) ; inventaires (`open`, `record_lines`, `submit`, `cancel`, décision `INVENTORY_ADJUSTMENT`) |
| P2-05 lectures | `GET /stock`, `/stock/at`, `/stock/availability`, `/stock-moves`, `/transfers`, `/transfers/{id}`, `/losses`, `/consumptions`, `/inventory-counts`, `/inventory-counts/{id}`, `/thresholds`, `/costs` — portée par emplacement (site, zone, détenteur), refus audités, montants masqués sans `inventory.valuation.read` |
| P2-06 hors ligne | Jeux `stock`, `transfers`, `counts` en portée `LOCATION` ; périmètre d'appareil dérivé d'`inventory.stock.read` ; API `recordChanges` de `sync-core` |
| P2-07 intégrité | Invariants INV-STK démontrés ; réconciliation quotidienne `inventory.ledger.reconcile_daily` (processus API et worker) ; reconstruction de la projection |
| RBAC | Aucun changement : les permissions `inventory.*` existaient depuis le seed P0-05 |

Décisions DÉDUITES à connaître (documentées dans le code) :

- **Inverse de consommation** : type dédié `CONSUMPTION_REVERSAL` (D06 §7.7, mis à jour) plutôt que le même type, pour garder le contrôle des couples strict par type.
- **Lot manquant hors ligne** : une sortie hors ligne d'un produit `REQUIRED` sans aucun lot en solde est appliquée sans lot plutôt que rejetée (BR-SYN-007 et INV-STK-05 priment sur INV-STK-13).
- **Emplacement sans mode de garde** : traité comme `SHARED` pour le disponible (lecture prudente).
- **Transfert multi-lots** : si l'expédition traverse plusieurs lots (FIFO), seule la première est portée sur la ligne de transfert (le stock, lui, est exact).
- **Lecture ancrée sur l'emplacement** : `location_id` obligatoire sur les listes, pour appliquer la portée.

Correctif découvert en P2-05 : le registre des commandes `inventory` recevait `DocumentSequenceService` par son seul type, `undefined` dans l'application Nest réelle (vitest ne produit pas de métadonnées de décorateur). Toute commande numérotée aurait échoué en `RETRY_LATER`. `@Inject` explicite, comme ailleurs dans le projet.

## 4. Ce qui n'est pas livré (signalé, pas silencieux)

| Élément | Raison | Déclencheur |
|---|---|---|
| Écrans PWA ECR-STK-01 à 05, 07, 08 ; ECR-ADM-08 ; ECR-NOT-01 | Même précédent que P0-11 et P1 : aucun écran métier construit, les API sont prêtes | Session dédiée aux écrans, ou P4 (première UI de vente) |
| Inventaire d'ouverture (`count_type = OPENING`, `inventory.opening.post`) et chargement du stock d'ouverture (DoD) | Le mouvement `OPENING_BALANCE` existe et est testé ; le document d'ouverture et le chargement exigent les données GIC (AV-072) | Réception des stocks d'ouverture par emplacement (AV-002, AV-072) |
| Réception sans document `BLIND_RECEIPT`, retour à la source (AT-017, BR-STK-024) | Rapprochement asynchrone et délai de 48 h (`inventory.transfer_unmatched_hours`) sans ordonnanceur récurrent réel | P5 (PDV en mode exclusif), avec un ordonnanceur |
| Rapprochement tardif d'inventaire (BR-STK-044, AT-021, INV-STK-09) ; répartition FIFO inverse (BR-STK-045) | Exige de détecter, à l'application de chaque mouvement, un inventaire comptabilisé postérieur à son `occurred_at` | Avant la mise en production de R1 (inventaires réels) |
| Seuils de preuve par catégorie et montant (AV-037) ; photo exigée avant approbation (`ATTACHMENT_REQUIRED`, AT-019) | La `condition` des politiques n'est interprétée nulle part (P0-13) ; la présence de la pièce n'est pas vérifiée à la décision | Décision d'AV-037, puis évaluation des conditions dans `approvals` |
| Annulation d'une perte `RECORDED` (`inventory.loss.request_cancellation`, BR-STK-034) | Exige `LOSS_CANCELLATION` au catalogue fermé des types d'opération (et ses deux `CHECK`) | Premier besoin réel |
| Conflit informatif `STOCK_NEGATIVE` (INV-STK-05, AT-049) et alertes `STOCK_LOW`, `STOCK_OUT`, `LEDGER_MISMATCH` (AT-047) | Le fait est appliqué, mais ni le conflit ni l'alerte ne sont ouverts : module `communication` absent, pas de mécanisme de conflit informatif générique | P4 (ventes hors ligne) et P9 (alertes) |
| INV-STK-07 (emplacement désactivé sans solde ni transfert ouvert) | `organization.location.deactivate` (P0-11) ne peut pas consulter `inventory` (sens du graphe) | Composition transport ou commande de désactivation portée par `inventory` |
| Contrôle des quantités saisies : conversion d'unité vers l'unité de base, entier pour une unité comptée (`QUANTITY_INVALID`, D06 §8) | Seule la positivité est contrôlée ; `quantity_base` fourni par l'appareil est pris tel quel | Avant les écrans de saisie (même moteur de conversion appareil/serveur, `packages/domain`) |
| Motif d'écart obligatoire à la comptabilisation d'un inventaire (`variance_reason_code_id`, dictionnaire) | Stocké s'il est fourni, jamais exigé : l'écart n'est connu qu'au serveur, à la soumission (fait accompli) | Exigence au moment de la décision de validation, ou saisie après coup |
| Jeux hors ligne des pertes et consommations | Le dictionnaire les marque « Offline DL (30 j) », mais le catalogue des jeux ([`../06-offline-sync/01-architecture-offline.md`](../06-offline-sync/01-architecture-offline.md) §3.1) n'a aucun code de jeu pour elles : incohérence interne du référentiel, non comblée | Arbitrage du catalogue des jeux (ajout d'un jeu, ou retrait de la mention du dictionnaire) |
| `SCOPE_EXIT` des soldes quand un emplacement sort du périmètre d'un appareil | Aucun gestionnaire `identity` n'émet encore de sortie de périmètre | Réaffectation d'un rôle (identity), avec P3/P5 |
| Ordonnancement récurrent de la réconciliation ; « zéro écart sur 7 jours de staging » (DoD) | Même limite que P0-07 : aucun ordonnanceur récurrent, et pas de `staging` (ADR-024) | Déploiement (AV-090) |

## 5. Prochaine étape

La phase **P3** (CRM terrain et pointage) dépend de P0 et P1 seulement ; elle peut démarrer. La phase **P4** reste bloquée par AV-024 et AV-025 (règle R11).
