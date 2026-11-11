-- Reprise d'un lot en cours : déclaration en attente de validation, entrée de reprise, type de validation
-- (ADR-069, BR-PRD-016 ; AV-541 à AV-544 ; décision du porteur du 08/11/2026, Q42 réponse A).
--
-- Un lot déjà en élevage à la date d'arrêt (poulets de chair en bande, pondeuses, porcs) ne naît ni d'une réception ni
-- d'une mise en place : il est repris par une déclaration unique (effectif repris, date de mise en place réelle, valeur
-- totale déclarée) que la Direction valide, comme l'inventaire d'ouverture (BR-STK-046). Rien n'existe avant la décision
-- (ni lot, ni lot de stock, ni mouvement) ; à l'approbation, `production` crée le lot (`ACTIVE`), son lot de stock, l'entrée
-- de reprise, le mouvement `OPENING_BALANCE` et l'écriture de coût ; au refus, la déclaration est close sans effet.
--
-- 1. `production_lot_openings` : la déclaration. Son identifiant est celui du lot qui naîtra (`aggregate_id`).
-- 2. `production_lot_entries` : l'entrée de reprise est une entrée de type et d'origine `OPENING`.
-- 3. `approvals_control_policies` : nouveau type de validation `LOT_OPENING`.
--
-- Aucune donnée existante n'est touchée. Retour arrière : voir la section `down`.
--
-- migrate:up transaction:false

CREATE TABLE production_lot_openings (
  id                  BINARY(16)     NOT NULL,
  site_id             BINARY(16)     NOT NULL,
  main_location_id    BINARY(16)     NOT NULL,
  lot_type            VARCHAR(25)    NOT NULL,
  product_id          BINARY(16)     NOT NULL,
  supplier_id         BINARY(16)     NULL,
  strain              VARCHAR(100)   NULL,
  -- Jour de mise en place réel (âge du lot), pas la date de la reprise.
  placed_on           DATE           NOT NULL,
  -- Effectif repris à la date d'arrêt (INV-PRD-01 : devient `initial_quantity` du lot et l'unique entrée).
  quantity_base       DECIMAL(14,3)  NOT NULL,
  -- Valeur totale déclarée du lot, inscrite en coût `ANIMAUX` à l'approbation (AV-542).
  value_xaf           BIGINT         NOT NULL,
  avg_weight_g        DECIMAL(10,1)  NULL,
  notes               TEXT           NULL,
  status              VARCHAR(20)    NOT NULL DEFAULT 'PENDING_APPROVAL',
  approval_request_id BINARY(16)     NULL,
  -- Entrée de reprise créée à l'approbation (le lot, lui, porte l'identifiant de la déclaration).
  entry_id            BINARY(16)     NULL,
  decided_by          BINARY(16)     NULL,
  decided_at          DATETIME(6)    NULL,
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
  UNIQUE KEY uq_production_lot_openings_command (command_id),
  KEY ix_production_lot_openings_site_status (site_id, status),
  -- Recherche d'une autre reprise du même lot réel (même emplacement, même produit, même mise en place).
  KEY ix_production_lot_openings_group (main_location_id, product_id, placed_on),
  CONSTRAINT ck_production_lot_openings_type CHECK (lot_type IN (
    'POULET_CHAIR', 'PONDEUSE', 'PORC_ENGRAISSEMENT', 'REPRODUCTEUR_VOLAILLE', 'PORC_NAISSAGE'
  )),
  CONSTRAINT ck_production_lot_openings_status CHECK (status IN ('PENDING_APPROVAL', 'POSTED', 'REJECTED')),
  CONSTRAINT ck_production_lot_openings_values CHECK (quantity_base > 0 AND value_xaf >= 0),
  CONSTRAINT ck_production_lot_openings_decision CHECK (
    (status = 'PENDING_APPROVAL' AND decided_at IS NULL AND entry_id IS NULL)
    OR (status = 'POSTED' AND decided_at IS NOT NULL AND decided_by IS NOT NULL AND entry_id IS NOT NULL)
    OR (status = 'REJECTED' AND decided_at IS NOT NULL AND decided_by IS NOT NULL AND entry_id IS NULL)
  ),
  CONSTRAINT fk_production_lot_openings_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_lot_openings_location FOREIGN KEY (main_location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_lot_openings_product FOREIGN KEY (product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_lot_openings_supplier FOREIGN KEY (supplier_id) REFERENCES procurement_suppliers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_lot_openings_approval FOREIGN KEY (approval_request_id) REFERENCES approvals_approval_requests (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_lot_openings_decided_by FOREIGN KEY (decided_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_lot_openings_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_lot_openings_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_production_lot_openings_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_production_lot_openings_update_guard BEFORE UPDATE ON production_lot_openings FOR EACH ROW
BEGIN
  IF NOT (
    NEW.site_id <=> OLD.site_id AND NEW.main_location_id <=> OLD.main_location_id AND NEW.lot_type <=> OLD.lot_type AND
    NEW.product_id <=> OLD.product_id AND NEW.supplier_id <=> OLD.supplier_id AND NEW.strain <=> OLD.strain AND
    NEW.placed_on <=> OLD.placed_on AND NEW.quantity_base <=> OLD.quantity_base AND NEW.value_xaf <=> OLD.value_xaf AND
    NEW.avg_weight_g <=> OLD.avg_weight_g AND NEW.notes <=> OLD.notes AND NEW.occurred_at <=> OLD.occurred_at AND
    NEW.command_id <=> OLD.command_id AND NEW.created_at <=> OLD.created_at AND NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_lot_openings : la déclaration est immuable, seuls le statut et la décision changent.';
  END IF;
  IF OLD.status <> 'PENDING_APPROVAL' AND NOT (NEW.status <=> OLD.status) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_lot_openings : une reprise décidée ne change plus de statut.';
  END IF;
END;

CREATE TRIGGER trg_production_lot_openings_no_delete BEFORE DELETE ON production_lot_openings FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_lot_openings : suppression physique interdite (INV-GLO-03).';
END;

-- L'entrée de reprise : type et origine `OPENING` (aucune mise en place, aucune source).
ALTER TABLE production_lot_entries DROP CHECK ck_production_lot_entries_type;
ALTER TABLE production_lot_entries ADD CONSTRAINT ck_production_lot_entries_type
  CHECK (entry_type IN ('PLACEMENT', 'BIRTH', 'TRANSFER_IN', 'OPENING'));
ALTER TABLE production_lot_entries DROP CHECK ck_production_lot_entries_source;
ALTER TABLE production_lot_entries ADD CONSTRAINT ck_production_lot_entries_source
  CHECK (source_kind IN ('PURCHASE', 'INTERNAL_STOCK', 'BIRTH', 'TRANSFER', 'WEANING', 'OPENING'));

-- Type de validation de la reprise d'un lot (ADR-069 §3).
ALTER TABLE approvals_control_policies DROP CHECK ck_approvals_control_policies_operation_type;
ALTER TABLE approvals_control_policies ADD CONSTRAINT ck_approvals_control_policies_operation_type CHECK (operation_type IN (
  'LOSS_DECLARATION', 'MORTALITY', 'INVENTORY_ADJUSTMENT', 'TRANSFER_DISCREPANCY', 'EXPENSE',
  'PURCHASE_REQUEST', 'PURCHASE_ORDER', 'RECEIPT_WITHOUT_PO', 'RECEIPT_VALUE', 'SUPPLIER_PAYMENT',
  'PRICE_OVERRIDE', 'SALE_CANCELLATION', 'CREDIT_LIMIT_EXCEEDED', 'CASH_VARIANCE', 'CHECKIN_OVERRIDE',
  'RECEIPT_QUARANTINE', 'RECEIPT_CANCELLATION', 'ANIMAL_COUNT_ADJUSTMENT',
  'PAYMENT_CANCELLATION', 'PAYMENT_DUPLICATE', 'CASH_TRANSFER_DISCREPANCY', 'INVOICE_MISMATCH', 'LOT_OPENING'
));

GRANT SELECT, INSERT, UPDATE ON production_lot_openings TO 'gic_app'@'%';

-- migrate:down transaction:false
-- Défait dans l'ordre inverse. Échoue sans effet de bord sur une contrainte s'il existe une entrée `OPENING` ou une
-- politique `LOT_OPENING` (les lots repris restent alors : un retour arrière ne défait pas des faits comptabilisés).
ALTER TABLE approvals_control_policies DROP CHECK ck_approvals_control_policies_operation_type;
ALTER TABLE approvals_control_policies ADD CONSTRAINT ck_approvals_control_policies_operation_type CHECK (operation_type IN (
  'LOSS_DECLARATION', 'MORTALITY', 'INVENTORY_ADJUSTMENT', 'TRANSFER_DISCREPANCY', 'EXPENSE',
  'PURCHASE_REQUEST', 'PURCHASE_ORDER', 'RECEIPT_WITHOUT_PO', 'RECEIPT_VALUE', 'SUPPLIER_PAYMENT',
  'PRICE_OVERRIDE', 'SALE_CANCELLATION', 'CREDIT_LIMIT_EXCEEDED', 'CASH_VARIANCE', 'CHECKIN_OVERRIDE',
  'RECEIPT_QUARANTINE', 'RECEIPT_CANCELLATION', 'ANIMAL_COUNT_ADJUSTMENT',
  'PAYMENT_CANCELLATION', 'PAYMENT_DUPLICATE', 'CASH_TRANSFER_DISCREPANCY', 'INVOICE_MISMATCH'
));
ALTER TABLE production_lot_entries DROP CHECK ck_production_lot_entries_source;
ALTER TABLE production_lot_entries ADD CONSTRAINT ck_production_lot_entries_source
  CHECK (source_kind IN ('PURCHASE', 'INTERNAL_STOCK', 'BIRTH', 'TRANSFER', 'WEANING'));
ALTER TABLE production_lot_entries DROP CHECK ck_production_lot_entries_type;
ALTER TABLE production_lot_entries ADD CONSTRAINT ck_production_lot_entries_type
  CHECK (entry_type IN ('PLACEMENT', 'BIRTH', 'TRANSFER_IN'));
DROP TABLE production_lot_openings;
