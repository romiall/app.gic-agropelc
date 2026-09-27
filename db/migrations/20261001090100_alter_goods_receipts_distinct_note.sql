-- Réception en quarantaine pour bon de livraison déjà comptabilisé (BR-APP-012), puis confirmée
-- « réception distincte » par le responsable des achats (SM-RECEIPT, QUARANTINED → POSTED) : elle
-- doit pouvoir être comptabilisée sans lever l'unicité (fournisseur, bon de livraison). DÉDUIT
-- (P6-05) : `distinct_note_confirmed` retire la réception confirmée de la clé d'unicité ; seule la
-- décision de validation le pose.
--
-- migrate:up transaction:false

ALTER TABLE procurement_goods_receipts
  ADD COLUMN distinct_note_confirmed BOOLEAN NOT NULL DEFAULT FALSE AFTER total_accepted_value_xaf;

ALTER TABLE procurement_goods_receipts DROP INDEX uq_procurement_goods_receipts_posted_note;
ALTER TABLE procurement_goods_receipts DROP COLUMN posted_note_key;
ALTER TABLE procurement_goods_receipts
  ADD COLUMN posted_note_key VARCHAR(100) GENERATED ALWAYS AS (
    CASE WHEN supplier_delivery_note_ref IS NOT NULL
          AND distinct_note_confirmed = FALSE
          AND status IN ('POSTED', 'POSTED_PENDING_REVIEW', 'REVIEW_REJECTED', 'CANCELLATION_PENDING')
         THEN CONCAT(HEX(supplier_id), ':', supplier_delivery_note_ref) END
  ) STORED AFTER distinct_note_confirmed;
ALTER TABLE procurement_goods_receipts
  ADD UNIQUE KEY uq_procurement_goods_receipts_posted_note (posted_note_key);

-- migrate:down transaction:false
ALTER TABLE procurement_goods_receipts DROP INDEX uq_procurement_goods_receipts_posted_note;
ALTER TABLE procurement_goods_receipts DROP COLUMN posted_note_key;
ALTER TABLE procurement_goods_receipts DROP COLUMN distinct_note_confirmed;
ALTER TABLE procurement_goods_receipts
  ADD COLUMN posted_note_key VARCHAR(100) GENERATED ALWAYS AS (
    CASE WHEN supplier_delivery_note_ref IS NOT NULL
          AND status IN ('POSTED', 'POSTED_PENDING_REVIEW', 'REVIEW_REJECTED', 'CANCELLATION_PENDING')
         THEN CONCAT(HEX(supplier_id), ':', supplier_delivery_note_ref) END
  ) STORED AFTER total_accepted_value_xaf;
ALTER TABLE procurement_goods_receipts
  ADD UNIQUE KEY uq_procurement_goods_receipts_posted_note (posted_note_key);
