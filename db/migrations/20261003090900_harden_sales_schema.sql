-- Espace de noms `sales`, durcissement après relecture adverse de P4-02 (2/2). Colonnes,
-- contraintes et index ; les déclencheurs sont dans la migration suivante.
--
-- - `ck_sales_sales_anonymous` est SUPPRIMÉ : INV-VEN-07 (vente sans client payée intégralement) se
--   vérifie à l'enregistrement en ligne (TX) ; une vente anonyme saisie hors ligne est un fait
--   accompli qui n'est jamais rejeté (BR-SYN-007, INV-SYN-06) — un doublon d'encaissement ou une
--   annulation de paiement laisserait sinon un reste dû sur une vente sans client. Le reste dû d'une
--   vente anonyme est signalé par un drapeau (`flags`) et un conflit pour la Finance (AV-135).
-- - une vente sur commande exige un client (BR-VEN-001, AV-027) ; une annulation pour une cause de
--   commande porte la commande.
-- - lignes de commande : prix catalogue, motif et validation d'une dérogation (BR-VEN-015, AV-026),
--   recopiés sur la ligne de vente à chaque confirmation (AV-127).
-- - encaissements : cible visée d'un doublon suspect (affectée à la décision de la Finance),
--   part remboursée, unicité du mouvement de trésorerie (relation 1 pour 1, INV-FIN-09),
--   référence normalisée contrôlée, crédit client réservé aux encaissements enregistrés d'un client.
-- - commandes : sort du paiement libéré (crédit ou remboursement) pour une commande annulée ou
--   clôturée sans vente ; un brouillon peut être annulé.
-- - annulations : `UNIQUE (command_id, sale_id)` (un document par vente et par commande de
--   synchronisation), jour métier de l'effet (`applied_business_date`, CA par jour).
--
-- migrate:up transaction:false

ALTER TABLE sales_sales
  DROP CHECK ck_sales_sales_anonymous,
  ADD CONSTRAINT ck_sales_sales_order_customer CHECK (sale_type <> 'ORDER' OR customer_id IS NOT NULL),
  ADD KEY ix_sales_sales_cash_session (cash_session_id);

ALTER TABLE sales_sale_lines
  ADD CONSTRAINT ck_sales_sale_lines_rule CHECK (
    price_source <> 'RULE'
    OR (price_rule_id IS NOT NULL AND price_rule_version IS NOT NULL AND list_unit_price_xaf IS NOT NULL)
  ),
  ADD CONSTRAINT ck_sales_sale_lines_quote CHECK (price_source <> 'ORDER_QUOTE' OR order_line_id IS NOT NULL),
  ADD CONSTRAINT ck_sales_sale_lines_cancelled_amount CHECK (cancelled_quantity_base > 0 OR cancelled_xaf = 0);

ALTER TABLE sales_sales_orders
  DROP CHECK ck_sales_sales_orders_confirmed,
  ADD CONSTRAINT ck_sales_sales_orders_confirmed CHECK (status IN ('DRAFT', 'CANCELLED') OR confirmed_at IS NOT NULL),
  ADD COLUMN released_payment_treatment VARCHAR(20) NULL AFTER closed_reason,
  ADD CONSTRAINT ck_sales_sales_orders_treatment CHECK (
    released_payment_treatment IS NULL OR released_payment_treatment IN ('CUSTOMER_CREDIT', 'REFUND')
  );

ALTER TABLE sales_sales_order_lines
  ADD COLUMN list_unit_price_xaf BIGINT NULL AFTER quoted_unit_price_xaf,
  ADD COLUMN override_reason_code_id BINARY(16) NULL AFTER price_source,
  ADD COLUMN override_approval_request_id BINARY(16) NULL AFTER override_reason_code_id,
  ADD CONSTRAINT ck_sales_sales_order_lines_list_price CHECK (list_unit_price_xaf IS NULL OR list_unit_price_xaf >= 0),
  ADD CONSTRAINT ck_sales_sales_order_lines_override CHECK (
    price_source <> 'MANUAL_OVERRIDE' OR override_reason_code_id IS NOT NULL
  ),
  ADD CONSTRAINT fk_sales_sales_order_lines_override_reason FOREIGN KEY (override_reason_code_id) REFERENCES catalog_reason_codes (id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_sales_sales_order_lines_override_approval FOREIGN KEY (override_approval_request_id) REFERENCES approvals_approval_requests (id) ON DELETE RESTRICT;

ALTER TABLE sales_sale_cancellations
  ADD COLUMN applied_business_date DATE GENERATED ALWAYS AS (CAST(CONVERT_TZ(applied_at, '+00:00', '+01:00') AS DATE)) STORED AFTER applied_at,
  DROP KEY ix_sales_sale_cancellations_command,
  ADD UNIQUE KEY uq_sales_sale_cancellations_command_sale (command_id, sale_id),
  ADD KEY ix_sales_sale_cancellations_applied_date (site_id, applied_business_date),
  ADD CONSTRAINT ck_sales_sale_cancellations_order_cause CHECK (cause = 'SALE_CANCELLATION' OR order_id IS NOT NULL);

ALTER TABLE sales_customer_payments
  ADD COLUMN refunded_xaf BIGINT NOT NULL DEFAULT 0 AFTER unallocated_xaf,
  ADD COLUMN intended_sale_id BINARY(16) NULL AFTER duplicate_of_payment_id,
  ADD COLUMN intended_order_id BINARY(16) NULL AFTER intended_sale_id,
  DROP KEY ix_sales_customer_payments_movement,
  ADD UNIQUE KEY uq_sales_customer_payments_movement (cash_movement_id),
  DROP CHECK ck_sales_customer_payments_unallocated,
  ADD CONSTRAINT ck_sales_customer_payments_unallocated CHECK (
    unallocated_xaf >= 0 AND refunded_xaf >= 0 AND unallocated_xaf + refunded_xaf <= amount_xaf
  ),
  -- Crédit client : seulement sur un encaissement enregistré d'un client identifié (INV-FIN-09).
  ADD CONSTRAINT ck_sales_customer_payments_credit CHECK (
    unallocated_xaf = 0
    OR (status IN ('RECORDED', 'CANCELLATION_REQUESTED') AND customer_id IS NOT NULL)
  ),
  ADD CONSTRAINT ck_sales_customer_payments_intended CHECK (intended_sale_id IS NULL OR intended_order_id IS NULL),
  -- Le motif et la validation d'une demande d'annulation sont consignés dès CANCELLATION_REQUESTED ;
  -- l'auteur et l'heure d'annulation seulement à CANCELLED.
  DROP CHECK ck_sales_customer_payments_cancel,
  ADD CONSTRAINT ck_sales_customer_payments_cancel CHECK (
    (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)
    OR (status <> 'CANCELLED' AND cancelled_at IS NULL AND cancelled_by IS NULL)
  ),
  ADD CONSTRAINT ck_sales_customer_payments_cancel_request CHECK (
    status IN ('CANCELLATION_REQUESTED', 'CANCELLED')
    OR (cancel_reason_code_id IS NULL AND cancel_comment IS NULL AND cancel_approval_request_id IS NULL)
  ),
  -- INV-FIN-03 : la base ne dérive pas la normalisation (elle reste dans packages/domain) mais
  -- refuse une référence non normalisée ou une référence saisie sans forme normalisée.
  ADD CONSTRAINT ck_sales_customer_payments_reference CHECK (
    reference_normalized IS NULL
    OR (reference_normalized = UPPER(reference_normalized) AND reference_normalized NOT REGEXP '[[:space:]]')
  ),
  ADD CONSTRAINT ck_sales_customer_payments_reference_pair CHECK (
    external_reference IS NULL OR reference_normalized IS NOT NULL
  ),
  ADD CONSTRAINT fk_sales_customer_payments_intended_sale FOREIGN KEY (intended_sale_id) REFERENCES sales_sales (id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_sales_customer_payments_intended_order FOREIGN KEY (intended_order_id) REFERENCES sales_sales_orders (id) ON DELETE RESTRICT;

ALTER TABLE sales_payment_allocations
  DROP CHECK ck_sales_payment_allocations_cause,
  ADD CONSTRAINT ck_sales_payment_allocations_cause CHECK (
    reversal_cause IS NULL
    OR reversal_cause IN (
      'PAYMENT_CANCELLED', 'SALE_CANCELLED', 'REALLOCATED', 'ORDER_CONFIRMED', 'ORDER_CANCELLED', 'ORDER_CLOSED'
    )
  );

-- migrate:down transaction:false
-- Un ALTER par table, atomique ; échoue sans effet de bord s'il existe des lignes qui violent les
-- anciennes contraintes.

ALTER TABLE sales_payment_allocations
  DROP CHECK ck_sales_payment_allocations_cause,
  ADD CONSTRAINT ck_sales_payment_allocations_cause CHECK (
    reversal_cause IS NULL
    OR reversal_cause IN ('PAYMENT_CANCELLED', 'SALE_CANCELLED', 'REALLOCATED', 'ORDER_CONFIRMED')
  );

ALTER TABLE sales_customer_payments
  DROP FOREIGN KEY fk_sales_customer_payments_intended_order,
  DROP FOREIGN KEY fk_sales_customer_payments_intended_sale,
  DROP CHECK ck_sales_customer_payments_reference_pair,
  DROP CHECK ck_sales_customer_payments_reference,
  DROP CHECK ck_sales_customer_payments_cancel_request,
  DROP CHECK ck_sales_customer_payments_cancel,
  ADD CONSTRAINT ck_sales_customer_payments_cancel CHECK (
    (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL)
    OR (status <> 'CANCELLED' AND cancelled_at IS NULL AND cancelled_by IS NULL
        AND cancel_reason_code_id IS NULL AND cancel_comment IS NULL AND cancel_approval_request_id IS NULL)
  ),
  DROP CHECK ck_sales_customer_payments_intended,
  DROP CHECK ck_sales_customer_payments_credit,
  DROP CHECK ck_sales_customer_payments_unallocated,
  ADD CONSTRAINT ck_sales_customer_payments_unallocated CHECK (unallocated_xaf >= 0 AND unallocated_xaf <= amount_xaf),
  DROP KEY uq_sales_customer_payments_movement,
  ADD KEY ix_sales_customer_payments_movement (cash_movement_id),
  DROP COLUMN intended_order_id,
  DROP COLUMN intended_sale_id,
  DROP COLUMN refunded_xaf;

ALTER TABLE sales_sale_cancellations
  ADD KEY fk_sales_sale_cancellations_site (site_id),
  DROP CHECK ck_sales_sale_cancellations_order_cause,
  DROP KEY ix_sales_sale_cancellations_applied_date,
  DROP KEY uq_sales_sale_cancellations_command_sale,
  ADD KEY ix_sales_sale_cancellations_command (command_id),
  DROP COLUMN applied_business_date;

ALTER TABLE sales_sales_order_lines
  DROP FOREIGN KEY fk_sales_sales_order_lines_override_approval,
  DROP FOREIGN KEY fk_sales_sales_order_lines_override_reason,
  DROP CHECK ck_sales_sales_order_lines_override,
  DROP CHECK ck_sales_sales_order_lines_list_price,
  DROP COLUMN override_approval_request_id,
  DROP COLUMN override_reason_code_id,
  DROP COLUMN list_unit_price_xaf;

ALTER TABLE sales_sales_orders
  DROP CHECK ck_sales_sales_orders_treatment,
  DROP COLUMN released_payment_treatment,
  DROP CHECK ck_sales_sales_orders_confirmed,
  ADD CONSTRAINT ck_sales_sales_orders_confirmed CHECK (status = 'DRAFT' OR confirmed_at IS NOT NULL);

ALTER TABLE sales_sale_lines
  DROP CHECK ck_sales_sale_lines_cancelled_amount,
  DROP CHECK ck_sales_sale_lines_quote,
  DROP CHECK ck_sales_sale_lines_rule;

ALTER TABLE sales_sales
  DROP KEY ix_sales_sales_cash_session,
  DROP CHECK ck_sales_sales_order_customer,
  ADD CONSTRAINT ck_sales_sales_anonymous CHECK (customer_id IS NOT NULL OR total_xaf - cancelled_xaf - amount_paid_xaf = 0);
