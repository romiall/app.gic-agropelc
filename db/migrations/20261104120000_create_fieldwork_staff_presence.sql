-- Espace de noms `fieldwork` : présence du personnel, alimentée chaque semaine par la fiche PT (PP-E ; REQ-306, AV-313).
-- Source : docs/03-data/dictionnaire/04-crm-fieldwork.md ; D03-TER ; fiche papier PT (« Présence et pointage »).
--
-- Le pointage numérique (`fieldwork_work_sessions`) ne couvre que les commerciaux de terrain. Les ouvriers et le
-- personnel administratif n'ont pas tous un compte : leur présence se relève sur la fiche PT (secours papier) et se
-- reporte une fois par semaine. Deux tables (AV-313 (a) : « table légère », le lot d'import hebdomadaire étant la
-- feuille) :
--   - `fieldwork_presence_sheets` : une feuille PT reportée (site, semaine, numéro de la feuille papier, responsable) ;
--     seule son annulation motivée la modifie (règle 4 : rien ne disparaît) ;
--   - `fieldwork_staff_presence` : une ligne par personne et par jour, en ajout seul.
-- Usage statistique et de suivi : ni paie ni discipline (AV-313). Ces lignes ne sont pas des sessions de travail : elles
-- n'entrent pas dans `analytics_f_attendance` (aucun jour de présence d'un commercial n'est compté deux fois).
--
-- Expand seulement : deux tables nouvelles, que la version précédente du code ignore.
--
-- migrate:up transaction:false

CREATE TABLE fieldwork_presence_sheets (
  id                  BINARY(16)   NOT NULL,
  site_id             BINARY(16)   NOT NULL,
  week_start          DATE         NOT NULL,
  paper_ref           VARCHAR(30)  NULL,
  responsible_name    VARCHAR(120) NULL,
  source              VARCHAR(10)  NOT NULL DEFAULT 'PAPER',
  status              VARCHAR(10)  NOT NULL DEFAULT 'RECORDED',
  cancelled_at        DATETIME(6)  NULL,
  cancelled_by        BINARY(16)   NULL,
  cancel_comment      TEXT         NULL,
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
  UNIQUE KEY uq_fieldwork_presence_sheets_command (command_id),
  KEY ix_fieldwork_presence_sheets_site_week (site_id, week_start),
  CONSTRAINT ck_fieldwork_presence_sheets_source CHECK (source IN ('PAPER')),
  CONSTRAINT ck_fieldwork_presence_sheets_status CHECK (status IN ('RECORDED', 'CANCELLED')),
  -- La semaine de la fiche PT commence un lundi (DAYOFWEEK : 1 = dimanche, 2 = lundi).
  CONSTRAINT ck_fieldwork_presence_sheets_monday CHECK (DAYOFWEEK(week_start) = 2),
  -- [STD-CANCEL] : colonnes d'annulation renseignées si et seulement si CANCELLED.
  CONSTRAINT ck_fieldwork_presence_sheets_cancel CHECK (
    (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancel_comment IS NOT NULL)
    OR (status <> 'CANCELLED' AND cancelled_at IS NULL AND cancelled_by IS NULL AND cancel_comment IS NULL)
  ),
  CONSTRAINT fk_fieldwork_presence_sheets_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_fieldwork_presence_sheets_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_fieldwork_presence_sheets_created_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_fieldwork_presence_sheets_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_fieldwork_presence_sheets_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Une feuille reportée n'est plus modifiable : seule l'annulation motivée (et la version) évolue (règle 4). Une feuille
-- annulée ne change plus du tout : elle ne redevient pas `RECORDED` et ses colonnes d'annulation ne se réécrivent pas.
CREATE TRIGGER trg_fieldwork_presence_sheets_update_guard BEFORE UPDATE ON fieldwork_presence_sheets FOR EACH ROW
BEGIN
  IF OLD.status = 'CANCELLED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fieldwork_presence_sheets : feuille annulée, plus modifiable (règle 4).';
  END IF;
  IF NOT (
    NEW.site_id <=> OLD.site_id AND
    NEW.week_start <=> OLD.week_start AND
    NEW.paper_ref <=> OLD.paper_ref AND
    NEW.responsible_name <=> OLD.responsible_name AND
    NEW.source <=> OLD.source AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fieldwork_presence_sheets : feuille non modifiable ; l''annuler et en reporter une nouvelle (règle 4).';
  END IF;
END;

CREATE TRIGGER trg_fieldwork_presence_sheets_no_delete BEFORE DELETE ON fieldwork_presence_sheets FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fieldwork_presence_sheets : suppression physique interdite (INV-GLO-03) ; utiliser CANCELLED.';
END;

CREATE TABLE fieldwork_staff_presence (
  id             BINARY(16)   NOT NULL,
  sheet_id       BINARY(16)   NOT NULL,
  line_no        SMALLINT     NOT NULL,
  presence_date  DATE         NOT NULL,
  person_name    VARCHAR(120) NOT NULL,
  person_role    VARCHAR(80)  NULL,
  mission_label  VARCHAR(80)  NULL,
  user_id        BINARY(16)   NULL,
  arrival_time   TIME         NULL,
  departure_time TIME         NULL,
  absence_code   VARCHAR(2)   NULL,
  created_at     DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by     BINARY(16)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_fieldwork_staff_presence_line_day (sheet_id, line_no, presence_date),
  KEY ix_fieldwork_staff_presence_date (presence_date),
  KEY ix_fieldwork_staff_presence_user_date (user_id, presence_date),
  CONSTRAINT ck_fieldwork_staff_presence_absence CHECK (absence_code IS NULL OR absence_code IN ('A', 'M', 'C', 'R', 'MI')),
  -- Un jour s'écrit en heures (arrivée, départ) ou par un code d'absence, jamais les deux ; un départ suppose une arrivée.
  CONSTRAINT ck_fieldwork_staff_presence_day CHECK (
    (absence_code IS NULL OR (arrival_time IS NULL AND departure_time IS NULL))
    AND (departure_time IS NULL OR arrival_time IS NOT NULL)
  ),
  CONSTRAINT fk_fieldwork_staff_presence_sheet FOREIGN KEY (sheet_id) REFERENCES fieldwork_presence_sheets (id) ON DELETE RESTRICT,
  CONSTRAINT fk_fieldwork_staff_presence_user FOREIGN KEY (user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_fieldwork_staff_presence_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_fieldwork_staff_presence_no_update BEFORE UPDATE ON fieldwork_staff_presence FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fieldwork_staff_presence : ligne en ajout seul, modification interdite (règle 4).';
END;

CREATE TRIGGER trg_fieldwork_staff_presence_no_delete BEFORE DELETE ON fieldwork_staff_presence FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fieldwork_staff_presence : suppression physique interdite (INV-GLO-03).';
END;

GRANT SELECT, INSERT, UPDATE ON fieldwork_presence_sheets TO 'gic_app'@'%';
GRANT SELECT, INSERT ON fieldwork_staff_presence TO 'gic_app'@'%';

-- migrate:down transaction:false

DROP TABLE IF EXISTS fieldwork_staff_presence;
DROP TABLE IF EXISTS fieldwork_presence_sheets;
