-- Espace de noms `inventory`, lot de stock : indicateur « vendable depuis l'élevage » (P4-03,
-- BR-PRD-010, BR-VEN-017). Seuls les animaux d'un lot de production `SELLING` se vendent
-- directement depuis un emplacement d'élevage ; `sales` ne peut pas importer `production`
-- (graphe des dépendances), l'état est donc porté par le lot de stock de traçabilité (lots
-- permanents compris, AV-109) et tenu par `production` à chaque passage `ACTIVE` ↔ `SELLING`, via
-- l'API publique d'`inventory`. Le déclencheur d'immuabilité des lots ne fige pas cette colonne.
--
-- migrate:up transaction:false

ALTER TABLE inventory_stock_lots
  ADD COLUMN sellable_from_rearing BOOLEAN NOT NULL DEFAULT FALSE AFTER status;

-- Lots de production déjà en vente.
UPDATE inventory_stock_lots l
  JOIN production_production_lots p ON p.stock_lot_id = l.id
  SET l.sellable_from_rearing = TRUE
  WHERE p.status = 'SELLING';

-- migrate:down transaction:false
ALTER TABLE inventory_stock_lots DROP COLUMN sellable_from_rearing;
