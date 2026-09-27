-- Espace de noms `procurement`, documents d'achat (P6-02) : demandes d'achat, bons de commande,
-- réceptions. Source : docs/03-data/dictionnaire/08-procurement.md ; D08-APP ;
-- SM-PURCHASE-REQUEST, SM-PURCHASE-ORDER, SM-RECEIPT ; INV-APP-01 à 04, INV-STK-12.
--
-- Colonnes DÉDUITES, ajoutées au dictionnaire dans le même commit :
-- - `purchase_order_lines.excess_qty_base` : excédent accepté hors ligne au-delà du commandé
--   (BR-APP-010, `OVER_RECEIPT`) — seule façon d'exprimer en base « Σ accepté ≤ commandé, sauf
--   excédent tracé » (INV-APP-02) ;
-- - `goods_receipt_lines.over_receipt_qty_base` : part de la ligne reçue au-delà du reliquat ;
-- - `goods_receipts.posted_note_key` : clé d'unicité partielle (fournisseur, numéro de bon de
--   livraison) parmi les réceptions comptabilisées (BR-APP-012 ; conventions §4, MySQL).
--
-- migrate:up transaction:false

CREATE TABLE procurement_purchase_requests (
  id                    BINARY(16)     NOT NULL,
  doc_number            VARCHAR(40)    NOT NULL,
  local_ref             VARCHAR(20)    NULL,
  site_id               BINARY(16)     NOT NULL,
  requested_by          BINARY(16)     NOT NULL,
  needed_by_date        DATE           NULL,
  justification         TEXT           NOT NULL,
  estimated_total_xaf   BIGINT         NOT NULL DEFAULT 0,
  status                VARCHAR(20)    NOT NULL DEFAULT 'SUBMITTED',
  approval_request_id   BINARY(16)     NULL,
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
  updated_at            DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by            BINARY(16)     NULL,
  version               INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_procurement_purchase_requests_doc_number (doc_number),
  UNIQUE KEY uq_procurement_purchase_requests_command (command_id),
  UNIQUE KEY uq_procurement_purchase_requests_device_ref (created_device_id, local_ref),
  KEY ix_procurement_purchase_requests_requested_by (requested_by, occurred_at),
  KEY ix_procurement_purchase_requests_status (status, site_id),
  CONSTRAINT ck_procurement_purchase_requests_status CHECK (status IN (
    'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'PARTIALLY_ORDERED', 'ORDERED', 'CLOSED'
  )),
  CONSTRAINT ck_procurement_purchase_requests_total CHECK (estimated_total_xaf >= 0),
  CONSTRAINT fk_procurement_purchase_requests_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_purchase_requests_requested_by FOREIGN KEY (requested_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_purchase_requests_approval FOREIGN KEY (approval_request_id) REFERENCES approvals_approval_requests (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_purchase_requests_created_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_purchase_requests_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_purchase_requests_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- BR-APP-002 : une demande soumise n'est plus modifiable ; seuls son statut et sa validation
-- évoluent (SM-PURCHASE-REQUEST).
CREATE TRIGGER trg_procurement_purchase_requests_update_guard BEFORE UPDATE ON procurement_purchase_requests FOR EACH ROW
BEGIN
  IF NOT (
    NEW.doc_number <=> OLD.doc_number AND
    NEW.site_id <=> OLD.site_id AND
    NEW.requested_by <=> OLD.requested_by AND
    NEW.needed_by_date <=> OLD.needed_by_date AND
    NEW.justification <=> OLD.justification AND
    NEW.estimated_total_xaf <=> OLD.estimated_total_xaf AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_device_id <=> OLD.created_device_id AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_purchase_requests : demande soumise non modifiable ; l''annuler et en soumettre une nouvelle (BR-APP-002).';
  END IF;
END;

CREATE TRIGGER trg_procurement_purchase_requests_no_delete BEFORE DELETE ON procurement_purchase_requests FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_purchase_requests : suppression physique interdite (INV-GLO-03) ; utiliser CANCELLED.';
END;

CREATE TABLE procurement_purchase_request_lines (
  id                        BINARY(16)     NOT NULL,
  request_id                BINARY(16)     NOT NULL,
  product_id                BINARY(16)     NOT NULL,
  quantity_base             DECIMAL(14,3)  NOT NULL,
  unit_code                 VARCHAR(20)    NOT NULL,
  quantity                  DECIMAL(14,3)  NOT NULL,
  estimated_unit_price_xaf  BIGINT         NULL,
  ordered_qty_base          DECIMAL(14,3)  NOT NULL DEFAULT 0,
  notes                     TEXT           NULL,
  created_at                DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY ix_procurement_purchase_request_lines_request (request_id),
  CONSTRAINT ck_procurement_purchase_request_lines_qty CHECK (
    quantity_base > 0 AND quantity > 0 AND ordered_qty_base >= 0 AND ordered_qty_base <= quantity_base
  ),
  CONSTRAINT ck_procurement_purchase_request_lines_price CHECK (estimated_unit_price_xaf IS NULL OR estimated_unit_price_xaf >= 0),
  CONSTRAINT fk_procurement_purchase_request_lines_request FOREIGN KEY (request_id) REFERENCES procurement_purchase_requests (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_purchase_request_lines_product FOREIGN KEY (product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_purchase_request_lines_unit FOREIGN KEY (unit_code) REFERENCES catalog_units (code) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Seule la quantité commandée (dénormalisée, BR-APP-004) évolue.
CREATE TRIGGER trg_procurement_purchase_request_lines_update_guard BEFORE UPDATE ON procurement_purchase_request_lines FOR EACH ROW
BEGIN
  IF NOT (
    NEW.request_id <=> OLD.request_id AND
    NEW.product_id <=> OLD.product_id AND
    NEW.quantity_base <=> OLD.quantity_base AND
    NEW.unit_code <=> OLD.unit_code AND
    NEW.quantity <=> OLD.quantity AND
    NEW.estimated_unit_price_xaf <=> OLD.estimated_unit_price_xaf AND
    NEW.notes <=> OLD.notes AND
    NEW.created_at <=> OLD.created_at
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_purchase_request_lines : seule la quantité commandée évolue (BR-APP-002, BR-APP-004).';
  END IF;
END;

CREATE TRIGGER trg_procurement_purchase_request_lines_no_delete BEFORE DELETE ON procurement_purchase_request_lines FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_purchase_request_lines : suppression physique interdite (INV-GLO-03).';
END;

CREATE TABLE procurement_purchase_orders (
  id                          BINARY(16)     NOT NULL,
  doc_number                  VARCHAR(40)    NOT NULL,
  local_ref                   VARCHAR(20)    NULL,
  site_id                     BINARY(16)     NOT NULL,
  supplier_id                 BINARY(16)     NOT NULL,
  delivery_location_id        BINARY(16)     NOT NULL,
  expected_delivery_date      DATE           NULL,
  total_xaf                   BIGINT         NOT NULL,
  status                      VARCHAR(20)    NOT NULL DEFAULT 'DRAFT',
  approval_request_id         BINARY(16)     NULL,
  approved_by                 BINARY(16)     NULL,
  approved_at                 DATETIME(6)    NULL,
  sent_at                     DATETIME(6)    NULL,
  closed_reason               TEXT           NULL,
  cancelled_at                DATETIME(6)    NULL,
  cancelled_by                BINARY(16)     NULL,
  cancel_reason_code_id       BINARY(16)     NULL,
  cancel_comment              TEXT           NULL,
  cancel_approval_request_id  BINARY(16)     NULL,
  occurred_at                 DATETIME(6)    NOT NULL,
  command_id                  BINARY(16)     NULL,
  created_at                  DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by                  BINARY(16)     NOT NULL,
  updated_at                  DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by                  BINARY(16)     NULL,
  version                     INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_procurement_purchase_orders_doc_number (doc_number),
  UNIQUE KEY uq_procurement_purchase_orders_command (command_id),
  KEY ix_procurement_purchase_orders_supplier (supplier_id, status),
  KEY ix_procurement_purchase_orders_location (delivery_location_id, status),
  CONSTRAINT ck_procurement_purchase_orders_status CHECK (status IN (
    'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED'
  )),
  CONSTRAINT ck_procurement_purchase_orders_total CHECK (total_xaf >= 0),
  -- Envoyé ⇒ date d'envoi (SM-PURCHASE-ORDER : réception et clôture n'existent qu'après envoi).
  CONSTRAINT ck_procurement_purchase_orders_sent CHECK (
    status NOT IN ('SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED') OR sent_at IS NOT NULL
  ),
  -- [STD-CANCEL] : colonnes d'annulation renseignées si et seulement si CANCELLED.
  CONSTRAINT ck_procurement_purchase_orders_cancel CHECK (
    (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)
    OR (status <> 'CANCELLED' AND cancelled_at IS NULL AND cancelled_by IS NULL
        AND cancel_reason_code_id IS NULL AND cancel_comment IS NULL AND cancel_approval_request_id IS NULL)
  ),
  CONSTRAINT fk_procurement_purchase_orders_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_purchase_orders_supplier FOREIGN KEY (supplier_id) REFERENCES procurement_suppliers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_purchase_orders_location FOREIGN KEY (delivery_location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_purchase_orders_approval FOREIGN KEY (approval_request_id) REFERENCES approvals_approval_requests (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_purchase_orders_approved_by FOREIGN KEY (approved_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_purchase_orders_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_purchase_orders_cancel_reason FOREIGN KEY (cancel_reason_code_id) REFERENCES catalog_reason_codes (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_purchase_orders_cancel_approval FOREIGN KEY (cancel_approval_request_id) REFERENCES approvals_approval_requests (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_purchase_orders_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_purchase_orders_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- L'identité du BC (fournisseur, livraison, numéro) est fixée à la création ; seul le brouillon
-- peut encore changer de date prévue et de total (lignes) — soumis, l'approbation porte sur ce
-- montant ; au-delà, seules les transitions évoluent.
CREATE TRIGGER trg_procurement_purchase_orders_update_guard BEFORE UPDATE ON procurement_purchase_orders FOR EACH ROW
BEGIN
  IF NOT (
    NEW.doc_number <=> OLD.doc_number AND
    NEW.site_id <=> OLD.site_id AND
    NEW.supplier_id <=> OLD.supplier_id AND
    NEW.delivery_location_id <=> OLD.delivery_location_id AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_purchase_orders : fournisseur, livraison et numéro immuables ; créer un nouveau BC.';
  END IF;
  IF OLD.status <> 'DRAFT' AND NOT (
    NEW.total_xaf <=> OLD.total_xaf AND NEW.expected_delivery_date <=> OLD.expected_delivery_date
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_purchase_orders : BC approuvé ou envoyé non modifiable (BR-APP-006, INV-APP-04).';
  END IF;
END;

CREATE TRIGGER trg_procurement_purchase_orders_no_delete BEFORE DELETE ON procurement_purchase_orders FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_purchase_orders : suppression physique interdite (INV-GLO-03) ; utiliser CANCELLED.';
END;

CREATE TABLE procurement_purchase_order_lines (
  id                  BINARY(16)     NOT NULL,
  order_id            BINARY(16)     NOT NULL,
  line_no             SMALLINT       NOT NULL,
  request_line_id     BINARY(16)     NULL,
  product_id          BINARY(16)     NOT NULL,
  unit_code           VARCHAR(20)    NOT NULL,
  ordered_qty_base    DECIMAL(14,3)  NOT NULL,
  unit_price_xaf      BIGINT         NOT NULL,
  line_total_xaf      BIGINT         NOT NULL,
  accepted_qty_base   DECIMAL(14,3)  NOT NULL DEFAULT 0,
  invoiced_qty_base   DECIMAL(14,3)  NOT NULL DEFAULT 0,
  closed_qty_base     DECIMAL(14,3)  NOT NULL DEFAULT 0,
  excess_qty_base     DECIMAL(14,3)  NOT NULL DEFAULT 0,
  status              VARCHAR(12)    NOT NULL DEFAULT 'OPEN',
  created_at          DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_procurement_purchase_order_lines_line_no (order_id, line_no),
  KEY ix_procurement_purchase_order_lines_request_line (request_line_id),
  KEY ix_procurement_purchase_order_lines_product (product_id),
  CONSTRAINT ck_procurement_purchase_order_lines_status CHECK (status IN ('OPEN', 'RECEIVED', 'CLOSED', 'CANCELLED')),
  CONSTRAINT ck_procurement_purchase_order_lines_amounts CHECK (
    ordered_qty_base > 0 AND unit_price_xaf >= 0 AND line_total_xaf >= 0
    AND accepted_qty_base >= 0 AND invoiced_qty_base >= 0 AND closed_qty_base >= 0 AND excess_qty_base >= 0
  ),
  -- INV-APP-02 : Σ accepté ≤ commandé, sauf excédent tracé en revue (OVER_RECEIPT).
  CONSTRAINT ck_procurement_purchase_order_lines_received CHECK (
    accepted_qty_base + closed_qty_base <= ordered_qty_base + excess_qty_base
  ),
  CONSTRAINT fk_procurement_purchase_order_lines_order FOREIGN KEY (order_id) REFERENCES procurement_purchase_orders (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_purchase_order_lines_request_line FOREIGN KEY (request_line_id) REFERENCES procurement_purchase_request_lines (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_purchase_order_lines_product FOREIGN KEY (product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_purchase_order_lines_unit FOREIGN KEY (unit_code) REFERENCES catalog_units (code) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- INV-APP-04 : les lignes d'un BC envoyé (ou au-delà) ne sont jamais augmentées ; l'identité
-- d'une ligne est immuable.
CREATE TRIGGER trg_procurement_purchase_order_lines_update_guard BEFORE UPDATE ON procurement_purchase_order_lines FOR EACH ROW
BEGIN
  IF NOT (
    NEW.order_id <=> OLD.order_id AND
    NEW.line_no <=> OLD.line_no AND
    NEW.request_line_id <=> OLD.request_line_id AND
    NEW.product_id <=> OLD.product_id AND
    NEW.unit_code <=> OLD.unit_code AND
    NEW.created_at <=> OLD.created_at
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_purchase_order_lines : produit et rattachement d''une ligne immuables.';
  END IF;
  IF (NEW.ordered_qty_base > OLD.ordered_qty_base OR NEW.unit_price_xaf > OLD.unit_price_xaf)
     AND (SELECT status FROM procurement_purchase_orders WHERE id = NEW.order_id)
         IN ('SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_purchase_order_lines : ligne d''un BC envoyé jamais augmentée (INV-APP-04) ; créer un nouveau BC.';
  END IF;
END;

CREATE TRIGGER trg_procurement_purchase_order_lines_no_delete BEFORE DELETE ON procurement_purchase_order_lines FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_purchase_order_lines : suppression physique interdite (INV-GLO-03) ; utiliser CANCELLED.';
END;

CREATE TABLE procurement_goods_receipts (
  id                          BINARY(16)     NOT NULL,
  doc_number                  VARCHAR(40)    NOT NULL,
  local_ref                   VARCHAR(20)    NULL,
  site_id                     BINARY(16)     NOT NULL,
  purchase_order_id           BINARY(16)     NULL,
  supplier_id                 BINARY(16)     NOT NULL,
  location_id                 BINARY(16)     NOT NULL,
  received_by                 BINARY(16)     NOT NULL,
  supplier_delivery_note_ref  VARCHAR(60)    NULL,
  observations                TEXT           NULL,
  status                      VARCHAR(25)    NOT NULL,
  approval_request_id         BINARY(16)     NULL,
  total_accepted_value_xaf    BIGINT         NOT NULL DEFAULT 0,
  -- BR-APP-012 : (fournisseur, bon de livraison) unique parmi les réceptions comptabilisées
  -- (stock entré ou en cours d'annulation) ; une réception en quarantaine, rejetée ou annulée
  -- ne compte pas.
  posted_note_key             VARCHAR(100)   GENERATED ALWAYS AS (
    CASE WHEN supplier_delivery_note_ref IS NOT NULL
          AND status IN ('POSTED', 'POSTED_PENDING_REVIEW', 'REVIEW_REJECTED', 'CANCELLATION_PENDING')
         THEN CONCAT(HEX(supplier_id), ':', supplier_delivery_note_ref) END
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
  updated_at                  DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by                  BINARY(16)     NULL,
  version                     INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_procurement_goods_receipts_doc_number (doc_number),
  UNIQUE KEY uq_procurement_goods_receipts_command (command_id),
  UNIQUE KEY uq_procurement_goods_receipts_device_ref (created_device_id, local_ref),
  UNIQUE KEY uq_procurement_goods_receipts_posted_note (posted_note_key),
  KEY ix_procurement_goods_receipts_order (purchase_order_id),
  KEY ix_procurement_goods_receipts_location (location_id, occurred_at),
  KEY ix_procurement_goods_receipts_supplier_note (supplier_id, supplier_delivery_note_ref),
  KEY ix_procurement_goods_receipts_status (status, site_id),
  CONSTRAINT ck_procurement_goods_receipts_status CHECK (status IN (
    'POSTED', 'POSTED_PENDING_REVIEW', 'REVIEW_REJECTED', 'QUARANTINED', 'REJECTED', 'CANCELLATION_PENDING', 'CANCELLED'
  )),
  CONSTRAINT ck_procurement_goods_receipts_value CHECK (total_accepted_value_xaf >= 0),
  CONSTRAINT ck_procurement_goods_receipts_cancel CHECK (
    (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)
    OR (status <> 'CANCELLED' AND cancelled_at IS NULL AND cancelled_by IS NULL
        AND cancel_reason_code_id IS NULL AND cancel_comment IS NULL)
  ),
  CONSTRAINT fk_procurement_goods_receipts_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_goods_receipts_order FOREIGN KEY (purchase_order_id) REFERENCES procurement_purchase_orders (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_goods_receipts_supplier FOREIGN KEY (supplier_id) REFERENCES procurement_suppliers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_goods_receipts_location FOREIGN KEY (location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_goods_receipts_received_by FOREIGN KEY (received_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_goods_receipts_approval FOREIGN KEY (approval_request_id) REFERENCES approvals_approval_requests (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_goods_receipts_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_goods_receipts_cancel_reason FOREIGN KEY (cancel_reason_code_id) REFERENCES catalog_reason_codes (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_goods_receipts_cancel_approval FOREIGN KEY (cancel_approval_request_id) REFERENCES approvals_approval_requests (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_goods_receipts_created_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_goods_receipts_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_goods_receipts_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Une réception est un fait : seuls son statut, sa validation et son annulation évoluent.
CREATE TRIGGER trg_procurement_goods_receipts_update_guard BEFORE UPDATE ON procurement_goods_receipts FOR EACH ROW
BEGIN
  IF NOT (
    NEW.doc_number <=> OLD.doc_number AND
    NEW.site_id <=> OLD.site_id AND
    NEW.purchase_order_id <=> OLD.purchase_order_id AND
    NEW.supplier_id <=> OLD.supplier_id AND
    NEW.location_id <=> OLD.location_id AND
    NEW.received_by <=> OLD.received_by AND
    NEW.supplier_delivery_note_ref <=> OLD.supplier_delivery_note_ref AND
    NEW.observations <=> OLD.observations AND
    NEW.total_accepted_value_xaf <=> OLD.total_accepted_value_xaf AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_device_id <=> OLD.created_device_id AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_goods_receipts : réception non modifiable ; seuls statut, validation et annulation évoluent.';
  END IF;
END;

CREATE TRIGGER trg_procurement_goods_receipts_no_delete BEFORE DELETE ON procurement_goods_receipts FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_goods_receipts : suppression physique interdite (INV-GLO-03) ; annuler par contre-écriture.';
END;

CREATE TABLE procurement_goods_receipt_lines (
  id                         BINARY(16)     NOT NULL,
  receipt_id                 BINARY(16)     NOT NULL,
  po_line_id                 BINARY(16)     NULL,
  product_id                 BINARY(16)     NOT NULL,
  unit_code                  VARCHAR(20)    NOT NULL,
  qty_delivered_base         DECIMAL(14,3)  NOT NULL,
  qty_rejected_base          DECIMAL(14,3)  NOT NULL DEFAULT 0,
  -- INV-APP-01 : accepté = livré − rejeté, calculé par la base.
  qty_accepted_base          DECIMAL(14,3)  GENERATED ALWAYS AS (qty_delivered_base - qty_rejected_base) STORED,
  over_receipt_qty_base      DECIMAL(14,3)  NOT NULL DEFAULT 0,
  rejection_reason_code_id   BINARY(16)     NULL,
  unit_cost_xaf              BIGINT         NOT NULL,
  supplier_lot_ref           VARCHAR(60)    NULL,
  expiry_date                DATE           NULL,
  stock_lot_id               BINARY(16)     NULL,
  created_at                 DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY ix_procurement_goods_receipt_lines_receipt (receipt_id),
  KEY ix_procurement_goods_receipt_lines_po_line (po_line_id),
  CONSTRAINT ck_procurement_goods_receipt_lines_qty CHECK (
    qty_delivered_base > 0 AND qty_rejected_base >= 0 AND qty_rejected_base <= qty_delivered_base
    AND over_receipt_qty_base >= 0 AND over_receipt_qty_base <= qty_delivered_base - qty_rejected_base
  ),
  -- D08 §8 : motif présent si une quantité est rejetée (REJECTION_REASON_REQUIRED).
  CONSTRAINT ck_procurement_goods_receipt_lines_rejection CHECK (qty_rejected_base = 0 OR rejection_reason_code_id IS NOT NULL),
  CONSTRAINT ck_procurement_goods_receipt_lines_cost CHECK (unit_cost_xaf >= 0),
  CONSTRAINT fk_procurement_goods_receipt_lines_receipt FOREIGN KEY (receipt_id) REFERENCES procurement_goods_receipts (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_goods_receipt_lines_po_line FOREIGN KEY (po_line_id) REFERENCES procurement_purchase_order_lines (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_goods_receipt_lines_product FOREIGN KEY (product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_goods_receipt_lines_unit FOREIGN KEY (unit_code) REFERENCES catalog_units (code) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_goods_receipt_lines_rejection_reason FOREIGN KEY (rejection_reason_code_id) REFERENCES catalog_reason_codes (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_goods_receipt_lines_stock_lot FOREIGN KEY (stock_lot_id) REFERENCES inventory_stock_lots (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Seul le lot de stock (créé à la comptabilisation, éventuellement après une quarantaine) est
-- renseigné après coup.
CREATE TRIGGER trg_procurement_goods_receipt_lines_update_guard BEFORE UPDATE ON procurement_goods_receipt_lines FOR EACH ROW
BEGIN
  IF NOT (
    NEW.receipt_id <=> OLD.receipt_id AND
    NEW.po_line_id <=> OLD.po_line_id AND
    NEW.product_id <=> OLD.product_id AND
    NEW.unit_code <=> OLD.unit_code AND
    NEW.qty_delivered_base <=> OLD.qty_delivered_base AND
    NEW.qty_rejected_base <=> OLD.qty_rejected_base AND
    NEW.over_receipt_qty_base <=> OLD.over_receipt_qty_base AND
    NEW.rejection_reason_code_id <=> OLD.rejection_reason_code_id AND
    NEW.unit_cost_xaf <=> OLD.unit_cost_xaf AND
    NEW.supplier_lot_ref <=> OLD.supplier_lot_ref AND
    NEW.expiry_date <=> OLD.expiry_date AND
    NEW.created_at <=> OLD.created_at
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_goods_receipt_lines : ligne de réception immuable (seul le lot de stock se renseigne).';
  END IF;
END;

CREATE TRIGGER trg_procurement_goods_receipt_lines_no_delete BEFORE DELETE ON procurement_goods_receipt_lines FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_goods_receipt_lines : suppression physique interdite (INV-GLO-03).';
END;

-- Catalogue fermé des types d'opération (approvals, operation-types.ts) : réceptions en
-- quarantaine et annulations de réception (D08 §11).
ALTER TABLE approvals_control_policies DROP CHECK ck_approvals_control_policies_operation_type;
ALTER TABLE approvals_control_policies ADD CONSTRAINT ck_approvals_control_policies_operation_type CHECK (operation_type IN (
  'LOSS_DECLARATION', 'MORTALITY', 'INVENTORY_ADJUSTMENT', 'TRANSFER_DISCREPANCY', 'EXPENSE',
  'PURCHASE_REQUEST', 'PURCHASE_ORDER', 'RECEIPT_WITHOUT_PO', 'RECEIPT_VALUE', 'SUPPLIER_PAYMENT',
  'PRICE_OVERRIDE', 'SALE_CANCELLATION', 'CREDIT_LIMIT_EXCEEDED', 'CASH_VARIANCE', 'CHECKIN_OVERRIDE',
  'RECEIPT_QUARANTINE', 'RECEIPT_CANCELLATION'
));

-- Droits par table (INV-GLO-05) : aucune suppression.
GRANT SELECT, INSERT, UPDATE ON procurement_purchase_requests TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON procurement_purchase_request_lines TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON procurement_purchase_orders TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON procurement_purchase_order_lines TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON procurement_goods_receipts TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON procurement_goods_receipt_lines TO 'gic_app'@'%';

-- migrate:down transaction:false
ALTER TABLE approvals_control_policies DROP CHECK ck_approvals_control_policies_operation_type;
ALTER TABLE approvals_control_policies ADD CONSTRAINT ck_approvals_control_policies_operation_type CHECK (operation_type IN (
  'LOSS_DECLARATION', 'MORTALITY', 'INVENTORY_ADJUSTMENT', 'TRANSFER_DISCREPANCY', 'EXPENSE',
  'PURCHASE_REQUEST', 'PURCHASE_ORDER', 'RECEIPT_WITHOUT_PO', 'RECEIPT_VALUE', 'SUPPLIER_PAYMENT',
  'PRICE_OVERRIDE', 'SALE_CANCELLATION', 'CREDIT_LIMIT_EXCEEDED', 'CASH_VARIANCE', 'CHECKIN_OVERRIDE'
));
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS procurement_goods_receipt_lines;
DROP TABLE IF EXISTS procurement_goods_receipts;
DROP TABLE IF EXISTS procurement_purchase_order_lines;
DROP TABLE IF EXISTS procurement_purchase_orders;
DROP TABLE IF EXISTS procurement_purchase_request_lines;
DROP TABLE IF EXISTS procurement_purchase_requests;
SET FOREIGN_KEY_CHECKS = 1;
