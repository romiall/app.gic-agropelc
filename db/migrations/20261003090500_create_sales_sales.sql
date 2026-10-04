-- Espace de noms `sales`, ventes et annulations (P4-02 2/2). Source : docs/03-data/dictionnaire/05-sales.md
-- (corrigé selon ADR-028) ; D04 §7.2 ; SM-SALE ; INV-VEN-02, INV-VEN-03, INV-VEN-06, INV-VEN-07.
--
-- Écarts au dictionnaire d'avant ADR-028, DÉDUITS et tracés (D04 §15) :
-- - `sale_type` vaut `DIRECT` ou `ORDER` (une vente par confirmation, ADR-028 §4) ; une vente `ORDER`
--   porte l'emplacement « à livrer » du site (`to_deliver_location_id`), une vente `DIRECT` n'en a pas ;
-- - la vente reste immuable (INV-VEN-02) : toute annulation, totale ou partielle, est un document
--   d'annulation (`sales_sale_cancellations` et ses lignes) ; la vente ne porte que le montant annulé
--   (`cancelled_xaf`, jamais décroissant) et son net (`net_total_xaf`) sert au solde dû ;
-- - `payment_status`, `net_total_xaf` et `balance_due_xaf` sont des colonnes générées : le statut de
--   paiement est dérivé, jamais saisi (BR-VEN-026) ;
-- - `sales_sale_lines` porte `cancelled_quantity_base`, `cancelled_xaf` et `delivered_quantity_base`
--   (compteurs monotones) et `cost_xaf`, somme des valeurs figées des mouvements `SALE` de la ligne
--   (une dernière sortie d'un lot biologique n'est pas quantité × coût unitaire arrondi, ADR-027) ;
-- - une annulation n'est effective qu'une fois `APPLIED` (une demande `REQUESTED` attend sa validation) ;
--   `applied_at` est l'heure métier de son effet sur le chiffre d'affaires et sur le stock.
-- `command_id` n'est pas unique sur les annulations (`sales.order.update` peut en créer une par vente).
--
-- migrate:up transaction:false

CREATE TABLE sales_sales (
  id                              BINARY(16)     NOT NULL,
  doc_number                      VARCHAR(40)    NOT NULL,
  local_ref                       VARCHAR(20)    NULL,
  site_id                         BINARY(16)     NOT NULL,
  sale_type                       VARCHAR(10)    NOT NULL,
  order_id                        BINARY(16)     NULL,
  customer_id                     BINARY(16)     NULL,
  customer_category_id_snapshot   BINARY(16)     NULL,
  channel_code                    VARCHAR(20)    NOT NULL,
  from_location_id                BINARY(16)     NOT NULL,
  to_deliver_location_id          BINARY(16)     NULL,
  zone_id                         BINARY(16)     NOT NULL,
  seller_user_id                  BINARY(16)     NOT NULL,
  commercial_user_id              BINARY(16)     NULL,
  work_session_id                 BINARY(16)     NULL,
  cash_session_id                 BINARY(16)     NULL,
  lat                             DECIMAL(9,6)   NULL,
  lng                             DECIMAL(9,6)   NULL,
  accuracy_m                      DECIMAL(8,1)   NULL,
  status                          VARCHAR(25)    NOT NULL DEFAULT 'CONFIRMED',
  subtotal_xaf                    BIGINT         NOT NULL,
  discount_total_xaf              BIGINT         NOT NULL DEFAULT 0,
  tax_total_xaf                   BIGINT         NOT NULL DEFAULT 0,
  total_xaf                       BIGINT         NOT NULL,
  cancelled_xaf                   BIGINT         NOT NULL DEFAULT 0,
  amount_paid_xaf                 BIGINT         NOT NULL DEFAULT 0,
  net_total_xaf                   BIGINT         GENERATED ALWAYS AS (total_xaf - cancelled_xaf) STORED,
  balance_due_xaf                 BIGINT         GENERATED ALWAYS AS (total_xaf - cancelled_xaf - amount_paid_xaf) STORED,
  -- BR-VEN-026 : dérivé des affectations actives ; un net nul est PAID (saleBalances).
  payment_status                  VARCHAR(15)    GENERATED ALWAYS AS (
    CASE WHEN total_xaf - cancelled_xaf - amount_paid_xaf = 0 THEN 'PAID'
         WHEN amount_paid_xaf = 0 THEN 'UNPAID'
         ELSE 'PARTIALLY_PAID' END
  ) STORED,
  due_date                        DATE           NULL,
  flags                           JSON           NOT NULL DEFAULT (JSON_ARRAY()),
  occurred_at                     DATETIME(6)    NOT NULL,
  business_date                   DATE           GENERATED ALWAYS AS (CAST(CONVERT_TZ(occurred_at, '+00:00', '+01:00') AS DATE)) STORED,
  client_created_at               DATETIME(6)    NULL,
  received_at_server              DATETIME(6)    NULL,
  command_id                      BINARY(16)     NULL,
  created_device_id               BINARY(16)     NULL,
  captured_offline                BOOLEAN        NOT NULL DEFAULT FALSE,
  clock_suspect                   BOOLEAN        NOT NULL DEFAULT FALSE,
  backdated_reason                TEXT           NULL,
  created_at                      DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by                      BINARY(16)     NOT NULL,
  updated_at                      DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by                      BINARY(16)     NULL,
  version                         INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sales_sales_doc_number (doc_number),
  UNIQUE KEY uq_sales_sales_command (command_id),
  UNIQUE KEY uq_sales_sales_device_ref (created_device_id, local_ref),
  KEY ix_sales_sales_occurred_at (occurred_at),
  KEY ix_sales_sales_business_date (business_date, from_location_id),
  KEY ix_sales_sales_site_date (site_id, business_date),
  KEY ix_sales_sales_customer (customer_id, occurred_at),
  KEY ix_sales_sales_commercial (commercial_user_id, business_date),
  KEY ix_sales_sales_seller (seller_user_id, business_date),
  KEY ix_sales_sales_order (order_id),
  KEY ix_sales_sales_payment_status (payment_status, due_date),
  CONSTRAINT ck_sales_sales_type CHECK (sale_type IN ('DIRECT', 'ORDER')),
  -- Une vente sur commande porte la commande et l'emplacement « à livrer » ; une vente directe, ni l'une ni l'autre.
  CONSTRAINT ck_sales_sales_order_link CHECK (
    (sale_type = 'ORDER' AND order_id IS NOT NULL AND to_deliver_location_id IS NOT NULL)
    OR (sale_type = 'DIRECT' AND order_id IS NULL AND to_deliver_location_id IS NULL)
  ),
  CONSTRAINT ck_sales_sales_status CHECK (status IN ('CONFIRMED', 'CANCELLATION_REQUESTED', 'CANCELLED')),
  CONSTRAINT ck_sales_sales_amounts CHECK (
    subtotal_xaf >= 0 AND discount_total_xaf >= 0 AND tax_total_xaf >= 0 AND total_xaf >= 0
  ),
  -- BR-VEN-014 : le total de la vente est la somme des lignes (au rabais près).
  CONSTRAINT ck_sales_sales_total CHECK (total_xaf = subtotal_xaf - discount_total_xaf + tax_total_xaf),
  CONSTRAINT ck_sales_sales_cancelled CHECK (cancelled_xaf >= 0 AND cancelled_xaf <= total_xaf),
  -- INV-VEN-06 : payé ≤ net (total − annulé).
  CONSTRAINT ck_sales_sales_paid CHECK (amount_paid_xaf >= 0 AND amount_paid_xaf <= total_xaf - cancelled_xaf),
  -- ADR-028 §5 : la vente passe CANCELLED quand toutes ses lignes sont annulées.
  CONSTRAINT ck_sales_sales_cancelled_status CHECK (status <> 'CANCELLED' OR cancelled_xaf = total_xaf),
  -- INV-VEN-07 (AV-027) : une vente sans client est intégralement payée.
  CONSTRAINT ck_sales_sales_anonymous CHECK (customer_id IS NOT NULL OR total_xaf - cancelled_xaf - amount_paid_xaf = 0),
  CONSTRAINT fk_sales_sales_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sales_order FOREIGN KEY (order_id) REFERENCES sales_sales_orders (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sales_customer FOREIGN KEY (customer_id) REFERENCES crm_customers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sales_channel FOREIGN KEY (channel_code) REFERENCES catalog_sales_channels (code) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sales_from_location FOREIGN KEY (from_location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sales_to_deliver_location FOREIGN KEY (to_deliver_location_id) REFERENCES organization_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sales_zone FOREIGN KEY (zone_id) REFERENCES organization_zones (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sales_seller FOREIGN KEY (seller_user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sales_commercial FOREIGN KEY (commercial_user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sales_work_session FOREIGN KEY (work_session_id) REFERENCES fieldwork_work_sessions (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sales_created_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sales_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sales_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- INV-VEN-02 : une vente confirmée est immuable ; seuls le montant annulé (jamais décroissant),
-- le payé dérivé des affectations, le statut, les anomalies (`flags`) et la session de caisse
-- (rattachement tardif, P5) évoluent. INV-VEN-10 : l'attribution est figée à la création.
CREATE TRIGGER trg_sales_sales_update_guard BEFORE UPDATE ON sales_sales FOR EACH ROW
BEGIN
  IF NOT (
    NEW.doc_number <=> OLD.doc_number AND
    NEW.local_ref <=> OLD.local_ref AND
    NEW.site_id <=> OLD.site_id AND
    NEW.sale_type <=> OLD.sale_type AND
    NEW.order_id <=> OLD.order_id AND
    NEW.customer_id <=> OLD.customer_id AND
    NEW.customer_category_id_snapshot <=> OLD.customer_category_id_snapshot AND
    NEW.channel_code <=> OLD.channel_code AND
    NEW.from_location_id <=> OLD.from_location_id AND
    NEW.to_deliver_location_id <=> OLD.to_deliver_location_id AND
    NEW.zone_id <=> OLD.zone_id AND
    NEW.seller_user_id <=> OLD.seller_user_id AND
    NEW.commercial_user_id <=> OLD.commercial_user_id AND
    NEW.work_session_id <=> OLD.work_session_id AND
    NEW.lat <=> OLD.lat AND
    NEW.lng <=> OLD.lng AND
    NEW.accuracy_m <=> OLD.accuracy_m AND
    NEW.subtotal_xaf <=> OLD.subtotal_xaf AND
    NEW.discount_total_xaf <=> OLD.discount_total_xaf AND
    NEW.tax_total_xaf <=> OLD.tax_total_xaf AND
    NEW.total_xaf <=> OLD.total_xaf AND
    NEW.due_date <=> OLD.due_date AND
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
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales : vente immuable (INV-VEN-02) ; corriger par un document d''annulation.';
  END IF;
  IF NEW.cancelled_xaf < OLD.cancelled_xaf THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales : le montant annulé ne diminue jamais (contre-écriture, ADR-028 §5).';
  END IF;
  IF OLD.status = 'CANCELLED' AND NEW.status <> 'CANCELLED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales : une vente annulée ne revient pas à CONFIRMED (SM-SALE).';
  END IF;
END;

CREATE TRIGGER trg_sales_sales_no_delete BEFORE DELETE ON sales_sales FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales : suppression physique interdite (INV-GLO-03) ; annuler par contre-écriture.';
END;

CREATE TABLE sales_sale_lines (
  id                          BINARY(16)     NOT NULL,
  sale_id                     BINARY(16)     NOT NULL,
  line_no                     SMALLINT       NOT NULL,
  order_line_id               BINARY(16)     NULL,
  product_id                  BINARY(16)     NOT NULL,
  product_name_snapshot       VARCHAR(200)   NOT NULL,
  quantity                    DECIMAL(14,3)  NOT NULL,
  unit_code                   VARCHAR(20)    NOT NULL,
  quantity_base               DECIMAL(14,3)  NOT NULL,
  pricing_quantity            DECIMAL(14,3)  NOT NULL,
  pricing_unit_code           VARCHAR(20)    NOT NULL,
  list_unit_price_xaf         BIGINT         NULL,
  unit_price_xaf              BIGINT         NOT NULL,
  price_rule_id               BINARY(16)     NULL,
  price_rule_version          INT            NULL,
  price_specificity           SMALLINT       NULL,
  price_source                VARCHAR(20)    NOT NULL,
  override_reason_code_id     BINARY(16)     NULL,
  override_approval_request_id BINARY(16)    NULL,
  discount_xaf                BIGINT         NOT NULL DEFAULT 0,
  tax_rate                    DECIMAL(7,4)   NOT NULL DEFAULT 0,
  line_total_xaf              BIGINT         NOT NULL,
  cancelled_quantity_base     DECIMAL(14,3)  NOT NULL DEFAULT 0,
  cancelled_xaf               BIGINT         NOT NULL DEFAULT 0,
  delivered_quantity_base     DECIMAL(14,3)  NOT NULL DEFAULT 0,
  unit_cost_xaf               BIGINT         NULL,
  cost_xaf                    BIGINT         NULL,
  allocation_id               BINARY(16)     NULL,
  client_lot_hint             BINARY(16)     NULL,
  created_at                  DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_sales_sale_lines_line_no (sale_id, line_no),
  KEY ix_sales_sale_lines_product (product_id),
  KEY ix_sales_sale_lines_order_line (order_line_id),
  KEY ix_sales_sale_lines_price_rule (price_rule_id),
  CONSTRAINT ck_sales_sale_lines_quantities CHECK (quantity > 0 AND quantity_base > 0 AND pricing_quantity > 0),
  CONSTRAINT ck_sales_sale_lines_price_source CHECK (price_source IN ('RULE', 'ORDER_QUOTE', 'MANUAL_OVERRIDE')),
  CONSTRAINT ck_sales_sale_lines_override CHECK (price_source <> 'MANUAL_OVERRIDE' OR override_reason_code_id IS NOT NULL),
  CONSTRAINT ck_sales_sale_lines_prices CHECK (
    unit_price_xaf >= 0 AND discount_xaf >= 0 AND tax_rate >= 0 AND tax_rate <= 1
    AND (list_unit_price_xaf IS NULL OR list_unit_price_xaf >= 0)
  ),
  -- INV-VEN-03, BR-VEN-014 : montant = arrondi au franc (demi supérieur) de quantité de tarification
  -- × prix appliqué, moins la remise.
  CONSTRAINT ck_sales_sale_lines_total CHECK (
    line_total_xaf >= 0 AND line_total_xaf = ROUND(pricing_quantity * unit_price_xaf, 0) - discount_xaf
  ),
  -- ADR-028 §5 : la dernière annulation d'une ligne emporte son montant exact.
  CONSTRAINT ck_sales_sale_lines_cancelled CHECK (
    cancelled_quantity_base >= 0 AND cancelled_quantity_base <= quantity_base
    AND cancelled_xaf >= 0 AND cancelled_xaf <= line_total_xaf
    AND (cancelled_quantity_base < quantity_base OR cancelled_xaf = line_total_xaf)
  ),
  -- Livré ≤ vendu net (INV-VEN-04, côté vente) ; une vente directe n'utilise pas ce compteur.
  CONSTRAINT ck_sales_sale_lines_delivered CHECK (
    delivered_quantity_base >= 0 AND delivered_quantity_base <= quantity_base - cancelled_quantity_base
  ),
  CONSTRAINT ck_sales_sale_lines_cost CHECK (
    (unit_cost_xaf IS NULL OR unit_cost_xaf >= 0) AND (cost_xaf IS NULL OR cost_xaf >= 0)
  ),
  CONSTRAINT fk_sales_sale_lines_sale FOREIGN KEY (sale_id) REFERENCES sales_sales (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sale_lines_order_line FOREIGN KEY (order_line_id) REFERENCES sales_sales_order_lines (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sale_lines_product FOREIGN KEY (product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sale_lines_unit FOREIGN KEY (unit_code) REFERENCES catalog_units (code) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sale_lines_pricing_unit FOREIGN KEY (pricing_unit_code) REFERENCES catalog_units (code) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sale_lines_price_rule FOREIGN KEY (price_rule_id) REFERENCES pricing_price_rules (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sale_lines_override_reason FOREIGN KEY (override_reason_code_id) REFERENCES catalog_reason_codes (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sale_lines_override_approval FOREIGN KEY (override_approval_request_id) REFERENCES approvals_approval_requests (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sale_lines_allocation FOREIGN KEY (allocation_id) REFERENCES inventory_stock_allocations (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Une ligne de vente est un fait figé (BR-VEN-013) ; seuls évoluent les compteurs d'annulation et
-- de livraison (jamais décroissants) et le coût, renseigné une seule fois par le serveur.
CREATE TRIGGER trg_sales_sale_lines_update_guard BEFORE UPDATE ON sales_sale_lines FOR EACH ROW
BEGIN
  IF NOT (
    NEW.sale_id <=> OLD.sale_id AND
    NEW.line_no <=> OLD.line_no AND
    NEW.order_line_id <=> OLD.order_line_id AND
    NEW.product_id <=> OLD.product_id AND
    NEW.product_name_snapshot <=> OLD.product_name_snapshot AND
    NEW.quantity <=> OLD.quantity AND
    NEW.unit_code <=> OLD.unit_code AND
    NEW.quantity_base <=> OLD.quantity_base AND
    NEW.pricing_quantity <=> OLD.pricing_quantity AND
    NEW.pricing_unit_code <=> OLD.pricing_unit_code AND
    NEW.list_unit_price_xaf <=> OLD.list_unit_price_xaf AND
    NEW.unit_price_xaf <=> OLD.unit_price_xaf AND
    NEW.price_rule_id <=> OLD.price_rule_id AND
    NEW.price_rule_version <=> OLD.price_rule_version AND
    NEW.price_specificity <=> OLD.price_specificity AND
    NEW.price_source <=> OLD.price_source AND
    NEW.override_reason_code_id <=> OLD.override_reason_code_id AND
    NEW.override_approval_request_id <=> OLD.override_approval_request_id AND
    NEW.discount_xaf <=> OLD.discount_xaf AND
    NEW.tax_rate <=> OLD.tax_rate AND
    NEW.line_total_xaf <=> OLD.line_total_xaf AND
    NEW.allocation_id <=> OLD.allocation_id AND
    NEW.client_lot_hint <=> OLD.client_lot_hint AND
    NEW.created_at <=> OLD.created_at
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sale_lines : ligne de vente immuable (INV-VEN-02) ; seuls annulé, livré et coût évoluent.';
  END IF;
  IF NEW.cancelled_quantity_base < OLD.cancelled_quantity_base OR NEW.cancelled_xaf < OLD.cancelled_xaf
     OR NEW.delivered_quantity_base < OLD.delivered_quantity_base THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sale_lines : les quantités annulée et livrée ne diminuent jamais.';
  END IF;
  IF (OLD.cost_xaf IS NOT NULL AND NOT (NEW.cost_xaf <=> OLD.cost_xaf))
     OR (OLD.unit_cost_xaf IS NOT NULL AND NOT (NEW.unit_cost_xaf <=> OLD.unit_cost_xaf)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sale_lines : le coût figé de la ligne ne change plus (ADR-025 §4).';
  END IF;
END;

CREATE TRIGGER trg_sales_sale_lines_no_delete BEFORE DELETE ON sales_sale_lines FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sale_lines : suppression physique interdite (INV-GLO-03).';
END;

CREATE TABLE sales_sale_cancellations (
  id                        BINARY(16)     NOT NULL,
  doc_number                VARCHAR(40)    NOT NULL,
  local_ref                 VARCHAR(20)    NULL,
  site_id                   BINARY(16)     NOT NULL,
  sale_id                   BINARY(16)     NOT NULL,
  order_id                  BINARY(16)     NULL,
  cause                     VARCHAR(25)    NOT NULL,
  status                    VARCHAR(15)    NOT NULL,
  reason_code_id            BINARY(16)     NULL,
  comment                   TEXT           NULL,
  requested_by              BINARY(16)     NOT NULL,
  approval_request_id       BINARY(16)     NULL,
  cancelled_total_xaf       BIGINT         NOT NULL,
  released_payment_treatment VARCHAR(20)   NULL,
  applied_at                DATETIME(6)    NULL,
  occurred_at               DATETIME(6)    NOT NULL,
  client_created_at         DATETIME(6)    NULL,
  received_at_server        DATETIME(6)    NULL,
  command_id                BINARY(16)     NULL,
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
  UNIQUE KEY uq_sales_sale_cancellations_doc_number (doc_number),
  UNIQUE KEY uq_sales_sale_cancellations_device_ref (created_device_id, local_ref),
  KEY ix_sales_sale_cancellations_sale (sale_id, status),
  KEY ix_sales_sale_cancellations_order (order_id),
  KEY ix_sales_sale_cancellations_command (command_id),
  KEY ix_sales_sale_cancellations_applied (applied_at),
  CONSTRAINT ck_sales_sale_cancellations_cause CHECK (cause IN (
    'SALE_CANCELLATION', 'ORDER_CANCELLATION', 'ORDER_CLOSURE', 'ORDER_ADJUSTMENT'
  )),
  CONSTRAINT ck_sales_sale_cancellations_status CHECK (status IN ('REQUESTED', 'APPLIED', 'REJECTED')),
  CONSTRAINT ck_sales_sale_cancellations_applied CHECK ((status = 'APPLIED') = (applied_at IS NOT NULL)),
  CONSTRAINT ck_sales_sale_cancellations_total CHECK (cancelled_total_xaf >= 0),
  CONSTRAINT ck_sales_sale_cancellations_treatment CHECK (
    released_payment_treatment IS NULL OR released_payment_treatment IN ('CUSTOMER_CREDIT', 'REFUND')
  ),
  CONSTRAINT fk_sales_sale_cancellations_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sale_cancellations_sale FOREIGN KEY (sale_id) REFERENCES sales_sales (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sale_cancellations_order FOREIGN KEY (order_id) REFERENCES sales_sales_orders (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sale_cancellations_reason FOREIGN KEY (reason_code_id) REFERENCES catalog_reason_codes (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sale_cancellations_requested_by FOREIGN KEY (requested_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sale_cancellations_approval FOREIGN KEY (approval_request_id) REFERENCES approvals_approval_requests (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sale_cancellations_created_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sale_cancellations_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sale_cancellations_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Un document d'annulation est une contre-écriture : sa nature, ses montants et ses lignes sont
-- fixés ; seuls son statut (REQUESTED → APPLIED ou REJECTED, une fois), son effet et le sort des
-- paiements libérés évoluent.
CREATE TRIGGER trg_sales_sale_cancellations_update_guard BEFORE UPDATE ON sales_sale_cancellations FOR EACH ROW
BEGIN
  IF NOT (
    NEW.doc_number <=> OLD.doc_number AND
    NEW.local_ref <=> OLD.local_ref AND
    NEW.site_id <=> OLD.site_id AND
    NEW.sale_id <=> OLD.sale_id AND
    NEW.order_id <=> OLD.order_id AND
    NEW.cause <=> OLD.cause AND
    NEW.reason_code_id <=> OLD.reason_code_id AND
    NEW.comment <=> OLD.comment AND
    NEW.requested_by <=> OLD.requested_by AND
    NEW.cancelled_total_xaf <=> OLD.cancelled_total_xaf AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_device_id <=> OLD.created_device_id AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sale_cancellations : document d''annulation immuable ; seuls statut et sort des paiements évoluent.';
  END IF;
  IF OLD.status <> 'REQUESTED' AND NEW.status <> OLD.status THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sale_cancellations : une annulation appliquée ou rejetée ne change plus de statut.';
  END IF;
END;

CREATE TRIGGER trg_sales_sale_cancellations_no_delete BEFORE DELETE ON sales_sale_cancellations FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sale_cancellations : suppression physique interdite (INV-GLO-03).';
END;

CREATE TABLE sales_sale_cancellation_lines (
  id               BINARY(16)     NOT NULL,
  cancellation_id  BINARY(16)     NOT NULL,
  sale_line_id     BINARY(16)     NOT NULL,
  quantity_base    DECIMAL(14,3)  NOT NULL,
  amount_xaf       BIGINT         NOT NULL,
  created_at       DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_sales_sale_cancellation_lines_line (cancellation_id, sale_line_id),
  KEY ix_sales_sale_cancellation_lines_sale_line (sale_line_id),
  CONSTRAINT ck_sales_sale_cancellation_lines_amounts CHECK (quantity_base > 0 AND amount_xaf >= 0),
  CONSTRAINT fk_sales_sale_cancellation_lines_cancellation FOREIGN KEY (cancellation_id) REFERENCES sales_sale_cancellations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_sale_cancellation_lines_sale_line FOREIGN KEY (sale_line_id) REFERENCES sales_sale_lines (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_sales_sale_cancellation_lines_no_update BEFORE UPDATE ON sales_sale_cancellation_lines FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sale_cancellation_lines : ligne d''annulation immuable (contre-écriture).';
END;

CREATE TRIGGER trg_sales_sale_cancellation_lines_no_delete BEFORE DELETE ON sales_sale_cancellation_lines FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sale_cancellation_lines : suppression physique interdite (INV-GLO-03).';
END;

-- Droits par table (INV-GLO-05) : aucune suppression ; les lignes d'annulation sont en ajout seul.
GRANT SELECT, INSERT, UPDATE ON sales_sales TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON sales_sale_lines TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON sales_sale_cancellations TO 'gic_app'@'%';
GRANT SELECT, INSERT ON sales_sale_cancellation_lines TO 'gic_app'@'%';

-- migrate:down transaction:false
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS sales_sale_cancellation_lines;
DROP TABLE IF EXISTS sales_sale_cancellations;
DROP TABLE IF EXISTS sales_sale_lines;
DROP TABLE IF EXISTS sales_sales;
SET FOREIGN_KEY_CHECKS = 1;
