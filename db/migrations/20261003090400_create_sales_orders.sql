-- Espace de noms `sales`, commandes clientes (P4-02 2/2). Source : docs/03-data/dictionnaire/05-sales.md
-- (corrigé selon ADR-028) ; D04 §7.1 ; SM-ORDER ; INV-VEN-04.
--
-- Écarts au dictionnaire d'avant ADR-028, DÉDUITS et tracés (D04 §15) :
-- - plus de `reservation_status` : aucune réservation `ORDER_RESERVATION` pour une commande, la part
--   vendue est déplacée vers « à livrer » et la part en attente n'a pas de stock (ADR-028 §4) ;
-- - les lignes portent les quantités de `SalesOrderLineQuantities` (packages/domain/src/sales.ts) :
--   `quantity_base` = commandé en vigueur (après ajustements, AV-130), `sold_quantity_base` = vendu
--   net des annulations, `delivered_quantity_base` = livré, avec 0 ≤ livré ≤ vendu ≤ commandé
--   (INV-VEN-04) ; `withdrawn_quantity_base` cumule les quantités retirées, pour la traçabilité ;
-- - plus de statut de ligne : en attente = commandé − vendu et à livrer = vendu − livré se dérivent
--   des quantités, le statut de la commande (SM-ORDER) se dérive des lignes ;
-- - `closed_at` / `closed_by` : clôture du reliquat d'une commande partiellement livrée (`CLOSED`,
--   AV-128) ; la commande annulée avant toute livraison est `CANCELLED` (colonnes [STD-CANCEL]).
-- `command_id` est unique : une commande de synchronisation ne crée qu'une commande.
--
-- migrate:up transaction:false

CREATE TABLE sales_sales_orders (
  id                          BINARY(16)     NOT NULL,
  doc_number                  VARCHAR(40)    NOT NULL,
  local_ref                   VARCHAR(20)    NULL,
  site_id                     BINARY(16)     NOT NULL,
  customer_id                 BINARY(16)     NOT NULL,
  commercial_user_id          BINARY(16)     NOT NULL,
  channel_code                VARCHAR(20)    NOT NULL,
  fulfilment_location_id      BINARY(16)     NOT NULL,
  requested_delivery_date     DATE           NULL,
  delivery_address            TEXT           NULL,
  status                      VARCHAR(20)    NOT NULL DEFAULT 'CONFIRMED',
  total_estimated_xaf         BIGINT         NOT NULL DEFAULT 0,
  advance_paid_xaf            BIGINT         NOT NULL DEFAULT 0,
  external_origin             VARCHAR(10)    NOT NULL DEFAULT 'NONE',
  confirmed_at                DATETIME(6)    NULL,
  closed_at                   DATETIME(6)    NULL,
  closed_by                   BINARY(16)     NULL,
  closed_reason               TEXT           NULL,
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
  UNIQUE KEY uq_sales_sales_orders_doc_number (doc_number),
  UNIQUE KEY uq_sales_sales_orders_command (command_id),
  UNIQUE KEY uq_sales_sales_orders_device_ref (created_device_id, local_ref),
  KEY ix_sales_sales_orders_customer (customer_id, occurred_at),
  KEY ix_sales_sales_orders_commercial (commercial_user_id, occurred_at),
  KEY ix_sales_sales_orders_location_status (fulfilment_location_id, status),
  KEY ix_sales_sales_orders_status (status, site_id),
  CONSTRAINT ck_sales_sales_orders_status CHECK (status IN (
    'DRAFT', 'CONFIRMED', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CLOSED', 'CANCELLED'
  )),
  CONSTRAINT ck_sales_sales_orders_origin CHECK (external_origin IN ('NONE', 'KOMMO')),
  CONSTRAINT ck_sales_sales_orders_amounts CHECK (total_estimated_xaf >= 0 AND advance_paid_xaf >= 0),
  CONSTRAINT ck_sales_sales_orders_confirmed CHECK (status = 'DRAFT' OR confirmed_at IS NOT NULL),
  -- Clôture du reliquat (AV-128) : renseignée si et seulement si le statut est CLOSED.
  CONSTRAINT ck_sales_sales_orders_closed CHECK (
    (status = 'CLOSED' AND closed_at IS NOT NULL AND closed_by IS NOT NULL)
    OR (status <> 'CLOSED' AND closed_at IS NULL AND closed_by IS NULL)
  ),
  -- [STD-CANCEL] : colonnes d'annulation renseignées si et seulement si CANCELLED.
  CONSTRAINT ck_sales_sales_orders_cancel CHECK (
    (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)
    OR (status <> 'CANCELLED' AND cancelled_at IS NULL AND cancelled_by IS NULL
        AND cancel_reason_code_id IS NULL AND cancel_comment IS NULL AND cancel_approval_request_id IS NULL)
  ),
  CONSTRAINT fk_sales_sales_orders_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sales_orders_customer FOREIGN KEY (customer_id) REFERENCES crm_customers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sales_orders_commercial FOREIGN KEY (commercial_user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sales_orders_channel FOREIGN KEY (channel_code) REFERENCES catalog_sales_channels (code) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sales_orders_location FOREIGN KEY (fulfilment_location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sales_orders_closed_by FOREIGN KEY (closed_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sales_orders_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sales_orders_cancel_reason FOREIGN KEY (cancel_reason_code_id) REFERENCES catalog_reason_codes (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sales_orders_cancel_approval FOREIGN KEY (cancel_approval_request_id) REFERENCES approvals_approval_requests (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sales_orders_created_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sales_orders_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sales_orders_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- L'engagement du client est fixé à la création (numéro, client, commercial, canal, origine) ; le
-- lieu de préparation, la date et l'adresse de livraison, les totaux, le statut, la clôture et
-- l'annulation évoluent (BR-VEN-005, AV-130). Le commercial et le client ne se réécrivent jamais
-- (BR-VEN-020 ; une fusion de clients n'est pas une réécriture).
CREATE TRIGGER trg_sales_sales_orders_update_guard BEFORE UPDATE ON sales_sales_orders FOR EACH ROW
BEGIN
  IF NOT (
    NEW.doc_number <=> OLD.doc_number AND
    NEW.local_ref <=> OLD.local_ref AND
    NEW.site_id <=> OLD.site_id AND
    NEW.customer_id <=> OLD.customer_id AND
    NEW.commercial_user_id <=> OLD.commercial_user_id AND
    NEW.channel_code <=> OLD.channel_code AND
    NEW.external_origin <=> OLD.external_origin AND
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
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales_orders : identité de la commande immuable ; seuls lieu, dates, totaux, statut et clôture évoluent.';
  END IF;
  IF OLD.status IN ('FULFILLED', 'CLOSED', 'CANCELLED') AND NEW.status <> OLD.status THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales_orders : commande terminée, son statut ne change plus (SM-ORDER).';
  END IF;
END;

CREATE TRIGGER trg_sales_sales_orders_no_delete BEFORE DELETE ON sales_sales_orders FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales_orders : suppression physique interdite (INV-GLO-03) ; utiliser CANCELLED.';
END;

CREATE TABLE sales_sales_order_lines (
  id                        BINARY(16)     NOT NULL,
  order_id                  BINARY(16)     NOT NULL,
  line_no                   SMALLINT       NOT NULL,
  product_id                BINARY(16)     NOT NULL,
  product_name_snapshot     VARCHAR(200)   NOT NULL,
  quantity                  DECIMAL(14,3)  NOT NULL,
  unit_code                 VARCHAR(20)    NOT NULL,
  quantity_base             DECIMAL(14,3)  NOT NULL,
  withdrawn_quantity_base   DECIMAL(14,3)  NOT NULL DEFAULT 0,
  sold_quantity_base        DECIMAL(14,3)  NOT NULL DEFAULT 0,
  delivered_quantity_base   DECIMAL(14,3)  NOT NULL DEFAULT 0,
  quoted_unit_price_xaf     BIGINT         NOT NULL,
  price_rule_id             BINARY(16)     NULL,
  price_rule_version        INT            NULL,
  price_source              VARCHAR(20)    NOT NULL DEFAULT 'RULE',
  line_total_xaf            BIGINT         NOT NULL,
  created_at                DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at                DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_sales_sales_order_lines_line_no (order_id, line_no),
  KEY ix_sales_sales_order_lines_product (product_id),
  CONSTRAINT ck_sales_sales_order_lines_price_source CHECK (price_source IN ('RULE', 'MANUAL_OVERRIDE')),
  CONSTRAINT ck_sales_sales_order_lines_amounts CHECK (quoted_unit_price_xaf >= 0 AND line_total_xaf >= 0),
  -- INV-VEN-04 : 0 ≤ livré ≤ vendu ≤ commandé en vigueur. Une ligne entièrement retirée a un
  -- commandé nul (AV-130) : `quantity` et `quantity_base` ne sont donc pas strictement positifs.
  CONSTRAINT ck_sales_sales_order_lines_quantities CHECK (
    quantity >= 0 AND quantity_base >= 0 AND withdrawn_quantity_base >= 0
    AND delivered_quantity_base >= 0
    AND delivered_quantity_base <= sold_quantity_base
    AND sold_quantity_base <= quantity_base
  ),
  CONSTRAINT fk_sales_sales_order_lines_order FOREIGN KEY (order_id) REFERENCES sales_sales_orders (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sales_order_lines_product FOREIGN KEY (product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sales_order_lines_unit FOREIGN KEY (unit_code) REFERENCES catalog_units (code) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sales_order_lines_price_rule FOREIGN KEY (price_rule_id) REFERENCES pricing_price_rules (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Le prix convenu, le produit et l'unité sont figés (BR-VEN-003, ADR-028 §6 : le prix des lignes
-- déjà vendues ne change pas) ; seules les quantités et le montant estimé évoluent.
CREATE TRIGGER trg_sales_sales_order_lines_update_guard BEFORE UPDATE ON sales_sales_order_lines FOR EACH ROW
BEGIN
  IF NOT (
    NEW.order_id <=> OLD.order_id AND
    NEW.line_no <=> OLD.line_no AND
    NEW.product_id <=> OLD.product_id AND
    NEW.product_name_snapshot <=> OLD.product_name_snapshot AND
    NEW.unit_code <=> OLD.unit_code AND
    NEW.quoted_unit_price_xaf <=> OLD.quoted_unit_price_xaf AND
    NEW.price_rule_id <=> OLD.price_rule_id AND
    NEW.price_rule_version <=> OLD.price_rule_version AND
    NEW.price_source <=> OLD.price_source AND
    NEW.created_at <=> OLD.created_at
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales_order_lines : produit, unité et prix convenu immuables ; seules les quantités évoluent.';
  END IF;
  -- Le vendu net baisse à une annulation, le commandé à un retrait : seuls le livré (un fait) et
  -- le cumul retiré sont monotones.
  IF NEW.delivered_quantity_base < OLD.delivered_quantity_base THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales_order_lines : la quantité livrée ne diminue jamais (INV-VEN-04).';
  END IF;
  IF NEW.withdrawn_quantity_base < OLD.withdrawn_quantity_base THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales_order_lines : la quantité retirée ne diminue jamais (traçabilité).';
  END IF;
END;

CREATE TRIGGER trg_sales_sales_order_lines_no_delete BEFORE DELETE ON sales_sales_order_lines FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales_order_lines : suppression physique interdite (INV-GLO-03).';
END;

-- Droits par table (INV-GLO-05) : aucune suppression.
GRANT SELECT, INSERT, UPDATE ON sales_sales_orders TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON sales_sales_order_lines TO 'gic_app'@'%';

-- migrate:down transaction:false
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS sales_sales_order_lines;
DROP TABLE IF EXISTS sales_sales_orders;
SET FOREIGN_KEY_CHECKS = 1;
