-- Espace de noms `sales`, encaissements clients et affectations (P4-02 2/2). Source :
-- docs/03-data/dictionnaire/05-sales.md ; D09 §7.1 ; SM-CUSTOMER-PAYMENT ; INV-FIN-03, INV-FIN-04,
-- INV-VEN-06 ; AV-056, ADR-028 §8.
--
-- Écarts au dictionnaire, DÉDUITS et tracés (D04 §15) :
-- - `reference_normalized` : référence passée par `normalizePaymentReference` (espaces retirés,
--   majuscules) ; `reference_key` = « moyen:référence normalisée », renseignée seulement pour les
--   statuts `RECORDED` et `CANCELLATION_REQUESTED`, porte l'unicité (précédent `posted_note_key` des
--   réceptions ; conventions §4). Un doublon `SUSPECT_DUPLICATE` ou `REJECTED` n'y compte pas, un
--   encaissement annulé libère sa référence. INV-FIN-03 ne cite que `RECORDED` : à aligner ;
-- - `duplicate_of_payment_id` : encaissement dont le suspect semble le doublon (décision de la Finance) ;
-- - `command_id` n'est PAS unique : une vente enregistrée en une commande crée un encaissement par
--   moyen de paiement (BR-VEN-023) ;
-- - `reversal_cause` des affectations : `ORDER_CONFIRMED` remplace `ORDER_FULFILLED` (un acompte passe
--   à la vente à la confirmation, ADR-028 §8) ; une libération partielle renverse l'affectation et en
--   crée une nouvelle pour la part conservée (le registre d'affectation reste immuable).
--
-- migrate:up transaction:false

CREATE TABLE sales_customer_payments (
  id                          BINARY(16)     NOT NULL,
  doc_number                  VARCHAR(40)    NOT NULL,
  local_ref                   VARCHAR(20)    NULL,
  site_id                     BINARY(16)     NOT NULL,
  customer_id                 BINARY(16)     NULL,
  payment_method_code         VARCHAR(40)    NOT NULL,
  amount_xaf                  BIGINT         NOT NULL,
  external_reference          VARCHAR(80)    NULL,
  reference_normalized        VARCHAR(80)    NULL,
  -- INV-FIN-03 : (moyen, référence normalisée) unique parmi les encaissements enregistrés.
  reference_key               VARCHAR(121)   GENERATED ALWAYS AS (
    CASE WHEN reference_normalized IS NOT NULL AND status IN ('RECORDED', 'CANCELLATION_REQUESTED')
         THEN CONCAT(payment_method_code, ':', reference_normalized) END
  ) STORED,
  received_by_user_id         BINARY(16)     NOT NULL,
  cash_account_id             BINARY(16)     NOT NULL,
  cash_session_id             BINARY(16)     NULL,
  cash_movement_id            BINARY(16)     NULL,
  status                      VARCHAR(25)    NOT NULL,
  duplicate_of_payment_id     BINARY(16)     NULL,
  unallocated_xaf             BIGINT         NOT NULL,
  cancelled_at                DATETIME(6)    NULL,
  cancelled_by                BINARY(16)     NULL,
  cancel_reason_code_id       BINARY(16)     NULL,
  cancel_comment              TEXT           NULL,
  cancel_approval_request_id  BINARY(16)     NULL,
  occurred_at                 DATETIME(6)    NOT NULL,
  business_date               DATE           GENERATED ALWAYS AS (CAST(CONVERT_TZ(occurred_at, '+00:00', '+01:00') AS DATE)) STORED,
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
  UNIQUE KEY uq_sales_customer_payments_doc_number (doc_number),
  UNIQUE KEY uq_sales_customer_payments_device_ref (created_device_id, local_ref),
  UNIQUE KEY uq_sales_customer_payments_reference (reference_key),
  KEY ix_sales_customer_payments_customer (customer_id, occurred_at),
  KEY ix_sales_customer_payments_session (cash_session_id),
  KEY ix_sales_customer_payments_business_date (site_id, business_date),
  KEY ix_sales_customer_payments_status (status, occurred_at),
  KEY ix_sales_customer_payments_command (command_id),
  KEY ix_sales_customer_payments_movement (cash_movement_id),
  CONSTRAINT ck_sales_customer_payments_status CHECK (status IN (
    'RECORDED', 'SUSPECT_DUPLICATE', 'REJECTED', 'CANCELLATION_REQUESTED', 'CANCELLED'
  )),
  CONSTRAINT ck_sales_customer_payments_amount CHECK (amount_xaf > 0),
  CONSTRAINT ck_sales_customer_payments_unallocated CHECK (unallocated_xaf >= 0 AND unallocated_xaf <= amount_xaf),
  -- Pas de trésorerie tant que l'encaissement est suspect ou rejeté (AV-056) ; un mouvement de
  -- trésorerie existe pour tout encaissement enregistré, en cours d'annulation ou annulé.
  CONSTRAINT ck_sales_customer_payments_movement CHECK (
    (status IN ('RECORDED', 'CANCELLATION_REQUESTED', 'CANCELLED') AND cash_movement_id IS NOT NULL)
    OR (status IN ('SUSPECT_DUPLICATE', 'REJECTED') AND cash_movement_id IS NULL)
  ),
  -- [STD-CANCEL] : colonnes d'annulation renseignées si et seulement si CANCELLED.
  CONSTRAINT ck_sales_customer_payments_cancel CHECK (
    (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)
    OR (status <> 'CANCELLED' AND cancelled_at IS NULL AND cancelled_by IS NULL
        AND cancel_reason_code_id IS NULL AND cancel_comment IS NULL AND cancel_approval_request_id IS NULL)
  ),
  CONSTRAINT fk_sales_customer_payments_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_customer_payments_customer FOREIGN KEY (customer_id) REFERENCES crm_customers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_customer_payments_method FOREIGN KEY (payment_method_code) REFERENCES finance_payment_methods (code) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_customer_payments_received_by FOREIGN KEY (received_by_user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_customer_payments_cash_account FOREIGN KEY (cash_account_id) REFERENCES finance_cash_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_customer_payments_cash_movement FOREIGN KEY (cash_movement_id) REFERENCES finance_cash_movements (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_customer_payments_duplicate_of FOREIGN KEY (duplicate_of_payment_id) REFERENCES sales_customer_payments (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_customer_payments_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_customer_payments_cancel_reason FOREIGN KEY (cancel_reason_code_id) REFERENCES catalog_reason_codes (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_customer_payments_cancel_approval FOREIGN KEY (cancel_approval_request_id) REFERENCES approvals_approval_requests (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_customer_payments_created_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_customer_payments_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_customer_payments_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Un encaissement est un fait : montant, moyen, référence et compte ne changent pas ; évoluent le
-- statut (la décision de la Finance fait passer un suspect à RECORDED, le mouvement de trésorerie
-- se renseigne alors), la part non affectée et l'annulation. REJECTED et CANCELLED sont terminaux.
CREATE TRIGGER trg_sales_customer_payments_update_guard BEFORE UPDATE ON sales_customer_payments FOR EACH ROW
BEGIN
  IF NOT (
    NEW.doc_number <=> OLD.doc_number AND
    NEW.local_ref <=> OLD.local_ref AND
    NEW.site_id <=> OLD.site_id AND
    NEW.customer_id <=> OLD.customer_id AND
    NEW.payment_method_code <=> OLD.payment_method_code AND
    NEW.amount_xaf <=> OLD.amount_xaf AND
    NEW.external_reference <=> OLD.external_reference AND
    NEW.reference_normalized <=> OLD.reference_normalized AND
    NEW.received_by_user_id <=> OLD.received_by_user_id AND
    NEW.cash_account_id <=> OLD.cash_account_id AND
    NEW.duplicate_of_payment_id <=> OLD.duplicate_of_payment_id AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.client_created_at <=> OLD.client_created_at AND
    NEW.received_at_server <=> OLD.received_at_server AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_device_id <=> OLD.created_device_id AND
    NEW.captured_offline <=> OLD.captured_offline AND
    NEW.clock_suspect <=> OLD.clock_suspect AND
    NEW.backdated_reason <=> OLD.backdated_reason AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_customer_payments : encaissement immuable ; seuls statut, part non affectée et annulation évoluent.';
  END IF;
  IF OLD.status IN ('REJECTED', 'CANCELLED') AND NEW.status <> OLD.status THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_customer_payments : encaissement rejeté ou annulé, son statut ne change plus.';
  END IF;
  IF OLD.cash_movement_id IS NOT NULL AND NOT (NEW.cash_movement_id <=> OLD.cash_movement_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_customer_payments : le mouvement de trésorerie ne change plus (INV-FIN-01).';
  END IF;
END;

CREATE TRIGGER trg_sales_customer_payments_no_delete BEFORE DELETE ON sales_customer_payments FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_customer_payments : suppression physique interdite (INV-GLO-03) ; annuler par contre-écriture.';
END;

CREATE TABLE sales_payment_allocations (
  id              BINARY(16)   NOT NULL,
  payment_id      BINARY(16)   NOT NULL,
  sale_id         BINARY(16)   NULL,
  order_id        BINARY(16)   NULL,
  amount_xaf      BIGINT       NOT NULL,
  allocated_at    DATETIME(6)  NOT NULL,
  status          VARCHAR(10)  NOT NULL DEFAULT 'ACTIVE',
  reversed_at     DATETIME(6)  NULL,
  reversal_cause  VARCHAR(20)  NULL,
  command_id      BINARY(16)   NULL,
  created_at      DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by      BINARY(16)   NOT NULL,
  PRIMARY KEY (id),
  KEY ix_sales_payment_allocations_payment (payment_id),
  KEY ix_sales_payment_allocations_sale (sale_id, status),
  KEY ix_sales_payment_allocations_order (order_id, status),
  KEY ix_sales_payment_allocations_command (command_id),
  CONSTRAINT ck_sales_payment_allocations_amount CHECK (amount_xaf > 0),
  -- Exactement une cible : une vente (règlement) ou une commande (acompte).
  CONSTRAINT ck_sales_payment_allocations_target CHECK ((sale_id IS NULL) <> (order_id IS NULL)),
  CONSTRAINT ck_sales_payment_allocations_status CHECK (status IN ('ACTIVE', 'REVERSED')),
  CONSTRAINT ck_sales_payment_allocations_reversal CHECK (
    (status = 'ACTIVE' AND reversed_at IS NULL AND reversal_cause IS NULL)
    OR (status = 'REVERSED' AND reversed_at IS NOT NULL AND reversal_cause IS NOT NULL)
  ),
  CONSTRAINT ck_sales_payment_allocations_cause CHECK (
    reversal_cause IS NULL
    OR reversal_cause IN ('PAYMENT_CANCELLED', 'SALE_CANCELLED', 'REALLOCATED', 'ORDER_CONFIRMED')
  ),
  CONSTRAINT fk_sales_payment_allocations_payment FOREIGN KEY (payment_id) REFERENCES sales_customer_payments (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_payment_allocations_sale FOREIGN KEY (sale_id) REFERENCES sales_sales (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_payment_allocations_order FOREIGN KEY (order_id) REFERENCES sales_sales_orders (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_payment_allocations_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Registre d'affectation (INV-FIN-04) : immuable, sauf le passage unique de ACTIVE à REVERSED.
CREATE TRIGGER trg_sales_payment_allocations_update_guard BEFORE UPDATE ON sales_payment_allocations FOR EACH ROW
BEGIN
  IF NOT (
    NEW.payment_id <=> OLD.payment_id AND
    NEW.sale_id <=> OLD.sale_id AND
    NEW.order_id <=> OLD.order_id AND
    NEW.amount_xaf <=> OLD.amount_xaf AND
    NEW.allocated_at <=> OLD.allocated_at AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_payment_allocations : affectation immuable ; seul le renversement (REVERSED) est permis.';
  END IF;
  IF OLD.status = 'REVERSED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_payment_allocations : affectation déjà renversée.';
  END IF;
END;

CREATE TRIGGER trg_sales_payment_allocations_no_delete BEFORE DELETE ON sales_payment_allocations FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_payment_allocations : suppression physique interdite (INV-GLO-03).';
END;

-- Droits par table (INV-GLO-05) : aucune suppression.
GRANT SELECT, INSERT, UPDATE ON sales_customer_payments TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON sales_payment_allocations TO 'gic_app'@'%';

-- migrate:down transaction:false
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS sales_payment_allocations;
DROP TABLE IF EXISTS sales_customer_payments;
SET FOREIGN_KEY_CHECKS = 1;
