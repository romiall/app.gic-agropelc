# ADR-068 — Charge (RISK-13), paliers analytiques et rétention des données de P9

- **Statut** : ACCEPTÉ (DÉDUIT, technique ; applique NFR-12, NFR-13, NFR-15, RISK-13, AV-086 et la stratégie analytique §6 ; les choix métier sont AV-386, AV-387 et AV-388, défauts paramétrables)
- **Date** : 14/10/2026 (numéro provisoire 078 de la plage 070 à 079, renuméroté ADR-068 à l'intégration du 26/10/2026 ; révisé le même jour après la revue adverse de la conception)
- **Précise** : [ADR-060](ADR-060-architecture-de-p9-communication-et-analytics.md), [ADR-064](ADR-064-couche-semantique-et-explorateur.md), [ADR-066](ADR-066-tableaux-tour-de-controle-et-instantanes.md)
- **Questions liées** : AV-086, AV-386, AV-387, AV-388

## Contexte

P9 ajoute des lectures larges (explorateur, tour de contrôle, exports) et des écritures de fond (alertes, instantanés) sur une base OLTP partagée. La volumétrie cible (AV-086, hypothèse H-06) est de 150 utilisateurs, 40 sites et 5 000 lignes de vente par jour, soit environ 5,5 millions de lignes de vente à trois ans. La stratégie analytique §6 fixe le palier de départ (vues SQL + instantanés) et le passage au palier suivant (agrégats journaliers) au franchissement de p95 > 3 s ou de 20 millions de lignes de faits.

Faits de la plateforme :
- **Consommateur** : `EventConsumerRunner` ouvre une transaction **par événement** (jusqu'à 5 essais), enregistre la position après chaque événement, et ne dépasse pas un trou récent de numérotation (`settledSequenceBound`, 120 s par défaut) : un événement derrière un trou attend jusqu'à 120 s.
- **Worker** : boucle série (ordonnanceur, un lot par consommateur, puis les tâches dues) ; une tâche longue retarde les consommateurs.
- **Tâche** : `JobRunner` exécute le gestionnaire dans **une** transaction sous un point de sauvegarde ; `JobHandler = (uow, payload)` n'ouvre pas de seconde transaction.
- **Suppression** : le rôle d'application n'a le privilège `DELETE` que sur les tables `PURGE_TECHNIQUE` et `LIBRE` ; les autres purges sont exécutées par un rôle de maintenance distinct (`03-historisation-suppression.md` §4).

## Décision

1. **Toute lecture est bornée** :
   - une période obligatoire pour un jeu daté, au plus trois ans en détail, 366 jours pour un tableau ;
   - `LIMIT + 1` imposé par le compilateur (affichage 10 000, export 100 000), dépassement = erreur (ADR-064 §8) ;
   - durée maximale par requête (ADR-064 §8) ;
   - au plus `analytics.query_max_concurrent_per_user` requêtes simultanées par utilisateur (2) : au-delà, 429 `QUERY_LIMIT_EXCEEDED` (D11 §8, détail `concurrency`).
2. **Aucun balayage complet à la lecture** : la boîte d'alertes se lit par l'index `alert_recipients (user_id, alert_id)` joint à `alerts` (filtré sur `status`) et, pour la supervision, par `alerts (status, severity, first_detected_at)`, `(site_id, status)` et `(owner_user_id, status)` ; un tableau appelle des fonctions bornées par période et par périmètre ; l'instantané personnel évite le calcul à l'ouverture. Les compteurs d'alertes suivent la lecture exacte d'ADR-062 §3 ; le compteur de validations est un balayage borné par plafond (ADR-066 §4).
3. **Écritures de fond bornées et isolées** :
   - le consommateur d'alertes est une transaction par événement, des écritures en nombre borné par événement (une alerte, ses destinataires, ses notifications) ;
   - une passe de détection traite des pages de `analytics.pass_page_size` sujets (500) ; une passe de plusieurs pages est une **chaîne de tâches de continuation** (curseur dans la charge utile) et son marqueur n'est publié que par la dernière page d'une passe complète (ADR-061 §3) ;
   - la tâche d'instantanés traite au plus `analytics.snapshot_batch_size` utilisateurs par passe (200) avec un budget de durée, et reprend à la passe suivante ;
   - les tâches longues (`analytics.export.run`, `analytics.kpi_snapshots.refresh`) sont **isolées du consommateur d'alertes** : le worker les exécute dans une boucle distincte (partition par `jobTypes` de `claimAndProcessOne`) ou avec un budget de tours (`runOnce`), faute de quoi un export de 120 s retarde toutes les alertes. C'est un changement de `platform/worker` (ajout, signalé au suivi §3) ; en attendant, l'export est borné à un quantum et repris ;
   - un gestionnaire de tâche ne lève jamais pour un échec métier (il le consigne et rend normalement) : seule une erreur technique justifie un rejeu.
4. **Indexation prouvée** : aucun index n'est ajouté sans une requête mesurée (`EXPLAIN` dans le test, plan sans balayage de table pour les chemins du tableau 7.2 et de l'explorateur sur le jeu de charge). Chaque index nouveau est dans une migration de la plage de P9 avec la requête qui le justifie (ADR-064 §9).
5. **Mesure** : un jeu de charge déterministe (générateur dans `db/`, hors de la suite par défaut) produit un million de lignes de vente et leurs satellites ; un test de performance, lancé à la demande (`test:perf`), vérifie p95 ≤ 3 s sur la tour de contrôle avec une plage de 366 jours **et** de 7 jours, p95 ≤ 5 s sur l'explorateur à 90 jours (NFR-12, NFR-13), un export de 100 000 lignes en moins de 2 minutes, et le délai événement → alerte (§7). Le résultat figure dans la démonstration de clôture, avec ce qui n'a pas été mesuré : le facteur 10 de H-06 reste la porte d'avant production (NFR-33). Les plans `EXPLAIN` sont, eux, dans la suite par défaut.
6. **Paliers** : P9 reste au palier 1. Le passage au palier 2 (agrégats journaliers maintenus par événements, jamais source de vérité) est déclenché par la mesure du point 5 ou par la production, pas par anticipation ; la couche sémantique le permet sans changer les contrats (une vue peut devenir une table d'agrégats).
7. **Délai et retard du consommateur** (NFR-15 : p95 ≤ 10 s) :
   - le **délai** événement → alerte se mesure de `recorded_at` de l'événement à `created_at` de l'alerte (p95 sur fenêtre glissante) ; il est nominal sous 10 s, mais un événement derrière un trou de numérotation récent attend jusqu'à 120 s, y compris une alerte `CRITICAL` « immédiate » (BR-NOT-004) : tolérance documentée (AV-388) ;
   - le **retard** se mesure à l'âge (`recorded_at`) du plus ancien événement non livré à `communication.alerts` ; un seuil informatif à 10 s, et `CONSUMER_FAILED` à `communication.consumer_lag_alert_seconds` (300), volontairement au-dessus de la fenêtre de 120 s ;
   - la fenêtre propre au consommateur d'alertes n'est raccourcie (option `settleSeconds` du runner) que si la mesure l'exige.
8. **Rétention** (suppression technique seulement pour ces tables ; rien d'autre n'est supprimé). Les durées sont des paramètres.

   | Donnée | Durée | Mécanisme | Paramètre |
   |---|---|---|---|
   | Alertes résolues ou écartées, leurs destinataires | 2 ans après résolution | purge par le rôle de maintenance ; `BEFORE DELETE` limité aux alertes `RESOLVED`/`DISMISSED` de plus de 2 ans | `communication.alert_retention_days` (730) |
   | Notifications lues | 90 jours après lecture | `PURGE_TECHNIQUE`, tâche de l'application | `communication.notification_retention_days` (90) |
   | Abonnements push révoqués ou invalides (410) | à la révocation | `PURGE_TECHNIQUE`, tâche de l'application | — |
   | Fichiers d'export | 30 jours (ligne conservée, `EXPIRED`) | tâche de l'application, `ChunkStorage.delete` | `analytics.export_file_retention_days` (30) |
   | Journal des requêtes de l'explorateur | 90 jours | `PURGE_TECHNIQUE`, tâche de l'application | `analytics.query_log_retention_days` (90) |
   | Marques de consommateur, événements, audit | conservés | `IMMUABLE` | — |
   | Instantanés personnels | écrasés ; supprimés à la perte du droit ou de l'appareil actif | projection (ADR-066 §5) | `analytics.snapshot_active_days` (7) |
   | Notes de direction, accusés | conservées (immuables) | BR-NOT-006 | — |

   `03-historisation-suppression.md` §3 reçoit les lignes correspondantes dans le même commit.

## Alternatives écartées

- **Matérialiser dès P9 des agrégats** : maintenance incrémentale et rattrapage des opérations tardives sans besoin mesuré.
- **Plafonner par délai seulement** : un calcul rapide mais illimité en lignes charge la mémoire du serveur.
- **Purger sans conserver la ligne d'export** : l'audit (BR-ANA-008) exige la trace.
- **Raccourcir la fenêtre de stabilisation de tous les consommateurs** : elle protège les événements validés tardivement (révocation de quotas, cache des droits) ; elle ne se change pas pour un seul besoin sans mesure.

## Conséquences

- La charge est une propriété testée (plans, bornes, concurrence, délai), pas une promesse ; le rapport de mesure de la clôture dit ce qui a été mesuré et ce qui ne l'a pas été.
- Les purges de l'application sont des tâches récurrentes de `communication` et `analytics`, avec leur test (une donnée en deçà de la durée n'est jamais supprimée) ; celle des alertes passe par la procédure de maintenance.

## Révision du 22/10/2026 (P9-22)

- **Voie longue du worker (§3, AV-450)** : `platform/jobs/job-lanes.ts` liste les tâches longues (`analytics.export.run`, `analytics.kpi_snapshots.refresh`) ; `WorkerService.start` joue deux boucles concurrentes, la voie courte (ordonnanceur, consommateurs, tâches courtes : `JobRunner.claimAndProcessOne({ excludeJobTypes })`) et la voie longue (`{ jobTypes }`), de sorte qu'un export de 120 s ne retarde ni une alerte ni une tâche courte. `runOnce()` (tests, passe unique) joue les deux voies à la suite. Le lot d'instantanés est de 50 utilisateurs (AV-448) et non de 200.
- **Purges (§8)** : `analytics.maintenance.purge_daily` (quotidienne) supprime les lignes du journal des requêtes de plus de `analytics.query_log_retention_days` jours (90), passe `EXPIRED` les exports échus, supprime les fichiers d'export `analytics.export_file_retention_days` jours (30) après la demande, abandonne les exports perdus ; les instantanés des inactifs sont retirés par la tâche d'instantanés.
- **Index et mesure (§4 et §5, AV-450)** : aucun index n'est ajouté. Le jeu de charge (`pnpm --filter @gic/db load:p9 [ventes] [jours]`, ventes et lignes de vente seulement, déterministe, base jetable) et les mesures (`pnpm --filter @gic/server test:perf` : p95 de la tour sur 7 et 366 jours, de l'explorateur à 90 jours, durée d'un export de 100 000 lignes) décident ; le résultat figure dans la démonstration de clôture, avec ce qui n'a pas été mesuré (encaissements, mouvements, coûts, facteur 10 de H-06).

## Tests

Bornes (période, lignes, durée, concurrence), plans `EXPLAIN` sans balayage complet, tâches par pages et reprise après interruption, tâche longue sans retard du consommateur, purges (limites incluses et exclues, rôle de maintenance), métriques de délai et de retard.
