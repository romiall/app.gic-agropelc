-- Espace de noms `inventory` (P2-04). Ajoute le type de mouvement `CONSUMPTION_REVERSAL`
-- (dictionnaire §consumptions : « Suppr. ANNULATION (mouvement inverse + écriture de coût
-- inverse) » ; BR-STK-002, BR-STK-036) : contrepartie explicite de `CONSUMPTION`
-- (V_CONSUMPTION -> emplacement), au même titre que `SUPPLIER_RETURN`/`CUSTOMER_RETURN`/
-- `LOSS_RELEASE` déjà prévus dans le catalogue (D06 §7.7) pour chaque annulation qui n'a pas
-- déjà de type dédié.
--
-- migrate:up transaction:false

ALTER TABLE inventory_stock_moves
  DROP CHECK ck_inventory_stock_moves_move_type,
  ADD CONSTRAINT ck_inventory_stock_moves_move_type CHECK (move_type IN (
    'OPENING_BALANCE', 'PURCHASE_RECEIPT', 'SUPPLIER_RETURN', 'TRANSFER_DISPATCH', 'TRANSFER_RECEIPT',
    'TRANSFER_DISCREPANCY', 'INTERNAL_MOVE', 'SALE', 'CUSTOMER_RETURN', 'LOSS', 'LOSS_PENDING',
    'LOSS_CONFIRMATION', 'LOSS_RELEASE', 'CONSUMPTION', 'CONSUMPTION_REVERSAL', 'PRODUCTION_OUTPUT',
    'PRODUCTION_INPUT', 'INVENTORY_GAIN', 'INVENTORY_LOSS'
  ));

-- migrate:down transaction:false

ALTER TABLE inventory_stock_moves
  DROP CHECK ck_inventory_stock_moves_move_type,
  ADD CONSTRAINT ck_inventory_stock_moves_move_type CHECK (move_type IN (
    'OPENING_BALANCE', 'PURCHASE_RECEIPT', 'SUPPLIER_RETURN', 'TRANSFER_DISPATCH', 'TRANSFER_RECEIPT',
    'TRANSFER_DISCREPANCY', 'INTERNAL_MOVE', 'SALE', 'CUSTOMER_RETURN', 'LOSS', 'LOSS_PENDING',
    'LOSS_CONFIRMATION', 'LOSS_RELEASE', 'CONSUMPTION', 'PRODUCTION_OUTPUT', 'PRODUCTION_INPUT',
    'INVENTORY_GAIN', 'INVENTORY_LOSS'
  ));
