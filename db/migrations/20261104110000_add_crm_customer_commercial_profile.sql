-- Espace de noms `crm` : profil commercial du client (PP-D ; REQ-308, AV-316).
-- Source : docs/03-data/dictionnaire/04-crm-fieldwork.md (`crm.customers`) ; D02-CRM ; fiche de visite VC.
--
-- Le compte avait `credit_allowed`, `credit_limit_xaf`, `payment_terms_days`, `business_activity` et `category_id`,
-- pas le produit qui intéresse le client, la quantité qu'il peut écouler par jour ni sa façon habituelle de payer.
-- Trois champs sur le compte (AV-316 (a) : le compte reste le propriétaire, pas de table « profil »), plus la demande
-- de paiement différé du commercial, **distincte** de `credit_allowed` : celui-ci est une décision du responsable
-- (AV-028), la demande n'en est que l'amorce. Les champs se modifient par `crm.customer.update` comme les autres :
-- version par champ (`field_versions`), fusion champ par champ d'un compte modifié sur deux appareils.
--
-- `usual_payment_method_code` est un code de moyen de paiement à titre indicatif (pas de clé étrangère : le module
-- `crm` ne lit pas la table de `finance`) ; la PWA ne propose que les moyens connus de l'appareil.
--
-- Expand seulement : colonnes facultatives (la demande de crédit vaut faux), que la version précédente du code ignore.
--
-- migrate:up transaction:false

ALTER TABLE crm_customers
  ADD COLUMN interest_product_id        BINARY(16)    NULL,
  ADD COLUMN potential_qty_per_day      DECIMAL(14,3) NULL,
  ADD COLUMN potential_unit_code        VARCHAR(20)   NULL,
  ADD COLUMN usual_payment_method_code  VARCHAR(40)   NULL,
  ADD COLUMN credit_requested           BOOLEAN       NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT ck_crm_customers_potential CHECK (potential_qty_per_day IS NULL OR potential_qty_per_day >= 0),
  ADD CONSTRAINT fk_crm_customers_interest_product FOREIGN KEY (interest_product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT;

-- migrate:down transaction:false

ALTER TABLE crm_customers
  DROP FOREIGN KEY fk_crm_customers_interest_product,
  DROP CONSTRAINT ck_crm_customers_potential,
  DROP COLUMN credit_requested,
  DROP COLUMN usual_payment_method_code,
  DROP COLUMN potential_unit_code,
  DROP COLUMN potential_qty_per_day,
  DROP COLUMN interest_product_id;
