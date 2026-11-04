-- Module `sync`, état technique par appareil : numéros de commandes refusées sur l'appareil (ADR-052, AV-507).
-- Source : BR-SYN-003 ; 06-offline-sync/02-synchronisation.md §3.1 ; dictionnaire
-- 11-audit-sync-integrations-platform.md (`sync_device_sync_state`, ligne `_device`).
--
-- Une commande dont l'enveloppe est invalide est refusée sur l'appareil avant l'envoi : elle n'atteint jamais le
-- serveur, et son `device_seq` manque dans la suite reçue. Sans déclaration, le détecteur `sync.devices.seq_gap_check`
-- y voit des commandes perdues et lève une alerte critique `DEVICE_SEQ_GAP` 24 heures plus tard. L'appareil déclare
-- désormais ces numéros à l'envoi (`skipped_device_seqs`) ; le serveur les garde, en plages `[début, fin]`
-- fusionnées, comme `known_gaps`, sur la ligne technique de l'appareil (une colonne de plus plutôt qu'une table :
-- même tuple `(device_id, dataset)`, même cycle de vie). Le détecteur les retire des plages manquantes.
--
-- Expand seulement : une colonne facultative, que la version précédente du code ignore.
--
-- migrate:up transaction:false

ALTER TABLE sync_device_sync_state
  ADD COLUMN declared_skips JSON NULL AFTER known_gaps;

-- migrate:down transaction:false

ALTER TABLE sync_device_sync_state DROP COLUMN declared_skips;
