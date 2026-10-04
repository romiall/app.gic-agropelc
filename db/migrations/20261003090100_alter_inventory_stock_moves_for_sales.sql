-- Espace de noms `inventory`, registre de stock : mouvements rattachés à une origine (P4-02 2/2,
-- ADR-029). Un retour client (`CUSTOMER_RETURN`) et une livraison (`DELIVERY`) ne sont pas des
-- inverses : chacun consomme une part d'un mouvement `SALE` d'origine (`origin_move_id`,
-- `origin_seq` 1, 2, 3…). INV-STK-04, `UNIQUE (reverses_move_id)` et les inverses restent
-- inchangés ; le déclencheur de plafond est dans la migration suivante.
--
-- Les listes de types reprennent l'état actuel de db/schema.sql (jamais une ancienne migration) ;
-- elles ajoutent le type de mouvement `DELIVERY` et les documents sources `SALE_CANCELLATION`
-- (17 caractères, colonne VARCHAR(20)) et `DELIVERY`.
--
-- migrate:up transaction:false

ALTER TABLE inventory_stock_moves
  ADD COLUMN origin_move_id  BINARY(16)   NULL AFTER reverses_move_id,
  ADD COLUMN origin_seq      INT UNSIGNED NULL AFTER origin_move_id;

-- L'unicité sert d'index à la clé étrangère (origin_move_id en tête) ; les NULL multiples sont
-- admis, comme pour `uq_inventory_stock_moves_reverses`.
ALTER TABLE inventory_stock_moves
  ADD UNIQUE KEY uq_inventory_stock_moves_origin_seq (origin_move_id, origin_seq),
  ADD CONSTRAINT fk_inventory_stock_moves_origin FOREIGN KEY (origin_move_id) REFERENCES inventory_stock_moves (id) ON DELETE RESTRICT;

ALTER TABLE inventory_stock_moves
  ADD CONSTRAINT ck_inventory_stock_moves_origin CHECK (
    (origin_move_id IS NULL AND origin_seq IS NULL)
    OR (origin_move_id IS NOT NULL AND origin_seq IS NOT NULL AND origin_seq >= 1
        AND is_reversal = FALSE AND move_type IN ('CUSTOMER_RETURN', 'DELIVERY'))
  ),
  ADD CONSTRAINT ck_inventory_stock_moves_settlement CHECK (
    move_type NOT IN ('CUSTOMER_RETURN', 'DELIVERY') OR origin_move_id IS NOT NULL
  ),
  DROP CHECK ck_inventory_stock_moves_move_type,
  ADD CONSTRAINT ck_inventory_stock_moves_move_type CHECK (move_type IN (
    'OPENING_BALANCE', 'PURCHASE_RECEIPT', 'SUPPLIER_RETURN', 'TRANSFER_DISPATCH', 'TRANSFER_RECEIPT',
    'TRANSFER_DISCREPANCY', 'INTERNAL_MOVE', 'SALE', 'CUSTOMER_RETURN', 'DELIVERY', 'LOSS', 'LOSS_PENDING',
    'LOSS_CONFIRMATION', 'LOSS_RELEASE', 'CONSUMPTION', 'CONSUMPTION_REVERSAL', 'PRODUCTION_OUTPUT',
    'PRODUCTION_INPUT', 'INVENTORY_GAIN', 'INVENTORY_LOSS'
  )),
  DROP CHECK ck_inventory_stock_moves_source_doc_type,
  ADD CONSTRAINT ck_inventory_stock_moves_source_doc_type CHECK (source_doc_type IN (
    'SALE', 'TRANSFER', 'LOSS', 'CONSUMPTION', 'INVENTORY_COUNT', 'GOODS_RECEIPT', 'EGG_COLLECTION',
    'INCUBATION_EVENT', 'LOT_ENTRY', 'SLAUGHTER', 'LOT_TRANSFER', 'SALE_CANCELLATION', 'DELIVERY'
  ));

-- migrate:down transaction:false
-- Les anciennes listes de types sont restaurées D'ABORD, en un seul ALTER : s'il existe un mouvement
-- DELIVERY ou un document source SALE_CANCELLATION / DELIVERY, l'instruction échoue sans aucun
-- effet de bord et les liens d'origine sont conservés. Ne pas défaire cette migration sur une
-- base qui contient des retours ou des livraisons rattachés (le registre est en ajout seul).

ALTER TABLE inventory_stock_moves
  DROP CHECK ck_inventory_stock_moves_move_type,
  ADD CONSTRAINT ck_inventory_stock_moves_move_type CHECK (move_type IN (
    'OPENING_BALANCE', 'PURCHASE_RECEIPT', 'SUPPLIER_RETURN', 'TRANSFER_DISPATCH', 'TRANSFER_RECEIPT',
    'TRANSFER_DISCREPANCY', 'INTERNAL_MOVE', 'SALE', 'CUSTOMER_RETURN', 'LOSS', 'LOSS_PENDING',
    'LOSS_CONFIRMATION', 'LOSS_RELEASE', 'CONSUMPTION', 'CONSUMPTION_REVERSAL', 'PRODUCTION_OUTPUT',
    'PRODUCTION_INPUT', 'INVENTORY_GAIN', 'INVENTORY_LOSS'
  )),
  DROP CHECK ck_inventory_stock_moves_source_doc_type,
  ADD CONSTRAINT ck_inventory_stock_moves_source_doc_type CHECK (source_doc_type IN (
    'SALE', 'TRANSFER', 'LOSS', 'CONSUMPTION', 'INVENTORY_COUNT', 'GOODS_RECEIPT', 'EGG_COLLECTION',
    'INCUBATION_EVENT', 'LOT_ENTRY', 'SLAUGHTER', 'LOT_TRANSFER'
  ));

ALTER TABLE inventory_stock_moves
  DROP CHECK ck_inventory_stock_moves_settlement,
  DROP CHECK ck_inventory_stock_moves_origin,
  DROP FOREIGN KEY fk_inventory_stock_moves_origin;

ALTER TABLE inventory_stock_moves
  DROP KEY uq_inventory_stock_moves_origin_seq,
  DROP COLUMN origin_seq,
  DROP COLUMN origin_move_id;
