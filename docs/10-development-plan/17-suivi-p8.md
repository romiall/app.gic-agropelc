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
| P8-08 | Paiements fournisseurs : validation de la Direction avant décaissement, affectations prévues, avances, annulation | _à venir_ | Fait : 5 tests serveur, 14 mutations détectées |
| P8-09 à P8-15 | Voir le backlog du plan | — | À faire |

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
| P8-09 | `procurement-api` (rapprochement) | payé (`paidXaf`) composé depuis `finance` | ADR-061 §3 |
| P8-11 | `production/application/public`, `production-api` | `lotStockLotIds`, CA de la marge de lot avec les produits d'abattage | ADR-062 §1, AV-366 |
| P8-11 | `inventory` : lecture et route | `lossValueSummary`, `GET /inventory/losses/summary` | ADR-062 §3 |

## 4. Écarts de documentation relevés (pour la session principale)

- `CLAUDE.md` §1 (ligne P6) et `11-demonstration-p6.md` disent AV-095 et AV-096 « ouverts » ; ils sont tranchés le 27/09/2026 dans le registre. AV-096 (dérogation d'emplacement de réception, option c) n'est pas construit : le code refuse toujours `RECEIPT_LOCATION_INVALID`. C'est hors du périmètre de P8.
- Le lancement de P8 demandait la section « §15 de D09 » pour les choix de P8, mais §15 (P4-08) et §16 (P5-15) existent déjà. Les choix de P8 sont en §17.
- D09 BR-FIN-040 liste six types de coût ; le schéma en compte neuf (`OEUFS`, `FRAIS_GENERAUX`, `PRODUCTION_TRANSFEREE`). La correction est faite dans l'incrément qui écrit les coûts (P8-05).
- Le dictionnaire `10-approvals-attachments-communication.md` (énumération `operation_type`) ne contient pas `CASH_TRANSFER_DISCREPANCY` ; complété avec `INVOICE_MISMATCH` en P8-03 (fait).
- `PROMPT-DE-REPRISE.md` §1 annonce « 123 permissions et 500 attributions » vérifiées par `db/tests/seed.test.ts` : depuis P8-03, **124 et 503** (à reporter à l'intégration).
- ADR-060 §9 corrigé en P8-03 : le lancement de P8 demandait des catégories à clé dérivée du code (ADR-031), mais l'enveloppe d'une commande exige un UUIDv7 comme `aggregate_id` ; une catégorie semée avec un UUID version 5 ne serait plus administrable. Les catégories ont donc un UUIDv7 semé une fois, synchronisé par son identifiant, comme les motifs.
