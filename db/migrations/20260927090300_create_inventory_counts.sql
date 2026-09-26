-- Espace de noms `inventory`, inventaires (P2-02). Source : docs/03-data/dictionnaire/
-- 06-inventory.md §inventory_counts/inventory_count_lines ; SM-INVENTORY-COUNT.
--
-- migrate:up transaction:false

CREATE TABLE inventory_inventory_counts (
  id                                    BINARY(16)     NOT NULL,
  doc_number                           VARCHAR(40)    NOT NULL,
  local_ref                            VARCHAR(20)    NULL,
  site_id                               BINARY(16)     NOT NULL,
  location_id                          BINARY(16)     NOT NULL,
  count_type                          VARCHAR(10)    NOT NULL,
  status                               VARCHAR(20)    NOT NULL,
  opened_by                            BINARY(16)     NULL,
  submitted_by                        BINARY(16)     NULL,
  submitted_at                        DATETIME(6)    NULL,
  variance_value_xaf                  BIGINT         NULL,
  abs_variance_value_xaf              BIGINT         NULL,
  net_variance_after_reconciliation_xaf BIGINT       NULL,
  approval_request_id                 BINARY(16)     NULL,
  posted_at                           DATETIME(6)    NULL,
  occurred_at                         DATETIME(6)    NOT NULL,
  client_created_at                   DATETIME(6)    NULL,
  received_at_server                  DATETIME(6)    NULL,
  command_id                          BINARY(16)     NULL,
  created_device_id                   BINARY(16)     NULL,
  captured_offline                    BOOLEAN        NOT NULL DEFAULT FALSE,
  clock_suspect                       BOOLEAN        NOT NULL DEFAULT FALSE,
  backdated_reason                    TEXT           NULL,
  created_at                          DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by                          BINARY(16)     NOT NULL,
  updated_at                          DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by                          BINARY(16)     NULL,
  version                              INT            NOT NULL DEFAULT 1,
  -- Un seul inventaire IN_PROGRESS par emplacement ; un seul OPENING POSTED par emplacement
  -- (dictionnaire) : colonnes générées NULL hors condition + UNIQUE (convention §4).
  in_progress_key  BINARY(16) GENERATED ALWAYS AS (IF(status = 'IN_PROGRESS', location_id, NULL)) STORED,
  opening_posted_key BINARY(16) GENERATED ALWAYS AS (IF(count_type = 'OPENING' AND status = 'POSTED', location_id, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inventory_inventory_counts_doc_number (doc_number),
  UNIQUE KEY uq_inventory_inventory_counts_command (command_id),
  UNIQUE KEY uq_inventory_inventory_counts_device_ref (created_device_id, local_ref),
  UNIQUE KEY uq_inventory_inventory_counts_in_progress (in_progress_key),
  UNIQUE KEY uq_inventory_inventory_counts_opening_posted (opening_posted_key),
  CONSTRAINT ck_inventory_inventory_counts_type CHECK (count_type IN ('FULL', 'PARTIAL', 'SPOT', 'OPENING')),
  CONSTRAINT ck_inventory_inventory_counts_status CHECK (status IN (
    'IN_PROGRESS', 'SUBMITTED', 'PENDING_APPROVAL', 'POSTED', 'REJECTED', 'CANCELLED'
  )),
  CONSTRAINT fk_inventory_inventory_counts_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_inventory_counts_location FOREIGN KEY (location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_inventory_counts_opened_by FOREIGN KEY (opened_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_inventory_counts_submitted_by FOREIGN KEY (submitted_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_inventory_counts_approval FOREIGN KEY (approval_request_id) REFERENCES approvals_approval_requests (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_inventory_counts_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_inventory_counts_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_inventory_counts_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_inventory_inventory_counts_no_delete BEFORE DELETE ON inventory_inventory_counts FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_inventory_counts : suppression physique interdite (INV-GLO-03) ; utiliser CANCELLED/REJECTED.';
END;

CREATE TABLE inventory_inventory_count_lines (
  id                            BINARY(16)     NOT NULL,
  count_id                      BINARY(16)     NOT NULL,
  product_id                    BINARY(16)     NOT NULL,
  lot_id                        BINARY(16)     NULL,
  lot_key                       BINARY(16)     GENERATED ALWAYS AS (COALESCE(lot_id, 0x00000000000000000000000000000000)) STORED,
  counted_at                    DATETIME(6)    NOT NULL,
  counted_qty_base              DECIMAL(14,3)  NOT NULL,
  theoretical_qty_base          DECIMAL(14,3)  NULL,
  variance_qty_base             DECIMAL(14,3)  NULL,
  reconciled_adjustment_qty_base DECIMAL(14,3) NOT NULL DEFAULT 0,
  unit_cost_xaf                 BIGINT         NULL,
  variance_reason_code_id       BINARY(16)     NULL,
  declared_unit_cost_xaf        BIGINT         NULL,
  comment                       TEXT           NULL,
  command_id                    BINARY(16)     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inventory_inventory_count_lines_product_lot (count_id, product_id, lot_key),
  CONSTRAINT ck_inventory_inventory_count_lines_counted CHECK (counted_qty_base >= 0),
  CONSTRAINT fk_inventory_inventory_count_lines_count FOREIGN KEY (count_id) REFERENCES inventory_inventory_counts (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_inventory_count_lines_product FOREIGN KEY (product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_inventory_count_lines_lot FOREIGN KEY (lot_id) REFERENCES inventory_stock_lots (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_inventory_count_lines_reason FOREIGN KEY (variance_reason_code_id) REFERENCES catalog_reason_codes (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Suppr. suit l'inventaire (dictionnaire) : pas de suppression indépendante d'une ligne.
CREATE TRIGGER trg_inventory_inventory_count_lines_no_delete BEFORE DELETE ON inventory_inventory_count_lines FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_inventory_count_lines : suit l''inventaire, jamais supprimée indépendamment.';
END;

-- Droits par table (INV-GLO-05).
GRANT SELECT, INSERT, UPDATE ON inventory_inventory_counts TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON inventory_inventory_count_lines TO 'gic_app'@'%';

-- migrate:down transaction:false
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS inventory_inventory_count_lines;
DROP TABLE IF EXISTS inventory_inventory_counts;
SET FOREIGN_KEY_CHECKS = 1;
