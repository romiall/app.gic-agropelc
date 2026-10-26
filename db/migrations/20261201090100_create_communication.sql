-- Module `communication` (P9-03) : règles d'alerte, alertes, destinataires, notifications, abonnements
-- Web Push, notes de direction, audiences et accusés.
-- Source : docs/03-data/dictionnaire/10-approvals-attachments-communication.md ; D13 ; SM-ALERT ;
-- BR-NOT-001 à 008 ; INV-NOT-01 ; ADR-061 à ADR-063 ; AV-350 à AV-370, AV-388 à AV-392.
--
-- Principes portés par le schéma :
-- - INV-NOT-01 : au plus une alerte ouverte par (type, sujet) — colonne générée `open_dedup_key` sous
--   index unique (MySQL n'a pas d'index partiel ; les valeurs NULL ne se heurtent pas) ;
-- - rien ne disparaît (ADR-006) : une alerte résolue ou écartée est immuable ; une note publiée est
--   immuable, audiences comprises ; la gravité d'une alerte ouverte ne baisse jamais (AV-351) ;
-- - la purge des alertes (2 ans après résolution) n'est possible que par le rôle de maintenance :
--   `gic_app` n'a pas `DELETE` sur les tables immuables (03-historisation-suppression.md §4) ;
-- - les états sont vérifiés par CHECK ; les déclencheurs ne sont qu'un filet (le code décide) ;
-- - aucune clé étrangère vers un site, une zone ou un propriétaire d'alerte : un événement qui cite un
--   objet inconnu ne doit pas être sauté, il est rejeté proprement par le consommateur.
-- migrate:up transaction:false

-- Règles d'alerte (BR-NOT-001) : activation, gravité, destinataires, résolution, escalade. Les seuils ne
-- sont pas ici : ce sont des paramètres `organization_system_settings` (AV-350).
CREATE TABLE communication_alert_rules (
  alert_type        VARCHAR(40)  NOT NULL,
  enabled           BOOLEAN      NOT NULL DEFAULT TRUE,
  severity          VARCHAR(10)  NOT NULL,
  recipient_roles   JSON         NOT NULL,
  resolution_mode   VARCHAR(10)  NOT NULL,
  escalation_hours  SMALLINT     NULL,
  escalation_roles  JSON         NOT NULL DEFAULT (JSON_ARRAY('DIRECTION')),
  created_at        DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at        DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by        BINARY(16)   NULL,
  version           INT          NOT NULL DEFAULT 1,
  PRIMARY KEY (alert_type),
  CONSTRAINT ck_communication_alert_rules_type CHECK (alert_type IN (
    'STOCK_LOW', 'STOCK_OUT', 'POS_REPLENISH', 'STOCK_NEGATIVE', 'HIGH_LOSS', 'HIGH_MORTALITY',
    'DAILY_ENTRY_MISSING', 'STANDARD_COST_MISSING', 'RECEIPT_INCOMPLETE', 'INVENTORY_VARIANCE',
    'OVERDUE_RECEIVABLE', 'CASH_VARIANCE', 'CASH_HOLDING_HIGH', 'CASH_SESSION_OPEN_LONG',
    'CASH_TRANSFER_NOT_RECEIVED', 'SYNC_ERROR', 'SYNC_STALE', 'DEVICE_SEQ_GAP', 'CLOCK_SKEW',
    'INACTIVE_COMMERCIAL', 'CHECKIN_SUSPICIOUS', 'PRICE_MISMATCH', 'DUPLICATE_SUSPECTED',
    'APPROVAL_PENDING_LONG', 'TRANSFER_NOT_RECEIVED', 'TRANSFER_UNMATCHED', 'LOT_EXPIRING',
    'ATTACHMENT_MISSING', 'KOMMO_SYNC_FAILED', 'AUDIT_CHAIN_BROKEN', 'ALLOCATION_EXPIRED',
    'ALLOCATION_REVOCATION_PENDING', 'SALE_UNDELIVERED', 'CONSUMER_FAILED', 'LEDGER_MISMATCH',
    'CASH_MISMATCH'
  )),
  CONSTRAINT ck_communication_alert_rules_severity CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  CONSTRAINT ck_communication_alert_rules_resolution CHECK (resolution_mode IN ('AUTO', 'MANUAL')),
  CONSTRAINT ck_communication_alert_rules_escalation CHECK (
    escalation_hours IS NULL OR escalation_hours BETWEEN 1 AND 168
  ),
  CONSTRAINT ck_communication_alert_rules_roles CHECK (
    JSON_TYPE(recipient_roles) = 'ARRAY' AND JSON_TYPE(escalation_roles) = 'ARRAY'
  ),
  CONSTRAINT fk_communication_alert_rules_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_communication_alert_rules_update_guard BEFORE UPDATE ON communication_alert_rules FOR EACH ROW
BEGIN
  IF NOT (NEW.alert_type <=> OLD.alert_type AND NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'communication_alert_rules : type d''alerte immuable.';
  END IF;
END;

CREATE TRIGGER trg_communication_alert_rules_no_delete BEFORE DELETE ON communication_alert_rules FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'communication_alert_rules : suppression interdite ; désactiver la règle.';
END;

-- Alertes (SM-ALERT ; BR-NOT-002 à 005 ; INV-NOT-01). Le message est le rendu neutre (sans valeur au
-- coût) ; les valeurs protégées restent des champs séparés de `payload` (ADR-061 §11, AV-390).
CREATE TABLE communication_alerts (
  id                 BINARY(16)    NOT NULL,
  alert_type         VARCHAR(40)   NOT NULL,
  nature             VARCHAR(5)    NOT NULL,
  severity           VARCHAR(10)   NOT NULL,
  status             VARCHAR(15)   NOT NULL DEFAULT 'OPEN',
  subject_type       VARCHAR(40)   NOT NULL,
  subject_id         BINARY(16)    NOT NULL,
  site_id            BINARY(16)    NULL,
  zone_id            BINARY(16)    NULL,
  owner_user_id      BINARY(16)    NULL,
  action_screen      VARCHAR(20)   NULL,
  title              VARCHAR(200)  NOT NULL,
  message            VARCHAR(1000) NOT NULL DEFAULT '',
  payload            JSON          NOT NULL,
  dedup_key          VARCHAR(200)  NOT NULL,
  -- INV-NOT-01 : `dedup_key` tant que l'alerte est ouverte, NULL ensuite (les NULL ne se heurtent pas).
  open_dedup_key     VARCHAR(200)  GENERATED ALWAYS AS (
    CASE WHEN status IN ('OPEN', 'ACKNOWLEDGED') THEN dedup_key ELSE NULL END
  ) STORED,
  occurrences        INT           NOT NULL DEFAULT 1,
  first_detected_at  DATETIME(6)   NOT NULL,
  last_detected_at   DATETIME(6)   NOT NULL,
  business_day       DATE          NULL,
  last_pass_id       VARCHAR(64)   NULL,
  critical_since     DATETIME(6)   NULL,
  escalated_at       DATETIME(6)   NULL,
  acknowledged_by    BINARY(16)    NULL,
  acknowledged_at    DATETIME(6)   NULL,
  resolved_by        BINARY(16)    NULL,
  resolved_at        DATETIME(6)   NULL,
  resolution_kind    VARCHAR(20)   NULL,
  resolution_comment VARCHAR(500)  NULL,
  created_at         DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at         DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  version            INT           NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_communication_alerts_open_dedup (open_dedup_key),
  KEY ix_communication_alerts_status (status, severity, first_detected_at),
  KEY ix_communication_alerts_site (site_id, status),
  KEY ix_communication_alerts_owner (owner_user_id, status),
  KEY ix_communication_alerts_type (alert_type, status),
  KEY ix_communication_alerts_subject (subject_type, subject_id),
  KEY ix_communication_alerts_escalation (status, severity, escalated_at, critical_since),
  CONSTRAINT ck_communication_alerts_nature CHECK (nature IN ('STATE', 'EVENT')),
  CONSTRAINT ck_communication_alerts_severity CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  CONSTRAINT ck_communication_alerts_status CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED')),
  CONSTRAINT ck_communication_alerts_occurrences CHECK (occurrences >= 1),
  -- Gravité critique ⇔ `critical_since` posé ; l'escalade suppose la gravité critique.
  CONSTRAINT ck_communication_alerts_critical CHECK ((severity = 'CRITICAL') = (critical_since IS NOT NULL)),
  CONSTRAINT ck_communication_alerts_escalated CHECK (escalated_at IS NULL OR critical_since IS NOT NULL),
  CONSTRAINT ck_communication_alerts_ack CHECK ((acknowledged_at IS NULL) = (acknowledged_by IS NULL)),
  -- Close ⇔ date de résolution ; un écart est une résolution de nature `DISMISSED`.
  CONSTRAINT ck_communication_alerts_closed CHECK (
    (status IN ('RESOLVED', 'DISMISSED')) = (resolved_at IS NOT NULL)
    AND (status IN ('RESOLVED', 'DISMISSED')) = (resolution_kind IS NOT NULL)
  ),
  CONSTRAINT ck_communication_alerts_kind CHECK (
    resolution_kind IS NULL OR resolution_kind IN ('CONDITION_CLEARED', 'PASS', 'MANUAL', 'DISMISSED')
  ),
  CONSTRAINT ck_communication_alerts_dismissed CHECK (
    resolution_kind IS NULL OR ((resolution_kind = 'DISMISSED') = (status = 'DISMISSED'))
  ),
  -- Une résolution ou un écart manuel a un auteur et un commentaire (SM-ALERT).
  CONSTRAINT ck_communication_alerts_manual CHECK (
    resolution_kind IS NULL OR resolution_kind NOT IN ('MANUAL', 'DISMISSED')
    OR (resolved_by IS NOT NULL AND resolution_comment IS NOT NULL)
  ),
  CONSTRAINT fk_communication_alerts_type FOREIGN KEY (alert_type) REFERENCES communication_alert_rules (alert_type) ON DELETE RESTRICT,
  CONSTRAINT fk_communication_alerts_acknowledged_by FOREIGN KEY (acknowledged_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_communication_alerts_resolved_by FOREIGN KEY (resolved_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_communication_alerts_update_guard BEFORE UPDATE ON communication_alerts FOR EACH ROW
BEGIN
  IF OLD.status IN ('RESOLVED', 'DISMISSED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'communication_alerts : alerte résolue ou écartée, immuable (ADR-006).';
  END IF;
  IF NOT (NEW.id <=> OLD.id AND NEW.alert_type <=> OLD.alert_type AND NEW.nature <=> OLD.nature
          AND NEW.subject_type <=> OLD.subject_type AND NEW.subject_id <=> OLD.subject_id
          AND NEW.dedup_key <=> OLD.dedup_key AND NEW.first_detected_at <=> OLD.first_detected_at
          AND NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'communication_alerts : identité de l''alerte immuable.';
  END IF;
  IF OLD.status = 'ACKNOWLEDGED' AND NEW.status = 'OPEN' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'communication_alerts : une alerte prise en compte ne redevient pas ouverte.';
  END IF;
  -- Une occurrence plus grave relève l'alerte, aucune ne l'abaisse (AV-351) ; le compteur ne recule pas.
  IF FIELD(NEW.severity, 'INFO', 'WARNING', 'CRITICAL') < FIELD(OLD.severity, 'INFO', 'WARNING', 'CRITICAL') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'communication_alerts : la gravité d''une alerte ouverte ne baisse pas.';
  END IF;
  IF NEW.occurrences < OLD.occurrences THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'communication_alerts : le compteur d''occurrences ne recule pas.';
  END IF;
  -- L'escalade et le point de départ de l'échéance ne s'effacent pas.
  IF OLD.escalated_at IS NOT NULL AND NOT (NEW.escalated_at <=> OLD.escalated_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'communication_alerts : escalade déjà posée.';
  END IF;
  IF OLD.critical_since IS NOT NULL AND NOT (NEW.critical_since <=> OLD.critical_since) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'communication_alerts : critical_since déjà posé.';
  END IF;
END;

-- Purge technique (ADR-068 §8) : seules les alertes résolues ou écartées depuis plus de deux ans, et
-- seulement par le rôle de maintenance (`gic_app` n'a pas DELETE).
CREATE TRIGGER trg_communication_alerts_purge_guard BEFORE DELETE ON communication_alerts FOR EACH ROW
BEGIN
  IF NOT (OLD.status IN ('RESOLVED', 'DISMISSED')
          AND OLD.resolved_at < DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 730 DAY)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'communication_alerts : seules les alertes closes depuis plus de 2 ans se purgent.';
  END IF;
END;

-- Destinataires explicites d'une alerte (ADR-062 §1) : sa boîte. Ajout seul ; supprimés avec l'alerte.
CREATE TABLE communication_alert_recipients (
  alert_id   BINARY(16)   NOT NULL,
  user_id    BINARY(16)   NOT NULL,
  origin     VARCHAR(15)  NOT NULL,
  role_code  VARCHAR(40)  NULL,
  added_at   DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (alert_id, user_id),
  KEY ix_communication_alert_recipients_user (user_id, alert_id),
  CONSTRAINT ck_communication_alert_recipients_origin CHECK (origin IN (
    'RULE', 'OWNER', 'TEAM_MANAGER', 'APPROVER', 'ESCALATION', 'FALLBACK'
  )),
  CONSTRAINT fk_communication_alert_recipients_alert FOREIGN KEY (alert_id) REFERENCES communication_alerts (id) ON DELETE CASCADE,
  CONSTRAINT fk_communication_alert_recipients_user FOREIGN KEY (user_id) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_communication_alert_recipients_update_guard BEFORE UPDATE ON communication_alert_recipients FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'communication_alert_recipients : ajout seul.';
END;

CREATE TRIGGER trg_communication_alert_recipients_no_delete BEFORE DELETE ON communication_alert_recipients FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'communication_alert_recipients : suppression directe interdite (suit l''alerte).';
END;

-- Notes de direction (BR-NOT-006, 007 ; ADR-063) : brouillon modifiable, puis publiée et immuable,
-- puis archivée. Aucune suppression physique (table de transaction, INV-GLO-03).
CREATE TABLE communication_internal_notes (
  id                   BINARY(16)    NOT NULL,
  title                VARCHAR(160)  NOT NULL,
  body                 TEXT          NOT NULL,
  category             VARCHAR(15)   NOT NULL,
  related_entity_type  VARCHAR(40)   NULL,
  related_entity_id    BINARY(16)    NULL,
  requires_ack         BOOLEAN       NOT NULL DEFAULT FALSE,
  status               VARCHAR(10)   NOT NULL DEFAULT 'DRAFT',
  published_at         DATETIME(6)   NULL,
  expires_at           DATETIME(6)   NULL,
  archived_at          DATETIME(6)   NULL,
  archive_reason       VARCHAR(500)  NULL,
  command_id           BINARY(16)    NULL,
  created_at           DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by           BINARY(16)    NOT NULL,
  updated_at           DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by           BINARY(16)    NULL,
  version              INT           NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_communication_internal_notes_command (command_id),
  KEY ix_communication_internal_notes_status (status, published_at),
  CONSTRAINT ck_communication_internal_notes_status CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  CONSTRAINT ck_communication_internal_notes_category CHECK (category IN ('PRIX', 'INSTRUCTION', 'PROCEDURE', 'INFORMATION')),
  CONSTRAINT ck_communication_internal_notes_related CHECK ((related_entity_type IS NULL) = (related_entity_id IS NULL)),
  CONSTRAINT ck_communication_internal_notes_published CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL),
  CONSTRAINT ck_communication_internal_notes_expiry CHECK (
    expires_at IS NULL OR published_at IS NULL OR expires_at > published_at
  ),
  CONSTRAINT ck_communication_internal_notes_archived CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL)),
  CONSTRAINT fk_communication_internal_notes_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_communication_internal_notes_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_communication_internal_notes_update_guard BEFORE UPDATE ON communication_internal_notes FOR EACH ROW
BEGIN
  IF NOT (NEW.id <=> OLD.id AND NEW.created_at <=> OLD.created_at AND NEW.created_by <=> OLD.created_by) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'communication_internal_notes : identité de la note immuable.';
  END IF;
  IF OLD.status = 'ARCHIVED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'communication_internal_notes : note archivée, immuable.';
  END IF;
  IF OLD.status = 'PUBLISHED' THEN
    IF NOT (NEW.title <=> OLD.title AND NEW.body <=> OLD.body AND NEW.category <=> OLD.category
            AND NEW.related_entity_type <=> OLD.related_entity_type AND NEW.related_entity_id <=> OLD.related_entity_id
            AND NEW.requires_ack <=> OLD.requires_ack AND NEW.published_at <=> OLD.published_at
            AND NEW.expires_at <=> OLD.expires_at) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'communication_internal_notes : note publiée, immuable (BR-NOT-006) ; publier une note corrective.';
    END IF;
    IF NEW.status NOT IN ('PUBLISHED', 'ARCHIVED') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'communication_internal_notes : une note publiée ne revient pas au brouillon.';
    END IF;
  END IF;
END;

CREATE TRIGGER trg_communication_internal_notes_no_delete BEFORE DELETE ON communication_internal_notes FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'communication_internal_notes : suppression interdite ; archiver la note.';
END;

-- Audience d'une note : `audience_ref` vaut '*' pour `ALL` (une clé primaire n'admet pas de NULL).
-- Modifiable tant que la note est un brouillon, figée ensuite (déclencheurs).
CREATE TABLE communication_note_audiences (
  note_id        BINARY(16)   NOT NULL,
  audience_type  VARCHAR(10)  NOT NULL,
  audience_ref   VARCHAR(80)  NOT NULL DEFAULT '*',
  PRIMARY KEY (note_id, audience_type, audience_ref),
  CONSTRAINT ck_communication_note_audiences_type CHECK (audience_type IN ('ALL', 'ROLE', 'SITE', 'ZONE', 'USER')),
  CONSTRAINT ck_communication_note_audiences_ref CHECK ((audience_type = 'ALL') = (audience_ref = '*')),
  CONSTRAINT fk_communication_note_audiences_note FOREIGN KEY (note_id) REFERENCES communication_internal_notes (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_communication_note_audiences_insert_guard BEFORE INSERT ON communication_note_audiences FOR EACH ROW
BEGIN
  IF (SELECT status FROM communication_internal_notes WHERE id = NEW.note_id) <> 'DRAFT' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'communication_note_audiences : audience figée dès la publication de la note.';
  END IF;
END;

CREATE TRIGGER trg_communication_note_audiences_update_guard BEFORE UPDATE ON communication_note_audiences FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'communication_note_audiences : modification interdite ; retirer puis ajouter la ligne d''un brouillon.';
END;

CREATE TRIGGER trg_communication_note_audiences_delete_guard BEFORE DELETE ON communication_note_audiences FOR EACH ROW
BEGIN
  IF (SELECT status FROM communication_internal_notes WHERE id = OLD.note_id) <> 'DRAFT' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'communication_note_audiences : audience figée dès la publication de la note.';
  END IF;
END;

-- Lecture et accusé de réception d'une note (UC-NOT-06) : la lecture crée la ligne, l'accusé la complète
-- une seule fois.
CREATE TABLE communication_note_acknowledgements (
  note_id          BINARY(16)   NOT NULL,
  user_id          BINARY(16)   NOT NULL,
  read_at          DATETIME(6)  NOT NULL,
  acknowledged_at  DATETIME(6)  NULL,
  command_id       BINARY(16)   NULL,
  PRIMARY KEY (note_id, user_id),
  KEY ix_communication_note_acknowledgements_user (user_id, acknowledged_at),
  CONSTRAINT fk_communication_note_acknowledgements_note FOREIGN KEY (note_id) REFERENCES communication_internal_notes (id) ON DELETE RESTRICT,
  CONSTRAINT fk_communication_note_acknowledgements_user FOREIGN KEY (user_id) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_communication_note_acknowledgements_update_guard BEFORE UPDATE ON communication_note_acknowledgements FOR EACH ROW
BEGIN
  IF NOT (NEW.note_id <=> OLD.note_id AND NEW.user_id <=> OLD.user_id AND NEW.read_at <=> OLD.read_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'communication_note_acknowledgements : lecture immuable.';
  END IF;
  IF OLD.acknowledged_at IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'communication_note_acknowledgements : accusé déjà enregistré, immuable.';
  END IF;
END;

CREATE TRIGGER trg_communication_note_acknowledgements_no_delete BEFORE DELETE ON communication_note_acknowledgements FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'communication_note_acknowledgements : suppression interdite.';
END;

-- Notifications par utilisateur (BR-NOT-004 ; ADR-062 §4) : une ligne par destinataire et par canal.
-- Purge technique 90 jours après lecture (ADR-068 §8) : `gic_app` peut supprimer. Idempotence d'un
-- consommateur rejoué : unicité (utilisateur, canal, événement source).
CREATE TABLE communication_notifications (
  id               BINARY(16)    NOT NULL,
  user_id          BINARY(16)    NOT NULL,
  channel          VARCHAR(10)   NOT NULL,
  kind             VARCHAR(10)   NOT NULL,
  alert_id         BINARY(16)    NULL,
  alert_type       VARCHAR(40)   NULL,
  note_id          BINARY(16)    NULL,
  source_type      VARCHAR(40)   NULL,
  source_id        BINARY(16)    NULL,
  source_event_id  BINARY(16)    NULL,
  title            VARCHAR(200)  NOT NULL,
  body             VARCHAR(1000) NOT NULL DEFAULT '',
  link             VARCHAR(200)  NULL,
  created_at       DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  delivered_at     DATETIME(6)   NULL,
  read_at          DATETIME(6)   NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_communication_notifications_event (user_id, channel, source_event_id),
  KEY ix_communication_notifications_user (user_id, read_at, created_at),
  KEY ix_communication_notifications_alert (alert_id),
  KEY ix_communication_notifications_push (user_id, alert_type, channel, created_at),
  CONSTRAINT ck_communication_notifications_channel CHECK (channel IN ('IN_APP', 'WEB_PUSH')),
  CONSTRAINT ck_communication_notifications_kind CHECK (kind IN ('ALERT', 'NOTE', 'DIRECT', 'EXPORT')),
  CONSTRAINT ck_communication_notifications_alert CHECK (kind <> 'ALERT' OR alert_type IS NOT NULL),
  CONSTRAINT ck_communication_notifications_note CHECK (kind <> 'NOTE' OR note_id IS NOT NULL),
  CONSTRAINT fk_communication_notifications_user FOREIGN KEY (user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_communication_notifications_alert FOREIGN KEY (alert_id) REFERENCES communication_alerts (id) ON DELETE SET NULL,
  CONSTRAINT fk_communication_notifications_note FOREIGN KEY (note_id) REFERENCES communication_internal_notes (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_communication_notifications_update_guard BEFORE UPDATE ON communication_notifications FOR EACH ROW
BEGIN
  IF NOT (NEW.id <=> OLD.id AND NEW.user_id <=> OLD.user_id AND NEW.channel <=> OLD.channel AND NEW.kind <=> OLD.kind
          AND NEW.alert_id <=> OLD.alert_id AND NEW.alert_type <=> OLD.alert_type AND NEW.note_id <=> OLD.note_id
          AND NEW.source_type <=> OLD.source_type AND NEW.source_id <=> OLD.source_id
          AND NEW.source_event_id <=> OLD.source_event_id AND NEW.title <=> OLD.title AND NEW.body <=> OLD.body
          AND NEW.link <=> OLD.link AND NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'communication_notifications : seules la livraison et la lecture évoluent.';
  END IF;
  IF OLD.read_at IS NOT NULL AND NOT (NEW.read_at <=> OLD.read_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'communication_notifications : date de lecture déjà posée.';
  END IF;
END;

-- Abonnements Web Push par appareil (UC-NOT-07) ; un point de terminaison révoqué (ou répondant 410)
-- est purgé.
CREATE TABLE communication_push_subscriptions (
  id          BINARY(16)    NOT NULL,
  user_id     BINARY(16)    NOT NULL,
  device_id   BINARY(16)    NOT NULL,
  endpoint    VARCHAR(500)  NOT NULL,
  p256dh      VARCHAR(200)  NOT NULL,
  auth        VARCHAR(100)  NOT NULL,
  created_at  DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  revoked_at  DATETIME(6)   NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_communication_push_subscriptions_endpoint (endpoint),
  KEY ix_communication_push_subscriptions_user (user_id, revoked_at),
  CONSTRAINT fk_communication_push_subscriptions_user FOREIGN KEY (user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_communication_push_subscriptions_device FOREIGN KEY (device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_communication_push_subscriptions_update_guard BEFORE UPDATE ON communication_push_subscriptions FOR EACH ROW
BEGIN
  IF NOT (NEW.id <=> OLD.id AND NEW.user_id <=> OLD.user_id AND NEW.device_id <=> OLD.device_id
          AND NEW.endpoint <=> OLD.endpoint AND NEW.p256dh <=> OLD.p256dh AND NEW.auth <=> OLD.auth
          AND NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'communication_push_subscriptions : seule la révocation évolue.';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NOT (NEW.revoked_at <=> OLD.revoked_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'communication_push_subscriptions : révocation déjà posée.';
  END IF;
END;

GRANT SELECT, INSERT, UPDATE ON communication_alert_rules TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON communication_alerts TO 'gic_app'@'%';
GRANT SELECT, INSERT ON communication_alert_recipients TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON communication_internal_notes TO 'gic_app'@'%';
GRANT SELECT, INSERT, DELETE ON communication_note_audiences TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON communication_note_acknowledgements TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON communication_notifications TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON communication_push_subscriptions TO 'gic_app'@'%';

-- migrate:down transaction:false
-- Défait les tables dans l'ordre inverse des dépendances.
DROP TABLE IF EXISTS communication_push_subscriptions;
DROP TABLE IF EXISTS communication_notifications;
DROP TABLE IF EXISTS communication_note_acknowledgements;
DROP TABLE IF EXISTS communication_note_audiences;
DROP TABLE IF EXISTS communication_internal_notes;
DROP TABLE IF EXISTS communication_alert_recipients;
DROP TABLE IF EXISTS communication_alerts;
DROP TABLE IF EXISTS communication_alert_rules;
