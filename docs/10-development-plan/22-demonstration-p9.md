# Démonstration de sortie de phase P9

> Plan §4 (P9 — Analytics et direction). Objectif métier : tour de contrôle, analyse flexible, alertes actionnables (CM §34, §35, §53, §54). Critères d'acceptation : AT-038, AT-039, AT-043, AT-045, AT-046, AT-048, AT-054, auxquels s'ajoutent les alertes AT-027, AT-032 et AT-047. DoD : « la Direction répond seule aux questions du CM §62 ».
>
> État arrêté le 28/10/2026, à la clôture du **serveur** de P9 (P9-01 à P9-26), complété le 29/10/2026 par P9-27 (décisions du porteur sur AV-461, AV-462 et AV-469 : **vérifié le 30/10/2026**, voir §8). La phase a été menée en parallèle de la session principale sur la branche `claude/p9-analytics`, puis intégrée le 26/10/2026 sur `claude/p9-integration` (AV provisoires 400 à 500 devenus AV-350 à AV-450, ADR provisoires 070 à 078 devenus ADR-060 à ADR-068). Suivi détaillé : [`21-suivi-p9.md`](21-suivi-p9.md). Revue adverse du code : [`23-revue-p9-constats.md`](23-revue-p9-constats.md).
>
> **Ce que ce document ne dit pas.** Les écrans de P9 (ECR-ANA-01 à 06, ECR-NOT-01 à 03) ne sont pas livrés : la DoD n'est donc pas démontrée (§4). Les correctifs de la revue adverse du 28/10/2026 sont couverts par la suite complète (§8) mais **n'ont eu aucune seconde revue adverse** (§6). Aucune mesure de charge n'a tourné (§5).
>
> Convention (règle 1 du projet) : chaque affirmation est **CONFIRMÉE** (écrite dans une source citée), **DÉDUITE** (conséquence argumentée) ou **À VALIDER** (décision du porteur). Une affirmation sans étiquette renvoie à la source citée dans la même phrase.

---

## 1. Conception et périmètre livré

### 1.1 Aucun AV bloquant

La conception est arrêtée par neuf ADR (CONFIRMÉ, `docs/decisions/`) :

| ADR | Objet |
|---|---|
| [ADR-060](../decisions/ADR-060-architecture-de-p9-communication-et-analytics.md) | Architecture : modules `communication` et `analytics`, flux des événements et des lectures |
| [ADR-061](../decisions/ADR-061-alertes-detection-correlation-et-cycle-de-vie.md) | Alertes : catalogue déclaratif, détection par les propriétaires de la donnée, corrélation, cycle de vie |
| [ADR-062](../decisions/ADR-062-destinataires-notifications-push-et-escalade.md) | Destinataires, notifications, Web Push et escalade |
| [ADR-063](../decisions/ADR-063-notes-de-direction.md) | Notes de direction : publication immuable, audience, accusés hors ligne |
| [ADR-064](../decisions/ADR-064-couche-semantique-et-explorateur.md) | Couche sémantique et explorateur : vues SQL en lecture, étendue exacte, mesures protégées, limites |
| [ADR-065](../decisions/ADR-065-une-seule-definition-par-indicateur-et-periodes.md) | Une seule définition par indicateur, périodes, tests d'équivalence |
| [ADR-066](../decisions/ADR-066-tableaux-tour-de-controle-et-instantanes.md) | Tableaux par rôle, tour de contrôle, instantanés personnels, jeu hors ligne `kpi` |
| [ADR-067](../decisions/ADR-067-vues-sauvegardees-et-exports-audites.md) | Vues sauvegardées, partage sans droit supplémentaire, exports audités |
| [ADR-068](../decisions/ADR-068-charge-paliers-analytiques-et-retention.md) | Charge (RISK-13), paliers analytiques, rétention |

La conception a été éprouvée par une revue adverse (60 constats retenus, tous traités ; suivi §7) et plusieurs ADR ont été révisés au fil des incréments.

Aucun AV n'est bloquant (CONFIRMÉ : aucun titre `BLOQUANTE` entre AV-350 et AV-484 dans [`A-VALIDER.md`](../A-VALIDER.md)). P9 a ouvert **126 points** : AV-350 à AV-450 (101), AV-460 à AV-472 (13, tous tranchés par le porteur le 29/10/2026) et AV-473 à AV-484 (12, nés de P9-27, `OUVERT`). AV-451 appartient à l'impression des pièces (ADR-048), non à P9. Leur valeur par défaut est implémentée, paramétrable quand la règle s'y prête. Vingt-trois sont classés IMPORTANTE (DÉDUIT du tableau de synthèse du registre) :

- alertes et notifications : AV-355 (alertes de stock sur mouvement), AV-357 (pièce requise jamais reçue), AV-358 (demande d'approbation en attente), AV-363 (destinataires), AV-365 (Web Push : bibliothèque, clés, repli), AV-388 (délai événement → alerte), AV-390 (valeurs au coût dans les alertes), AV-397 (encaisse élevée), AV-403 (perte anormale), AV-409 (écart du registre), AV-411 (mortalité élevée), AV-412 (saisie du jour manquante), AV-414 (réception incomplète), AV-416 (validation en attente), AV-420 (chaîne d'audit rompue), AV-423 (trou de séquence d'un appareil) ;
- notes : AV-426 (audience), AV-428 (accusé hors audience) ;
- analyse : AV-373 (étendue exacte des lignes), AV-376 (chiffre d'affaires : deux calculs), AV-379 (contenu de la tour de contrôle), AV-386 (volumétrie et paliers) ;
- exploitation : AV-470 (purge des alertes closes sous un rôle de maintenance).

Les décisions attendues du porteur avant le pilote sont au §7.

### 1.2 Ce qui est livré

| Incr. | Objet | Commit (branche `claude/p9-analytics`) | État |
|---|---|---|---|
| A7 | Verrou de la masse mensuelle des frais généraux (correctif de la revue de P8) | `9a9efc6` | Vérifié (suivi §0 : 7 mutations détectées sur 8, 1 équivalente) |
| P9-01 | Conception : ADR-060 à ADR-068, AV, backlog, D11, D13, dictionnaires | `384e74c` | Fait |
| P9-02 | Domaine partagé et contrats : catalogue des alertes (36 types), traitement d'un événement, périodes, registre des indicateurs | `50c87f4` | Vérifié (suivi §2) |
| P9-03 | Schéma `communication` : 36 règles et 15 réglages semés, INV-NOT-01 à 03 | `e47a37c` | Vérifié |
| P9-04 | Socle des alertes : écriture dédoublonnée, consommateur `communication.alerts`, commandes `communication.alert.*`, table des événements sautés | `c99284c` | Vérifié |
| P9-05 | Destinataires, notifications, Web Push (port), escalade, abonnements | `953d210` | Vérifié avec un double de l'adaptateur d'envoi |
| P9-06 | Lectures HTTP : alertes, résumé, détail, notifications, règles | `0fb93e0` | Vérifié |
| P9-07 | Détecteurs 1 : ventes et finance | `87b6640` | Vérifié |
| P9-08 | Détecteurs 2 : stock | `3ccef04` | Vérifié |
| P9-09 | Détecteurs 3 : production, achats, validations, pièces | `b4f2e6f`, `a0fdb5c`, `140c224` | Vérifié |
| P9-10 | Détecteurs 4 : terrain, clients, audit, synchronisation, consommateurs | `dbb67a9`, `9ddb207`, `d34c8c4` | Vérifié |
| P9-11 | Notes de direction (commandes, lectures) et notifications directes | `ab994e4`, `3761a19`, `173aa93`, `8b132d5` | Vérifié |
| P9-12 | Jeu hors ligne `comms` (côté serveur) | `c814cfd` | Vérifié côté serveur par le vrai pull |
| P9-13 | Schéma `analytics` : quatre tables, treize vues `analytics_f_*` en lecture seule | `cbbf4e9`, `ff2863e`, `60322df`, `17cbd38` | Vérifié ; deux revues adverses |
| P9-14 | Étendue exacte des lignes, compilateur, route de l'explorateur | `446a8dc`, `3dbea0a`, `f927aa7`, `17cbd38` | Vérifié |
| P9-15, P9-16 | Fonctions de référence des indicateurs, cohérence des périodes | `c9364ae` | Vérifié par la suite du 28/10/2026 (§8) |
| P9-17 | Cinq tableaux de rôle et tour de contrôle | `c9364ae` | Vérifié par la suite du 28/10/2026 (§8) |
| P9-18 | Instantanés personnels et jeu `kpi` (côté serveur) | `0170e79` | Vérifié par la suite du 28/10/2026 (§8) |
| P9-19 | Vues sauvegardées et partage | `0170e79` | Vérifié par la suite du 28/10/2026 (§8) |
| P9-20 | Exports audités CSV et XLSX | `0170e79` | Vérifié par la suite du 28/10/2026 (§8) |
| P9-21 | Document source d'une ligne, remontée jusqu'aux sources | `1fa3c5b` | Vérifié par la suite du 28/10/2026 (§8) |
| P9-22 | Charge et rétention : voie longue du worker, purge, jeu de charge, mesures à la demande | `1fa3c5b` | Vérifié par les essais de la suite (§8) ; **aucune mesure exécutée** (§5) |
| P9-23 | Invariants et réconciliation | `6ae8365` | Vérifié par la suite du 28/10/2026 (§8) |
| P9-24 | Acceptation de bout en bout sur l'application complète | `6ae8365` | Vérifié par la suite du 28/10/2026 (§8) |
| P9-25 | Revue adverse du code (47 constats) et correctifs | `c313065` (wip), puis commits du 28/10/2026 | Correctifs écrits et **vérifiés par la suite complète du 28/10/2026** (§8) ; pas de seconde revue adverse (§6) |
| P9-26 | Clôture : cette démonstration, matrice §17.11, plan | ce commit | Ce document |
| P9-27 | Décisions du porteur du 29/10/2026 : AV-461 (plafond global désactivé par défaut), AV-462 (cinq indicateurs livrés), AV-469 (alerte `JOB_FAILED`) | `56f152c` | Vérifié par la suite du 30/10/2026 (§8) |

Les empreintes sont celles que cite le suivi (§2) ; la fusion de la branche dans l'intégration du 26/10/2026 a pu les réécrire. L'état « vérifié » de P9-01 à P9-14 est celui du suivi, constaté incrément par incrément avec mutations sur base jetable ; P9-15 à P9-24 sont vérifiés par la suite complète du 28/10/2026 (§8) et P9-27 par celle du 30/10/2026.

**Chemins principaux** (CONFIRMÉ : arborescence du dépôt et suivi §2 et §3) :

- Domaine partagé : `packages/domain/src/` (`alerts.ts`, `alert-processing.ts`, `alert-recipients.ts`, `alert-delivery.ts`, `alert-message.ts`, `direct-notifications.ts`, `note-audience.ts`, `analytics-catalog.ts`, `analytics-period.ts`, `kpi-catalog.ts`, détecteurs `stock-alerts.ts`, `production-alerts.ts`, `procurement-alerts.ts`, `approval-alerts.ts`, `attachment-alerts.ts`, `sync-alerts.ts`, `consumer-alerts.ts`, `cash-holding.ts`, `retention.ts`) ; contrats : `packages/contracts/src/` (`communication-commands.ts`, `communication-reads.ts`, `analytics-commands.ts`, `analytics-reads.ts`).
- Module `communication` : `apps/server/src/modules/communication/application/` (`alerts/`, `commands/`, `events/`, `jobs/`, `maintenance/`, `notes/`, `notifications/`, `recipients/`, `public/`, `sync-changes.ts`) ; transport : `apps/server/src/communication-api/`.
- Module `analytics` : `apps/server/src/modules/analytics/application/` (`commands/`, `exports/`, `jobs/`, `maintenance/`, `public/`, `query/`, `scope/`, `snapshots/`, `views/`) ; transport : `apps/server/src/analytics-api/` (contrôleurs, `dashboards/`, `jobs/`).
- Détecteurs placés chez les modules propriétaires de la donnée (graphe de dépendances) : `sales`, `finance`, `inventory`, `production`, `procurement`, `approvals`, `crm`, `fieldwork`, `audit`, `sync` (fichiers `*-alert-events.ts` et tâches de passe ; liste au suivi §3).
- Plateforme : `apps/server/src/platform/jobs/` (`job-lanes.ts`, `job-purge.ts`), `platform/events/` (`consumer-status.ts`, `deterministic-event-id.ts`, `consumer-failure-purge.ts`), `platform/storage/` (port `ChunkStorage`), `health/`.
- Base : migrations `db/migrations/20261201…`, vues `analytics_f_*`, dictionnaires `communication` et `analytics`, jeu de charge `db/load/`, essai de charge `apps/server/test/perf/analytics.perf.ts`.

**Surface livrée** (CONFIRMÉ : suivi et matrice §17.11) :

- Lectures : `GET /alerts`, `/alerts/summary`, `/alerts/{id}`, `/notifications`, `/alert-rules`, `/notes`, `/notes/{id}`, `/notes/{id}/acknowledgements`, `POST /analytics/query`, `GET /analytics/catalog`, `GET /analytics/dashboards/{direction, commercial, stock, production, finance}` (le tableau de distribution date de P5), `GET /analytics/snapshots/me`, `GET /analytics/views` et `/views/{id}`, `GET /analytics/exports`, `/exports/{id}` et `/exports/{id}/download`, `GET /health/ready` enrichie.
- Commandes : `communication.alert.acknowledge`, `.resolve`, `.dismiss`, `communication.alert_rule.set`, `communication.note.save_draft`, `.publish`, `.archive`, `.acknowledge`, `communication.notification.read` et les abonnements Web Push, `analytics.view.save`, `.share`, `.set_default`, `.delete`, `analytics.export.request`.
- Alertes : 37 types au catalogue (dont `JOB_FAILED`, P9-27), 35 des 36 premiers ont un détecteur testé ; cinq notifications directes d'événements (approbations, transferts) ; passes et récurrences par module.
- Jeux hors ligne publiés par le serveur : `comms` (alertes, notifications, notes, portée `USER`) et `kpi` (instantanés, portée `USER`).

---

## 2. Critères d'acceptation automatisés

Chaque ligne dit ce qui est réellement joué par le code, d'après la lecture des fichiers d'essai, et signale l'écart avec le scénario du plan de tests ([`03-plan-de-tests.md`](../09-non-functional/03-plan-de-tests.md)). « Écrit » veut dire que l'essai existe ; l'état d'exécution du 28/10/2026 est au §8.

| AT | Scénario du plan | Ce que le code joue | Fichier(s) |
|---|---|---|---|
| AT-027 | 30 morts sur un lot de 2 000 : validation requise, alerte `HIGH_MORTALITY` immédiate | **En deux moitiés, sans scénario unique.** Validation : 30 morts sur un lot de 2 000 (paramètres d'AV-048), demande `MORTALITY`, têtes en attente. Alerte : sur des lots de 1 000 têtes, 20 têtes n'alertent pas et la 21e oui, 5 sur 1 000 non et 6 sur 1 000 oui, seuils du site avant les globaux, une alerte critique par lot et par jour levée par le vrai consommateur | `production-acceptance.test.ts` (validation) ; `production-high-mortality-alert.test.ts`, `production-alert-settings.test.ts` (alerte) |
| AT-032 | Créance échue : alerte `OVERDUE_RECEIVABLE`, règlement aux plus anciennes | **En trois essais.** Événement `ReceivableOverdue` pour la seule vente échue et règlement affecté aux plus anciennes ; passe à identité des créances (marqueur, rejeu du créneau sans doublon) ; levée de l'alerte et résolution par la passe suivante | `sales-acceptance.test.ts` ; `detection-events.test.ts` ; `communication-alerts.test.ts` |
| AT-038 | « Combien de poulets réellement disponibles à Douala ? » : zone et sous-zones, réservations déduites | **Deux moitiés.** `GET /stock/availability?zone_id=` : la Direction lit toute la zone (trois emplacements, 12 unités), le magasinier son seul site (8) ; la zone d'essai n'a ni sous-zone ni réservation. Le filtre de zone de l'explorateur couvre la zone et ses sous-zones (égalité, liste, exclusion) sur `f_sales_line`, pas sur le stock. `analytics_f_stock_balance` est rapprochée de `GET /stock` (alloué déduit du disponible) | `inventory-read.e2e.test.ts` (P2) ; `analytics-query-compiler.test.ts` (EP-1, écrit le 28/10/2026) ; `analytics-views-stock.test.ts` |
| AT-039 | « Combien vendu cette semaine, par quel commercial, à quels clients ? » : tableau = explorateur = documents | Application complète (`PosWorld`, horloge fixe au 23/07/2026), trois ventes réelles dont une annulée dans le délai direct. L'explorateur, par vendeur (`seller_user_id`, non par commercial) et par client, rend 10 × prix pour le premier couple et 6 × prix pour le second ; le total de la vente A relu par `GET /sales/{id}` est vérifié par présence de la valeur dans la réponse ; regroupé par vente, chaque ligne porte `source { type, id, route }` (BR-ANA-010). L'égalité avec le **tableau** n'est pas lue dans ce test : elle l'est dans AT-054 | `p9-acceptance.e2e.test.ts` |
| AT-043 | « Pourquoi manque-t-il 5 unités ? » : du registre aux documents, auteurs et appareils | Aucun manque n'est provoqué. Les mouvements d'un produit lus dans l'explorateur (`f_stock_moves`, `source.type = STOCK_MOVE`) sont ceux du registre `GET /stock-moves` (au moins trois, chacun dans l'explorateur) ; chacun porte un document source et un auteur, le mouvement de vente porte sa commande. L'appareil n'est vérifié que par `inventory-read.e2e` (`createdDeviceId`, mouvement d'un transfert) | `p9-acceptance.e2e.test.ts` ; `inventory-read.e2e.test.ts` (P2) |
| AT-045 | Enquête d'audit sur une vente annulée : qui, quand (réel et serveur), appareil, hors ligne, validateur, avant et après ; chaîne vérifiée | Vente annulée dans le délai direct, donc sans validateur et en ligne. L'audit de la vente et de l'annulation donne l'auteur, l'appareil, le résultat, l'heure réelle (`occurred_at` exacte) et une heure d'enregistrement (`recorded_at`, vérifiée comme date, non comparée) ; l'état « après » est présent, « avant » n'est pas assertée ; la lecture HTTP de l'audit n'est vérifiée que si elle répond 200 ; `verifyChainRange` est `ok` sur la plage de l'enquête. **Non joués** : annulation hors ligne, validateur | `p9-acceptance.e2e.test.ts` ; `audit-chain-broken-alert.test.ts` (rupture de la chaîne : alerte critique) |
| AT-046 | Export de ventes par un responsable commercial : limité à son équipe, audité | Responsable à portée `TEAM` (équipe d'un vendeur). Demande `analytics.export.request` (CSV), tâche réclamée par le vrai `JobRunner`, fichier téléchargé : il contient les ventes A et C du vendeur de l'équipe et pas la vente B d'un autre ; audit dans l'ordre `request`, `completed`, `downloaded` ; la Direction ne télécharge pas l'export de l'équipe (404). Lecture de l'explorateur à portée d'équipe en plus | `p9-acceptance.e2e.test.ts` ; `analytics-explorer.e2e.test.ts` ; `analytics-export-pipeline.test.ts` ; `analytics-views-exports.e2e.test.ts` |
| AT-047 | Stock sous le seuil puis réapprovisionnement : une seule alerte, résolue automatiquement | **En plusieurs essais.** Transitions de seuil sur mouvement (stock bas levé, passé en rupture, résolu au réapprovisionnement, par le vrai consommateur) ; balayage horaire (levée par la passe, résolue par le marqueur de la suivante) ; déduplication et unicité en concurrence (INV-NOT-01) | `inventory-stock-alert-transitions.test.ts` ; `inventory-stock-alert-passes.test.ts` ; `communication-alerts.test.ts` |
| AT-048 | Note de direction à accusé de lecture : lue et accusée hors ligne, synchronisée | Par le vrai pull et les vraies commandes, sur le harnais de synchronisation : note publiée à un site, reçue par les seuls utilisateurs touchés, lue puis accusée par commandes marquées hors ligne, la notification sort des non lues, puis note retirée à l'archivage. **Côté serveur seulement** : la PWA n'applique pas les lignes `NOTE` (§4) | `communication-comms-sync.test.ts` ; `communication-note-commands.test.ts` |
| AT-054 | « Ventes de la semaine » lues sur le tableau commercial, la tour de contrôle et l'explorateur : identiques ; `OWN` ; sans `inventory.valuation.read`, aucun coût ni marge | **Trois moitiés.** Vendeur à portée `OWN` (affectations de site révoquées) : le tableau commercial et l'explorateur rendent la même valeur (10 × prix, ses lignes seulement), `FORBIDDEN_MEASURE` (403) pour la marge, valeurs au coût `null` sur le tableau. Tour de contrôle : chaque indicateur de flux qui a une mesure d'explorateur égale cette mesure (même période, même étendue) sur les données de la base, **hors ratios et pourcentages** ; l'instantané personnel égale le tableau de la même période ; le bloc DISTRIBUTION égale l'instantané `distribution` | `p9-acceptance.e2e.test.ts` ; `analytics-dashboards.e2e.test.ts` ; `p5-distribution-metrics.test.ts` ; `analytics-snapshots.test.ts` |

Acquis antérieurs que la phase reprend sans les rejouer : AT-040 à AT-042 (P5 et P8), AT-036 (volet alerte `CLOCK_SKEW`, `sync-clock-skew-alert.test.ts`), AT-044 (Kommo, hors périmètre depuis le 26/10/2026).

---

## 3. Invariants et cohérence

- **INV-NOT-01** (une alerte ouverte par type et objet), **INV-NOT-02** (alerte résolue ou écartée figée, gravité d'une alerte ouverte qui ne baisse pas), **INV-NOT-03** (note publiée immuable, audience comprise, jamais supprimée) : balayés sur toute la base par `p9-invariants.test.ts`, qui joue aussi INV-ANA-01 à 03 ; preuve des déclencheurs et de l'index unique dans `db/tests/communication.test.ts` ; unicité en concurrence dans `communication-alerts.test.ts`.
- **INV-ANA-01** (export audité à la demande et à la fin, ligne jamais supprimée, figée une fois terminée) : chaque export a sa ligne d'audit de demande et, une fois terminé, sa ligne de fin ; un export réussi a son fichier et son nombre de lignes, un échec son code (`p9-invariants.test.ts`) ; déclencheurs et privilèges dans `db/tests/analytics.test.ts` (aucun `DELETE` pour l'application sur les exports).
- **INV-ANA-02** (vue par défaut d'un rôle partagée avec lui, une seule par rôle) : balayage de `p9-invariants.test.ts` ; deux propriétaires qui posent en même temps la vue par défaut du même rôle sont rejoués en concurrence (ordre de verrouillage ADR-038, rang N10b) : les deux commandes sont appliquées, une seule vue reste par défaut.
- **INV-ANA-03** (instantané : utilisateur, tableau du catalogue, période connue, un seul par couple) : balayage de `p9-invariants.test.ts`, clé primaire et contrôle de période dans `db/tests/analytics.test.ts`.
- **Limite du balayage d'INV-NOT-02 et 03** (CONFIRMÉ, matrice §17.11) : sur une base sans alerte close ni note publiée il ne prouve rien ; la preuve réelle est dans `db/tests`.
- **Équivalence des définitions** (BR-ANA-009) : chaque vue `analytics_f_*` est rapprochée de la fonction de référence du module propriétaire ou d'un calcul indépendant (`analytics-views-*.test.ts`) ; l'étendue exacte n'est jamais plus large qu'`evaluateAccess` (grille jugée ligne à ligne, `analytics-exact-scope.test.ts`) ; chaque indicateur de flux du tableau égale l'explorateur (`analytics-dashboards.e2e.test.ts`).
- **Essais qui peuvent sauter** (EP-4, CONFIRMÉ) : les essais `analytics-views-*` sautent quand les autres fichiers n'ont pas laissé assez de lignes. Une suite « verte » peut donc ne rien avoir rapproché. Le correctif écrit le 28/10/2026 (variable `ANALYTICS_STRICT=1`, qui transforme un saut en échec) n'a pas encore tourné : à la clôture, la seconde passe se rejoue avec cette variable et exige zéro saut (§9).
- Les tâches de réconciliation (`audit.chain.verify_daily`, `inventory.ledger.reconcile_daily`, `finance.cash.reconcile_daily`) publient leur événement puis se terminent en succès : elles ne lèvent plus à l'écart (suivi §3, changement de comportement signalé).

---

## 4. Ce qui n'est pas livré

- **Écrans ECR-ANA-01 à 06 et ECR-NOT-01 à 03** : lot séparé, **non commencé** (plan §4, P9 ; matrice §17.11, dernière ligne). Aucun écran de P9 n'est inscrit au suivi des écrans ([`15-ecrans-pwa.md`](15-ecrans-pwa.md)). Conséquences : la DoD (« la Direction répond seule aux questions du CM §62 ») n'est **pas démontrée** ; la lisibilité de la tour de contrôle en moins de 30 s (NFR-12, test utilisateur) ne peut pas être vérifiée.
- **Jeux hors ligne `comms` et `kpi` côté PWA** : le serveur les publie, mais la PWA ne les applique pas (besoin B3 du suivi §5 : `KNOWN_DATASETS`). Les lignes `ALERT`, `NOTIFICATION`, `NOTE` du jeu `comms` et le jeu `kpi` sont ignorés ; AT-048 n'est donc démontré que côté serveur.
- **Web Push désactivé** : seul le port existe, l'adaptateur par défaut est `DisabledWebPushSender` ; seul le canal in-app est en service. Bibliothèque, clés VAPID et abonnements valides dépendent d'AV-365 (IMPORTANTE, à trancher). Le correctif de robustesse de l'envoi (NT-4) est vérifié par la suite du 28/10/2026.
- **`KOMMO_SYNC_FAILED`** : sans détecteur, règle semée désactivée. Le 36e type du catalogue relève de la phase P10, reportée et hors du périmètre depuis le 26/10/2026 (CLAUDE.md, § 1). Aucun code Kommo.
- **`DeviceEnrollmentRequested`** : l'événement d'enrôlement d'appareil n'est pas publié, donc aucune notification directe aux approbateurs d'un appareil en attente (AV-432).
- **Indicateurs de D11 §7.1 : livrés en P9-27** (décision du porteur du 29/10/2026, AV-462 choix (b)). KPI-COM-16, KPI-PRD-04, KPI-PRD-05, KPI-PRD-09 et KPI-OPS-02 (avec le code local `KPI-OPS-02-CONFLICTS`) sont à l'état `EXISTING` : fonctions `sales.targetAttainment`, `production.feedConsumption`, `production.latestWeighing`, `production.costPerHead`, `sync.syncBacklog`, essais d'équivalence (AT-054), blocs ÉQUIPES, PRODUCTION et DISTRIBUTION des tableaux ; seul KPI-PRD-04 a un lien d'exploration. Restent **non vérifiés** : le code et les essais de P9-27 n'ont ni été compilés ni exécutés. KPI-FIN-06 est à l'état `EXISTING` d'après AV-462, mais le bloc FINANCES des tableaux ne porte pas la trésorerie.
- **Écarts connus à D11 §7.2** (matrice §17.11) : le bloc STOCK ne porte pas le disponible par zone (KPI-STK-01) ; le bloc VENTES n'a ni détail par canal ni classement des commerciaux. Aucun essai ne rapproche les chiffres par canal d'une source (REQ-022).
- **Passes de détection paginées** : l'ADR-068 §3 prévoyait des pages de 500 sujets ; une passe reste une seule transaction de la voie courte, avec durée consignée et marqueur retenu au-delà de 100 s (AV-468, pagination reportée à la mesure).
- **Alerte technique `JOB_FAILED`** : livrée en P9-27 (décision du porteur du 29/10/2026, AV-469 choix (b)) : 37e type du catalogue, migration `20261202090000_add_job_failed_alert_type.sql`, passe `communication.jobs.failure_check` (cinq minutes) ; comme le reste de P9-27, vérifiée par la suite du 30/10/2026. La sonde `/health/ready` reste en place.
- **Aucun index de jour métier ajouté** (AV-450) : décision d'attendre la mesure.
- **Restes de la revue après les correctifs du 28/10/2026** : NT-4 (`PushSendOptions` n'est pas exporté par l'API publique de `communication` : aucun consommateur externe, non fait), PF-1 (le script `db:purge-alerts` est lancé par `tsx`, comme `approve-device` ; le point d'entrée compilé `src/purge-alerts.ts`, pour une exploitation sans `tsx`, n'est pas écrit), PF-10 (cas XLSX d'EX-4 et fenêtre de sept jours de PF-8 dans l'essai de charge ; le générateur n'a jamais tourné). AL-4 (le champ `resolutionMode` de la règle est renseigné depuis le catalogue) et EP-2 (l'export s'exécute avec `totals: null`) ont été terminés à la main après le lot, avant la suite.

---

## 5. Ce qui n'est pas mesuré

Liste déposée au suivi §4 (revue de P9, PF-8, 28/10/2026) et reprise ici sans changement ; elle ne devient « mesurée » qu'avec une date, un jour de la semaine et le volume imprimé (ventes, lignes, produits, sites).

- **Mesuré** : **rien à ce jour**. Ni `load:p9` (générateur du jeu de charge) ni `test:perf` (essai de charge) n'ont tourné (CONFIRMÉ : suivi §4).
- **Écrit mais non exécuté** (`apps/server/test/perf/analytics.perf.ts`, jeu `db/load/p9-load-set.ts`, base dédiée dont le nom se termine par `_load`) :
  - tour de contrôle sur la semaine civile en cours (condition : jeu généré le jour même) et sur 366 jours, p95 ≤ 3 s (NFR-12) ; le document 23 (PF-10) note que la plage de 7 jours est calée par `from`/`to`, à confirmer si le contrôleur la traite comme `period=WEEK` ;
  - explorateur à 90 jours, p95 ≤ 5 s (NFR-13) ;
  - export de 100 000 lignes en moins de 2 minutes (NFR-13) ;
  - cas XLSX éventuel (EX-4), non écrit.
  Le jeu compte au plus 40 produits actifs, un site et une zone ; le test refuse une base non dédiée, un jeu incomplet ou de moins de 500 000 lignes (`P9_PERF_MIN_LINES`).
- **Non mesuré** :
  - plans `EXPLAIN` et poussée des conditions dans les vues `TEMPTABLE` : l'`EXPLAIN` d'une vue exigerait `SHOW VIEW` (DÉDUIT du manuel MySQL, non essayé) ; une assertion de plan est écartée comme instable ;
  - chemin confiné : étendue exacte, 500 candidats, listes `IN` ;
  - délai événement → alerte (NFR-15, p95 ≤ 10 s) : aucune métrique de délai, seul le retard des consommateurs est calculé ;
  - jeux sans jour métier généré (AV-450) ;
  - durée des passes de détection (AV-468) ;
  - lot d'instantanés (budget de 60 s à confirmer par la mesure) ;
  - facteur 10 de H-06 (NFR-33, test de charge à 10 fois avant R4) ;
  - test utilisateur de NFR-12 (impossible sans écrans) ;
  - plafond global des explorations simultanées : désactivé par défaut depuis P9-27 (AV-461, décision du porteur), la saturation du pool par quelques calculs lents n'est pas mesurée;

Conséquence (DÉDUIT) : RISK-13 (analytics trop coûteux) est traité par des bornes (limites en erreur, plafond par utilisateur et plafond global optionnel, voie longue du worker, vues en lecture seule), pas par une mesure.

---

## 6. Revue adverse (P9-25)

**Bilan chiffré** ([`23-revue-p9-constats.md`](23-revue-p9-constats.md), état du 28/10/2026). Six domaines relus, chaque relecteur chargé de réfuter ses propres constats ; **47 constats** : 8 sur les exports (EX-1 à EX-8, revue du 26/10) et 39 sur les cinq autres domaines (alertes AL, notifications et notes NT, explorateur et indicateurs EP, tableaux et instantanés TB, plateforme PF, revue du 28/10). Aucun BLOQUANT. Gravité : 15 MAJEUR (EX-1 et 14 sur les 39), 32 MINEUR. Sur les 39 : 22 CONFIRMÉS et 17 PLAUSIBLES ; **aucun n'a été vérifié par un second lecteur**, et un PLAUSIBLE n'est pas un défaut établi (CONFIRMÉ : document 23, en-tête).

Traitement des 47 constats (document 23, § 7) :

| Sort | Constats | Nombre |
|---|---|---|
| Corrigé, vérifié par la suite du 28/10/2026 | EX-1 à EX-8 | 8 |
| Corrigé, essais joués par la suite | AL-1, AL-3, AL-4 ; NT-1, NT-2, NT-3, NT-5, NT-6, NT-7 ; EP-1, EP-2, EP-3, EP-4, EP-5, EP-6 ; TB-1 à TB-9, TB-11, TB-12 ; PF-2 à PF-7 | 32 |
| Corrigé en partie (restes au §4) | NT-4, PF-1, PF-10 | 3 |
| Couvert par d'autres correctifs | PF-9 (par TB-3 et TB-8) | 1 |
| Documenté sans correctif de code | PF-8 (plans `EXPLAIN` : documentés comme non mesurés, §5) | 1 |
| Consigné sans correctif, avec la raison | AL-2, TB-10 | 2 |

Précisions :

- **Consignés avec raison.** AL-2 (un événement de passe sauté après cinq essais n'empêche pas le marqueur de résoudre) : déclencheur lointain, effet borné à une période de passe, et le garde proposé figerait durablement des alertes d'état réglées ; écrit comme limite connue dans ADR-061 §3 et §12. TB-10 (un bloc indisponible disparaît de l'instantané) : reporter d'anciennes valeurs sous une nouvelle date serait trompeur ; marqueur par bloc à décider avec l'écran hors ligne.
- **PF-3** est « corrigé » par un report : pagination différée (AV-468), garde-fou de durée ; la durée de passe n'a jamais été mesurée. **PF-4** était corrigé par EP-2 (plafond global, AV-461), plafond désactivé par défaut le 29/10/2026 (P9-27).
- **Constats réfutés.** Le scénario de TB-1 pour la Direction et la Finance affectées à une zone est réfuté (latent : leur permission est en portée totale) ; le sous-constat « p95 de l'explorateur à 7 jours » de PF-8 est réfuté (non exigé par l'ADR ni par NFR-13).
- **Choix métier nés de la revue** : AV-460 à AV-472 (13 points), tranchés le 29/10/2026 ; AV-461, AV-462 et AV-469 mis en œuvre en P9-27 (vérifié le 30/10/2026), qui ouvre AV-473 à AV-484.
- **Mutations.** Les incréments de P9-02 à P9-14 ont chacun été éprouvés par mutation sur base jetable (comptes de mutants détectés, survivants et équivalents au suivi §2 et §8 à §16). Les correctifs du 28/10/2026 n'ont pas été éprouvés par mutation ; ils sont couverts par les essais de la suite complète (§8) et n'ont eu **aucune seconde revue adverse** : le diff (environ 140 fichiers) n'a été relu que par le typage, le lint, les frontières de modules et ces essais.
- **Revues adverses antérieures** (suivi) : conception, 60 constats retenus (4 graves, 22 moyens, 34 mineurs) ; P9-05, 31 constats retenus dont neuf corrigés ; P9-08, 39 constats bruts dont 33 confirmés, aucun bloquant ; P9-10, 31 constats ; P9-11, 15 constats dont deux majeurs ; P9-13, deux revues dont une de 23 constats.

Fait à la vérification groupée du 28/10/2026 (§8) : `packages/domain/dist` et `@gic/contracts` reconstruits par le typage, formatage Prettier depuis la racine, suites rejouées sur une base neuve après `db:migrate` (migration `20261201090700`, privilège `DELETE` sur les sauts de consommateurs) et `db:seed` (réglages ajoutés, comptés par `db/tests/seed.test.ts`). Reste : les restes du §4 et les constats nouveaux, à rapporter en AV à partir du numéro 473.

---

## 7. Points laissés au porteur

**Décisions du porteur du 29/10/2026** : AV-460 à AV-472 sont tranchés (journal des décisions de [`A-VALIDER.md`](../A-VALIDER.md) §3) ; les trois qui s'écartaient du défaut implémenté sont mis en œuvre en P9-27 (AV-461 : plafond global désactivé par défaut ; AV-462 : cinq indicateurs livrés ; AV-469 : alerte `JOB_FAILED`). Le tableau ci-dessous garde la décision de chacun ; il reste à trancher, en priorité avant le pilote, AV-473 à AV-484 (tous SECONDAIRE, défauts paramétrables ou sans effet irréversible).

| AV | Question | Classe | Défaut implémenté |
|---|---|---|---|
| AV-460 | Un demandeur qui a perdu un droit depuis le calcul peut-il encore télécharger son export ? | SECONDAIRE | Droits revérifiés au téléchargement (réglage `analytics.export_download_revalidate_rights`, vrai) ; **à confirmer** |
| AV-461 | Plafond global des explorations simultanées | SECONDAIRE | **Tranché (29/10)** : aucun plafond global par défaut (`analytics.query_max_concurrent_global` = 0, activable) ; mis en œuvre en P9-27 |
| AV-462 | Livrer ou non les cinq indicateurs sans fonction ni écran | SECONDAIRE | **Tranché (29/10)** : livrés ; mis en œuvre en P9-27 (§4) |
| AV-463 | Propriétaire de l'alerte de créance échue sans commercial | SECONDAIRE | Le vendeur à défaut |
| AV-464 | Mode de résolution d'une règle d'alerte | SECONDAIRE | Celui du catalogue, affiché, non réglable |
| AV-465 | Clients actifs et inactifs d'un commercial terrain borné par une zone | SECONDAIRE | Titulaire seul ; site de rattachement quand la portée ne porte que des sites |
| AV-466 | Point de départ du délai d'escalade d'une alerte arrivée en retard | SECONDAIRE | Instant du traitement par le serveur |
| AV-467 | Contenu de l'instantané `distribution` | SECONDAIRE | Les quatre indicateurs du bloc DISTRIBUTION, plus KPI-OPS-02 depuis P9-27 (AV-480) |
| AV-468 | Passes de détection : transaction unique ou pages | SECONDAIRE | Transaction unique ; pagination reportée à la mesure |
| AV-469 | Supervision du worker et export dont la tâche est perdue | SECONDAIRE | Sonde en secondes, tâches `FAILED` rapportées, export `FAILED` à l'épuisement ; **tranché (29/10)** : plus l'alerte `JOB_FAILED` à l'Admin, mise en œuvre en P9-27 |
| AV-470 | Purge des alertes closes : script sous un rôle de maintenance | IMPORTANTE | Script d'exploitation, plancher de 730 jours ; **l'exploitation doit le planifier avant le pilote** |
| AV-471 | Notifications purgées (lues, lignes Web Push, notes publiées) | SECONDAIRE | Lues depuis plus de 90 jours et lignes d'envoi, jamais celles d'une note publiée |
| AV-472 | Rétention des tâches terminées et des sauts de consommateurs | SECONDAIRE | 30 et 90 jours, jamais dans la fenêtre de `CONSUMER_FAILED` |
| AV-473 | Atteinte d'objectif (KPI-COM-16) : objectifs `USER`, agrégation, lecteur | SECONDAIRE | Valeur du tableau = CA réalisé ÷ visé, autres métriques en détail ; indicateur absent pour une étendue de sites seuls ; rendu avec `crm.target.read` |
| AV-474 | Atteinte d'objectif : fenêtre du réalisé | SECONDAIRE | Réalisé cumulé du début de l'objectif au jour de lecture (plafonné à aujourd'hui) |
| AV-475 | Poids moyen et coût par tête : type de lot de référence | SECONDAIRE | Type comptant le plus de têtes en élevage, autres types en détail |
| AV-476 | Consommation d'aliment (KPI-PRD-04) : source et unité | SECONDAIRE | Consommations `ALIMENT` imputées aux lots (`inventory_consumptions`), en kg |
| AV-477 | Poids moyen (KPI-PRD-05) : pesée de référence et pondération | SECONDAIRE | Dernière pesée de chaque lot en élevage, sans plafond d'ancienneté, pondérée par l'effectif |
| AV-478 | Coût par tête (KPI-PRD-09) : agrégation | SECONDAIRE | Σ coûts restants ÷ Σ effectifs non vendus, à l'instant de lecture |
| AV-479 | Opérations en attente et conflits ouverts (KPI-OPS-02) : définition et périmètre | SECONDAIRE | Deux indicateurs ; appareils en service des points de vente ouverts ; conflits avec `sync.conflict.resolve` |
| AV-480 | Place des cinq indicateurs dans les blocs ; instantané `distribution` | SECONDAIRE | ÉQUIPES, PRODUCTION, DISTRIBUTION ; instantané à cinq indicateurs (six avec les conflits) |
| AV-481 | `JOB_FAILED` : durée de l'alerte après un échec corrigé | SECONDAIRE | Fenêtre de 24 h, résolution automatique seulement |
| AV-482 | `JOB_FAILED` : écran d'action | SECONDAIRE | Aucun lien (pas d'écran de supervision des tâches) |
| AV-483 | `JOB_FAILED` : cadence de la passe | SECONDAIRE | 5 minutes, non réglable |
| AV-484 | `JOB_FAILED` : regroupement et seuil | SECONDAIRE | Un type de tâche, un échec suffit |

Les 101 autres points de P9 (AV-350 à AV-450, dont les 22 IMPORTANTE du §1.1) restent `OUVERT` avec leur défaut implémenté ; AV-365 (Web Push) conditionne la mise en service de ce canal ; AV-013 (client inactif, 30 jours) est maintenant lu par les tableaux (TB-5, réglage `crm.inactive_after_days`).

Déjà connus, hors P9 (CLAUDE.md, § 1, « À faire ») :

- AV-296, AV-297 et AV-320 (motifs de rejet jamais semés, à poser au porteur) avant le déploiement du pilote ;
- **vérification dans le navigateur et sur un téléphone : jamais faite**, pour les écrans de toutes les phases ; elle n'a de sens pour P9 qu'une fois les écrans ECR-ANA et ECR-NOT livrés ;
- marge d'un lot pilote validée par la Direction (DoD de P8) ;
- AV-451 (régime de TVA de la facture imprimée, lot des pièces papier).

Autres décisions attendues :

- **Feu vert pour le lot des écrans de P9** (ECR-ANA-01 à 06, ECR-NOT-01 à 03, et l'application des jeux `comms` et `kpi` côté PWA) : sans lui, la DoD de P9 reste ouverte.
- **Planification de la purge des alertes** (AV-470) par l'exploitation.
- **Mesure de charge** (§5) : à lancer sur une base `_load` dédiée avant d'affirmer NFR-12, NFR-13, NFR-15 et NFR-33.

---

## 8. Résultats de la suite complète du 28/10/2026

Exécution du 28/10/2026 sur MySQL 8.4 (port 3307), base neuve `gic_agropelc_p9v` (`reprise/final_suite.sh`), sur le commit `c313065` plus l'arbre de travail (le lot P9-25 n'était pas encore commité), puis rejeux ciblés sur des bases neuves (`gic_agropelc_p9w`, `gic_agropelc_p9x`) :

| Étape | Résultat |
|---|---|
| Migrations (22 s) et semis (7 s) | verts |
| Typage des cinq paquets (`pnpm run typecheck`) | vert |
| ESLint (`npx eslint apps packages db`) | vert |
| Frontières de modules (`pnpm run check:boundaries`) | vert |
| Références documentaires (`check_refs.py`) | vert (une fois ce document écrit) |
| Domaine | 774 essais, 46 fichiers, verts |
| Contrats | 268 essais, 13 fichiers, verts |
| Base | 246 essais, 25 fichiers, verts |
| PWA | 860 essais, dont 1 sauté ; 1 échec sans lien avec P9 (écart de fins de ligne entre la feuille de style des pièces papier et sa copie, sous Windows) : essai rendu insensible aux fins de ligne, fichier rejoué (32 essais verts) |
| Serveur, premier passage | 212 fichiers, 2 180 essais dont 9 sautés (huit dans `analytics-views-commercial`, un dans `analytics-views-stock`, faute de ventes en base à cet instant) ; 3 échecs, tous dans des essais |
| Serveur, second passage (base neuve) | 2 166 essais verts, 9 sautés, 1 échec (essai de l'abandon d'export), corrigé |
| Seconde passe stricte `ANALYTICS_STRICT=1` des essais d'analyse, sur la base peuplée par la suite | 17 fichiers, 269 essais, **aucun saut** ; le seul échec (le même essai) corrigé, fichier rejoué en mode strict : 25 essais verts, puis `p9-invariants` : 8 essais verts |

Défauts trouvés par cette vérification, tous dans des essais écrits avant ou pendant le lot et jamais exécutés jusque-là, aucun dans le code livré :

- **EX-5 (étendue tronquée)** : l'acteur de l'essai avait la portée maximale `ALL`, son étendue n'était jamais tronquée ; portée `SITE` posée.
- **Jeu hors ligne `comms`, note lue par un utilisateur affecté après la publication** : l'essai comparait des dates de test (maintenant + 1 minute) à l'heure réelle du lecteur depuis NT-2 ; essai replacé dans le passé.
- **INV-ANA-01 (audit des exports)** : trois essais laissaient dans la base partagée un export sans ligne d'audit exigée — EX-2 (échec forcé par SQL), EX-1 (fin écrite par la couche de stockage), PF-5 (export inséré sans audit de demande). Ils passent maintenant par la conclusion réelle, par une transaction annulée ou par une ligne d'audit écrite avec la ligne.
- **Un essai illisible** : une chaîne coupée par un retour à la ligne, vue par Prettier et ESLint.
- **Deux restes de code**, écrits à la main après le lot : l'export s'exécute avec `totals: null` (EP-2) ; le mode de résolution d'une règle d'alerte est lu depuis le catalogue (AL-4).

**Ce que ces résultats ne démontrent pas** : aucune seconde revue adverse des correctifs (le diff n'a été relu que par le typage, le lint, les frontières et ces essais) ; la mesure de charge, les plans `EXPLAIN` et NFR-15 (§5) ; aucun essai dans un navigateur ni sur un téléphone ; les écrans de P9 (§4). Le format de la suite (`final_suite.sh`, étape `format`) a échoué sur un fichier `.sql` que Prettier ne sait pas lire et sur une ligne de commande trop longue : le formatage a été vérifié à part, sur les 134 fichiers de code modifiés (« All matched files use Prettier code style »).

**Suite complète du 30/10/2026 (après P9-27)**, base neuve `gic_agropelc_p9y` : migrations et semis, typage des cinq paquets, ESLint, frontières de modules et références documentaires verts. Domaine 781 essais (46 fichiers), contrats 268, base 246, PWA 859 verts et 1 sauté, serveur 216 fichiers et 2 234 essais : cinq échecs au premier passage, tous dans des essais. L'essai de l'atteinte d'objectif créait des clients sans titulaire dénormalisé et des visites sans l'indicateur « hors session » (INV-CRM-02 et BR-CRM-013, balayés sur toute la base) : corrigé et rejoué ; trois essais de réception sans document ont dépassé leur délai sous charge (la suite a duré 28 minutes au lieu de 15) et passent à froid (27 essais). Essais de P9-27 : `kpi-target-attainment` 7, `kpi-production-lot-indicators` 16, `kpi-sync-backlog` 5. Passe stricte `ANALYTICS_STRICT=1` : 17 fichiers, 286 essais, aucun saut ; invariants de P9 : 8 essais. **Mise en ligne le 30/10/2026** (livraison `20261030-134330`, commit `ec29ea7`, [`deploy/hostinger/`](../../deploy/hostinger/README.md)) : deux migrations appliquées, `GET /health/ready` répond 200 avec la nouvelle sonde. Ces résultats ne démontrent ni une seconde revue adverse du code de P9-25 et de P9-27, ni un essai dans un navigateur.

---

## 9. Rejouer

Depuis `apps/server`, avec `DATABASE_URL` et `SERVER_DATABASE_URL` pointant sur une base MySQL 8.4 neuve, migrée et semée (port 3307) ; `packages/domain/dist` et `@gic/contracts` reconstruits au préalable :

```bash
npx vitest run test/p9-acceptance.e2e.test.ts test/p9-invariants.test.ts test/production-acceptance.test.ts test/sales-acceptance.test.ts
```

```bash
npx vitest run test/communication-comms-sync.test.ts test/communication-note-commands.test.ts test/inventory-stock-alert-transitions.test.ts test/inventory-stock-alert-passes.test.ts test/production-high-mortality-alert.test.ts
```

Seconde passe des essais d'analyse, **après** les fichiers producteurs de données, zéro saut exigé (EP-4) :

```bash
ANALYTICS_STRICT=1 npx vitest run test/analytics-
```

Mesure de charge, à la demande, sur une base dédiée dont le nom se termine par `_load` (`db/README.md` § 7) :

```bash
pnpm --filter @gic/db load:p9
pnpm --filter @gic/server test:perf
```
