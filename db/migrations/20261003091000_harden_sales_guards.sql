-- Espace de noms `sales`, durcissement des déclencheurs après relecture adverse de P4-02 (2/2).
--
-- Gardes de mise à jour redéfinies :
-- - commandes : une commande confirmée ne redevient pas brouillon ; clôture et annulation figées une
--   fois la commande terminée ; sort du paiement libéré écrit une seule fois ;
-- - lignes de commande : prix catalogue, motif et validation de dérogation figés ;
-- - annulations : date d'effet (`applied_at`, qui porte le chiffre d'affaires, BR-FIN-042) et
--   validation figées après décision ; sort du paiement libéré écrit une seule fois ; traces
--   d'origine (horloge, hors ligne) figées ;
-- - encaissements : la référence ne se corrige qu'à la décision de la Finance sur un doublon suspect
--   (SUSPECT_DUPLICATE vers RECORDED, AV-135) ; cible visée figée ; montants et annulation figés
--   une fois l'encaissement rejeté ou annulé ; part remboursée jamais décroissante.
-- Gardes d'insertion nouvelles (cohérences que les CHECK ne peuvent pas porter) : « à livrer » du
-- site de la préparation (ventes), affectation d'un encaissement enregistré à une cible non annulée
-- (INV-FIN-09, INV-FIN-10), ligne d'annulation de la vente du document, ligne de bon de livraison
-- concordante avec sa ligne de commande et sa commande.
--
-- migrate:up transaction:false

DROP TRIGGER trg_sales_sales_orders_update_guard;

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
  IF OLD.status <> 'DRAFT' AND NEW.status = 'DRAFT' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales_orders : une commande confirmée ne redevient pas brouillon (SM-ORDER).';
  END IF;
  IF OLD.status IN ('FULFILLED', 'CLOSED', 'CANCELLED') AND NOT (
    NEW.closed_at <=> OLD.closed_at AND
    NEW.closed_by <=> OLD.closed_by AND
    NEW.closed_reason <=> OLD.closed_reason AND
    NEW.cancelled_at <=> OLD.cancelled_at AND
    NEW.cancelled_by <=> OLD.cancelled_by AND
    NEW.cancel_reason_code_id <=> OLD.cancel_reason_code_id AND
    NEW.cancel_comment <=> OLD.cancel_comment AND
    NEW.cancel_approval_request_id <=> OLD.cancel_approval_request_id
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales_orders : clôture et annulation figées une fois la commande terminée.';
  END IF;
  IF OLD.released_payment_treatment IS NOT NULL AND NOT (NEW.released_payment_treatment <=> OLD.released_payment_treatment) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales_orders : le sort du paiement libéré s''écrit une seule fois.';
  END IF;
END;

DROP TRIGGER trg_sales_sales_order_lines_update_guard;

CREATE TRIGGER trg_sales_sales_order_lines_update_guard BEFORE UPDATE ON sales_sales_order_lines FOR EACH ROW
BEGIN
  IF NOT (
    NEW.order_id <=> OLD.order_id AND
    NEW.line_no <=> OLD.line_no AND
    NEW.product_id <=> OLD.product_id AND
    NEW.product_name_snapshot <=> OLD.product_name_snapshot AND
    NEW.unit_code <=> OLD.unit_code AND
    NEW.quoted_unit_price_xaf <=> OLD.quoted_unit_price_xaf AND
    NEW.list_unit_price_xaf <=> OLD.list_unit_price_xaf AND
    NEW.price_rule_id <=> OLD.price_rule_id AND
    NEW.price_rule_version <=> OLD.price_rule_version AND
    NEW.price_source <=> OLD.price_source AND
    NEW.override_reason_code_id <=> OLD.override_reason_code_id AND
    NEW.override_approval_request_id <=> OLD.override_approval_request_id AND
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

DROP TRIGGER trg_sales_sale_cancellations_update_guard;

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
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sale_cancellations : document d''annulation immuable ; seuls statut et sort des paiements évoluent.';
  END IF;
  -- La date d'effet porte la diminution du chiffre d'affaires (BR-FIN-042) : elle ne se réécrit pas.
  IF OLD.status <> 'REQUESTED' AND (
    NEW.status <> OLD.status OR NOT (NEW.applied_at <=> OLD.applied_at)
    OR NOT (NEW.approval_request_id <=> OLD.approval_request_id)
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sale_cancellations : une annulation appliquée ou rejetée ne change plus de statut ni de date d''effet.';
  END IF;
  IF OLD.released_payment_treatment IS NOT NULL AND NOT (NEW.released_payment_treatment <=> OLD.released_payment_treatment) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sale_cancellations : le sort du paiement libéré s''écrit une seule fois.';
  END IF;
END;

DROP TRIGGER trg_sales_customer_payments_update_guard;

CREATE TRIGGER trg_sales_customer_payments_update_guard BEFORE UPDATE ON sales_customer_payments FOR EACH ROW
BEGIN
  IF NOT (
    NEW.doc_number <=> OLD.doc_number AND
    NEW.local_ref <=> OLD.local_ref AND
    NEW.site_id <=> OLD.site_id AND
    NEW.customer_id <=> OLD.customer_id AND
    NEW.payment_method_code <=> OLD.payment_method_code AND
    NEW.amount_xaf <=> OLD.amount_xaf AND
    NEW.received_by_user_id <=> OLD.received_by_user_id AND
    NEW.cash_account_id <=> OLD.cash_account_id AND
    NEW.duplicate_of_payment_id <=> OLD.duplicate_of_payment_id AND
    NEW.intended_sale_id <=> OLD.intended_sale_id AND
    NEW.intended_order_id <=> OLD.intended_order_id AND
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
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_customer_payments : encaissement immuable ; seuls statut, part non affectée et annulation évoluent.';
  END IF;
  -- La référence ne se corrige qu'à la décision de la Finance sur un doublon suspect (AV-135).
  IF NOT (NEW.external_reference <=> OLD.external_reference AND NEW.reference_normalized <=> OLD.reference_normalized)
     AND NOT (OLD.status = 'SUSPECT_DUPLICATE' AND NEW.status = 'RECORDED') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_customer_payments : référence figée, corrigeable seulement à la décision sur un doublon suspect.';
  END IF;
  IF OLD.status IN ('REJECTED', 'CANCELLED') AND NEW.status <> OLD.status THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_customer_payments : encaissement rejeté ou annulé, son statut ne change plus.';
  END IF;
  IF OLD.status IN ('REJECTED', 'CANCELLED') AND NOT (
    NEW.unallocated_xaf <=> OLD.unallocated_xaf AND
    NEW.refunded_xaf <=> OLD.refunded_xaf AND
    NEW.cancelled_at <=> OLD.cancelled_at AND
    NEW.cancelled_by <=> OLD.cancelled_by AND
    NEW.cancel_reason_code_id <=> OLD.cancel_reason_code_id AND
    NEW.cancel_comment <=> OLD.cancel_comment AND
    NEW.cancel_approval_request_id <=> OLD.cancel_approval_request_id
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_customer_payments : encaissement terminé, ses montants et son annulation sont figés.';
  END IF;
  IF NEW.refunded_xaf < OLD.refunded_xaf THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_customer_payments : la part remboursée ne diminue jamais.';
  END IF;
  IF OLD.cash_movement_id IS NOT NULL AND NOT (NEW.cash_movement_id <=> OLD.cash_movement_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_customer_payments : le mouvement de trésorerie ne change plus (INV-FIN-01).';
  END IF;
END;

CREATE TRIGGER trg_sales_sales_insert_guard BEFORE INSERT ON sales_sales FOR EACH ROW
BEGIN
  DECLARE td_type VARCHAR(20);
  DECLARE td_site BINARY(16);
  DECLARE from_site BINARY(16);
  -- ADR-028 §1 : l'emplacement « à livrer » d'une vente sur commande est celui du site de la préparation.
  IF NEW.to_deliver_location_id IS NOT NULL THEN
    SELECT location_type, site_id INTO td_type, td_site FROM organization_locations WHERE id = NEW.to_deliver_location_id;
    SELECT site_id INTO from_site FROM organization_locations WHERE id = NEW.from_location_id;
    IF td_type IS NULL OR td_type <> 'V_TO_DELIVER' OR from_site IS NULL OR td_site <> from_site THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sales : « à livrer » doit être celui du site de l''emplacement de préparation (ADR-028 §1).';
    END IF;
  END IF;
END;

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
    -- Sans cible (ou avec deux), le CHECK ck_sales_payment_allocations_target tranche.
    IF (NEW.sale_id IS NOT NULL OR NEW.order_id IS NOT NULL) AND (t_status IS NULL OR t_status = 'CANCELLED') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_payment_allocations : pas d''affectation à une vente ou une commande annulée (INV-FIN-10).';
    END IF;
  END IF;
END;

CREATE TRIGGER trg_sales_sale_cancellation_lines_insert_guard BEFORE INSERT ON sales_sale_cancellation_lines FOR EACH ROW
BEGIN
  DECLARE line_sale BINARY(16);
  DECLARE doc_sale BINARY(16);
  SELECT sale_id INTO line_sale FROM sales_sale_lines WHERE id = NEW.sale_line_id;
  SELECT sale_id INTO doc_sale FROM sales_sale_cancellations WHERE id = NEW.cancellation_id;
  IF line_sale IS NULL OR doc_sale IS NULL OR line_sale <> doc_sale THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_sale_cancellation_lines : la ligne annulée doit appartenir à la vente du document.';
  END IF;
END;

CREATE TRIGGER trg_sales_delivery_note_lines_insert_guard BEFORE INSERT ON sales_delivery_note_lines FOR EACH ROW
BEGIN
  DECLARE sl_order_line BINARY(16);
  DECLARE ol_order BINARY(16);
  DECLARE note_order BINARY(16);
  SELECT order_line_id INTO sl_order_line FROM sales_sale_lines WHERE id = NEW.sale_line_id;
  SELECT order_id INTO ol_order FROM sales_sales_order_lines WHERE id = NEW.order_line_id;
  SELECT order_id INTO note_order FROM sales_delivery_notes WHERE id = NEW.delivery_note_id;
  IF sl_order_line IS NULL OR sl_order_line <> NEW.order_line_id OR ol_order IS NULL OR note_order IS NULL
     OR ol_order <> note_order THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_delivery_note_lines : ligne de vente, ligne de commande et commande du bon doivent concorder.';
  END IF;
END;

-- migrate:down transaction:false
-- Restaure les versions précédentes des gardes de mise à jour et supprime les gardes d'insertion.

DROP TRIGGER trg_sales_delivery_note_lines_insert_guard;
DROP TRIGGER trg_sales_sale_cancellation_lines_insert_guard;
DROP TRIGGER trg_sales_payment_allocations_insert_guard;
DROP TRIGGER trg_sales_sales_insert_guard;

DROP TRIGGER trg_sales_sales_orders_update_guard;

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

DROP TRIGGER trg_sales_sales_order_lines_update_guard;

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

DROP TRIGGER trg_sales_sale_cancellations_update_guard;

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

DROP TRIGGER trg_sales_customer_payments_update_guard;

CREATE TRIGGER trg_sales_customer_payments_update_guard BEFORE UPDATE ON sales_customer_payments FOR EACH ROW
BEGIN
  IF NOT (
    NEW.doc_number <=> OLD.doc_number AND
    NEW.local_ref <=> OLD.local_ref AND
    NEW.site_id <=> OLD.site_id AND
    NEW.customer_id <=> OLD.customer_id AND
    NEW.payment_method_code <=> OLD.payment_method_code AND
    NEW.amount_xaf <=> OLD.amount_xaf AND
    NEW.external_reference <=> OLD.external_reference AND
    NEW.reference_normalized <=> OLD.reference_normalized AND
    NEW.received_by_user_id <=> OLD.received_by_user_id AND
    NEW.cash_account_id <=> OLD.cash_account_id AND
    NEW.duplicate_of_payment_id <=> OLD.duplicate_of_payment_id AND
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
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_customer_payments : encaissement immuable ; seuls statut, part non affectée et annulation évoluent.';
  END IF;
  IF OLD.status IN ('REJECTED', 'CANCELLED') AND NEW.status <> OLD.status THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_customer_payments : encaissement rejeté ou annulé, son statut ne change plus.';
  END IF;
  IF OLD.cash_movement_id IS NOT NULL AND NOT (NEW.cash_movement_id <=> OLD.cash_movement_id) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sales_customer_payments : le mouvement de trésorerie ne change plus (INV-FIN-01).';
  END IF;
END;

