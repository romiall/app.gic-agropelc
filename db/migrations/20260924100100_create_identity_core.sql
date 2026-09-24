-- Espace de noms `identity` (socle RBAC, hors affectations de rôle qui référencent
-- `organization` : voir 20260924100300_create_identity_role_assignments.sql).
-- Source : docs/03-data/dictionnaire/01-identity.md.
--
-- Ordre de création dans ce fichier, dicté par les références croisées :
-- users (sans les FK vers soi-même/devices, différées) -> roles -> permissions ->
-- role_permissions -> devices -> ALTER users (FK différées) -> auth_sessions.
-- `identity_devices.designated_site_id` référence `organization.sites`, qui n'existe pas
-- encore à ce stade : colonne créée sans FK ici, contrainte ajoutée par la migration
-- organization (20260924100200_create_organization.sql).
--
-- migrate:up transaction:false

CREATE TABLE identity_users (
  id                     BINARY(16)    NOT NULL,
  full_name              VARCHAR(200)  NOT NULL,
  phone                  VARCHAR(20)   NOT NULL,
  email                  VARCHAR(200)  NULL,
  password_hash          TEXT          NOT NULL,
  must_change_password   BOOLEAN       NOT NULL DEFAULT TRUE,
  status                 VARCHAR(20)   NOT NULL DEFAULT 'ACTIVE',
  status_changed_at      DATETIME(6)   NULL,
  status_reason          TEXT          NULL,
  -- FK ajoutée plus bas (devices n'existe pas encore).
  primary_device_id      BINARY(16)    NULL,
  locale                 VARCHAR(10)   NOT NULL DEFAULT 'fr-CM',
  is_system              BOOLEAN       NOT NULL DEFAULT FALSE,
  last_login_at          DATETIME(6)   NULL,
  -- [STD-AUDIT] ; created_by/updated_by référencent cette même table (utilisateur
  -- `system` auto-créateur au bootstrap, P0-05) : FK ajoutées plus bas.
  created_at             DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by             BINARY(16)    NOT NULL,
  updated_at             DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by             BINARY(16)    NULL,
  version                INT           NOT NULL DEFAULT 1,
  -- Index unique partiel (MySQL n'a pas d'index unique partiel natif, ADR-023) :
  -- colonne générée, NULL hors condition, UNIQUE sur cette colonne.
  active_phone           VARCHAR(20) GENERATED ALWAYS AS (IF(status <> 'DEACTIVATED', phone, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_identity_users_active_phone (active_phone),
  KEY ix_identity_users_status (status),
  CONSTRAINT ck_identity_users_status CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DEACTIVATED')),
  CONSTRAINT ck_identity_users_status_reason CHECK (status = 'ACTIVE' OR status_reason IS NOT NULL),
  -- E.164 : + suivi de 8 à 15 chiffres, le premier non nul (gabarit large, la validation
  -- fine des indicatifs vit dans packages/contracts, pas en base).
  CONSTRAINT ck_identity_users_phone CHECK (phone REGEXP '^\\+[1-9][0-9]{7,14}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE identity_roles (
  id                    BINARY(16)    NOT NULL,
  code                  VARCHAR(40)   NOT NULL,
  name                  VARCHAR(200)  NOT NULL,
  description           TEXT          NULL,
  allowed_scope_types   JSON          NOT NULL DEFAULT (JSON_ARRAY('GLOBAL')),
  is_system             BOOLEAN       NOT NULL DEFAULT FALSE,
  is_active             BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at            DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by            BINARY(16)    NOT NULL,
  updated_at            DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by            BINARY(16)    NULL,
  version               INT           NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_identity_roles_code (code),
  CONSTRAINT ck_identity_roles_code CHECK (code REGEXP '^[A-Z][A-Z0-9_]*$'),
  CONSTRAINT fk_identity_roles_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_identity_roles_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE identity_permissions (
  code               VARCHAR(80)   NOT NULL,
  module             VARCHAR(40)   NOT NULL,
  description        TEXT          NOT NULL,
  supported_scopes   JSON          NOT NULL,
  is_approval        BOOLEAN       NOT NULL DEFAULT FALSE,
  is_sensitive       BOOLEAN       NOT NULL DEFAULT FALSE,
  deprecated_at      DATETIME(6)   NULL,
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE identity_role_permissions (
  role_id           BINARY(16)    NOT NULL,
  permission_code   VARCHAR(80)   NOT NULL,
  -- max_scope ∈ permissions.supported_scopes : contrôle applicatif dans la transaction de
  -- commande, volontairement hors base (référence à une colonne JSON d'une autre table,
  -- non exprimable en CHECK MySQL) — docs/03-data/dictionnaire/01-identity.md.
  max_scope         VARCHAR(10)   NOT NULL,
  limits            JSON          NULL,
  granted_at        DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  granted_by        BINARY(16)    NOT NULL,
  PRIMARY KEY (role_id, permission_code),
  CONSTRAINT ck_identity_role_permissions_max_scope CHECK (max_scope IN ('OWN', 'TEAM', 'SITE', 'ZONE', 'ALL')),
  CONSTRAINT fk_identity_role_permissions_role FOREIGN KEY (role_id) REFERENCES identity_roles (id) ON DELETE RESTRICT,
  CONSTRAINT fk_identity_role_permissions_permission FOREIGN KEY (permission_code) REFERENCES identity_permissions (code) ON DELETE RESTRICT,
  CONSTRAINT fk_identity_role_permissions_granted_by FOREIGN KEY (granted_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE identity_devices (
  id                     BINARY(16)    NOT NULL,
  short_code             VARCHAR(4)    NOT NULL,
  label                  VARCHAR(200)  NULL,
  enrolled_by_user_id    BINARY(16)    NOT NULL,
  status                 VARCHAR(20)   NOT NULL DEFAULT 'PENDING',
  status_changed_at      DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  status_reason          TEXT          NULL,
  approved_by            BINARY(16)    NULL,
  platform               VARCHAR(100)  NULL,
  app_version            VARCHAR(20)   NULL,
  is_shared              BOOLEAN       NOT NULL DEFAULT FALSE,
  -- FK vers organization.sites ajoutée par la migration organization (§ en-tête).
  designated_site_id     BINARY(16)    NULL,
  last_seen_at           DATETIME(6)   NULL,
  created_at             DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by             BINARY(16)    NOT NULL,
  updated_at             DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by             BINARY(16)    NULL,
  version                INT           NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_identity_devices_short_code (short_code),
  KEY ix_identity_devices_status (status),
  KEY ix_identity_devices_enrolled_by (enrolled_by_user_id),
  CONSTRAINT ck_identity_devices_status CHECK (status IN ('PENDING', 'ACTIVE', 'BLOCKED', 'LOST', 'RETIRED')),
  CONSTRAINT ck_identity_devices_approved_by CHECK (status <> 'ACTIVE' OR approved_by IS NOT NULL),
  CONSTRAINT fk_identity_devices_enrolled_by FOREIGN KEY (enrolled_by_user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_identity_devices_approved_by FOREIGN KEY (approved_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_identity_devices_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_identity_devices_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- FK différées de identity_users (dépendaient de identity_users elle-même et de
-- identity_devices, créées ci-dessus).
ALTER TABLE identity_users
  ADD CONSTRAINT fk_identity_users_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_identity_users_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_identity_users_primary_device FOREIGN KEY (primary_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT;

CREATE TABLE identity_auth_sessions (
  id                    BINARY(16)    NOT NULL,
  user_id               BINARY(16)    NOT NULL,
  device_id             BINARY(16)    NOT NULL,
  -- SHA-256 hexadécimal (64 car.) : CHAR(64) plutôt que le `text` logique du
  -- dictionnaire, pour un UNIQUE KEY exploitable (même choix que audit_log.row_hash).
  refresh_token_hash    CHAR(64)      NOT NULL,
  token_family_id       BINARY(16)    NOT NULL,
  created_at            DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  last_used_at          DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  expires_at            DATETIME(6)   NOT NULL,
  offline_grant_until   DATETIME(6)   NOT NULL,
  revoked_at            DATETIME(6)   NULL,
  revoked_reason        VARCHAR(20)   NULL,
  -- Type logique `inet`, non listé au tableau des types (01-identifiants-et-
  -- conventions.md §2) : VARCHAR(45) couvre IPv4 et IPv6 textuels (déduit).
  ip_first              VARCHAR(45)   NULL,
  ip_last               VARCHAR(45)   NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_identity_auth_sessions_refresh_token_hash (refresh_token_hash),
  KEY ix_identity_auth_sessions_user_device (user_id, device_id),
  KEY ix_identity_auth_sessions_expires_at (expires_at),
  CONSTRAINT ck_identity_auth_sessions_revoked_reason CHECK (
    revoked_reason IS NULL OR revoked_reason IN ('LOGOUT', 'ADMIN', 'USER_DEACTIVATED', 'DEVICE_BLOCKED', 'TOKEN_REUSE', 'EXPIRED')
  ),
  CONSTRAINT fk_identity_auth_sessions_user FOREIGN KEY (user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_identity_auth_sessions_device FOREIGN KEY (device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Immuabilité (déclencheurs) : docs/03-data/03-historisation-suppression.md §3-4.
-- DESACTIVATION (users, roles, devices) : jamais de suppression physique, modification
-- libre sinon (changements de statut/profil tracés par l'audit avant/après, pas par un
-- déclencheur). role_permissions : retrait autorisé (liaison de configuration, audité par
-- le code applicatif) — pas de déclencheur de blocage. auth_sessions : PURGE_TECHNIQUE,
-- suppression normale après rétention — pas de déclencheur de blocage.
CREATE TRIGGER trg_identity_users_no_delete BEFORE DELETE ON identity_users FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'identity_users : suppression physique interdite (INV-GLO-03) ; utiliser DEACTIVATED.';
END;

CREATE TRIGGER trg_identity_roles_no_delete BEFORE DELETE ON identity_roles FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'identity_roles : suppression physique interdite (INV-GLO-03) ; utiliser is_active=false.';
END;

CREATE TRIGGER trg_identity_permissions_no_delete BEFORE DELETE ON identity_permissions FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'identity_permissions : suppression physique interdite ; utiliser deprecated_at.';
END;

CREATE TRIGGER trg_identity_devices_no_delete BEFORE DELETE ON identity_devices FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'identity_devices : suppression physique interdite (INV-GLO-03) ; utiliser RETIRED.';
END;

-- Droits par table (INV-GLO-05). Préalable : utilisateur `gic_app` déjà créé (db/README.md).
GRANT SELECT, INSERT, UPDATE ON identity_users TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON identity_roles TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON identity_permissions TO 'gic_app'@'%';
-- role_permissions : retrait autorisé (liaison de configuration), pas de mise à jour en
-- place (toute évolution des limites repasse par un retrait puis un nouvel octroi, tous
-- deux audités) : pas de UPDATE.
GRANT SELECT, INSERT, DELETE ON identity_role_permissions TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON identity_devices TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON identity_auth_sessions TO 'gic_app'@'%';

-- migrate:down transaction:false
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS identity_auth_sessions;
DROP TABLE IF EXISTS identity_devices;
DROP TABLE IF EXISTS identity_role_permissions;
DROP TABLE IF EXISTS identity_permissions;
DROP TABLE IF EXISTS identity_roles;
DROP TABLE IF EXISTS identity_users;
SET FOREIGN_KEY_CHECKS = 1;
