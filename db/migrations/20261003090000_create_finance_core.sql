-- Module `finance`, socle de trésorerie (P4-02) : moyens de paiement, comptes de trésorerie,
-- mouvements de trésorerie. Source : docs/03-data/dictionnaire/09-finance.md ; D09-FIN §7.2
-- (BR-FIN-010, 011, 012) ; INV-FIN-01, INV-FIN-02 ; AV-056.
-- Les sessions de caisse arrivent en P5 : `cash_session_id` reste sans clé étrangère d'ici là.
--
-- migrate:up transaction:false

CREATE TABLE finance_payment_methods (
  code                  VARCHAR(40)    NOT NULL,
  label                 VARCHAR(100)   NOT NULL,
  requires_reference    BOOLEAN        NOT NULL DEFAULT FALSE,
  default_account_type  VARCHAR(20)    NOT NULL,
  is_active             BOOLEAN        NOT NULL DEFAULT TRUE,
  created_at            DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at            DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  version               INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (code),
  CONSTRAINT ck_finance_payment_methods_account_type CHECK (default_account_type IN (
    'CAISSE_PDV', 'CAISSE_UTILISATEUR', 'CAISSE_CENTRALE', 'MOBILE_MONEY', 'BANQUE'
  ))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_finance_payment_methods_no_delete BEFORE DELETE ON finance_payment_methods FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_payment_methods : suppression interdite ; désactiver le moyen.';
END;

CREATE TABLE finance_cash_accounts (
  id                    BINARY(16)     NOT NULL,
  code                  VARCHAR(40)    NOT NULL,
  name                  VARCHAR(200)   NOT NULL,
  account_type          VARCHAR(20)    NOT NULL,
  site_id               BINARY(16)     NULL,
  holder_user_id        BINARY(16)     NULL,
  responsible_user_id   BINARY(16)     NOT NULL,
  external_ref          VARCHAR(60)    NULL,
  balance_xaf           BIGINT         NOT NULL DEFAULT 0,
  status                VARCHAR(20)    NOT NULL DEFAULT 'ACTIVE',
  -- BR-FIN-010 : une caisse de PDV active par site, une caisse utilisateur active par détenteur.
  active_pos_site       BINARY(16)     GENERATED ALWAYS AS (
    IF(account_type = 'CAISSE_PDV' AND status = 'ACTIVE', site_id, NULL)
  ) STORED,
  active_user_holder    BINARY(16)     GENERATED ALWAYS AS (
    IF(account_type = 'CAISSE_UTILISATEUR' AND status = 'ACTIVE', holder_user_id, NULL)
  ) STORED,
  created_at            DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by            BINARY(16)     NOT NULL,
  updated_at            DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by            BINARY(16)     NULL,
  version               INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_finance_cash_accounts_code (code),
  UNIQUE KEY uq_finance_cash_accounts_active_pos_site (active_pos_site),
  UNIQUE KEY uq_finance_cash_accounts_active_user_holder (active_user_holder),
  KEY ix_finance_cash_accounts_site (site_id, account_type),
  KEY ix_finance_cash_accounts_holder (holder_user_id),
  CONSTRAINT ck_finance_cash_accounts_type CHECK (account_type IN (
    'CAISSE_PDV', 'CAISSE_UTILISATEUR', 'CAISSE_CENTRALE', 'MOBILE_MONEY', 'BANQUE'
  )),
  CONSTRAINT ck_finance_cash_accounts_status CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT ck_finance_cash_accounts_pos_site CHECK (account_type <> 'CAISSE_PDV' OR site_id IS NOT NULL),
  CONSTRAINT ck_finance_cash_accounts_user_holder CHECK (account_type <> 'CAISSE_UTILISATEUR' OR holder_user_id IS NOT NULL),
  CONSTRAINT fk_finance_cash_accounts_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_accounts_holder FOREIGN KEY (holder_user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_accounts_responsible FOREIGN KEY (responsible_user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_accounts_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_accounts_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_finance_cash_accounts_no_delete BEFORE DELETE ON finance_cash_accounts FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_cash_accounts : suppression interdite (INV-FIN-01) ; désactiver le compte.';
END;

CREATE TABLE finance_cash_movements (
  id                    BINARY(16)     NOT NULL,
  cash_account_id       BINARY(16)     NOT NULL,
  direction             VARCHAR(3)     NOT NULL,
  amount_xaf            BIGINT         NOT NULL,
  movement_type         VARCHAR(25)    NOT NULL,
  source_doc_type       VARCHAR(25)    NOT NULL,
  source_doc_id         BINARY(16)     NOT NULL,
  cash_session_id       BINARY(16)     NULL,
  occurred_at           DATETIME(6)    NOT NULL,
  business_date         DATE           GENERATED ALWAYS AS (CAST(CONVERT_TZ(occurred_at, '+00:00', '+01:00') AS DATE)) STORED,
  recorded_at           DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  is_reversal           BOOLEAN        NOT NULL DEFAULT FALSE,
  reverses_movement_id  BINARY(16)     NULL,
  command_id            BINARY(16)     NULL,
  created_device_id     BINARY(16)     NULL,
  captured_offline      BOOLEAN        NOT NULL DEFAULT FALSE,
  created_by            BINARY(16)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_finance_cash_movements_reverses (reverses_movement_id),
  KEY ix_finance_cash_movements_account (cash_account_id, occurred_at),
  KEY ix_finance_cash_movements_source (source_doc_type, source_doc_id),
  KEY ix_finance_cash_movements_session (cash_session_id),
  KEY ix_finance_cash_movements_business_date (business_date, cash_account_id),
  CONSTRAINT ck_finance_cash_movements_direction CHECK (direction IN ('IN', 'OUT')),
  CONSTRAINT ck_finance_cash_movements_amount CHECK (amount_xaf > 0),
  CONSTRAINT ck_finance_cash_movements_type CHECK (movement_type IN (
    'CUSTOMER_PAYMENT', 'REFUND', 'SUPPLIER_PAYMENT', 'EXPENSE', 'TRANSFER_OUT', 'TRANSFER_IN',
    'SESSION_VARIANCE', 'OPENING_BALANCE'
  )),
  CONSTRAINT ck_finance_cash_movements_source_doc_type CHECK (source_doc_type IN (
    'CUSTOMER_PAYMENT', 'SALE_REFUND', 'SUPPLIER_PAYMENT', 'EXPENSE', 'CASH_TRANSFER', 'CASH_SESSION'
  )),
  CONSTRAINT ck_finance_cash_movements_reversal CHECK (
    (is_reversal = FALSE AND reverses_movement_id IS NULL) OR (is_reversal = TRUE AND reverses_movement_id IS NOT NULL)
  ),
  CONSTRAINT fk_finance_cash_movements_account FOREIGN KEY (cash_account_id) REFERENCES finance_cash_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_movements_reverses FOREIGN KEY (reverses_movement_id) REFERENCES finance_cash_movements (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_movements_created_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_movements_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- BR-FIN-011 : registre en ajout seul ; correction par mouvement inverse.
CREATE TRIGGER trg_finance_cash_movements_no_update BEFORE UPDATE ON finance_cash_movements FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_cash_movements : registre immuable (BR-FIN-011) ; corriger par un mouvement inverse.';
END;

CREATE TRIGGER trg_finance_cash_movements_no_delete BEFORE DELETE ON finance_cash_movements FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_cash_movements : suppression interdite (INV-FIN-01).';
END;

GRANT SELECT, INSERT, UPDATE ON finance_payment_methods TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON finance_cash_accounts TO 'gic_app'@'%';
GRANT SELECT, INSERT ON finance_cash_movements TO 'gic_app'@'%';

-- migrate:down transaction:false
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS finance_cash_movements;
DROP TABLE IF EXISTS finance_cash_accounts;
DROP TABLE IF EXISTS finance_payment_methods;
SET FOREIGN_KEY_CHECKS = 1;
