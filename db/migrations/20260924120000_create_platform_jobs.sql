-- Espace de noms `platform` (suite) : file de tâches maison (P0-08 ; ADR-011 ; ADR-023
-- « pg-boss abandonné, table de tâches maison, SELECT … FOR UPDATE SKIP LOCKED »).
-- Source : docs/03-data/dictionnaire/11-audit-sync-integrations-platform.md (section
-- platform.jobs, ajoutée dans le même commit — aucune autre migration ne référence cette
-- table, elle n'a donc pas besoin d'exister avant P0-08).
--
-- Aucune colonne de verrou explicite (`locked_by`/`locked_at`) : `SELECT … FOR UPDATE SKIP
-- LOCKED` tient le verrou pour la durée de la transaction de traitement (apps/server/src/
-- platform/jobs/job-runner.ts) ; un crash du worker relâche le verrou (rollback), la ligne
-- reste PENDING pour un autre worker — pas de nettoyage de verrou périmé à construire.
--
-- migrate:up transaction:false

CREATE TABLE platform_jobs (
  id            BINARY(16)    NOT NULL,
  job_type      VARCHAR(80)   NOT NULL,
  payload       JSON          NOT NULL,
  status        VARCHAR(10)   NOT NULL DEFAULT 'PENDING',
  run_at        DATETIME(6)   NOT NULL,
  attempts      SMALLINT      NOT NULL DEFAULT 0,
  max_attempts  SMALLINT      NOT NULL DEFAULT 5,
  last_error    TEXT          NULL,
  created_at    DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  completed_at  DATETIME(6)   NULL,
  PRIMARY KEY (id),
  KEY ix_platform_jobs_poll (status, run_at),
  CONSTRAINT ck_platform_jobs_status CHECK (status IN ('PENDING', 'DONE', 'FAILED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Droits par table (INV-GLO-05). DELETE accordé : PURGE_TECHNIQUE (table opérationnelle,
-- pas un registre métier ni un journal — 03-historisation-suppression.md §4), comme
-- sync_change_feed (20260924100700_create_sync.sql). UPDATE nécessaire non seulement pour
-- les transitions de statut mais aussi pour SELECT … FOR UPDATE [SKIP LOCKED] (MySQL exige
-- le privilège UPDATE pour toute lecture verrouillante, même sans écriture réelle — constaté
-- sur audit_audit_log en P0-06, 20260924110000_grant_audit_log_lock.sql : accordé ici dès la
-- création plutôt que découvert après coup).
GRANT SELECT, INSERT, UPDATE, DELETE ON platform_jobs TO 'gic_app'@'%';

-- migrate:down transaction:false
DROP TABLE IF EXISTS platform_jobs;
