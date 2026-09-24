-- Espace de noms `sync`. Source : docs/03-data/dictionnaire/11-audit-sync-integrations-
-- platform.md (sections sync.command_inbox, sync.sync_conflicts, sync.change_feed,
-- sync.device_sync_state). N'inclut pas `integrations.*` (hors périmètre P0-04).
-- Partitionnement de command_inbox et change_feed reporté (ADR-023, RISK-27), même
-- raisonnement que pour audit.audit_log (20260924100600_create_audit.sql).
--
-- migrate:up transaction:false

CREATE TABLE sync_command_inbox (
  command_id          BINARY(16)     NOT NULL,
  device_id           BINARY(16)     NULL,
  user_id             BINARY(16)     NOT NULL,
  device_seq          BIGINT         NULL,
  transport            VARCHAR(20)   NOT NULL,
  command_type        VARCHAR(80)    NOT NULL,
  command_version     SMALLINT       NOT NULL DEFAULT 1,
  aggregate_type       VARCHAR(40)   NULL,
  aggregate_id        BINARY(16)     NULL,
  base_version        INT            NULL,
  depends_on          JSON           NOT NULL DEFAULT (JSON_ARRAY()),
  payload             JSON           NOT NULL,
  payload_hash        CHAR(64)       NOT NULL,
  occurred_at         DATETIME(6)    NOT NULL,
  client_created_at   DATETIME(6)    NULL,
  device_sent_at      DATETIME(6)    NULL,
  received_at         DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  applied_at          DATETIME(6)    NULL,
  clock_skew_ms       INT            NULL,
  captured_offline    BOOLEAN        NOT NULL DEFAULT FALSE,
  batch_id            BINARY(16)     NULL,
  status              VARCHAR(25)    NOT NULL DEFAULT 'RECEIVED',
  result              JSON           NULL,
  error_code          VARCHAR(60)    NULL,
  error_message       TEXT           NULL,
  attempts            SMALLINT       NOT NULL DEFAULT 1,
  PRIMARY KEY (command_id),
  UNIQUE KEY uq_sync_command_inbox_device_seq (device_id, device_seq),
  KEY ix_sync_command_inbox_device_received (device_id, received_at),
  KEY ix_sync_command_inbox_user_received (user_id, received_at),
  KEY ix_sync_command_inbox_status (status),
  CONSTRAINT ck_sync_command_inbox_transport CHECK (transport IN ('SYNC_PUSH', 'ONLINE_API', 'SYSTEM')),
  CONSTRAINT ck_sync_command_inbox_status CHECK (status IN ('RECEIVED', 'APPLIED', 'APPLIED_WITH_WARNINGS', 'CONFLICT', 'REJECTED', 'FAILED_RETRYABLE')),
  CONSTRAINT fk_sync_command_inbox_device FOREIGN KEY (device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sync_command_inbox_user FOREIGN KEY (user_id) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- IMMUABLE sauf transitions (INV-SYN-01) : seuls le statut et le résultat de traitement
-- peuvent changer après réception.
CREATE TRIGGER trg_sync_command_inbox_update_guard BEFORE UPDATE ON sync_command_inbox FOR EACH ROW
BEGIN
  IF NOT (
    NEW.device_id <=> OLD.device_id AND
    NEW.user_id <=> OLD.user_id AND
    NEW.device_seq <=> OLD.device_seq AND
    NEW.transport <=> OLD.transport AND
    NEW.command_type <=> OLD.command_type AND
    NEW.command_version <=> OLD.command_version AND
    NEW.aggregate_type <=> OLD.aggregate_type AND
    NEW.aggregate_id <=> OLD.aggregate_id AND
    NEW.base_version <=> OLD.base_version AND
    NEW.depends_on <=> OLD.depends_on AND
    NEW.payload <=> OLD.payload AND
    NEW.payload_hash <=> OLD.payload_hash AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.client_created_at <=> OLD.client_created_at AND
    NEW.device_sent_at <=> OLD.device_sent_at AND
    NEW.received_at <=> OLD.received_at AND
    NEW.clock_skew_ms <=> OLD.clock_skew_ms AND
    NEW.captured_offline <=> OLD.captured_offline AND
    NEW.batch_id <=> OLD.batch_id
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sync_command_inbox : seuls status/result/error_*/applied_at/attempts sont modifiables (INV-SYN-01).';
  END IF;
END;

CREATE TRIGGER trg_sync_command_inbox_no_delete BEFORE DELETE ON sync_command_inbox FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sync_command_inbox : suppression physique interdite (INV-GLO-03).';
END;

CREATE TABLE sync_sync_conflicts (
  id                    BINARY(16)     NOT NULL,
  command_id            BINARY(16)     NULL,
  conflict_type         VARCHAR(40)    NOT NULL,
  entity_type           VARCHAR(40)    NOT NULL,
  entity_id             BINARY(16)     NOT NULL,
  site_id               BINARY(16)     NULL,
  owner_role            VARCHAR(40)    NOT NULL,
  applied               BOOLEAN        NOT NULL,
  details               JSON           NOT NULL,
  status                VARCHAR(20)    NOT NULL DEFAULT 'OPEN',
  resolution            VARCHAR(20)    NULL,
  resolution_refs       JSON           NOT NULL DEFAULT (JSON_ARRAY()),
  resolved_by           BINARY(16)     NULL,
  resolved_at           DATETIME(6)    NULL,
  resolution_comment    TEXT           NULL,
  created_at            DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY ix_sync_sync_conflicts_status (status, owner_role, site_id),
  CONSTRAINT ck_sync_sync_conflicts_status CHECK (status IN ('OPEN', 'RESOLVED', 'DISMISSED')),
  CONSTRAINT ck_sync_sync_conflicts_resolution CHECK (resolution IS NULL OR resolution IN ('ACCEPT_CLIENT', 'KEEP_SERVER', 'MERGE', 'COMPENSATE')),
  CONSTRAINT fk_sync_sync_conflicts_command FOREIGN KEY (command_id) REFERENCES sync_command_inbox (command_id) ON DELETE RESTRICT,
  CONSTRAINT fk_sync_sync_conflicts_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sync_sync_conflicts_resolved_by FOREIGN KEY (resolved_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- IMMUABLE après résolution (SM-CONFLICT) : tant que OPEN, seule la résolution peut
-- changer ; au-delà, plus aucune modification.
CREATE TRIGGER trg_sync_sync_conflicts_update_guard BEFORE UPDATE ON sync_sync_conflicts FOR EACH ROW
BEGIN
  IF OLD.status IN ('RESOLVED', 'DISMISSED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sync_sync_conflicts : immuable après résolution.';
  END IF;
  IF NOT (
    NEW.command_id <=> OLD.command_id AND
    NEW.conflict_type <=> OLD.conflict_type AND
    NEW.entity_type <=> OLD.entity_type AND
    NEW.entity_id <=> OLD.entity_id AND
    NEW.site_id <=> OLD.site_id AND
    NEW.owner_role <=> OLD.owner_role AND
    NEW.applied <=> OLD.applied AND
    NEW.details <=> OLD.details AND
    NEW.created_at <=> OLD.created_at
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sync_sync_conflicts : seule la résolution est modifiable avant clôture.';
  END IF;
END;

CREATE TRIGGER trg_sync_sync_conflicts_no_delete BEFORE DELETE ON sync_sync_conflicts FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sync_sync_conflicts : suppression physique interdite (INV-GLO-03).';
END;

CREATE TABLE sync_change_feed (
  seq            BIGINT UNSIGNED AUTO_INCREMENT,
  dataset        VARCHAR(40)    NOT NULL,
  entity_type    VARCHAR(40)    NOT NULL,
  entity_id      BINARY(16)     NOT NULL,
  change_type    VARCHAR(20)    NOT NULL,
  scope_type     VARCHAR(10)    NOT NULL,
  -- Portée polymorphe selon scope_type (GLOBAL/SITE/ZONE/TEAM/USER/DEVICE/LOCATION) :
  -- pas de clé étrangère unique possible.
  scope_id       BINARY(16)     NULL,
  row_version    BIGINT         NOT NULL,
  recorded_at    DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (seq),
  KEY ix_sync_change_feed_scope (scope_type, scope_id, seq),
  KEY ix_sync_change_feed_dataset (dataset, seq),
  CONSTRAINT ck_sync_change_feed_change_type CHECK (change_type IN ('UPSERT', 'DELETE', 'SCOPE_EXIT')),
  CONSTRAINT ck_sync_change_feed_scope_type CHECK (scope_type IN ('GLOBAL', 'SITE', 'ZONE', 'TEAM', 'USER', 'DEVICE', 'LOCATION'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Faits ponctuels, jamais modifiés après insertion (le contenu n'est pas copié ici, voir
-- dictionnaire) ; PURGE_TECHNIQUE au-delà de 60 jours (BR-SYN-015) — donc pas de
-- déclencheur de blocage de suppression, seulement de modification.
CREATE TRIGGER trg_sync_change_feed_no_update BEFORE UPDATE ON sync_change_feed FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sync_change_feed : aucune modification (fait ponctuel en ajout seul).';
END;

CREATE TABLE sync_device_sync_state (
  device_id             BINARY(16)     NOT NULL,
  dataset               VARCHAR(40)    NOT NULL,
  cursor_seq            BIGINT         NOT NULL DEFAULT 0,
  last_pull_at          DATETIME(6)    NULL,
  bootstrapped_at       DATETIME(6)    NULL,
  needs_rebootstrap     BOOLEAN        NOT NULL DEFAULT FALSE,
  -- Colonnes de la ligne technique par appareil (`dataset = '_device'`, dictionnaire) :
  -- portées par le même tuple (device_id, dataset) plutôt qu'une table séparée.
  last_push_at          DATETIME(6)    NULL,
  last_device_seq       BIGINT         NULL,
  known_gaps            JSON           NULL,
  last_clock_skew_ms    INT            NULL,
  pending_reported      INT            NULL,
  app_version           VARCHAR(20)    NULL,
  PRIMARY KEY (device_id, dataset),
  CONSTRAINT fk_sync_device_sync_state_device FOREIGN KEY (device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Droits par table (INV-GLO-05).
GRANT SELECT, INSERT, UPDATE ON sync_command_inbox TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON sync_sync_conflicts TO 'gic_app'@'%';
GRANT SELECT, INSERT, DELETE ON sync_change_feed TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON sync_device_sync_state TO 'gic_app'@'%';

-- migrate:down transaction:false
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS sync_device_sync_state;
DROP TABLE IF EXISTS sync_change_feed;
DROP TABLE IF EXISTS sync_sync_conflicts;
DROP TABLE IF EXISTS sync_command_inbox;
SET FOREIGN_KEY_CHECKS = 1;
