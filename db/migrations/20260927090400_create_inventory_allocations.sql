-- Espace de noms `inventory`, allocations (P2-02 : table créée dès P2 ; commandes et logique
-- métier activées en P5, plan §4 « Tables inventory.* (sauf allocations, activées en P5 ;
-- la table est créée dès P2) »). Source : docs/03-data/dictionnaire/06-inventory.md
-- §stock_allocations/stock_allocation_entries ; SM-ALLOCATION ; ADR-004.
--
-- migrate:up transaction:false

CREATE TABLE inventory_stock_allocations (
  id                    BINARY(16)     NOT NULL,
  allocation_type       VARCHAR(20)    NOT NULL,
  location_id           BINARY(16)     NOT NULL,
  product_id            BINARY(16)     NOT NULL,
  lot_id                BINARY(16)     NULL,
  holder_user_id        BINARY(16)     NULL,
  holder_device_id      BINARY(16)     NULL,
  sales_order_line_id   BINARY(16)     NULL,
  quantity_granted       DECIMAL(14,3)  NOT NULL,
  quantity_remaining     DECIMAL(14,3)  NOT NULL,
  valid_until           DATETIME(6)    NULL,
  status                VARCHAR(10)    NOT NULL DEFAULT 'ACTIVE',
  close_cause           VARCHAR(20)    NULL,
  revocation_pending    BOOLEAN        NOT NULL DEFAULT FALSE,
  granted_by            BINARY(16)     NOT NULL,
  created_at            DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by            BINARY(16)     NOT NULL,
  updated_at            DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by            BINARY(16)     NULL,
  version               INT            NOT NULL DEFAULT 1,
  -- Un seul quota ACTIVE par (détenteur, emplacement, produit, lot) — colonne générée NULL
  -- hors condition (convention §4) ; les augmentations passent par des entrées, jamais une
  -- deuxième ligne ACTIVE pour le même quadruplet.
  active_device_quota_key VARCHAR(200) GENERATED ALWAYS AS (
    IF(
      status = 'ACTIVE' AND allocation_type = 'DEVICE_QUOTA',
      CONCAT(HEX(holder_user_id), '-', HEX(holder_device_id), '-', HEX(location_id), '-', HEX(product_id), '-', HEX(COALESCE(lot_id, 0x00000000000000000000000000000000))),
      NULL
    )
  ) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inventory_stock_allocations_active_device_quota (active_device_quota_key),
  KEY ix_inventory_stock_allocations_location_status (location_id, product_id, status),
  KEY ix_inventory_stock_allocations_holder_device (holder_device_id, status),
  CONSTRAINT ck_inventory_stock_allocations_type CHECK (allocation_type IN ('DEVICE_QUOTA', 'ORDER_RESERVATION')),
  CONSTRAINT ck_inventory_stock_allocations_status CHECK (status IN ('ACTIVE', 'CLOSED', 'REVOKED')),
  CONSTRAINT ck_inventory_stock_allocations_close_cause CHECK (close_cause IS NULL OR close_cause IN ('RELEASED', 'CONSUMED', 'CANCELLED', 'TRANSFERRED', 'EXPIRED_RELEASED')),
  CONSTRAINT ck_inventory_stock_allocations_holder CHECK (
    (allocation_type = 'DEVICE_QUOTA' AND holder_user_id IS NOT NULL AND holder_device_id IS NOT NULL AND sales_order_line_id IS NULL)
    OR (allocation_type = 'ORDER_RESERVATION' AND sales_order_line_id IS NOT NULL AND holder_user_id IS NULL AND holder_device_id IS NULL)
  ),
  CONSTRAINT fk_inventory_stock_allocations_location FOREIGN KEY (location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_allocations_product FOREIGN KEY (product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_allocations_lot FOREIGN KEY (lot_id) REFERENCES inventory_stock_lots (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_allocations_holder_user FOREIGN KEY (holder_user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_allocations_holder_device FOREIGN KEY (holder_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_allocations_granted_by FOREIGN KEY (granted_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_allocations_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_allocations_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- IMMUABLE sauf transitions (dictionnaire) : aucune commande P2 n'écrit encore cette table
-- (activée en P5) ; le déclencheur de suppression suffit pour l'instant, la restriction fine
-- des colonnes modifiables sera posée avec les commandes grant/release/revoke (P5).
CREATE TRIGGER trg_inventory_stock_allocations_no_delete BEFORE DELETE ON inventory_stock_allocations FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_allocations : suppression physique interdite (INV-GLO-03).';
END;

CREATE TABLE inventory_stock_allocation_entries (
  id             BINARY(16)     NOT NULL,
  allocation_id  BINARY(16)     NOT NULL,
  entry_type     VARCHAR(20)    NOT NULL,
  quantity       DECIMAL(14,3)  NOT NULL,
  stock_move_id  BINARY(16)     NULL,
  occurred_at    DATETIME(6)    NOT NULL,
  command_id     BINARY(16)     NULL,
  created_at     DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by     BINARY(16)     NOT NULL,
  PRIMARY KEY (id),
  KEY ix_inventory_stock_allocation_entries_allocation (allocation_id),
  CONSTRAINT ck_inventory_stock_allocation_entries_type CHECK (entry_type IN ('GRANT', 'INCREASE', 'CONSUME', 'RELEASE', 'REVOKE', 'TRANSFER', 'ADJUST')),
  CONSTRAINT fk_inventory_stock_allocation_entries_allocation FOREIGN KEY (allocation_id) REFERENCES inventory_stock_allocations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_allocation_entries_move FOREIGN KEY (stock_move_id) REFERENCES inventory_stock_moves (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_allocation_entries_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_inventory_stock_allocation_entries_no_update BEFORE UPDATE ON inventory_stock_allocation_entries FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_allocation_entries : registre immuable.';
END;

CREATE TRIGGER trg_inventory_stock_allocation_entries_no_delete BEFORE DELETE ON inventory_stock_allocation_entries FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_allocation_entries : suppression physique interdite.';
END;

-- FK différée de inventory_stock_moves (db/README.md ; même motif que identity_devices.
-- designated_site_id en P0-11) : la colonne existe depuis la migration du registre
-- (20260927090000), sans contrainte, car inventory_stock_allocations n'existait pas encore.
ALTER TABLE inventory_stock_moves
  ADD CONSTRAINT fk_inventory_stock_moves_allocation FOREIGN KEY (allocation_id) REFERENCES inventory_stock_allocations (id) ON DELETE RESTRICT;

-- Droits par table (INV-GLO-05).
GRANT SELECT, INSERT, UPDATE ON inventory_stock_allocations TO 'gic_app'@'%';
GRANT SELECT, INSERT ON inventory_stock_allocation_entries TO 'gic_app'@'%';

-- migrate:down transaction:false
SET FOREIGN_KEY_CHECKS = 0;
ALTER TABLE inventory_stock_moves DROP FOREIGN KEY fk_inventory_stock_moves_allocation;
DROP TABLE IF EXISTS inventory_stock_allocation_entries;
DROP TABLE IF EXISTS inventory_stock_allocations;
SET FOREIGN_KEY_CHECKS = 1;
