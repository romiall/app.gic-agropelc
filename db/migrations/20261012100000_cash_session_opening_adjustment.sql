-- Module `finance`, ajustements de session de caisse : ajustement de l'écart d'**ouverture** (P5-23, revue
-- adverse ; AV-224). Source : ADR-032 §4 et §6 ; dictionnaire 07-finance (`finance_cash_session_adjustments`).
--
-- Une opération d'une caisse de PDV datée entre la clôture d'une session et l'ouverture de la suivante
-- (« trou »), synchronisée après cette ouverture, n'appartient à aucune session : l'écart d'ouverture de la
-- session suivante, figé sans elle, la comptait une seconde fois (manque imputé à l'ouvreur, puis surplus à
-- l'ouverture d'après). Elle est désormais corrigée par un ajustement de cause `LATE_BEFORE_OPENING`,
-- posé sur la session suivante (mouvement `SESSION_VARIANCE` daté de son ouverture). Aucune colonne ne
-- change : seule la liste des causes admises s'élargit.
--
-- migrate:up transaction:false

ALTER TABLE finance_cash_session_adjustments
  DROP CHECK ck_finance_cash_session_adjustments_cause,
  ADD CONSTRAINT ck_finance_cash_session_adjustments_cause CHECK (
    cause IN ('LATE_OPERATION', 'REVERSAL', 'LATE_BEFORE_OPENING')
  );

-- migrate:down transaction:false
-- Échoue sans effet de bord s'il existe un ajustement d'ouverture (il ne satisferait plus l'ancien CHECK).

ALTER TABLE finance_cash_session_adjustments
  DROP CHECK ck_finance_cash_session_adjustments_cause,
  ADD CONSTRAINT ck_finance_cash_session_adjustments_cause CHECK (cause IN ('LATE_OPERATION', 'REVERSAL'));
