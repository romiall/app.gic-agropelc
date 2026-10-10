-- Module `inventory`, réception sans document et retour à la source (P5-16). Sources : BR-STK-021,
-- BR-STK-024, BR-STK-025, SM-TRANSFER (04-workflows/machines-a-etats/03-stock.md), INV-STK-08 ;
-- AV-180 à AV-184 ; dictionnaire 03-data/dictionnaire/06-inventory.md (stock_transfers,
-- transfer_pair_locks).
--
-- - `transfer_kind` passe à VARCHAR(20) : `BLIND_RECEIPT` (13 caractères) ne tenait pas dans
--   VARCHAR(10) ; la valeur était admise par le CHECK sans jamais avoir pu être écrite ;
-- - rapprochement d'une réception sans document : `matched_at` (le lien `matched_transfer_id`
--   existait), un transfert n'est rapproché que d'une seule réception (UNIQUE, filet de concurrence
--   d'INV-STK-08) ; `unmatched_signalled_at` : le conflit de délai `TRANSFER_UNMATCHED` a été ouvert
--   (au plus une fois, AV-184), sans recherche dans les conflits ;
-- - retour à la source : `returned_by`, `returned_at`, `return_reason` ;
-- - cohérence nature / statut et colonnes de rapprochement et de retour (CHECK) ; aucune ligne
--   existante ne les viole (`UNMATCHED`, `MATCHED` et `RETURNED` n'ont jamais été produits) ;
-- - index de paire (destination, source, nature, statut) : les lectures verrouillantes des
--   candidats au rapprochement le désignent (`FORCE INDEX`) pour ne verrouiller que la paire ;
--   index (nature, statut, date) pour l'énumération non verrouillante du balayage ;
-- - `inventory_transfer_pair_locks` : une ligne-verrou par paire (source, destination), prise en
--   premier par toute opération qui expédie, reçoit, rapproche ou retourne un transfert de la
--   paire (même motif que `platform_document_sequences`) ; table technique sans clé étrangère :
--   l'existence des emplacements est contrôlée par le gestionnaire après le verrou, et un refus
--   annule l'insertion.
--
-- migrate:up transaction:false

ALTER TABLE inventory_stock_transfers DROP CHECK ck_inventory_stock_transfers_kind;

ALTER TABLE inventory_stock_transfers
  MODIFY COLUMN transfer_kind VARCHAR(20) NOT NULL DEFAULT 'STANDARD';

ALTER TABLE inventory_stock_transfers
  ADD COLUMN matched_at              DATETIME(6)   NULL AFTER matched_transfer_id,
  ADD COLUMN unmatched_signalled_at  DATETIME(6)   NULL AFTER matched_at,
  ADD COLUMN returned_by             BINARY(16)    NULL AFTER unmatched_signalled_at,
  ADD COLUMN returned_at             DATETIME(6)   NULL AFTER returned_by,
  ADD COLUMN return_reason           VARCHAR(500)  NULL AFTER returned_at,
  ADD UNIQUE KEY uq_inventory_stock_transfers_matched (matched_transfer_id),
  ADD KEY ix_inventory_stock_transfers_pair (to_location_id, from_location_id, transfer_kind, status),
  ADD KEY ix_inventory_stock_transfers_kind_status (transfer_kind, status, occurred_at),
  ADD CONSTRAINT ck_inventory_stock_transfers_kind CHECK (transfer_kind IN ('STANDARD', 'INTERNAL', 'BLIND_RECEIPT')),
  ADD CONSTRAINT ck_inventory_stock_transfers_kind_status CHECK (
    (transfer_kind = 'BLIND_RECEIPT' AND status IN ('UNMATCHED', 'MATCHED'))
    OR (transfer_kind = 'STANDARD' AND status IN (
      'REQUESTED', 'DECLINED', 'CANCELLED', 'DISPATCHED', 'RECEIVED', 'DISCREPANCY_PENDING', 'CLOSED', 'RETURNED'
    ))
    OR (transfer_kind = 'INTERNAL' AND status = 'COMPLETED')
  ),
  ADD CONSTRAINT ck_inventory_stock_transfers_matched CHECK (
    (status = 'MATCHED' AND matched_transfer_id IS NOT NULL AND matched_at IS NOT NULL)
    OR (status <> 'MATCHED' AND matched_transfer_id IS NULL AND matched_at IS NULL)
  ),
  ADD CONSTRAINT ck_inventory_stock_transfers_returned CHECK (
    (status = 'RETURNED' AND returned_by IS NOT NULL AND returned_at IS NOT NULL AND return_reason IS NOT NULL)
    OR (status <> 'RETURNED' AND returned_by IS NULL AND returned_at IS NULL AND return_reason IS NULL)
  ),
  ADD CONSTRAINT ck_inventory_stock_transfers_signalled CHECK (
    unmatched_signalled_at IS NULL OR transfer_kind = 'BLIND_RECEIPT'
  ),
  ADD CONSTRAINT fk_inventory_stock_transfers_returned_by FOREIGN KEY (returned_by) REFERENCES identity_users (id) ON DELETE RESTRICT;

-- L'index implicite de la clé étrangère `matched_transfer_id` (`fk_inventory_stock_transfers_matched`)
-- est retiré par MySQL lui-même : l'index unique le remplace.

CREATE TABLE inventory_transfer_pair_locks (
  from_location_id  BINARY(16)   NOT NULL,
  to_location_id    BINARY(16)   NOT NULL,
  created_at        DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (from_location_id, to_location_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Droits par table (INV-GLO-05). UPDATE : exigé par la lecture verrouillante et par l'upsert sans
-- effet qui crée la ligne au premier usage ; pas de DELETE (une ligne-verrou n'a jamais à disparaître).
GRANT SELECT, INSERT, UPDATE ON inventory_transfer_pair_locks TO 'gic_app'@'%';

-- migrate:down transaction:false
-- Le retour à VARCHAR(10) échoue (sans effet) s'il existe une ligne `BLIND_RECEIPT` : ne pas défaire
-- cette migration sur une base qui en contient. La clé étrangère `matched_transfer_id` est retirée puis
-- recréée : MySQL lui rend ainsi son index implicite d'origine (`fk_inventory_stock_transfers_matched`).
DROP TABLE IF EXISTS inventory_transfer_pair_locks;
ALTER TABLE inventory_stock_transfers
  DROP FOREIGN KEY fk_inventory_stock_transfers_returned_by,
  DROP FOREIGN KEY fk_inventory_stock_transfers_matched,
  DROP CHECK ck_inventory_stock_transfers_signalled,
  DROP CHECK ck_inventory_stock_transfers_returned,
  DROP CHECK ck_inventory_stock_transfers_matched,
  DROP CHECK ck_inventory_stock_transfers_kind_status,
  DROP CHECK ck_inventory_stock_transfers_kind,
  DROP INDEX ix_inventory_stock_transfers_kind_status,
  DROP INDEX ix_inventory_stock_transfers_pair,
  DROP INDEX uq_inventory_stock_transfers_matched;
ALTER TABLE inventory_stock_transfers
  DROP COLUMN return_reason,
  DROP COLUMN returned_at,
  DROP COLUMN returned_by,
  DROP COLUMN unmatched_signalled_at,
  DROP COLUMN matched_at;
ALTER TABLE inventory_stock_transfers
  MODIFY COLUMN transfer_kind VARCHAR(10) NOT NULL DEFAULT 'STANDARD';
ALTER TABLE inventory_stock_transfers
  ADD CONSTRAINT ck_inventory_stock_transfers_kind CHECK (transfer_kind IN ('STANDARD', 'INTERNAL', 'BLIND_RECEIPT')),
  ADD CONSTRAINT fk_inventory_stock_transfers_matched FOREIGN KEY (matched_transfer_id) REFERENCES inventory_stock_transfers (id) ON DELETE RESTRICT;
