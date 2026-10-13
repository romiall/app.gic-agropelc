-- Module `sync`, inbox des commandes : drapeau d'horloge suspecte figé à la réception (P5-23, revue adverse ;
-- AV-216). Source : BR-SYN-011, ADR-016 ; 06-offline-sync/02-synchronisation.md §9 ; dictionnaire
-- 11-audit-sync-integrations-platform.md (`sync_command_inbox`).
--
-- Le seuil de suspicion était une constante de 5 min ; il est désormais lu dans le paramètre
-- `sync.clock_skew_flag_minutes`, une fois par lot, à l'heure serveur de la réception, par le service
-- d'envoi (`sync/`). Le module `platform/sync`, qui fournit `[STD-ORIGIN]` à tous les documents
-- (`loadCommandOrigin`), ne peut pas lire un paramètre d'`organization` (frontières de modules) : la décision
-- est donc écrite dans l'inbox à la réception (`clock_suspect`) et relue telle quelle. Elle est immuable,
-- comme l'écart mesuré : un changement ultérieur du paramètre ne réécrit pas l'histoire.
-- Rattrapage : les lignes existantes reprennent l'ancienne règle (|écart| > 5 min).
--
-- migrate:up transaction:false

ALTER TABLE sync_command_inbox
  ADD COLUMN clock_suspect BOOLEAN NOT NULL DEFAULT FALSE AFTER clock_skew_ms;

UPDATE sync_command_inbox
  SET clock_suspect = (ABS(clock_skew_ms) > 300000)
  WHERE clock_skew_ms IS NOT NULL;

DROP TRIGGER trg_sync_command_inbox_update_guard;

-- IMMUABLE sauf transitions (INV-SYN-01) : seuls le statut et le résultat de traitement
-- peuvent changer après réception.
CREATE TRIGGER trg_sync_command_inbox_update_guard BEFORE UPDATE ON sync_command_inbox FOR EACH ROW
BEGIN
  IF NOT (
    NEW.device_id <=> OLD.device_id AND
    NEW.user_id <=> OLD.user_id AND
    NEW.device_seq <=> OLD.device_seq AND
    NEW.transport <=> OLD.transport AND
    NEW.command_type <=> OLD.command_type AND
    NEW.command_version <=> OLD.command_version AND
    NEW.aggregate_type <=> OLD.aggregate_type AND
    NEW.aggregate_id <=> OLD.aggregate_id AND
    NEW.base_version <=> OLD.base_version AND
    NEW.depends_on <=> OLD.depends_on AND
    NEW.payload <=> OLD.payload AND
    NEW.payload_hash <=> OLD.payload_hash AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.client_created_at <=> OLD.client_created_at AND
    NEW.device_sent_at <=> OLD.device_sent_at AND
    NEW.received_at <=> OLD.received_at AND
    NEW.clock_skew_ms <=> OLD.clock_skew_ms AND
    NEW.clock_suspect <=> OLD.clock_suspect AND
    NEW.captured_offline <=> OLD.captured_offline AND
    NEW.batch_id <=> OLD.batch_id
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sync_command_inbox : seuls status/result/error_*/applied_at/attempts sont modifiables (INV-SYN-01).';
  END IF;
END;

-- migrate:down transaction:false

DROP TRIGGER trg_sync_command_inbox_update_guard;

CREATE TRIGGER trg_sync_command_inbox_update_guard BEFORE UPDATE ON sync_command_inbox FOR EACH ROW
BEGIN
  IF NOT (
    NEW.device_id <=> OLD.device_id AND
    NEW.user_id <=> OLD.user_id AND
    NEW.device_seq <=> OLD.device_seq AND
    NEW.transport <=> OLD.transport AND
    NEW.command_type <=> OLD.command_type AND
    NEW.command_version <=> OLD.command_version AND
    NEW.aggregate_type <=> OLD.aggregate_type AND
    NEW.aggregate_id <=> OLD.aggregate_id AND
    NEW.base_version <=> OLD.base_version AND
    NEW.depends_on <=> OLD.depends_on AND
    NEW.payload <=> OLD.payload AND
    NEW.payload_hash <=> OLD.payload_hash AND
    NEW.occurred_at <=> OLD.occurred_at AND
    NEW.client_created_at <=> OLD.client_created_at AND
    NEW.device_sent_at <=> OLD.device_sent_at AND
    NEW.received_at <=> OLD.received_at AND
    NEW.clock_skew_ms <=> OLD.clock_skew_ms AND
    NEW.captured_offline <=> OLD.captured_offline AND
    NEW.batch_id <=> OLD.batch_id
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'sync_command_inbox : seuls status/result/error_*/applied_at/attempts sont modifiables (INV-SYN-01).';
  END IF;
END;

ALTER TABLE sync_command_inbox DROP COLUMN clock_suspect;
