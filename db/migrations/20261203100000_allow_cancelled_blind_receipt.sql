-- Annulation d'une réception sans document non rapprochée (AV-520 ; SM-TRANSFER `UNMATCHED → CANCELLED`). Le CHECK
-- `ck_inventory_stock_transfers_kind_status` (migration 20261010093000) n'admet pour une réception sans document que
-- `UNMATCHED` et `MATCHED` : `CANCELLED`, déjà valide pour le CHECK de statut d'origine, y devient permis. Rien d'autre
-- ne change : les contraintes `matched` et `returned` exigent déjà leurs colonnes nulles pour tout autre statut.
--
-- Un seul ALTER : le retrait et la pose du CHECK sont atomiques (précédent : 20261202090000).
--
-- Retour arrière : impossible tant qu'une réception sans document annulée existe (le CHECK d'origine la refuserait) ;
-- le down échoue alors sans rien modifier (ALTER atomique).
--
-- migrate:up transaction:false

ALTER TABLE inventory_stock_transfers
  DROP CHECK ck_inventory_stock_transfers_kind_status,
  ADD CONSTRAINT ck_inventory_stock_transfers_kind_status CHECK (
    (transfer_kind = 'BLIND_RECEIPT' AND status IN ('UNMATCHED', 'MATCHED', 'CANCELLED'))
    OR (transfer_kind = 'STANDARD' AND status IN (
      'REQUESTED', 'DECLINED', 'CANCELLED', 'DISPATCHED', 'RECEIVED', 'DISCREPANCY_PENDING', 'CLOSED', 'RETURNED'
    ))
    OR (transfer_kind = 'INTERNAL' AND status = 'COMPLETED')
  );

-- migrate:down transaction:false

ALTER TABLE inventory_stock_transfers
  DROP CHECK ck_inventory_stock_transfers_kind_status,
  ADD CONSTRAINT ck_inventory_stock_transfers_kind_status CHECK (
    (transfer_kind = 'BLIND_RECEIPT' AND status IN ('UNMATCHED', 'MATCHED'))
    OR (transfer_kind = 'STANDARD' AND status IN (
      'REQUESTED', 'DECLINED', 'CANCELLED', 'DISPATCHED', 'RECEIVED', 'DISCREPANCY_PENDING', 'CLOSED', 'RETURNED'
    ))
    OR (transfer_kind = 'INTERNAL' AND status = 'COMPLETED')
  );
