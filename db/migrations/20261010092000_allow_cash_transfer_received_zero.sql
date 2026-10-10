-- Module `finance`, remises de fonds : cohérence d'état d'une remise reçue à zéro (P5-15).
-- Source : ADR-032 §7 ; SM-CASH-TRANSFER ; D09 §16 ; AV-174 (motif exigé à la clôture d'un écart),
-- AV-175 (remise perdue en route : réception de 0 XAF, sans entrée de trésorerie).
--
-- Le CHECK d'état de P5-03 exigeait `in_movement_id` pour `DISCREPANCY_PENDING` et `CLOSED`, alors
-- qu'un mouvement de trésorerie est toujours > 0 et que le schéma de réception admet 0 : une remise
-- entièrement perdue n'avait aucune issue. Ce CHECK est remplacé :
-- - `DISCREPANCY_PENDING` et `CLOSED` : entrée exigée si le montant reçu est > 0, absente s'il est nul ;
-- - `CLOSED` : imputation, **motif**, date et auteur de la clôture exigés (la décision porte toujours
--   un motif, AV-174) ;
-- - `CANCELLED` : aucune entrée de trésorerie (une remise annulée n'a jamais été reçue).
-- Un second CHECK interdit une entrée de trésorerie pour un montant reçu nul. Le code applique ces
-- règles avant l'écriture (une erreur SQL sur un fait accompli serait rejouée sans fin) ; les
-- contraintes ne sont qu'un filet. Aucun changement de colonne ni de droit.
--
-- migrate:up transaction:false

ALTER TABLE finance_cash_transfers
  DROP CHECK ck_finance_cash_transfers_state,
  ADD CONSTRAINT ck_finance_cash_transfers_state CHECK (
    (status = 'SENT' AND received_at IS NULL AND cancelled_at IS NULL AND closed_at IS NULL)
    OR (status = 'RECEIVED' AND received_at IS NOT NULL AND in_movement_id IS NOT NULL AND discrepancy_xaf = 0)
    OR (status = 'DISCREPANCY_PENDING' AND received_at IS NOT NULL AND discrepancy_xaf <> 0 AND closed_at IS NULL
        AND ((amount_received_xaf > 0 AND in_movement_id IS NOT NULL)
          OR (amount_received_xaf = 0 AND in_movement_id IS NULL)))
    OR (status = 'CLOSED' AND received_at IS NOT NULL AND discrepancy_xaf <> 0
        AND ((amount_received_xaf > 0 AND in_movement_id IS NOT NULL)
          OR (amount_received_xaf = 0 AND in_movement_id IS NULL))
        AND imputation IS NOT NULL AND closing_reason IS NOT NULL AND closed_at IS NOT NULL
        AND closed_by IS NOT NULL)
    OR (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL
        AND cancel_movement_id IS NOT NULL AND received_at IS NULL AND in_movement_id IS NULL)
  ),
  ADD CONSTRAINT ck_finance_cash_transfers_in_movement CHECK (
    in_movement_id IS NULL OR amount_received_xaf > 0
  );

-- migrate:down transaction:false
-- Restaure le CHECK exact de 20261008090000 ; échoue sans effet de bord s'il existe une remise reçue
-- à zéro (son état ne satisferait plus l'ancien CHECK).
ALTER TABLE finance_cash_transfers
  DROP CHECK ck_finance_cash_transfers_in_movement,
  DROP CHECK ck_finance_cash_transfers_state,
  ADD CONSTRAINT ck_finance_cash_transfers_state CHECK (
    (status = 'SENT' AND received_at IS NULL AND cancelled_at IS NULL AND closed_at IS NULL)
    OR (status = 'RECEIVED' AND received_at IS NOT NULL AND in_movement_id IS NOT NULL AND discrepancy_xaf = 0)
    OR (status = 'DISCREPANCY_PENDING' AND received_at IS NOT NULL AND in_movement_id IS NOT NULL AND discrepancy_xaf <> 0
        AND closed_at IS NULL)
    OR (status = 'CLOSED' AND received_at IS NOT NULL AND in_movement_id IS NOT NULL AND discrepancy_xaf <> 0
        AND imputation IS NOT NULL AND closed_at IS NOT NULL AND closed_by IS NOT NULL)
    OR (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL
        AND cancel_movement_id IS NOT NULL AND received_at IS NULL)
  );
