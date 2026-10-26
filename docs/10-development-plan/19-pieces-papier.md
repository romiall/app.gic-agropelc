# Lot « Pièces papier » (PP) — cadrage

> **Statut : planifié le 22/10/2026 ; PP-A livré pour seize pièces le 26/10/2026** ([ADR-048](../decisions/ADR-048-impression-des-pieces-papier.md), suivi au §7). PP-B à PP-E ne sont pas commencés. Le porteur a demandé que ce besoin entre dans le plan sans en faire la priorité du moment. Ce document garde la substance des douze choix du porteur ; le dossier d'origine (`pieces-papier/`, produit par une autre session le 20/10/2026) est versionné depuis le 26/10/2026.
> Classement des informations : **CONFIRMÉ** (dit par le porteur ou vérifié dans le dépôt), **DÉDUIT** (conséquence argumentée), **À VALIDER** (point `AV-nnn`, défaut paramétrable, aucun bloquant).

---

## 1. Le besoin

Deux phrases du porteur le résument.

1. **20/10/2026** — l'application imprime chaque opération sur papier blanc, dans la mise en page des pièces papier conçues pour GIC AGROPELC (mêmes rubriques, même charte : vert, orange doré, logo), depuis le téléphone ou l'ordinateur, y compris hors ligne. Quand l'application est indisponible, l'opération s'écrit sur une pièce numérotée, puis se **reporte** dans l'application. **CONFIRMÉ**.
2. **22/10/2026** — toutes les opérations doivent être imprimables, et une opération que l'on **consulte** doit aussi apparaître en mise en page de pièce. **CONFIRMÉ**.

Le dossier d'origine ajoute qu'à défaut de mise en page identique la charte doit être respectée (**DÉDUIT**, à confirmer par le porteur : AV-309, AV-323).

Les exigences correspondantes sont REQ-301 à REQ-309 ([`../01-functional/00-exigences-sources.md`](../01-functional/00-exigences-sources.md) §3), leurs lignes dans la [matrice](02-matrice-tracabilite.md) §15bis. Le Contexte métier et le Prompt maître ne sont pas modifiés.

## 2. Les douze choix du porteur (20/10/2026)

| N° | Sujet | Choix | Instruction |
|---|---|---|---|
| D1 | Impression | Page complète sur papier blanc, depuis la PWA (impression par le navigateur, hors ligne comprise) ; le numéro imprimé est celui de l'application | REQ-301, AV-309, AV-310 |
| D2 | Numéro de la pièce papier | Un champ « pièce papier » commun à toutes les opérations | REQ-303, AV-308 |
| D3 | Facture client | Hors application pour l'instant ; **levé le 26/10/2026** : la facture est imprimée par l'application, modèle validé par le comptable | REQ-309, AV-041, AV-451 |
| D4 | Journal de caisse | Un journal par compte de trésorerie, imprimé par l'application ; la feuille vierge reste le secours | REQ-304, AV-311 |
| D5 | Commerciaux | La même feuille de caisse, case « caisse du commercial » ; plus de comptage par coupures | REQ-304, AV-311 |
| D6 | Pointage | Table « présence » simple, alimentée chaque semaine à partir de la fiche PT | REQ-306, AV-313 |
| D7 | Registre des carnets | Registre papier, contrôle de continuité par les références saisies | REQ-305, AV-312 |
| D8 | Bilan hebdomadaire | Nouvelle fiche papier (BH) et écran dans l'application | REQ-307, AV-314 |
| D9 | Veille marché | Rubriques structurées sur la fiche de visite et dans la visite | REQ-308, AV-315 |
| D10 | Profil client | Rubriques ajoutées à la fiche de visite et au compte client | REQ-308, AV-316 |
| D11 | Entrée des données | Écran de report pour le courant, import par lots pour l'historique | REQ-303, AV-317, AV-072 |
| D12 | Délai de report | 24 h conseillées, 72 h au maximum (valeurs actuelles, paramétrables) | REQ-303, AV-078 |

Le porteur ne demande pas que les pièces soient alignées sur l'application à tout prix : il demande que les informations utiles puissent y entrer plus tard. **CONFIRMÉ.**

## 3. Les 25 pièces et leur rattachement à l'application

Les pièces sont des carnets à souches autocopiants (série « Argent » en A5 paysage, série « Commande et livraison »), des blocs, des registres et de la papeterie ; la note de présentation du dossier d'origine les décrit une par une. Le tableau dit seulement **ce que l'application en fait**.

| Code | Pièce | Opération de l'application | Table source | `local_ref` | Lot |
|---|---|---|---|---|---|
| BV | Bon de vente | vente | `sales_sales` | oui | PP-A |
| RE | Reçu d'encaissement | encaissement | `sales_customer_payments` | oui | PP-A |
| BD | Bon de décaissement | dépense, paiement fournisseur, avance (paiement non affecté), remboursement client (mise à jour de `sales_customer_payments` et mouvement `REFUND`, en ligne par la Finance, sans table propre) | `finance_expenses`, `finance_supplier_payments` | dépense oui ; paiement fournisseur non | PP-A |
| RF | Remise de fonds | remise de fonds | `finance_cash_transfers` | oui | PP-A |
| BL | Bon de livraison | livraison | `sales_delivery_notes` | oui | PP-A |
| CC | Bon de commande client | commande client | `sales_sales_orders` | oui | PP-A |
| BC | Bon de commande fournisseur | bon de commande | `procurement_purchase_orders` | oui | PP-A |
| BR | Bon de réception | réception | `procurement_goods_receipts` | oui | PP-A |
| BT | Bon de transfert | transfert de stock | `inventory_stock_transfers` | oui | PP-A |
| DA | Demande d'achat | demande d'achat | `procurement_purchase_requests` | oui | PP-A |
| FP | Fiche de perte ou de consommation | perte, mortalité, consommation d'intrant | `inventory_loss_declarations`, `inventory_consumptions` | perte oui ; consommation non | PP-A |
| FI | Fiche d'inventaire | inventaire | `inventory_inventory_counts` | oui | PP-A |
| FL | Suivi de lot de production | saisie du jour d'un lot (mortalité, aliment, pesée, collecte d'œufs) | `inventory_loss_declarations` (mortalité), `inventory_consumptions` (aliment), tables de pesée et de collecte | mortalité oui ; aliment, pesée et collecte non | PP-A |
| FJC | Feuille journalière de caisse | journal d'un compte de trésorerie pour un jour (28 lignes) | `finance_cash_movements` (lecture à étendre : AV-311) | — | PP-A |
| JE | Journal des encaissements | état des encaissements par mode de paiement (30 lignes) | `sales_customer_payments` (lecture des encaissements, hors transferts et remboursements) | — | PP-A |
| VC | Fiche de visite commerciale | visite, profil du client, veille marché | `crm_visits` | non | PP-D |
| PT | Présence et pointage | présence hebdomadaire (secours du pointage numérique) | à créer | — | PP-E |
| BH | Bilan hebdomadaire du commercial | bilan hebdomadaire | à créer | — | PP-E |
| RC | Registre de suivi des carnets | registre papier ; contrôle de continuité dans l'application | aucune | — | PP-B |
| FA | Facture | facture d'une vente à un client nommé (26/10/2026 ; prix TTC, TVA à 0, AV-041 ; régime et mention : AV-451) | `sales_sales` | oui | PP-A |
| EL | Papier à en-tête | papeterie, aucune impression par l'application | — | — | — |
| BN-G, BN-R, BN-T | Blocs-notes général, de réunion, de terrain | papeterie | — | — | — |
| CV | Couvertures de carnet | papeterie | — | — | — |

Constats vérifiés dans le dépôt le 22/10/2026 (**CONFIRMÉ**) :

- Le reçu d'une vente est déjà imprimable : bouton qui appelle `window.print()` (`apps/pwa/src/features/sales/SaleDetailScreen.tsx`) et feuille `@media print` (`apps/pwa/src/app/app.css`), ECR-VEN-05. Le mécanisme est à généraliser, pas à inventer. Depuis le 26/10/2026, ce bouton est remplacé par le bon de vente (ADR-048).
- `local_ref varchar(20)` existe sur 13 tables : `sales_sales`, `sales_sales_orders`, `sales_customer_payments`, `sales_delivery_notes`, `sales_sale_cancellations`, `procurement_purchase_requests`, `procurement_purchase_orders`, `procurement_goods_receipts`, `inventory_stock_transfers`, `inventory_loss_declarations`, `inventory_inventory_counts`, `finance_expenses`, `finance_cash_transfers`. Il n'existe pas sur `crm_visits`, `fieldwork_work_sessions`, `finance_cash_sessions`, `finance_supplier_payments`, `finance_supplier_invoices`, `inventory_consumptions`, ni sur les tables de pesée et de collecte d'œufs. Ce champ est, par convention, une référence d'appareil (`{CODE_APPAREIL}-{seq6}`, [`../03-data/01-identifiants-et-conventions.md`](../03-data/01-identifiants-et-conventions.md) §1.4) ; huit commandes l'acceptent (vente, commande, encaissement, livraison, réception, demande d'achat, dépense, remise de fonds), la PWA ne l'envoie dans aucune charge utile, il est unique par appareil (hors bons de commande fournisseur) et immuable. Le numéro d'un carnet, lui, est **saisi à la main** : c'est l'objet d'AV-308.
- Dans la PWA, trois écrans seulement sont des écrans de détail nommés comme tels : la vente, la commande client et la session de caisse (`SaleDetailScreen`, `OrderDetailScreen`, `SessionDetail`). Les autres opérations sont consultables par liste, suivi ou fiche : savoir lesquelles n'ont pas de vue de détail suffisante pour porter une pièce est la première tâche de PP-0 (**À VÉRIFIER**).
- Les mouvements d'un compte de trésorerie sont dans `finance_cash_movements` ; `GET /cash-accounts/{id}/movements` existe mais ne rend ni numéro de pièce, ni libellé, ni mode de paiement, ni session : il est à étendre (AV-311). Le jeu hors ligne `cash` ne porte aucun mouvement. La session de caisse ne concerne que la caisse d'un point de vente ; la caisse d'un commercial n'a pas de session.
- Le compte client a `credit_allowed`, `credit_limit_xaf`, `payment_terms_days`, `business_activity`, `category_id` ; il n'a ni produit d'intérêt, ni potentiel par jour, ni mode de paiement habituel. La visite n'a rien sur le fournisseur ou le prix du concurrent. Il n'existe ni bilan hebdomadaire ni présence du personnel non commercial.
- `communication.internal_notes` est la **note de direction** (de la direction vers une audience) : mauvais sens pour un bilan de commercial.

## 4. Conception cible (DÉDUIT, à fixer par l'ADR de PP-0)

> **Fixée le 26/10/2026 par [ADR-048](../decisions/ADR-048-impression-des-pieces-papier.md)**, qui remplace le point 1 : la pièce n'est pas un composant redessiné, elle reprend à l'identique le balisage et la feuille de style du dossier papier, dans un document autonome (`iframe`) imprimé par `contentWindow.print()`. Les points 2, 3 et 7 sont mis en œuvre ; les points 4 à 6 restent à faire.

1. **Une pièce, un composant.** Chaque type de pièce est un composant de la PWA qui reproduit ses rubriques, alimenté par les données **locales** de l'opération (IndexedDB), donc utilisable hors ligne. Le même composant sert à **consulter** l'opération (REQ-302) et à l'**imprimer** (`window.print()`, `@page` A5 paysage, A5 portrait, A4 portrait ou A4 paysage selon la pièce). La souche n'est pas imprimée : le corps occupe la feuille. Aucune commande métier ni migration : imprimer, c'est lire (seul un marqueur local de réimpression est écrit sur l'appareil, AV-310).
2. **Logique partagée dans `packages/domain`** : le montant en lettres (reçus, bons de caisse) est une fonction pure en français (règle 6 de `CLAUDE.md`), identique sur l'appareil et le serveur.
3. **Numéro imprimé** : `doc_number` s'il est connu, sinon le numéro de la pièce papier saisi (AV-308), sinon `local_ref` hors ligne. Réimpression : mention « DUPLICATA » avec la date (marqueur local ; ni un autre appareil ni une impression hors ligne avant l'envoi ne sont reconnus, AV-310). Opération annulée : bandeau « ANNULÉE » (ADR-006 : rien ne disparaît). Détail et défauts : AV-310.
4. **Rubriques vérifiées contre le papier** : un test compare les rubriques de chaque composant à `CORRESPONDANCE-APPLICATION.xlsx` (rubrique papier, champ de la commande, référentiel, seuil), pour que la ressaisie se fasse « sans interprétation ». Le classeur n'est pas suivi par git : son extraction (feuille « Champs ») est à verser dans le dépôt en PP-0, sans quoi le test ne tourne pas en CI.
5. **Report d'une pièce papier** : écran par type de pièce, champs dans l'ordre de la pièce, heure métier = heure écrite sur la pièce (`occurred_at`), numéro de la pièce, contrôle des doublons (signalés, jamais rejetés, BR-SYN-007), photo de la pièce en pièce jointe (ADR-012, ADR-046), annulation par contre-écriture. Tout passe par les **commandes existantes** (règle 3), dans la fenêtre d'antidatage d'AV-078.
6. **Import par lots** : extension d'AV-072 (modèles CSV). Fichier modèle, zone d'attente et validation avant chargement, clé d'import par ligne pour l'idempotence, passage par les commandes existantes. L'Excel `fiches-terrain/commercial/` est un premier jeu de test.
7. **Pièges connus** (revus par AV-309) : polices Windows des gabarits papier non redistribuables, donc une police libre embarquée ; logo dans le pré-cache du service worker ; lisibilité en noir et blanc ; support limité de `@page size` sur iOS ; données personnelles imprimées (nom, téléphone du client).

## 5. Lots

Tailles **indicatives**. Dépendances : le lot ne démarre qu'avec ses AV tranchés ou leur défaut accepté.

| Lot | Contenu | Dépend de | Taille | Schéma |
|---|---|---|---|---|
| **PP-0** Instruction | AV-308 à AV-312, AV-317, AV-323 et AV-324 relus avec le porteur ; ADR « impression des pièces » ; inventaire des opérations sans vue de détail et des opérations sans pièce propre ; extraction versionnée de `CORRESPONDANCE-APPLICATION.xlsx` ; tests d'acceptation `AT-*` à rédiger ; liste des pièces à imprimer en premier | — | S | aucun |
| **PP-A** Impression et consultation | Socle (police libre, `@page`, logo en cache, montant en lettres, mentions duplicata et annulée) ; BV, RE, BD, BL, CC, RF, BR, BT d'abord, puis BC, DA, FP, FI, FL ; journal de caisse FJC et JE (AV-311) ; action « Voir la pièce / Imprimer » sur chaque détail d'opération | PP-0 | L | aucun |
| **PP-B** Report | Numéro de la pièce papier (AV-308), écran « Reporter une pièce papier », contrôle de continuité des carnets (AV-312), application de la fenêtre d'antidatage d'AV-078 aux commandes concernées | PP-0 | L | migrations (modules propriétaires) |
| **PP-C** Import par lots | Modèles d'import, zone d'attente, validation, rapport d'erreurs, clé d'import (AV-317, AV-072) | PP-B, jeu de données GIC | L | tables d'attente |
| **PP-D** CRM | Veille marché dans la visite (AV-315), profil commercial du client (AV-316), fiche VC | PP-0 | M | migrations CRM, jeu `crm_activity` |
| **PP-E** Présence et bilan | Présence du personnel (AV-313), bilan hebdomadaire (AV-314), fiches PT et BH | PP-0, coordination avec la session P9 | M | migrations |

**Ordre recommandé (DÉDUIT, à valider avec le porteur).** Le secours papier ne vaut que si l'on sait ensuite **reporter** : PP-A (imprimer) et PP-B (reporter) forment le minimum à avoir avant de distribuer des carnets aux sites. PP-C, PP-D et PP-E peuvent suivre le pilote. Le porteur a dit le 22/10/2026 que ce lot n'est pas la priorité ; il n'a donc pas de date, et le choix de son rang revient au porteur (suite du projet, `PROMPT-DE-REPRISE.md` §5).

**Hors périmètre.** La papeterie (EL, BN, CV) ; l'impression d'un carnet ou d'une souche ; la paie à partir des présences (défaut d'AV-313, à confirmer) ; l'enregistrement des numéros de carnet distribués (le registre RC reste sur papier, sauf si le porteur retient AV-312 (b)).

## 6. Règles de travail du lot

- **Coordination.** PP-E touche l'analytique (`analytics.f_attendance`, bilans) : plages d'AV, d'ADR et de migrations réservées de la session P9 (`CLAUDE.md` §1) à respecter. La session principale garde les migrations `20261102` à `20261130` ; au-delà, voir la plage de la session P9 et en convenir avant d'écrire une migration.
- **Pas d'écriture directe.** Report et import passent par les commandes idempotentes ; un fait déjà saisi n'est pas ressaisi (doublon signalé).
- **Points légaux** (facture, TVA, mentions, conservation) : à valider avec le comptable, hors périmètre du développement ; AV-041 reste en vigueur et pourrait se rouvrir avec la facturation électronique annoncée pour 2026.
- **Définition de terminé** d'un lot : exigences REQ-301 à REQ-309 concernées vérifiées dans la matrice, `AT-*` automatisés, `check_refs` propre, démonstration dans ce document (§7).

## 7. Suivi

| Date | Lot | État |
|---|---|---|
| 22/10/2026 | Cadrage | Fait : exigences REQ-301 à REQ-309, AV-308 à AV-317, matrice §15bis, plan §4, ce document. Aucun code. |
| 26/10/2026 | PP-0 (en partie), PP-A | Fait : [ADR-048](../decisions/ADR-048-impression-des-pieces-papier.md) ; moteur de rendu fidèle (charte copiée à l'octet, balisage de `_generation/lib.mjs` porté en TypeScript, polices libres de repli, logo en pré-cache) ; montant en lettres dans `packages/domain` ; seize pièces imprimables et consultables depuis leur écran : BV, FA, RE, CC, BL, BD, RF, FJC, JE, DA, BC, BR, BT, FI, FP, FL ; duplicata, annulée, pagination ; comparaison visuelle des seize pièces aux aperçus du porteur (`pieces-papier/apercu/`). Décisions du porteur : mise en page exacte, facture comprise, pas de souche, sous-titre du bon de vente vide. **Reste** : AV-451 (facture), extension de la lecture des mouvements (AV-311), identité en paramètres (AV-324), comparaison automatisée à `CORRESPONDANCE-APPLICATION.xlsx`, opérations sans pièce propre (AV-323), `AT-*`, vérification sur imprimante et sur téléphone. |
