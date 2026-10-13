-- Module `identity`, périodes hors service closes d'un appareil (P5-23, revue adverse ; AV-212). Source :
-- INV-ADM-03, BR-ADM-006, SM-DEVICE ; dictionnaire 01-identity (`identity_device_status_periods`).
--
-- Le contrôle d'appareil du pipeline (`checkDeviceActive`) ne lisait que le statut courant et
-- `status_changed_at`, que `unblock` et `retire` réécrivent : après un déblocage, les faits datés pendant le
-- blocage étaient appliqués ; après `LOST` puis `RETIRED`, ceux datés entre la perte et le retrait aussi.
-- La ligne `identity_devices` reste la période **ouverte** ; chaque période hors service **close** (par
-- `unblock`, ou par `retire` depuis `BLOCKED` ou `LOST`) est consignée ici, dans la transaction de la
-- commande, avant que la ligne vivante ne soit réécrite. Un fait daté dans `[valid_from, valid_to)` d'une
-- période close est mis en quarantaine (`CONFLICT DEVICE_REVOKED`), quel que soit le statut courant.
--
-- Ajout seul (IMMUABLE) : ni modification ni suppression. Une période par commande de fermeture
-- (`command_id`, clé primaire) : un rejeu n'en crée pas de seconde. Amorçage : aucune ligne — les appareils
-- déjà hors service portent leur période ouverte dans `status_changed_at`, et les périodes closes antérieures
-- n'ont jamais été conservées (aucune base de production n'existe, P0-17).
--
-- migrate:up transaction:false

CREATE TABLE identity_device_status_periods (
  command_id   BINARY(16)   NOT NULL,
  device_id    BINARY(16)   NOT NULL,
  status       VARCHAR(20)  NOT NULL,
  valid_from   DATETIME(6)  NOT NULL,
  valid_to     DATETIME(6)  NOT NULL,
  reason       TEXT         NULL,
  closed_by    BINARY(16)   NOT NULL,
  created_at   DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (command_id),
  KEY ix_identity_device_status_periods_device (device_id, valid_from),
  CONSTRAINT ck_identity_device_status_periods_status CHECK (status IN ('BLOCKED', 'LOST')),
  CONSTRAINT ck_identity_device_status_periods_bounds CHECK (valid_to > valid_from),
  CONSTRAINT fk_identity_device_status_periods_device FOREIGN KEY (device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_identity_device_status_periods_closed_by FOREIGN KEY (closed_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_identity_device_status_periods_no_update BEFORE UPDATE ON identity_device_status_periods FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'identity_device_status_periods : aucune modification (périodes en ajout seul, INV-ADM-03).';
END;

CREATE TRIGGER trg_identity_device_status_periods_no_delete BEFORE DELETE ON identity_device_status_periods FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'identity_device_status_periods : suppression physique interdite (INV-GLO-03).';
END;

GRANT SELECT, INSERT ON identity_device_status_periods TO 'gic_app'@'%';

-- migrate:down transaction:false

DROP TABLE identity_device_status_periods;
