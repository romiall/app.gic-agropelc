-- Espace de noms `inventory`, pertes et consommations (P2-02). Source : docs/03-data/
-- dictionnaire/06-inventory.md §loss_declarations/consumptions ; SM-LOSS.
--
-- migrate:up transaction:false

CREATE TABLE inventory_loss_declarations (
  id                      BINARY(16)     NOT NULL,
  doc_number              VARCHAR(40)    NOT NULL,
  local_ref               VARCHAR(20)    NULL,
  site_id                 BINARY(16)     NOT NULL,
  location_id             BINARY(16)     NOT NULL,
  product_id              BINARY(16)     NOT NULL,
  lot_id                  BINARY(16)     NULL,
  production_lot_id       BINARY(16)     NULL,
  quantity_base           DECIMAL(14,3)  NOT NULL,
  unit_code               VARCHAR(20)    NOT NULL,
  quantity                DECIMAL(14,3)  NOT NULL,
  category                VARCHAR(20)    NOT NULL,
  reason_code_id          BINARY(16)     NULL,
  comment                 TEXT           NULL,
  declared_by             BINARY(16)     NOT NULL,
  policy_id               BINARY(16)     NULL,
  policy_version          INT            NULL,
  requires_photo          BOOLEAN        NOT NULL DEFAULT FALSE,
  requires_approval       BOOLEAN        NOT NULL DEFAULT FALSE,
  status                  VARCHAR(25)    NOT NULL,
  approval_request_id     BINARY(16)     NULL,
  unit_cost_xaf           BIGINT         NOT NULL,
  value_xaf               BIGINT         NOT NULL,
  responsibility_user_id  BINARY(16)     NULL,
  cancelled_at            DATETIME(6)    NULL,
  cancelled_by            BINARY(16)     NULL,
  cancel_reason_code_id   BINARY(16)     NULL,
  cancel_comment          TEXT           NULL,
  cancel_approval_request_id BINARY(16)  NULL,
  occurred_at             DATETIME(6)    NOT NULL,
  business_date           DATE           GENERATED ALWAYS AS (DATE(CONVERT_TZ(occurred_at, '+00:00', '+01:00'))) STORED,
  client_created_at       DATETIME(6)    NULL,
  received_at_server      DATETIME(6)    NULL,
  command_id              BINARY(16)     NULL,
  created_device_id       BINARY(16)     NULL,
  captured_offline        BOOLEAN        NOT NULL DEFAULT FALSE,
  clock_suspect           BOOLEAN        NOT NULL DEFAULT FALSE,
  backdated_reason        TEXT           NULL,
  created_at              DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by              BINARY(16)     NOT NULL,
  updated_at              DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by              BINARY(16)     NULL,
  version                 INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inventory_loss_declarations_doc_number (doc_number),
  UNIQUE KEY uq_inventory_loss_declarations_command (command_id),
  UNIQUE KEY uq_inventory_loss_declarations_device_ref (created_device_id, local_ref),
  KEY ix_inventory_loss_declarations_location (location_id, occurred_at),
  KEY ix_inventory_loss_declarations_production_lot (production_lot_id, occurred_at),
  KEY ix_inventory_loss_declarations_category (category, business_date),
  KEY ix_inventory_loss_declarations_status (status),
  CONSTRAINT ck_inventory_loss_declarations_qty CHECK (quantity_base > 0 AND quantity > 0),
  CONSTRAINT ck_inventory_loss_declarations_category CHECK (category IN (
    'MORTALITE', 'CASSE', 'DETERIORATION', 'IMPROPRE', 'DESTRUCTION', 'INEXPLIQUEE', 'VOL_SUSPECTE', 'ECART_TRANSFERT'
  )),
  CONSTRAINT ck_inventory_loss_declarations_comment CHECK (
    category NOT IN ('INEXPLIQUEE', 'VOL_SUSPECTE') OR (comment IS NOT NULL AND comment <> '')
  ),
  CONSTRAINT ck_inventory_loss_declarations_mortality CHECK (category <> 'MORTALITE' OR production_lot_id IS NOT NULL),
  CONSTRAINT ck_inventory_loss_declarations_status CHECK (status IN (
    'RECORDED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED_RETURNED', 'REJECTED_UNJUSTIFIED', 'CANCELLATION_PENDING', 'CANCELLED'
  )),
  CONSTRAINT fk_inventory_loss_declarations_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_loss_declarations_location FOREIGN KEY (location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_loss_declarations_product FOREIGN KEY (product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_loss_declarations_lot FOREIGN KEY (lot_id) REFERENCES inventory_stock_lots (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_loss_declarations_unit FOREIGN KEY (unit_code) REFERENCES catalog_units (code) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_loss_declarations_reason FOREIGN KEY (reason_code_id) REFERENCES catalog_reason_codes (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_loss_declarations_declared_by FOREIGN KEY (declared_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_loss_declarations_policy FOREIGN KEY (policy_id) REFERENCES approvals_control_policies (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_loss_declarations_approval FOREIGN KEY (approval_request_id) REFERENCES approvals_approval_requests (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_loss_declarations_responsibility FOREIGN KEY (responsibility_user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_loss_declarations_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_loss_declarations_cancel_reason FOREIGN KEY (cancel_reason_code_id) REFERENCES catalog_reason_codes (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_loss_declarations_cancel_approval FOREIGN KEY (cancel_approval_request_id) REFERENCES approvals_approval_requests (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_loss_declarations_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_loss_declarations_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_loss_declarations_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_inventory_loss_declarations_no_delete BEFORE DELETE ON inventory_loss_declarations FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_loss_declarations : suppression physique interdite (INV-GLO-03) ; utiliser CANCELLED.';
END;

CREATE TABLE inventory_consumptions (
  id                  BINARY(16)     NOT NULL,
  location_id         BINARY(16)     NOT NULL,
  product_id          BINARY(16)     NOT NULL,
  lot_id              BINARY(16)     NULL,
  quantity_base       DECIMAL(14,3)  NOT NULL,
  unit_code           VARCHAR(20)    NOT NULL,
  quantity            DECIMAL(14,3)  NOT NULL,
  cost_object_type    VARCHAR(20)    NOT NULL,
  cost_object_id      BINARY(16)     NOT NULL,
  recorded_by         BINARY(16)     NOT NULL,
  value_xaf           BIGINT         NOT NULL,
  status              VARCHAR(10)    NOT NULL DEFAULT 'RECORDED',
  cancelled_at        DATETIME(6)    NULL,
  cancelled_by        BINARY(16)     NULL,
  cancel_reason_code_id BINARY(16)   NULL,
  cancel_comment      TEXT           NULL,
  cancel_approval_request_id BINARY(16) NULL,
  occurred_at         DATETIME(6)    NOT NULL,
  client_created_at   DATETIME(6)    NULL,
  received_at_server  DATETIME(6)    NULL,
  command_id          BINARY(16)     NULL,
  created_device_id   BINARY(16)     NULL,
  captured_offline    BOOLEAN        NOT NULL DEFAULT FALSE,
  clock_suspect       BOOLEAN        NOT NULL DEFAULT FALSE,
  backdated_reason    TEXT           NULL,
  created_at          DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by          BINARY(16)     NOT NULL,
  updated_at          DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by          BINARY(16)     NULL,
  version             INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inventory_consumptions_command (command_id),
  KEY ix_inventory_consumptions_cost_object (cost_object_type, cost_object_id, occurred_at),
  CONSTRAINT ck_inventory_consumptions_qty CHECK (quantity_base > 0 AND quantity > 0),
  CONSTRAINT ck_inventory_consumptions_cost_object CHECK (cost_object_type IN ('PRODUCTION_LOT', 'INCUBATION_BATCH', 'SITE')),
  CONSTRAINT ck_inventory_consumptions_status CHECK (status IN ('RECORDED', 'CANCELLED')),
  CONSTRAINT fk_inventory_consumptions_location FOREIGN KEY (location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_consumptions_product FOREIGN KEY (product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_consumptions_lot FOREIGN KEY (lot_id) REFERENCES inventory_stock_lots (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_consumptions_unit FOREIGN KEY (unit_code) REFERENCES catalog_units (code) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_consumptions_recorded_by FOREIGN KEY (recorded_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_consumptions_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_consumptions_cancel_reason FOREIGN KEY (cancel_reason_code_id) REFERENCES catalog_reason_codes (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_consumptions_cancel_approval FOREIGN KEY (cancel_approval_request_id) REFERENCES approvals_approval_requests (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_consumptions_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_consumptions_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_consumptions_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_inventory_consumptions_no_delete BEFORE DELETE ON inventory_consumptions FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_consumptions : suppression physique interdite (INV-GLO-03) ; utiliser CANCELLED.';
END;

-- Droits par table (INV-GLO-05).
GRANT SELECT, INSERT, UPDATE ON inventory_loss_declarations TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON inventory_consumptions TO 'gic_app'@'%';

-- migrate:down transaction:false
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS inventory_consumptions;
DROP TABLE IF EXISTS inventory_loss_declarations;
SET FOREIGN_KEY_CHECKS = 1;
