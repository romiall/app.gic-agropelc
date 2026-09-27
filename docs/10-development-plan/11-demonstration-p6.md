# Démonstration de sortie de phase P6

> Plan §4 (P6 — Approvisionnement). Critère : « Chaîne Besoin → Réception opérationnelle ». État arrêté le 27/09/2026, à la fin des éléments de code de P6 (P6-01 à P6-08). Développement local (MySQL 8.4 sur le poste, ADR-024 §5) ; commits locaux, rien n'est poussé vers le dépôt distant à cette date.
>
> P6 a été avancée avant P4 et P5 : P4 reste bloquée par AV-024 et AV-025 (règle R11), P5 dépend de P4, et P6 ne dépend que de P2.

---

## 1. Aucun AV bloquant

P6 n'a aucun AV **bloquant**. Les AV listés en prérequis (AV-051 à AV-054) et ceux qui touchent la phase restent `OUVERT` ; leur valeur par défaut est implémentée de façon **paramétrable** ou réversible, sans être présentée comme une décision :

| AV | Défaut implémenté | Où |
|---|---|---|
| AV-051 | Toute DA validée (`PURCHASE_REQUEST`) ; BC approuvé d'office jusqu'au paramètre `procurement.po_approval_threshold_xaf` (500 000 XAF), validation de la Direction au-delà | `request-commands.ts`, `order-commands.ts` |
| AV-052 | Réception sans BC autorisée : fournisseur actif, prix déclaré et photo obligatoires ; stock immédiat, revue `RECEIPT_WITHOUT_PO` du responsable des achats | `receipt-commands.ts` |
| AV-053 | Tolérance nulle par défaut (paramètre `procurement.receipt_over_tolerance_pct`) ; acceptation au-delà refusée en ligne (`OVER_RECEIPT`) | `receipt-commands.ts` |
| AV-054 | Quantités rejetées hors stock : seules les acceptées entrent (le traitement de l'avoir sur facture relève de P8) | `receipt-commands.ts` |
| AV-037 | Photo du bon de livraison exigée sans BC et à partir du paramètre `procurement.receipt_photo_threshold_xaf` (100 000 XAF) | `packages/domain` (`receiptPhotoRequired`) |
| AV-042 | CMUP recalculé à chaque entrée de réception, au prix du BC ou au prix déclaré | `inventory` (`recordStockMove`) |
| AV-095 (ouvert en P6-05) | Réception hors ligne dépassant le reliquat : quarantaine (paramètre `procurement.offline_over_receipt_mode` = `QUARANTINE`) ; mode `APPLY_WITH_REVIEW` implémenté et testé | `receipt-commands.ts` |
| AV-096 (ouvert en P6-05) | Dérogation d'emplacement de réception non ouverte : `RECEIPT_LOCATION_INVALID`, réception au site du BC puis transfert | `receipt-commands.ts` |

Les choix d'implémentation laissés libres par les règles sont **DÉDUITS** et documentés dans [D08 §15](../01-functional/domaines/D08-APP-approvisionnement.md).

## 2. Tests d'acceptation et invariants

### 2.1 Tests d'acceptation de la phase (plan §4 : AT-023, 024)

| AT | Scénario | Où | État |
|---|---|---|---|
| AT-023 | BC de 100, livré 98, rejeté 3 : stock +95, reliquat 5, CMUP recalculé | `procurement-receipt-commands.test.ts` (stock, reliquat, statut du BC, coût d'entrée ; CMUP recalculé par une seconde entrée, 15 000 → 16 000) ; `procurement-receipt-day.e2e.test.ts` (même règle hors ligne) | Vert |
| AT-024 | Même bon de livraison réceptionné deux fois : seconde réception en quarantaine, sans effet stock | `procurement-receipt-commands.test.ts` (quarantaine, rejet, puis réception distincte confirmée) ; `procurement-receipt-day.e2e.test.ts` (deux appareils hors ligne) | Vert |

Scénarios de bout en bout du plan : `procurement-receipt-day.e2e.test.ts` — « réception partielle avec rejet ; doublon en quarantaine ». Deux magasiniers du même magasin téléchargent le BC livrable, le réceptionnent hors ligne (un rejet partiel, un bon ressaisi, une livraison concurrente qui dépasse le reliquat), envoient leur file par `/sync/push`, la renvoient sans doublon ; le responsable des achats tranche ; le BC reçu quitte les appareils.

### 2.2 Invariants `INV-APP-*` et `INV-STK-12`

| INV | Où | État |
|---|---|---|
| INV-APP-01 | `db/tests/procurement-documents.test.ts` (colonne générée, `CHECK`) ; `packages/domain` (`receiptLineQuantities`) ; balayage `procurement-invariants.test.ts` | Vert |
| INV-APP-02 | `procurement-receipt-commands.test.ts` (refus en ligne, excédent tracé hors ligne) ; balayage (accepté du BC = Σ réceptions comptabilisées, excédent = dépassement, trace `over_receipt_qty_base`) | Vert |
| INV-APP-03 | `procurement-receipt-commands.test.ts`, `procurement-receipt-day.e2e.test.ts` ; balayage (aucun mouvement pour une réception en quarantaine ou rejetée) | Vert |
| INV-APP-04 | `db/tests/procurement-documents.test.ts` (déclencheur) ; balayage (tentative d'augmentation sur un BC envoyé) | Vert |
| INV-STK-12 | `procurement-receipt-commands.test.ts` ; balayage (Σ entrées `PURCHASE_RECEIPT` d'une ligne = accepté ; réception annulée inversée au même coût) | Vert |

Le balayage vérifie aussi la couverture des DA (quantité commandée = Σ lignes de BC actives, BR-APP-004) et les totaux (BC, valeur acceptée des réceptions).

### 2.3 Suites complètes (27/09/2026)

`packages/domain` 153 tests (15 fichiers) ; `packages/contracts` 155 tests ; `apps/server` 375 tests (58 fichiers, exécution séquentielle, 2 min 20 s) ; `db` 70 tests (8 fichiers). `typecheck`, `check:boundaries` (266 modules), `lint` (aucune erreur ; l'avertissement préexistant de la PWA), `format:check`, `python3 docs/_tools/check_refs.py` verts.

## 3. Ce qui est livré

| Élément | Contenu |
|---|---|
| P6-01 `packages/domain` | Quantités d'une ligne de réception, reliquat, dépassement avec tolérance, statuts d'un BC et d'une DA, montants arrondis au franc, seuil d'approbation, valeur acceptée ; puis (P6-05) exigence de photo |
| P6-02 `db` | Migrations des DA, BC, réceptions et lignes : accepté calculé par la base, unicité du bon de livraison comptabilisé, INV-APP-04 par déclencheur, immuabilités ; paramètres d'achat ; types d'opération de validation |
| P6-03 DA | `procurement.request.submit`, `.cancel`, `.close` ; décision `PURCHASE_REQUEST` |
| P6-04 BC | `procurement.order.create`, `.update` (brouillon), `.submit` (seuil), `.mark_sent`, `.close_remaining`, `.cancel` ; décision `PURCHASE_ORDER` ; couverture des DA |
| P6-05 réceptions | `procurement.receipt.record` (hors ligne), `.request_cancellation` ; décisions `RECEIPT_WITHOUT_PO`, `RECEIPT_QUARANTINE`, `RECEIPT_CANCELLATION` ; lots fournisseur ; photo ; dépassement du reliquat (deux modes) |
| P6-06 lectures | `GET /purchase-requests`, `/purchase-requests/{id}`, `/purchase-orders`, `/purchase-orders/{id}`, `/purchase-orders/{id}/matching`, `/receipts`, `/receipts/{id}` — portée par site, refus audités, valeurs masquées sans `inventory.valuation.read` |
| P6-07 hors ligne | Jeu `procurement` : BC livrables du site avec reliquats, DA de l'utilisateur, réceptions des 30 derniers jours, fournisseurs actifs ; `SCOPE_EXIT` des BC qui ne sont plus livrables et des fournisseurs désactivés |
| P6-08 intégrité | Balayage des invariants ; parcours de réception hors ligne à deux appareils |
| Plateforme | `approvals` : refus motivé d'une décision par le module propriétaire (`ApprovalDecisionRefused`, décision rejetée et annulée) ; contexte de décision enrichi du demandeur et du résumé. `inventory` : API publique des lots fournisseur (`ensureSupplierLot`) et des emplacements virtuels. `packages/domain` : un jour métier inexistant (`2026-02-30`) est refusé au lieu d'être reporté au mois suivant |
| RBAC | Aucun changement : les permissions `procurement.*` existaient depuis le seed P0-05 |

Décisions DÉDUITES à connaître (détail : D08 §15) :

- **Quarantaine plutôt qu'excédent hors ligne** (AV-095) : aucune entrée de stock fantôme ; la décision comptabilise la réception réelle à son heure métier.
- **Réception distincte** : une réception en quarantaine pour bon de livraison déjà comptabilisé, validée, est marquée `distinct_note_confirmed` et sort de l'unicité du bon (nouvelle migration).
- **Refus d'une décision** : une annulation dont le stock a été consommé est refusée (`STOCK_UNAVAILABLE`), la demande reste en attente ; de même pour la validation d'une quarantaine sur un BC non envoyé ou annulé.
- **Lectures** : un seul droit, `procurement.order.read`, pour les DA, BC et réceptions ; prix et coûts masqués sans `inventory.valuation.read` (RC-05).
- **Jeu hors ligne** : aucun prix ni coût ; les utilisateurs affectés globalement travaillent en ligne.

## 4. Ce qui n'est pas livré (signalé, pas silencieux)

| Élément | Raison | Déclencheur |
|---|---|---|
| Écrans PWA ECR-APP-01 à 05 | Même précédent que P0-11 à P3 : aucun écran métier construit, les API sont prêtes | Session dédiée aux écrans |
| Quantités facturées et payées, rapprochement BC / réception / facture (WF-09 avec facture, AT-025) | Module `finance` : le rapprochement expose déjà `invoicedQtyBase` (0) et `paidXaf` (`null`) | P8 |
| Réduction d'une ligne d'un BC envoyé et annulation ligne à ligne (BR-APP-006) | Seuls la modification du brouillon, la clôture du reliquat d'un BC partiellement reçu et l'annulation d'un BC sans réception existent | Premier besoin en exploitation |
| Retour fournisseur d'une marchandise déjà consommée ou mélangée (extension citée par BR-APP-013) | Le type de mouvement `SUPPLIER_RETURN` existe ; aucun document de retour | Extension, sur demande |
| Recalcul du CMUP à l'annulation d'une réception | Un mouvement inverse reprend le coût d'origine sans recalculer le CMUP (stratégie stock §9, même règle que tout inverse) | Revue de la valorisation (AV-042, P8) |
| Alerte `RECEIPT_INCOMPLETE` (BR-APP-015) | Module `communication` absent ; les reliquats et rejets sont lisibles (`/purchase-orders`, `/matching`) | P9 |
| Mise en place d'un lot à la réception d'animaux vivants (BR-APP-016, BR-PRD-004) | Module `production` | P7 |
| Dérogation d'emplacement de réception | AV-096 ouvert, défaut « non ouverte » | Décision AV-096 |
| DoD « tous les achats d'intrants du pilote passent par l'outil » | Exige les écrans et un déploiement | Déploiement (R3) |

Risque connu relevé pendant P6-07 : les tests de projection du jeu `crm_activity` (P3-07) écrivent des visites datées du 06/10/2026, alors que la fenêtre de 90 jours est évaluée par la base à l'heure réelle ; ces assertions échoueront à partir de début janvier 2027. Les tests de P6 datent leurs données par rapport à l'heure réelle ; ceux de P3 sont à aligner (tâche courte, sans effet sur le code de production).

## 5. Prochaine étape

**P7** (Production) dépend de P2 et P6, toutes deux terminées côté code ; aucun AV bloquant n'est listé pour P7 dans le registre (AV-005 est IMPORTANTE). **P4** reste bloquée par AV-024 et AV-025 (règle R11), et **P5** dépend de P4 ; **P8** dépend de P4.
