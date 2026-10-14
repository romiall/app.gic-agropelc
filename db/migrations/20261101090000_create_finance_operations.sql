-- Module `finance`, finance opérationnelle (P8-03) : catégories de dépense, dépenses, factures
-- fournisseurs et leurs lignes, paiements fournisseurs et leurs affectations, vue des dettes.
-- Source : docs/03-data/dictionnaire/09-finance.md ; D09 BR-FIN-020 à 022, 030 à 033 ; SM-EXPENSE,
-- SM-SUPPLIER-INVOICE, SM-SUPPLIER-PAYMENT ; INV-FIN-07 ; ADR-042, ADR-043 ; AV-263 à AV-279.
--
-- Principes portés par le schéma :
-- - rien ne disparaît (ADR-006) : aucune suppression ; les données d'origine d'un document sont
--   immuables, seuls son statut et ses données de décision, de paiement et d'annulation évoluent ;
-- - INV-FIN-07 : `paid_xaf` d'une facture (Σ des affectations actives, dénormalisé) reste entre 0 et
--   son total ; une affectation ne change que vers `ACTIVE` ou `REVERSED` ;
-- - la référence fournisseur est unique parmi les factures non annulées (colonne générée) : la
--   facture rectificative d'un avoir peut reprendre la référence de la facture annulée (AV-272) ;
-- - les états sont vérifiés par CHECK ; les déclencheurs ne sont qu'un filet (le code décide).
-- migrate:up transaction:false

-- Catégories de dépense (AV-058, AV-270) : `is_system` marque `NON_JUSTIFIEE` (BR-FIN-022).
CREATE TABLE finance_expense_categories (
  id                      BINARY(16)     NOT NULL,
  code                    VARCHAR(40)    NOT NULL,
  label                   VARCHAR(120)   NOT NULL,
  default_cost_type       VARCHAR(25)    NULL,
  allowed_on_pos          BOOLEAN        NOT NULL DEFAULT FALSE,
  is_system               BOOLEAN        NOT NULL DEFAULT FALSE,
  is_active               BOOLEAN        NOT NULL DEFAULT TRUE,
  status_reason           VARCHAR(500)   NULL,
  created_at              DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by              BINARY(16)     NOT NULL,
  updated_at              DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by              BINARY(16)     NULL,
  version                 INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_finance_expense_categories_code (code),
  CONSTRAINT ck_finance_expense_categories_cost_type CHECK (
    default_cost_type IS NULL OR default_cost_type IN ('VETERINAIRE', 'ALIMENT', 'AUTRE_INTRANT', 'DEPENSE_DIRECTE')
  ),
  -- Une catégorie système n'est jamais permise au PDV (elle n'est jamais saisie).
  CONSTRAINT ck_finance_expense_categories_system CHECK (NOT (is_system AND allowed_on_pos)),
  CONSTRAINT fk_finance_expense_categories_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_expense_categories_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_finance_expense_categories_update_guard BEFORE UPDATE ON finance_expense_categories FOR EACH ROW
BEGIN
  IF NOT (NEW.code <=> OLD.code AND NEW.is_system <=> OLD.is_system AND NEW.created_at <=> OLD.created_at
          AND NEW.created_by <=> OLD.created_by) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_expense_categories : code et nature système immuables.';
  END IF;
END;

CREATE TRIGGER trg_finance_expense_categories_no_delete BEFORE DELETE ON finance_expense_categories FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_expense_categories : suppression interdite ; désactiver la catégorie.';
END;

-- Dépense (SM-EXPENSE ; BR-FIN-020 à 022 ; ADR-042).
CREATE TABLE finance_expenses (
  id                        BINARY(16)     NOT NULL,
  doc_number                VARCHAR(40)    NOT NULL,
  local_ref                 VARCHAR(20)    NULL,
  site_id                   BINARY(16)     NOT NULL,
  category_id               BINARY(16)     NOT NULL,
  amount_xaf                BIGINT         NOT NULL,
  payee_name                VARCHAR(120)   NULL,
  supplier_id               BINARY(16)     NULL,
  description               VARCHAR(1000)  NOT NULL,
  -- Objet de coût (ADR-042 §8) ; l'espèce ne vaut que pour un site (frais généraux, AV-269).
  cost_object_type          VARCHAR(20)    NULL,
  cost_object_id            BINARY(16)     NULL,
  species_group             VARCHAR(10)    NULL,
  paid_now                  BOOLEAN        NOT NULL,
  paid_from_account_id      BINARY(16)     NULL,
  paid_at                   DATETIME(6)    NULL,
  paid_by                   BINARY(16)     NULL,
  cash_movement_id          BINARY(16)     NULL,
  status                    VARCHAR(25)    NOT NULL,
  -- Motifs de revue d'une saisie hors ligne non conforme (ADR-042 §6, AV-265) : tableau JSON.
  review_reasons            JSON           NULL,
  approval_request_id       BINARY(16)     NULL,
  -- Rejet après paiement (BR-FIN-022, AV-268) : catégorie système et déclarant responsable.
  reclassified_category_id  BINARY(16)     NULL,
  responsibility_user_id    BINARY(16)     NULL,
  cancel_reason             VARCHAR(500)   NULL,
  cancelled_by              BINARY(16)     NULL,
  cancelled_at              DATETIME(6)    NULL,
  occurred_at               DATETIME(6)    NOT NULL,
  business_date             DATE           GENERATED ALWAYS AS (CAST(CONVERT_TZ(occurred_at, '+00:00', '+01:00') AS DATE)) STORED,
  command_id                BINARY(16)     NULL,
  client_created_at         DATETIME(6)    NULL,
  received_at_server        DATETIME(6)    NULL,
  created_device_id         BINARY(16)     NULL,
  captured_offline          BOOLEAN        NOT NULL DEFAULT FALSE,
  clock_suspect             BOOLEAN        NOT NULL DEFAULT FALSE,
  backdated_reason          TEXT           NULL,
  created_at                DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by                BINARY(16)     NOT NULL,
  updated_at                DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by                BINARY(16)     NULL,
  version                   INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_finance_expenses_doc_number (doc_number),
  UNIQUE KEY uq_finance_expenses_device_ref (created_device_id, local_ref),
  UNIQUE KEY uq_finance_expenses_command (command_id),
  UNIQUE KEY uq_finance_expenses_cash_movement (cash_movement_id),
  KEY ix_finance_expenses_category_day (category_id, business_date),
  KEY ix_finance_expenses_cost_object (cost_object_type, cost_object_id),
  KEY ix_finance_expenses_site_day (site_id, business_date),
  KEY ix_finance_expenses_author_day (created_by, business_date),
  KEY ix_finance_expenses_status (status, business_date),
  CONSTRAINT ck_finance_expenses_status CHECK (status IN (
    'RECORDED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'PAID', 'PAID_PENDING_APPROVAL', 'PAID_REJECTED', 'CANCELLED'
  )),
  CONSTRAINT ck_finance_expenses_amount CHECK (amount_xaf > 0),
  CONSTRAINT ck_finance_expenses_cost_object CHECK (
    (cost_object_type IS NULL AND cost_object_id IS NULL AND species_group IS NULL)
    OR (cost_object_type IN ('PRODUCTION_LOT', 'INCUBATION_BATCH', 'SITE') AND cost_object_id IS NOT NULL)
  ),
  CONSTRAINT ck_finance_expenses_species CHECK (
    species_group IS NULL OR (cost_object_type = 'SITE' AND species_group IN ('VOLAILLE', 'PORC'))
  ),
  -- Payée ⇔ compte, date, auteur et mouvement ; payée immédiatement ⇒ payée.
  CONSTRAINT ck_finance_expenses_paid CHECK (
    (paid_at IS NULL AND paid_from_account_id IS NULL AND paid_by IS NULL AND cash_movement_id IS NULL)
    OR (paid_at IS NOT NULL AND paid_from_account_id IS NOT NULL AND paid_by IS NOT NULL AND cash_movement_id IS NOT NULL)
  ),
  CONSTRAINT ck_finance_expenses_paid_now CHECK (NOT paid_now OR paid_at IS NOT NULL),
  CONSTRAINT ck_finance_expenses_state CHECK (
    ((status IN ('PAID', 'PAID_PENDING_APPROVAL', 'PAID_REJECTED')) = (paid_at IS NOT NULL))
    AND (status NOT IN ('PENDING_APPROVAL', 'PAID_PENDING_APPROVAL') OR approval_request_id IS NOT NULL)
    AND ((status = 'PAID_REJECTED') = (reclassified_category_id IS NOT NULL AND responsibility_user_id IS NOT NULL))
    AND ((status = 'CANCELLED') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancel_reason IS NOT NULL))
  ),
  CONSTRAINT fk_finance_expenses_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_expenses_category FOREIGN KEY (category_id) REFERENCES finance_expense_categories (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_expenses_supplier FOREIGN KEY (supplier_id) REFERENCES procurement_suppliers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_expenses_account FOREIGN KEY (paid_from_account_id) REFERENCES finance_cash_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_expenses_paid_by FOREIGN KEY (paid_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_expenses_movement FOREIGN KEY (cash_movement_id) REFERENCES finance_cash_movements (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_expenses_approval FOREIGN KEY (approval_request_id) REFERENCES approvals_approval_requests (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_expenses_reclassified FOREIGN KEY (reclassified_category_id) REFERENCES finance_expense_categories (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_expenses_responsibility FOREIGN KEY (responsibility_user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_expenses_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_expenses_created_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_expenses_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_expenses_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_finance_expenses_update_guard BEFORE UPDATE ON finance_expenses FOR EACH ROW
BEGIN
  IF NOT (
    NEW.doc_number <=> OLD.doc_number AND
    NEW.local_ref <=> OLD.local_ref AND
    NEW.site_id <=> OLD.site_id AND
    NEW.category_id <=> OLD.category_id AND
    NEW.amount_xaf <=> OLD.amount_xaf AND
    NEW.payee_name <=> OLD.payee_name AND
    NEW.supplier_id <=> OLD.supplier_id AND
    NEW.description <=> OLD.description AND
    NEW.cost_object_type <=> OLD.cost_object_type AND
    NEW.cost_object_id <=> OLD.cost_object_id AND
    NEW.species_group <=> OLD.species_group AND
    NEW.paid_now <=> OLD.paid_now AND
    NEW.review_reasons <=> OLD.review_reasons AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.command_id <=> OLD.command_id AND
    NEW.client_created_at <=> OLD.client_created_at AND
    NEW.received_at_server <=> OLD.received_at_server AND
    NEW.created_device_id <=> OLD.created_device_id AND
    NEW.captured_offline <=> OLD.captured_offline AND
    NEW.clock_suspect <=> OLD.clock_suspect AND
    NEW.backdated_reason <=> OLD.backdated_reason AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_expenses : saisie immuable ; seuls décision, paiement et annulation évoluent.';
  END IF;
  IF OLD.paid_at IS NOT NULL AND NOT (
    NEW.paid_at <=> OLD.paid_at AND NEW.paid_from_account_id <=> OLD.paid_from_account_id AND
    NEW.paid_by <=> OLD.paid_by AND NEW.cash_movement_id <=> OLD.cash_movement_id
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_expenses : paiement immuable.';
  END IF;
  IF OLD.status IN ('REJECTED', 'PAID', 'PAID_REJECTED', 'CANCELLED') AND NOT (
    NEW.status <=> OLD.status AND NEW.reclassified_category_id <=> OLD.reclassified_category_id AND
    NEW.responsibility_user_id <=> OLD.responsibility_user_id AND NEW.cancelled_at <=> OLD.cancelled_at AND
    NEW.approval_request_id <=> OLD.approval_request_id
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_expenses : état terminal.';
  END IF;
END;

CREATE TRIGGER trg_finance_expenses_no_delete BEFORE DELETE ON finance_expenses FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_expenses : suppression interdite ; annuler la dépense (ADR-006).';
END;

-- Facture fournisseur (SM-SUPPLIER-INVOICE ; BR-FIN-030, 031 ; ADR-043). En ligne seulement.
CREATE TABLE finance_supplier_invoices (
  id                      BINARY(16)     NOT NULL,
  doc_number              VARCHAR(40)    NOT NULL,
  -- Site du BC, s'il existe (série globale `FF`, ADR-043 §10).
  site_id                 BINARY(16)     NULL,
  supplier_id             BINARY(16)     NOT NULL,
  supplier_invoice_ref    VARCHAR(60)    NOT NULL,
  invoice_date            DATE           NOT NULL,
  due_date                DATE           NOT NULL,
  purchase_order_id       BINARY(16)     NULL,
  total_xaf               BIGINT         NOT NULL,
  printed_total_xaf       BIGINT         NULL,
  tax_total_xaf           BIGINT         NOT NULL DEFAULT 0,
  paid_xaf                BIGINT         NOT NULL DEFAULT 0,
  status                  VARCHAR(20)    NOT NULL,
  mismatch_details        JSON           NULL,
  approval_request_id     BINARY(16)     NULL,
  approved_by             BINARY(16)     NULL,
  approved_at             DATETIME(6)    NULL,
  approval_reason         VARCHAR(500)   NULL,
  disputed_by             BINARY(16)     NULL,
  disputed_at             DATETIME(6)    NULL,
  dispute_reason          VARCHAR(500)   NULL,
  comment                 VARCHAR(500)   NULL,
  cancel_reason           VARCHAR(500)   NULL,
  cancelled_by            BINARY(16)     NULL,
  cancelled_at            DATETIME(6)    NULL,
  -- Unicité de la référence parmi les factures non annulées (AV-272).
  active_ref_key          VARCHAR(60)    GENERATED ALWAYS AS (CASE WHEN status <> 'CANCELLED' THEN supplier_invoice_ref END) STORED,
  occurred_at             DATETIME(6)    NOT NULL,
  command_id              BINARY(16)     NULL,
  created_at              DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by              BINARY(16)     NOT NULL,
  updated_at              DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by              BINARY(16)     NULL,
  version                 INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_finance_supplier_invoices_doc_number (doc_number),
  UNIQUE KEY uq_finance_supplier_invoices_active_ref (supplier_id, active_ref_key),
  UNIQUE KEY uq_finance_supplier_invoices_command (command_id),
  KEY ix_finance_supplier_invoices_supplier (supplier_id, status, due_date),
  KEY ix_finance_supplier_invoices_order (purchase_order_id),
  KEY ix_finance_supplier_invoices_status (status, due_date),
  CONSTRAINT ck_finance_supplier_invoices_status CHECK (status IN (
    'MISMATCH', 'DISPUTED', 'APPROVED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED'
  )),
  -- INV-FIN-07 : le payé reste entre 0 et le total.
  CONSTRAINT ck_finance_supplier_invoices_amounts CHECK (
    total_xaf >= 0 AND tax_total_xaf >= 0 AND paid_xaf >= 0 AND paid_xaf <= total_xaf
    AND (printed_total_xaf IS NULL OR printed_total_xaf >= 0)
  ),
  CONSTRAINT ck_finance_supplier_invoices_dates CHECK (due_date >= invoice_date),
  CONSTRAINT ck_finance_supplier_invoices_state CHECK (
    (status NOT IN ('APPROVED', 'PARTIALLY_PAID', 'PAID') OR (approved_at IS NOT NULL AND approved_by IS NOT NULL))
    AND (status <> 'DISPUTED' OR disputed_at IS NOT NULL)
    AND ((status = 'CANCELLED') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancel_reason IS NOT NULL))
    AND (status <> 'APPROVED' OR paid_xaf = 0)
    AND (status <> 'PARTIALLY_PAID' OR (paid_xaf > 0 AND paid_xaf < total_xaf))
    AND (status <> 'PAID' OR paid_xaf = total_xaf)
    AND (status IN ('APPROVED', 'PARTIALLY_PAID', 'PAID') OR paid_xaf = 0)
  ),
  CONSTRAINT fk_finance_supplier_invoices_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_supplier_invoices_supplier FOREIGN KEY (supplier_id) REFERENCES procurement_suppliers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_supplier_invoices_order FOREIGN KEY (purchase_order_id) REFERENCES procurement_purchase_orders (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_supplier_invoices_approval FOREIGN KEY (approval_request_id) REFERENCES approvals_approval_requests (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_supplier_invoices_approved_by FOREIGN KEY (approved_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_supplier_invoices_disputed_by FOREIGN KEY (disputed_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_supplier_invoices_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_supplier_invoices_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_supplier_invoices_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_finance_supplier_invoices_update_guard BEFORE UPDATE ON finance_supplier_invoices FOR EACH ROW
BEGIN
  IF NOT (
    NEW.doc_number <=> OLD.doc_number AND
    NEW.site_id <=> OLD.site_id AND
    NEW.supplier_id <=> OLD.supplier_id AND
    NEW.supplier_invoice_ref <=> OLD.supplier_invoice_ref AND
    NEW.invoice_date <=> OLD.invoice_date AND
    NEW.due_date <=> OLD.due_date AND
    NEW.purchase_order_id <=> OLD.purchase_order_id AND
    NEW.total_xaf <=> OLD.total_xaf AND
    NEW.printed_total_xaf <=> OLD.printed_total_xaf AND
    NEW.tax_total_xaf <=> OLD.tax_total_xaf AND
    NEW.mismatch_details <=> OLD.mismatch_details AND
    NEW.comment <=> OLD.comment AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_supplier_invoices : facture immuable ; seuls décision, payé et annulation évoluent.';
  END IF;
  IF OLD.status = 'CANCELLED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_supplier_invoices : facture annulée, état terminal.';
  END IF;
END;

CREATE TRIGGER trg_finance_supplier_invoices_no_delete BEFORE DELETE ON finance_supplier_invoices FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_supplier_invoices : suppression interdite ; annuler la facture (ADR-006).';
END;

-- Lignes d'une facture (BR-FIN-030) : rattachées à une ligne de BC ou de réception, ou libres.
CREATE TABLE finance_supplier_invoice_lines (
  id                      BINARY(16)     NOT NULL,
  invoice_id              BINARY(16)     NOT NULL,
  line_no                 SMALLINT       NOT NULL,
  po_line_id              BINARY(16)     NULL,
  receipt_line_id         BINARY(16)     NULL,
  product_id              BINARY(16)     NULL,
  description             VARCHAR(200)   NOT NULL,
  quantity_base           DECIMAL(14,3)  NULL,
  unit_price_xaf          BIGINT         NULL,
  line_total_xaf          BIGINT         NOT NULL,
  created_at              DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_finance_supplier_invoice_lines_no (invoice_id, line_no),
  KEY ix_finance_supplier_invoice_lines_po_line (po_line_id),
  KEY ix_finance_supplier_invoice_lines_receipt_line (receipt_line_id),
  CONSTRAINT ck_finance_supplier_invoice_lines_amounts CHECK (
    line_no > 0 AND line_total_xaf >= 0 AND (unit_price_xaf IS NULL OR unit_price_xaf >= 0)
    AND (quantity_base IS NULL OR quantity_base > 0)
  ),
  -- Une ligne de BC est chiffrée (quantité et prix), pour le rapprochement.
  CONSTRAINT ck_finance_supplier_invoice_lines_po CHECK (
    po_line_id IS NULL OR (quantity_base IS NOT NULL AND unit_price_xaf IS NOT NULL)
  ),
  CONSTRAINT fk_finance_supplier_invoice_lines_invoice FOREIGN KEY (invoice_id) REFERENCES finance_supplier_invoices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_supplier_invoice_lines_po_line FOREIGN KEY (po_line_id) REFERENCES procurement_purchase_order_lines (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_supplier_invoice_lines_receipt_line FOREIGN KEY (receipt_line_id) REFERENCES procurement_goods_receipt_lines (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_supplier_invoice_lines_product FOREIGN KEY (product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_finance_supplier_invoice_lines_no_update BEFORE UPDATE ON finance_supplier_invoice_lines FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_supplier_invoice_lines : lignes immuables ; annuler la facture.';
END;

CREATE TRIGGER trg_finance_supplier_invoice_lines_no_delete BEFORE DELETE ON finance_supplier_invoice_lines FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_supplier_invoice_lines : suppression interdite.';
END;

-- Paiement fournisseur (SM-SUPPLIER-PAYMENT ; BR-FIN-032, 033 ; ADR-043 §6 et §7). En ligne seulement.
CREATE TABLE finance_supplier_payments (
  id                      BINARY(16)     NOT NULL,
  doc_number              VARCHAR(40)    NOT NULL,
  site_id                 BINARY(16)     NULL,
  supplier_id             BINARY(16)     NOT NULL,
  amount_xaf              BIGINT         NOT NULL,
  payment_method_code     VARCHAR(40)    NOT NULL,
  from_account_id         BINARY(16)     NOT NULL,
  external_reference      VARCHAR(80)    NULL,
  status                  VARCHAR(20)    NOT NULL,
  -- Reste non affecté (avance, AV-275) : montant − Σ affectations prévues ou actives.
  unallocated_xaf         BIGINT         NOT NULL,
  -- Décaissement : à l'enregistrement sous le seuil, à la validation au-delà (AV-276).
  cash_movement_id        BINARY(16)     NULL,
  disbursed_at            DATETIME(6)    NULL,
  cancel_movement_id      BINARY(16)     NULL,
  approval_request_id     BINARY(16)     NULL,
  decided_by              BINARY(16)     NULL,
  decided_at              DATETIME(6)    NULL,
  comment                 VARCHAR(500)   NULL,
  cancel_reason           VARCHAR(500)   NULL,
  cancelled_by            BINARY(16)     NULL,
  cancelled_at            DATETIME(6)    NULL,
  occurred_at             DATETIME(6)    NOT NULL,
  command_id              BINARY(16)     NULL,
  created_at              DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by              BINARY(16)     NOT NULL,
  updated_at              DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by              BINARY(16)     NULL,
  version                 INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_finance_supplier_payments_doc_number (doc_number),
  UNIQUE KEY uq_finance_supplier_payments_command (command_id),
  UNIQUE KEY uq_finance_supplier_payments_movement (cash_movement_id),
  UNIQUE KEY uq_finance_supplier_payments_cancel_movement (cancel_movement_id),
  KEY ix_finance_supplier_payments_supplier (supplier_id, status),
  KEY ix_finance_supplier_payments_status (status, occurred_at),
  CONSTRAINT ck_finance_supplier_payments_status CHECK (status IN ('PENDING_APPROVAL', 'RECORDED', 'REJECTED', 'CANCELLED')),
  CONSTRAINT ck_finance_supplier_payments_amounts CHECK (
    amount_xaf > 0 AND unallocated_xaf >= 0 AND unallocated_xaf <= amount_xaf
  ),
  CONSTRAINT ck_finance_supplier_payments_disbursed CHECK (
    (cash_movement_id IS NULL) = (disbursed_at IS NULL)
  ),
  CONSTRAINT ck_finance_supplier_payments_state CHECK (
    (status <> 'PENDING_APPROVAL' OR (cash_movement_id IS NULL AND approval_request_id IS NOT NULL))
    AND (status <> 'RECORDED' OR cash_movement_id IS NOT NULL)
    AND (status <> 'REJECTED' OR (cash_movement_id IS NULL AND decided_at IS NOT NULL))
    AND ((status = 'CANCELLED') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancel_reason IS NOT NULL))
    AND (status <> 'CANCELLED' OR cash_movement_id IS NULL OR cancel_movement_id IS NOT NULL)
    AND (cancel_movement_id IS NULL OR status = 'CANCELLED')
  ),
  CONSTRAINT fk_finance_supplier_payments_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_supplier_payments_supplier FOREIGN KEY (supplier_id) REFERENCES procurement_suppliers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_supplier_payments_method FOREIGN KEY (payment_method_code) REFERENCES finance_payment_methods (code) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_supplier_payments_account FOREIGN KEY (from_account_id) REFERENCES finance_cash_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_supplier_payments_movement FOREIGN KEY (cash_movement_id) REFERENCES finance_cash_movements (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_supplier_payments_cancel_movement FOREIGN KEY (cancel_movement_id) REFERENCES finance_cash_movements (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_supplier_payments_approval FOREIGN KEY (approval_request_id) REFERENCES approvals_approval_requests (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_supplier_payments_decided_by FOREIGN KEY (decided_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_supplier_payments_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_supplier_payments_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_supplier_payments_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_finance_supplier_payments_update_guard BEFORE UPDATE ON finance_supplier_payments FOR EACH ROW
BEGIN
  IF NOT (
    NEW.doc_number <=> OLD.doc_number AND
    NEW.site_id <=> OLD.site_id AND
    NEW.supplier_id <=> OLD.supplier_id AND
    NEW.amount_xaf <=> OLD.amount_xaf AND
    NEW.payment_method_code <=> OLD.payment_method_code AND
    NEW.from_account_id <=> OLD.from_account_id AND
    NEW.external_reference <=> OLD.external_reference AND
    NEW.comment <=> OLD.comment AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_supplier_payments : paiement immuable ; seuls décision, affectations et annulation évoluent.';
  END IF;
  IF OLD.cash_movement_id IS NOT NULL AND NOT (NEW.cash_movement_id <=> OLD.cash_movement_id AND NEW.disbursed_at <=> OLD.disbursed_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_supplier_payments : décaissement immuable.';
  END IF;
  IF OLD.status IN ('REJECTED', 'CANCELLED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_supplier_payments : état terminal.';
  END IF;
END;

CREATE TRIGGER trg_finance_supplier_payments_no_delete BEFORE DELETE ON finance_supplier_payments FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_supplier_payments : suppression interdite ; annuler le paiement (ADR-006).';
END;

-- Affectation d'un paiement à une facture (INV-FIN-07 ; ADR-043 §6 et §7).
CREATE TABLE finance_supplier_payment_allocations (
  id                      BINARY(16)     NOT NULL,
  payment_id              BINARY(16)     NOT NULL,
  invoice_id              BINARY(16)     NOT NULL,
  amount_xaf              BIGINT         NOT NULL,
  status                  VARCHAR(10)    NOT NULL,
  activated_at            DATETIME(6)    NULL,
  reversed_at             DATETIME(6)    NULL,
  reversed_by             BINARY(16)     NULL,
  reversal_reason         VARCHAR(500)   NULL,
  -- Une facture n'est affectée qu'une fois à la fois par un même paiement.
  active_invoice_key      BINARY(16)     GENERATED ALWAYS AS (CASE WHEN status <> 'REVERSED' THEN invoice_id END) STORED,
  created_at              DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by              BINARY(16)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_finance_supplier_payment_allocations_active (payment_id, active_invoice_key),
  KEY ix_finance_supplier_payment_allocations_invoice (invoice_id, status),
  CONSTRAINT ck_finance_supplier_payment_allocations_status CHECK (status IN ('PLANNED', 'ACTIVE', 'REVERSED')),
  CONSTRAINT ck_finance_supplier_payment_allocations_amount CHECK (amount_xaf > 0),
  CONSTRAINT ck_finance_supplier_payment_allocations_state CHECK (
    ((status = 'REVERSED') = (reversed_at IS NOT NULL AND reversed_by IS NOT NULL AND reversal_reason IS NOT NULL))
    AND (status <> 'ACTIVE' OR activated_at IS NOT NULL)
  ),
  CONSTRAINT fk_finance_supplier_payment_allocations_payment FOREIGN KEY (payment_id) REFERENCES finance_supplier_payments (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_supplier_payment_allocations_invoice FOREIGN KEY (invoice_id) REFERENCES finance_supplier_invoices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_supplier_payment_allocations_reversed_by FOREIGN KEY (reversed_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_supplier_payment_allocations_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_finance_supplier_payment_allocations_update_guard BEFORE UPDATE ON finance_supplier_payment_allocations FOR EACH ROW
BEGIN
  IF NOT (
    NEW.payment_id <=> OLD.payment_id AND NEW.invoice_id <=> OLD.invoice_id AND NEW.amount_xaf <=> OLD.amount_xaf AND
    NEW.created_at <=> OLD.created_at AND NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_supplier_payment_allocations : affectation immuable.';
  END IF;
  IF NOT ((OLD.status = 'PLANNED' AND NEW.status IN ('PLANNED', 'ACTIVE', 'REVERSED'))
          OR (OLD.status = 'ACTIVE' AND NEW.status IN ('ACTIVE', 'REVERSED'))
          OR (OLD.status = 'REVERSED' AND NEW.status = 'REVERSED' AND NEW.reversed_at <=> OLD.reversed_at)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_supplier_payment_allocations : seul le passage à ACTIVE puis à REVERSED est admis.';
  END IF;
END;

CREATE TRIGGER trg_finance_supplier_payment_allocations_no_delete BEFORE DELETE ON finance_supplier_payment_allocations FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_supplier_payment_allocations : suppression interdite ; contrepasser l''affectation.';
END;

-- Dettes fournisseurs (BR-FIN-032, KPI-FIN-05) : factures approuvées non soldées ; jours de retard au
-- jour métier de Douala (UTC+1, sans heure d'été). `SQL SECURITY INVOKER` : les droits sont ceux du
-- lecteur sur la table, sans dépendre du compte qui crée la vue.
CREATE SQL SECURITY INVOKER VIEW finance_v_payables AS
SELECT
  i.supplier_id,
  i.id AS invoice_id,
  i.doc_number,
  i.supplier_invoice_ref,
  i.invoice_date,
  i.due_date,
  i.total_xaf,
  i.paid_xaf,
  i.total_xaf - i.paid_xaf AS balance_xaf,
  GREATEST(0, DATEDIFF(CAST(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+01:00') AS DATE), i.due_date)) AS days_overdue
FROM finance_supplier_invoices i
WHERE i.status IN ('APPROVED', 'PARTIALLY_PAID');

-- Type de validation d'un écart de rapprochement (SM-SUPPLIER-INVOICE ; ADR-043 §2).
ALTER TABLE approvals_control_policies DROP CHECK ck_approvals_control_policies_operation_type;
ALTER TABLE approvals_control_policies ADD CONSTRAINT ck_approvals_control_policies_operation_type CHECK (operation_type IN (
  'LOSS_DECLARATION', 'MORTALITY', 'INVENTORY_ADJUSTMENT', 'TRANSFER_DISCREPANCY', 'EXPENSE',
  'PURCHASE_REQUEST', 'PURCHASE_ORDER', 'RECEIPT_WITHOUT_PO', 'RECEIPT_VALUE', 'SUPPLIER_PAYMENT',
  'PRICE_OVERRIDE', 'SALE_CANCELLATION', 'CREDIT_LIMIT_EXCEEDED', 'CASH_VARIANCE', 'CHECKIN_OVERRIDE',
  'RECEIPT_QUARANTINE', 'RECEIPT_CANCELLATION', 'ANIMAL_COUNT_ADJUSTMENT',
  'PAYMENT_CANCELLATION', 'PAYMENT_DUPLICATE', 'CASH_TRANSFER_DISCREPANCY', 'INVOICE_MISMATCH'
));

GRANT SELECT, INSERT, UPDATE ON finance_expense_categories TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON finance_expenses TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON finance_supplier_invoices TO 'gic_app'@'%';
GRANT SELECT, INSERT ON finance_supplier_invoice_lines TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON finance_supplier_payments TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON finance_supplier_payment_allocations TO 'gic_app'@'%';
GRANT SELECT ON finance_v_payables TO 'gic_app'@'%';

-- migrate:down transaction:false
-- Défait la vue, les tables, puis restaure le catalogue des types de validation ; échoue sans effet
-- de bord sur la contrainte s'il existe une politique `INVOICE_MISMATCH`.
DROP VIEW IF EXISTS finance_v_payables;
DROP TABLE IF EXISTS finance_supplier_payment_allocations;
DROP TABLE IF EXISTS finance_supplier_payments;
DROP TABLE IF EXISTS finance_supplier_invoice_lines;
DROP TABLE IF EXISTS finance_supplier_invoices;
DROP TABLE IF EXISTS finance_expenses;
DROP TABLE IF EXISTS finance_expense_categories;
ALTER TABLE approvals_control_policies
  DROP CHECK ck_approvals_control_policies_operation_type,
  ADD CONSTRAINT ck_approvals_control_policies_operation_type CHECK (operation_type IN (
    'LOSS_DECLARATION', 'MORTALITY', 'INVENTORY_ADJUSTMENT', 'TRANSFER_DISCREPANCY', 'EXPENSE',
    'PURCHASE_REQUEST', 'PURCHASE_ORDER', 'RECEIPT_WITHOUT_PO', 'RECEIPT_VALUE', 'SUPPLIER_PAYMENT',
    'PRICE_OVERRIDE', 'SALE_CANCELLATION', 'CREDIT_LIMIT_EXCEEDED', 'CASH_VARIANCE', 'CHECKIN_OVERRIDE',
    'RECEIPT_QUARANTINE', 'RECEIPT_CANCELLATION', 'ANIMAL_COUNT_ADJUSTMENT',
    'PAYMENT_CANCELLATION', 'PAYMENT_DUPLICATE', 'CASH_TRANSFER_DISCREPANCY'
  ));
