-- Module `identity`, périodes hors service closes d'un utilisateur (AV-229, suite d'AV-212 pour les appareils). Source :
-- BR-ADM-002, AT-034, SM-USER ; dictionnaire 01-identity (`identity_user_status_periods`).
--
-- Le contrôle d'utilisateur du pipeline (`checkUserActive`) ne lisait que le statut courant et `status_changed_at`, que
-- `reactivate` (et `deactivate` depuis la suspension) réécrit : après une réactivation, les faits datés pendant la
-- suspension étaient appliqués ; après `SUSPENDED` puis `DEACTIVATED`, ceux datés entre la suspension et la
-- désactivation aussi. La ligne `identity_users` reste la période **ouverte** ; chaque période hors service **close**
-- (par `reactivate` depuis `SUSPENDED` ou `DEACTIVATED`, ou par `deactivate` depuis `SUSPENDED`) est consignée ici, dans la
-- transaction de la commande, avant que la ligne vivante ne soit réécrite. Un fait daté dans `[valid_from, valid_to)`
-- d'une période close est mis en quarantaine (`CONFLICT USER_DEACTIVATED`), quel que soit le statut courant.
--
-- Ajout seul (IMMUABLE) : ni modification ni suppression. Une période par commande de fermeture (`command_id`, clé
-- primaire) : un rejeu n'en crée pas de seconde. Amorçage : aucune ligne — les comptes déjà hors service portent leur
-- période ouverte dans `status_changed_at`, et les périodes closes antérieures n'ont jamais été conservées.
--
-- migrate:up transaction:false

CREATE TABLE identity_user_status_periods (
  command_id   BINARY(16)   NOT NULL,
  user_id      BINARY(16)   NOT NULL,
  status       VARCHAR(20)  NOT NULL,
  valid_from   DATETIME(6)  NOT NULL,
  valid_to     DATETIME(6)  NOT NULL,
  reason       TEXT         NULL,
  closed_by    BINARY(16)   NOT NULL,
  created_at   DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (command_id),
  KEY ix_identity_user_status_periods_user (user_id, valid_from),
  CONSTRAINT ck_identity_user_status_periods_status CHECK (status IN ('SUSPENDED', 'DEACTIVATED')),
  CONSTRAINT ck_identity_user_status_periods_bounds CHECK (valid_to > valid_from),
  CONSTRAINT fk_identity_user_status_periods_user FOREIGN KEY (user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_identity_user_status_periods_closed_by FOREIGN KEY (closed_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_identity_user_status_periods_no_update BEFORE UPDATE ON identity_user_status_periods FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'identity_user_status_periods : aucune modification (périodes en ajout seul, BR-ADM-002).';
END;

CREATE TRIGGER trg_identity_user_status_periods_no_delete BEFORE DELETE ON identity_user_status_periods FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'identity_user_status_periods : suppression physique interdite (INV-GLO-03).';
END;

GRANT SELECT, INSERT ON identity_user_status_periods TO 'gic_app'@'%';

-- migrate:down transaction:false

DROP TABLE identity_user_status_periods;
