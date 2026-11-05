-- Espace de noms `crm` : bilan hebdomadaire du commercial (PP-E ; REQ-307, AV-314).
-- Source : docs/03-data/dictionnaire/04-crm-fieldwork.md ; D02-CRM ; fiche papier BH (« Bilan hebdomadaire »).
--
-- Un bilan par commercial et par semaine (lundi au dimanche, jours métier de Douala) : les réussites, les difficultés,
-- les besoins et demandes à la direction, les priorités de la semaine suivante et les informations du marché. Les
-- chiffres de la fiche (visites, nouveaux prospects et clients, chiffre d'affaires, encaissé, casses et pertes) ne sont
-- jamais saisis : la lecture les calcule depuis les visites, les comptes, les ventes, les encaissements et les pertes
-- (le principe du contexte métier veut qu'aucun indicateur ne soit saisi). Le « vu par le responsable » et son
-- commentaire sont portés par le bilan (`reviewed_*`, `manager_comment`).
-- Le commercial peut corriger son bilan tant que le responsable ne l'a pas vu ; ensuite il est figé (les textes
-- d'avant restent dans le journal d'audit de la commande).
--
-- Expand seulement : une table nouvelle, que la version précédente du code ignore.
--
-- migrate:up transaction:false

CREATE TABLE crm_weekly_reports (
  id                  BINARY(16)   NOT NULL,
  user_id             BINARY(16)   NOT NULL,
  week_start          DATE         NOT NULL,
  successes           TEXT         NULL,
  difficulties        TEXT         NULL,
  needs               TEXT         NULL,
  priorities          TEXT         NULL,
  market_info         TEXT         NULL,
  status              VARCHAR(10)  NOT NULL DEFAULT 'SUBMITTED',
  last_edited_at      DATETIME(6)  NOT NULL,
  reviewed_at         DATETIME(6)  NULL,
  reviewed_by         BINARY(16)   NULL,
  manager_comment     TEXT         NULL,
  occurred_at         DATETIME(6)  NOT NULL,
  client_created_at   DATETIME(6)  NULL,
  received_at_server  DATETIME(6)  NULL,
  command_id          BINARY(16)   NULL,
  created_device_id   BINARY(16)   NULL,
  captured_offline    BOOLEAN      NOT NULL DEFAULT FALSE,
  clock_suspect       BOOLEAN      NOT NULL DEFAULT FALSE,
  backdated_reason    TEXT         NULL,
  created_at          DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by          BINARY(16)   NOT NULL,
  updated_at          DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by          BINARY(16)   NULL,
  version             INT          NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_crm_weekly_reports_command (command_id),
  UNIQUE KEY uq_crm_weekly_reports_user_week (user_id, week_start),
  KEY ix_crm_weekly_reports_week (week_start),
  CONSTRAINT ck_crm_weekly_reports_status CHECK (status IN ('SUBMITTED', 'REVIEWED')),
  -- La semaine du bilan commence un lundi (DAYOFWEEK : 1 = dimanche, 2 = lundi).
  CONSTRAINT ck_crm_weekly_reports_monday CHECK (DAYOFWEEK(week_start) = 2),
  -- « Vu par le responsable » : renseigné si et seulement si REVIEWED.
  CONSTRAINT ck_crm_weekly_reports_review CHECK (
    (status = 'REVIEWED' AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)
    OR (status <> 'REVIEWED' AND reviewed_at IS NULL AND reviewed_by IS NULL AND manager_comment IS NULL)
  ),
  CONSTRAINT fk_crm_weekly_reports_user FOREIGN KEY (user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_weekly_reports_reviewed_by FOREIGN KEY (reviewed_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_weekly_reports_created_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_weekly_reports_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_weekly_reports_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Le bilan ne change jamais de commercial ni de semaine ; une fois vu, ses textes sont figés.
CREATE TRIGGER trg_crm_weekly_reports_update_guard BEFORE UPDATE ON crm_weekly_reports FOR EACH ROW
BEGIN
  IF NOT (
    NEW.user_id <=> OLD.user_id AND
    NEW.week_start <=> OLD.week_start AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_weekly_reports : le commercial et la semaine d''un bilan ne changent pas.';
  END IF;
  -- Un bilan vu ne redevient pas `SUBMITTED` : sans cette garde, deux UPDATE (repasser en `SUBMITTED`, puis changer les
  -- textes) contourneraient le figement des textes.
  IF OLD.status = 'REVIEWED' AND NEW.status <> 'REVIEWED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_weekly_reports : un bilan vu ne redevient pas modifiable.';
  END IF;
  IF OLD.status = 'REVIEWED' AND NOT (
    NEW.successes <=> OLD.successes AND
    NEW.difficulties <=> OLD.difficulties AND
    NEW.needs <=> OLD.needs AND
    NEW.priorities <=> OLD.priorities AND
    NEW.market_info <=> OLD.market_info
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_weekly_reports : bilan vu par le responsable, textes figés.';
  END IF;
END;

CREATE TRIGGER trg_crm_weekly_reports_no_delete BEFORE DELETE ON crm_weekly_reports FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_weekly_reports : suppression physique interdite (INV-GLO-03).';
END;

GRANT SELECT, INSERT, UPDATE ON crm_weekly_reports TO 'gic_app'@'%';

-- migrate:down transaction:false

DROP TABLE IF EXISTS crm_weekly_reports;
