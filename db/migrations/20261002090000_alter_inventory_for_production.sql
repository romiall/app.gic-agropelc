-- P7-02 : prérequis `inventory` (et catalogues fermés voisins) de la production.
-- Sources : ADR-026 (frais généraux, amendé le 28/09/2026), ADR-027 (valorisation des lots
-- biologiques), décisions AV-098 (production transférée au coût standard), AV-100 (lot de
-- stock propre par abattage), AV-101 (abattoir à la ferme), AV-103/104 (frais généraux saisis
-- par espèce, ventilés à la saisie), AV-108 (écart d'inventaire sur animaux validé par le
-- Responsable production), AV-113 (mortalité d'un lot d'incubation). Dictionnaires :
-- 06-inventory.md, 02-organization.md, 10-approvals-attachments-communication.md.
--
-- migrate:up transaction:false

-- Écritures de coût : frais généraux (espèce obligatoire), production transférée (crédit du
-- lot producteur, AV-098), nouvelles sources (saisie de frais généraux, répartition,
-- production).
ALTER TABLE inventory_cost_entries
  ADD COLUMN species_group VARCHAR(10) NULL AFTER cost_type;
ALTER TABLE inventory_cost_entries
  DROP CHECK ck_inventory_cost_entries_cost_type,
  ADD CONSTRAINT ck_inventory_cost_entries_cost_type CHECK (cost_type IN (
    'ANIMAUX', 'OEUFS', 'ALIMENT', 'VETERINAIRE', 'AUTRE_INTRANT', 'DEPENSE_DIRECTE', 'AJUSTEMENT',
    'FRAIS_GENERAUX', 'PRODUCTION_TRANSFEREE'
  )),
  DROP CHECK ck_inventory_cost_entries_source_type,
  ADD CONSTRAINT ck_inventory_cost_entries_source_type CHECK (source_type IN (
    'STOCK_MOVE', 'EXPENSE', 'MANUAL', 'OVERHEAD_ENTRY', 'ALLOCATION', 'PRODUCTION'
  )),
  ADD CONSTRAINT ck_inventory_cost_entries_species CHECK (species_group IS NULL OR species_group IN ('VOLAILLE', 'PORC')),
  ADD CONSTRAINT ck_inventory_cost_entries_overhead_species CHECK (cost_type <> 'FRAIS_GENERAUX' OR species_group IS NOT NULL);

-- Saisie des frais généraux d'une ferme (AV-103, AV-104) : une en-tête, une ligne par espèce ;
-- chaque ligne porte l'écriture de coût `SITE` correspondante (source `OVERHEAD_ENTRY`).
CREATE TABLE inventory_overhead_entries (
  id                          BINARY(16)     NOT NULL,
  site_id                     BINARY(16)     NOT NULL,
  label                       VARCHAR(200)   NOT NULL,
  total_xaf                   BIGINT         NOT NULL,
  status                      VARCHAR(20)    NOT NULL DEFAULT 'RECORDED',
  cancelled_at                DATETIME(6)    NULL,
  cancelled_by                BINARY(16)     NULL,
  cancel_reason_code_id       BINARY(16)     NULL,
  cancel_comment              TEXT           NULL,
  cancel_approval_request_id  BINARY(16)     NULL,
  occurred_at                 DATETIME(6)    NOT NULL,
  business_date               DATE           GENERATED ALWAYS AS (DATE(CONVERT_TZ(occurred_at, '+00:00', '+01:00'))) STORED,
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
  UNIQUE KEY uq_inventory_overhead_entries_command (command_id),
  KEY ix_inventory_overhead_entries_site_date (site_id, business_date),
  CONSTRAINT ck_inventory_overhead_entries_total CHECK (total_xaf > 0),
  CONSTRAINT ck_inventory_overhead_entries_status CHECK (status IN ('RECORDED', 'CANCELLED')),
  CONSTRAINT ck_inventory_overhead_entries_cancel CHECK (
    (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)
    OR (status <> 'CANCELLED' AND cancelled_at IS NULL AND cancelled_by IS NULL
        AND cancel_reason_code_id IS NULL AND cancel_comment IS NULL)
  ),
  CONSTRAINT fk_inventory_overhead_entries_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_overhead_entries_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_overhead_entries_created_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_overhead_entries_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_overhead_entries_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_inventory_overhead_entries_update_guard BEFORE UPDATE ON inventory_overhead_entries FOR EACH ROW
BEGIN
  IF NOT (
    NEW.site_id <=> OLD.site_id AND NEW.label <=> OLD.label AND NEW.total_xaf <=> OLD.total_xaf AND
    NEW.occurred_at <=> OLD.occurred_at AND NEW.command_id <=> OLD.command_id AND
    NEW.created_at <=> OLD.created_at AND NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_overhead_entries : saisie non modifiable ; annuler puis ressaisir.';
  END IF;
END;

CREATE TRIGGER trg_inventory_overhead_entries_no_delete BEFORE DELETE ON inventory_overhead_entries FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_overhead_entries : suppression physique interdite (INV-GLO-03).';
END;

CREATE TABLE inventory_overhead_entry_lines (
  id              BINARY(16)     NOT NULL,
  entry_id        BINARY(16)     NOT NULL,
  species_group   VARCHAR(10)    NOT NULL,
  amount_xaf      BIGINT         NOT NULL,
  cost_entry_id   BINARY(16)     NOT NULL,
  created_at      DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_inventory_overhead_entry_lines_species (entry_id, species_group),
  UNIQUE KEY uq_inventory_overhead_entry_lines_cost_entry (cost_entry_id),
  CONSTRAINT ck_inventory_overhead_entry_lines_species CHECK (species_group IN ('VOLAILLE', 'PORC')),
  CONSTRAINT ck_inventory_overhead_entry_lines_amount CHECK (amount_xaf > 0),
  CONSTRAINT fk_inventory_overhead_entry_lines_entry FOREIGN KEY (entry_id) REFERENCES inventory_overhead_entries (id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_overhead_entry_lines_cost_entry FOREIGN KEY (cost_entry_id) REFERENCES inventory_cost_entries (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_inventory_overhead_entry_lines_no_update BEFORE UPDATE ON inventory_overhead_entry_lines FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_overhead_entry_lines : ligne immuable.';
END;

CREATE TRIGGER trg_inventory_overhead_entry_lines_no_delete BEFORE DELETE ON inventory_overhead_entry_lines FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_overhead_entry_lines : suppression physique interdite (INV-GLO-03).';
END;

-- Mouvements : abattage (AV-032, AV-101) et transfert entre lots (sevrage AV-111, transfert
-- entrant) comme documents sources.
ALTER TABLE inventory_stock_moves
  DROP CHECK ck_inventory_stock_moves_source_doc_type,
  ADD CONSTRAINT ck_inventory_stock_moves_source_doc_type CHECK (source_doc_type IN (
    'SALE', 'TRANSFER', 'LOSS', 'CONSUMPTION', 'INVENTORY_COUNT', 'GOODS_RECEIPT', 'EGG_COLLECTION',
    'INCUBATION_EVENT', 'LOT_ENTRY', 'SLAUGHTER', 'LOT_TRANSFER'
  ));

-- Lots de stock : origine transformation (lot propre par abattage, AV-100).
ALTER TABLE inventory_stock_lots
  DROP CHECK ck_inventory_stock_lots_origin_type,
  ADD CONSTRAINT ck_inventory_stock_lots_origin_type CHECK (origin_type IN (
    'PRODUCTION_LOT', 'INCUBATION_BATCH', 'SUPPLIER_LOT', 'COLLECTION', 'TRANSFORMATION'
  ));

-- Pertes : mortalité d'un lot d'incubation (poussins à l'éclosoir, AV-113).
ALTER TABLE inventory_loss_declarations
  ADD COLUMN incubation_batch_id BINARY(16) NULL AFTER production_lot_id,
  ADD KEY ix_inventory_loss_declarations_incubation_batch (incubation_batch_id, occurred_at);
ALTER TABLE inventory_loss_declarations
  DROP CHECK ck_inventory_loss_declarations_mortality,
  ADD CONSTRAINT ck_inventory_loss_declarations_mortality CHECK (
    category <> 'MORTALITE' OR production_lot_id IS NOT NULL OR incubation_batch_id IS NOT NULL
  );

-- Consommations : nature du coût conservée sur la consommation (une consommation de valeur
-- nulle n'a pas d'écriture de coût ; indice de consommation, AV-049).
ALTER TABLE inventory_consumptions
  ADD COLUMN cost_type VARCHAR(20) NULL AFTER cost_object_id,
  ADD CONSTRAINT ck_inventory_consumptions_cost_type CHECK (cost_type IS NULL OR cost_type IN (
    'ANIMAUX', 'OEUFS', 'ALIMENT', 'VETERINAIRE', 'AUTRE_INTRANT', 'DEPENSE_DIRECTE', 'AJUSTEMENT'
  ));

-- Emplacements : abattoir de la ferme (AV-101).
ALTER TABLE organization_locations
  DROP CHECK ck_organization_locations_type,
  ADD CONSTRAINT ck_organization_locations_type CHECK (location_type IN (
    'STORE', 'POS', 'BUILDING', 'PEN', 'INCUBATOR', 'HATCHER', 'MOBILE', 'SLAUGHTERHOUSE',
    'V_OPENING', 'V_SUPPLIER', 'V_CUSTOMER', 'V_PRODUCTION', 'V_CONSUMPTION', 'V_LOSS', 'V_PENDING_LOSS', 'V_ADJUSTMENT', 'V_TRANSIT'
  ));

-- Validation : écart d'inventaire sur des animaux (AV-108).
ALTER TABLE approvals_control_policies DROP CHECK ck_approvals_control_policies_operation_type;
ALTER TABLE approvals_control_policies ADD CONSTRAINT ck_approvals_control_policies_operation_type CHECK (operation_type IN (
  'LOSS_DECLARATION', 'MORTALITY', 'INVENTORY_ADJUSTMENT', 'TRANSFER_DISCREPANCY', 'EXPENSE',
  'PURCHASE_REQUEST', 'PURCHASE_ORDER', 'RECEIPT_WITHOUT_PO', 'RECEIPT_VALUE', 'SUPPLIER_PAYMENT',
  'PRICE_OVERRIDE', 'SALE_CANCELLATION', 'CREDIT_LIMIT_EXCEEDED', 'CASH_VARIANCE', 'CHECKIN_OVERRIDE',
  'RECEIPT_QUARANTINE', 'RECEIPT_CANCELLATION', 'ANIMAL_COUNT_ADJUSTMENT'
));

GRANT SELECT, INSERT, UPDATE ON inventory_overhead_entries TO 'gic_app'@'%';
GRANT SELECT, INSERT ON inventory_overhead_entry_lines TO 'gic_app'@'%';

-- migrate:down transaction:false
ALTER TABLE approvals_control_policies DROP CHECK ck_approvals_control_policies_operation_type;
ALTER TABLE approvals_control_policies ADD CONSTRAINT ck_approvals_control_policies_operation_type CHECK (operation_type IN (
  'LOSS_DECLARATION', 'MORTALITY', 'INVENTORY_ADJUSTMENT', 'TRANSFER_DISCREPANCY', 'EXPENSE',
  'PURCHASE_REQUEST', 'PURCHASE_ORDER', 'RECEIPT_WITHOUT_PO', 'RECEIPT_VALUE', 'SUPPLIER_PAYMENT',
  'PRICE_OVERRIDE', 'SALE_CANCELLATION', 'CREDIT_LIMIT_EXCEEDED', 'CASH_VARIANCE', 'CHECKIN_OVERRIDE',
  'RECEIPT_QUARANTINE', 'RECEIPT_CANCELLATION'
));
ALTER TABLE organization_locations
  DROP CHECK ck_organization_locations_type,
  ADD CONSTRAINT ck_organization_locations_type CHECK (location_type IN (
    'STORE', 'POS', 'BUILDING', 'PEN', 'INCUBATOR', 'HATCHER', 'MOBILE',
    'V_OPENING', 'V_SUPPLIER', 'V_CUSTOMER', 'V_PRODUCTION', 'V_CONSUMPTION', 'V_LOSS', 'V_PENDING_LOSS', 'V_ADJUSTMENT', 'V_TRANSIT'
  ));
ALTER TABLE inventory_consumptions DROP CHECK ck_inventory_consumptions_cost_type, DROP COLUMN cost_type;
ALTER TABLE inventory_loss_declarations
  DROP CHECK ck_inventory_loss_declarations_mortality,
  ADD CONSTRAINT ck_inventory_loss_declarations_mortality CHECK (category <> 'MORTALITE' OR production_lot_id IS NOT NULL);
ALTER TABLE inventory_loss_declarations DROP KEY ix_inventory_loss_declarations_incubation_batch, DROP COLUMN incubation_batch_id;
ALTER TABLE inventory_stock_lots
  DROP CHECK ck_inventory_stock_lots_origin_type,
  ADD CONSTRAINT ck_inventory_stock_lots_origin_type CHECK (origin_type IN ('PRODUCTION_LOT', 'INCUBATION_BATCH', 'SUPPLIER_LOT', 'COLLECTION'));
ALTER TABLE inventory_stock_moves
  DROP CHECK ck_inventory_stock_moves_source_doc_type,
  ADD CONSTRAINT ck_inventory_stock_moves_source_doc_type CHECK (source_doc_type IN (
    'SALE', 'TRANSFER', 'LOSS', 'CONSUMPTION', 'INVENTORY_COUNT', 'GOODS_RECEIPT', 'EGG_COLLECTION', 'INCUBATION_EVENT', 'LOT_ENTRY'
  ));
DROP TABLE inventory_overhead_entry_lines;
DROP TABLE inventory_overhead_entries;
ALTER TABLE inventory_cost_entries
  DROP CHECK ck_inventory_cost_entries_overhead_species,
  DROP CHECK ck_inventory_cost_entries_species,
  DROP CHECK ck_inventory_cost_entries_source_type,
  ADD CONSTRAINT ck_inventory_cost_entries_source_type CHECK (source_type IN ('STOCK_MOVE', 'EXPENSE', 'MANUAL')),
  DROP CHECK ck_inventory_cost_entries_cost_type,
  ADD CONSTRAINT ck_inventory_cost_entries_cost_type CHECK (cost_type IN ('ANIMAUX', 'OEUFS', 'ALIMENT', 'VETERINAIRE', 'AUTRE_INTRANT', 'DEPENSE_DIRECTE', 'AJUSTEMENT'));
ALTER TABLE inventory_cost_entries DROP COLUMN species_group;
