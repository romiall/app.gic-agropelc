-- Espace de noms `attachments`. Source : docs/03-data/dictionnaire/10-approvals-
-- attachments-communication.md (section attachments.attachments).
--
-- migrate:up transaction:false

CREATE TABLE attachments_attachments (
  id                  BINARY(16)     NOT NULL,
  -- Propriétaire polymorphe (tout document) : pas de clé étrangère (03-data/02-modele-
  -- relationnel.md §4), validé par le module propriétaire.
  owner_type          VARCHAR(40)    NOT NULL,
  owner_id            BINARY(16)     NOT NULL,
  kind                VARCHAR(20)    NOT NULL,
  mime_type           VARCHAR(60)    NOT NULL,
  size_bytes          INT            NOT NULL,
  sha256              CHAR(64)       NOT NULL,
  storage_key         VARCHAR(200)   NULL,
  upload_status       VARCHAR(20)    NOT NULL DEFAULT 'PENDING_UPLOAD',
  uploaded_bytes       INT           NOT NULL DEFAULT 0,
  captured_at         DATETIME(6)    NOT NULL,
  captured_lat        DECIMAL(9,6)   NULL,
  captured_lng        DECIMAL(9,6)   NULL,
  superseded_by_id    BINARY(16)     NULL,
  -- [STD-ORIGIN] (INV-GLO-01 : colonnes immuables après insertion).
  occurred_at          DATETIME(6)   NOT NULL,
  client_created_at    DATETIME(6)   NULL,
  received_at          DATETIME(6)   NULL,
  command_id           BINARY(16)    NULL,
  created_device_id    BINARY(16)    NULL,
  captured_offline     BOOLEAN       NOT NULL DEFAULT FALSE,
  clock_suspect        BOOLEAN       NOT NULL DEFAULT FALSE,
  backdated_reason     TEXT          NULL,
  created_at           DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by           BINARY(16)    NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_attachments_attachments_storage_key (storage_key),
  KEY ix_attachments_attachments_owner (owner_type, owner_id),
  -- Pas d'index partiel MySQL (ADR-023) : index complet sur upload_status, un peu moins
  -- sélectif qu'un index partiel PostgreSQL mais sans impact de correction.
  KEY ix_attachments_attachments_upload_status (upload_status),
  CONSTRAINT ck_attachments_attachments_kind CHECK (kind IN ('PHOTO', 'INVOICE', 'RECEIPT', 'DELIVERY_NOTE', 'SUPPLIER_DOCUMENT', 'OTHER')),
  CONSTRAINT ck_attachments_attachments_size CHECK (size_bytes > 0 AND size_bytes <= 5242880),
  CONSTRAINT ck_attachments_attachments_upload_status CHECK (upload_status IN ('PENDING_UPLOAD', 'AVAILABLE', 'QUARANTINED', 'MISSING', 'SUPERSEDED')),
  CONSTRAINT ck_attachments_attachments_uploaded_bytes CHECK (uploaded_bytes >= 0 AND uploaded_bytes <= size_bytes),
  CONSTRAINT fk_attachments_attachments_superseded_by FOREIGN KEY (superseded_by_id) REFERENCES attachments_attachments (id) ON DELETE RESTRICT,
  CONSTRAINT fk_attachments_attachments_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_attachments_attachments_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- IMMUABLE (remplacement par SUPERSEDED) : seul le cycle de vie de l'upload change après
-- insertion (INV-GLO-01 : les colonnes STD-ORIGIN sont immuables).
CREATE TRIGGER trg_attachments_attachments_update_guard BEFORE UPDATE ON attachments_attachments FOR EACH ROW
BEGIN
  IF NOT (
    NEW.owner_type <=> OLD.owner_type AND
    NEW.owner_id <=> OLD.owner_id AND
    NEW.kind <=> OLD.kind AND
    NEW.mime_type <=> OLD.mime_type AND
    NEW.size_bytes <=> OLD.size_bytes AND
    NEW.sha256 <=> OLD.sha256 AND
    NEW.captured_at <=> OLD.captured_at AND
    NEW.captured_lat <=> OLD.captured_lat AND
    NEW.captured_lng <=> OLD.captured_lng AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.client_created_at <=> OLD.client_created_at AND
    NEW.received_at <=> OLD.received_at AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_device_id <=> OLD.created_device_id AND
    NEW.captured_offline <=> OLD.captured_offline AND
    NEW.clock_suspect <=> OLD.clock_suspect AND
    NEW.backdated_reason <=> OLD.backdated_reason AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    -- MESSAGE_TEXT est limité à 128 caractères par MySQL : rester concis.
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'attachments_attachments : seul le cycle de vie de l''upload est modifiable.';
  END IF;
END;

CREATE TRIGGER trg_attachments_attachments_no_delete BEFORE DELETE ON attachments_attachments FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'attachments_attachments : suppression physique interdite (INV-GLO-03) ; remplacer (SUPERSEDED).';
END;

GRANT SELECT, INSERT, UPDATE ON attachments_attachments TO 'gic_app'@'%';

-- migrate:down transaction:false
DROP TABLE IF EXISTS attachments_attachments;
