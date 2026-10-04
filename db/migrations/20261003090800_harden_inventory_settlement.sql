-- Espace de noms `inventory`, durcissement du registre après relecture adverse de P4-02 (2/2) :
-- - un `CUSTOMER_RETURN` rattaché ne s'inverse pas non plus (le stock repartirait chez le client
--   alors que la part reste consommée dans le plafond : une revente est un nouveau `SALE`) ;
-- - un `SALE` vers un emplacement « à livrer » cible celui du SITE de l'emplacement source
--   (INV-STK-18 : les soldes par site ne dérivent pas) ;
-- - le type de mouvement et le document source sont liés : `DELIVERY` ⇔ document `DELIVERY`, un
--   document `SALE_CANCELLATION` ne produit que des `CUSTOMER_RETURN`.
-- Le reste du déclencheur est inchangé (migration 20261003090200).
--
-- migrate:up transaction:false

ALTER TABLE inventory_stock_moves
  ADD CONSTRAINT ck_inventory_stock_moves_delivery_doc CHECK ((move_type = 'DELIVERY') = (source_doc_type = 'DELIVERY')),
  ADD CONSTRAINT ck_inventory_stock_moves_cancellation_doc CHECK (source_doc_type <> 'SALE_CANCELLATION' OR move_type = 'CUSTOMER_RETURN');

DROP TRIGGER trg_inventory_stock_moves_settlement_guard;

CREATE TRIGGER trg_inventory_stock_moves_settlement_guard BEFORE INSERT ON inventory_stock_moves FOR EACH ROW
BEGIN
  DECLARE r_type VARCHAR(30);
  DECLARE o_product BINARY(16);
  DECLARE o_lot BINARY(16);
  DECLARE o_type VARCHAR(30);
  DECLARE o_qty DECIMAL(14,3);
  DECLARE o_value BIGINT;
  DECLARE o_from BINARY(16);
  DECLARE o_to BINARY(16);
  DECLARE o_reversal TINYINT(1);
  DECLARE o_to_type VARCHAR(20);
  DECLARE n_to_type VARCHAR(20);
  DECLARE n_to_site BINARY(16);
  DECLARE n_from_site BINARY(16);
  DECLARE n_done BIGINT;
  DECLARE q_done DECIMAL(14,3);
  DECLARE v_done DECIMAL(30,0);

  IF NEW.reverses_move_id IS NOT NULL THEN
    SELECT move_type INTO r_type FROM inventory_stock_moves WHERE id = NEW.reverses_move_id;
    IF r_type IN ('SALE', 'DELIVERY', 'CUSTOMER_RETURN') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : une vente, une livraison ou un retour ne s''inverse pas (INV-STK-17, ADR-029).';
    END IF;
  END IF;

  -- Une vente vers « à livrer » cible l'emplacement « à livrer » du site de sa source (INV-STK-18).
  IF NEW.origin_move_id IS NULL AND NEW.move_type = 'SALE' THEN
    SELECT location_type, site_id INTO n_to_type, n_to_site FROM organization_locations WHERE id = NEW.to_location_id;
    IF n_to_type = 'V_TO_DELIVER' THEN
      SELECT site_id INTO n_from_site FROM organization_locations WHERE id = NEW.from_location_id;
      IF n_from_site IS NULL OR n_from_site <> n_to_site THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : « à livrer » doit être celui du site de la source (INV-STK-18).';
      END IF;
    END IF;
  END IF;

  IF NEW.origin_move_id IS NOT NULL THEN
    SELECT product_id, lot_id, move_type, quantity, value_xaf, from_location_id, to_location_id, is_reversal
      INTO o_product, o_lot, o_type, o_qty, o_value, o_from, o_to, o_reversal
      FROM inventory_stock_moves WHERE id = NEW.origin_move_id;
    IF o_type IS NULL OR o_type <> 'SALE' OR o_reversal = 1 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : l''origine doit être un mouvement SALE non inverse (INV-STK-17).';
    END IF;
    IF NEW.product_id <> o_product OR NOT (NEW.lot_id <=> o_lot) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : produit ou lot différent de l''origine (INV-STK-17).';
    END IF;
    IF NEW.from_location_id <> o_to THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : départ différent de l''arrivée de l''origine (INV-STK-17).';
    END IF;
    IF NEW.move_type = 'CUSTOMER_RETURN' AND NEW.to_location_id <> o_from THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : un retour revient au départ de l''origine (INV-STK-17).';
    END IF;
    IF NEW.move_type = 'DELIVERY' THEN
      SELECT location_type INTO o_to_type FROM organization_locations WHERE id = o_to;
      SELECT location_type INTO n_to_type FROM organization_locations WHERE id = NEW.to_location_id;
      IF o_to_type IS NULL OR o_to_type <> 'V_TO_DELIVER' OR n_to_type IS NULL OR n_to_type <> 'V_CUSTOMER' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : une livraison va de V_TO_DELIVER vers V_CUSTOMER (INV-STK-17).';
      END IF;
    END IF;
    SELECT COUNT(*), COALESCE(SUM(quantity), 0), COALESCE(SUM(value_xaf), 0)
      INTO n_done, q_done, v_done
      FROM inventory_stock_moves WHERE origin_move_id = NEW.origin_move_id;
    IF NEW.origin_seq IS NULL OR NEW.origin_seq <> n_done + 1 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : séquence de rattachement invalide (INV-STK-17).';
    END IF;
    IF q_done + NEW.quantity > o_qty THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : quantité au-delà de l''origine (INV-STK-17).';
    END IF;
    IF v_done + NEW.value_xaf > o_value THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : valeur au-delà de l''origine (INV-STK-17).';
    END IF;
    IF q_done + NEW.quantity = o_qty AND v_done + NEW.value_xaf <> o_value THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : le dernier mouvement doit solder la valeur exacte (INV-STK-17).';
    END IF;
  END IF;
END;

-- migrate:down transaction:false
-- Restaure la version précédente du déclencheur (migration 20261003090200).

DROP TRIGGER trg_inventory_stock_moves_settlement_guard;

CREATE TRIGGER trg_inventory_stock_moves_settlement_guard BEFORE INSERT ON inventory_stock_moves FOR EACH ROW
BEGIN
  DECLARE r_type VARCHAR(30);
  DECLARE o_product BINARY(16);
  DECLARE o_lot BINARY(16);
  DECLARE o_type VARCHAR(30);
  DECLARE o_qty DECIMAL(14,3);
  DECLARE o_value BIGINT;
  DECLARE o_from BINARY(16);
  DECLARE o_to BINARY(16);
  DECLARE o_reversal TINYINT(1);
  DECLARE o_to_type VARCHAR(20);
  DECLARE n_to_type VARCHAR(20);
  DECLARE n_done BIGINT;
  DECLARE q_done DECIMAL(14,3);
  DECLARE v_done DECIMAL(30,0);

  IF NEW.reverses_move_id IS NOT NULL THEN
    SELECT move_type INTO r_type FROM inventory_stock_moves WHERE id = NEW.reverses_move_id;
    IF r_type IN ('SALE', 'DELIVERY') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : une vente ou une livraison ne s''inverse pas (INV-STK-17, ADR-029).';
    END IF;
  END IF;

  IF NEW.origin_move_id IS NOT NULL THEN
    SELECT product_id, lot_id, move_type, quantity, value_xaf, from_location_id, to_location_id, is_reversal
      INTO o_product, o_lot, o_type, o_qty, o_value, o_from, o_to, o_reversal
      FROM inventory_stock_moves WHERE id = NEW.origin_move_id;
    IF o_type IS NULL OR o_type <> 'SALE' OR o_reversal = 1 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : l''origine doit être un mouvement SALE non inverse (INV-STK-17).';
    END IF;
    IF NEW.product_id <> o_product OR NOT (NEW.lot_id <=> o_lot) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : produit ou lot différent de l''origine (INV-STK-17).';
    END IF;
    IF NEW.from_location_id <> o_to THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : départ différent de l''arrivée de l''origine (INV-STK-17).';
    END IF;
    IF NEW.move_type = 'CUSTOMER_RETURN' AND NEW.to_location_id <> o_from THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : un retour revient au départ de l''origine (INV-STK-17).';
    END IF;
    IF NEW.move_type = 'DELIVERY' THEN
      SELECT location_type INTO o_to_type FROM organization_locations WHERE id = o_to;
      SELECT location_type INTO n_to_type FROM organization_locations WHERE id = NEW.to_location_id;
      IF o_to_type IS NULL OR o_to_type <> 'V_TO_DELIVER' OR n_to_type IS NULL OR n_to_type <> 'V_CUSTOMER' THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : une livraison va de V_TO_DELIVER vers V_CUSTOMER (INV-STK-17).';
      END IF;
    END IF;
    SELECT COUNT(*), COALESCE(SUM(quantity), 0), COALESCE(SUM(value_xaf), 0)
      INTO n_done, q_done, v_done
      FROM inventory_stock_moves WHERE origin_move_id = NEW.origin_move_id;
    IF NEW.origin_seq IS NULL OR NEW.origin_seq <> n_done + 1 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : séquence de rattachement invalide (INV-STK-17).';
    END IF;
    IF q_done + NEW.quantity > o_qty THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : quantité au-delà de l''origine (INV-STK-17).';
    END IF;
    IF v_done + NEW.value_xaf > o_value THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : valeur au-delà de l''origine (INV-STK-17).';
    END IF;
    IF q_done + NEW.quantity = o_qty AND v_done + NEW.value_xaf <> o_value THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_moves : le dernier mouvement doit solder la valeur exacte (INV-STK-17).';
    END IF;
  END IF;
END;

ALTER TABLE inventory_stock_moves
  DROP CHECK ck_inventory_stock_moves_cancellation_doc,
  DROP CHECK ck_inventory_stock_moves_delivery_doc;
