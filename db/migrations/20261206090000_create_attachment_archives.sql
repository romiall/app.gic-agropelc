-- Module `attachments`, archive des photos jointes (AV-539, ADR-070). Source : docs/03-data/dictionnaire/
-- 10-approvals-attachments-communication.md (`attachments_archives`, `attachments_archive_volumes`,
-- `attachments_archive_items`) ; Q10 du questionnaire de clôture (08/11/2026).
--
-- L'Admin télécharge les photos jointes de plus de 30 jours par période, rangées par type d'opération, puis vide
-- l'espace du serveur. La ligne de `attachments_attachments` n'est jamais touchée (la pièce reste `AVAILABLE`, INV-GLO-03) ;
-- ce qui se perd, c'est le fichier du disque, et ces trois tables en gardent la trace :
-- - `attachments_archives`        le plan figé d'une période (un seul plan vivant par période : `live_key`) ;
-- - `attachments_archive_volumes` un fichier ZIP du plan (un mois, une catégorie d'opération), avec la preuve de sa livraison ;
-- - `attachments_archive_items`   une photo du plan : référence, chemin dans l'archive, empreinte, taille, date de soumission.
--
-- Aucune suppression physique (déclencheurs) ; seuls l'état de livraison, de vérification et de résolution évoluent
-- après l'insertion. Le plancher de 30 jours est aussi un CHECK : en deçà, une migration serait nécessaire.
--
-- migrate:up transaction:false

CREATE TABLE attachments_archives (
  id                    BINARY(16)    NOT NULL,
  granularity           VARCHAR(10)   NOT NULL,
  -- Période en jours locaux (Africa/Douala) : `period_start` inclus, `period_end` exclu.
  period_start          DATE          NOT NULL,
  period_end            DATE          NOT NULL,
  -- Seules les pièces reçues avant cet instant (maintenant moins `min_age_days`) sont archivables.
  cutoff_at             DATETIME(6)   NOT NULL,
  min_age_days          INT           NOT NULL,
  volume_max_bytes      BIGINT        NOT NULL,
  -- Conservation de l'archive de l'entreprise, rappelée dans LISEZMOI.txt : figée au plan pour que le volume reste identique.
  retention_years       INT           NOT NULL,
  file_count            INT           NOT NULL,
  files_bytes           BIGINT        NOT NULL,
  -- Pièces de la période écartées au calcul du plan : opération encore ouverte, fichier absent du disque.
  kept_open_count       INT           NOT NULL DEFAULT 0,
  absent_count          INT           NOT NULL DEFAULT 0,
  status                VARCHAR(12)   NOT NULL DEFAULT 'READY',
  -- Un seul plan vivant par période (index unique partiel, ADR-023).
  live_key              VARCHAR(30)   GENERATED ALWAYS AS (
    CASE WHEN status = 'READY' THEN CONCAT(granularity, ':', period_start) END
  ) STORED,
  completed_at          DATETIME(6)   NULL,
  cancelled_at          DATETIME(6)   NULL,
  cancelled_by          BINARY(16)    NULL,
  created_at            DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by            BINARY(16)    NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_attachments_archives_live (live_key),
  KEY ix_attachments_archives_period (period_start, created_at),
  CONSTRAINT ck_attachments_archives_granularity CHECK (granularity IN ('MONTH', 'QUARTER')),
  CONSTRAINT ck_attachments_archives_status CHECK (status IN ('READY', 'COMPLETED', 'CANCELLED')),
  CONSTRAINT ck_attachments_archives_period CHECK (period_end > period_start),
  CONSTRAINT ck_attachments_archives_counts CHECK (
    file_count > 0 AND files_bytes >= 0 AND kept_open_count >= 0 AND absent_count >= 0 AND volume_max_bytes > 0
  ),
  -- Plancher de 30 jours (ADR-070 §2) : les images de moins de 30 jours restent toujours sur le serveur.
  CONSTRAINT ck_attachments_archives_min_age CHECK (min_age_days >= 30),
  CONSTRAINT ck_attachments_archives_retention CHECK (retention_years >= 1),
  CONSTRAINT fk_attachments_archives_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_attachments_archives_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE attachments_archive_volumes (
  id                    BINARY(16)    NOT NULL,
  archive_id            BINARY(16)    NOT NULL,
  seq                   INT           NOT NULL,
  category              VARCHAR(24)   NOT NULL,
  -- Premier jour du mois local des photos du volume.
  month_start           DATE          NOT NULL,
  part                  INT           NOT NULL DEFAULT 1,
  file_name             VARCHAR(160)  NOT NULL,
  file_count            INT           NOT NULL,
  files_bytes           BIGINT        NOT NULL,
  -- Longueur exacte du ZIP (en-tête Content-Length), calculée d'avance.
  zip_bytes             BIGINT        NOT NULL,
  -- Empreinte SHA-256 des octets envoyés à la dernière livraison complète (la même à chaque livraison tant que le serveur
  -- ne change pas de version : le volume est déterministe).
  zip_sha256            CHAR(64)      NULL,
  deliveries            INT           NOT NULL DEFAULT 0,
  aborted_deliveries    INT           NOT NULL DEFAULT 0,
  first_delivered_at    DATETIME(6)   NULL,
  last_delivered_at     DATETIME(6)   NULL,
  last_delivered_by     BINARY(16)    NULL,
  -- Fichier rangé par l'Admin dont l'empreinte a été comparée à `zip_sha256` (facultatif).
  verified_at           DATETIME(6)   NULL,
  verified_by           BINARY(16)    NULL,
  -- Toutes les photos du volume sont vidées ou libérées.
  resolved_at           DATETIME(6)   NULL,
  resolved_by           BINARY(16)    NULL,
  created_at            DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_attachments_archive_volumes_seq (archive_id, seq),
  UNIQUE KEY uq_attachments_archive_volumes_name (archive_id, file_name),
  CONSTRAINT ck_attachments_archive_volumes_category CHECK (
    category IN ('RECEPTION', 'MORTALITE', 'PERTE', 'DEPENSE', 'FACTURE_FOURNISSEUR')
  ),
  CONSTRAINT ck_attachments_archive_volumes_counts CHECK (
    seq >= 1 AND part >= 1 AND file_count > 0 AND files_bytes >= 0 AND zip_bytes > 0
    AND deliveries >= 0 AND aborted_deliveries >= 0
  ),
  CONSTRAINT fk_attachments_archive_volumes_archive FOREIGN KEY (archive_id) REFERENCES attachments_archives (id) ON DELETE RESTRICT,
  CONSTRAINT fk_attachments_archive_volumes_delivered_by FOREIGN KEY (last_delivered_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_attachments_archive_volumes_verified_by FOREIGN KEY (verified_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_attachments_archive_volumes_resolved_by FOREIGN KEY (resolved_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TABLE attachments_archive_items (
  archive_id            BINARY(16)    NOT NULL,
  attachment_id         BINARY(16)    NOT NULL,
  volume_id             BINARY(16)    NOT NULL,
  -- Chemin dans le ZIP : CATÉGORIE/AAAA-MM/NUMÉRO[_RÉFÉRENCE]_AAAAMMJJ-HHMMSS_ID.ext (ADR-070 §5).
  entry_path            VARCHAR(300)  NOT NULL,
  category              VARCHAR(24)   NOT NULL,
  owner_type            VARCHAR(40)   NOT NULL,
  owner_id              BINARY(16)    NOT NULL,
  -- Numéro du document dans le système, et références secondaires réduites séparées par une espace (pièce papier,
  -- bon de livraison ou numéro de facture du fournisseur).
  reference             VARCHAR(80)   NOT NULL,
  secondary_reference   VARCHAR(100)  NULL,
  kind                  VARCHAR(20)   NOT NULL,
  mime_type             VARCHAR(60)   NOT NULL,
  size_bytes            INT           NOT NULL,
  sha256                CHAR(64)      NOT NULL,
  captured_at           DATETIME(6)   NOT NULL,
  -- Soumission : réception de la pièce par le serveur (`received_at`, à défaut `created_at`).
  submitted_at          DATETIME(6)   NOT NULL,
  state                 VARCHAR(10)   NOT NULL DEFAULT 'PLANNED',
  resolved_at           DATETIME(6)   NULL,
  -- Motif d'une photo libérée : OPEN_OPERATION, CHANGED, ARCHIVE_CANCELLED.
  release_reason        VARCHAR(30)   NULL,
  -- Une pièce n'est couverte que par un élément prévu ou vidé à la fois ; libérée, elle peut être reprise (index unique partiel).
  held_attachment_id    BINARY(16)    GENERATED ALWAYS AS (
    CASE WHEN state IN ('PLANNED', 'PURGED') THEN attachment_id END
  ) STORED,
  created_at            DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (archive_id, attachment_id),
  UNIQUE KEY uq_attachments_archive_items_held (held_attachment_id),
  KEY ix_attachments_archive_items_volume (volume_id, state),
  KEY ix_attachments_archive_items_attachment (attachment_id),
  CONSTRAINT ck_attachments_archive_items_state CHECK (state IN ('PLANNED', 'PURGED', 'RELEASED')),
  CONSTRAINT ck_attachments_archive_items_category CHECK (
    category IN ('RECEPTION', 'MORTALITE', 'PERTE', 'DEPENSE', 'FACTURE_FOURNISSEUR')
  ),
  CONSTRAINT ck_attachments_archive_items_resolution CHECK (
    (state = 'PLANNED' AND resolved_at IS NULL AND release_reason IS NULL)
    OR (state = 'PURGED' AND resolved_at IS NOT NULL AND release_reason IS NULL)
    OR (state = 'RELEASED' AND resolved_at IS NOT NULL AND release_reason IS NOT NULL)
  ),
  CONSTRAINT ck_attachments_archive_items_size CHECK (size_bytes > 0),
  CONSTRAINT fk_attachments_archive_items_archive FOREIGN KEY (archive_id) REFERENCES attachments_archives (id) ON DELETE RESTRICT,
  CONSTRAINT fk_attachments_archive_items_attachment FOREIGN KEY (attachment_id) REFERENCES attachments_attachments (id) ON DELETE RESTRICT,
  CONSTRAINT fk_attachments_archive_items_volume FOREIGN KEY (volume_id) REFERENCES attachments_archive_volumes (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Plan : seuls le statut et ses dates évoluent, et un plan terminé ou annulé ne change plus.
CREATE TRIGGER trg_attachments_archives_update_guard BEFORE UPDATE ON attachments_archives FOR EACH ROW
BEGIN
  IF NOT (
    NEW.id <=> OLD.id AND
    NEW.granularity <=> OLD.granularity AND
    NEW.period_start <=> OLD.period_start AND
    NEW.period_end <=> OLD.period_end AND
    NEW.cutoff_at <=> OLD.cutoff_at AND
    NEW.min_age_days <=> OLD.min_age_days AND
    NEW.volume_max_bytes <=> OLD.volume_max_bytes AND
    NEW.retention_years <=> OLD.retention_years AND
    NEW.file_count <=> OLD.file_count AND
    NEW.files_bytes <=> OLD.files_bytes AND
    NEW.kept_open_count <=> OLD.kept_open_count AND
    NEW.absent_count <=> OLD.absent_count AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'attachments_archives : seuls le statut et ses dates sont modifiables.';
  END IF;
  IF OLD.status <> 'READY' AND NOT (NEW.status <=> OLD.status AND NEW.completed_at <=> OLD.completed_at AND NEW.cancelled_at <=> OLD.cancelled_at AND NEW.cancelled_by <=> OLD.cancelled_by) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'attachments_archives : un plan terminé ou annulé ne change plus.';
  END IF;
END;

CREATE TRIGGER trg_attachments_archives_no_delete BEFORE DELETE ON attachments_archives FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'attachments_archives : suppression physique interdite (INV-GLO-03).';
END;

-- Volume : la livraison, la vérification et la résolution évoluent (l'empreinte suit la dernière livraison complète).
CREATE TRIGGER trg_attachments_archive_volumes_update_guard BEFORE UPDATE ON attachments_archive_volumes FOR EACH ROW
BEGIN
  IF NOT (
    NEW.id <=> OLD.id AND
    NEW.archive_id <=> OLD.archive_id AND
    NEW.seq <=> OLD.seq AND
    NEW.category <=> OLD.category AND
    NEW.month_start <=> OLD.month_start AND
    NEW.part <=> OLD.part AND
    NEW.file_name <=> OLD.file_name AND
    NEW.file_count <=> OLD.file_count AND
    NEW.files_bytes <=> OLD.files_bytes AND
    NEW.zip_bytes <=> OLD.zip_bytes AND
    NEW.created_at <=> OLD.created_at
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'attachments_archive_volumes : seule la livraison est modifiable.';
  END IF;
END;

CREATE TRIGGER trg_attachments_archive_volumes_no_delete BEFORE DELETE ON attachments_archive_volumes FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'attachments_archive_volumes : suppression physique interdite (INV-GLO-03).';
END;

-- Élément : seule la résolution (prévu, vidé ou libéré) évolue, et une photo résolue ne change plus.
CREATE TRIGGER trg_attachments_archive_items_update_guard BEFORE UPDATE ON attachments_archive_items FOR EACH ROW
BEGIN
  IF NOT (
    NEW.archive_id <=> OLD.archive_id AND
    NEW.attachment_id <=> OLD.attachment_id AND
    NEW.volume_id <=> OLD.volume_id AND
    NEW.entry_path <=> OLD.entry_path AND
    NEW.category <=> OLD.category AND
    NEW.owner_type <=> OLD.owner_type AND
    NEW.owner_id <=> OLD.owner_id AND
    NEW.reference <=> OLD.reference AND
    NEW.secondary_reference <=> OLD.secondary_reference AND
    NEW.kind <=> OLD.kind AND
    NEW.mime_type <=> OLD.mime_type AND
    NEW.size_bytes <=> OLD.size_bytes AND
    NEW.sha256 <=> OLD.sha256 AND
    NEW.captured_at <=> OLD.captured_at AND
    NEW.submitted_at <=> OLD.submitted_at AND
    NEW.created_at <=> OLD.created_at
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'attachments_archive_items : seule la résolution est modifiable.';
  END IF;
  IF OLD.state <> 'PLANNED' AND NOT (NEW.state <=> OLD.state AND NEW.resolved_at <=> OLD.resolved_at AND NEW.release_reason <=> OLD.release_reason) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'attachments_archive_items : une photo résolue ne change plus.';
  END IF;
END;

CREATE TRIGGER trg_attachments_archive_items_no_delete BEFORE DELETE ON attachments_archive_items FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'attachments_archive_items : suppression physique interdite (INV-GLO-03).';
END;

GRANT SELECT, INSERT, UPDATE ON attachments_archives TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON attachments_archive_volumes TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON attachments_archive_items TO 'gic_app'@'%';

-- migrate:down transaction:false

DROP TABLE IF EXISTS attachments_archive_items;
DROP TABLE IF EXISTS attachments_archive_volumes;
DROP TABLE IF EXISTS attachments_archives;
