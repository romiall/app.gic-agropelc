# ADR-070 — Architecture de P9 : modules `communication` et `analytics`, flux des événements et des lectures

- **Statut** : ACCEPTÉ (DÉDUIT, technique ; applique ADR-011, ADR-021, ADR-030, ADR-035 et le graphe de dépendances ; les choix métier sont les AV 400 à 442, défauts paramétrables)
- **Date** : 14/10/2026 (numéro provisoire de la plage 070 à 079 de la session P9 ; renumérotation à l'intégration ; révisé le même jour après la revue adverse de la conception)
- **Précise** : [ADR-011](ADR-011-architecture-backend.md) (outbox), [ADR-030](ADR-030-accueil-par-role.md) et [ADR-035](ADR-035-tableaux-d-analyse-avant-p9.md) (composition en couche de transport)
- **Questions liées** : AV-064 à AV-067, AV-086, AV-400 à AV-442

## Contexte

Avant P9, aucun module `analytics` ni `communication` n'existe dans le code, bien que le graphe de dépendances les déclare (`analytics → identity` ; `communication → identity, organization`) et que les phases précédentes y renvoient : « alerte : P9 » (P4-09, P5-08, P5-12, P5-15, P5-16, P6), `escalated_at` jamais écrit, jeux hors ligne `comms` et `kpi` spécifiés sans producteur.

Contraintes du projet :
- une table n'est écrite que par son module propriétaire (CLAUDE.md §3.5) ; un module n'importe que l'API publique des modules de niveau inférieur ;
- les modules propriétaires (`sales`, `inventory`, `finance`…) n'ont pas le droit d'importer `communication` (graphe) ;
- les tableaux d'analyse déjà livrés (accueil, tableau de distribution) sont composés dans une couche de transport hors `modules/`, à partir des fonctions publiques des modules (ADR-030, ADR-035) ;
- les événements métier sont écrits dans la transaction du fait ou de la tâche (`platform_domain_events`) et lus au moins une fois par des consommateurs idempotents (ADR-011).

## Décision

1. **Deux modules, chacun avec sa couche de transport.**
   - `communication` (tables `communication_*`) : règles d'alerte, alertes, destinataires, notifications, abonnements push, notes de direction. Dépendances : `identity`, `organization`.
   - `analytics` (tables `analytics_*`) : vues sauvegardées, exports, instantanés ; catalogue de la couche sémantique et compilateur de requêtes. Dépendance : `identity`.
   - Couches de transport `communication-api/` et `analytics-api/` (hors `modules/`, non soumises au graphe, comme `home-api/` et `distribution-api/`) : contrôleurs HTTP et composition de plusieurs modules.
   - Câblage : `XxxModule`, `XxxJobsModule` (importé par `app.module.ts` et `worker/worker.module.ts`), `XxxApiModule`.
2. **Alertes : les faits montent par événements, jamais par lecture.** Le module propriétaire d'un fait publie un événement nommé dans sa transaction (ou dans sa tâche planifiée) ; le consommateur `communication.alerts` (registre `EVENT_CONSUMER_REGISTRY`, worker) le transforme en alerte (ADR-071). `communication` ne lit aucune table d'un autre module ; aucun module propriétaire n'importe `communication`.
3. **Analyse : les valeurs viennent des définitions existantes.** Les tableaux de P9 (tour de contrôle, tableaux de rôle) sont composés dans `analytics-api/` à partir des **mêmes fonctions publiques** que l'accueil et le tableau de distribution (`period-activity.ts`, `locationFlows`, `soldByLocation`, `cashedByGroup`, `receivables`, …). Aucune formule nouvelle n'est écrite dans P9 pour un indicateur qui existe déjà (BR-ANA-009 ; ADR-075). L'explorateur lit des vues SQL `analytics_f_*` déclarées par le module `analytics` (ADR-074) ; leur équivalence avec les fonctions est testée.
4. **Tâches multi-modules dans `analytics-api/`.** Les tâches qui composent plusieurs modules (instantanés `kpi_snapshots`, exports) vivent dans `analytics-api/`, comme le tableau de distribution : le worker les inscrit dans `JobHandlerRegistry` et `RecurringJobRegistry`.
5. **Détecteurs dans les modules propriétaires.** Les tâches de détection (créance échue, pièce manquante, demande d'approbation en attente…) sont des fichiers nouveaux des modules propriétaires, avec leurs seuils lus dans `system_settings` (règle 8). Une tâche déjà écrite mais jamais planifiée (`sales.receivables.overdue_daily`…) reçoit sa récurrence dans son module (`RecurringJobRegistry`), comme `inventory` et `finance`.
6. **Jeux hors ligne.** `comms` (alertes, notifications, notes) et `kpi` (instantanés personnels) suivent le mécanisme existant : écriture dans `sync_change_feed` et lecteur de projection dans `sync/entity-projections.ts`. Les lecteurs de P9 sont écrits dans un fichier nouveau (`sync/communication-projections.ts`, `sync/kpi-projections.ts`) ; leur inscription dans `ENTITY_PROJECTIONS` est une ligne, demandée à la session qui tient ce fichier (suivi §3).
7. **Pas de réplique ni d'agrégats matérialisés en P9** : palier P1 de la stratégie analytique (architecture §6) — vues SQL et instantanés personnels. Le seuil de bascule est mesuré, pas supposé (ADR-078).

## Alternatives écartées

- **Alertes calculées à la lecture** (chaque lecture de `/alerts` évalue les conditions) : charge illimitée (RISK-13), pas de cycle de vie (prise en compte, escalade), pas de notifications.
- **`communication` lit les tables des modules** : viole la frontière de module et lie la détection au schéma d'autrui ; chaque évolution d'un module casserait les alertes.
- **Modules propriétaires appellent `communication.raiseAlert`** : exige d'ajouter `communication` à leurs dépendances autorisées (graphe) et couple chaque commande à l'écriture d'une alerte ; l'événement garde la détection hors de la transaction métier (délai toléré, NFR-15).
- **Module `analytics` qui importe tous les modules** : inverse le graphe ; la couche de transport est le précédent établi.

## Conséquences

- Le catalogue des événements (08-api-events §2) devient la liste des **déclencheurs** : un événement cité « NOT » doit être produit par son module, avec les données minimales utiles (ADR-071 §3). P9 ajoute ces événements module par module (backlog P9-07 à P9-10), chacun testé.
- Les fichiers que la session principale tient (`home-service.ts`, `role-catalog.ts`, `entity-projections.ts`, `identity`, `attachments`) ne sont ni modifiés ni dupliqués : les besoins sont listés au suivi (§3) et signalés.
- `analytics-api/` duplique la **composition** de l'accueil (appels de fonctions publiques, mise en forme), pas les formules ; une extraction de la composition privée de `home-service.ts` pourra suivre, hors de P9.
- Un seul rang de verrou nouveau, **N10b** (ligne d'alerte et destinataires, ADR-071 §10), pris avant les insertions N11 et la tête d'audit N14 ; aucune commande d'un autre module ne le tient : les écritures de `communication` se font dans des transactions de consommateur ou de commandes `communication.*` propres.
- Des ajouts de `platform/` sont nécessaires et signalés à la session principale (suivi §3) : table des événements sautés par le runner de consommateurs (ADR-071 §12), isolation des tâches longues dans le worker (ADR-078 §3), suppression et lecture en flux du port de stockage (ADR-077 §5). Ils sont additifs : aucun comportement existant ne change.
- Le placement d'un détecteur suit le graphe : `INACTIVE_COMMERCIAL` est dans `sales` (qui importe `crm` et `fieldwork`), pas dans `fieldwork` ; la part « % des ventes » de `HIGH_LOSS` est dans `sales` (ADR-071 §2).

## Tests

Graphe de dépendances (dependency-cruiser) : `communication` n'importe que `identity` et `organization` ; aucun module propriétaire n'importe `communication` ni `analytics`. Chaque événement de déclenchement a un test de production (module propriétaire) et un test de consommation (`communication`).
