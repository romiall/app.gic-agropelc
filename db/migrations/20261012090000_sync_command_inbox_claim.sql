-- Module `sync`, inbox des commandes : reprise réclamée par tentative (P5-21, revue adverse ; AV-210,
-- AV-217). Source : 06-offline-sync/02-synchronisation.md §3.2 ; INV-SYN-01 ; dictionnaire
-- 11-audit-sync-integrations-platform.md (`sync_command_inbox`).
--
-- Une ligne `RECEIVED` est « en cours de traitement » ou « abandonnée » selon le temps écoulé depuis sa
-- dernière réclamation. Cet âge se mesurait sur `received_at`, la première réception, que le
-- déclencheur `trg_sync_command_inbox_update_guard` rend immuable : une commande reprise paraissait
-- aussitôt abandonnée et un second renvoi simultané pouvait la traiter une deuxième fois.
-- - `claimed_at` : instant de la dernière réclamation (insertion ou reprise) ; NULL pour les lignes
--   antérieures, dont l'âge se lit alors sur `received_at`. Colonne hors de la liste figée du
--   déclencheur : modifiable, comme `status`, `result`, `error_*`, `applied_at` et `attempts`.
-- - `attempts` : SMALLINT → INT. Le numéro de tentative est le jeton de la réclamation ; une commande
--   qui ne se règle pas est renvoyée longtemps (AV-217), un SMALLINT débordait en quelques heures.
--
-- migrate:up transaction:false

ALTER TABLE sync_command_inbox
  ADD COLUMN claimed_at DATETIME(6) NULL AFTER applied_at,
  MODIFY COLUMN attempts INT NOT NULL DEFAULT 1;

-- migrate:down transaction:false
-- Échoue sans effet de bord si une ligne a dépassé 32 767 tentatives.

ALTER TABLE sync_command_inbox
  DROP COLUMN claimed_at,
  MODIFY COLUMN attempts SMALLINT NOT NULL DEFAULT 1;
