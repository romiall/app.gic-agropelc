-- Espace de noms `audit`. Source : docs/03-data/dictionnaire/11-audit-sync-integrations-
-- platform.md (section audit.audit_log) ; docs/07-security-rbac/03-audit.md.
--
-- Partitionnement mensuel documenté par le dictionnaire mais explicitement **reporté**
-- au P0/P2 (ADR-023, RISK-27 : le partitionnement MySQL interdit les clés étrangères
-- entrantes sur une table partitionnée, incompatible avec une table aussi référencée) :
-- volumétrie H-06 largement couverte par les index ci-dessous, archivage applicatif
-- prévu avant la limite.
--
-- Le calcul du chaînage (prev_hash/row_hash) est une responsabilité applicative (JOB,
-- P0-07, docs/07-security-rbac/03-audit.md §5), sous verrou séquentiel : ce ne sont ici
-- que des colonnes ; aucune fonction de hachage en base.
--
-- migrate:up transaction:false

CREATE TABLE audit_audit_log (
  seq                BIGINT UNSIGNED AUTO_INCREMENT,
  id                 BINARY(16)     NOT NULL,
  occurred_at        DATETIME(6)    NOT NULL,
  recorded_at        DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  actor_user_id      BINARY(16)     NOT NULL,
  actor_roles        JSON           NOT NULL,
  device_id          BINARY(16)     NULL,
  -- Type logique `inet`, non listé au tableau des types (déduit, cf. identity_auth_sessions).
  ip                 VARCHAR(45)    NULL,
  user_agent         VARCHAR(300)   NULL,
  captured_offline   BOOLEAN        NOT NULL DEFAULT FALSE,
  sync_delay_ms      BIGINT         NULL,
  clock_skew_ms      INT            NULL,
  command_id         BINARY(16)     NULL,
  action             VARCHAR(80)    NOT NULL,
  entity_type        VARCHAR(40)    NOT NULL,
  entity_id          BINARY(16)     NULL,
  -- Pas de FK (non fléché dans le dictionnaire) : l'audit doit rester écrivable même si
  -- le site référencé est modifié ou désactivé par ailleurs dans la même transaction.
  site_id            BINARY(16)     NULL,
  -- `before`/`after` sont des mots réservés MySQL (clauses de déclencheur) : quotés.
  `before`           JSON           NULL,
  `after`            JSON           NULL,
  reason             TEXT           NULL,
  approval_request_id BINARY(16)    NULL,
  result             VARCHAR(20)    NOT NULL,
  error_code         VARCHAR(60)    NULL,
  correlation_id     BINARY(16)     NULL,
  prev_hash          CHAR(64)       NOT NULL,
  row_hash           CHAR(64)       NOT NULL,
  PRIMARY KEY (seq),
  UNIQUE KEY uq_audit_audit_log_id (id),
  KEY ix_audit_audit_log_entity (entity_type, entity_id),
  KEY ix_audit_audit_log_actor (actor_user_id, recorded_at),
  KEY ix_audit_audit_log_action (action, recorded_at),
  KEY ix_audit_audit_log_site (site_id, recorded_at),
  KEY ix_audit_audit_log_device (device_id, recorded_at),
  CONSTRAINT ck_audit_audit_log_result CHECK (result IN ('SUCCESS', 'DENIED', 'FAILED', 'QUARANTINED')),
  CONSTRAINT fk_audit_audit_log_actor FOREIGN KEY (actor_user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_audit_audit_log_device FOREIGN KEY (device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- IMMUABLE (INV-AUD-01) : ajout seul, aucune colonne modifiable après insertion.
CREATE TRIGGER trg_audit_audit_log_no_update BEFORE UPDATE ON audit_audit_log FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_audit_log : aucune modification (journal en ajout seul, INV-AUD-01).';
END;

CREATE TRIGGER trg_audit_audit_log_no_delete BEFORE DELETE ON audit_audit_log FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_audit_log : suppression physique interdite (INV-GLO-03, INV-AUD-01).';
END;

-- Ajout seul pour l'application : ni UPDATE ni DELETE.
GRANT SELECT, INSERT ON audit_audit_log TO 'gic_app'@'%';

-- migrate:down transaction:false
DROP TABLE IF EXISTS audit_audit_log;
