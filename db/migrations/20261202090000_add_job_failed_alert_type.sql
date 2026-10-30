-- Septième type d'alerte ajouté au catalogue de D13 §7.1 : JOB_FAILED, tâche de fond passée FAILED (P9-27 ;
-- décision du porteur du 29/10/2026, AV-469 choix (b) ; ADR-061, ADR-062). Le CHECK de
-- communication_alert_rules.alert_type énumère les types du catalogue : un type de plus demande une migration.
-- communication_alerts n'a pas ce CHECK (sa colonne alert_type référence la règle par clé étrangère).
--
-- La règle JOB_FAILED elle-même est semée par `pnpm run db:seed` (db/seeds/communication-references.ts), comme
-- les trente-six autres : cette migration ne pose aucune ligne. Tant qu'elle n'est pas semée, le consommateur
-- d'alertes ignore le type (loadAlertRule renvoie `undefined`).
--
-- Un seul ALTER : le retrait et la pose du CHECK sont atomiques (précédent : 20261002090000).
--
-- Retour arrière : la liste d'origine (36 types) ne peut être remise que si aucune règle JOB_FAILED n'existe ;
-- une règle semée ne se supprime pas (déclencheur trg_communication_alert_rules_no_delete, ADR-006). Sur une base
-- déjà semée, le down échoue sans rien modifier (ALTER atomique) : recréer la base de développement.
--
-- migrate:up transaction:false

ALTER TABLE communication_alert_rules
  DROP CHECK ck_communication_alert_rules_type,
  ADD CONSTRAINT ck_communication_alert_rules_type CHECK (alert_type IN (
    'STOCK_LOW', 'STOCK_OUT', 'POS_REPLENISH', 'STOCK_NEGATIVE', 'HIGH_LOSS', 'HIGH_MORTALITY',
    'DAILY_ENTRY_MISSING', 'STANDARD_COST_MISSING', 'RECEIPT_INCOMPLETE', 'INVENTORY_VARIANCE',
    'OVERDUE_RECEIVABLE', 'CASH_VARIANCE', 'CASH_HOLDING_HIGH', 'CASH_SESSION_OPEN_LONG',
    'CASH_TRANSFER_NOT_RECEIVED', 'SYNC_ERROR', 'SYNC_STALE', 'DEVICE_SEQ_GAP', 'CLOCK_SKEW',
    'INACTIVE_COMMERCIAL', 'CHECKIN_SUSPICIOUS', 'PRICE_MISMATCH', 'DUPLICATE_SUSPECTED',
    'APPROVAL_PENDING_LONG', 'TRANSFER_NOT_RECEIVED', 'TRANSFER_UNMATCHED', 'LOT_EXPIRING',
    'ATTACHMENT_MISSING', 'KOMMO_SYNC_FAILED', 'AUDIT_CHAIN_BROKEN', 'ALLOCATION_EXPIRED',
    'ALLOCATION_REVOCATION_PENDING', 'SALE_UNDELIVERED', 'CONSUMER_FAILED', 'LEDGER_MISMATCH',
    'CASH_MISMATCH', 'JOB_FAILED'
  ));

-- migrate:down transaction:false

ALTER TABLE communication_alert_rules
  DROP CHECK ck_communication_alert_rules_type,
  ADD CONSTRAINT ck_communication_alert_rules_type CHECK (alert_type IN (
    'STOCK_LOW', 'STOCK_OUT', 'POS_REPLENISH', 'STOCK_NEGATIVE', 'HIGH_LOSS', 'HIGH_MORTALITY',
    'DAILY_ENTRY_MISSING', 'STANDARD_COST_MISSING', 'RECEIPT_INCOMPLETE', 'INVENTORY_VARIANCE',
    'OVERDUE_RECEIVABLE', 'CASH_VARIANCE', 'CASH_HOLDING_HIGH', 'CASH_SESSION_OPEN_LONG',
    'CASH_TRANSFER_NOT_RECEIVED', 'SYNC_ERROR', 'SYNC_STALE', 'DEVICE_SEQ_GAP', 'CLOCK_SKEW',
    'INACTIVE_COMMERCIAL', 'CHECKIN_SUSPICIOUS', 'PRICE_MISMATCH', 'DUPLICATE_SUSPECTED',
    'APPROVAL_PENDING_LONG', 'TRANSFER_NOT_RECEIVED', 'TRANSFER_UNMATCHED', 'LOT_EXPIRING',
    'ATTACHMENT_MISSING', 'KOMMO_SYNC_FAILED', 'AUDIT_CHAIN_BROKEN', 'ALLOCATION_EXPIRED',
    'ALLOCATION_REVOCATION_PENDING', 'SALE_UNDELIVERED', 'CONSUMER_FAILED', 'LEDGER_MISMATCH',
    'CASH_MISMATCH'
  ));
