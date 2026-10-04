-- Espace de noms `sales`, bons de livraison (P4-02 2/2). Source : ADR-028 §7, AV-034 ; D04 §6.
-- Une livraison, même partielle, est un document `LIV` : livreur, heure de remise, réceptionnaire,
-- preuve éventuelle, quantités par ligne de vente ; plusieurs livraisons par commande. Une
-- livraison ne dépasse pas le vendu non livré (INV-VEN-04) : plafond tenu par les compteurs des
-- lignes de vente et de commande, et par le mouvement `DELIVERY` rattaché au mouvement `SALE`
-- (INV-STK-17).
--
-- Un bon de livraison est un fait en ajout seul : ni modification, ni suppression, ni statut. Le
-- retour de marchandise déjà livrée est hors MVP (AV-029) et la correction d'un bon saisi par
-- erreur n'existe pas en V1 (AV-134) ; les ajouter plus tard ne casse pas cette structure.
-- `command_id` est unique : une commande de synchronisation ne crée qu'un bon de livraison.
--
-- migrate:up transaction:false

CREATE TABLE sales_delivery_notes (
  id                    BINARY(16)     NOT NULL,
  doc_number            VARCHAR(40)    NOT NULL,
  local_ref             VARCHAR(20)    NULL,
  site_id               BINARY(16)     NOT NULL,
  order_id              BINARY(16)     NOT NULL,
  delivered_by_user_id  BINARY(16)     NOT NULL,
  recipient_name        VARCHAR(200)   NULL,
  proof_attachment_id   BINARY(16)     NULL,
  notes                 TEXT           NULL,
  occurred_at           DATETIME(6)    NOT NULL,
  business_date         DATE           GENERATED ALWAYS AS (CAST(CONVERT_TZ(occurred_at, '+00:00', '+01:00') AS DATE)) STORED,
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
  UNIQUE KEY uq_sales_delivery_notes_doc_number (doc_number),
  UNIQUE KEY uq_sales_delivery_notes_command (command_id),
  UNIQUE KEY uq_sales_delivery_notes_device_ref (created_device_id, local_ref),
  KEY ix_sales_delivery_notes_order (order_id, occurred_at),
  KEY ix_sales_delivery_notes_business_date (site_id, business_date),
  KEY ix_sales_delivery_notes_deliverer (delivered_by_user_id, business_date),
  CONSTRAINT fk_sales_delivery_notes_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_delivery_notes_order FOREIGN KEY (order_id) REFERENCES sales_sales_orders (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_delivery_notes_deliverer FOREIGN KEY (delivered_by_user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_delivery_notes_proof FOREIGN KEY (proof_attachment_id) REFERENCES attachments_attachments (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_delivery_notes_created_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_delivery_notes_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_sales_delivery_notes_no_update BEFORE UPDATE ON sales_delivery_notes FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_delivery_notes : bon de livraison immuable (ADR-028 §7).';
END;

CREATE TRIGGER trg_sales_delivery_notes_no_delete BEFORE DELETE ON sales_delivery_notes FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_delivery_notes : suppression physique interdite (INV-GLO-03).';
END;

CREATE TABLE sales_delivery_note_lines (
  id                  BINARY(16)     NOT NULL,
  delivery_note_id    BINARY(16)     NOT NULL,
  order_line_id       BINARY(16)     NOT NULL,
  sale_line_id        BINARY(16)     NOT NULL,
  quantity_base       DECIMAL(14,3)  NOT NULL,
  created_at          DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_sales_delivery_note_lines_sale_line (delivery_note_id, sale_line_id),
  KEY ix_sales_delivery_note_lines_order_line (order_line_id),
  KEY ix_sales_delivery_note_lines_sale_line (sale_line_id),
  CONSTRAINT ck_sales_delivery_note_lines_quantity CHECK (quantity_base > 0),
  CONSTRAINT fk_sales_delivery_note_lines_note FOREIGN KEY (delivery_note_id) REFERENCES sales_delivery_notes (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_delivery_note_lines_order_line FOREIGN KEY (order_line_id) REFERENCES sales_sales_order_lines (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sales_delivery_note_lines_sale_line FOREIGN KEY (sale_line_id) REFERENCES sales_sale_lines (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_sales_delivery_note_lines_no_update BEFORE UPDATE ON sales_delivery_note_lines FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_delivery_note_lines : ligne de livraison immuable (ADR-028 §7).';
END;

CREATE TRIGGER trg_sales_delivery_note_lines_no_delete BEFORE DELETE ON sales_delivery_note_lines FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_delivery_note_lines : suppression physique interdite (INV-GLO-03).';
END;

-- Droits par table (INV-GLO-05) : ajout seul.
GRANT SELECT, INSERT ON sales_delivery_notes TO 'gic_app'@'%';
GRANT SELECT, INSERT ON sales_delivery_note_lines TO 'gic_app'@'%';

-- migrate:down transaction:false
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS sales_delivery_note_lines;
DROP TABLE IF EXISTS sales_delivery_notes;
SET FOREIGN_KEY_CHECKS = 1;
