-- Espace de noms `approvals`. Source : docs/03-data/dictionnaire/10-approvals-
-- attachments-communication.md (sections approvals.control_policies,
-- approvals.approval_requests). N'inclut pas `communication.*` (hors périmètre P0-04,
-- docs/10-development-plan/06-passage-au-developpement.md §3).
--
-- migrate:up transaction:false

CREATE TABLE approvals_control_policies (
  id                    BINARY(16)     NOT NULL,
  code                  VARCHAR(40)    NOT NULL,
  version               INT            NOT NULL DEFAULT 1,
  operation_type        VARCHAR(30)    NOT NULL,
  -- `condition` est un mot réservé MySQL : quoté systématiquement.
  `condition`           JSON           NOT NULL DEFAULT (JSON_OBJECT()),
  requires_photo        BOOLEAN        NOT NULL DEFAULT FALSE,
  requires_comment      BOOLEAN        NOT NULL DEFAULT FALSE,
  requires_approval     BOOLEAN        NOT NULL DEFAULT FALSE,
  approver_permission   VARCHAR(80)    NULL,
  approver_scope        VARCHAR(10)    NULL,
  valid_from            DATETIME(6)    NOT NULL,
  valid_to              DATETIME(6)    NULL,
  status                VARCHAR(20)    NOT NULL DEFAULT 'ACTIVE',
  created_at            DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by            BINARY(16)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_approvals_control_policies_code_version (code, version),
  CONSTRAINT ck_approvals_control_policies_operation_type CHECK (operation_type IN (
    'LOSS_DECLARATION', 'MORTALITY', 'INVENTORY_ADJUSTMENT', 'TRANSFER_DISCREPANCY', 'EXPENSE',
    'PURCHASE_REQUEST', 'PURCHASE_ORDER', 'RECEIPT_WITHOUT_PO', 'RECEIPT_VALUE', 'SUPPLIER_PAYMENT',
    'PRICE_OVERRIDE', 'SALE_CANCELLATION', 'CREDIT_LIMIT_EXCEEDED', 'CASH_VARIANCE', 'CHECKIN_OVERRIDE'
  )),
  CONSTRAINT ck_approvals_control_policies_approver_scope CHECK (approver_scope IS NULL OR approver_scope IN ('SITE', 'ZONE', 'TEAM', 'ALL')),
  CONSTRAINT ck_approvals_control_policies_status CHECK (status IN ('ACTIVE', 'RETIRED')),
  CONSTRAINT ck_approvals_control_policies_requires_approval CHECK (requires_approval = FALSE OR approver_permission IS NOT NULL),
  CONSTRAINT fk_approvals_control_policies_permission FOREIGN KEY (approver_permission) REFERENCES identity_permissions (code) ON DELETE RESTRICT,
  CONSTRAINT fk_approvals_control_policies_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- VERSIONNEMENT (BR-ADM-016) : seul status (RETIRED) et valid_to changent après insertion.
CREATE TRIGGER trg_approvals_control_policies_update_guard BEFORE UPDATE ON approvals_control_policies FOR EACH ROW
BEGIN
  IF NOT (
    NEW.code <=> OLD.code AND
    NEW.version <=> OLD.version AND
    NEW.operation_type <=> OLD.operation_type AND
    NEW.`condition` <=> OLD.`condition` AND
    NEW.requires_photo <=> OLD.requires_photo AND
    NEW.requires_comment <=> OLD.requires_comment AND
    NEW.requires_approval <=> OLD.requires_approval AND
    NEW.approver_permission <=> OLD.approver_permission AND
    NEW.approver_scope <=> OLD.approver_scope AND
    NEW.valid_from <=> OLD.valid_from AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'approvals_control_policies : seuls status et valid_to sont modifiables (versionnement, BR-ADM-016).';
  END IF;
END;

CREATE TRIGGER trg_approvals_control_policies_no_delete BEFORE DELETE ON approvals_control_policies FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'approvals_control_policies : suppression physique interdite (versionnement, BR-ADM-016).';
END;

CREATE TABLE approvals_approval_requests (
  id                          BINARY(16)     NOT NULL,
  operation_type              VARCHAR(30)    NOT NULL,
  -- Sujet polymorphe (tout document) : pas de clé étrangère.
  subject_type                VARCHAR(40)    NOT NULL,
  subject_id                  BINARY(16)     NOT NULL,
  subject_summary             TEXT           NOT NULL,
  site_id                     BINARY(16)     NULL,
  zone_id                     BINARY(16)     NULL,
  amount_xaf                  BIGINT         NULL,
  requested_by                BINARY(16)     NOT NULL,
  requested_at                DATETIME(6)    NOT NULL,
  policy_id                   BINARY(16)     NULL,
  policy_version              INT            NULL,
  required_attachment_ids     JSON           NOT NULL DEFAULT (JSON_ARRAY()),
  status                      VARCHAR(20)    NOT NULL DEFAULT 'PENDING',
  decision_option             VARCHAR(40)    NULL,
  decided_by                  BINARY(16)     NULL,
  decided_at                  DATETIME(6)    NULL,
  decision_comment            TEXT           NULL,
  self_approved                BOOLEAN       NOT NULL DEFAULT FALSE,
  escalated_at                DATETIME(6)    NULL,
  created_at                  DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by                  BINARY(16)     NOT NULL,
  updated_at                  DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by                  BINARY(16)     NULL,
  version                     INT            NOT NULL DEFAULT 1,
  -- Une seule demande PENDING par (subject_type, subject_id, operation_type) : index
  -- unique partiel (MySQL, ADR-023).
  active_pending_key   VARCHAR(150) GENERATED ALWAYS AS (
    IF(status = 'PENDING', CONCAT(subject_type, ':', HEX(subject_id), ':', operation_type), NULL)
  ) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_approvals_approval_requests_active_pending (active_pending_key),
  KEY ix_approvals_approval_requests_status_site (status, site_id),
  KEY ix_approvals_approval_requests_status_operation (status, operation_type),
  KEY ix_approvals_approval_requests_requested_by (requested_by),
  CONSTRAINT ck_approvals_approval_requests_status CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  CONSTRAINT ck_approvals_approval_requests_amount CHECK (amount_xaf IS NULL OR amount_xaf >= 0),
  CONSTRAINT ck_approvals_approval_requests_decision CHECK (
    (status IN ('APPROVED', 'REJECTED') AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
    OR (status NOT IN ('APPROVED', 'REJECTED') AND decided_by IS NULL AND decided_at IS NULL)
  ),
  -- INV-ADM-02.
  CONSTRAINT ck_approvals_approval_requests_self_approval CHECK (decided_by IS NULL OR decided_by <> requested_by OR self_approved = TRUE),
  CONSTRAINT fk_approvals_approval_requests_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_approvals_approval_requests_zone FOREIGN KEY (zone_id) REFERENCES organization_zones (id) ON DELETE RESTRICT,
  CONSTRAINT fk_approvals_approval_requests_requested_by FOREIGN KEY (requested_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_approvals_approval_requests_policy FOREIGN KEY (policy_id) REFERENCES approvals_control_policies (id) ON DELETE RESTRICT,
  CONSTRAINT fk_approvals_approval_requests_decided_by FOREIGN KEY (decided_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_approvals_approval_requests_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_approvals_approval_requests_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- IMMUABLE après décision (SM-APPROVAL) : tant que PENDING, seule la décision (et son
-- escalade) peut changer ; une fois APPROVED/REJECTED/CANCELLED, plus aucune modification.
CREATE TRIGGER trg_approvals_approval_requests_update_guard BEFORE UPDATE ON approvals_approval_requests FOR EACH ROW
BEGIN
  IF OLD.status IN ('APPROVED', 'REJECTED', 'CANCELLED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'approvals_approval_requests : immuable après décision.';
  END IF;
  IF NOT (
    NEW.operation_type <=> OLD.operation_type AND
    NEW.subject_type <=> OLD.subject_type AND
    NEW.subject_id <=> OLD.subject_id AND
    NEW.subject_summary <=> OLD.subject_summary AND
    NEW.site_id <=> OLD.site_id AND
    NEW.zone_id <=> OLD.zone_id AND
    NEW.amount_xaf <=> OLD.amount_xaf AND
    NEW.requested_by <=> OLD.requested_by AND
    NEW.requested_at <=> OLD.requested_at AND
    NEW.policy_id <=> OLD.policy_id AND
    NEW.policy_version <=> OLD.policy_version AND
    NEW.required_attachment_ids <=> OLD.required_attachment_ids AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'approvals_approval_requests : seule la décision (et son escalade) est modifiable avant clôture.';
  END IF;
END;

CREATE TRIGGER trg_approvals_approval_requests_no_delete BEFORE DELETE ON approvals_approval_requests FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'approvals_approval_requests : suppression physique interdite (INV-GLO-03) ; utiliser CANCELLED.';
END;

GRANT SELECT, INSERT, UPDATE ON approvals_control_policies TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON approvals_approval_requests TO 'gic_app'@'%';

-- migrate:down transaction:false
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS approvals_approval_requests;
DROP TABLE IF EXISTS approvals_control_policies;
SET FOREIGN_KEY_CHECKS = 1;
