/**
 * Voies d'exécution des tâches du worker (P9-22 ; ADR-068 §3). Une tâche longue — calcul d'un export (jusqu'à
 * `analytics.export_max_seconds`, 120), recalcul des instantanés personnels ou purge quotidienne de l'analyse
 * (jusqu'à 100 000 suppressions du journal et 10 000 fichiers examinés par exécution, P9-25 PF-5) — ne doit pas
 * retarder les consommateurs d'événements ni les tâches courtes (alertes en moins de 10 s, NFR-15) : le worker les
 * réclame dans une **boucle distincte**, la voie longue, et exclut ces types de la voie courante.
 *
 * La réclamation ne verrouille que la ligne qu'elle traite (lecture des candidats sans verrou, puis verrou par clé
 * primaire : `job-runner.ts`, P9-25 PF-2) : une voie ne retient donc jamais les tâches de l'autre.
 *
 * Liste de types de tâche (chaînes), pas une dépendance vers un module : la plateforme ne connaît aucun module métier.
 * Les types s'ajoutent **en fin de liste** : `analytics.export.run` reste à l'indice 0 (des essais s'y réfèrent).
 */
export const LONG_RUNNING_JOB_TYPES: readonly string[] = [
  'analytics.export.run',
  'analytics.kpi_snapshots.refresh',
  'analytics.maintenance.purge_daily',
];
