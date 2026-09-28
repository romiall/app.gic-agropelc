-- P7-04 : espace de noms `production` (dictionnaire 07-production.md ; D07 ; décisions des 27 et
-- 28/09/2026 : ADR-026 amendé, ADR-027 ; AV-044 cinq types, AV-099 un lot par produit et lots
-- liés, AV-100 lot de stock propre par collecte et abattage, AV-101 abattage à la ferme, AV-104
-- frais généraux par espèce, AV-105 part estimée à la clôture, AV-106 répartition à la demande,
-- AV-110 plusieurs collectes par jour, AV-111 naissance et sevrage).
--
-- Aucune colonne d'effectif (INV-PRD-01) : l'effectif se lit dans le registre de stock.
--
-- migrate:up transaction:false

CREATE TABLE production_production_lots (
  id                          BINARY(16)     NOT NULL,
  lot_code                    VARCHAR(40)    NOT NULL,
  lot_type                    VARCHAR(25)    NOT NULL,
  product_id                  BINARY(16)     NOT NULL,
  stock_lot_id                BINARY(16)     NOT NULL,
  site_id                     BINARY(16)     NOT NULL,
  main_location_id            BINARY(16)     NOT NULL,
  -- AV-099 : lots d'une même bande (truies ↔ porcelets, poules ↔ coqs).
  parent_lot_id               BINARY(16)     NULL,
  supplier_id                 BINARY(16)     NULL,
  strain                      VARCHAR(100)   NULL,
  planned_start_date          DATE           NULL,
  start_date                  DATE           NULL,
  initial_quantity            DECIMAL(14,3)  NULL,
  planned_end_date            DATE           NULL,
  status                      VARCHAR(15)    NOT NULL DEFAULT 'PLANNED',
  closed_at                   DATETIME(6)    NULL,
  closing_summary             JSON           NULL,
  notes                       TEXT           NULL,
  cancelled_at                DATETIME(6)    NULL,
  cancelled_by                BINARY(16)     NULL,
  cancel_reason_code_id       BINARY(16)     NULL,
  cancel_comment              TEXT           NULL,
  cancel_approval_request_id  BINARY(16)     NULL,
  occurred_at                 DATETIME(6)    NOT NULL,
  client_created_at           DATETIME(6)    NULL,
  received_at_server          DATETIME(6)    NULL,
  command_id                  BINARY(16)     NULL,
  created_device_id           BINARY(16)     NULL,
  captured_offline            BOOLEAN        NOT NULL DEFAULT FALSE,
  clock_suspect               BOOLEAN        NOT NULL DEFAULT FALSE,
  backdated_reason            TEXT           NULL,
  created_at                  DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by                  BINARY(16)     NOT NULL,
  updated_at                  DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by                  BINARY(16)     NULL,
  version                     INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_production_production_lots_code (lot_code),
  UNIQUE KEY uq_production_production_lots_stock_lot (stock_lot_id),
  UNIQUE KEY uq_production_production_lots_command (command_id),
  KEY ix_production_production_lots_site_status (site_id, status),
  KEY ix_production_production_lots_parent (parent_lot_id),
  CONSTRAINT ck_production_production_lots_type CHECK (lot_type IN (
    'POULET_CHAIR', 'PONDEUSE', 'PORC_ENGRAISSEMENT', 'REPRODUCTEUR_VOLAILLE', 'PORC_NAISSAGE'
  )),
  CONSTRAINT ck_production_production_lots_status CHECK (status IN ('PLANNED', 'ACTIVE', 'SELLING', 'CLOSED', 'CANCELLED')),
  CONSTRAINT ck_production_production_lots_closed CHECK (status <> 'CLOSED' OR closed_at IS NOT NULL),
  CONSTRAINT ck_production_production_lots_initial CHECK (initial_quantity IS NULL OR initial_quantity >= 0),
  CONSTRAINT ck_production_production_lots_cancel CHECK (
    (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)
    OR (status <> 'CANCELLED' AND cancelled_at IS NULL AND cancelled_by IS NULL
        AND cancel_reason_code_id IS NULL AND cancel_comment IS NULL)
  ),
  CONSTRAINT ck_production_production_lots_parent CHECK (parent_lot_id IS NULL OR parent_lot_id <> id),
  CONSTRAINT fk_production_production_lots_product FOREIGN KEY (product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_production_lots_stock_lot FOREIGN KEY (stock_lot_id) REFERENCES inventory_stock_lots (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_production_lots_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_production_lots_location FOREIGN KEY (main_location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_production_lots_parent FOREIGN KEY (parent_lot_id) REFERENCES production_production_lots (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_production_lots_supplier FOREIGN KEY (supplier_id) REFERENCES procurement_suppliers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_production_lots_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_production_lots_cancel_reason FOREIGN KEY (cancel_reason_code_id) REFERENCES catalog_reason_codes (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_production_lots_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_production_lots_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_production_lots_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_production_production_lots_update_guard BEFORE UPDATE ON production_production_lots FOR EACH ROW
BEGIN
  IF NOT (
    NEW.lot_code <=> OLD.lot_code AND NEW.lot_type <=> OLD.lot_type AND NEW.product_id <=> OLD.product_id AND
    NEW.stock_lot_id <=> OLD.stock_lot_id AND NEW.site_id <=> OLD.site_id AND
    NEW.occurred_at <=> OLD.occurred_at AND NEW.command_id <=> OLD.command_id AND
    NEW.created_at <=> OLD.created_at AND NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_production_lots : code, type, produit, lot de stock et ferme immuables.';
  END IF;
  IF OLD.status IN ('CLOSED', 'CANCELLED') AND NOT (NEW.status <=> OLD.status) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_production_lots : un lot clôturé ou annulé ne change plus de statut.';
  END IF;
END;

CREATE TRIGGER trg_production_production_lots_no_delete BEFORE DELETE ON production_production_lots FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_production_lots : suppression physique interdite (INV-GLO-03).';
END;

CREATE TABLE production_lot_entries (
  id                          BINARY(16)     NOT NULL,
  production_lot_id           BINARY(16)     NOT NULL,
  entry_type                  VARCHAR(15)    NOT NULL,
  product_id                  BINARY(16)     NOT NULL,
  quantity_base               DECIMAL(14,3)  NOT NULL,
  to_location_id              BINARY(16)     NOT NULL,
  source_kind                 VARCHAR(20)    NOT NULL,
  source_location_id          BINARY(16)     NULL,
  source_product_id           BINARY(16)     NULL,
  source_stock_lot_id         BINARY(16)     NULL,
  source_production_lot_id    BINARY(16)     NULL,
  goods_receipt_id            BINARY(16)     NULL,
  -- Mise bas (AV-111, BR-POR-007) : mort-nés comptés, hors stock.
  stillborn_qty               INT            NOT NULL DEFAULT 0,
  avg_weight_g                DECIMAL(10,1)  NULL,
  unit_cost_xaf               BIGINT         NULL,
  value_xaf                   BIGINT         NOT NULL DEFAULT 0,
  status                      VARCHAR(15)    NOT NULL DEFAULT 'RECORDED',
  cancelled_at                DATETIME(6)    NULL,
  cancelled_by                BINARY(16)     NULL,
  cancel_reason_code_id       BINARY(16)     NULL,
  cancel_comment              TEXT           NULL,
  cancel_approval_request_id  BINARY(16)     NULL,
  occurred_at                 DATETIME(6)    NOT NULL,
  client_created_at           DATETIME(6)    NULL,
  received_at_server          DATETIME(6)    NULL,
  command_id                  BINARY(16)     NULL,
  created_device_id           BINARY(16)     NULL,
  captured_offline            BOOLEAN        NOT NULL DEFAULT FALSE,
  clock_suspect               BOOLEAN        NOT NULL DEFAULT FALSE,
  backdated_reason            TEXT           NULL,
  created_at                  DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by                  BINARY(16)     NOT NULL,
  updated_at                  DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by                  BINARY(16)     NULL,
  version                     INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_production_lot_entries_command (command_id),
  KEY ix_production_lot_entries_lot (production_lot_id, occurred_at),
  KEY ix_production_lot_entries_source_lot (source_production_lot_id),
  CONSTRAINT ck_production_lot_entries_type CHECK (entry_type IN ('PLACEMENT', 'BIRTH', 'TRANSFER_IN')),
  CONSTRAINT ck_production_lot_entries_source CHECK (source_kind IN ('PURCHASE', 'INTERNAL_STOCK', 'BIRTH', 'TRANSFER', 'WEANING')),
  CONSTRAINT ck_production_lot_entries_qty CHECK (quantity_base > 0 AND stillborn_qty >= 0 AND value_xaf >= 0),
  CONSTRAINT ck_production_lot_entries_status CHECK (status IN ('RECORDED', 'CANCELLED')),
  CONSTRAINT ck_production_lot_entries_cancel CHECK (
    (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)
    OR (status <> 'CANCELLED' AND cancelled_at IS NULL AND cancelled_by IS NULL
        AND cancel_reason_code_id IS NULL AND cancel_comment IS NULL)
  ),
  CONSTRAINT fk_production_lot_entries_lot FOREIGN KEY (production_lot_id) REFERENCES production_production_lots (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_lot_entries_product FOREIGN KEY (product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_lot_entries_to_location FOREIGN KEY (to_location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_lot_entries_source_location FOREIGN KEY (source_location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_lot_entries_source_product FOREIGN KEY (source_product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_lot_entries_source_lot FOREIGN KEY (source_production_lot_id) REFERENCES production_production_lots (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_lot_entries_receipt FOREIGN KEY (goods_receipt_id) REFERENCES procurement_goods_receipts (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_lot_entries_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_lot_entries_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_lot_entries_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_production_lot_entries_update_guard BEFORE UPDATE ON production_lot_entries FOR EACH ROW
BEGIN
  IF NOT (
    NEW.production_lot_id <=> OLD.production_lot_id AND NEW.entry_type <=> OLD.entry_type AND
    NEW.product_id <=> OLD.product_id AND NEW.quantity_base <=> OLD.quantity_base AND
    NEW.to_location_id <=> OLD.to_location_id AND NEW.value_xaf <=> OLD.value_xaf AND
    NEW.occurred_at <=> OLD.occurred_at AND NEW.command_id <=> OLD.command_id AND NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_lot_entries : entrée non modifiable ; annuler puis ressaisir.';
  END IF;
END;

CREATE TRIGGER trg_production_lot_entries_no_delete BEFORE DELETE ON production_lot_entries FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_lot_entries : suppression physique interdite (INV-GLO-03).';
END;

CREATE TABLE production_lot_weighings (
  id                          BINARY(16)     NOT NULL,
  production_lot_id           BINARY(16)     NOT NULL,
  location_id                 BINARY(16)     NULL,
  sample_size                 INT            NOT NULL,
  avg_weight_g                DECIMAL(10,1)  NOT NULL,
  total_weight_kg             DECIMAL(12,3)  NULL,
  source                      VARCHAR(10)    NOT NULL DEFAULT 'MANUAL',
  status                      VARCHAR(15)    NOT NULL DEFAULT 'RECORDED',
  cancelled_at                DATETIME(6)    NULL,
  cancelled_by                BINARY(16)     NULL,
  cancel_reason_code_id       BINARY(16)     NULL,
  cancel_comment              TEXT           NULL,
  cancel_approval_request_id  BINARY(16)     NULL,
  occurred_at                 DATETIME(6)    NOT NULL,
  client_created_at           DATETIME(6)    NULL,
  received_at_server          DATETIME(6)    NULL,
  command_id                  BINARY(16)     NULL,
  created_device_id           BINARY(16)     NULL,
  captured_offline            BOOLEAN        NOT NULL DEFAULT FALSE,
  clock_suspect               BOOLEAN        NOT NULL DEFAULT FALSE,
  backdated_reason            TEXT           NULL,
  created_at                  DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by                  BINARY(16)     NOT NULL,
  updated_at                  DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by                  BINARY(16)     NULL,
  version                     INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_production_lot_weighings_command (command_id),
  KEY ix_production_lot_weighings_lot (production_lot_id, occurred_at),
  CONSTRAINT ck_production_lot_weighings_values CHECK (sample_size > 0 AND avg_weight_g > 0 AND (total_weight_kg IS NULL OR total_weight_kg > 0)),
  CONSTRAINT ck_production_lot_weighings_source CHECK (source IN ('MANUAL', 'DEVICE')),
  CONSTRAINT ck_production_lot_weighings_status CHECK (status IN ('RECORDED', 'CANCELLED')),
  CONSTRAINT ck_production_lot_weighings_cancel CHECK (
    (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)
    OR (status <> 'CANCELLED' AND cancelled_at IS NULL AND cancelled_by IS NULL
        AND cancel_reason_code_id IS NULL AND cancel_comment IS NULL)
  ),
  CONSTRAINT fk_production_lot_weighings_lot FOREIGN KEY (production_lot_id) REFERENCES production_production_lots (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_lot_weighings_location FOREIGN KEY (location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_lot_weighings_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_lot_weighings_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_lot_weighings_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_production_lot_weighings_update_guard BEFORE UPDATE ON production_lot_weighings FOR EACH ROW
BEGIN
  IF NOT (
    NEW.production_lot_id <=> OLD.production_lot_id AND NEW.sample_size <=> OLD.sample_size AND
    NEW.avg_weight_g <=> OLD.avg_weight_g AND NEW.total_weight_kg <=> OLD.total_weight_kg AND
    NEW.occurred_at <=> OLD.occurred_at AND NEW.command_id <=> OLD.command_id AND NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_lot_weighings : pesée non modifiable ; annuler puis ressaisir.';
  END IF;
END;

CREATE TRIGGER trg_production_lot_weighings_no_delete BEFORE DELETE ON production_lot_weighings FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_lot_weighings : suppression physique interdite (INV-GLO-03).';
END;

CREATE TABLE production_lot_observations (
  id                    BINARY(16)     NOT NULL,
  production_lot_id     BINARY(16)     NOT NULL,
  observation_type      VARCHAR(15)    NOT NULL,
  text                  TEXT           NOT NULL,
  severity              VARCHAR(10)    NOT NULL DEFAULT 'INFO',
  occurred_at           DATETIME(6)    NOT NULL,
  client_created_at     DATETIME(6)    NULL,
  received_at_server    DATETIME(6)    NULL,
  command_id            BINARY(16)     NULL,
  created_device_id     BINARY(16)     NULL,
  captured_offline      BOOLEAN        NOT NULL DEFAULT FALSE,
  clock_suspect         BOOLEAN        NOT NULL DEFAULT FALSE,
  backdated_reason      TEXT           NULL,
  created_at            DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by            BINARY(16)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_production_lot_observations_command (command_id),
  KEY ix_production_lot_observations_lot (production_lot_id, occurred_at),
  CONSTRAINT ck_production_lot_observations_type CHECK (observation_type IN ('SANITAIRE', 'COMPORTEMENT', 'ENVIRONNEMENT', 'INCIDENT', 'AUTRE')),
  CONSTRAINT ck_production_lot_observations_severity CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  CONSTRAINT ck_production_lot_observations_text CHECK (CHAR_LENGTH(TRIM(text)) > 0),
  CONSTRAINT fk_production_lot_observations_lot FOREIGN KEY (production_lot_id) REFERENCES production_production_lots (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_lot_observations_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_lot_observations_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_production_lot_observations_no_update BEFORE UPDATE ON production_lot_observations FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_lot_observations : observation immuable ; ajouter une nouvelle observation.';
END;

CREATE TRIGGER trg_production_lot_observations_no_delete BEFORE DELETE ON production_lot_observations FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_lot_observations : suppression physique interdite (INV-GLO-03).';
END;

CREATE TABLE production_egg_collections (
  id                          BINARY(16)     NOT NULL,
  doc_number                  VARCHAR(40)    NOT NULL,
  production_lot_id           BINARY(16)     NOT NULL,
  site_id                     BINARY(16)     NOT NULL,
  collection_date             DATE           NOT NULL,
  storage_location_id         BINARY(16)     NOT NULL,
  -- AV-100 : lot de stock propre de la collecte (origine COLLECTION).
  stock_lot_id                BINARY(16)     NOT NULL,
  hatching_product_id         BINARY(16)     NULL,
  collected_qty               INT            NOT NULL,
  broken_qty                  INT            NOT NULL DEFAULT 0,
  nonconforming_qty           INT            NOT NULL DEFAULT 0,
  marketable_qty              INT            NOT NULL,
  hatching_qty                INT            NOT NULL DEFAULT 0,
  -- AV-098 : valeur au coût standard des œufs entrés, créditée au lot producteur.
  standard_value_xaf          BIGINT         NOT NULL DEFAULT 0,
  status                      VARCHAR(15)    NOT NULL DEFAULT 'RECORDED',
  cancelled_at                DATETIME(6)    NULL,
  cancelled_by                BINARY(16)     NULL,
  cancel_reason_code_id       BINARY(16)     NULL,
  cancel_comment              TEXT           NULL,
  cancel_approval_request_id  BINARY(16)     NULL,
  occurred_at                 DATETIME(6)    NOT NULL,
  client_created_at           DATETIME(6)    NULL,
  received_at_server          DATETIME(6)    NULL,
  command_id                  BINARY(16)     NULL,
  created_device_id           BINARY(16)     NULL,
  captured_offline            BOOLEAN        NOT NULL DEFAULT FALSE,
  clock_suspect               BOOLEAN        NOT NULL DEFAULT FALSE,
  backdated_reason            TEXT           NULL,
  created_at                  DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by                  BINARY(16)     NOT NULL,
  updated_at                  DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by                  BINARY(16)     NULL,
  version                     INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_production_egg_collections_doc_number (doc_number),
  UNIQUE KEY uq_production_egg_collections_stock_lot (stock_lot_id),
  UNIQUE KEY uq_production_egg_collections_command (command_id),
  KEY ix_production_egg_collections_lot_date (production_lot_id, collection_date),
  KEY ix_production_egg_collections_site_date (site_id, collection_date),
  -- INV-OEU-01 (AV-110 : plusieurs collectes par jour, aucune unicité (lot, date)).
  CONSTRAINT ck_production_egg_collections_balance CHECK (
    collected_qty = broken_qty + nonconforming_qty + marketable_qty + hatching_qty
    AND collected_qty >= 0 AND broken_qty >= 0 AND nonconforming_qty >= 0 AND marketable_qty >= 0 AND hatching_qty >= 0
  ),
  CONSTRAINT ck_production_egg_collections_hatching CHECK (hatching_qty = 0 OR hatching_product_id IS NOT NULL),
  CONSTRAINT ck_production_egg_collections_status CHECK (status IN ('RECORDED', 'CANCELLED')),
  CONSTRAINT ck_production_egg_collections_cancel CHECK (
    (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)
    OR (status <> 'CANCELLED' AND cancelled_at IS NULL AND cancelled_by IS NULL
        AND cancel_reason_code_id IS NULL AND cancel_comment IS NULL)
  ),
  CONSTRAINT fk_production_egg_collections_lot FOREIGN KEY (production_lot_id) REFERENCES production_production_lots (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_egg_collections_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_egg_collections_location FOREIGN KEY (storage_location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_egg_collections_stock_lot FOREIGN KEY (stock_lot_id) REFERENCES inventory_stock_lots (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_egg_collections_hatching_product FOREIGN KEY (hatching_product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_egg_collections_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_egg_collections_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_egg_collections_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_production_egg_collections_update_guard BEFORE UPDATE ON production_egg_collections FOR EACH ROW
BEGIN
  IF NOT (
    NEW.production_lot_id <=> OLD.production_lot_id AND NEW.collection_date <=> OLD.collection_date AND
    NEW.collected_qty <=> OLD.collected_qty AND NEW.broken_qty <=> OLD.broken_qty AND
    NEW.nonconforming_qty <=> OLD.nonconforming_qty AND NEW.marketable_qty <=> OLD.marketable_qty AND
    NEW.hatching_qty <=> OLD.hatching_qty AND NEW.standard_value_xaf <=> OLD.standard_value_xaf AND
    NEW.occurred_at <=> OLD.occurred_at AND NEW.command_id <=> OLD.command_id AND NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_egg_collections : collecte non modifiable ; annuler puis ressaisir (BR-OEU-004).';
  END IF;
END;

CREATE TRIGGER trg_production_egg_collections_no_delete BEFORE DELETE ON production_egg_collections FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_egg_collections : suppression physique interdite (INV-GLO-03).';
END;

CREATE TABLE production_egg_collection_lines (
  id              BINARY(16)     NOT NULL,
  collection_id   BINARY(16)     NOT NULL,
  product_id      BINARY(16)     NOT NULL,
  quantity        INT            NOT NULL,
  unit_cost_xaf   BIGINT         NOT NULL DEFAULT 0,
  created_at      DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_production_egg_collection_lines_grade (collection_id, product_id),
  CONSTRAINT ck_production_egg_collection_lines_qty CHECK (quantity > 0 AND unit_cost_xaf >= 0),
  CONSTRAINT fk_production_egg_collection_lines_collection FOREIGN KEY (collection_id) REFERENCES production_egg_collections (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_egg_collection_lines_product FOREIGN KEY (product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_production_egg_collection_lines_no_update BEFORE UPDATE ON production_egg_collection_lines FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_egg_collection_lines : ligne immuable.';
END;

CREATE TRIGGER trg_production_egg_collection_lines_no_delete BEFORE DELETE ON production_egg_collection_lines FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_egg_collection_lines : suppression physique interdite (INV-GLO-03).';
END;

CREATE TABLE production_incubation_batches (
  id                          BINARY(16)     NOT NULL,
  batch_code                  VARCHAR(40)    NOT NULL,
  stock_lot_id                BINARY(16)     NOT NULL,
  site_id                     BINARY(16)     NOT NULL,
  species                     VARCHAR(20)    NOT NULL,
  egg_product_id              BINARY(16)     NOT NULL,
  chick_product_id            BINARY(16)     NOT NULL,
  incubator_location_id       BINARY(16)     NOT NULL,
  hatcher_location_id         BINARY(16)     NULL,
  egg_source                  VARCHAR(10)    NOT NULL,
  eggs_set_qty                INT            NOT NULL,
  set_at                      DATETIME(6)    NOT NULL,
  expected_candling_date      DATE           NULL,
  expected_transfer_date      DATE           NULL,
  expected_hatch_date         DATE           NULL,
  infertile_qty               INT            NOT NULL DEFAULT 0,
  early_dead_qty              INT            NOT NULL DEFAULT 0,
  accidental_loss_qty         INT            NOT NULL DEFAULT 0,
  transferred_qty             INT            NOT NULL DEFAULT 0,
  hatched_viable_qty          INT            NOT NULL DEFAULT 0,
  hatched_nonviable_qty       INT            NOT NULL DEFAULT 0,
  unhatched_qty               INT            NOT NULL DEFAULT 0,
  status                      VARCHAR(15)    NOT NULL DEFAULT 'INCUBATING',
  hatch_rate                  DECIMAL(5,4)   NULL,
  cancelled_at                DATETIME(6)    NULL,
  cancelled_by                BINARY(16)     NULL,
  cancel_reason_code_id       BINARY(16)     NULL,
  cancel_comment              TEXT           NULL,
  cancel_approval_request_id  BINARY(16)     NULL,
  occurred_at                 DATETIME(6)    NOT NULL,
  client_created_at           DATETIME(6)    NULL,
  received_at_server          DATETIME(6)    NULL,
  command_id                  BINARY(16)     NULL,
  created_device_id           BINARY(16)     NULL,
  captured_offline            BOOLEAN        NOT NULL DEFAULT FALSE,
  clock_suspect               BOOLEAN        NOT NULL DEFAULT FALSE,
  backdated_reason            TEXT           NULL,
  created_at                  DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by                  BINARY(16)     NOT NULL,
  updated_at                  DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by                  BINARY(16)     NULL,
  version                     INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_production_incubation_batches_code (batch_code),
  UNIQUE KEY uq_production_incubation_batches_stock_lot (stock_lot_id),
  UNIQUE KEY uq_production_incubation_batches_command (command_id),
  KEY ix_production_incubation_batches_site_status (site_id, status),
  CONSTRAINT ck_production_incubation_batches_source CHECK (egg_source IN ('INTERNAL', 'PURCHASED')),
  CONSTRAINT ck_production_incubation_batches_status CHECK (status IN ('INCUBATING', 'IN_HATCHER', 'CLOSED', 'CANCELLED')),
  CONSTRAINT ck_production_incubation_batches_counters CHECK (
    eggs_set_qty > 0 AND infertile_qty >= 0 AND early_dead_qty >= 0 AND accidental_loss_qty >= 0
    AND transferred_qty >= 0 AND hatched_viable_qty >= 0 AND hatched_nonviable_qty >= 0 AND unhatched_qty >= 0
  ),
  -- INV-INC-01 à la clôture.
  CONSTRAINT ck_production_incubation_batches_balance CHECK (
    status <> 'CLOSED' OR eggs_set_qty = infertile_qty + early_dead_qty + accidental_loss_qty
      + unhatched_qty + hatched_viable_qty + hatched_nonviable_qty
  ),
  CONSTRAINT ck_production_incubation_batches_cancel CHECK (
    (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)
    OR (status <> 'CANCELLED' AND cancelled_at IS NULL AND cancelled_by IS NULL
        AND cancel_reason_code_id IS NULL AND cancel_comment IS NULL)
  ),
  CONSTRAINT fk_production_incubation_batches_stock_lot FOREIGN KEY (stock_lot_id) REFERENCES inventory_stock_lots (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_incubation_batches_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_incubation_batches_egg_product FOREIGN KEY (egg_product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_incubation_batches_chick_product FOREIGN KEY (chick_product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_incubation_batches_incubator FOREIGN KEY (incubator_location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_incubation_batches_hatcher FOREIGN KEY (hatcher_location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_incubation_batches_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_incubation_batches_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_incubation_batches_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_production_incubation_batches_update_guard BEFORE UPDATE ON production_incubation_batches FOR EACH ROW
BEGIN
  IF NOT (
    NEW.batch_code <=> OLD.batch_code AND NEW.stock_lot_id <=> OLD.stock_lot_id AND NEW.site_id <=> OLD.site_id AND
    NEW.eggs_set_qty <=> OLD.eggs_set_qty AND NEW.set_at <=> OLD.set_at AND
    NEW.egg_product_id <=> OLD.egg_product_id AND NEW.chick_product_id <=> OLD.chick_product_id AND
    NEW.command_id <=> OLD.command_id AND NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_incubation_batches : œufs incubés figés au démarrage (BR-INC-002).';
  END IF;
  IF OLD.status IN ('CLOSED', 'CANCELLED') AND NOT (NEW.status <=> OLD.status) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_incubation_batches : un lot d''incubation clos ne change plus de statut.';
  END IF;
END;

CREATE TRIGGER trg_production_incubation_batches_no_delete BEFORE DELETE ON production_incubation_batches FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_incubation_batches : suppression physique interdite (INV-GLO-03).';
END;

CREATE TABLE production_incubation_events (
  id                          BINARY(16)     NOT NULL,
  batch_id                    BINARY(16)     NOT NULL,
  event_type                  VARCHAR(25)    NOT NULL,
  qty_infertile               INT            NULL,
  qty_early_dead              INT            NULL,
  qty_transferred             INT            NULL,
  qty_hatched_viable          INT            NULL,
  qty_hatched_nonviable       INT            NULL,
  qty_unhatched               INT            NULL,
  output_location_id          BINARY(16)     NULL,
  status                      VARCHAR(15)    NOT NULL DEFAULT 'RECORDED',
  -- Un seul transfert et une seule éclosion enregistrés par lot (dictionnaire).
  single_step_key             VARCHAR(60)    GENERATED ALWAYS AS (
    CASE WHEN status = 'RECORDED' AND event_type IN ('TRANSFER_TO_HATCHER', 'HATCH')
         THEN CONCAT(HEX(batch_id), ':', event_type) END
  ) STORED,
  cancelled_at                DATETIME(6)    NULL,
  cancelled_by                BINARY(16)     NULL,
  cancel_reason_code_id       BINARY(16)     NULL,
  cancel_comment              TEXT           NULL,
  cancel_approval_request_id  BINARY(16)     NULL,
  occurred_at                 DATETIME(6)    NOT NULL,
  client_created_at           DATETIME(6)    NULL,
  received_at_server          DATETIME(6)    NULL,
  command_id                  BINARY(16)     NULL,
  created_device_id           BINARY(16)     NULL,
  captured_offline            BOOLEAN        NOT NULL DEFAULT FALSE,
  clock_suspect               BOOLEAN        NOT NULL DEFAULT FALSE,
  backdated_reason            TEXT           NULL,
  created_at                  DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by                  BINARY(16)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_production_incubation_events_command (command_id),
  UNIQUE KEY uq_production_incubation_events_single_step (single_step_key),
  KEY ix_production_incubation_events_batch (batch_id, occurred_at),
  CONSTRAINT ck_production_incubation_events_type CHECK (event_type IN ('SET', 'CANDLING', 'TRANSFER_TO_HATCHER', 'HATCH', 'CANCEL')),
  CONSTRAINT ck_production_incubation_events_qty CHECK (
    COALESCE(qty_infertile, 0) >= 0 AND COALESCE(qty_early_dead, 0) >= 0 AND COALESCE(qty_transferred, 0) >= 0
    AND COALESCE(qty_hatched_viable, 0) >= 0 AND COALESCE(qty_hatched_nonviable, 0) >= 0 AND COALESCE(qty_unhatched, 0) >= 0
  ),
  CONSTRAINT ck_production_incubation_events_status CHECK (status IN ('RECORDED', 'CANCELLED')),
  CONSTRAINT fk_production_incubation_events_batch FOREIGN KEY (batch_id) REFERENCES production_incubation_batches (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_incubation_events_location FOREIGN KEY (output_location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_incubation_events_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_incubation_events_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_production_incubation_events_update_guard BEFORE UPDATE ON production_incubation_events FOR EACH ROW
BEGIN
  IF NOT (
    NEW.batch_id <=> OLD.batch_id AND NEW.event_type <=> OLD.event_type AND
    NEW.qty_infertile <=> OLD.qty_infertile AND NEW.qty_early_dead <=> OLD.qty_early_dead AND
    NEW.qty_transferred <=> OLD.qty_transferred AND NEW.qty_hatched_viable <=> OLD.qty_hatched_viable AND
    NEW.qty_hatched_nonviable <=> OLD.qty_hatched_nonviable AND NEW.qty_unhatched <=> OLD.qty_unhatched AND
    NEW.occurred_at <=> OLD.occurred_at AND NEW.command_id <=> OLD.command_id
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_incubation_events : étape non modifiable ; annuler.';
  END IF;
END;

CREATE TRIGGER trg_production_incubation_events_no_delete BEFORE DELETE ON production_incubation_events FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_incubation_events : suppression physique interdite (INV-GLO-03).';
END;

-- Abattage (AV-032, AV-101, AV-102 ; ADR-026 §2) : transformation multi-produits.
CREATE TABLE production_slaughter_batches (
  id                          BINARY(16)     NOT NULL,
  doc_number                  VARCHAR(40)    NOT NULL,
  production_lot_id           BINARY(16)     NOT NULL,
  site_id                     BINARY(16)     NOT NULL,
  source_location_id          BINARY(16)     NOT NULL,
  location_id                 BINARY(16)     NOT NULL,
  input_product_id            BINARY(16)     NOT NULL,
  heads_qty                   INT            NOT NULL,
  -- AV-114 (défaut) : têtes saisies, consommées sans produit.
  condemned_heads             INT            NOT NULL DEFAULT 0,
  live_weight_g               BIGINT         NOT NULL,
  output_weight_g             BIGINT         NOT NULL,
  total_input_value_xaf       BIGINT         NOT NULL DEFAULT 0,
  yield_rate                  DECIMAL(5,4)   NULL,
  -- AV-100 : lot de stock propre des produits (origine TRANSFORMATION).
  stock_lot_id                BINARY(16)     NOT NULL,
  status                      VARCHAR(15)    NOT NULL DEFAULT 'RECORDED',
  cancelled_at                DATETIME(6)    NULL,
  cancelled_by                BINARY(16)     NULL,
  cancel_reason_code_id       BINARY(16)     NULL,
  cancel_comment              TEXT           NULL,
  cancel_approval_request_id  BINARY(16)     NULL,
  occurred_at                 DATETIME(6)    NOT NULL,
  client_created_at           DATETIME(6)    NULL,
  received_at_server          DATETIME(6)    NULL,
  command_id                  BINARY(16)     NULL,
  created_device_id           BINARY(16)     NULL,
  captured_offline            BOOLEAN        NOT NULL DEFAULT FALSE,
  clock_suspect               BOOLEAN        NOT NULL DEFAULT FALSE,
  backdated_reason            TEXT           NULL,
  created_at                  DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by                  BINARY(16)     NOT NULL,
  updated_at                  DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by                  BINARY(16)     NULL,
  version                     INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_production_slaughter_batches_doc_number (doc_number),
  UNIQUE KEY uq_production_slaughter_batches_stock_lot (stock_lot_id),
  UNIQUE KEY uq_production_slaughter_batches_command (command_id),
  KEY ix_production_slaughter_batches_lot (production_lot_id, occurred_at),
  CONSTRAINT ck_production_slaughter_batches_values CHECK (
    heads_qty > 0 AND condemned_heads >= 0 AND condemned_heads <= heads_qty
    AND live_weight_g > 0 AND output_weight_g > 0 AND output_weight_g <= live_weight_g
    AND total_input_value_xaf >= 0
  ),
  CONSTRAINT ck_production_slaughter_batches_status CHECK (status IN ('RECORDED', 'CANCELLED')),
  CONSTRAINT ck_production_slaughter_batches_cancel CHECK (
    (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)
    OR (status <> 'CANCELLED' AND cancelled_at IS NULL AND cancelled_by IS NULL
        AND cancel_reason_code_id IS NULL AND cancel_comment IS NULL)
  ),
  CONSTRAINT fk_production_slaughter_batches_lot FOREIGN KEY (production_lot_id) REFERENCES production_production_lots (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_slaughter_batches_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_slaughter_batches_source FOREIGN KEY (source_location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_slaughter_batches_location FOREIGN KEY (location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_slaughter_batches_product FOREIGN KEY (input_product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_slaughter_batches_stock_lot FOREIGN KEY (stock_lot_id) REFERENCES inventory_stock_lots (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_slaughter_batches_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_slaughter_batches_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_slaughter_batches_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_production_slaughter_batches_update_guard BEFORE UPDATE ON production_slaughter_batches FOR EACH ROW
BEGIN
  IF NOT (
    NEW.doc_number <=> OLD.doc_number AND NEW.production_lot_id <=> OLD.production_lot_id AND
    NEW.heads_qty <=> OLD.heads_qty AND NEW.condemned_heads <=> OLD.condemned_heads AND
    NEW.live_weight_g <=> OLD.live_weight_g AND NEW.output_weight_g <=> OLD.output_weight_g AND
    NEW.total_input_value_xaf <=> OLD.total_input_value_xaf AND NEW.stock_lot_id <=> OLD.stock_lot_id AND
    NEW.occurred_at <=> OLD.occurred_at AND NEW.command_id <=> OLD.command_id AND NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_slaughter_batches : abattage non modifiable ; annuler.';
  END IF;
END;

CREATE TRIGGER trg_production_slaughter_batches_no_delete BEFORE DELETE ON production_slaughter_batches FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_slaughter_batches : suppression physique interdite (INV-GLO-03).';
END;

CREATE TABLE production_slaughter_outputs (
  id                    BINARY(16)     NOT NULL,
  slaughter_id          BINARY(16)     NOT NULL,
  product_id            BINARY(16)     NOT NULL,
  to_location_id        BINARY(16)     NOT NULL,
  quantity_base         DECIMAL(14,3)  NOT NULL,
  weight_g              BIGINT         NOT NULL,
  allocated_value_xaf   BIGINT         NOT NULL,
  unit_cost_xaf         BIGINT         NOT NULL,
  created_at            DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_production_slaughter_outputs_product (slaughter_id, product_id),
  CONSTRAINT ck_production_slaughter_outputs_values CHECK (quantity_base > 0 AND weight_g > 0 AND allocated_value_xaf >= 0 AND unit_cost_xaf >= 0),
  CONSTRAINT fk_production_slaughter_outputs_slaughter FOREIGN KEY (slaughter_id) REFERENCES production_slaughter_batches (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_slaughter_outputs_product FOREIGN KEY (product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_slaughter_outputs_location FOREIGN KEY (to_location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_production_slaughter_outputs_no_update BEFORE UPDATE ON production_slaughter_outputs FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_slaughter_outputs : ligne immuable.';
END;

CREATE TRIGGER trg_production_slaughter_outputs_no_delete BEFORE DELETE ON production_slaughter_outputs FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_slaughter_outputs : suppression physique interdite (INV-GLO-03).';
END;

-- Répartition des frais généraux (ADR-026 amendé ; AV-104 à AV-106) : une exécution par
-- (ferme, espèce, mois, rang) — initiale, régularisation ou part estimée à la clôture d'un lot.
CREATE TABLE production_overhead_allocations (
  id                    BINARY(16)     NOT NULL,
  site_id               BINARY(16)     NOT NULL,
  species_group         VARCHAR(10)    NOT NULL,
  period                CHAR(7)        NOT NULL,
  run_kind              VARCHAR(20)    NOT NULL,
  sequence              INT            NOT NULL,
  pool_xaf              BIGINT         NOT NULL,
  allocated_xaf         BIGINT         NOT NULL,
  head_days_total       DECIMAL(18,3)  NOT NULL,
  -- Part estimée à la clôture (AV-105) : lot concerné.
  production_lot_id     BINARY(16)     NULL,
  occurred_at           DATETIME(6)    NOT NULL,
  command_id            BINARY(16)     NULL,
  created_at            DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by            BINARY(16)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_production_overhead_allocations_run (site_id, species_group, period, sequence),
  UNIQUE KEY uq_production_overhead_allocations_command (command_id),
  KEY ix_production_overhead_allocations_lot (production_lot_id),
  CONSTRAINT ck_production_overhead_allocations_species CHECK (species_group IN ('VOLAILLE', 'PORC')),
  CONSTRAINT ck_production_overhead_allocations_kind CHECK (run_kind IN ('INITIAL', 'REGULARIZATION', 'CLOSING_ESTIMATE')),
  CONSTRAINT ck_production_overhead_allocations_period CHECK (period REGEXP '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT ck_production_overhead_allocations_amounts CHECK (pool_xaf >= 0 AND allocated_xaf >= 0 AND allocated_xaf <= pool_xaf AND head_days_total >= 0),
  CONSTRAINT ck_production_overhead_allocations_estimate CHECK ((run_kind = 'CLOSING_ESTIMATE') = (production_lot_id IS NOT NULL)),
  CONSTRAINT fk_production_overhead_allocations_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_overhead_allocations_lot FOREIGN KEY (production_lot_id) REFERENCES production_production_lots (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_overhead_allocations_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_production_overhead_allocations_no_update BEFORE UPDATE ON production_overhead_allocations FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_overhead_allocations : répartition jamais réécrite (ADR-026) ; régulariser.';
END;

CREATE TRIGGER trg_production_overhead_allocations_no_delete BEFORE DELETE ON production_overhead_allocations FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_overhead_allocations : suppression physique interdite (INV-GLO-03).';
END;

CREATE TABLE production_overhead_allocation_lines (
  id                  BINARY(16)     NOT NULL,
  allocation_id       BINARY(16)     NOT NULL,
  production_lot_id   BINARY(16)     NOT NULL,
  head_days           DECIMAL(18,3)  NOT NULL,
  amount_xaf          BIGINT         NOT NULL,
  cost_entry_id       BINARY(16)     NULL,
  created_at          DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_production_overhead_allocation_lines_lot (allocation_id, production_lot_id),
  CONSTRAINT ck_production_overhead_allocation_lines_values CHECK (head_days >= 0 AND amount_xaf >= 0),
  CONSTRAINT fk_production_overhead_allocation_lines_allocation FOREIGN KEY (allocation_id) REFERENCES production_overhead_allocations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_overhead_allocation_lines_lot FOREIGN KEY (production_lot_id) REFERENCES production_production_lots (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_production_overhead_allocation_lines_no_update BEFORE UPDATE ON production_overhead_allocation_lines FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_overhead_allocation_lines : ligne immuable.';
END;

CREATE TRIGGER trg_production_overhead_allocation_lines_no_delete BEFORE DELETE ON production_overhead_allocation_lines FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_overhead_allocation_lines : suppression physique interdite (INV-GLO-03).';
END;

-- Droits par table (INV-GLO-05) : aucune suppression.
GRANT SELECT, INSERT, UPDATE ON production_production_lots TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON production_lot_entries TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON production_lot_weighings TO 'gic_app'@'%';
GRANT SELECT, INSERT ON production_lot_observations TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON production_egg_collections TO 'gic_app'@'%';
GRANT SELECT, INSERT ON production_egg_collection_lines TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON production_incubation_batches TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON production_incubation_events TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON production_slaughter_batches TO 'gic_app'@'%';
GRANT SELECT, INSERT ON production_slaughter_outputs TO 'gic_app'@'%';
GRANT SELECT, INSERT ON production_overhead_allocations TO 'gic_app'@'%';
GRANT SELECT, INSERT ON production_overhead_allocation_lines TO 'gic_app'@'%';

-- migrate:down transaction:false
DROP TABLE production_overhead_allocation_lines;
DROP TABLE production_overhead_allocations;
DROP TABLE production_slaughter_outputs;
DROP TABLE production_slaughter_batches;
DROP TABLE production_incubation_events;
DROP TABLE production_incubation_batches;
DROP TABLE production_egg_collection_lines;
DROP TABLE production_egg_collections;
DROP TABLE production_lot_observations;
DROP TABLE production_lot_weighings;
DROP TABLE production_lot_entries;
DROP TABLE production_production_lots;
