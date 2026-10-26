/**
 * Voies d'exécution des tâches du worker (P9-22 ; ADR-068 §3). Une tâche longue — calcul d'un export (jusqu'à
 * `analytics.export_max_seconds`, 120) ou recalcul des instantanés personnels — ne doit pas retarder les consommateurs
 * d'événements ni les tâches courtes (alertes en moins de 10 s, NFR-15) : le worker les réclame dans une **boucle
 * distincte**, la voie longue, et exclut ces types de la voie courante.
 *
 * Liste de types de tâche (chaînes), pas une dépendance vers un module : la plateforme ne connaît aucun module métier.
 */
export const LONG_RUNNING_JOB_TYPES: readonly string[] = [
  'analytics.export.run',
  'analytics.kpi_snapshots.refresh',
];
