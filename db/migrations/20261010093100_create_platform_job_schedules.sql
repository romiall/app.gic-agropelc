-- Espace de noms `platform` (suite) : ordonnanceur des tâches récurrentes (P5-16). Source :
-- 05-architecture/01-architecture-logicielle.md (ordonnanceur : « horaires en Africa/Douala »),
-- 05-architecture/05-stack.md K5 (« tâches planifiées par verrou de ligne dédié »), ADR-011,
-- ADR-023 ; dictionnaire 03-data/dictionnaire/11-audit-sync-integrations-platform.md
-- (section platform.job_schedules, ajoutée dans le même commit).
--
-- Une ligne par type de tâche récurrente (déclaré par les modules au démarrage). La boucle du worker
-- verrouille la ligne due (`FOR UPDATE SKIP LOCKED`), dépose au plus une tâche dans `platform_jobs`
-- pour le créneau, puis avance `next_run_at` au créneau suivant dans la même transaction : jamais
-- deux dépôts pour un créneau, jamais de rattrapage en rafale après un arrêt, jamais de nouvelle
-- occurrence tant que la précédente attend (`last_job_id` encore `PENDING`).
--
-- Deux formes de récurrence : un intervalle fixe en secondes (`INTERVAL`, créneaux alignés), ou une
-- heure locale quotidienne en Africa/Douala (`DAILY`, `HH:MM`). `last_job_id` sans clé étrangère :
-- `platform_jobs` est purgeable (PURGE_TECHNIQUE).
--
-- migrate:up transaction:false

CREATE TABLE platform_job_schedules (
  job_type          VARCHAR(80)  NOT NULL,
  schedule_kind     VARCHAR(10)  NOT NULL,
  interval_seconds  INT          NULL,
  local_time        CHAR(5)      NULL,
  next_run_at       DATETIME(6)  NOT NULL,
  last_enqueued_at  DATETIME(6)  NULL,
  last_job_id       BINARY(16)   NULL,
  created_at        DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at        DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (job_type),
  CONSTRAINT ck_platform_job_schedules_kind CHECK (
    (schedule_kind = 'INTERVAL' AND interval_seconds IS NOT NULL AND interval_seconds > 0 AND local_time IS NULL)
    OR (schedule_kind = 'DAILY' AND interval_seconds IS NULL AND local_time IS NOT NULL
        AND local_time REGEXP '^([01][0-9]|2[0-3]):[0-5][0-9]$')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Droits par table (INV-GLO-05). UPDATE : avancement du créneau et lecture verrouillante ; pas de
-- DELETE (une récurrence retirée du code reste inerte : sa ligne est ignorée par l'ordonnanceur).
GRANT SELECT, INSERT, UPDATE ON platform_job_schedules TO 'gic_app'@'%';

-- migrate:down transaction:false
DROP TABLE IF EXISTS platform_job_schedules;
