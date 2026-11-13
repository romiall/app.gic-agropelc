-- Module `identity`, journal des changements de droits des rôles faits dans l'application (questionnaire de clôture,
-- Q28 du 08/11/2026 : « permissions modifiables par l'Admin et les profils de direction dans l'application » ;
-- ADR-072, AV-553). Source : docs/03-data/dictionnaire/01-identity.md (`identity_role_permission_changes`).
--
-- Une ligne par changement appliqué par la commande `identity.role_permission.set` : octroi (`GRANT`), changement de
-- portée (`SCOPE`) ou retrait (`REVOKE`) d'une permission sur un rôle, avec la portée avant et après, le motif,
-- l'auteur et l'instant. `identity_role_permissions` garde l'état en vigueur ; ce journal garde l'historique, et les
-- graines (`db/seeds/run.ts`) ne reviennent jamais sur un couple (rôle, permission) qu'il nomme : la décision prise dans
-- l'application l'emporte sur la valeur du code à chaque livraison. Journal en ajout seul (déclencheurs).
--
-- migrate:up transaction:false

CREATE TABLE identity_role_permission_changes (
  id                BINARY(16)    NOT NULL,
  role_id           BINARY(16)    NOT NULL,
  permission_code   VARCHAR(80)   NOT NULL,
  change_type       VARCHAR(10)   NOT NULL,
  scope_before      VARCHAR(10)   NULL,
  scope_after       VARCHAR(10)   NULL,
  reason            VARCHAR(500)  NOT NULL,
  changed_by        BINARY(16)    NOT NULL,
  changed_at        DATETIME(6)   NOT NULL,
  -- Commande qui a fait le changement : un rejeu de la même commande ne l'écrit pas deux fois.
  command_id        BINARY(16)    NOT NULL,
  created_at        DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_identity_rpc_command (command_id),
  KEY ix_identity_rpc_role_permission (role_id, permission_code, changed_at),
  CONSTRAINT ck_identity_rpc_change_type CHECK (change_type IN ('GRANT', 'SCOPE', 'REVOKE')),
  CONSTRAINT ck_identity_rpc_scope_values CHECK (
    (scope_before IS NULL OR scope_before IN ('OWN', 'TEAM', 'SITE', 'ZONE', 'ALL'))
    AND (scope_after IS NULL OR scope_after IN ('OWN', 'TEAM', 'SITE', 'ZONE', 'ALL'))
  ),
  CONSTRAINT ck_identity_rpc_scopes CHECK (
    (change_type = 'GRANT' AND scope_before IS NULL AND scope_after IS NOT NULL)
    OR (change_type = 'SCOPE' AND scope_before IS NOT NULL AND scope_after IS NOT NULL AND scope_before <> scope_after)
    OR (change_type = 'REVOKE' AND scope_before IS NOT NULL AND scope_after IS NULL)
  ),
  CONSTRAINT ck_identity_rpc_reason CHECK (CHAR_LENGTH(TRIM(reason)) > 0),
  CONSTRAINT fk_identity_rpc_role FOREIGN KEY (role_id) REFERENCES identity_roles (id) ON DELETE RESTRICT,
  CONSTRAINT fk_identity_rpc_permission FOREIGN KEY (permission_code) REFERENCES identity_permissions (code) ON DELETE RESTRICT,
  CONSTRAINT fk_identity_rpc_changed_by FOREIGN KEY (changed_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_identity_rpc_no_update BEFORE UPDATE ON identity_role_permission_changes FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'identity_role_permission_changes : journal en ajout seul (ADR-072).';
END;

CREATE TRIGGER trg_identity_rpc_no_delete BEFORE DELETE ON identity_role_permission_changes FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'identity_role_permission_changes : journal en ajout seul (ADR-072).';
END;

GRANT SELECT, INSERT ON identity_role_permission_changes TO 'gic_app'@'%';
-- La commande change la portée d'un droit en place (UPDATE : la limite éventuelle du droit est conservée) ; le compte
-- applicatif n'avait sur cette table que SELECT, INSERT et DELETE (20260924100100).
GRANT UPDATE ON identity_role_permissions TO 'gic_app'@'%';

-- migrate:down transaction:false

REVOKE UPDATE ON identity_role_permissions FROM 'gic_app'@'%';
DROP TRIGGER IF EXISTS trg_identity_rpc_no_delete;
DROP TRIGGER IF EXISTS trg_identity_rpc_no_update;
DROP TABLE IF EXISTS identity_role_permission_changes;
