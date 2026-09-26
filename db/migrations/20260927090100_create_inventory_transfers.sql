-- Espace de noms `inventory`, transferts (P2-02). Source : docs/03-data/dictionnaire/
-- 06-inventory.md §stock_transfers/stock_transfer_lines ; SM-TRANSFER.
--
-- migrate:up transaction:false

CREATE TABLE inventory_stock_transfers (
  id                     BINARY(16)     NOT NULL,
  doc_number             VARCHAR(40)    NOT NULL,
  local_ref              VARCHAR(20)    NULL,
  site_id                BINARY(16)     NOT NULL,
  transfer_kind          VARCHAR(10)    NOT NULL DEFAULT 'STANDARD',
  from_location_id       BINARY(16)     NOT NULL,
  to_location_id         BINARY(16)     NOT NULL,
  status                 VARCHAR(20)    NOT NULL,
  requested_by           BINARY(16)     NULL,
  requested_at           DATETIME(6)    NULL,
  dispatched_by          BINARY(16)     NULL,
  dispatched_at          DATETIME(6)    NULL,
  carrier_user_id        BINARY(16)     NULL,
  carrier_name           VARCHAR(200)   NULL,
  received_by            BINARY(16)     NULL,
  received_at            DATETIME(6)    NULL,
  matched_transfer_id    BINARY(16)     NULL,
  sales_order_id         BINARY(16)     NULL,
  approval_request_id    BINARY(16)     NULL,
  notes                  TEXT           NULL,
  occurred_at            DATETIME(6)    NOT NULL,
  client_created_at      DATETIME(6)    NULL,
  received_at_server     DATETIME(6)    NULL,
  command_id             BINARY(16)     NULL,
  created_device_id      BINARY(16)     NULL,
  captured_offline       BOOLEAN        NOT NULL DEFAULT FALSE,
  clock_suspect          BOOLEAN        NOT NULL DEFAULT FALSE,
  backdated_reason       TEXT           NULL,
  created_at             DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by             BINARY(16)     NOT NULL,
  updated_at             DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by             BINARY(16)     NULL,
  version                INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inventory_stock_transfers_doc_number (doc_number),
  UNIQUE KEY uq_inventory_stock_transfers_command (command_id),
  UNIQUE KEY uq_inventory_stock_transfers_device_ref (created_device_id, local_ref),
  KEY ix_inventory_stock_transfers_to_status (to_location_id, status),
  KEY ix_inventory_stock_transfers_from_status (from_location_id, status),
  KEY ix_inventory_stock_transfers_dispatched (dispatched_at),
  CONSTRAINT ck_inventory_stock_transfers_locations CHECK (from_location_id <> to_location_id),
  CONSTRAINT ck_inventory_stock_transfers_kind CHECK (transfer_kind IN ('STANDARD', 'INTERNAL', 'BLIND_RECEIPT')),
  CONSTRAINT ck_inventory_stock_transfers_status CHECK (status IN (
    'REQUESTED', 'DECLINED', 'CANCELLED', 'DISPATCHED', 'RECEIVED', 'DISCREPANCY_PENDING',
    'CLOSED', 'RETURNED', 'COMPLETED', 'UNMATCHED', 'MATCHED'
  )),
  CONSTRAINT fk_inventory_stock_transfers_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_transfers_from FOREIGN KEY (from_location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_transfers_to FOREIGN KEY (to_location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_transfers_requested_by FOREIGN KEY (requested_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_transfers_dispatched_by FOREIGN KEY (dispatched_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_transfers_carrier FOREIGN KEY (carrier_user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_transfers_received_by FOREIGN KEY (received_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_transfers_matched FOREIGN KEY (matched_transfer_id) REFERENCES inventory_stock_transfers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_transfers_approval FOREIGN KEY (approval_request_id) REFERENCES approvals_approval_requests (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_transfers_created_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_transfers_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_transfers_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Suppr. ANNULATION (avant expédition) / transfert retour (dictionnaire) : jamais de
-- suppression physique, transitions de statut normales via les gestionnaires de commande.
CREATE TRIGGER trg_inventory_stock_transfers_no_delete BEFORE DELETE ON inventory_stock_transfers FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_transfers : suppression physique interdite (INV-GLO-03) ; utiliser CANCELLED.';
END;

CREATE TABLE inventory_stock_transfer_lines (
  id                          BINARY(16)     NOT NULL,
  transfer_id                 BINARY(16)     NOT NULL,
  product_id                  BINARY(16)     NOT NULL,
  lot_id                       BINARY(16)     NULL,
  unit_code                   VARCHAR(20)    NOT NULL,
  requested_qty_base          DECIMAL(14,3)  NULL,
  dispatched_qty_base         DECIMAL(14,3)  NULL,
  received_qty_base           DECIMAL(14,3)  NULL,
  discrepancy_qty_base        DECIMAL(14,3)  GENERATED ALWAYS AS (
    IF(dispatched_qty_base IS NOT NULL AND received_qty_base IS NOT NULL, dispatched_qty_base - received_qty_base, NULL)
  ) STORED,
  discrepancy_reason_code_id  BINARY(16)     NULL,
  returned_qty_base           DECIMAL(14,3)  NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY ix_inventory_stock_transfer_lines_transfer (transfer_id),
  CONSTRAINT ck_inventory_stock_transfer_lines_qty CHECK (
    (requested_qty_base IS NULL OR requested_qty_base >= 0) AND
    (dispatched_qty_base IS NULL OR dispatched_qty_base >= 0) AND
    (received_qty_base IS NULL OR received_qty_base >= 0) AND
    returned_qty_base >= 0
  ),
  CONSTRAINT fk_inventory_stock_transfer_lines_transfer FOREIGN KEY (transfer_id) REFERENCES inventory_stock_transfers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_transfer_lines_product FOREIGN KEY (product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_transfer_lines_lot FOREIGN KEY (lot_id) REFERENCES inventory_stock_lots (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_transfer_lines_unit FOREIGN KEY (unit_code) REFERENCES catalog_units (code) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_transfer_lines_reason FOREIGN KEY (discrepancy_reason_code_id) REFERENCES catalog_reason_codes (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Suppr. suit le transfert (dictionnaire) : pas de suppression indépendante d'une ligne.
CREATE TRIGGER trg_inventory_stock_transfer_lines_no_delete BEFORE DELETE ON inventory_stock_transfer_lines FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_transfer_lines : suit le transfert, jamais supprimée indépendamment.';
END;

-- Droits par table (INV-GLO-05).
GRANT SELECT, INSERT, UPDATE ON inventory_stock_transfers TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON inventory_stock_transfer_lines TO 'gic_app'@'%';

-- migrate:down transaction:false
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS inventory_stock_transfer_lines;
DROP TABLE IF EXISTS inventory_stock_transfers;
SET FOREIGN_KEY_CHECKS = 1;
