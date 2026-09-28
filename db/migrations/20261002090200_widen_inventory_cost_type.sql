-- P7-05 : `inventory_cost_entries.cost_type` élargi à 25 caractères — la nature
-- `PRODUCTION_TRANSFEREE` (21 caractères, ajoutée par 20261002090000 : crédit du lot producteur
-- au coût standard, AV-098, ADR-027) dépassait l'ancienne longueur de 20. Même longueur pour la
-- nature conservée sur les consommations.
--
-- migrate:up transaction:false
ALTER TABLE inventory_cost_entries MODIFY cost_type VARCHAR(25) NOT NULL;
ALTER TABLE inventory_consumptions MODIFY cost_type VARCHAR(25) NULL;

-- migrate:down transaction:false
ALTER TABLE inventory_consumptions MODIFY cost_type VARCHAR(20) NULL;
ALTER TABLE inventory_cost_entries MODIFY cost_type VARCHAR(20) NOT NULL;
