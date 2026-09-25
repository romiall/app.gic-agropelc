-- Espace de noms `procurement`, fiche fournisseur seule (P1-02 ; le reste — demandes
-- d'achat, BC, réceptions — arrive en P6, quand `inventory` existe). Source :
-- docs/03-data/dictionnaire/08-procurement.md §suppliers.
--
-- migrate:up transaction:false

CREATE TABLE procurement_suppliers (
  id                     BINARY(16)     NOT NULL,
  code                   VARCHAR(40)    NOT NULL,
  name                   VARCHAR(200)   NOT NULL,
  supplied_categories    JSON           NOT NULL,
  contact_name           VARCHAR(200)   NULL,
  phone                  VARCHAR(20)    NULL,
  email                  VARCHAR(200)   NULL,
  address                TEXT           NULL,
  tax_id                 VARCHAR(40)    NULL,
  payment_terms_days     SMALLINT       NULL,
  status                 VARCHAR(10)    NOT NULL DEFAULT 'ACTIVE',
  notes                  TEXT           NULL,
  created_at             DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by             BINARY(16)     NOT NULL,
  updated_at             DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by             BINARY(16)     NULL,
  version                INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_procurement_suppliers_code (code),
  FULLTEXT KEY ftx_procurement_suppliers_name (name) WITH PARSER ngram,
  CONSTRAINT ck_procurement_suppliers_status CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT ck_procurement_suppliers_payment_terms CHECK (payment_terms_days IS NULL OR payment_terms_days >= 0),
  CONSTRAINT fk_procurement_suppliers_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_procurement_suppliers_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_procurement_suppliers_no_delete BEFORE DELETE ON procurement_suppliers FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'procurement_suppliers : suppression physique interdite (INV-GLO-03) ; utiliser status=INACTIVE.';
END;

-- Droits par table (INV-GLO-05).
GRANT SELECT, INSERT, UPDATE ON procurement_suppliers TO 'gic_app'@'%';

-- migrate:down transaction:false
DROP TABLE IF EXISTS procurement_suppliers;
