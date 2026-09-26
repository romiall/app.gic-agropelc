-- Espace de noms `inventory`, socle (P2-02). Source : docs/03-data/dictionnaire/06-inventory.md ;
-- docs/01-functional/domaines/D06-STK-stocks.md ; docs/02-domain-model/03-strategie-stock.md.
-- Ordre : stock_lots -> stock_moves (référence stock_lots) -> stock_balances -> product_valuations
-- -> stock_thresholds -> cost_entries.
--
-- migrate:up transaction:false

CREATE TABLE inventory_stock_lots (
  id              BINARY(16)     NOT NULL,
  lot_code        VARCHAR(40)    NOT NULL,
  product_id      BINARY(16)     NULL,
  origin_type     VARCHAR(20)    NOT NULL,
  origin_id       BINARY(16)     NULL,
  supplier_id     BINARY(16)     NULL,
  supplier_lot_ref VARCHAR(60)   NULL,
  expiry_date     DATE           NULL,
  fifo_rank_at    DATETIME(6)    NOT NULL,
  status          VARCHAR(10)    NOT NULL DEFAULT 'OPEN',
  created_at      DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by      BINARY(16)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inventory_stock_lots_code (lot_code),
  KEY ix_inventory_stock_lots_origin (origin_type, origin_id),
  KEY ix_inventory_stock_lots_expiry (expiry_date),
  CONSTRAINT ck_inventory_stock_lots_origin_type CHECK (origin_type IN ('PRODUCTION_LOT', 'INCUBATION_BATCH', 'SUPPLIER_LOT', 'COLLECTION')),
  CONSTRAINT ck_inventory_stock_lots_status CHECK (status IN ('OPEN', 'CLOSED')),
  CONSTRAINT fk_inventory_stock_lots_product FOREIGN KEY (product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_lots_supplier FOREIGN KEY (supplier_id) REFERENCES procurement_suppliers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_lots_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- IMMUABLE sauf `status` (dictionnaire §stock_lots).
CREATE TRIGGER trg_inventory_stock_lots_update_guard BEFORE UPDATE ON inventory_stock_lots FOR EACH ROW
BEGIN
  IF NOT (
    NEW.lot_code <=> OLD.lot_code AND NEW.product_id <=> OLD.product_id AND
    NEW.origin_type <=> OLD.origin_type AND NEW.origin_id <=> OLD.origin_id AND
    NEW.supplier_id <=> OLD.supplier_id AND NEW.supplier_lot_ref <=> OLD.supplier_lot_ref AND
    NEW.expiry_date <=> OLD.expiry_date AND NEW.fifo_rank_at <=> OLD.fifo_rank_at AND
    NEW.created_at <=> OLD.created_at AND NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_lots : seul le statut est modifiable.';
  END IF;
END;

CREATE TRIGGER trg_inventory_stock_lots_no_delete BEFORE DELETE ON inventory_stock_lots FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_lots : suppression physique interdite (INV-GLO-03).';
END;

CREATE TABLE inventory_stock_moves (
  id                   BINARY(16)      NOT NULL,
  product_id           BINARY(16)      NOT NULL,
  lot_id               BINARY(16)      NULL,
  quantity             DECIMAL(14,3)   NOT NULL,
  from_location_id     BINARY(16)      NOT NULL,
  to_location_id       BINARY(16)      NOT NULL,
  move_type            VARCHAR(30)     NOT NULL,
  reason_code_id       BINARY(16)      NULL,
  unit_cost_xaf        BIGINT          NOT NULL,
  value_xaf            BIGINT          NOT NULL,
  occurred_at          DATETIME(6)     NOT NULL,
  business_date        DATE            GENERATED ALWAYS AS (DATE(CONVERT_TZ(occurred_at, '+00:00', '+01:00'))) STORED,
  recorded_at          DATETIME(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  source_doc_type      VARCHAR(20)     NOT NULL,
  source_doc_id        BINARY(16)      NOT NULL,
  source_line_id       BINARY(16)      NULL,
  allocation_id        BINARY(16)      NULL,
  cost_object_type     VARCHAR(20)     NULL,
  cost_object_id       BINARY(16)      NULL,
  is_reversal          BOOLEAN         NOT NULL DEFAULT FALSE,
  reverses_move_id     BINARY(16)      NULL,
  created_by           BINARY(16)      NOT NULL,
  created_device_id    BINARY(16)      NULL,
  command_id           BINARY(16)      NULL,
  captured_offline      BOOLEAN        NOT NULL DEFAULT FALSE,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inventory_stock_moves_reverses (reverses_move_id),
  KEY ix_inventory_stock_moves_from (from_location_id, product_id, occurred_at),
  KEY ix_inventory_stock_moves_to (to_location_id, product_id, occurred_at),
  KEY ix_inventory_stock_moves_source_doc (source_doc_type, source_doc_id),
  KEY ix_inventory_stock_moves_lot (lot_id),
  KEY ix_inventory_stock_moves_business_date (business_date, move_type),
  KEY ix_inventory_stock_moves_command (command_id),
  CONSTRAINT ck_inventory_stock_moves_quantity CHECK (quantity > 0),
  CONSTRAINT ck_inventory_stock_moves_locations CHECK (from_location_id <> to_location_id),
  CONSTRAINT ck_inventory_stock_moves_reversal CHECK ((is_reversal = FALSE AND reverses_move_id IS NULL) OR (is_reversal = TRUE AND reverses_move_id IS NOT NULL)),
  CONSTRAINT ck_inventory_stock_moves_value CHECK (value_xaf >= 0),
  CONSTRAINT ck_inventory_stock_moves_unit_cost CHECK (unit_cost_xaf >= 0),
  CONSTRAINT ck_inventory_stock_moves_move_type CHECK (move_type IN (
    'OPENING_BALANCE', 'PURCHASE_RECEIPT', 'SUPPLIER_RETURN', 'TRANSFER_DISPATCH', 'TRANSFER_RECEIPT',
    'TRANSFER_DISCREPANCY', 'INTERNAL_MOVE', 'SALE', 'CUSTOMER_RETURN', 'LOSS', 'LOSS_PENDING',
    'LOSS_CONFIRMATION', 'LOSS_RELEASE', 'CONSUMPTION', 'PRODUCTION_OUTPUT', 'PRODUCTION_INPUT',
    'INVENTORY_GAIN', 'INVENTORY_LOSS'
  )),
  CONSTRAINT ck_inventory_stock_moves_source_doc_type CHECK (source_doc_type IN (
    'SALE', 'TRANSFER', 'LOSS', 'CONSUMPTION', 'INVENTORY_COUNT', 'GOODS_RECEIPT', 'EGG_COLLECTION', 'INCUBATION_EVENT', 'LOT_ENTRY'
  )),
  CONSTRAINT ck_inventory_stock_moves_cost_object CHECK (cost_object_type IS NULL OR cost_object_type IN ('PRODUCTION_LOT', 'INCUBATION_BATCH', 'SITE')),
  CONSTRAINT fk_inventory_stock_moves_product FOREIGN KEY (product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_moves_lot FOREIGN KEY (lot_id) REFERENCES inventory_stock_lots (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_moves_from FOREIGN KEY (from_location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_moves_to FOREIGN KEY (to_location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_moves_reason FOREIGN KEY (reason_code_id) REFERENCES catalog_reason_codes (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_moves_reverses FOREIGN KEY (reverses_move_id) REFERENCES inventory_stock_moves (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_moves_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_moves_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- IMMUABLE intégrale (INV-STK-04, dictionnaire §stock_moves) : le registre est la source de
-- vérité, jamais modifié ni supprimé — une correction est toujours un nouveau mouvement
-- inverse (`reverses_move_id`).
CREATE TRIGGER trg_inventory_stock_moves_no_update BEFORE UPDATE ON inventory_stock_moves FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : registre immuable (INV-STK-04) ; créer un mouvement inverse.';
END;

CREATE TRIGGER trg_inventory_stock_moves_no_delete BEFORE DELETE ON inventory_stock_moves FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : suppression physique interdite (INV-STK-04).';
END;

CREATE TABLE inventory_stock_balances (
  location_id    BINARY(16)      NOT NULL,
  product_id     BINARY(16)      NOT NULL,
  lot_key        BINARY(16)      NOT NULL,
  qty_on_hand    DECIMAL(14,3)   NOT NULL DEFAULT 0,
  qty_reserved   DECIMAL(14,3)   NOT NULL DEFAULT 0,
  qty_allocated  DECIMAL(14,3)   NOT NULL DEFAULT 0,
  value_xaf      BIGINT          NOT NULL DEFAULT 0,
  last_move_at   DATETIME(6)     NULL,
  updated_at     DATETIME(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  row_version    BIGINT          NOT NULL DEFAULT 0,
  PRIMARY KEY (location_id, product_id, lot_key),
  KEY ix_inventory_stock_balances_product (product_id, location_id),
  CONSTRAINT ck_inventory_stock_balances_reserved CHECK (qty_reserved >= 0),
  CONSTRAINT ck_inventory_stock_balances_allocated CHECK (qty_allocated >= 0),
  CONSTRAINT fk_inventory_stock_balances_location FOREIGN KEY (location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_balances_product FOREIGN KEY (product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
-- Projection reconstructible (dictionnaire §stock_balances) : ni déclencheur d'immuabilité ni
-- interdiction de suppression — `rebuild_stock_balances` (procédure de maintenance, hors P2)
-- peut vider et regénérer entièrement cette table depuis le registre.

CREATE TABLE inventory_product_valuations (
  product_id          BINARY(16)      NOT NULL,
  avg_unit_cost_xaf   DECIMAL(14,2)   NOT NULL DEFAULT 0,
  qty_basis           DECIMAL(14,3)   NOT NULL DEFAULT 0,
  last_entry_move_id  BINARY(16)      NULL,
  updated_at          DATETIME(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (product_id),
  CONSTRAINT fk_inventory_product_valuations_product FOREIGN KEY (product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_product_valuations_move FOREIGN KEY (last_entry_move_id) REFERENCES inventory_stock_moves (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;
-- Projection reconstructible (rejeu des entrées valorisées dans l'ordre d'application) :
-- aucune restriction de suppression.

CREATE TABLE inventory_stock_thresholds (
  id               BINARY(16)     NOT NULL,
  location_id      BINARY(16)     NOT NULL,
  product_id       BINARY(16)     NOT NULL,
  min_qty_base     DECIMAL(14,3)  NOT NULL,
  target_qty_base  DECIMAL(14,3)  NOT NULL,
  is_active        BOOLEAN        NOT NULL DEFAULT TRUE,
  created_at       DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by       BINARY(16)     NOT NULL,
  updated_at       DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by       BINARY(16)     NULL,
  version          INT            NOT NULL DEFAULT 1,
  -- Unicité « au plus un seuil actif » par (location_id, product_id) : colonne générée NULL
  -- hors condition (convention MySQL, 01-identifiants-et-conventions.md §4).
  active_key       VARCHAR(65)    GENERATED ALWAYS AS (
    IF(is_active, CONCAT(HEX(location_id), '-', HEX(product_id)), NULL)
  ) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inventory_stock_thresholds_active (active_key),
  CONSTRAINT ck_inventory_stock_thresholds_qty CHECK (min_qty_base >= 0 AND target_qty_base >= min_qty_base),
  CONSTRAINT fk_inventory_stock_thresholds_location FOREIGN KEY (location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_thresholds_product FOREIGN KEY (product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_thresholds_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_stock_thresholds_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_inventory_stock_thresholds_no_delete BEFORE DELETE ON inventory_stock_thresholds FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_thresholds : suppression physique interdite (INV-GLO-03) ; utiliser is_active=false.';
END;

CREATE TABLE inventory_cost_entries (
  id                 BINARY(16)     NOT NULL,
  cost_object_type   VARCHAR(20)    NOT NULL,
  cost_object_id     BINARY(16)     NOT NULL,
  cost_type          VARCHAR(20)    NOT NULL,
  amount_xaf         BIGINT         NOT NULL,
  direction          VARCHAR(10)    NOT NULL DEFAULT 'DEBIT',
  source_type        VARCHAR(20)    NOT NULL,
  source_id          BINARY(16)     NOT NULL,
  reverses_entry_id  BINARY(16)     NULL,
  occurred_at        DATETIME(6)    NOT NULL,
  created_at         DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by         BINARY(16)     NOT NULL,
  comment            TEXT           NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inventory_cost_entries_source (source_type, source_id, cost_object_id),
  UNIQUE KEY uq_inventory_cost_entries_reverses (reverses_entry_id),
  KEY ix_inventory_cost_entries_object (cost_object_type, cost_object_id, occurred_at),
  CONSTRAINT ck_inventory_cost_entries_amount CHECK (amount_xaf > 0),
  CONSTRAINT ck_inventory_cost_entries_direction CHECK (direction IN ('DEBIT', 'CREDIT')),
  CONSTRAINT ck_inventory_cost_entries_cost_object CHECK (cost_object_type IN ('PRODUCTION_LOT', 'INCUBATION_BATCH', 'SITE')),
  CONSTRAINT ck_inventory_cost_entries_cost_type CHECK (cost_type IN ('ANIMAUX', 'OEUFS', 'ALIMENT', 'VETERINAIRE', 'AUTRE_INTRANT', 'DEPENSE_DIRECTE', 'AJUSTEMENT')),
  CONSTRAINT ck_inventory_cost_entries_source_type CHECK (source_type IN ('STOCK_MOVE', 'EXPENSE', 'MANUAL')),
  CONSTRAINT fk_inventory_cost_entries_reverses FOREIGN KEY (reverses_entry_id) REFERENCES inventory_cost_entries (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_cost_entries_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_inventory_cost_entries_no_update BEFORE UPDATE ON inventory_cost_entries FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_cost_entries : registre immuable ; créer une écriture inverse.';
END;

CREATE TRIGGER trg_inventory_cost_entries_no_delete BEFORE DELETE ON inventory_cost_entries FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_cost_entries : suppression physique interdite.';
END;

-- Droits par table (INV-GLO-05).
GRANT SELECT, INSERT, UPDATE ON inventory_stock_lots TO 'gic_app'@'%';
GRANT SELECT, INSERT ON inventory_stock_moves TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory_stock_balances TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON inventory_product_valuations TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON inventory_stock_thresholds TO 'gic_app'@'%';
GRANT SELECT, INSERT ON inventory_cost_entries TO 'gic_app'@'%';

-- migrate:down transaction:false
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS inventory_cost_entries;
DROP TABLE IF EXISTS inventory_stock_thresholds;
DROP TABLE IF EXISTS inventory_product_valuations;
DROP TABLE IF EXISTS inventory_stock_balances;
DROP TABLE IF EXISTS inventory_stock_moves;
DROP TABLE IF EXISTS inventory_stock_lots;
SET FOREIGN_KEY_CHECKS = 1;
