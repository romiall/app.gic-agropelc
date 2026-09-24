-- identity.user_role_assignments : référence organization.sites/zones/teams, donc créée
-- après organization (docs/03-data/dictionnaire/01-identity.md ; graphe des dépendances,
-- identity -> organization).
--
-- migrate:up transaction:false

CREATE TABLE identity_user_role_assignments (
  id               BINARY(16)     NOT NULL,
  user_id          BINARY(16)     NOT NULL,
  role_id          BINARY(16)     NOT NULL,
  scope_type       VARCHAR(10)    NOT NULL DEFAULT 'GLOBAL',
  scope_site_id    BINARY(16)     NULL,
  scope_zone_id    BINARY(16)     NULL,
  scope_team_id    BINARY(16)     NULL,
  valid_from       DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  valid_to         DATETIME(6)    NULL,
  revoked_at       DATETIME(6)    NULL,
  revoked_by       BINARY(16)     NULL,
  revoke_reason    TEXT           NULL,
  created_at       DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by       BINARY(16)     NOT NULL,
  updated_at       DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by       BINARY(16)     NULL,
  version          INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  KEY ix_identity_user_role_assignments_user (user_id, valid_from, valid_to),
  KEY ix_identity_user_role_assignments_role (role_id),
  CONSTRAINT ck_identity_user_role_assignments_scope_type CHECK (scope_type IN ('GLOBAL', 'SITE', 'ZONE', 'TEAM')),
  CONSTRAINT ck_identity_user_role_assignments_scope_cols CHECK (
    (scope_type = 'GLOBAL' AND scope_site_id IS NULL AND scope_zone_id IS NULL AND scope_team_id IS NULL)
    OR (scope_type = 'SITE' AND scope_site_id IS NOT NULL AND scope_zone_id IS NULL AND scope_team_id IS NULL)
    OR (scope_type = 'ZONE' AND scope_zone_id IS NOT NULL AND scope_site_id IS NULL AND scope_team_id IS NULL)
    OR (scope_type = 'TEAM' AND scope_team_id IS NOT NULL AND scope_site_id IS NULL AND scope_zone_id IS NULL)
  ),
  CONSTRAINT ck_identity_user_role_assignments_period CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT fk_identity_ura_user FOREIGN KEY (user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_identity_ura_role FOREIGN KEY (role_id) REFERENCES identity_roles (id) ON DELETE RESTRICT,
  CONSTRAINT fk_identity_ura_scope_site FOREIGN KEY (scope_site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_identity_ura_scope_zone FOREIGN KEY (scope_zone_id) REFERENCES organization_zones (id) ON DELETE RESTRICT,
  CONSTRAINT fk_identity_ura_scope_team FOREIGN KEY (scope_team_id) REFERENCES organization_teams (id) ON DELETE RESTRICT,
  CONSTRAINT fk_identity_ura_revoked_by FOREIGN KEY (revoked_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_identity_ura_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_identity_ura_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- scope_type ∈ roles.allowed_scope_types : jointure vers une autre table, non exprimable
-- en CHECK MySQL ; déclencheur de revérification (dictionnaire §user_role_assignments).
CREATE TRIGGER trg_identity_ura_scope_allowed BEFORE INSERT ON identity_user_role_assignments FOR EACH ROW
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM identity_roles
    WHERE id = NEW.role_id AND JSON_CONTAINS(allowed_scope_types, JSON_QUOTE(NEW.scope_type))
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'identity_user_role_assignments : scope_type non autorisé pour ce rôle (roles.allowed_scope_types).';
  END IF;
END;

-- IMMUABLE sauf révocation/fermeture (INV-ADM-04) : liste blanche des colonnes
-- modifiables après insertion.
CREATE TRIGGER trg_identity_ura_update_guard BEFORE UPDATE ON identity_user_role_assignments FOR EACH ROW
BEGIN
  IF NOT (
    NEW.user_id <=> OLD.user_id AND
    NEW.role_id <=> OLD.role_id AND
    NEW.scope_type <=> OLD.scope_type AND
    NEW.scope_site_id <=> OLD.scope_site_id AND
    NEW.scope_zone_id <=> OLD.scope_zone_id AND
    NEW.scope_team_id <=> OLD.scope_team_id AND
    NEW.valid_from <=> OLD.valid_from AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'identity_user_role_assignments : seule la révocation/fermeture est modifiable (INV-ADM-04).';
  END IF;
END;

CREATE TRIGGER trg_identity_ura_no_delete BEFORE DELETE ON identity_user_role_assignments FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'identity_user_role_assignments : suppression physique interdite (INV-ADM-04) ; révoquer.';
END;

GRANT SELECT, INSERT, UPDATE ON identity_user_role_assignments TO 'gic_app'@'%';

-- migrate:down transaction:false
DROP TABLE IF EXISTS identity_user_role_assignments;
