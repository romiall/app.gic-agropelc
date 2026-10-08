-- Module `finance`, sessions de caisse, ajustements de session et remises de fonds (P5-03).
-- Source : docs/03-data/dictionnaire/09-finance.md ; D05 BR-DIS-005 à 009 ; D09 BR-FIN-013, 014 ;
-- SM-CASH-SESSION, SM-CASH-TRANSFER ; INV-FIN-05, INV-FIN-06 ; ADR-032 ; AV-153 à AV-159, AV-165.
--
-- Principes d'ADR-032 portés par le schéma :
-- - la session d'un mouvement est celle dont la **fenêtre** couvre son `occurred_at` : `cash_session_id`
--   du registre n'est qu'un index dénormalisé (FK ajoutée ici) ; le non-chevauchement des fenêtres est
--   assuré par le code, les déclencheurs ne sont qu'un filet (une exception SQL sur un fait accompli
--   hors ligne serait rejouée sans fin) ;
-- - une session `VALIDATED` est figée (INV-FIN-05) ; une opération tardive crée un ajustement et un
--   mouvement compensatoire `SESSION_VARIANCE` du delta, jamais une réécriture ;
-- - une remise de fonds n'a aucun second mouvement d'écart : l'écart, son imputation et son motif sont
--   des données de la remise.
-- Aucune clé étrangère de la session vers le registre (le mouvement d'écart cite la session, pas
-- l'inverse : évite une dépendance circulaire à l'insertion).
--
-- migrate:up transaction:false

CREATE TABLE finance_cash_sessions (
  id                      BINARY(16)     NOT NULL,
  cash_account_id         BINARY(16)     NOT NULL,
  -- Site de la caisse (copié à l'ouverture) : lectures par PDV et par jour sans jointure.
  site_id                 BINARY(16)     NOT NULL,
  opened_by               BINARY(16)     NOT NULL,
  opened_device_id        BINARY(16)     NULL,
  opened_at               DATETIME(6)    NOT NULL,
  business_date           DATE           GENERATED ALWAYS AS (CAST(CONVERT_TZ(opened_at, '+00:00', '+01:00') AS DATE)) STORED,
  opening_counted_xaf     BIGINT         NOT NULL,
  -- Solde du compte à l'ouverture, tiré du registre ordonné par `occurred_at` (ADR-032 §4) ; signé.
  opening_expected_xaf    BIGINT         NOT NULL,
  -- Écart d'ouverture = compté − attendu ; appartient à la période précédente, exclu de l'attendu.
  opening_variance_xaf    BIGINT         NOT NULL,
  closed_by               BINARY(16)     NULL,
  closed_device_id        BINARY(16)     NULL,
  closed_at               DATETIME(6)    NULL,
  closing_counted_xaf     BIGINT         NULL,
  -- Attendu à la clôture (ADR-032 §3) ; signé. Valeur de clôture : une réévaluation ne la réécrit pas.
  closing_expected_xaf    BIGINT         NULL,
  variance_xaf            BIGINT         NULL,
  status                  VARCHAR(20)    NOT NULL DEFAULT 'OPEN',
  force_closed            BOOLEAN        NOT NULL DEFAULT FALSE,
  forced_by               BINARY(16)     NULL,
  -- Écart nul ou dans la tolérance paramétrée : validé d'office, sans valideur (AV-057).
  auto_validated          BOOLEAN        NOT NULL DEFAULT FALSE,
  validated_by            BINARY(16)     NULL,
  validated_at            DATETIME(6)    NULL,
  variance_reason         VARCHAR(500)   NULL,
  approval_request_id     BINARY(16)     NULL,
  -- INV-FIN-06 : au plus une session ouverte par compte (colonne générée + index unique, conventions §4).
  open_account            BINARY(16)     GENERATED ALWAYS AS (IF(status = 'OPEN', cash_account_id, NULL)) STORED,
  -- Origine de l'ouverture ; la clôture porte sa propre commande.
  command_id              BINARY(16)     NULL,
  client_created_at       DATETIME(6)    NULL,
  received_at_server      DATETIME(6)    NULL,
  captured_offline        BOOLEAN        NOT NULL DEFAULT FALSE,
  clock_suspect           BOOLEAN        NOT NULL DEFAULT FALSE,
  backdated_reason        TEXT           NULL,
  close_command_id        BINARY(16)     NULL,
  close_captured_offline  BOOLEAN        NOT NULL DEFAULT FALSE,
  created_at              DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by              BINARY(16)     NOT NULL,
  updated_at              DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by              BINARY(16)     NULL,
  version                 INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_finance_cash_sessions_open_account (open_account),
  UNIQUE KEY uq_finance_cash_sessions_command (command_id),
  UNIQUE KEY uq_finance_cash_sessions_close_command (close_command_id),
  KEY ix_finance_cash_sessions_account (cash_account_id, opened_at),
  KEY ix_finance_cash_sessions_site_day (site_id, business_date),
  KEY ix_finance_cash_sessions_status (status, opened_at),
  CONSTRAINT ck_finance_cash_sessions_status CHECK (status IN ('OPEN', 'PENDING_VALIDATION', 'VALIDATED')),
  CONSTRAINT ck_finance_cash_sessions_opening CHECK (
    opening_counted_xaf >= 0 AND opening_variance_xaf = opening_counted_xaf - opening_expected_xaf
  ),
  -- Une session ouverte n'a aucune donnée de clôture ; une session close les a toutes, et l'écart de
  -- clôture est exactement compté − attendu.
  CONSTRAINT ck_finance_cash_sessions_closing CHECK (
    (status = 'OPEN' AND closed_at IS NULL AND closed_by IS NULL AND closing_counted_xaf IS NULL
       AND closing_expected_xaf IS NULL AND variance_xaf IS NULL)
    OR
    (status <> 'OPEN' AND closed_at IS NOT NULL AND closed_by IS NOT NULL AND closing_counted_xaf IS NOT NULL
       AND closing_expected_xaf IS NOT NULL AND variance_xaf IS NOT NULL
       AND closing_counted_xaf >= 0 AND closed_at >= opened_at
       AND variance_xaf = closing_counted_xaf - closing_expected_xaf)
  ),
  CONSTRAINT ck_finance_cash_sessions_validation CHECK (
    (status <> 'VALIDATED')
    OR (validated_at IS NOT NULL AND (validated_by IS NOT NULL OR auto_validated = TRUE))
  ),
  CONSTRAINT ck_finance_cash_sessions_forced CHECK (force_closed = FALSE OR (forced_by IS NOT NULL AND status <> 'OPEN')),
  CONSTRAINT fk_finance_cash_sessions_account FOREIGN KEY (cash_account_id) REFERENCES finance_cash_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_sessions_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_sessions_opened_by FOREIGN KEY (opened_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_sessions_opened_device FOREIGN KEY (opened_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_sessions_closed_by FOREIGN KEY (closed_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_sessions_closed_device FOREIGN KEY (closed_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_sessions_forced_by FOREIGN KEY (forced_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_sessions_validated_by FOREIGN KEY (validated_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_sessions_approval FOREIGN KEY (approval_request_id) REFERENCES approvals_approval_requests (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_sessions_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_sessions_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Filet de non-chevauchement des fenêtres d'un compte (le code assure l'invariant, ADR-032 §2).
CREATE TRIGGER trg_finance_cash_sessions_insert_guard BEFORE INSERT ON finance_cash_sessions FOR EACH ROW
BEGIN
  IF EXISTS (
    SELECT 1 FROM finance_cash_sessions s
    WHERE s.cash_account_id = NEW.cash_account_id
      AND s.opened_at < COALESCE(NEW.closed_at, '9999-12-31 23:59:59.999999')
      AND NEW.opened_at < COALESCE(s.closed_at, '9999-12-31 23:59:59.999999')
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_cash_sessions : les fenêtres de session d''un même compte ne se chevauchent pas (ADR-032 §2).';
  END IF;
END;

CREATE TRIGGER trg_finance_cash_sessions_update_guard BEFORE UPDATE ON finance_cash_sessions FOR EACH ROW
BEGIN
  IF NOT (
    NEW.cash_account_id <=> OLD.cash_account_id AND
    NEW.site_id <=> OLD.site_id AND
    NEW.opened_by <=> OLD.opened_by AND
    NEW.opened_device_id <=> OLD.opened_device_id AND
    NEW.opened_at <=> OLD.opened_at AND
    NEW.opening_counted_xaf <=> OLD.opening_counted_xaf AND
    NEW.opening_expected_xaf <=> OLD.opening_expected_xaf AND
    NEW.opening_variance_xaf <=> OLD.opening_variance_xaf AND
    NEW.command_id <=> OLD.command_id AND
    NEW.client_created_at <=> OLD.client_created_at AND
    NEW.received_at_server <=> OLD.received_at_server AND
    NEW.captured_offline <=> OLD.captured_offline AND
    NEW.clock_suspect <=> OLD.clock_suspect AND
    NEW.backdated_reason <=> OLD.backdated_reason AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_cash_sessions : identité et ouverture de la session immuables.';
  END IF;
  -- Une session close ne se rouvre pas ; une session figée (INV-FIN-05) ne change plus.
  IF OLD.status <> 'OPEN' AND NEW.status = 'OPEN' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_cash_sessions : une session close ne se rouvre pas.';
  END IF;
  IF OLD.status = 'VALIDATED' AND NEW.status <> 'VALIDATED' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_cash_sessions : session VALIDATED figée (INV-FIN-05).';
  END IF;
  IF OLD.status <> 'OPEN' AND NOT (
    NEW.closed_by <=> OLD.closed_by AND
    NEW.closed_device_id <=> OLD.closed_device_id AND
    NEW.closed_at <=> OLD.closed_at AND
    NEW.closing_counted_xaf <=> OLD.closing_counted_xaf AND
    NEW.closing_expected_xaf <=> OLD.closing_expected_xaf AND
    NEW.variance_xaf <=> OLD.variance_xaf AND
    NEW.force_closed <=> OLD.force_closed AND
    NEW.forced_by <=> OLD.forced_by AND
    NEW.close_command_id <=> OLD.close_command_id AND
    NEW.close_captured_offline <=> OLD.close_captured_offline
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_cash_sessions : la clôture est figée ; une réévaluation passe par un ajustement (ADR-032 §6).';
  END IF;
  IF OLD.status = 'VALIDATED' AND NOT (
    NEW.auto_validated <=> OLD.auto_validated AND
    NEW.validated_by <=> OLD.validated_by AND
    NEW.validated_at <=> OLD.validated_at AND
    NEW.variance_reason <=> OLD.variance_reason AND
    NEW.approval_request_id <=> OLD.approval_request_id
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_cash_sessions : session VALIDATED figée (INV-FIN-05).';
  END IF;
  -- Filet de non-chevauchement à la clôture (la fin de fenêtre ne doit pas mordre sur la session suivante).
  IF NEW.closed_at IS NOT NULL AND NOT (NEW.closed_at <=> OLD.closed_at) THEN
    IF EXISTS (
      SELECT 1 FROM finance_cash_sessions s
      WHERE s.cash_account_id = NEW.cash_account_id
        AND s.id <> NEW.id
        AND s.opened_at < NEW.closed_at
        AND NEW.opened_at < COALESCE(s.closed_at, '9999-12-31 23:59:59.999999')
    ) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_cash_sessions : la clôture chevaucherait la session suivante du compte (ADR-032 §2).';
    END IF;
  END IF;
END;

CREATE TRIGGER trg_finance_cash_sessions_no_delete BEFORE DELETE ON finance_cash_sessions FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_cash_sessions : suppression interdite ; corriger par ajustement (ADR-006).';
END;

-- Ajustement d'une session close (ADR-032 §6) : une ligne par réévaluation, rattachée au mouvement
-- compensatoire `SESSION_VARIANCE` du delta (nouvel écart − Σ des écarts déjà posés).
CREATE TABLE finance_cash_session_adjustments (
  id                      BINARY(16)     NOT NULL,
  session_id              BINARY(16)     NOT NULL,
  -- Mouvement compensatoire écrit dans la même transaction (le registre cite la session, pas l'inverse).
  movement_id             BINARY(16)     NOT NULL,
  -- Mouvement tardif qui a déclenché la réévaluation.
  trigger_movement_id     BINARY(16)     NULL,
  cause                   VARCHAR(20)    NOT NULL,
  -- Σ des écarts de clôture et d'ajustement posés avant, et écart courant après (INV-FIN-11).
  variance_before_xaf     BIGINT         NOT NULL,
  variance_after_xaf      BIGINT         NOT NULL,
  delta_xaf               BIGINT         NOT NULL,
  expected_after_xaf      BIGINT         NOT NULL,
  -- `INCLUDED_IN_VALIDATION` : session `PENDING_VALIDATION`, validé avec elle ; `OWN_APPROVAL` :
  -- session `VALIDATED`, demande propre.
  treatment               VARCHAR(25)    NOT NULL,
  status                  VARCHAR(20)    NOT NULL DEFAULT 'PENDING',
  applied_at              DATETIME(6)    NOT NULL,
  approval_request_id     BINARY(16)     NULL,
  validated_by            BINARY(16)     NULL,
  validated_at            DATETIME(6)    NULL,
  variance_reason         VARCHAR(500)   NULL,
  command_id              BINARY(16)     NULL,
  created_at              DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by              BINARY(16)     NOT NULL,
  updated_at              DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by              BINARY(16)     NULL,
  version                 INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_finance_cash_session_adjustments_movement (movement_id),
  KEY ix_finance_cash_session_adjustments_session (session_id, applied_at),
  KEY ix_finance_cash_session_adjustments_status (status, applied_at),
  CONSTRAINT ck_finance_cash_session_adjustments_cause CHECK (cause IN ('LATE_OPERATION', 'REVERSAL')),
  CONSTRAINT ck_finance_cash_session_adjustments_treatment CHECK (treatment IN ('INCLUDED_IN_VALIDATION', 'OWN_APPROVAL')),
  CONSTRAINT ck_finance_cash_session_adjustments_status CHECK (status IN ('PENDING', 'VALIDATED')),
  CONSTRAINT ck_finance_cash_session_adjustments_delta CHECK (
    delta_xaf <> 0 AND delta_xaf = variance_after_xaf - variance_before_xaf
  ),
  CONSTRAINT ck_finance_cash_session_adjustments_validation CHECK (
    status <> 'VALIDATED' OR (validated_at IS NOT NULL AND validated_by IS NOT NULL)
  ),
  CONSTRAINT fk_finance_cash_session_adjustments_session FOREIGN KEY (session_id) REFERENCES finance_cash_sessions (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_session_adjustments_movement FOREIGN KEY (movement_id) REFERENCES finance_cash_movements (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_session_adjustments_trigger FOREIGN KEY (trigger_movement_id) REFERENCES finance_cash_movements (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_session_adjustments_approval FOREIGN KEY (approval_request_id) REFERENCES approvals_approval_requests (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_session_adjustments_validated_by FOREIGN KEY (validated_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_session_adjustments_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_session_adjustments_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Registre d'ajustements : seules la validation évolue (état, valideur, demande, motif).
CREATE TRIGGER trg_finance_cash_session_adjustments_update_guard BEFORE UPDATE ON finance_cash_session_adjustments FOR EACH ROW
BEGIN
  IF NOT (
    NEW.session_id <=> OLD.session_id AND
    NEW.movement_id <=> OLD.movement_id AND
    NEW.trigger_movement_id <=> OLD.trigger_movement_id AND
    NEW.cause <=> OLD.cause AND
    NEW.variance_before_xaf <=> OLD.variance_before_xaf AND
    NEW.variance_after_xaf <=> OLD.variance_after_xaf AND
    NEW.delta_xaf <=> OLD.delta_xaf AND
    NEW.expected_after_xaf <=> OLD.expected_after_xaf AND
    NEW.treatment <=> OLD.treatment AND
    NEW.applied_at <=> OLD.applied_at AND
    NEW.command_id <=> OLD.command_id AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_cash_session_adjustments : ajustement immuable, seule sa validation évolue.';
  END IF;
  IF OLD.status = 'VALIDATED' AND NOT (
    NEW.status <=> OLD.status AND
    NEW.validated_by <=> OLD.validated_by AND
    NEW.validated_at <=> OLD.validated_at AND
    NEW.approval_request_id <=> OLD.approval_request_id AND
    NEW.variance_reason <=> OLD.variance_reason
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_cash_session_adjustments : ajustement validé figé.';
  END IF;
END;

CREATE TRIGGER trg_finance_cash_session_adjustments_no_delete BEFORE DELETE ON finance_cash_session_adjustments FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_cash_session_adjustments : suppression interdite (ADR-006).';
END;

-- Remise de fonds entre deux comptes (SM-CASH-TRANSFER ; ADR-032 §7 : aucun second mouvement d'écart).
CREATE TABLE finance_cash_transfers (
  id                      BINARY(16)     NOT NULL,
  doc_number              VARCHAR(40)    NOT NULL,
  local_ref               VARCHAR(20)    NULL,
  -- Site de numérotation du document (le compte source n'a pas toujours de site).
  site_id                 BINARY(16)     NULL,
  from_account_id         BINARY(16)     NOT NULL,
  to_account_id           BINARY(16)     NOT NULL,
  amount_sent_xaf         BIGINT         NOT NULL,
  amount_received_xaf     BIGINT         NULL,
  -- Écart = reçu − envoyé (AV-153) : négatif = manque, positif = excédent.
  discrepancy_xaf         BIGINT         NULL,
  status                  VARCHAR(25)    NOT NULL DEFAULT 'SENT',
  sent_by                 BINARY(16)     NOT NULL,
  sent_device_id          BINARY(16)     NULL,
  sent_at                 DATETIME(6)    NOT NULL,
  carrier_user_id         BINARY(16)     NULL,
  carrier_name            VARCHAR(120)   NULL,
  received_by             BINARY(16)     NULL,
  received_device_id      BINARY(16)     NULL,
  received_at             DATETIME(6)    NULL,
  -- Mouvements du registre : sortie à l'envoi, entrée du montant reçu, inverse de l'annulation.
  out_movement_id         BINARY(16)     NOT NULL,
  in_movement_id          BINARY(16)     NULL,
  cancel_movement_id      BINARY(16)     NULL,
  -- Clôture d'un écart : imputation et motif, validés par `CASH_TRANSFER_DISCREPANCY`.
  imputation              VARCHAR(10)    NULL,
  closing_reason          VARCHAR(500)   NULL,
  closed_by               BINARY(16)     NULL,
  closed_at               DATETIME(6)    NULL,
  approval_request_id     BINARY(16)     NULL,
  cancel_reason           VARCHAR(500)   NULL,
  cancelled_by            BINARY(16)     NULL,
  cancelled_at            DATETIME(6)    NULL,
  occurred_at             DATETIME(6)    NOT NULL,
  command_id              BINARY(16)     NULL,
  client_created_at       DATETIME(6)    NULL,
  received_at_server      DATETIME(6)    NULL,
  created_device_id       BINARY(16)     NULL,
  captured_offline        BOOLEAN        NOT NULL DEFAULT FALSE,
  clock_suspect           BOOLEAN        NOT NULL DEFAULT FALSE,
  backdated_reason        TEXT           NULL,
  receive_command_id      BINARY(16)     NULL,
  cancel_command_id       BINARY(16)     NULL,
  created_at              DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by              BINARY(16)     NOT NULL,
  updated_at              DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by              BINARY(16)     NULL,
  version                 INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_finance_cash_transfers_doc_number (doc_number),
  UNIQUE KEY uq_finance_cash_transfers_device_ref (created_device_id, local_ref),
  UNIQUE KEY uq_finance_cash_transfers_command (command_id),
  UNIQUE KEY uq_finance_cash_transfers_receive_command (receive_command_id),
  UNIQUE KEY uq_finance_cash_transfers_cancel_command (cancel_command_id),
  UNIQUE KEY uq_finance_cash_transfers_out_movement (out_movement_id),
  KEY ix_finance_cash_transfers_from (from_account_id, status),
  KEY ix_finance_cash_transfers_to (to_account_id, status),
  KEY ix_finance_cash_transfers_status (status, sent_at),
  CONSTRAINT ck_finance_cash_transfers_status CHECK (status IN ('SENT', 'RECEIVED', 'DISCREPANCY_PENDING', 'CLOSED', 'CANCELLED')),
  CONSTRAINT ck_finance_cash_transfers_accounts CHECK (from_account_id <> to_account_id),
  CONSTRAINT ck_finance_cash_transfers_amounts CHECK (
    amount_sent_xaf > 0 AND (amount_received_xaf IS NULL OR amount_received_xaf >= 0)
  ),
  -- Comparaison null-safe : une CHECK qui vaut NULL passerait en silence.
  CONSTRAINT ck_finance_cash_transfers_discrepancy CHECK (
    discrepancy_xaf <=> (amount_received_xaf - amount_sent_xaf)
  ),
  CONSTRAINT ck_finance_cash_transfers_received_pair CHECK (
    (received_at IS NULL AND amount_received_xaf IS NULL AND received_by IS NULL)
    OR (received_at IS NOT NULL AND amount_received_xaf IS NOT NULL AND received_by IS NOT NULL)
  ),
  CONSTRAINT ck_finance_cash_transfers_imputation CHECK (
    imputation IS NULL OR imputation IN ('SENDER', 'CARRIER', 'RECEIVER', 'COMPANY')
  ),
  -- Cohérence de l'état avec ses données (SM-CASH-TRANSFER).
  CONSTRAINT ck_finance_cash_transfers_state CHECK (
    (status = 'SENT' AND received_at IS NULL AND cancelled_at IS NULL AND closed_at IS NULL)
    OR (status = 'RECEIVED' AND received_at IS NOT NULL AND in_movement_id IS NOT NULL AND discrepancy_xaf = 0)
    OR (status = 'DISCREPANCY_PENDING' AND received_at IS NOT NULL AND in_movement_id IS NOT NULL AND discrepancy_xaf <> 0
        AND closed_at IS NULL)
    OR (status = 'CLOSED' AND received_at IS NOT NULL AND in_movement_id IS NOT NULL AND discrepancy_xaf <> 0
        AND imputation IS NOT NULL AND closed_at IS NOT NULL AND closed_by IS NOT NULL)
    OR (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL
        AND cancel_movement_id IS NOT NULL AND received_at IS NULL)
  ),
  CONSTRAINT fk_finance_cash_transfers_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_transfers_from FOREIGN KEY (from_account_id) REFERENCES finance_cash_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_transfers_to FOREIGN KEY (to_account_id) REFERENCES finance_cash_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_transfers_sent_by FOREIGN KEY (sent_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_transfers_sent_device FOREIGN KEY (sent_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_transfers_carrier FOREIGN KEY (carrier_user_id) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_transfers_received_by FOREIGN KEY (received_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_transfers_received_device FOREIGN KEY (received_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_transfers_out_movement FOREIGN KEY (out_movement_id) REFERENCES finance_cash_movements (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_transfers_in_movement FOREIGN KEY (in_movement_id) REFERENCES finance_cash_movements (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_transfers_cancel_movement FOREIGN KEY (cancel_movement_id) REFERENCES finance_cash_movements (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_transfers_closed_by FOREIGN KEY (closed_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_transfers_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_transfers_approval FOREIGN KEY (approval_request_id) REFERENCES approvals_approval_requests (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_transfers_created_device FOREIGN KEY (created_device_id) REFERENCES identity_devices (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_transfers_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_finance_cash_transfers_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_finance_cash_transfers_update_guard BEFORE UPDATE ON finance_cash_transfers FOR EACH ROW
BEGIN
  IF NOT (
    NEW.doc_number <=> OLD.doc_number AND
    NEW.local_ref <=> OLD.local_ref AND
    NEW.site_id <=> OLD.site_id AND
    NEW.from_account_id <=> OLD.from_account_id AND
    NEW.to_account_id <=> OLD.to_account_id AND
    NEW.amount_sent_xaf <=> OLD.amount_sent_xaf AND
    NEW.sent_by <=> OLD.sent_by AND
    NEW.sent_device_id <=> OLD.sent_device_id AND
    NEW.sent_at <=> OLD.sent_at AND
    NEW.carrier_user_id <=> OLD.carrier_user_id AND
    NEW.carrier_name <=> OLD.carrier_name AND
    NEW.out_movement_id <=> OLD.out_movement_id AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.command_id <=> OLD.command_id AND
    NEW.client_created_at <=> OLD.client_created_at AND
    NEW.received_at_server <=> OLD.received_at_server AND
    NEW.created_device_id <=> OLD.created_device_id AND
    NEW.captured_offline <=> OLD.captured_offline AND
    NEW.clock_suspect <=> OLD.clock_suspect AND
    NEW.backdated_reason <=> OLD.backdated_reason AND
    NEW.created_at <=> OLD.created_at AND
    NEW.created_by <=> OLD.created_by
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_cash_transfers : envoi immuable ; seuls réception, clôture et annulation évoluent.';
  END IF;
  IF OLD.status IN ('RECEIVED', 'CLOSED', 'CANCELLED') AND NOT (
    NEW.status <=> OLD.status AND
    NEW.amount_received_xaf <=> OLD.amount_received_xaf AND
    NEW.discrepancy_xaf <=> OLD.discrepancy_xaf AND
    NEW.received_by <=> OLD.received_by AND
    NEW.received_at <=> OLD.received_at AND
    NEW.in_movement_id <=> OLD.in_movement_id AND
    NEW.cancel_movement_id <=> OLD.cancel_movement_id AND
    NEW.imputation <=> OLD.imputation AND
    NEW.closing_reason <=> OLD.closing_reason AND
    NEW.closed_by <=> OLD.closed_by AND
    NEW.closed_at <=> OLD.closed_at AND
    NEW.cancelled_by <=> OLD.cancelled_by AND
    NEW.cancelled_at <=> OLD.cancelled_at
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_cash_transfers : remise terminée, ses données ne changent plus.';
  END IF;
  IF OLD.status IN ('CLOSED', 'CANCELLED') AND NEW.status <> OLD.status THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_cash_transfers : état terminal.';
  END IF;
END;

CREATE TRIGGER trg_finance_cash_transfers_no_delete BEFORE DELETE ON finance_cash_transfers FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'finance_cash_transfers : suppression interdite ; annuler la remise (ADR-006).';
END;

-- Clés étrangères de l'index `cash_session_id` (colonne nullable jamais écrite avant P5).
ALTER TABLE finance_cash_movements
  ADD CONSTRAINT fk_finance_cash_movements_session FOREIGN KEY (cash_session_id) REFERENCES finance_cash_sessions (id) ON DELETE RESTRICT;
ALTER TABLE sales_sales
  ADD CONSTRAINT fk_sales_sales_cash_session FOREIGN KEY (cash_session_id) REFERENCES finance_cash_sessions (id) ON DELETE RESTRICT;
ALTER TABLE sales_customer_payments
  ADD CONSTRAINT fk_sales_customer_payments_cash_session FOREIGN KEY (cash_session_id) REFERENCES finance_cash_sessions (id) ON DELETE RESTRICT;

-- Type de validation de l'écart d'une remise de fonds (catalogue d'`approvals`, ADR-032 §7).
ALTER TABLE approvals_control_policies DROP CHECK ck_approvals_control_policies_operation_type;
ALTER TABLE approvals_control_policies ADD CONSTRAINT ck_approvals_control_policies_operation_type CHECK (operation_type IN (
  'LOSS_DECLARATION', 'MORTALITY', 'INVENTORY_ADJUSTMENT', 'TRANSFER_DISCREPANCY', 'EXPENSE',
  'PURCHASE_REQUEST', 'PURCHASE_ORDER', 'RECEIPT_WITHOUT_PO', 'RECEIPT_VALUE', 'SUPPLIER_PAYMENT',
  'PRICE_OVERRIDE', 'SALE_CANCELLATION', 'CREDIT_LIMIT_EXCEEDED', 'CASH_VARIANCE', 'CHECKIN_OVERRIDE',
  'RECEIPT_QUARANTINE', 'RECEIPT_CANCELLATION', 'ANIMAL_COUNT_ADJUSTMENT',
  'PAYMENT_CANCELLATION', 'PAYMENT_DUPLICATE', 'CASH_TRANSFER_DISCREPANCY'
));

GRANT SELECT, INSERT, UPDATE ON finance_cash_sessions TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON finance_cash_session_adjustments TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON finance_cash_transfers TO 'gic_app'@'%';

-- migrate:down transaction:false
-- Défait les clés étrangères, les tables, puis restaure le catalogue des types de validation ;
-- échoue sans effet de bord sur la contrainte s'il existe une politique `CASH_TRANSFER_DISCREPANCY`.
ALTER TABLE sales_customer_payments DROP FOREIGN KEY fk_sales_customer_payments_cash_session;
ALTER TABLE sales_sales DROP FOREIGN KEY fk_sales_sales_cash_session;
ALTER TABLE finance_cash_movements DROP FOREIGN KEY fk_finance_cash_movements_session;
DROP TABLE IF EXISTS finance_cash_transfers;
DROP TABLE IF EXISTS finance_cash_session_adjustments;
DROP TABLE IF EXISTS finance_cash_sessions;
ALTER TABLE approvals_control_policies
  DROP CHECK ck_approvals_control_policies_operation_type,
  ADD CONSTRAINT ck_approvals_control_policies_operation_type CHECK (operation_type IN (
    'LOSS_DECLARATION', 'MORTALITY', 'INVENTORY_ADJUSTMENT', 'TRANSFER_DISCREPANCY', 'EXPENSE',
    'PURCHASE_REQUEST', 'PURCHASE_ORDER', 'RECEIPT_WITHOUT_PO', 'RECEIPT_VALUE', 'SUPPLIER_PAYMENT',
    'PRICE_OVERRIDE', 'SALE_CANCELLATION', 'CREDIT_LIMIT_EXCEEDED', 'CASH_VARIANCE', 'CHECKIN_OVERRIDE',
    'RECEIPT_QUARANTINE', 'RECEIPT_CANCELLATION', 'ANIMAL_COUNT_ADJUSTMENT',
    'PAYMENT_CANCELLATION', 'PAYMENT_DUPLICATE'
  ));
