-- Module `analytics` (P9-13) : vues sauvegardées, exports audités, instantanés d'indicateurs personnels et
-- journal des requêtes de l'explorateur.
-- Source : docs/03-data/dictionnaire/12-analytics.md ; D11 ; BR-ANA-004 à 009 ; ADR-074, ADR-076, ADR-077,
-- ADR-078 ; AV-421 à AV-438.
--
-- Principes portés par le schéma :
-- - le module `analytics` lit les autres modules par des vues (migrations suivantes) et n'écrit que ces
--   quatre tables ;
-- - un export n'est jamais supprimé (BR-ANA-008 : la ligne est la trace d'audit) ; son fichier l'est après
--   30 jours, la ligne passe `EXPIRED` ; un export terminé en échec garde son motif ;
-- - une vue sauvegardée est un objet de confort : suppression physique par son propriétaire, auditée ;
-- - le journal des requêtes est technique : ajout seul, purge après 90 jours par l'application ;
-- - un instantané est écrasé à chaque calcul et supprimé à la perte du droit de lecture du tableau.
-- migrate:up transaction:false

-- Vues sauvegardées (BR-ANA-007) : un partage ne donne aucun droit supplémentaire, le lecteur exécute la
-- définition avec ses propres droits ; un champ disparu du catalogue rend la vue obsolète (ADR-077 §2).
CREATE TABLE analytics_saved_views (
  id                   BINARY(16)    NOT NULL,
  owner_user_id        BINARY(16)    NOT NULL,
  name                 VARCHAR(120)  NOT NULL,
  dataset              VARCHAR(40)   NOT NULL,
  definition           JSON          NOT NULL,
  catalog_version      INT           NOT NULL,
  shared_with_roles    JSON          NOT NULL DEFAULT (JSON_ARRAY()),
  is_default_for_role  VARCHAR(40)   NULL,
  created_at           DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by           BINARY(16)    NOT NULL,
  updated_at           DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by           BINARY(16)    NULL,
  version              INT           NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_analytics_saved_views_owner_name (owner_user_id, name),
  -- Une seule vue par défaut par rôle (les valeurs NULL ne se heurtent pas).
  UNIQUE KEY uq_analytics_saved_views_default_role (is_default_for_role),
  KEY ix_analytics_saved_views_dataset (dataset),
  CONSTRAINT ck_analytics_saved_views_dataset CHECK (dataset REGEXP '^f_[a-z_]+$'),
  CONSTRAINT ck_analytics_saved_views_definition CHECK (JSON_TYPE(definition) = 'OBJECT'),
  CONSTRAINT ck_analytics_saved_views_roles CHECK (JSON_TYPE(shared_with_roles) = 'ARRAY'),
  CONSTRAINT ck_analytics_saved_views_catalog CHECK (catalog_version >= 1),
  CONSTRAINT fk_analytics_saved_views_owner FOREIGN KEY (owner_user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_analytics_saved_views_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_analytics_saved_views_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_analytics_saved_views_update_guard BEFORE UPDATE ON analytics_saved_views FOR EACH ROW
BEGIN
  IF NOT (NEW.id <=> OLD.id AND NEW.owner_user_id <=> OLD.owner_user_id
          AND NEW.created_at <=> OLD.created_at AND NEW.created_by <=> OLD.created_by) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'analytics_saved_views : identité et propriétaire immuables.';
  END IF;
END;

-- Exports (BR-ANA-008, ADR-077) : file de tâches ; la définition est celle qui a été validée à la demande,
-- le catalogue est figé par sa version. La ligne n'est jamais supprimée.
CREATE TABLE analytics_export_jobs (
  id               BINARY(16)    NOT NULL,
  requested_by     BINARY(16)    NOT NULL,
  dataset          VARCHAR(40)   NOT NULL,
  definition       JSON          NOT NULL,
  format           VARCHAR(4)    NOT NULL,
  status           VARCHAR(10)   NOT NULL DEFAULT 'QUEUED',
  row_count        INT           NULL,
  duration_ms      INT           NULL,
  storage_key      VARCHAR(200)  NULL,
  catalog_version  INT           NOT NULL,
  error_code       VARCHAR(60)   NULL,
  command_id       BINARY(16)    NULL,
  expires_at       DATETIME(6)   NOT NULL,
  created_at       DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  finished_at      DATETIME(6)   NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_analytics_export_jobs_command (command_id),
  -- Liste d'un demandeur, plus récents d'abord ; file des exports à traiter ; purge des fichiers échus.
  KEY ix_analytics_export_jobs_requester (requested_by, created_at),
  KEY ix_analytics_export_jobs_status (status, created_at),
  CONSTRAINT ck_analytics_export_jobs_dataset CHECK (dataset REGEXP '^f_[a-z_]+$'),
  CONSTRAINT ck_analytics_export_jobs_definition CHECK (JSON_TYPE(definition) = 'OBJECT'),
  CONSTRAINT ck_analytics_export_jobs_format CHECK (format IN ('CSV', 'XLSX')),
  CONSTRAINT ck_analytics_export_jobs_status CHECK (status IN ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'EXPIRED')),
  CONSTRAINT ck_analytics_export_jobs_catalog CHECK (catalog_version >= 1),
  -- Tant que l'export n'est pas terminé il n'a pas de date de fin ; terminé, il en a une.
  CONSTRAINT ck_analytics_export_jobs_finished CHECK ((status IN ('QUEUED', 'RUNNING')) = (finished_at IS NULL)),
  -- Un export réussi a son fichier et son nombre de lignes ; un échec dit pourquoi, jamais en silence.
  CONSTRAINT ck_analytics_export_jobs_done CHECK (status NOT IN ('DONE', 'EXPIRED') OR row_count IS NOT NULL),
  CONSTRAINT ck_analytics_export_jobs_file CHECK (status <> 'DONE' OR storage_key IS NOT NULL),
  CONSTRAINT ck_analytics_export_jobs_failed CHECK (status <> 'FAILED' OR error_code IS NOT NULL),
  CONSTRAINT fk_analytics_export_jobs_requested_by FOREIGN KEY (requested_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_analytics_export_jobs_update_guard BEFORE UPDATE ON analytics_export_jobs FOR EACH ROW
BEGIN
  IF NOT (NEW.id <=> OLD.id AND NEW.requested_by <=> OLD.requested_by AND NEW.dataset <=> OLD.dataset
          AND NEW.definition <=> OLD.definition AND NEW.format <=> OLD.format
          AND NEW.catalog_version <=> OLD.catalog_version AND NEW.created_at <=> OLD.created_at
          AND NEW.expires_at <=> OLD.expires_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'analytics_export_jobs : définition, demandeur et échéance immuables (BR-ANA-008).';
  END IF;
  IF OLD.status = 'FAILED' OR OLD.status = 'EXPIRED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'analytics_export_jobs : export terminé, immuable.';
  END IF;
  IF OLD.status = 'DONE' AND NEW.status <> 'EXPIRED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'analytics_export_jobs : un export réussi ne peut qu''expirer.';
  END IF;
END;

CREATE TRIGGER trg_analytics_export_jobs_no_delete BEFORE DELETE ON analytics_export_jobs FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'analytics_export_jobs : suppression interdite (trace d''audit, BR-ANA-008).';
END;

-- Instantanés d'indicateurs personnels (ADR-076 §5) : une ligne par utilisateur, tableau et période ; le
-- périmètre est celui, exact, de l'utilisateur à l'instant du calcul. Écrasé à chaque calcul.
CREATE TABLE analytics_kpi_snapshots (
  user_id      BINARY(16)    NOT NULL,
  scope_key    VARCHAR(100)  NOT NULL,
  period_key   VARCHAR(20)   NOT NULL,
  payload      JSON          NOT NULL,
  computed_at  DATETIME(6)   NOT NULL,
  PRIMARY KEY (user_id, scope_key, period_key),
  -- Reprise de la tâche d'instantanés par ancienneté.
  KEY ix_analytics_kpi_snapshots_computed (computed_at),
  CONSTRAINT ck_analytics_kpi_snapshots_period CHECK (period_key IN ('TODAY', 'WEEK', 'MONTH')),
  CONSTRAINT ck_analytics_kpi_snapshots_payload CHECK (JSON_TYPE(payload) = 'OBJECT'),
  CONSTRAINT fk_analytics_kpi_snapshots_user FOREIGN KEY (user_id) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Journal technique des requêtes de l'explorateur (ADR-074 §10) : un refus de droit ou de limite y figure
-- aussi (RC-09). Ajout seul ; purgé après 90 jours (AV-437).
CREATE TABLE analytics_query_log (
  id           BINARY(16)    NOT NULL,
  user_id      BINARY(16)    NOT NULL,
  dataset      VARCHAR(40)   NOT NULL,
  definition   JSON          NOT NULL,
  outcome      VARCHAR(10)   NOT NULL,
  error_code   VARCHAR(60)   NULL,
  row_count    INT           NULL,
  duration_ms  INT           NULL,
  created_at   DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY ix_analytics_query_log_created (created_at),
  KEY ix_analytics_query_log_user (user_id, created_at),
  CONSTRAINT ck_analytics_query_log_outcome CHECK (outcome IN ('OK', 'REFUSED', 'LIMIT', 'ERROR')),
  CONSTRAINT ck_analytics_query_log_definition CHECK (JSON_TYPE(definition) = 'OBJECT'),
  CONSTRAINT fk_analytics_query_log_user FOREIGN KEY (user_id) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_analytics_query_log_no_update BEFORE UPDATE ON analytics_query_log FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'analytics_query_log : ajout seul.';
END;

-- Privilèges applicatifs : DELETE seulement là où la politique de suppression l'autorise
-- (03-historisation-suppression.md) — vues sauvegardées (objet de confort), instantanés (projection) et
-- journal (purge technique) ; jamais sur les exports.
GRANT SELECT, INSERT, UPDATE, DELETE ON analytics_saved_views TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON analytics_export_jobs TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON analytics_kpi_snapshots TO 'gic_app'@'%';
GRANT SELECT, INSERT, DELETE ON analytics_query_log TO 'gic_app'@'%';

-- migrate:down transaction:false
DROP TABLE IF EXISTS analytics_query_log;
DROP TABLE IF EXISTS analytics_kpi_snapshots;
DROP TABLE IF EXISTS analytics_export_jobs;
DROP TABLE IF EXISTS analytics_saved_views;
