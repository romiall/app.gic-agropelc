-- Espace de noms `sales`, affectations d'encaissement (P4-08, revue adverse) : un encaissement dont
-- l'annulation est demandée (`CANCELLATION_REQUESTED`, rendu atteignable par
-- `sales.payment.request_cancellation`) reste un encaissement réel tant que la Finance n'a pas
-- décidé : ses affectations peuvent encore être recréées par la confirmation d'une commande (acompte
-- transféré à la vente, ADR-028 §8) ou par l'annulation partielle d'une vente (part conservée). La
-- garde n'accepte plus seulement `RECORDED` ; la décision d'annulation relit et renverse toutes les
-- affectations actives sous verrou. INV-FIN-09 (aucune affectation pour `SUSPECT_DUPLICATE` ou
-- `REJECTED`) et INV-FIN-10 sont inchangés.
--
-- migrate:up transaction:false

DROP TRIGGER trg_sales_payment_allocations_insert_guard;

CREATE TRIGGER trg_sales_payment_allocations_insert_guard BEFORE INSERT ON sales_payment_allocations FOR EACH ROW
BEGIN
  DECLARE p_status VARCHAR(25);
  DECLARE t_status VARCHAR(25);
  -- INV-FIN-09, INV-FIN-10 : on n'affecte qu'un encaissement enregistré (ou dont l'annulation est
  -- seulement demandée), à une cible non annulée.
  IF NEW.status = 'ACTIVE' THEN
    SELECT status INTO p_status FROM sales_customer_payments WHERE id = NEW.payment_id;
    IF p_status IS NULL OR p_status NOT IN ('RECORDED', 'CANCELLATION_REQUESTED') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_payment_allocations : seul un encaissement enregistré (RECORDED, ou annulation demandée) s''affecte (INV-FIN-09).';
    END IF;
    IF NEW.sale_id IS NOT NULL THEN
      SELECT status INTO t_status FROM sales_sales WHERE id = NEW.sale_id;
    ELSEIF NEW.order_id IS NOT NULL THEN
      SELECT status INTO t_status FROM sales_sales_orders WHERE id = NEW.order_id;
    END IF;
    -- Sans cible (ou avec deux), le CHECK ck_sales_payment_allocations_target tranche.
    IF (NEW.sale_id IS NOT NULL OR NEW.order_id IS NOT NULL) AND (t_status IS NULL OR t_status = 'CANCELLED') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_payment_allocations : pas d''affectation à une vente ou une commande annulée (INV-FIN-10).';
    END IF;
  END IF;
END;

-- migrate:down transaction:false

DROP TRIGGER trg_sales_payment_allocations_insert_guard;

CREATE TRIGGER trg_sales_payment_allocations_insert_guard BEFORE INSERT ON sales_payment_allocations FOR EACH ROW
BEGIN
  DECLARE p_status VARCHAR(25);
  DECLARE t_status VARCHAR(25);
  -- INV-FIN-09, INV-FIN-10 : on n'affecte qu'un encaissement enregistré, à une cible non annulée.
  IF NEW.status = 'ACTIVE' THEN
    SELECT status INTO p_status FROM sales_customer_payments WHERE id = NEW.payment_id;
    IF p_status IS NULL OR p_status <> 'RECORDED' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_payment_allocations : seul un encaissement enregistré (RECORDED) s''affecte (INV-FIN-09).';
    END IF;
    IF NEW.sale_id IS NOT NULL THEN
      SELECT status INTO t_status FROM sales_sales WHERE id = NEW.sale_id;
    ELSEIF NEW.order_id IS NOT NULL THEN
      SELECT status INTO t_status FROM sales_sales_orders WHERE id = NEW.order_id;
    END IF;
    IF (NEW.sale_id IS NOT NULL OR NEW.order_id IS NOT NULL) AND (t_status IS NULL OR t_status = 'CANCELLED') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_payment_allocations : pas d''affectation à une vente ou une commande annulée (INV-FIN-10).';
    END IF;
  END IF;
END;
