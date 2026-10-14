# Suivi de la phase P9 — Analytics et direction (serveur, menée en parallèle)

> Ouvert le 14/10/2026. Décision du porteur (14/10/2026) : la session parallèle qui a mené P8 corrige d'abord le constat A7 de la revue de P8, puis entame le **serveur** de P9 ; les écrans de P8 viendront après. La session principale poursuit en même temps le lot de mise en pilote (MP-08 à MP-11) dans `apps/pwa`, `identity`, `attachments` et l'accueil. Elle intègre ce travail : fusion de `claude/p9-analytics`, renumérotation des AV et des ADR, mise à jour de `CLAUDE.md` et de `PROMPT-DE-REPRISE.md`. Cadrage : [`PROMPT-LANCEMENT-P9.md`](../../PROMPT-LANCEMENT-P9.md). Fiche : [plan §4, P9](01-plan-developpement.md).

## 0. Correctif A7 — verrou de la masse mensuelle des frais généraux

**Constat** (revue de P8, [`17-suivi-p8.md`](17-suivi-p8.md) §6, A7). L'annulation d'une dépense de frais généraux et `production.overhead.allocate` ne partageaient aucun verrou. Le même trou existait entre `inventory.overhead.cancel` (P7) et la répartition, et touchait aussi la clôture d'un lot (part estimée, AV-105). La répartition lisait la masse du mois, les annulations lisaient « mois déjà réparti ? » : toutes par des lectures simples, sous l'instantané de leur transaction. Deux transactions concurrentes passaient donc chacune. Conséquence : les lots portaient la part d'un frais annulé et la masse du site devenait négative.

**Correction** (DÉDUIT ; [ADR-038](../decisions/ADR-038-ordre-de-verrouillage-global.md), rang N2b et révision de P9) :

| Élément | Changement |
|---|---|
| Verrou | table `inventory_overhead_pool_locks` (site, espèce, mois métier), propriété d'`inventory`, migration `20261201090000` ; upsert sans effet, tenu jusqu'à la fin de la transaction |
| Écrivains sous le verrou | `production.overhead.allocate`, `production.lot.close` (une masse par mois de la vie du lot, ordre croissant), `inventory.overhead.record` et `.cancel`, `finance.expense.cancel`, et toute écriture `SITE` `FRAIS_GENERAUX` par `recordCostEntry` (saisie et approbation d'une dépense) |
| Lectures | la masse (`costObjectBalance`, option `current`) et la garde « mois déjà réparti » (`siteOverheadMonthAllocated`, `monthAllocated`) passent en lecture verrouillante `FOR SHARE` : elles rendent les écritures validées, non l'instantané |
| Ordre | espèce puis mois croissants ; les lignes d'une saisie sont écrites par espèce croissante ; aucun cycle (ADR-038, révision) |

**Tests** (aucun test de concurrence ne tournait pour cette paire) :
- `production-overhead-allocation.test.ts`, trois cas :
  - annulation arrivée pendant la répartition : refusée, masse du site nulle ;
  - annulation validée avant la répartition qui attendait : masse relue à jour, rien n'est réparti d'un frais annulé ;
  - chaque commande attend le verrou, mois de Douala à la frontière UTC.
- `finance-expense-commands.test.ts` : saisie et annulation d'une dépense attendent le verrou ; répartition validée pendant l'attente, garde relue à jour.

**Mutations** (base jetable `gic_agropelc_p9m`) : sept sur huit détectées.
- Détectées :
  - répartition sans verrou ;
  - masse lue sur l'instantané ;
  - annulation de saisie sans verrou, ou sans garde à jour ;
  - écriture de la masse sans verrou ;
  - annulation de dépense sans verrou ;
  - mois calculé en UTC.
- Une équivalente : la garde de l'annulation d'une dépense lue sans `FOR SHARE`. Le droit de l'acteur est déjà en cache (chargé par le contrôle de permission du pipeline, hors transaction) et le gestionnaire ne lit rien avant le verrou : l'instantané de la transaction naît à la garde, après lui. La lecture courante est conservée : elle ne doit pas dépendre de cette absence de lecture simple.
- Constat de méthode : une assertion « la commande attend encore » fondée sur un délai (700 ms) ne distingue pas une commande bloquée d'une commande lente quand la machine est chargée. Une mutation a donc survécu une fois, détectée en la rejouant seule ; l'assertion ne produit jamais de faux échec.

## 1. Espace réservé

| Élément | Valeur |
|---|---|
| Branche | `claude/p9-analytics`, partie de la tête intégrée de `claude/brave-pasteur-c7q4y7` (`befdb76`, qui contient la fusion de P8 `21a0a82`) |
| Worktree | `.claude/worktrees/p9-analytics` |
| Bases | `gic_agropelc_p9` (développement et tests), `gic_agropelc_p9m` (base jetable : mutations, scénarios destructifs) |
| Migrations | versions `20261201xxxxxx` |
| AV | numéros 400 à 449 (provisoires) ; utilisés : 400 à 442 (P9-01) |
| ADR | numéros 070 à 079 (provisoires) ; utilisés : 070 à 078 (P9-01) |
| Démonstration de sortie | `20-demonstration-p9.md` (à la clôture) |
| Matrice | §17.11 « Phase P9 » |

## 2. Avancement

| Incr. | Objet | Commit | État |
|---|---|---|---|
| A7 | Verrou de la masse mensuelle des frais généraux, lectures courantes, tests de concurrence | `9a9efc6` | Fait : 4 tests de concurrence, 7 mutations détectées sur 8 (1 équivalente) ; paquet `db` 201 tests verts |
| P9-01 | Conception : cartographie, ADR 070 à 078, AV 400 à 442, backlog du plan §4 (26 incréments) | `384e74c` | Fait : ADR-070 à 078, 43 AV (aucun bloquant, 10 IMPORTANTE), D11, D13, dictionnaires `communication` et `analytics`, `03-historisation-suppression.md` et ADR-038 (rang N10b) complétés, `check_refs.py` propre ; revue adverse de la conception : cinq chercheurs, un vérificateur sceptique par constat, 60 constats retenus (4 graves, 22 moyens, 34 mineurs), tous traités dans ce commit (§7) |
| P9-02 | Domaine partagé et contrats : catalogue des alertes, traitement d'un événement, rendu, livraison, périodes d'analyse, registre des indicateurs, couche sémantique ; schémas de commandes et de lectures | `50c87f4` | Fait : domaine 531 tests (126 nouveaux, couverture des fichiers nouveaux 97 à 100 %), contrats 267 tests (30 nouveaux), 29 mutations détectées sur la base de code, `tsc` et ESLint propres |
| P9-03 | Schéma `communication` : migration `20261201090100`, 36 règles d'alerte et 15 paramètres semés, dictionnaire, invariants INV-NOT-02 et 03 | `e47a37c` | Fait : `db` 221 tests (20 nouveaux), 35 mutations du schéma détectées sur la base jetable (aucune survivante), montée, descente et remontée vérifiées, seed idempotent |
| P9-04 | Socle des alertes : écriture dédoublonnée, consommateur `communication.alerts`, commandes `communication.alert.*` et `communication.alert_rule.set` ; table des événements sautés par le runner | `c99284c` | Fait : serveur 27 tests (25 + 2), domaine 23 tests, 20 mutations détectées (deux survivantes traitées par des tests), migration `20261201090200` montée, descente et remontée vérifiées |
| P9-05 | Destinataires, notifications, Web Push (port), escalade et abonnements | `953d210` | Fait : serveur 57 tests (11 destinataires, 34 notifications, escalade et envoi, 12 commandes), domaine 13 tests de plus ; revue adverse (41 agents, 31 constats retenus, neuf corrigés) ; mutations et revue : §8 |
| P9-06 | Lectures HTTP de la communication : alertes, résumé, détail, notifications, règles | ce commit | Fait : 14 tests de bout en bout (portées `ALL`, `SITE`, `OWN`, `TEAM`, boîte, valeur au coût, 404 audité, curseur, notifications, règles) ; 28 mutants détectés sur 30 (2 équivalents) ; revue adverse §9 |
| P9-07 et suivants | Voir le backlog du plan | — | À faire |

## 3. Code existant touché (hors des fichiers nouveaux de P9)

Ces modifications sont signalées à la session principale à chaque fin de lot.

| Incr. | Module ou fichier | Changement | Raison |
|---|---|---|---|
| A7 | `inventory` : `public/cost-entries.ts`, `public/index.ts` | `lockOverheadPool`, `lockOverheadPools`, `overheadPeriodOf` ; option `current` de `costObjectBalance` ; `siteOverheadMonthAllocated` en lecture verrouillante ; `recordCostEntry` prend le verrou d'une écriture `SITE` `FRAIS_GENERAUX` | A7, ADR-038 rang N2b |
| A7 | `inventory` : `commands/overhead-commands.ts` | l'annulation d'une saisie verrouille la masse de chaque espèce avant la garde (lue en `FOR SHARE`) ; les lignes d'une saisie sont écrites par espèce croissante | A7 |
| A7 | `production` : `overhead-allocation.ts` | la répartition (et la part estimée à la clôture d'un lot) verrouille la masse avant de la lire, en lecture courante | A7 |
| A7 | `finance` : `commands/expense-commands.ts` | l'annulation d'une dépense de frais généraux verrouille la masse avant la garde | A7 |
| A7 | `db` : migration `20261201090000`, `schema.sql`, `schema.generated.ts` | table `inventory_overhead_pool_locks` (sans clé étrangère vers le site) | A7 |
| A7 | tests de P7-10 et P8-05 | trois cas de concurrence ajoutés à `production-overhead-allocation.test.ts`, un à `finance-expense-commands.test.ts` | A7 |
| A7 | documentation | ADR-038 (rang N2b, révision), dictionnaire `06-inventory.md`, D06 (API publique) | A7 |
| P9-04 | `apps/server/src/platform/events/event-consumer-runner.ts` | méthode `recordFailure` : chaque événement sauté après ses essais est consigné dans `platform_event_consumer_failures` avant l'avancée de la position (aucune ligne existante modifiée) | P9-04 |
| P9-04 | `apps/server/src/app.module.ts`, `apps/server/src/worker/worker.module.ts` | `CommunicationModule` et `CommunicationJobsModule` ajoutés aux imports | P9-04 |
| P9-05 | `apps/server/src/app.module.ts`, `apps/server/src/worker/worker.module.ts` | `CommunicationRecipientsModule` (global) ajouté aux imports | P9-05 |
| P9-05 | `packages/domain/src/index.ts` | exports de `alert-recipients.ts` et de trois fonctions de `alert-delivery.ts` (ajouts) | P9-05 |
| P9-04 | `db/schema.sql`, `apps/server/src/platform/kysely/schema.generated.ts` | table `platform_event_consumer_failures` et version `20261201090200` (le fichier généré est régénéré) | P9-04 |
| P9-03 | `db/seeds/run.ts`, `db/seeds/system-settings.ts` | étape `seedAlertRules` ; quinze paramètres de détection, de rétention et de regroupement (ajouts en fin de liste) | P9-03 |
| P9-02 | `packages/domain` : `index.ts` ; `packages/contracts` : `index.ts` | exports ajoutés en fin de fichier (aucun existant modifié) | P9-02 |
| P9-01 | documentation | ADR-070 à 078 (nouveaux), ADR-038 (rang N10b), `docs/decisions/README.md`, `A-VALIDER.md` (AV 400 à 442), plan §4 (section P9), D11 §13 et §15, D13 §3, §7.1, §15, dictionnaires `10-approvals-attachments-communication.md` (règles sans seuil, `alert_recipients`, colonnes d'alerte, audiences) et `12-analytics.md` (`query_log`, `catalog_version`, export, instantanés), `03-data/03-historisation-suppression.md` (alertes, journal des requêtes, notes) | P9-01 |

### Code existant dont la modification est prévue par la conception (à signaler à chaque incrément)

| Incr. prévu | Fichier ou module | Changement prévu | Nature |
|---|---|---|---|
| P9-06 | `apps/server/src/app.module.ts`, `packages/contracts/src/index.ts` | `CommunicationApiModule` ajouté aux imports ; exports des contrats `alertRuleItemSchema` et `alertRuleListResponseSchema` (ajouts) | P9-06 |
| P9-05 | `communication-api/identity-recipient-resolver.ts` (nouveau) | lecture des tables `identity` (affectations, rôles, utilisateurs, appareils) et `organization` (équipes, zones) par rôle et périmètre : requête inverse que les API publiques n'offrent pas ; demande B1 | lecture, signalée |
| P9-07 à P9-10 | `sales`, `finance`, `inventory`, `production`, `procurement`, `approvals`, `crm`, `fieldwork`, `sync`, `audit` | événements de déclenchement (fichiers `*-alert-events.ts`), tâches de passe et récurrences ; `audit.chain.verify_daily`, `inventory.ledger.reconcile_daily`, `finance.cash.reconcile_daily` publient leur événement puis se terminent en succès ; déduplication par jour des tâches de P4 à P5 adaptée | ajouts, un changement de comportement des trois tâches de réconciliation |
| P9-14 | `platform/read-scope.ts` | mode « union » ajouté à `ReadScope` (ET par défaut inchangé) | ajout |
| P9-15 | `public/` des modules propriétaires (`inventory`, `production`, `crm`, `sales`, `approvals`) | fonctions de référence manquantes (couverture, ratios, mortalité, œufs, effectifs, compteur de validations) exportées par `index.ts` | ajouts |
| P9-17 | `distribution-api/` | `resolveDashboardScope` extrait du contrôleur ; schéma de réponse inchangé (test de non-régression) | refactorisation sans changement de contrat |
| P9-20 | `platform/storage` | `ChunkStorage.delete(key)` et lecture en flux | ajout |
| P9-22 | `worker/worker.service.ts` | isolation des tâches longues du consommateur d'alertes (partition par type de tâche ou budget de tours) | ajout |

## 4. Écarts de documentation relevés (pour la session principale)

- Le prompt de lancement de P9 (§1) réserve `gic_agropelc_mp8i` à la session principale : `gic_agropelc_p9` a été créée neuve, sans la toucher.
- `PROMPT-DE-REPRISE.md` §1 dit de ne pas lancer MySQL soi-même ; la consigne du porteur du 04/10/2026 (lancement détaché du serveur 8.4, port 3307) le permet. Le serveur était arrêté à l'ouverture de cette session (poste redémarré) : il a été relancé par `Start-Process` détaché, comme prévu.
- Les écrans de P8 restent à mener (ECR-FIN-02 à 06, ECR-APP-05) : lot séparé, après P9, sur feu vert de la session principale.

## 5. Besoins sur les fichiers tenus par la session principale

Aucun de ces fichiers n'est modifié par la session P9. Chaque besoin est exprimé comme un changement minimal ; une adaptation locale isolée est prévue en attendant, pour ne pas bloquer P9.

| N° | Fichier ou module | Besoin | Pourquoi | Solution d'attente | Incrément |
|---|---|---|---|---|---|
| B1 | `identity` (API publique) | Lecture inverse : utilisateurs titulaires d'un ou plusieurs rôles (ou d'une permission) dont une affectation active couvre un site ou une zone, à un instant (`usersHoldingRolesAt`, `usersHoldingPermissionAt`) | Destinataires d'alerte (ADR-072), demande d'approbation sans approbateur (AV-408) | Adaptateur isolé dans `communication-api/` lisant les affectations, comme `sync/device-scope.ts` | P9-05, P9-09 |
| B2 | `sync/entity-projections.ts` | Inscrire dans `ENTITY_PROJECTIONS` les lecteurs de P9 : une ligne `...COMMUNICATION_PROJECTIONS, ...KPI_PROJECTIONS` (fichiers nouveaux `sync/communication-projections.ts`, `sync/kpi-projections.ts`) | Jeux hors ligne `comms` et `kpi` (ADR-070 §6) | Lecteurs écrits et testés en isolation ; le test par pull réel attend l'inscription | P9-12, P9-17 |
| B3 | `apps/pwa` | `KNOWN_DATASETS` : `comms` (étendu aux alertes, notifications, notes) et `kpi` ; écrans ECR-ANA-01 à 06 et ECR-NOT-01 à 03 (lot séparé) | Consommation des jeux hors ligne | Aucune : le serveur publie, la PWA ignore un jeu inconnu | après P9-12 |
| B4 | `home-api/home-service.ts` | Aucun besoin bloquant : la composition de l'accueil est dupliquée dans `analytics-api/` (appels des mêmes fonctions publiques) ; une extraction des blocs privés est possible plus tard | ADR-075 | — | P9-17 |
| B5 | `identity` (API publique) | Étendue exacte d'une permission de lecture : `readScopeAt(user, permission, at)` rend `ALL` ou une union de clauses (sites, zones avec descendantes, titulaires) après intersection portée maximale ∩ affectation, en échec fermé | Confinement des lignes de l'explorateur et des instantanés (ADR-074 §4) ; `listConfinementAt` est un pré-filtre sur-ensemble sans zone | `resolveExactScope` dans `analytics-api/analytics-scope.ts`, par énumération de `evaluateAccess` sur les sites, zones et utilisateurs (sûre : jamais plus large) | P9-14 |

## 6. Bases de données

Aucune donnée de test incohérente connue à l'ouverture : `gic_agropelc_p9` et `gic_agropelc_p9m` ont été créées neuves le 14/10/2026 par la procédure du lancement (création, `dbmate up`, `seeds/run.ts`). Les mutations tournent sur `gic_agropelc_p9m` seulement.

## 7. Revue adverse de la conception de P9-01 (14/10/2026)

Cinq chercheurs (alertes et événements ; destinataires, push, escalade et notes ; couche sémantique et explorateur ; tableaux, vues, exports et charge ; couverture et cohérence), puis un vérificateur sceptique par constat (65 agents). **60 constats retenus** sur 60 (aucun réfuté) : 4 graves, 22 moyens, 34 mineurs. Chacun est traité dans le commit de P9-01 ; le tableau regroupe les constats par sujet.

| Sujet | Constat vérifié | Traitement |
|---|---|---|
| Confinement des lignes (4 constats, dont 3 graves) | `listConfinementAt` ne porte aucune zone, rend `null` pour `ALL` et pour `SITE` ou `ZONE` sous une affectation non-site : c'est un pré-filtre sur-ensemble, inutilisable seul sur un agrégat | ADR-074 §4 (étendue exacte par énumération de `evaluateAccess`, sûre par construction, règle fermée), ADR-072 §3 (évaluation exacte par ligne, compteurs), AV-423, besoin B5, grille de tests |
| Téléchargement d'un export (grave) | Ouvert à tout titulaire de `audit.log.read` : l'administrateur lirait un export de marge | ADR-077 §6 (demandeur seul, audit de la ligne et du téléchargement), AV-434 |
| Marqueur de passe | Fondé sur l'horloge et sur des tâches qui dédoublonnent par jour : résolution à tort après un rejeu ; passes paginées non définies | ADR-071 §3 (`pass_id`, `last_pass_id`, marqueur de passe complète), ADR-078 §3, AV-403 |
| Détecteurs mal placés | `INACTIVE_COMMERCIAL` dans `fieldwork` (cycle) ; part « % des ventes » de `HIGH_LOSS` dans `inventory` | ADR-071 §2 (tableau module → types), AV-406, AV-409 |
| Tâches qui lèvent | `audit.chain.verify_daily`, `inventory.ledger.reconcile_daily`, `finance.cash.reconcile_daily` annulent leur écriture en levant ; `LEDGER_MISMATCH`, `CASH_MISMATCH` absents | ADR-071 §3 et §13, AV-402, D13 §7.1 |
| Consommateur défaillant | `last_error` écrasé par le premier événement suivant ; événement sauté non identifiable | ADR-071 §12 (table des échecs), AV-412, ajout de plateforme |
| Rang de verrou | « N15 pris en dernier » inexistant et contradictoire avec N14 | ADR-038 (rang N10b ajouté), ADR-070, ADR-071 §10 |
| Délai et fenêtre | NFR-15 incompatible avec la fenêtre de stabilisation de 120 s ; description inexacte du runner (une transaction par événement) | ADR-071 §14, ADR-078 §3 et §7, AV-438 |
| Tâches longues | Export et instantanés dans la boucle série du worker retardent les alertes ; `FAILED` perdu par le point de sauvegarde ; fichiers orphelins | ADR-077 §3, ADR-078 §3, backlog P9-22 |
| Port de stockage | Ni suppression ni lecture en flux | ADR-077 §5, backlog P9-20 |
| Valeurs au coût | Message d'alerte pré-rendu : valeur visible sans `inventory.valuation.read` | ADR-071 §11, ADR-072 §4, AV-440, dictionnaire (`payload`) |
| Vues de portée et dates | Colonnes de site inexistantes sur plusieurs sources ; deux dates pour deux mesures ; lot incompatible avec le grain ; `occurred_at` contre `applied_at` | ADR-074 §2 et §3, AV-424, AV-427, dictionnaire |
| Index | Colonnes de jour métier générées déjà présentes et indexées ; index manquants à justifier | ADR-074 §2 et §9 |
| Indicateurs sans fonction | Couverture, ratios, mortalité, œufs, effectifs, compteur de validations | ADR-075 §1, backlog P9-15, AV-429 |
| Période précédente | Sans sens pour un indicateur d'instant ; résolveur dupliquant `businessPeriodOf` | ADR-075 §3, ADR-076 §2 |
| Extraction du tableau de distribution | Logique du périmètre en ligne dans le contrôleur, liée à la requête HTTP | ADR-076 §3, backlog P9-17 |
| Destinataires | Matrice RBAC réelle (vendeur de PDV = `SITE`), responsables d'équipe (`manager_user_id`), approbateurs par permission, précédent `device-scope.ts` faux | ADR-072 §1, §2 et Contexte, AV-413, AV-417, B1 |
| Notifications directes | Événements « NOT » sans alerte non couverts | ADR-072 §4, AV-439, backlog P9-05 |
| Escalade et push | Échéance depuis `critical_since`, regroupement sous verrou, escalade non regroupée | ADR-072 §6 et §7, dictionnaire |
| Notes | Audience à la lecture contre jeu `USER` ; rôle non portée du flux ; immuabilité des audiences ; clé primaire à colonne nulle ; brouillon non supprimable | ADR-073 §1 à §5, AV-419, dictionnaire |
| Sujet composite | Solde sans identifiant : UUID v5 du couple | ADR-071 §5, AV-441 |
| `dismiss` d'une alerte d'état | Fait renaître l'alerte à la passe suivante | ADR-071 §9, AV-404 |
| `SYNC_ERROR` | Un rejet n'a ni événement ni conflit | AV-442 |
| Rétention | Marques `IMMUABLE`, alertes sans `DELETE` pour le rôle d'application, clés de paramètres | ADR-078 §8, `03-historisation-suppression.md`, AV-437 |
| Références inexactes | `GET /stock/ledger`, RC-07, AT-046 cité pour les alertes, périmètre `comms` | ADR-075 §6, ADR-072 Tests, ADR-073 §4, AV-428 |
| Paramètres | Cadence de tâche déclarée paramétrable alors qu'elle est en code ; seuils « déjà lus » semés mais non lus | ADR-071 §8, AV-400, AV-405, AV-411 |
| CA | Nombre de ventes de `periodRevenue` compte les annulées ; attribution distincte voulue | ADR-075 §2, AV-426 |
| Couverture des acceptations | AT-027, AT-032, AT-047 non repris | backlog P9-24 |

## 8. Revue adverse de P9-05 et mutations (14/10/2026)

Quatre angles (concurrence et verrouillage ; confidentialité et portée ; conformité aux ADR et à D13 ; qualité des tests), un vérificateur sceptique par constat : 41 agents, **37 constats, 31 retenus, 6 réfutés**. Neuf défauts réels sont corrigés dans le code, les autres sont documentés (ADR-072, révision P9-05) ou couverts par des tests ajoutés.

| Sujet | Constat vérifié | Traitement |
|---|---|---|
| Escalade consommée sans audience, erreur avalée (3 constats) | `escalated_at` et `AlertEscalated` posés avant les destinataires ; sans titulaire du niveau supérieur ou après une erreur, l'unique escalade est perdue | Corrigé : l'audience est résolue avant la pose ; point de sauvegarde par alerte ; l'alerte reste candidate. Tests : sans audience puis audience, panne isolée, erreur annulée |
| Candidats non filtrés par la règle | 200 alertes non escaladables affamaient les autres | Corrigé : jointure sur la règle (active, délai, échéance), lecture par identifiant croissant avec curseur (ordre des verrous de `resolveByPass`). Tests : affamement par règle et par absence d'audience, lots |
| Créneau de regroupement | Ouvert par une ligne jamais envoyée (alerte close), par l'escalade ; décompte des tues faux (alertes tièdes, doubles lignes) | Corrigé : lignes livrées ou d'alerte ouverte seulement, hors escalade ; décompte des alertes critiques, une fois chacune. Test de séquence complet |
| Appareils et utilisateurs | Push livrés à un appareil bloqué, perdu ou retiré et à un utilisateur suspendu | Corrigé : jointures sur `identity_devices` et `identity_users` à la création et à l'envoi. Révoquer les abonnements au changement de statut reste à faire avec le consommateur d'état d'appareil (hors P9-05, la jointure suffit fonctionnellement) |
| Relèvement en `CRITICAL` | Renotifie des destinataires devenus inactifs | Corrigé : filtre par `activeUsersAmong` ; test |
| Propriétaire et responsable | Retenus sans affectation active, neutralisant le repli sur la Direction | Corrigé dans l'adaptateur ; tests |
| Approbateurs de portée `TEAM` ou `OWN` | Le demandeur n'était pas le propriétaire jugé par le moteur de droits | Corrigé : le demandeur est le propriétaire de la ressource évaluée, sans être destinataire ; test |
| Abonnement | Verrou d'intervalle sur un point de terminaison absent (ADR-038 §3) ; « tout marquer lu » hors ligne marquait des notifications créées ensuite | Corrigé : lecture validée, reprise du doublon ; borne par l'instant du geste. Tests, dont la concurrence |
| Notifications directes (AV-439) | Annoncées par la ligne du plan sans être livrées | Reportées en P9-11 (même écrivain de notifications), plan et AV-439 mis à jour |
| Instant jugé | Destinataires jugés à l'instant du traitement, non de l'événement (ADR-072 §1) | Documenté et assumé (ADR-072, révision §1) : l'alerte ouverte s'adresse à ceux qui peuvent agir maintenant |
| Responsable pour `APPROVAL_PENDING_LONG` | Cité par l'ADR, jamais produit ; le catalogue ne le prévoit pas | ADR corrigé (approbateurs seulement) |
| Livraison par notification, adaptateur « journal » | État de livraison par notification et non par abonnement ; adaptateur désactivé livré ; envoi par une tâche dédiée à la minute | Documentés (ADR-072, révision §5) ; l'état par appareil demande une table, à décider avec l'adaptateur réel (AV-415) |
| Qualité des tests (14 constats) | Gardes sans test : périmètre transmis, origines, rôles propres d'un déclencheur, rôles d'escalade, abonnements révoqués, créneaux, fenêtre de reprise, adaptateur (appartenance échue, rôle inactif, équipe inactive) | une trentaine de tests ajoutés ; paramètre `communication.push_group_minutes` non testé : les paramètres système sont immuables et partagés (voir la mémoire du projet), couvert par défaut à 15 |

**Mutations** (base jetable `gic_agropelc_p9m`) : 56 mutants sur le code de P9-05, **52 détectés**, 4 équivalents documentés : sortie anticipée pour `INFO` (le canal vide ne produit aucune ligne), valeur initiale de `showProtected` (écrasée dès qu'une valeur protégée est rendue), rejugement de l'échéance sous verrou (déjà acquise par la requête des candidats, défense en profondeur contre une course), délai de règle nul (une arithmétique `NULL` écarte déjà la ligne). La première passe a révélé six gardes non testées, dont un **test vide** : trois abonnements créés après la première lecture de la transaction du test étaient invisibles à la lecture répétable ; les données sont désormais validées avant la première lecture, avec un témoin.

**Outil de test** (`apps/server/test/communication-test-kit.ts`) : une transaction de test annulée laisse un numéro absent dans `platform_domain_events`, et les consommateurs ne dépassent pas un trou de moins de 120 s (`settled-sequence.ts`) ; un seul test annulé suffisait à faire échouer, dans la même minute, un test de la suite qui attend un consommateur (observé : `role-assignment-commands`, cache RBAC). Les tests de `communication` reprennent désormais chaque numéro consommé par une transaction annulée avec une ligne `test.tombstone`, ignorée de tous les consommateurs (le numéro appartenait à la seule transaction annulée). À reprendre par la session principale pour les autres tests qui annulent des transactions produisant des événements.

## 9. Revue adverse de P9-06 et mutations (14/10/2026)

Deux angles (confinement et confidentialité ; conformité, exactitude et performance), un vérificateur sceptique par constat : 10 agents, **8 constats, 5 retenus, 3 réfutés** (curseur qui diviserait l'existence d'une alerte, jeton valide d'un utilisateur suspendu pendant 15 minutes — propriété du pipeline d'authentification, évaluation exacte non mémoïsée — coût borné par le plafond de balayage).

| Sujet | Constat vérifié | Traitement |
|---|---|---|
| La boîte donne un droit de lecture permanent (2 constats) | ADR-072 §9 limite la boîte à la durée d'ouverture de l'alerte ; le code la lisait aussi après résolution (détail et liste `status=RESOLVED`), pendant la durée de conservation | Corrigé : `RECIPIENT` seulement pour `OPEN` et `ACKNOWLEDGED` ; « boîte seule » ne rend jamais une alerte close ; une alerte close se lit par la supervision. Tests dont le cas d'un destinataire qui supervise aussi |
| Corps figé des notifications | Une valeur au coût reçue avec le droit restait lisible après sa perte (écart liste d'alertes / notifications, RC-05) | Corrigé : le corps `IN_APP` d'une alerte porteuse de valeur au coût est rendu à la lecture selon le droit courant ; les autres gardent leur texte. Les notifications déjà poussées ou synchronisées ne se rappellent pas |
| Fin de page | Curseur non nul après la dernière alerte ; `truncated` vrai pour exactement 2 000 lignes | Corrigé comme `approvalInboxPage` ; le résumé relit une ligne avant d'annoncer la troncature |
| Tri sans index | `ORDER BY last_detected_at` sans index : tri complet à chaque balayage | Non corrigé : l'ensemble ouvert est petit et les closes sont purgées à 2 ans ; l'index `(status, last_detected_at, id)` est à décider sur mesure (`EXPLAIN`, RISK-13) avec les tableaux, P9-22 |

**Mutations** (base jetable) : 30 mutants sur le code des lectures, **28 détectés, 2 équivalents** : reconnaissance de la portée `ALL` (optimisation : le même résultat sort du balayage ligne à ligne, plus lent et plafonné), pré-filtre de la boîte sans statut (l'évaluation exacte de la visibilité écarte la même ligne). Deux listes de test ont dû être durcies : les alertes du test sont datées dans le futur et propres à l'exécution, pour rester en tête de la liste triée d'une base partagée qui s'accumule.

