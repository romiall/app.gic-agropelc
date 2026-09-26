-- Espace de noms `fieldwork` (P3-02). Source : docs/03-data/dictionnaire/04-crm-fieldwork.md
-- §fieldwork.geo_checkins, §fieldwork.work_sessions ; D03-TER ; SM-WORK-SESSION.
--
-- Référence circulaire session ↔ tentative : une session pointe sa tentative d'ouverture
-- (`start_checkin_id`) et de fermeture (`end_checkin_id`), une tentative pointe la session
-- qu'elle ouvre ou ferme (`work_session_id`). MySQL ne diffère pas la vérification des clés
-- étrangères : seule la seconde direction porte une contrainte (la session est insérée
-- d'abord, avec l'identifiant de sa tentative déjà connu) ; `start_checkin_id`/`end_checkin_id`
-- sont des références sans clé étrangère, vérifiées par le gestionnaire (même précédent que les
-- références polymorphes, conventions §4).
--
-- migrate:up transaction:false

CREATE TABLE fieldwork_work_sessions (
  id                   BINARY(16)     NOT NULL,
  user_id              BINARY(16)     NOT NULL,
  device_id            BINARY(16)     NOT NULL,
  declared_zone_id     BINARY(16)     NOT NULL,
  started_at           DATETIME(6)    NOT NULL,
  start_checkin_id     BINARY(16)     NOT NULL,
  ended_at             DATETIME(6)    NULL,
  end_checkin_id       BINARY(16)     NULL,
  status               VARCHAR(12)    NOT NULL DEFAULT 'OPEN',
  close_cause          VARCHAR(12)    NULL,
  override_status      VARCHAR(12)    NOT NULL DEFAULT 'NOT_REQUIRED',
  override_reason      TEXT           NULL,
  approval_request_id  BINARY(16)     NULL,
  -- INV-TER-01 : au plus une session non clôturée par utilisateur (unicité partielle,
  -- conventions §4 : colonne générée NULL hors condition + UNIQUE).
  open_user_key        BINARY(16)     GENERATED ALWAYS AS (CASE WHEN status = 'OPEN' THEN user_id END) STORED,
  occurred_at          DATETIME(6)    NOT NULL,
  client_created_at    DATETIME(6)    NULL,
  received_at_server   DATETIME(6)    NULL,
  command_id           BINARY(16)     NULL,
  created_device_id    BINARY(16)     NULL,
  captured_offline     BOOLEAN        NOT NULL DEFAULT FALSE,
  clock_suspect        BOOLEAN        NOT NULL DEFAULT FALSE,
  backdated_reason     TEXT           NULL,
  created_at           DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by           BINARY(16)     NOT NULL,
  updated_at           DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by           BINARY(16)     NULL,
  version              INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_fieldwork_work_sessions_open_user (open_user_key),
  UNIQUE KEY uq_fieldwork_work_sessions_command (command_id),
  KEY ix_fieldwork_work_sessions_user_started (user_id, started_at),
  CONSTRAINT ck_fieldwork_work_sessions_status CHECK (status IN ('OPEN', 'CLOSED', 'AUTO_CLOSED')),
  CONSTRAINT ck_fieldwork_work_sessions_close_cause CHECK (
    close_cause IS NULL OR close_cause IN ('END_SERVICE', 'SUPERSEDED', 'AUTO_2359', 'FORCED')
  ),
  CONSTRAINT ck_fieldwork_work_sessions_override CHECK (
    override_status IN ('NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED')
  ),
  CONSTRAINT ck_fieldwork_work_sessions_lifecycle CHECK (
    (status = 'OPEN' AND ended_at IS NULL AND close_cause IS NULL AND end_checkin_id IS NULL)
    OR (status <> 'OPEN' AND ended_at IS NOT NULL AND close_cause IS NOT NULL)
  ),
  CONSTRAINT ck_fieldwork_work_sessions_period CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT fk_fieldwork_work_sessions_user FOREIGN KEY (user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_fieldwork_work_sessions_device FOREIGN KEY (device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_fieldwork_work_sessions_zone FOREIGN KEY (declared_zone_id) REFERENCES organization_zones (id) ON DELETE RESTRICT,
  CONSTRAINT fk_fieldwork_work_sessions_approval FOREIGN KEY (approval_request_id) REFERENCES approvals_approval_requests (id) ON DELETE RESTRICT,
  CONSTRAINT fk_fieldwork_work_sessions_created_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_fieldwork_work_sessions_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_fieldwork_work_sessions_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- IMMUABLE sauf transitions (dictionnaire) : seuls la clôture et la dérogation évoluent.
CREATE TRIGGER trg_fieldwork_work_sessions_update_guard BEFORE UPDATE ON fieldwork_work_sessions FOR EACH ROW
BEGIN
  IF NOT (
    NEW.user_id <=> OLD.user_id AND
    NEW.device_id <=> OLD.device_id AND
    NEW.declared_zone_id <=> OLD.declared_zone_id AND
    NEW.started_at <=> OLD.started_at AND
    NEW.start_checkin_id <=> OLD.start_checkin_id AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_device_id <=> OLD.created_device_id AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fieldwork_work_sessions : seules la clôture et la dérogation sont modifiables.';
  END IF;
END;

CREATE TRIGGER trg_fieldwork_work_sessions_no_delete BEFORE DELETE ON fieldwork_work_sessions FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fieldwork_work_sessions : suppression physique interdite (INV-GLO-03).';
END;

CREATE TABLE fieldwork_geo_checkins (
  id                   BINARY(16)     NOT NULL,
  user_id              BINARY(16)     NOT NULL,
  checkin_type         VARCHAR(15)    NOT NULL,
  declared_zone_id     BINARY(16)     NOT NULL,
  lat                  DECIMAL(9,6)   NULL,
  lng                  DECIMAL(9,6)   NULL,
  accuracy_m           DECIMAL(8,1)   NULL,
  -- Géorepère figé au moment du calcul serveur (BR-ADM-013, BR-TER-003).
  geofence_lat         DECIMAL(9,6)   NULL,
  geofence_lng         DECIMAL(9,6)   NULL,
  geofence_radius_m    DECIMAL(8,1)   NULL,
  max_accuracy_m       DECIMAL(8,1)   NULL,
  distance_m           DECIMAL(8,1)   NULL,
  client_result        VARCHAR(25)    NOT NULL,
  server_result        VARCHAR(25)    NOT NULL,
  result_divergence    BOOLEAN        NOT NULL DEFAULT FALSE,
  work_session_id      BINARY(16)     NULL,
  suspicion_flags      JSON           NOT NULL DEFAULT (JSON_ARRAY()),
  occurred_at          DATETIME(6)    NOT NULL,
  client_created_at    DATETIME(6)    NULL,
  received_at_server   DATETIME(6)    NULL,
  command_id           BINARY(16)     NULL,
  created_device_id    BINARY(16)     NULL,
  captured_offline     BOOLEAN        NOT NULL DEFAULT FALSE,
  clock_suspect        BOOLEAN        NOT NULL DEFAULT FALSE,
  backdated_reason     TEXT           NULL,
  created_at           DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by           BINARY(16)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_fieldwork_geo_checkins_command (command_id),
  KEY ix_fieldwork_geo_checkins_user_occurred (user_id, occurred_at),
  KEY ix_fieldwork_geo_checkins_session (work_session_id),
  CONSTRAINT ck_fieldwork_geo_checkins_type CHECK (checkin_type IN ('START_SERVICE', 'END_SERVICE')),
  CONSTRAINT ck_fieldwork_geo_checkins_client_result CHECK (client_result IN (
    'ACCEPTED', 'REJECTED_OUT_OF_ZONE', 'REJECTED_LOW_ACCURACY', 'NO_POSITION'
  )),
  CONSTRAINT ck_fieldwork_geo_checkins_server_result CHECK (server_result IN (
    'ACCEPTED', 'REJECTED_OUT_OF_ZONE', 'REJECTED_LOW_ACCURACY', 'NO_POSITION', 'ZONE_INACTIVE'
  )),
  CONSTRAINT ck_fieldwork_geo_checkins_position CHECK (
    (lat IS NULL AND lng IS NULL) OR (lat IS NOT NULL AND lng IS NOT NULL)
  ),
  CONSTRAINT ck_fieldwork_geo_checkins_ranges CHECK (
    (lat IS NULL OR lat BETWEEN -90 AND 90) AND (lng IS NULL OR lng BETWEEN -180 AND 180)
    AND (accuracy_m IS NULL OR accuracy_m >= 0)
  ),
  CONSTRAINT ck_fieldwork_geo_checkins_no_position CHECK (server_result <> 'NO_POSITION' OR lat IS NULL),
  CONSTRAINT fk_fieldwork_geo_checkins_user FOREIGN KEY (user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_fieldwork_geo_checkins_zone FOREIGN KEY (declared_zone_id) REFERENCES organization_zones (id) ON DELETE RESTRICT,
  CONSTRAINT fk_fieldwork_geo_checkins_session FOREIGN KEY (work_session_id) REFERENCES fieldwork_work_sessions (id) ON DELETE RESTRICT,
  CONSTRAINT fk_fieldwork_geo_checkins_created_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_fieldwork_geo_checkins_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- IMMUABLE (INV-TER-02 : toute tentative est conservée, y compris refusée). La
-- pseudonymisation des coordonnées après 2 ans (AV-074) ajoutera ici sa propre exception.
CREATE TRIGGER trg_fieldwork_geo_checkins_no_update BEFORE UPDATE ON fieldwork_geo_checkins FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fieldwork_geo_checkins : tentative de pointage immuable (INV-TER-02).';
END;

CREATE TRIGGER trg_fieldwork_geo_checkins_no_delete BEFORE DELETE ON fieldwork_geo_checkins FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fieldwork_geo_checkins : suppression physique interdite (INV-TER-02, INV-GLO-03).';
END;

-- Droits par table (INV-GLO-05). Tentatives : ajout seul.
GRANT SELECT, INSERT, UPDATE ON fieldwork_work_sessions TO 'gic_app'@'%';
GRANT SELECT, INSERT ON fieldwork_geo_checkins TO 'gic_app'@'%';

-- migrate:down transaction:false
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS fieldwork_geo_checkins;
DROP TABLE IF EXISTS fieldwork_work_sessions;
SET FOREIGN_KEY_CHECKS = 1;
