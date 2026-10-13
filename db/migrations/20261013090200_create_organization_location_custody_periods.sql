-- Module `organization`, historique de la garde des emplacements (P5-23, revue adverse ; AV-195 (2), ADR-040).
-- Source : BR-STK-016, ADR-033 §2 ; dictionnaire 02-organization (`organization_location_custody_periods`).
--
-- La garde d'appareil des faits hors ligne (`custodyMismatch`, `inventory`) lisait le mode de garde et
-- l'appareil désigné **courants** : une vente de l'ancien appareil d'un PDV, faite avant un changement
-- d'appareil désigné mais synchronisée après, ouvrait un faux `CUSTODY_DEVICE_MISMATCH` ; un fait antérieur à
-- un passage de la garde exclusive à la garde partagée était jugé sous les règles du partage. Chaque période
-- de garde (mode, appareil désigné) est désormais consignée : un fait hors ligne se juge sur la période qui
-- couvre son `occurred_at`.
--
-- Écrite par `organization.location.create` (période initiale) et `organization.pos.configure` (une période
-- naît seulement quand le couple (mode, appareil) change). Fermeture d'une période : `valid_to` posé une
-- seule fois ; rien d'autre ne se modifie ni ne se supprime. Amorçage : une période ouverte par emplacement
-- physique, avec son état courant, depuis sa création.
--
-- migrate:up transaction:false

CREATE TABLE organization_location_custody_periods (
  id                    BINARY(16)   NOT NULL,
  location_id           BINARY(16)   NOT NULL,
  custody_mode          VARCHAR(20)  NOT NULL,
  designated_device_id  BINARY(16)   NULL,
  valid_from            DATETIME(6)  NOT NULL,
  valid_to              DATETIME(6)  NULL,
  command_id            BINARY(16)   NULL,
  created_by            BINARY(16)   NOT NULL,
  created_at            DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY ix_organization_location_custody_periods_location (location_id, valid_from),
  CONSTRAINT ck_organization_location_custody_periods_mode CHECK (custody_mode IN ('EXCLUSIVE_USER', 'EXCLUSIVE_DEVICE', 'SHARED')),
  CONSTRAINT ck_organization_location_custody_periods_device CHECK (custody_mode <> 'EXCLUSIVE_DEVICE' OR designated_device_id IS NOT NULL),
  CONSTRAINT ck_organization_location_custody_periods_bounds CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT fk_organization_location_custody_periods_location FOREIGN KEY (location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_organization_location_custody_periods_device FOREIGN KEY (designated_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_organization_location_custody_periods_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_organization_location_custody_periods_update_guard BEFORE UPDATE ON organization_location_custody_periods FOR EACH ROW
BEGIN
  IF NOT (
    NEW.id <=> OLD.id AND
    NEW.location_id <=> OLD.location_id AND
    NEW.custody_mode <=> OLD.custody_mode AND
    NEW.designated_device_id <=> OLD.designated_device_id AND
    NEW.valid_from <=> OLD.valid_from AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_by <=> OLD.created_by AND
    NEW.created_at <=> OLD.created_at AND
    OLD.valid_to IS NULL
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_location_custody_periods : seule la fermeture d''une période ouverte (valid_to) est admise.';
  END IF;
END;

CREATE TRIGGER trg_organization_location_custody_periods_no_delete BEFORE DELETE ON organization_location_custody_periods FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'organization_location_custody_periods : suppression physique interdite (INV-GLO-03).';
END;

INSERT INTO organization_location_custody_periods
  (id, location_id, custody_mode, designated_device_id, valid_from, valid_to, command_id, created_by)
SELECT UUID_TO_BIN(UUID()), l.id, l.custody_mode, l.designated_device_id, l.created_at, NULL, NULL, l.created_by
  FROM organization_locations l
 WHERE l.is_virtual = FALSE AND l.custody_mode IS NOT NULL
   AND (l.custody_mode <> 'EXCLUSIVE_DEVICE' OR l.designated_device_id IS NOT NULL);

GRANT SELECT, INSERT, UPDATE ON organization_location_custody_periods TO 'gic_app'@'%';

-- migrate:down transaction:false

DROP TABLE organization_location_custody_periods;
