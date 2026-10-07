# Démonstration de sortie de phase P4

> Plan §4 (P4 — Commandes, ventes, encaissements). Critère : « Enregistrer chaque vente une fois, avec tous ses effets » (CM §13, §32). État arrêté le 07/10/2026, à la fin des éléments de code de P4 (P4-01 à P4-13). Développement dans l'environnement distant (MySQL 8.0, comme la CI) ; chaque incrément est commité et poussé sur la branche de travail, CI verte (ADR-024 §5 : aucun déploiement Hostinger requis).
>
> P4 suit P6 et P7 : la vente consomme le stock (P2), les prix (P1), les comptes clients (P3), les lots biologiques (P7). Elle débloque P5 (points de vente, sessions de caisse, quotas d'appareil) et P8 (finance opérationnelle).

---

## 1. Aucun AV bloquant

Les deux AV bloquants de P4 ont été tranchés le 27/09/2026 : AV-024 (vente et CA à la confirmation, marchandise « à livrer », [ADR-025](../decisions/ADR-025-vente-a-la-confirmation.md)) et AV-025 (vente hors ligne bloquée au-delà de l'allocation). La conception des commandes, ventes et livraisons est arrêtée par [ADR-028](../decisions/ADR-028-commande-vente-livraison-p4.md) (30/09/2026) et [ADR-029](../decisions/ADR-029-contre-ecriture-partielle-du-stock.md) (04/10/2026). Restent `OUVERT` des points secondaires ou importants dont la valeur par défaut est implémentée, paramétrable ou réversible, sans être présentée comme une décision (journal [`A-VALIDER.md`](../A-VALIDER.md)) :

| AV | Défaut implémenté |
|---|---|
| AV-033 | Acomptes autorisés, affectés à la commande puis passés à la vente à sa confirmation |
| AV-060 | Arrondi au franc par ligne (demi supérieur) |
| AV-083 | Vente hors ligne d'un produit désactivé : acceptée et signalée |
| AV-085 | Frais de livraison : ligne de service optionnelle |
| AV-087 | Prix convenu à la commande, appliqué à la vente |
| AV-131 | Perte d'une marchandise vendue avant sa livraison : annulation partielle, puis perte |
| AV-132 | Vente confirmée non livrée : alerte à 7 jours, paramétrée (alerte en P9) |
| AV-133 | Livraison hors ligne après l'annulation du reste : vente directe de régularisation et conflit |
| AV-134 | Bon de livraison mal saisi : non corrigeable en V1 (seul le non-livré s'annule) |
| AV-135 | Doublon d'encaissement : la Finance corrige la référence en décidant |
| AV-136 | Produit vendu au poids : vente directe seulement, pas de commande |
| AV-137 | Vente anonyme hors ligne impayée : enregistrée, drapeau et conflit pour la Finance |
| AV-138 | Annulation d'une vente d'animaux après la clôture du lot : appliquée, conflit informatif |
| AV-139 | Compte crédité par un moyen électronique : désigné par l'appareil, à défaut le seul compte actif du type |
| AV-140 | Canal déduit du lieu de la vente ; canaux créés par l'administrateur |
| AV-141 | Prix catalogue périmé en ligne : refusé, l'appareil actualise son catalogue |
| AV-142 | Stock négatif hors ligne : traité par le responsable du site selon son type |
| AV-143 | Crédit hors ligne d'un client non autorisé : appliqué, validation a posteriori |
| AV-144 | Vente directe depuis un magasin : refusée |
| AV-145 | Vente en ligne à un compte fusionné : refusée (vendre au compte conservé) |
| AV-146 | Argent d'une vente annulée : remboursement ou crédit client, au choix de l'annulateur ou de l'approbateur |
| AV-147 | Pas de remise sur une ligne de commande : prix convenu (plafond et validation `PRICE_OVERRIDE`) |
| AV-148 | Brouillon de commande : lignes et prix figés à la saisie |
| AV-149 | Annulation d'une vente sur commande : la quantité est retirée de la commande |
| AV-150 | Acompte d'une commande refusée hors ligne : gardé en crédit client non affecté, conflit pour la Finance ; acompte borné au reste à vendre |
| AV-151 | Annulation d'un encaissement en partie remboursé : refusée |
| AV-152 | Mort d'animaux hors d'un lot de production : perte simple `DETERIORATION` |

Les choix d'implémentation laissés libres par les règles sont **DÉDUITS** et documentés dans [D04 §15](../01-functional/domaines/D04-VEN-commandes-ventes.md) et [D09 §15](../01-functional/domaines/D09-FIN-finance.md).

## 2. Tests d'acceptation et invariants

### 2.1 Tests d'acceptation de la phase (plan §4 : AT-001, 002, 005, 007 à 011, 018, 030, 032, 033 ; parts P4 d'AT-026 et AT-052)

| AT | Scénario | Où | État |
|---|---|---|---|
| AT-001 | Vente hors ligne au PDV, synchronisée plus tard | `sales-sale-commands.test.ts` (heure métier conservée, stock, caisse, CA, audit, `captured_offline`) | Vert |
| AT-002 | Même lot renvoyé (réponse perdue) | `sales-sale-commands.test.ts`, `sales-cancel-commands.test.ts`, `sales-payment-commands.test.ts`, `sync-push-pull.test.ts` (une vente, un encaissement, un mouvement) | Vert |
| AT-005 | Vente hors ligne à un prix devenu obsolète | `sales-sale-commands.test.ts` (prix figé, anomalie `PRICE_MISMATCH`) | Vert |
| AT-007 | Changement de prix de 4 500 à 4 800 | `sales-sale-commands.test.ts` (la vente antérieure garde prix, règle et version) | Vert |
| AT-008 | Commande, acompte, livraison partielle, reste, solde (WF-02) | `sales-acceptance.test.ts` (vente du disponible, acompte transféré, `PARTIALLY_FULFILLED`, vente du reste, `FULFILLED`, solde affecté aux ventes) | Vert |
| AT-009 | Annulation directe dans les 15 minutes | `sales-acceptance.test.ts` (stock rendu, remboursement, CA négatif au jour métier de l'annulation, même passé minuit à Douala) ; `sales-cancel-commands.test.ts` | Vert |
| AT-010 | Annulation hors délai | `sales-acceptance.test.ts` (demande, auto-validation refusée `SELF_APPROVAL_FORBIDDEN`, validation par la Direction) ; `sales-cancel-commands.test.ts` | Vert |
| AT-011 | Première vente à un prospect | `sales-acceptance.test.ts` (conversion, `first_sale_id`, KPI « nouveaux clients ») ; `crm-customer-commands.test.ts` | Vert |
| AT-018 | 50 poulets au stock mobile ; ventes, perte, retour (WF-06) | `sales-acceptance.test.ts` (transfert reçu, 44 vendus, 2 perdus, 4 rendus, solde mobile nul, caisse du commercial) | Vert ; perte hors lot : AV-152 |
| AT-030 | Même référence mobile money deux fois | `sales-acceptance.test.ts` (second encaissement `SUSPECT_DUPLICATE`, sans trésorerie, lié au premier) ; `sales-payment-commands.test.ts` | Vert |
| AT-032 | Créance échue | `sales-acceptance.test.ts` (événement `ReceivableOverdue` pour la seule vente échue, règlement aux plus anciennes) ; `sales-revenue-receivables.test.ts` | Vert ; alerte `OVERDUE_RECEIVABLE` en P9 |
| AT-033 | Commercial A qui lit la vente de B | `sales-read.e2e.test.ts` (404 audité, 403 sans droit, coût masqué sans `inventory.valuation.read`) ; parts P2, P3 déjà vertes | Vert |
| AT-026 (part P4) | CA et marge du lot de 2 400 poulets | `production-acceptance.test.ts` (2 310 têtes vendues à 4 650 : CA 10 741 500, coût des ventes 5 600 000, marge du lot 5 141 500, conformes à la [stratégie finance §6.2](../02-domain-model/05-strategie-finance-couts.md)) | Vert |
| AT-052 (part P4) | Vente de 3 porcs | `production-acceptance.test.ts` (3 têtes au prix par tête ; 3 têtes au kilo vif, 270 kg, AV-031) | Vert |

Parcours de bout en bout du plan : WF-01 hors caisse PDV (AT-001, vente hors ligne puis synchronisée), WF-02 (AT-008), annulations (AT-009, AT-010, `sales-cancel-commands.test.ts`), doublon de paiement (AT-030, `sales-payment-commands.test.ts`). Lectures HTTP : `sales-read.e2e.test.ts` (commandes, livraisons, ventes, reçus, encaissements, créances, caisses, fiche client, réalisé `CA`).

### 2.2 Invariants

| INV | Où | État |
|---|---|---|
| INV-VEN-01 | `sales-finance-invariants.test.ts` (toute vente appliquée existe, une seule par commande) ; `db/tests` (`UNIQUE (command_id)`) | Vert |
| INV-VEN-02, INV-VEN-10 | `db/tests/sales.test.ts` (vente immuable, attribution figée, montant annulé non décroissant) ; balayage des bornes | Vert |
| INV-VEN-03 | `db/tests` (`CHECK`) ; `packages/domain` ; balayage (ligne et total) | Vert |
| INV-VEN-04 | `db/tests` ; balayage (livré ≤ vendu ≤ commandé) | Vert |
| INV-VEN-05 | balayage (règle et version, motif de dérogation) ; AT-007 | Vert |
| INV-VEN-06, INV-FIN-04 | balayage (payé = affectations actives ≤ net ; encaissement = affecté + crédit + remboursé) | Vert |
| INV-VEN-07 | balayage (vente anonyme en ligne soldée ; hors ligne : AV-137) | Vert |
| INV-VEN-08 | balayage (sorties `SALE` = quantité de chaque ligne non `SERVICE`) | Vert |
| INV-VEN-09 | balayage (vente annulée : tout annulé, aucune affectation active) | Vert |
| INV-FIN-01, INV-FIN-02 | balayage (solde = registre, inverses appariés, mouvement de chaque encaissement) ; `finance-cash.test.ts` ; `db/tests` (aucune suppression) | Vert |
| INV-FIN-03 | `db/tests` (index unique) ; balayage ; AT-030 | Vert |
| INV-FIN-09, INV-FIN-10 | balayage | Vert |
| INV-STK-16 | balayage (sorties − retours rattachés = quantité nette ; ligne annulée : net nul en valeur) ; `inventory-settlement.test.ts` | Vert |

### 2.3 Suites complètes (07/10/2026)

`packages/domain` 216 tests (17 fichiers) ; `packages/contracts` 165 tests (5 fichiers) ; `db` 117 tests (12 fichiers) ; `apps/pwa` 58 tests (10 fichiers) ; `apps/server` 656 tests (85 fichiers). `typecheck`, `check:boundaries`, `lint`, `format:check` et `python3 docs/_tools/check_refs.py` verts ; CI de la branche verte.

## 3. Ce qui est livré

| Incrément | Contenu |
|---|---|
| P4-01 `packages/domain` | Montant de ligne, remise et plafond par rôle, contrôle de crédit, statut de paiement, répartition d'un encaissement, délai d'annulation, échéance, quantités et statut d'une commande, ancienneté des créances, partage d'un montant au franc |
| P4-02 `db` | Socle `finance` (moyens de paiement, comptes, mouvements) ; tables `sales` (commandes, ventes, annulations, livraisons, encaissements, affectations) et leurs gardes ; emplacement « à livrer » ; politiques, paramètres, RBAC |
| P4-03 prérequis | Emplacement « à livrer » par site, mouvements rattachés à une origine (ADR-029), règlement du stock vendu, coût restant des lots, lot clôturé avant livraison |
| P4-04 ventes directes | `sales.sale.record` hors ligne : prix, remise, poids, lot FIFO et coût figé, attribution, conversion du prospect, vente anonyme, crédit, encaissements joints |
| P4-05 annulations | `sales.sale.cancel`, demande et décision `SALE_CANCELLATION` ; contre-écritures de stock, CA négatif, remboursement ou crédit client |
| P4-06 commandes | Brouillon, confirmation (vente du disponible, acomptes), reste, modification par ajustement, annulation et clôture du reliquat |
| P4-07 livraisons | `sales.order.fulfil` : bons `LIV`, livraisons partielles, régularisation hors ligne |
| P4-08 encaissements | `sales.payment.record` hors vente, doublons, réaffectation, remboursement, annulation ; décisions de la Finance |
| P4-09 créances et CA | Créances par ancienneté, tâche `ReceivableOverdue`, CA, coût des ventes et marges, CA et marge des lots, réalisé des objectifs |
| P4-10 lectures HTTP | `sales-api/` et `finance-api/` ; volet ventes de la fiche client ; portée par document et pré-filtre « sites OU titulaires » (`listConfinementAt`) |
| P4-11 hors ligne | Jeux `orders`, `sales_recent`, `cash` ; encours dans `customers` ; moyens de paiement dans `catalog` ([ADR-031](../decisions/ADR-031-cle-de-synchronisation-des-referentiels-a-code.md)) ; acompte d'une commande refusée hors ligne gardé (AV-150) |
| P4-12 revue adverse | Portée des listes, de la fiche client et des commandes à préparer ; balayage des invariants |
| P4-13 tests | Balayage des invariants, tests d'acceptation, réalisé `CA` par HTTP |

## 4. Ce qui reste hors périmètre de P4

- **Écrans PWA** ECR-VEN-01 à 06, ECR-FIN-01, volet ventes d'ECR-CRM-03 : l'API, les jeux hors ligne et la logique partagée (`packages/domain`) sont prêts ; l'appareil n'applique encore que les jeux de P0 (`apps/pwa/src/sync/pull.ts`).
- **Sessions de caisse, quotas d'appareil, caisse du PDV** : P5 (le jeu `cash` portera la session ouverte ; le blocage sur l'appareil au-delà de l'allocation, AV-025, est appliqué par la PWA).
- **Alertes** `OVERDUE_RECEIVABLE`, vente non livrée (AV-132), stock négatif : P9 (les événements existent).
- **Finance opérationnelle** (dépenses, factures, dettes, rapprochement) : P8.
- **Référentiels du seed** autres que les moyens de paiement (motifs, sources, étapes, paramètres), unités et canaux : pas encore publiés dans le flux de synchronisation (écart relevé en P4-11, ADR-031 « Conséquences »).
