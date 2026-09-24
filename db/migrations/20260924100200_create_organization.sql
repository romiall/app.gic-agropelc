-- Espace de noms `organization`. Source : docs/03-data/dictionnaire/02-organization.md.
-- Ordre : zones -> zone_ancestors -> sites (puis FK différée de identity_devices) ->
-- locations -> points_of_sale (a besoin de locations) -> teams -> team_memberships ->
-- system_settings.
--
-- migrate:up transaction:false

CREATE TABLE organization_zones (
  id                   BINARY(16)     NOT NULL,
  parent_id            BINARY(16)     NULL,
  level                VARCHAR(20)    NOT NULL,
  code                 VARCHAR(40)    NOT NULL,
  name                 VARCHAR(200)   NOT NULL,
  depth                SMALLINT       NOT NULL,
  geofence_lat         DECIMAL(9,6)   NULL,
  geofence_lng         DECIMAL(9,6)   NULL,
  -- Pas de DEFAULT ici (contrairement au « 500 » du dictionnaire) : la valeur par défaut
  -- s'applique quand un géorepère est renseigné, pas comme valeur autonome — un DEFAULT de
  -- colonne s'appliquerait aussi quand lat/lng restent NULL, ce qui violerait
  -- ck_organization_zones_geofence (tout ou rien). Le défaut 500 reste appliqué côté
  -- application (packages/domain) à la construction d'un géorepère.
  geofence_radius_m    DECIMAL(8,1)   NULL,
  max_gps_accuracy_m   DECIMAL(8,1)   NULL DEFAULT 150,
  is_active            BOOLEAN        NOT NULL DEFAULT TRUE,
  created_at           DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by           BINARY(16)     NOT NULL,
  updated_at           DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by           BINARY(16)     NULL,
  version              INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_organization_zones_code (code),
  KEY ix_organization_zones_parent (parent_id),
  CONSTRAINT ck_organization_zones_level CHECK (level IN ('PAYS', 'REGION', 'VILLE', 'MARCHE', 'QUARTIER', 'SECTEUR')),
  CONSTRAINT ck_organization_zones_geofence CHECK (
    (geofence_lat IS NULL AND geofence_lng IS NULL AND geofence_radius_m IS NULL)
    OR (geofence_lat IS NOT NULL AND geofence_lng IS NOT NULL AND geofence_radius_m IS NOT NULL)
  ),
  CONSTRAINT ck_organization_zones_radius CHECK (geofence_radius_m IS NULL OR geofence_radius_m BETWEEN 50 AND 5000),
  CONSTRAINT fk_organization_zones_parent FOREIGN KEY (parent_id) REFERENCES organization_zones (id) ON DELETE RESTRICT,
  CONSTRAINT fk_organization_zones_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_organization_zones_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Pas de contrôle DB du cycle parent_id (contrôle TX, dictionnaire §zones).
CREATE TRIGGER trg_organization_zones_no_delete BEFORE DELETE ON organization_zones FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_zones : suppression physique interdite (INV-GLO-03) ; utiliser is_active=false.';
END;

-- Fermeture transitive (remplace `path uuid[]` + GIN de la version PostgreSQL, ADR-023).
-- Recalculée entièrement par le gestionnaire de commande de `organization` à la création
-- ou au déplacement d'une zone (pas de déclencheur de maintenance ici : responsabilité
-- applicative documentée, dictionnaire §zone_ancestors).
CREATE TABLE organization_zone_ancestors (
  zone_id       BINARY(16)   NOT NULL,
  ancestor_id   BINARY(16)   NOT NULL,
  depth         SMALLINT     NOT NULL,
  PRIMARY KEY (zone_id, ancestor_id),
  KEY ix_organization_zone_ancestors_ancestor (ancestor_id),
  CONSTRAINT fk_organization_zone_ancestors_zone FOREIGN KEY (zone_id) REFERENCES organization_zones (id) ON DELETE RESTRICT,
  CONSTRAINT fk_organization_zone_ancestors_ancestor FOREIGN KEY (ancestor_id) REFERENCES organization_zones (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE organization_sites (
  id           BINARY(16)     NOT NULL,
  code         VARCHAR(10)    NOT NULL,
  name         VARCHAR(200)   NOT NULL,
  site_type    VARCHAR(20)    NOT NULL,
  zone_id      BINARY(16)     NOT NULL,
  address      TEXT           NULL,
  lat          DECIMAL(9,6)   NULL,
  lng          DECIMAL(9,6)   NULL,
  status       VARCHAR(20)    NOT NULL DEFAULT 'ACTIVE',
  opened_on    DATE           NULL,
  closed_on    DATE           NULL,
  created_at   DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by   BINARY(16)     NOT NULL,
  updated_at   DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by   BINARY(16)     NULL,
  version      INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_organization_sites_code (code),
  KEY ix_organization_sites_zone (zone_id),
  CONSTRAINT ck_organization_sites_type CHECK (site_type IN ('FERME', 'MAGASIN', 'POINT_DE_VENTE', 'BUREAU')),
  CONSTRAINT ck_organization_sites_status CHECK (status IN ('ACTIVE', 'CLOSED')),
  CONSTRAINT ck_organization_sites_closed_on CHECK (
    (status = 'CLOSED' AND closed_on IS NOT NULL) OR (status <> 'CLOSED' AND closed_on IS NULL)
  ),
  CONSTRAINT fk_organization_sites_zone FOREIGN KEY (zone_id) REFERENCES organization_zones (id) ON DELETE RESTRICT,
  CONSTRAINT fk_organization_sites_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_organization_sites_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_organization_sites_no_delete BEFORE DELETE ON organization_sites FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_sites : suppression physique interdite (INV-GLO-03) ; utiliser CLOSED.';
END;

-- FK différée de identity_devices (docs/03-data/dictionnaire/01-identity.md ;
-- 20260924100100_create_identity_core.sql, colonne créée sans contrainte).
ALTER TABLE identity_devices
  ADD CONSTRAINT fk_identity_devices_designated_site FOREIGN KEY (designated_site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT;

CREATE TABLE organization_locations (
  id                     BINARY(16)     NOT NULL,
  site_id                BINARY(16)     NULL,
  parent_location_id     BINARY(16)     NULL,
  code                   VARCHAR(40)    NOT NULL,
  name                   VARCHAR(200)   NOT NULL,
  location_type          VARCHAR(20)    NOT NULL,
  custody_mode           VARCHAR(20)    NULL,
  custodian_user_id      BINARY(16)     NULL,
  designated_device_id   BINARY(16)     NULL,
  capacity               INT            NULL,
  status                 VARCHAR(20)    NOT NULL DEFAULT 'ACTIVE',
  created_at             DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by             BINARY(16)     NOT NULL,
  updated_at             DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by             BINARY(16)     NULL,
  version                INT            NOT NULL DEFAULT 1,
  -- `is_virtual` calculé (type[s] V_*) ; index uniques partiels (MySQL, ADR-023) pour « un
  -- seul emplacement actif par type virtuel » et « un seul MOBILE actif par détenteur »
  -- (INV-ADM-05).
  is_virtual                BOOLEAN GENERATED ALWAYS AS (
    location_type IN ('V_OPENING', 'V_SUPPLIER', 'V_CUSTOMER', 'V_PRODUCTION', 'V_CONSUMPTION', 'V_LOSS', 'V_PENDING_LOSS', 'V_ADJUSTMENT', 'V_TRANSIT')
  ) STORED,
  active_virtual_type       VARCHAR(20) GENERATED ALWAYS AS (
    IF(
      location_type IN ('V_OPENING', 'V_SUPPLIER', 'V_CUSTOMER', 'V_PRODUCTION', 'V_CONSUMPTION', 'V_LOSS', 'V_PENDING_LOSS', 'V_ADJUSTMENT', 'V_TRANSIT')
      AND status = 'ACTIVE',
      location_type,
      NULL
    )
  ) STORED,
  active_mobile_custodian   BINARY(16) GENERATED ALWAYS AS (
    IF(location_type = 'MOBILE' AND status = 'ACTIVE', custodian_user_id, NULL)
  ) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_organization_locations_site_code (site_id, code),
  UNIQUE KEY uq_organization_locations_active_virtual_type (active_virtual_type),
  UNIQUE KEY uq_organization_locations_active_mobile_custodian (active_mobile_custodian),
  KEY ix_organization_locations_site_type (site_id, location_type),
  KEY ix_organization_locations_custodian (custodian_user_id),
  CONSTRAINT ck_organization_locations_type CHECK (location_type IN (
    'STORE', 'POS', 'BUILDING', 'PEN', 'INCUBATOR', 'HATCHER', 'MOBILE',
    'V_OPENING', 'V_SUPPLIER', 'V_CUSTOMER', 'V_PRODUCTION', 'V_CONSUMPTION', 'V_LOSS', 'V_PENDING_LOSS', 'V_ADJUSTMENT', 'V_TRANSIT'
  )),
  CONSTRAINT ck_organization_locations_custody_mode CHECK (custody_mode IS NULL OR custody_mode IN ('EXCLUSIVE_USER', 'EXCLUSIVE_DEVICE', 'SHARED')),
  CONSTRAINT ck_organization_locations_status CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT ck_organization_locations_virtual_site CHECK (
    (is_virtual = TRUE AND site_id IS NULL) OR (is_virtual = FALSE AND site_id IS NOT NULL)
  ),
  CONSTRAINT ck_organization_locations_mobile CHECK (
    location_type <> 'MOBILE' OR (custodian_user_id IS NOT NULL AND custody_mode = 'EXCLUSIVE_USER')
  ),
  CONSTRAINT ck_organization_locations_exclusive_device CHECK (
    custody_mode <> 'EXCLUSIVE_DEVICE' OR designated_device_id IS NOT NULL
  ),
  CONSTRAINT fk_organization_locations_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_organization_locations_parent FOREIGN KEY (parent_location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_organization_locations_custodian FOREIGN KEY (custodian_user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_organization_locations_device FOREIGN KEY (designated_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_organization_locations_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_organization_locations_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- PEN (case) => parent de type BUILDING : jointure sur la même table, non exprimable en
-- CHECK MySQL (une seule ligne) ; déclencheur de revérification (ADR-023).
CREATE TRIGGER trg_organization_locations_pen_parent_ins BEFORE INSERT ON organization_locations FOR EACH ROW
BEGIN
  DECLARE parent_type VARCHAR(20);
  IF NEW.location_type = 'PEN' THEN
    IF NEW.parent_location_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_locations : une case (PEN) doit avoir un bâtiment parent.';
    END IF;
    SELECT location_type INTO parent_type FROM organization_locations WHERE id = NEW.parent_location_id;
    IF parent_type IS NULL OR parent_type <> 'BUILDING' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_locations : le parent d''une case (PEN) doit être un bâtiment (BUILDING).';
    END IF;
  END IF;
END;

CREATE TRIGGER trg_organization_locations_pen_parent_upd BEFORE UPDATE ON organization_locations FOR EACH ROW
BEGIN
  DECLARE parent_type VARCHAR(20);
  IF NEW.location_type = 'PEN' THEN
    IF NEW.parent_location_id IS NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_locations : une case (PEN) doit avoir un bâtiment parent.';
    END IF;
    SELECT location_type INTO parent_type FROM organization_locations WHERE id = NEW.parent_location_id;
    IF parent_type IS NULL OR parent_type <> 'BUILDING' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_locations : le parent d''une case (PEN) doit être un bâtiment (BUILDING).';
    END IF;
  END IF;
END;

-- Suppr. DESACTIVATION sous condition (BR-ADM-011, INV-STK-07) ; les virtuels ne sont
-- jamais désactivés (contrôle applicatif, pas de déclencheur dédié). Aucune suppression
-- physique dans tous les cas.
CREATE TRIGGER trg_organization_locations_no_delete BEFORE DELETE ON organization_locations FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_locations : suppression physique interdite (INV-GLO-03) ; utiliser status=INACTIVE.';
END;

CREATE TABLE organization_points_of_sale (
  site_id                             BINARY(16)     NOT NULL,
  sales_location_id                   BINARY(16)     NOT NULL,
  replenishment_source_location_id    BINARY(16)     NULL,
  custody_mode                        VARCHAR(20)    NOT NULL DEFAULT 'EXCLUSIVE_DEVICE',
  designated_device_id                BINARY(16)     NULL,
  opening_hours                       TEXT           NULL,
  created_at                          DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by                          BINARY(16)     NOT NULL,
  updated_at                          DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by                          BINARY(16)     NULL,
  version                             INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (site_id),
  CONSTRAINT ck_organization_pos_custody_mode CHECK (custody_mode IN ('EXCLUSIVE_DEVICE', 'SHARED')),
  CONSTRAINT ck_organization_pos_device CHECK (custody_mode <> 'EXCLUSIVE_DEVICE' OR designated_device_id IS NOT NULL),
  CONSTRAINT fk_organization_pos_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_organization_pos_sales_location FOREIGN KEY (sales_location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_organization_pos_replenishment FOREIGN KEY (replenishment_source_location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_organization_pos_device FOREIGN KEY (designated_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_organization_pos_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_organization_pos_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Le type POINT_DE_VENTE du site est vérifié par le code applicatif (contrôle TX,
-- dictionnaire §points_of_sale) : pas de jointure vers organization_sites en CHECK MySQL.
CREATE TRIGGER trg_organization_pos_no_delete BEFORE DELETE ON organization_points_of_sale FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_points_of_sale : suit le site, jamais supprimé indépendamment.';
END;

CREATE TABLE organization_teams (
  id                 BINARY(16)     NOT NULL,
  code               VARCHAR(40)    NOT NULL,
  name               VARCHAR(200)   NOT NULL,
  manager_user_id    BINARY(16)     NOT NULL,
  is_active          BOOLEAN        NOT NULL DEFAULT TRUE,
  created_at         DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by         BINARY(16)     NOT NULL,
  updated_at         DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by         BINARY(16)     NULL,
  version            INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_organization_teams_code (code),
  CONSTRAINT fk_organization_teams_manager FOREIGN KEY (manager_user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_organization_teams_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_organization_teams_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_organization_teams_no_delete BEFORE DELETE ON organization_teams FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_teams : suppression physique interdite (INV-GLO-03) ; utiliser is_active=false.';
END;

CREATE TABLE organization_team_memberships (
  id            BINARY(16)     NOT NULL,
  team_id       BINARY(16)     NOT NULL,
  user_id       BINARY(16)     NOT NULL,
  valid_from    DATETIME(6)    NOT NULL,
  valid_to      DATETIME(6)    NULL,
  created_at    DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by    BINARY(16)     NOT NULL,
  updated_at    DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by    BINARY(16)     NULL,
  version       INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  KEY ix_organization_team_memberships_user (user_id, valid_from, valid_to),
  CONSTRAINT ck_organization_team_memberships_period CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT fk_organization_team_memberships_team FOREIGN KEY (team_id) REFERENCES organization_teams (id) ON DELETE RESTRICT,
  CONSTRAINT fk_organization_team_memberships_user FOREIGN KEY (user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_organization_team_memberships_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_organization_team_memberships_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Périodes non chevauchantes par utilisateur (BR-ADM-014). Le verrouillage de ligne
-- (`SELECT … FOR UPDATE`) est la responsabilité du gestionnaire de commande (P0-06,
-- P0-11) ; ce déclencheur est la revérification qui rend la garantie équivalente à une
-- contrainte d'exclusion PostgreSQL (ADR-023).
CREATE TRIGGER trg_organization_team_memberships_overlap_ins BEFORE INSERT ON organization_team_memberships FOR EACH ROW
BEGIN
  IF EXISTS (
    SELECT 1 FROM organization_team_memberships
    WHERE user_id = NEW.user_id
      AND id <> NEW.id
      AND valid_from < COALESCE(NEW.valid_to, '9999-12-31 23:59:59.999999')
      AND COALESCE(valid_to, '9999-12-31 23:59:59.999999') > NEW.valid_from
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_team_memberships : périodes chevauchantes pour cet utilisateur (BR-ADM-014).';
  END IF;
END;

-- IMMUABLE sauf fermeture de période : seule `valid_to` (et les colonnes STD-AUDIT de
-- traçabilité de cette fermeture) peut changer après insertion ; revérifie aussi le
-- non-chevauchement si la fermeture est modifiée.
CREATE TRIGGER trg_organization_team_memberships_update_guard BEFORE UPDATE ON organization_team_memberships FOR EACH ROW
BEGIN
  IF NOT (
    NEW.team_id <=> OLD.team_id AND
    NEW.user_id <=> OLD.user_id AND
    NEW.valid_from <=> OLD.valid_from AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_team_memberships : seule la fermeture (valid_to) est modifiable.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM organization_team_memberships
    WHERE user_id = NEW.user_id
      AND id <> NEW.id
      AND valid_from < COALESCE(NEW.valid_to, '9999-12-31 23:59:59.999999')
      AND COALESCE(valid_to, '9999-12-31 23:59:59.999999') > NEW.valid_from
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_team_memberships : périodes chevauchantes pour cet utilisateur (BR-ADM-014).';
  END IF;
END;

CREATE TRIGGER trg_organization_team_memberships_no_delete BEFORE DELETE ON organization_team_memberships FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_team_memberships : suppression physique interdite (INV-ADM-04) ; fermer par valid_to.';
END;

CREATE TABLE organization_system_settings (
  id                   BINARY(16)     NOT NULL,
  `key`                VARCHAR(100)   NOT NULL,
  value                JSON           NOT NULL,
  scope_type           VARCHAR(10)    NOT NULL DEFAULT 'GLOBAL',
  scope_id             BINARY(16)     NULL,
  valid_from           DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  is_client_visible    BOOLEAN        NOT NULL DEFAULT FALSE,
  created_at           DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by           BINARY(16)     NOT NULL,
  reason               TEXT           NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_organization_system_settings_version (`key`, scope_type, scope_id, valid_from),
  CONSTRAINT ck_organization_system_settings_scope CHECK (scope_type IN ('GLOBAL', 'SITE', 'ZONE', 'ROLE')),
  CONSTRAINT fk_organization_system_settings_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- VERSIONNEMENT pur : une nouvelle ligne par changement, aucune colonne n'est jamais
-- modifiée après insertion (docs/03-data/03-historisation-suppression.md §3).
CREATE TRIGGER trg_organization_system_settings_no_update BEFORE UPDATE ON organization_system_settings FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_system_settings : aucune modification (versionnement, BR-ADM-015) ; insérer une nouvelle version.';
END;

CREATE TRIGGER trg_organization_system_settings_no_delete BEFORE DELETE ON organization_system_settings FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_system_settings : suppression physique interdite (versionnement, BR-ADM-015).';
END;

-- Droits par table (INV-GLO-05).
GRANT SELECT, INSERT, UPDATE ON organization_zones TO 'gic_app'@'%';
GRANT SELECT, INSERT, DELETE ON organization_zone_ancestors TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON organization_sites TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON organization_locations TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON organization_points_of_sale TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON organization_teams TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON organization_team_memberships TO 'gic_app'@'%';
GRANT SELECT, INSERT ON organization_system_settings TO 'gic_app'@'%';

-- migrate:down transaction:false
SET FOREIGN_KEY_CHECKS = 0;
-- FK différée ajoutée par cette migration sur une table d'un autre fichier : à retirer
-- explicitement (DROP TABLE avec FOREIGN_KEY_CHECKS=0 ne nettoie pas la définition de la
-- table enfant, qui referencerait sinon une table absente au prochain `up`).
ALTER TABLE identity_devices DROP FOREIGN KEY fk_identity_devices_designated_site;
DROP TABLE IF EXISTS organization_system_settings;
DROP TABLE IF EXISTS organization_team_memberships;
DROP TABLE IF EXISTS organization_teams;
DROP TABLE IF EXISTS organization_points_of_sale;
DROP TABLE IF EXISTS organization_locations;
DROP TABLE IF EXISTS organization_zone_ancestors;
DROP TABLE IF EXISTS organization_sites;
DROP TABLE IF EXISTS organization_zones;
SET FOREIGN_KEY_CHECKS = 1;
