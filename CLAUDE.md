# CLAUDE.md — règles de travail sur le projet GIC AGROPELC

Ce fichier s'adresse à toute session Claude Code et à tout développeur qui travaille dans ce dépôt. Il est court : le détail est dans `docs/`.

## 1. État du projet

- **Cadrage terminé** : le référentiel d'ingénierie complet est dans [`docs/`](docs/README.md) (39 sections du Prompt maître §48, puis l'audit de cohérence).
- **Phase P0 : code terminé** (P0-01 à P0-16, 25/09/2026 ; AV-089 et AV-073 tranchés le 24/09/2026, voir [`docs/A-VALIDER.md`](docs/A-VALIDER.md) §3). Restent P0-17 (`staging` déployé) et le volet matériel de P0-18 (démonstration sur appareil physique), hors de portée d'une session sans accès Hostinger — voir [`docs/10-development-plan/07-demonstration-p0.md`](docs/10-development-plan/07-demonstration-p0.md).
- **Phase P1 : code terminé** (P1-01 à P1-06, 26/09/2026 ; aucun AV bloquant). Catalogue, moteur de tarification partagé (`packages/domain`), fournisseurs (fiche). Restent les écrans PWA d'administration (ECR-PRX-01 à 03) et l'import CSV (AV-072, données GIC requises) — voir [`docs/10-development-plan/08-demonstration-p1.md`](docs/10-development-plan/08-demonstration-p1.md). Backlog et structure : [`docs/10-development-plan/06-passage-au-developpement.md`](docs/10-development-plan/06-passage-au-developpement.md). GitHub est la source de vérité : chaque incrément est commité et poussé ; l'environnement local ne sert qu'à récupérer le dépôt et exécuter/tester. Aucun déploiement Hostinger n'est requis pour P0 à P3 (ADR-024 §5).
- **Phase P2 : code terminé** (P2-01 à P2-07, 26/09/2026 ; aucun AV bloquant ; AV-038 et AV-094 tranchés le même jour). Registre de stock en partie double, transferts, pertes, consommations, seuils, inventaires, lectures `GET /stock…` avec portée par emplacement, jeux hors ligne `stock`/`transfers`/`counts`, réconciliation quotidienne. Restent les écrans PWA, l'inventaire d'ouverture (AV-072), la réception sans document, le rapprochement tardif et les alertes — voir [`docs/10-development-plan/09-demonstration-p2.md`](docs/10-development-plan/09-demonstration-p2.md).
- **Phase P3 : code terminé** (P3-01 à P3-08, 27/09/2026 ; aucun AV bloquant). Comptes clients (doublons, fusion, pipeline, réaffectation, conversion prête pour P4), visites, interactions, objectifs, pointage et dérogations, lectures `GET /customers…`, `/work-sessions`, jeux hors ligne `customers`/`crm_activity`/`fieldwork`, invariants INV-CRM et INV-TER. Restent les écrans PWA, les alertes (P9), l'historique des géorepères et les données initiales — voir [`docs/10-development-plan/10-demonstration-p3.md`](docs/10-development-plan/10-demonstration-p3.md).
- **Phase P6 : code terminé** (P6-01 à P6-08, 27/09/2026 ; aucun AV bloquant ; AV-095 et AV-096 ouverts, défauts paramétrables). Avancée avant P4 et P5. Demandes d'achat, bons de commande (seuil d'approbation), réceptions (livré, rejeté, accepté ; quarantaine du doublon et du dépassement hors ligne ; réception sans BC en revue ; annulation par mouvements inverses), lectures `GET /purchase-requests…`, `/purchase-orders…` (dont `/matching`), `/receipts…`, jeu hors ligne `procurement`, invariants INV-APP et INV-STK-12. Restent les écrans PWA, la facture et le paiement (P8), l'alerte de réception incomplète (P9) — voir [`docs/10-development-plan/11-demonstration-p6.md`](docs/10-development-plan/11-demonstration-p6.md).
- **Phase P7 : code terminé** (P7-01 à P7-13, 30/09/2026 ; aucun AV bloquant ; AV-116 à 119 et AV-121 ouverts, défauts paramétrables). Lots de cinq types (mise en place interne ou par achat direct, naissance, transfert, sevrage, clôture), saisie du jour (mortalité validée `MORTALITY`, intrants, pesées, observations), collectes par calibre, incubation, abattage multi-produits, frais généraux répartis (ADR-026), coût restant et productions au coût standard (ADR-027), lectures `GET /production/…` avec indicateurs, jeu hors ligne `production`, invariants INV-PRD, INV-OEU-01, INV-INC-01. Restent les écrans PWA, le CA et la marge des lots (P4), les dépenses directes (P8), les alertes (P9) — voir [`docs/10-development-plan/12-demonstration-p7.md`](docs/10-development-plan/12-demonstration-p7.md). Ensuite : P4 (en cours), reprise de P6 pour AV-096 (réception hors site après validation), P5 et P8.
- **Phase P4 : en cours** (depuis le 30/09/2026). Décisions du porteur du 30/09 (AV-026 à 028, 030, 031, 034, 041, 056, 063, AV-126 à 130) et conception [ADR-028](docs/decisions/ADR-028-commande-vente-livraison-p4.md) (vente à la confirmation, emplacement « à livrer » par site, bon de livraison, contre-écritures partielles) précisée par [ADR-029](docs/decisions/ADR-029-contre-ecriture-partielle-du-stock.md) (retours et livraisons = mouvements rattachés à un `SALE` d'origine, plafond et valeur exacte garantis en base). Faits : P4-01 (règles partagées des ventes, `packages/domain/src/sales.ts`) et P4-02 (socle de trésorerie `finance` ; tables `sales`, emplacement « à livrer » par site, mouvements rattachés, durcissement après relecture adverse ; AV-135 à 137 ouverts, défauts paramétrables). **Prochaine étape : P4-03** (prérequis `organization`, `inventory`, `finance`, dont l'API `returnSoldGoods` / `deliverSoldGoods` / `soldGoodsPosition` et `settlementValueXaf`) — voir [`PROMPT-DE-REPRISE.md`](PROMPT-DE-REPRISE.md). Le serveur MySQL du projet est un MySQL 8.4 sur le port 3307, pas celui de XAMPP ([`db/README.md`](db/README.md) §0). **71 commits locaux ne sont pas poussés** (de P1-01 à P4-02) : ne jamais pousser sans demande explicite du porteur.
- Documentation rédigée en **français**.

## 2. Sources et hiérarchie

| Source | Rôle |
|---|---|
| `Contexte métier de référence — Projet GIC AGROPELC.md` (CM) | Source de vérité **métier** (le quoi). Ne jamais la modifier. |
| `Prompt maître — Cadrage technique et architecture GIC AGROPELC.md` (PM) | Instruction **technique** (le comment). Ne jamais la modifier. |
| `docs/` | Référentiel dérivé des deux sources ; fait foi pour le développement. |

En cas de contradiction : le CM décide du quoi, le PM du comment, et le point est tracé (`C-nn` ou `AV-nnn`).

## 3. Règles absolues

1. **Classer chaque affirmation** : CONFIRMÉ (écrit dans une source), DÉDUIT (conséquence argumentée), À VALIDER (décision en attente). Une hypothèse n'est jamais présentée comme une exigence.
2. **Ne jamais combler un trou en silence.** Une question métier non couverte devient un point `AV-nnn` dans [`docs/A-VALIDER.md`](docs/A-VALIDER.md) (question, pourquoi, choix, recommandation, impact, classe). La valeur par défaut est implémentée de façon **paramétrable**, et le travail continue. Seul un AV **bloquant** arrête la phase concernée (aucun aujourd'hui : AV-024 et AV-025, qui bloquaient P4, ont été tranchés le 27/09/2026).
3. **Toute écriture est une commande idempotente** (`command_id`, `device_seq`, `occurred_at`), validée par le serveur. Aucun fait accompli n'est rejeté pour une raison d'état métier (BR-SYN-007).
4. **Rien ne disparaît** : pas de suppression physique d'une opération sensible ; correction par annulation ou contre-écriture (ADR-006). Le journal d'audit est en ajout seul.
5. **Frontières de modules** : une table n'est écrite que par son module propriétaire ; un module n'importe que l'API publique des modules de niveau inférieur ([graphe](docs/05-architecture/03-graphe-dependances.md)).
6. **Logique métier partagée** : validations, moteur de prix, politiques, disponibilité et arrondis vivent dans `packages/domain`, sans entrée-sortie, et s'exécutent à l'identique sur l'appareil et le serveur (ADR-021).
7. **Temps et argent** : quatre horodatages (`occurred_at`, `client_created_at`, `received_at`, `applied_at`), fuseau `Africa/Douala` ; montants en XAF entiers ; quantités en `numeric(14,3)` (ADR-013, ADR-016).
8. **Seuils = paramètres** : aucun seuil métier codé en dur (`organization.system_settings`, historisés).

## 4. Avant de travailler sur une phase ou une fonctionnalité

Lire, dans cet ordre :

1. [`docs/README.md`](docs/README.md) — index maître ;
2. [`docs/00-reference/00-conventions.md`](docs/00-reference/00-conventions.md) — identifiants, statuts, nommage ;
3. [`docs/10-development-plan/06-passage-au-developpement.md`](docs/10-development-plan/06-passage-au-developpement.md) — structure du dépôt, backlog, règles R1 à R11 ;
4. la fiche de la phase dans [`docs/10-development-plan/01-plan-developpement.md`](docs/10-development-plan/01-plan-developpement.md) §4 ;
5. les lignes de la phase dans la [matrice de traçabilité](docs/10-development-plan/02-matrice-tracabilite.md), puis chaque document qu'elles citent : domaine (`docs/01-functional/domaines/Dnn`), tables (`docs/03-data/dictionnaire/`), machine à états (`SM-*`), workflow (`WF-*`), permissions (`docs/07-security-rbac/01-rbac.md`), tests d'acceptation (`AT-*`).

## 5. En fin de modification

- Dans le **même commit** que le changement : mettre à jour le dictionnaire (schéma), la matrice (exigence), le registre AV (décision), un nouvel ADR (décision structurante), l'index des règles (`python3 docs/_tools/check_refs.py --index`).
- Lancer `python3 docs/_tools/check_refs.py` : il doit afficher « aucune référence orpheline » et « aucun lien relatif cassé ».
- Chaque invariant `INV-*` touché a au moins un test ; chaque test d'acceptation de la phase est automatisé.
- Messages de commit en français, préfixés par la portée (ex. `docs(cadrage): …`, `feat(inventory): …`).

## 6. Identifiants

`REQ` exigences · `BR-<DOM>` règles métier · `INV-<DOM>` invariants · `ADR` décisions · `AV` questions ouvertes · `SM-*` machines à états · `WF-nn` workflows · `ECR-<DOM>` écrans · `NFR` exigences non fonctionnelles · `AT` tests d'acceptation · `RISK` risques · `C-nn` contradictions entre les sources. Chaque identifiant est défini à un seul endroit ; les formats sont dans [`docs/00-reference/00-conventions.md`](docs/00-reference/00-conventions.md) §3.
 