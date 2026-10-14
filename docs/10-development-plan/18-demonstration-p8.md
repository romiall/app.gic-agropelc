# Démonstration de sortie de phase P8

> Plan §4 (P8 — Finance opérationnelle). Objectif métier : coûts, marges, dettes, dépenses (CM §31 à 33). Critères d'acceptation : AT-025, AT-040, AT-041. DoD : « marge d'un lot pilote validée par la Direction ».
>
> État arrêté le 13/10/2026, à la fin du code serveur de P8 (P8-01 à P8-15). La phase a été menée en parallèle de la session principale, sur la branche `claude/p8-finance` (worktree `.claude/worktrees/p8-finance`), avec des commits locaux seulement : **rien n'est poussé**. La session principale l'a intégré le 13/10/2026 : fusion, renumérotation sans trou des AV (numéros provisoires 350 à 366, devenus AV-263 à AV-279) et des ADR (060 à 062, devenus ADR-042 à ADR-044), mise à jour de `CLAUDE.md` et de `PROMPT-DE-REPRISE.md`. Suivi détaillé : [`17-suivi-p8.md`](17-suivi-p8.md).
>
> Les écrans de P8 (ECR-FIN-02 à 06, ECR-APP-05) ne sont pas commencés : ils attendent le feu vert de la session principale.

---

## 1. Aucun AV bloquant

La conception est arrêtée par trois ADR :
- [ADR-042](../decisions/ADR-042-depenses-p8.md) : dépenses ;
- [ADR-043](../decisions/ADR-043-factures-et-paiements-fournisseurs-p8.md) : factures et paiements fournisseurs, dettes, ordre des verrous ;
- [ADR-044](../decisions/ADR-044-couts-complets-et-marges-p8.md) : coûts complets, marges des lots, valeur des pertes, vue d'ensemble financière.

La revue adverse de P8-14 les a précisés sans les renverser.

Aucun AV n'est bloquant. Les 17 points ouverts par P8 (4 importants, 13 secondaires) restent `OUVERT` : leur valeur par défaut est implémentée, paramétrable quand la règle s'y prête ([`A-VALIDER.md`](../A-VALIDER.md)). Ils sont à passer en revue avec le porteur, en priorité les quatre importants :
- AV-265 : dépense hors ligne non conforme ;
- AV-267 : session de caisse pour une dépense du PDV ;
- AV-272 : avoir fournisseur ;
- AV-279 : chiffre d'affaires d'un lot.

| AV | Question | Classe | Défaut implémenté |
|---|---|---|---|
| AV-263 | Plafond d'approbation des dépenses par rôle | SECONDAIRE | Limite `maxAmountXaf` de l'approbateur vérifiée à la décision ; aucune valeur semée |
| AV-264 | Dépense au-delà du seuil sans politique `EXPENSE` | SECONDAIRE | Pas de validation ; politique `EXPENSE_DEFAULT` semée |
| AV-265 | Dépense hors ligne non conforme ; dépense hors ligne non payée | IMPORTANTE | Appliquée puis validée a posteriori avec motif ; saisie non payée admise ; objet de coût introuvable refusé |
| AV-266 | Plafond d'une petite dépense au PDV | SECONDAIRE | `finance.pos_expense_max_xaf` = 50 000 |
| AV-267 | Session de caisse pour une dépense du PDV | IMPORTANTE | Exigée comme pour un encaissement : refus en ligne, `CASH_SESSION_MISSING` hors ligne |
| AV-268 | Dépense rejetée après paiement | SECONDAIRE | Reclassée `NON_JUSTIFIEE`, responsabilité du déclarant |
| AV-269 | Dépense imputée à un site | SECONDAIRE | Avec espèce : frais généraux répartis (ferme) ; sans espèce : dépense directe du site |
| AV-270 | Catégories : type de coût, PDV, administration | SECONDAIRE | Type de coût par catégorie ; cinq catégories admises au PDV ; `NON_JUSTIFIEE` système |
| AV-271 | Facture sans bon de commande | SECONDAIRE | Mise en revue (`MISMATCH`), paramètre `finance.invoice_without_po_mode` |
| AV-272 | Avoir fournisseur | IMPORTANTE | Annulation motivée puis facture rectificative (même référence admise) |
| AV-273 | Échéance par défaut | SECONDAIRE | Saisie, sinon date + délai du fournisseur, sinon date de facture |
| AV-274 | Réception ou BC annulé après facturation | SECONDAIRE | Pas de garde côté achats ; écart lisible au rapprochement ; décision non informée refusée |
| AV-275 | Avances et affectation ultérieure | SECONDAIRE | Avance admise (paramètre) ; `.allocate`, complément regroupé |
| AV-276 | Paiement validé : date, factures payées entre-temps | SECONDAIRE | Décaissement daté de la décision ; décision refusée si une affectation n'est plus possible |
| AV-277 | Annulation d'un paiement enregistré | SECONDAIRE | Par la Direction, avec motif |
| AV-278 | Lecture des documents fournisseurs et de la vue d'ensemble | SECONDAIRE | `finance.payable.read`, portée `ALL` ; blocs de la vue d'ensemble selon le droit de leur lecture |
| AV-279 | Chiffre d'affaires d'un lot | IMPORTANTE | Ventes du lot et de ses produits d'abattage ; œufs exclus |

## 2. Ce qui est livré

| Incr. | Objet | Commit |
|---|---|---|
| P8-01 | Conception : ADR-042 à ADR-044, AV-263 à AV-279, D09 §17, backlog | `b48ea93` |
| P8-02 | Règles partagées (`packages/domain` : `expenses.ts`, `supplier-ledger.ts`) et schémas des commandes | `290f88a` |
| P8-03 | Schéma `finance` (6 tables, vue des dettes, déclencheurs), seed, dictionnaires | `b588b23` |
| P8-04 | Catégories de dépense | `cc09f77` |
| P8-05, P8-06 | Dépenses (en ligne, hors ligne, PDV, paiement, annulation) et décisions `EXPENSE` | `eb036be` |
| P8-07 | Factures fournisseurs : rapprochement sous verrou du BC, écart, contestation, avoir | `3558d5c` |
| P8-08 | Paiements fournisseurs : validation de la Direction avant décaissement, avances, annulation | `21b9851` |
| P8-09 | Lectures HTTP : dépenses, factures, paiements, dettes, payé du rapprochement de P6 | `3d316bd` |
| P8-10 | Jeux hors ligne : dépenses de l'auteur (`cash`), catégories (`catalog`), seuils (`me`) | `c7f40eb` |
| P8-11 | Coûts complets et marges : lot abattu, valeur des pertes, vue d'ensemble financière | `4dcc4a7` |
| P8-12 | Invariants, réconciliation quotidienne, ordre des verrous en concurrence | `2914381` |
| P8-13 | Tests d'acceptation | `8f3bf1d` |
| P8-14 | Revue adverse et correctifs | `b38c6be`, `8c1b775` |
| P8-15 | Clôture : suite complète sur base neuve, cette démonstration, matrice §17.10 | ce commit |

## 3. Critères d'acceptation automatisés

| AT | Ce qui est démontré | Test |
|---|---|---|
| AT-025 (WF-09) | Avec les vraies commandes de P6 : BC de 100 sacs approuvé puis envoyé ; réception de 98 livrés, 3 rejetés, 95 acceptés ; facture de 98 → `MISMATCH` et décision de la Direction ; dette ouverte ; paiement de 1 470 000 en attente, sans décaissement, que la Finance ne peut pas valider ; décaissé à la validation de la Direction, facture soldée, payé visible au rapprochement | `p8-acceptance.e2e.test.ts` |
| AT-040 | « Combien réellement encaissé ? » : sur `GET /finance/overview`, l'encaissé est distinct du CA et la créance vaut CA − encaissé | `p8-acceptance.e2e.test.ts`, `p8-costs.e2e.test.ts` |
| AT-041 | « Quelles pertes ? Combien a coûté cette production ? » : pertes d'un vrai lot par lot, par motif et par produit, en quantité et en valeur ; coût du lot inchangé par la mortalité (BR-PRD-013) | `production-acceptance.test.ts`, `p8-costs.e2e.test.ts` |
| AT-026 (part P8) | Exemple de la stratégie finance rejoué avec la litière de 140 000 en dépense validée et imputée au lot : coût 5 600 000, coût par tête 2 424, détail `DEPENSE_DIRECTE` de 140 000 | `production-acceptance.test.ts` |
| Marge d'un lot abattu | Lot abattu puis 1 000 pièces vendues : le CA des produits entre dans la marge du lot (`lotWithSales`, la composition de `GET /production/lots/:id`) | `production-acceptance.test.ts` |
| Journée de PDV hors ligne avec dépenses | Trois dépenses payées par la caisse pendant la session, dont deux en validation a posteriori ; attendu de la session diminué d'autant, écart nul ; décisions de la Finance (rejet après paiement reclassé) | `p8-acceptance.e2e.test.ts` |

## 4. Invariants et cohérence

- **INV-FIN-07** (payé d'une facture = Σ affectations actives) et **INV-FIN-08** (coût d'une dépense imputée) : `verifySupplierLedger` et `verifyExpenses`, branchées dans la réconciliation quotidienne `finance.cash.reconcile_daily`.
- La réconciliation contrôle aussi :
  - le mouvement de chaque dépense et de chaque paiement, sur le compte payeur ;
  - le mouvement d'origine d'un paiement annulé et son inverse ;
  - l'objet de coût de chaque écriture ;
  - le facturé des BC (`INVOICED_QTY_DRIFT`).
- Balayage de toute la base : `p8-invariants.test.ts`, qui couvre en plus l'accord entre documents en attente et demandes de validation.
- Ordre des verrous (ADR-038, ADR-043 §9) éprouvé en concurrence sur le vrai pipeline, sans aucun interblocage (`p8-lock-order.test.ts`). Six paires sont jouées :
  - deux paiements d'une même facture ;
  - deux factures d'une même ligne de BC ;
  - décision d'un écart contre une nouvelle facture du même BC ;
  - paiement contre annulation d'une facture ;
  - décision contre annulation d'un paiement ;
  - paiement contre annulation d'une dépense.
- Chaque écart est nommé par les vérifications : il est posé dans une transaction annulée, sans trace en base.

## 5. Suite complète sur une base neuve

Base `gic_agropelc_p8n`, créée le 13/10/2026 selon la procédure du lancement, migrée et semée.

| Suite | Résultat |
|---|---|
| Serveur (`apps/server`, toutes les suites) | **1 178 tests verts sur 1 178** (139 fichiers, 14 min) |
| Base de données (`db`, migrations, déclencheurs, seed) | 200 tests verts (21 fichiers) |
| Domaine (`packages/domain`) | 405 tests verts ; `expenses.ts` et `supplier-ledger.ts` couverts à 100 % |
| Contrats (`packages/contracts`) | 237 tests verts |

Typage (serveur, paquets, et PWA contre les paquets partagés modifiés), ESLint, frontières des modules (`dependency-cruiser`) et `check_refs.py` sont propres.

Pourquoi une base neuve : les bases `gic_agropelc_p8` et `gic_agropelc_p8m` gardent des données de test devenues incohérentes. Il y a d'une part des passes de mutation lancées sur la base de développement jusqu'à P8-11, d'autre part les anciens assistants de données d'achat de P8, qui écrivaient l'accepté d'un BC sans réception. Ce dernier défaut, corrigé en P8-14, faisait échouer les invariants de P6 balayés sur toute la base. Le suivi en donne le détail (§5 et §6).

## 6. Revue adverse (P8-14)

Quatre chercheurs (dépenses ; factures et paiements ; lectures, synchronisation et droits ; schéma et vérifications) et deux vérificateurs sceptiques ont produit 28 constats, dont aucun critique : 11 confirmés, 11 partiels, 6 réfutés ou acceptés.

Les corrections portent chacune un test, et 27 mutations sont détectées. Les plus notables :
- une avance ajoutée à une facture déjà réglée en partie par le même paiement : jusque-là une erreur prise pour transitoire, rejouée sans fin ;
- une approbation d'écart qui dépasserait l'accepté sans que l'approbateur le sache ;
- l'auto-approbation par la commande générique ;
- la liste des dépenses paginée avant le filtre de portée ;
- la vue d'ensemble qui exposait trésorerie et CA aux achats.

Le détail et les points laissés à la session principale sont au §6 du suivi.

## 7. Ce qui reste

- **Écrans de P8** : ECR-FIN-02 à 06 et ECR-APP-05, après le feu vert de la session principale.
- **DoD** : « marge d'un lot pilote validée par la Direction ». Le calcul est démontré sur l'exemple de la stratégie finance (AT-026) ; la validation sur un lot réel appartient au pilote.
- **Hors de P8**, signalés à la session principale (suivi §6) :
  - aucune garde hors ligne sur `approvals.request.approve` (B4, corrigé par la session principale dans son lot MP-07) ;
  - verrou commun entre l'annulation de frais généraux et leur répartition (A7) ;
  - arrivée des justificatifs entre 10 000 et 50 000 jamais vérifiée (A6, alerte de P9).
- **Alertes** : réception incomplète, factures échues, justificatifs manquants, en P9.
- **Revue des AV** de P8 avec le porteur (§1).

## 8. Rejouer

Depuis `apps/server`, avec `DATABASE_URL` et `SERVER_DATABASE_URL` pointant sur une base MySQL 8.4 migrée et semée (port 3307) :

```bash
npx vitest run test/p8-acceptance.e2e.test.ts test/production-acceptance.test.ts test/p8-costs.e2e.test.ts
```

```bash
npx vitest run test/p8-invariants.test.ts test/p8-lock-order.test.ts test/cash-ledger-reconciliation-job.test.ts
```
