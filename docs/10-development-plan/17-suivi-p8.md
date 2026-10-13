# Suivi de la phase P8 — Finance opérationnelle (menée en parallèle)

> Ouvert le 13/10/2026. P8 est développée en parallèle de la session principale, qui vérifie et corrige les écrans de P1 à P5. La session principale intègre ce travail : elle fusionne `claude/p8-finance`, renumérote sans trou les AV et les ADR, et met à jour `CLAUDE.md` et `PROMPT-DE-REPRISE.md`. Fiche, conception et backlog : [plan §4, P8](01-plan-developpement.md#p8--finance-opérationnelle).

## 1. Espace réservé

| Élément | Valeur |
|---|---|
| Branche | `claude/p8-finance`, partie de `claude/brave-pasteur-c7q4y7` (`9a5b315`) |
| Worktree | `.claude/worktrees/p8-finance` |
| Bases | `gic_agropelc_p8` (développement et tests), `gic_agropelc_p8m` (base jetable : mutations, scénarios destructifs) |
| Migrations | versions `20261101xxxxxx` |
| AV | numéros 350 à 399 (provisoires) ; utilisés : AV-350 à AV-366 |
| ADR | numéros 060 à 069 (provisoires) ; utilisés : ADR-060 à ADR-062 |
| Démonstration de sortie | `18-demonstration-p8.md` (à la clôture) |

Point de départ vérifié le 13/10/2026 : suite serveur complète sur `gic_agropelc_p8` neuve, **1 111 tests verts** (127 fichiers). Un premier passage a donné un dépassement de délai sous charge dans `sales-allocations.test.ts`, vert à la relance (33 sur 33).

## 2. Avancement

| Incr. | Objet | Commit | État |
|---|---|---|---|
| P8-01 | Conception : ADR-060 à 062, AV-350 à 366, D09 §17, backlog | `b48ea93` | Fait |
| P8-02 | Domaine partagé (`expenses.ts`, `supplier-ledger.ts`) et schémas des commandes (`finance-operations-commands.ts`) | `290f88a` | Fait : domaine 401 tests (37 nouveaux, 100 % de couverture des deux fichiers), contrats 236 tests ; 8 mutations détectées ; typage, ESLint, frontières verts |
| P8-03 | `db` : migration `20261101090000`, seed, `schema.sql`, types Kysely, dictionnaires | `b588b23` | Fait : `db` 200 tests (11 nouveaux), six mutations du schéma détectées sur `gic_agropelc_p8m` ; serveur RBAC et validations 36 tests ; typage vert |
| P8-04 | Catégories de dépense : commandes, publication `catalog`, projection | `cc09f77` | Fait : 5 tests serveur, 7 mutations détectées ; seed 12 tests |
| P8-05 | Dépenses : enregistrement (en ligne, hors ligne, PDV, revue a posteriori), paiement, annulation | `eb036be` | Fait : 10 tests serveur, 15 mutations détectées ; non-régression de 7 fichiers voisins verte (101 tests) |
| P8-06 | Décisions `EXPENSE` (approbation, rejet, plafond par rôle, retrait refusé) | `eb036be` | Fait : 4 tests serveur, 6 mutations détectées ; domaine 18 tests pour les dépenses |
| P8-07 | Factures fournisseurs : rapprochement sous verrou du BC, écart et décision `INVOICE_MISMATCH`, contestation, avoir, quantités facturées écrites par `procurement` | `3558d5c` | Fait : 6 tests serveur, 12 mutations détectées |
| P8-08 | Paiements fournisseurs : validation de la Direction avant décaissement, affectations prévues, avances, annulation | `21b9851` | Fait : 5 tests serveur, 14 mutations détectées |
| P8-09 | Lectures HTTP : dépenses (portée), factures, paiements, dettes ; payé du rapprochement de P6 | `3d316bd` | Fait : 5 tests HTTP de bout en bout, 6 mutations détectées |
| P8-10 | Jeux hors ligne : dépenses de l'auteur (`cash`, 30 jours), catégories (`catalog`), seuils (`me`) | `c7f40eb` | Fait : 3 tests par le pull réel ; 3 mutations détectées, 1 équivalente (la garde de portée `USER` double la vérification de l'auteur) |
| P8-11 | Coûts complets et marges : CA d'un lot avec ses produits d'abattage, valeur des pertes, vue d'ensemble financière | `4dcc4a7` | Fait : 5 tests (2 unitaires, 3 HTTP), 8 mutations détectées ; le câblage de bout en bout de la marge d'un lot abattu est vérifié en P8-13 |
| P8-12 | Invariants et réconciliation : `verifyExpenses`, `verifySupplierLedger` dans la réconciliation quotidienne ; balayage de toute la base ; ordre des verrous en concurrence | `2914381` | Fait : 5 tests de balayage, 7 tests de concurrence et de détection, 1 test de la tâche ; 12 mutations détectées sur `gic_agropelc_p8m`, 1 équivalente (verrou de l'en-tête du BC seul retiré : les lignes du BC, verrouillées aussi, sérialisent déjà les paires testées ; l'en-tête reste verrouillé pour l'ordre global d'ADR-038) |
| P8-13 | Acceptation : AT-025 (WF-09 de bout en bout), AT-040, AT-041, AT-026 avec la dépense directe de 140 000, lot abattu dont les produits sont vendus, journée de PDV hors ligne avec dépenses | _à venir_ | Fait : 3 tests de bout en bout (`p8-acceptance.e2e.test.ts`), 1 test d'acceptation de la production ; 6 mutations détectées sur `gic_agropelc_p8m` |
| P8-14 | Revue adverse : quatre axes (dépenses, fournisseurs, lectures et synchronisation, schéma et vérifications), deux vérificateurs sceptiques ; correctifs | `b38c6be` (lectures) et _à venir_ | Fait : 28 constats (aucun critique), 11 confirmés, 11 partiels, 6 réfutés ou acceptés ; 27 mutations détectées (11 lectures, 16 fournisseurs, dépenses et vérifications) ; voir §6 |
| P8-15 | Voir le backlog du plan | — | À faire |

## 3. Code existant touché (hors des fichiers nouveaux de P8)

Ces modifications sont signalées à la session principale à chaque fin de lot. Elle peut corriger les mêmes fichiers en parallèle : chaque changement reste petit et localisé.

| Incr. | Module ou fichier | Changement | Raison |
|---|---|---|---|
| P8-03 | `approvals` : `operation-types.ts`, CHECK `ck_approvals_control_policies_operation_type` | ajout de `INVOICE_MISMATCH` | SM-SUPPLIER-INVOICE |
| P8-03 | `db/seeds/rbac-data.ts`, `db/tests/seed.test.ts` | permission `finance.expense_category.manage` (Finance, Administrateur) ; `finance.expense.record` OWN du Resp. commercial (matrice RBAC l.237) | AV-357 ; alignement prévu en P8 |
| P8-05 | `inventory/application/public` (`cost-entries.ts`, `index.ts`) | lectures `lotCostObjectStatus` (état d'un lot par son lot de stock) et `siteOverheadMonthAllocated` (mois de frais généraux déjà réparti) | ADR-060 §8 |
| P8-05 | `finance` (P5) : `cash-session-commands.ts` (résolution des conflits à l'ouverture) | type `EXPENSE` en plus de `CUSTOMER_PAYMENT` | ADR-060 §5, AV-354 |
| P8-05 | `finance` (P5) : `cash-transfer-support.ts` | `canActOnCashAccount` : permission optionnelle (défaut inchangé) | ADR-060 §4 |
| P8-05 | `procurement/application/public` (`supplier-query.ts`, `index.ts`) | `findSupplier` (avancé de P8-07) | ADR-061 |
| P8-05 | `packages/contracts` (`error-codes.ts`) | `EXPENSE_REVIEW_REQUIRED` en fin de `WARNING_CODES` | R8 |
| P8-07 | `procurement/application/public` (`invoicing.ts`, `index.ts`) | `lockOrderForInvoicing`, `applyInvoicedQuantities`, `receiptLinesForInvoicing`, `invoicedQuantitiesOfOrder` | ADR-061 §3 |
| P8-07 | Documentation de P6 | D08 l.93 (quantité facturée écrite à l'appel de `finance`), dictionnaire `08-procurement.md` (`invoiced_qty_base`), `02-modules.md` (API interne de `procurement`) | ADR-061 §3 |
| P8-09 | `procurement-api/procurement-read.controller.ts` (rapprochement) | payé (`paidXaf`) composé depuis `finance` (`paidXafOfPurchaseOrder`) quand les valeurs sont visibles | ADR-061 §3 |
| P8-11 | `production/application/public` (`lot-sale-lots.ts`, `index.ts`), `production-api` (`production-read.controller.ts`, nouveau `lot-margin.ts`) | `slaughterStockLotIds` ; CA de la marge de lot avec les produits d'abattage (défaut de P4 et P7 : un lot abattu affichait un CA nul) | ADR-062 §1, AV-366 |
| P8-11 | `inventory/application/public` (`loss-summary.ts`, `index.ts`), `inventory-api` (nouveau `loss-summary-read.controller.ts`, `inventory-api.module.ts`) | `lossValueSummary`, `GET /losses/summary` | ADR-062 §3 |
| P8-12 | `finance` (P4, P5) : `jobs/cash-ledger-reconciliation-job.ts` et son test unitaire `cash-ledger-reconciliation-job.test.ts` | deux sections de plus (dépenses, documents fournisseurs) ; le test simule les deux nouvelles vérifications | INV-FIN-07, INV-FIN-08 |
| P8-13 | `production-api` (`production-read.controller.ts`, `lot-margin.ts`) | la composition du CA d'un lot (`withSales`, P4-09 et P8-11) devient `lotWithSales` dans `lot-margin.ts`, appelée par la route et par le test d'acceptation ; comportement inchangé | ADR-062 §1 |
| P8-13 | `production-acceptance.test.ts` (P7, P4) | `run` accepte des justificatifs ; commandes et décisions de dépense enregistrées ; un test de plus en fin de fichier (AT-026 avec dépense, AT-041, lot abattu vendu) | ADR-062 §5 |
| P8-14 | `procurement-api/procurement-read.controller.ts`, `test/procurement-read.e2e.test.ts` (P6) | payé du BC (`paidXaf`) seulement pour un lecteur des dettes (`finance.payable.read`) ; l'attente du test de P6 passe de `null` (valeur d'attente d'avant P8) à 0 pour l'acheteur — elle échouait depuis P8-09 sans avoir été relancée | AV-365, revue de P8-14 |
| P8-14 | `inventory-api/loss-summary-read.controller.ts`, `sync/entity-projections.ts` | dates au calendrier, ordre sans valorisation ; fenêtre des dépenses du jeu `cash` | revue de P8-14 |
| P8-14 | `finance` (P5) : `cash-transfer-support.ts` (`loadSiteRef`) | type du site rendu (sans changement pour les appelants existants) | revue de P8-14 (A3) |
| P8-14 | `test/supplier-ledger-fixtures.ts` (assistants de P8) | l'accepté d'une ligne de BC vient d'une réception comptabilisée avec son entrée en stock et sa valeur acceptée : les anciens assistants écrivaient l'accepté seul et violaient les invariants de P6 balayés sur toute la base (`procurement-invariants.test.ts`, 322 lignes sur `gic_agropelc_p8`) | INV-APP-02, INV-STK-12 |

## 4. Écarts de documentation relevés (pour la session principale)

- `CLAUDE.md` §1 (ligne P6) et `11-demonstration-p6.md` disent AV-095 et AV-096 « ouverts » ; ils sont tranchés le 27/09/2026 dans le registre. AV-096 (dérogation d'emplacement de réception, option c) n'est pas construit : le code refuse toujours `RECEIPT_LOCATION_INVALID`. C'est hors du périmètre de P8.
- Le lancement de P8 demandait la section « §15 de D09 » pour les choix de P8, mais §15 (P4-08) et §16 (P5-15) existent déjà. Les choix de P8 sont en §17.
- D09 BR-FIN-040 liste six types de coût ; le schéma en compte neuf (`OEUFS`, `FRAIS_GENERAUX`, `PRODUCTION_TRANSFEREE`). La correction est faite dans l'incrément qui écrit les coûts (P8-05).
- Le dictionnaire `10-approvals-attachments-communication.md` (énumération `operation_type`) ne contient pas `CASH_TRANSFER_DISCREPANCY` ; complété avec `INVOICE_MISMATCH` en P8-03 (fait).
- `PROMPT-DE-REPRISE.md` §1 annonce « 123 permissions et 500 attributions » vérifiées par `db/tests/seed.test.ts` : depuis P8-03, **124 et 503** (à reporter à l'intégration).
- ADR-060 §9 corrigé en P8-03 : le lancement de P8 demandait des catégories à clé dérivée du code (ADR-031), mais l'enveloppe d'une commande exige un UUIDv7 comme `aggregate_id` ; une catégorie semée avec un UUID version 5 ne serait plus administrable. Les catégories ont donc un UUIDv7 semé une fois, synchronisé par son identifiant, comme les motifs.

## 5. Bases de données

- **Mutations sur la base de développement (13/10/2026).** Jusqu'à P8-11, les tests de mutation de P8-04 à P8-08 ont tourné sur `gic_agropelc_p8` au lieu de la base jetable. Le code volontairement faux y a laissé 32 lignes incohérentes, toutes datées des passes de mutation et toutes de données de test : 19 factures dont le payé ne suit pas les affectations, 7 paiements, 6 dépenses dont le coût net ne suit pas l'état. Le balayage `p8-invariants.test.ts` les signale sur cette base ; aucune n'est corrigée à la main (ce serait fabriquer des données). Depuis P8-12, les mutations tournent sur `gic_agropelc_p8m`, et la suite de clôture tournera sur une base neuve.

## 6. Revue adverse de P8-14

Quatre chercheurs (Sonnet, lecture seule), un par axe, puis deux vérificateurs sceptiques chargés de réfuter chaque constat, code à l'appui. Corrigés, chacun avec son test et sa mutation :

- **Lectures** (`b38c6be`) :
  - C1 : liste des dépenses pré-filtrée avant la pagination ;
  - C3 : dates impossibles en 400 ;
  - C2 et C7 : blocs de la vue d'ensemble selon le droit de leur lecture, créances par tranche ;
  - C4 : payé du BC réservé aux lecteurs des dettes ;
  - C6 : ordre des pertes sans valorisation ;
  - C8 : solde nul avant approbation ;
  - D6 : dettes de solde nul exclues ;
  - C5 : jeu `cash` étendu.
- **Fournisseurs** :
  - B1 : complément d'avance regroupé, au lieu d'une erreur prise pour transitoire et rejouée sans fin ;
  - B2 : décision d'écart refusée si l'accepté serait dépassé depuis la demande ;
  - B3 : l'auteur ne valide pas son document par la commande générique ;
  - B5 : références comparées sans casse ni ponctuation ;
  - B6 : produit et réception comptabilisée contrôlés ;
  - B8 : identifiants de facture en minuscules pour l'ordre des verrous.
- **Dépenses** : A3, un site comme objet de coût est celui de la dépense, et une ferme pour des frais d'une espèce.
- **Vérifications** :
  - D2 : facturé des BC (`INVOICED_QTY_DRIFT`) dans la réconciliation quotidienne ;
  - D3 : aucun plafond sur les écarts rapportés ;
  - D5 : compte payeur, objet de coût, mouvement d'origine d'un paiement annulé, comparaison sûre en présence de `NULL`.

D3 n'a pas de mutation détectable sans 51 écarts du même contrôle : c'est le retrait d'un plafond, vérifié à la lecture.

Alignés dans la documentation sans changement de code :
- A1 : objet de coût inconnu refusé même hors ligne (ADR-060 §6 aligné sur §8 et AV-352) ;
- A2 : sans politique `EXPENSE` active, aucune demande (ADR-060 §6 aligné sur AV-351) ;
- A4 : une politique `EXPENSE` doit nommer `finance.expense.approve` ;
- A5 : site de la dépense = site de la saisie (ADR-060 §10 aligné sur le dictionnaire).

Réfutés : B7 (accepté par ADR-061 §6 : la décision est refusée proprement, AV-363) et la moitié de B5 (l'appareil d'une commande n'est jamais nul).

**Pour la session principale (hors de P8, non corrigés ici)** :
- B4 : `approvals.request.approve` n'a aucune garde hors ligne. Une décision saisie hors ligne ou antidatée décaisse un paiement à la date de l'appareil, alors que les machines à états disent « aucune décision hors ligne ». Le correctif est générique (`buildDecisionCommandHandler`) et touche tous les types de décision.
- A7 : l'annulation d'une dépense de frais généraux et `production.overhead.allocate` ne partagent aucun verrou. Le même trou existe déjà dans `inventory.overhead.cancel` (P7). Le correctif est un verrou partagé sur la répartition du mois.
- A6 : un justificatif exigé entre 10 000 et 50 000 n'est jamais vérifié à l'arrivée du fichier. Cela relève d'une alerte asynchrone, en P9.

