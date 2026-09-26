-- Espace de noms `catalog` (P1-02). Source : docs/03-data/dictionnaire/03-catalog-pricing.md ;
-- docs/01-functional/domaines/D16-CAT-catalogue-referentiels.md.
-- Ordre : product_categories -> units -> products (-> product_units, product_standard_costs) ;
-- customer_categories, sales_channels, reason_codes sont indépendants.
--
-- migrate:up transaction:false

CREATE TABLE catalog_product_categories (
  id           BINARY(16)     NOT NULL,
  parent_id    BINARY(16)     NULL,
  code         VARCHAR(40)    NOT NULL,
  name         VARCHAR(200)   NOT NULL,
  is_active    BOOLEAN        NOT NULL DEFAULT TRUE,
  created_at   DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by   BINARY(16)     NOT NULL,
  updated_at   DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by   BINARY(16)     NULL,
  version      INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_catalog_product_categories_code (code),
  KEY ix_catalog_product_categories_parent (parent_id),
  CONSTRAINT fk_catalog_product_categories_parent FOREIGN KEY (parent_id) REFERENCES catalog_product_categories (id) ON DELETE RESTRICT,
  CONSTRAINT fk_catalog_product_categories_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_catalog_product_categories_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_catalog_product_categories_no_delete BEFORE DELETE ON catalog_product_categories FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'catalog_product_categories : suppression physique interdite (INV-GLO-03) ; utiliser is_active=false.';
END;

CREATE TABLE catalog_units (
  code         VARCHAR(20)    NOT NULL,
  name         VARCHAR(60)    NOT NULL,
  is_count     BOOLEAN        NOT NULL,
  is_active    BOOLEAN        NOT NULL DEFAULT TRUE,
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_catalog_units_no_delete BEFORE DELETE ON catalog_units FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'catalog_units : suppression physique interdite (INV-GLO-03) ; utiliser is_active=false.';
END;

CREATE TABLE catalog_products (
  id                 BINARY(16)     NOT NULL,
  code               VARCHAR(40)    NOT NULL,
  name               VARCHAR(200)   NOT NULL,
  category_id        BINARY(16)     NOT NULL,
  stock_family       VARCHAR(30)    NOT NULL,
  base_unit_code     VARCHAR(20)    NOT NULL,
  lot_tracking       VARCHAR(10)    NOT NULL DEFAULT 'NONE',
  expiry_tracking    BOOLEAN        NOT NULL DEFAULT FALSE,
  is_sellable        BOOLEAN        NOT NULL DEFAULT FALSE,
  is_purchasable     BOOLEAN        NOT NULL DEFAULT FALSE,
  is_producible      BOOLEAN        NOT NULL DEFAULT FALSE,
  is_consumable      BOOLEAN        NOT NULL DEFAULT FALSE,
  pricing_mode       VARCHAR(12)    NOT NULL DEFAULT 'PER_UNIT',
  species            VARCHAR(20)    NULL,
  status             VARCHAR(10)    NOT NULL DEFAULT 'ACTIVE',
  sellable_since     DATETIME(6)    NULL,
  created_at         DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by         BINARY(16)     NOT NULL,
  updated_at         DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by         BINARY(16)     NULL,
  version            INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_catalog_products_code (code),
  KEY ix_catalog_products_category (category_id),
  KEY ix_catalog_products_status_sellable (status, is_sellable),
  CONSTRAINT ck_catalog_products_stock_family CHECK (stock_family IN ('BIOLOGIQUE', 'PRODUCTION_COMMERCIALISABLE', 'INTRANT', 'MARCHANDISE', 'EMBALLAGE_CONSOMMABLE', 'SERVICE')),
  CONSTRAINT ck_catalog_products_lot_tracking CHECK (lot_tracking IN ('REQUIRED', 'OPTIONAL', 'NONE')),
  CONSTRAINT ck_catalog_products_pricing_mode CHECK (pricing_mode IN ('PER_UNIT', 'PER_WEIGHT')),
  CONSTRAINT ck_catalog_products_species CHECK (species IS NULL OR species IN ('POULET_CHAIR', 'PONDEUSE', 'PORC')),
  CONSTRAINT ck_catalog_products_status CHECK (status IN ('ACTIVE', 'INACTIVE')),
  -- BR-CAT-005 : SERVICE => lot_tracking NONE. Espèce requise si BIOLOGIQUE (dictionnaire §products).
  CONSTRAINT ck_catalog_products_service_no_lot CHECK (stock_family <> 'SERVICE' OR lot_tracking = 'NONE'),
  CONSTRAINT ck_catalog_products_species_required CHECK (stock_family <> 'BIOLOGIQUE' OR species IS NOT NULL),
  CONSTRAINT fk_catalog_products_category FOREIGN KEY (category_id) REFERENCES catalog_product_categories (id) ON DELETE RESTRICT,
  CONSTRAINT fk_catalog_products_base_unit FOREIGN KEY (base_unit_code) REFERENCES catalog_units (code) ON DELETE RESTRICT,
  CONSTRAINT fk_catalog_products_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_catalog_products_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- INV-CAT-01 : base_unit_code immuable dès qu'un mouvement de stock existe. `inventory`
-- n'existe qu'à partir de P2 : ce déclencheur ne peut pas encore interroger
-- `inventory_stock_moves` (table absente). Revérification différée à P2 (créée là où la
-- table existe réellement) — documenté, pas silencieux (CLAUDE.md règle #2). En attendant,
-- seul le contrôle applicatif (gestionnaire de commande) protège cette colonne.
CREATE TRIGGER trg_catalog_products_no_delete BEFORE DELETE ON catalog_products FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'catalog_products : suppression physique interdite (INV-GLO-03) ; utiliser status=INACTIVE.';
END;

CREATE TABLE catalog_product_units (
  id                BINARY(16)      NOT NULL,
  product_id        BINARY(16)      NOT NULL,
  unit_code         VARCHAR(20)     NOT NULL,
  factor_to_base    DECIMAL(14,6)   NOT NULL,
  is_sales_unit     BOOLEAN         NOT NULL DEFAULT FALSE,
  is_purchase_unit  BOOLEAN         NOT NULL DEFAULT FALSE,
  is_count_unit     BOOLEAN         NOT NULL DEFAULT FALSE,
  is_active         BOOLEAN         NOT NULL DEFAULT TRUE,
  created_at        DATETIME(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by        BINARY(16)      NOT NULL,
  updated_at        DATETIME(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by        BINARY(16)      NULL,
  version           INT             NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_catalog_product_units_product_unit (product_id, unit_code),
  CONSTRAINT ck_catalog_product_units_factor CHECK (factor_to_base > 0),
  CONSTRAINT fk_catalog_product_units_product FOREIGN KEY (product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_catalog_product_units_unit FOREIGN KEY (unit_code) REFERENCES catalog_units (code) ON DELETE RESTRICT,
  CONSTRAINT fk_catalog_product_units_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_catalog_product_units_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- BR-CAT-004 : factor_to_base immuable une fois utilisé dans une transaction. `sales` et
-- `procurement` (lignes) n'existent pas encore (P1) : contrôle applicatif seul pour l'instant,
-- comme pour base_unit_code ci-dessus.
CREATE TRIGGER trg_catalog_product_units_no_delete BEFORE DELETE ON catalog_product_units FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'catalog_product_units : suppression physique interdite (INV-GLO-03) ; utiliser is_active=false.';
END;

CREATE TABLE catalog_reason_codes (
  id                 BINARY(16)     NOT NULL,
  category           VARCHAR(30)    NOT NULL,
  code               VARCHAR(40)    NOT NULL,
  label              VARCHAR(200)   NOT NULL,
  loss_category      VARCHAR(30)    NULL,
  requires_comment   BOOLEAN        NOT NULL DEFAULT FALSE,
  is_active          BOOLEAN        NOT NULL DEFAULT TRUE,
  created_at         DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by         BINARY(16)     NOT NULL,
  updated_at         DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by         BINARY(16)     NULL,
  version            INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_catalog_reason_codes_category_code (category, code),
  CONSTRAINT ck_catalog_reason_codes_category CHECK (category IN ('LOSS', 'REJECTION', 'INVENTORY_ADJUSTMENT', 'CANCELLATION', 'PRICE_OVERRIDE', 'VISIT_OUTCOME', 'PROSPECT_LOST', 'CHECKIN_OVERRIDE', 'PRODUCTION_YIELD', 'CASH_VARIANCE', 'TRANSFER_DISCREPANCY')),
  CONSTRAINT fk_catalog_reason_codes_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_catalog_reason_codes_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_catalog_reason_codes_no_delete BEFORE DELETE ON catalog_reason_codes FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'catalog_reason_codes : suppression physique interdite (BR-CAT-010) ; utiliser is_active=false.';
END;

-- AV-017 : catégories de clients, référentiel partagé CRM/tarification/ventes.
CREATE TABLE catalog_customer_categories (
  id           BINARY(16)     NOT NULL,
  code         VARCHAR(40)    NOT NULL,
  name         VARCHAR(200)   NOT NULL,
  is_active    BOOLEAN        NOT NULL DEFAULT TRUE,
  created_at   DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by   BINARY(16)     NOT NULL,
  updated_at   DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by   BINARY(16)     NULL,
  version      INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_catalog_customer_categories_code (code),
  CONSTRAINT fk_catalog_customer_categories_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_catalog_customer_categories_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_catalog_customer_categories_no_delete BEFORE DELETE ON catalog_customer_categories FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'catalog_customer_categories : suppression physique interdite (INV-GLO-03) ; utiliser is_active=false.';
END;

-- AV-018 : canaux de vente, référentiel partagé CRM/tarification/ventes.
CREATE TABLE catalog_sales_channels (
  code         VARCHAR(20)    NOT NULL,
  name         VARCHAR(60)    NOT NULL,
  is_active    BOOLEAN        NOT NULL DEFAULT TRUE,
  PRIMARY KEY (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_catalog_sales_channels_no_delete BEFORE DELETE ON catalog_sales_channels FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'catalog_sales_channels : suppression physique interdite (INV-GLO-03) ; utiliser is_active=false.';
END;

CREATE TABLE catalog_product_standard_costs (
  id             BINARY(16)     NOT NULL,
  product_id     BINARY(16)     NOT NULL,
  unit_cost_xaf  BIGINT         NOT NULL,
  valid_from     DATETIME(6)    NOT NULL,
  reason         TEXT           NULL,
  created_at     DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by     BINARY(16)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_catalog_product_standard_costs_version (product_id, valid_from),
  CONSTRAINT ck_catalog_product_standard_costs_unit_cost CHECK (unit_cost_xaf >= 0),
  CONSTRAINT fk_catalog_product_standard_costs_product FOREIGN KEY (product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_catalog_product_standard_costs_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- IMMUABLE (versionnement, BR-CAT-011) : jamais modifiée après insertion.
CREATE TRIGGER trg_catalog_product_standard_costs_no_update BEFORE UPDATE ON catalog_product_standard_costs FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'catalog_product_standard_costs : aucune modification (versionnement) ; insérer une nouvelle version.';
END;

CREATE TRIGGER trg_catalog_product_standard_costs_no_delete BEFORE DELETE ON catalog_product_standard_costs FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'catalog_product_standard_costs : suppression physique interdite (INV-GLO-03).';
END;

-- Droits par table (INV-GLO-05).
GRANT SELECT, INSERT, UPDATE ON catalog_product_categories TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON catalog_units TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON catalog_products TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON catalog_product_units TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON catalog_reason_codes TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON catalog_customer_categories TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON catalog_sales_channels TO 'gic_app'@'%';
GRANT SELECT, INSERT ON catalog_product_standard_costs TO 'gic_app'@'%';

-- migrate:down transaction:false
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS catalog_product_standard_costs;
DROP TABLE IF EXISTS catalog_sales_channels;
DROP TABLE IF EXISTS catalog_customer_categories;
DROP TABLE IF EXISTS catalog_reason_codes;
DROP TABLE IF EXISTS catalog_product_units;
DROP TABLE IF EXISTS catalog_products;
DROP TABLE IF EXISTS catalog_units;
DROP TABLE IF EXISTS catalog_product_categories;
SET FOREIGN_KEY_CHECKS = 1;
