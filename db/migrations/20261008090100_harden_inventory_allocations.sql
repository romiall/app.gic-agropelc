-- Module `inventory`, durcissement des quotas d'appareil (P5-04). Source : ADR-033 (quota d'appareil
-- seul, reste jamais négatif, restitution), ADR-028 §4 (plus de réservation de commande), SM-ALLOCATION,
-- INV-STK-10, INV-STK-11, INV-STK-20 ; AV-160 à AV-162.
--
-- - `allocation_type` = `DEVICE_QUOTA` seul : `ORDER_RESERVATION` et `sales_order_line_id` n'ont plus
--   d'objet (la confirmation d'une commande vend le disponible vers « à livrer ») ; aucun code ne
--   les écrivait ; l'entrée `TRANSFER` disparaît avec la réservation transférable ;
-- - le reste d'un quota est ≥ 0, un quota fermé ou révoqué a un reste nul, un état est cohérent avec
--   ses données ; la consommation et sa restitution sont des entrées signées liées à un mouvement,
--   une fois par mouvement ;
-- - garde d'UPDATE à liste blanche : identité immuable, quantités accordées jamais en baisse, états
--   terminaux figés.
--
-- migrate:up transaction:false

ALTER TABLE inventory_stock_allocations
  DROP CHECK ck_inventory_stock_allocations_type,
  DROP CHECK ck_inventory_stock_allocations_close_cause,
  DROP CHECK ck_inventory_stock_allocations_holder,
  DROP COLUMN sales_order_line_id,
  ADD COLUMN revoked_at                  DATETIME(6)   NULL AFTER revocation_pending,
  ADD COLUMN revoked_by                  BINARY(16)    NULL AFTER revoked_at,
  ADD COLUMN revoke_reason               VARCHAR(500)  NULL AFTER revoked_by,
  ADD COLUMN released_at                 DATETIME(6)   NULL AFTER revoke_reason,
  -- Reste déclaré par l'appareil à la libération (fait accompli) : un écart avec le reste du serveur
  -- ouvre un conflit, il n'est jamais corrigé en silence (ADR-033 §9).
  ADD COLUMN release_declared_remaining  DECIMAL(14,3) NULL AFTER released_at,
  ADD CONSTRAINT ck_inventory_stock_allocations_type CHECK (allocation_type = 'DEVICE_QUOTA'),
  ADD CONSTRAINT ck_inventory_stock_allocations_close_cause CHECK (
    close_cause IS NULL OR close_cause IN ('RELEASED', 'CONSUMED', 'EXPIRED_RELEASED')
  ),
  ADD CONSTRAINT ck_inventory_stock_allocations_holder CHECK (
    holder_user_id IS NOT NULL AND holder_device_id IS NOT NULL
  ),
  ADD CONSTRAINT ck_inventory_stock_allocations_quantities CHECK (
    quantity_granted > 0 AND quantity_remaining >= 0 AND quantity_remaining <= quantity_granted
  ),
  ADD CONSTRAINT ck_inventory_stock_allocations_state CHECK (
    (status = 'ACTIVE' AND close_cause IS NULL AND released_at IS NULL AND revoked_at IS NULL)
    OR (status = 'CLOSED' AND close_cause IS NOT NULL AND quantity_remaining = 0 AND revoked_at IS NULL
        AND (close_cause = 'CONSUMED' OR released_at IS NOT NULL))
    OR (status = 'REVOKED' AND close_cause IS NULL AND quantity_remaining = 0 AND revoked_at IS NOT NULL
        AND revoked_by IS NOT NULL AND revoke_reason IS NOT NULL)
  ),
  ADD CONSTRAINT ck_inventory_stock_allocations_pending CHECK (revocation_pending = FALSE OR status = 'ACTIVE'),
  ADD CONSTRAINT fk_inventory_stock_allocations_revoked_by FOREIGN KEY (revoked_by) REFERENCES identity_users (id) ON DELETE RESTRICT;

CREATE TRIGGER trg_inventory_stock_allocations_update_guard BEFORE UPDATE ON inventory_stock_allocations FOR EACH ROW
BEGIN
  IF NOT (
    NEW.allocation_type <=> OLD.allocation_type AND
    NEW.location_id <=> OLD.location_id AND
    NEW.product_id <=> OLD.product_id AND
    NEW.lot_id <=> OLD.lot_id AND
    NEW.holder_user_id <=> OLD.holder_user_id AND
    NEW.holder_device_id <=> OLD.holder_device_id AND
    NEW.granted_by <=> OLD.granted_by AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_allocations : identité du quota immuable (détenteur, emplacement, produit).';
  END IF;
  IF NEW.quantity_granted < OLD.quantity_granted THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_allocations : la quantité accordée ne diminue jamais (augmentation par entrée).';
  END IF;
  IF OLD.status <> 'ACTIVE' AND NEW.status <> OLD.status THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_allocations : quota fermé ou révoqué, état terminal (SM-ALLOCATION).';
  END IF;
  IF OLD.status <> 'ACTIVE' AND NOT (
    NEW.quantity_granted <=> OLD.quantity_granted AND
    NEW.quantity_remaining <=> OLD.quantity_remaining AND
    NEW.valid_until <=> OLD.valid_until AND
    NEW.close_cause <=> OLD.close_cause AND
    NEW.revoked_at <=> OLD.revoked_at AND
    NEW.revoked_by <=> OLD.revoked_by AND
    NEW.revoke_reason <=> OLD.revoke_reason AND
    NEW.released_at <=> OLD.released_at AND
    NEW.release_declared_remaining <=> OLD.release_declared_remaining
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'inventory_stock_allocations : quota terminé, ses données ne changent plus.';
  END IF;
END;

-- Registre d'entrées : `TRANSFER` n'existe plus ; `RESTORE` rend à un quota actif la quantité d'une
-- vente annulée ; le signe suit le type ; consommation et restitution citent leur mouvement, une
-- seule fois par mouvement et par type (INV-STK-20).
ALTER TABLE inventory_stock_allocation_entries
  DROP CHECK ck_inventory_stock_allocation_entries_type,
  ADD CONSTRAINT ck_inventory_stock_allocation_entries_type CHECK (
    entry_type IN ('GRANT', 'INCREASE', 'CONSUME', 'RELEASE', 'REVOKE', 'ADJUST', 'RESTORE')
  ),
  ADD CONSTRAINT ck_inventory_stock_allocation_entries_sign CHECK (
    (entry_type IN ('GRANT', 'INCREASE', 'RESTORE') AND quantity > 0)
    OR (entry_type IN ('CONSUME', 'RELEASE', 'REVOKE') AND quantity < 0)
    OR (entry_type = 'ADJUST' AND quantity <> 0)
  ),
  ADD CONSTRAINT ck_inventory_stock_allocation_entries_move CHECK (
    entry_type NOT IN ('CONSUME', 'RESTORE') OR stock_move_id IS NOT NULL
  ),
  ADD UNIQUE KEY uq_inventory_stock_allocation_entries_move_type (stock_move_id, entry_type),
  ADD KEY ix_inventory_stock_allocation_entries_time (allocation_id, occurred_at);

-- migrate:down transaction:false
-- Rétablit le schéma de la création (réservation comprise). Échoue sans effet de bord s'il existe des
-- entrées `RESTORE` ou des quotas révoqués ou fermés qui violeraient les anciennes contraintes.

ALTER TABLE inventory_stock_allocation_entries
  DROP INDEX ix_inventory_stock_allocation_entries_time,
  DROP INDEX uq_inventory_stock_allocation_entries_move_type,
  DROP CHECK ck_inventory_stock_allocation_entries_move,
  DROP CHECK ck_inventory_stock_allocation_entries_sign,
  DROP CHECK ck_inventory_stock_allocation_entries_type,
  ADD CONSTRAINT ck_inventory_stock_allocation_entries_type CHECK (
    entry_type IN ('GRANT', 'INCREASE', 'CONSUME', 'RELEASE', 'REVOKE', 'TRANSFER', 'ADJUST')
  );

DROP TRIGGER trg_inventory_stock_allocations_update_guard;

ALTER TABLE inventory_stock_allocations
  DROP FOREIGN KEY fk_inventory_stock_allocations_revoked_by,
  DROP CHECK ck_inventory_stock_allocations_pending,
  DROP CHECK ck_inventory_stock_allocations_state,
  DROP CHECK ck_inventory_stock_allocations_quantities,
  DROP CHECK ck_inventory_stock_allocations_holder,
  DROP CHECK ck_inventory_stock_allocations_close_cause,
  DROP CHECK ck_inventory_stock_allocations_type,
  DROP COLUMN release_declared_remaining,
  DROP COLUMN released_at,
  DROP COLUMN revoke_reason,
  DROP COLUMN revoked_by,
  DROP COLUMN revoked_at,
  ADD COLUMN sales_order_line_id BINARY(16) NULL AFTER holder_device_id,
  ADD CONSTRAINT ck_inventory_stock_allocations_type CHECK (allocation_type IN ('DEVICE_QUOTA', 'ORDER_RESERVATION')),
  ADD CONSTRAINT ck_inventory_stock_allocations_close_cause CHECK (
    close_cause IS NULL OR close_cause IN ('RELEASED', 'CONSUMED', 'CANCELLED', 'TRANSFERRED', 'EXPIRED_RELEASED')
  ),
  ADD CONSTRAINT ck_inventory_stock_allocations_holder CHECK (
    (allocation_type = 'DEVICE_QUOTA' AND holder_user_id IS NOT NULL AND holder_device_id IS NOT NULL AND sales_order_line_id IS NULL)
    OR (allocation_type = 'ORDER_RESERVATION' AND sales_order_line_id IS NOT NULL AND holder_user_id IS NULL AND holder_device_id IS NULL)
  );
