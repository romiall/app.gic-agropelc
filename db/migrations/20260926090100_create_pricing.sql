-- Espace de noms `pricing` (P1-02). Source : docs/03-data/dictionnaire/03-catalog-pricing.md ;
-- docs/01-functional/domaines/D10-PRX-tarification.md ; docs/02-domain-model/
-- 04-strategie-pricing.md. Dépend de catalog (products, units) et organization (zones, sites).
--
-- migrate:up transaction:false

CREATE TABLE pricing_commercial_campaigns (
  id           BINARY(16)     NOT NULL,
  code         VARCHAR(40)    NOT NULL,
  name         VARCHAR(200)   NOT NULL,
  valid_from   DATETIME(6)    NOT NULL,
  valid_to     DATETIME(6)    NOT NULL,
  status       VARCHAR(10)    NOT NULL DEFAULT 'DRAFT',
  created_at   DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by   BINARY(16)     NOT NULL,
  updated_at   DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by   BINARY(16)     NULL,
  version      INT            NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pricing_commercial_campaigns_code (code),
  CONSTRAINT ck_pricing_commercial_campaigns_period CHECK (valid_to > valid_from),
  CONSTRAINT ck_pricing_commercial_campaigns_status CHECK (status IN ('DRAFT', 'ACTIVE', 'CANCELLED')),
  CONSTRAINT fk_pricing_commercial_campaigns_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_pricing_commercial_campaigns_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- Suppr. ANNULATION (statut) : jamais de suppression physique.
CREATE TRIGGER trg_pricing_commercial_campaigns_no_delete BEFORE DELETE ON pricing_commercial_campaigns FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'pricing_commercial_campaigns : suppression physique interdite (INV-GLO-03) ; utiliser status=CANCELLED.';
END;

CREATE TABLE pricing_price_rules (
  id                        BINARY(16)     NOT NULL,
  code                      VARCHAR(40)    NOT NULL,
  version                   INT            NOT NULL DEFAULT 1,
  supersedes_rule_id        BINARY(16)     NULL,
  product_id                BINARY(16)     NOT NULL,
  unit_price_xaf            BIGINT         NOT NULL,
  pricing_unit_code         VARCHAR(20)    NOT NULL,
  zone_id                   BINARY(16)     NULL,
  site_id                   BINARY(16)     NULL,
  customer_category_id      BINARY(16)     NULL,
  channel_code              VARCHAR(20)    NULL,
  min_quantity              DECIMAL(14,3)  NULL,
  commercial_campaign_id    BINARY(16)     NULL,
  priority                  INT            NOT NULL DEFAULT 0,
  -- BR-PRX-005, stockée pour les index et l'explication (dictionnaire §price_rules).
  specificity               SMALLINT       NOT NULL DEFAULT 0,
  valid_from                DATETIME(6)    NOT NULL,
  valid_to                  DATETIME(6)    NULL,
  status                    VARCHAR(10)    NOT NULL DEFAULT 'DRAFT',
  approved_by               BINARY(16)     NULL,
  approved_at               DATETIME(6)    NULL,
  notes                     TEXT           NULL,
  created_at                DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by                BINARY(16)     NOT NULL,
  updated_at                DATETIME(6)    NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  updated_by                BINARY(16)     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pricing_price_rules_code_version (code, version),
  KEY ix_pricing_price_rules_product_status_from (product_id, status, valid_from),
  KEY ix_pricing_price_rules_zone (zone_id),
  KEY ix_pricing_price_rules_site (site_id),
  CONSTRAINT ck_pricing_price_rules_price CHECK (unit_price_xaf > 0),
  CONSTRAINT ck_pricing_price_rules_period CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT ck_pricing_price_rules_min_quantity CHECK (min_quantity IS NULL OR min_quantity > 0),
  CONSTRAINT ck_pricing_price_rules_status CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED', 'CANCELLED')),
  CONSTRAINT ck_pricing_price_rules_approved CHECK (
    (status IN ('ACTIVE', 'RETIRED') AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
    OR (status IN ('DRAFT', 'CANCELLED'))
  ),
  CONSTRAINT fk_pricing_price_rules_supersedes FOREIGN KEY (supersedes_rule_id) REFERENCES pricing_price_rules (id) ON DELETE RESTRICT,
  CONSTRAINT fk_pricing_price_rules_product FOREIGN KEY (product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_pricing_price_rules_pricing_unit FOREIGN KEY (pricing_unit_code) REFERENCES catalog_units (code) ON DELETE RESTRICT,
  CONSTRAINT fk_pricing_price_rules_zone FOREIGN KEY (zone_id) REFERENCES organization_zones (id) ON DELETE RESTRICT,
  CONSTRAINT fk_pricing_price_rules_site FOREIGN KEY (site_id) REFERENCES organization_sites (id) ON DELETE RESTRICT,
  CONSTRAINT fk_pricing_price_rules_customer_category FOREIGN KEY (customer_category_id) REFERENCES catalog_customer_categories (id) ON DELETE RESTRICT,
  CONSTRAINT fk_pricing_price_rules_channel FOREIGN KEY (channel_code) REFERENCES catalog_sales_channels (code) ON DELETE RESTRICT,
  CONSTRAINT fk_pricing_price_rules_campaign FOREIGN KEY (commercial_campaign_id) REFERENCES pricing_commercial_campaigns (id) ON DELETE RESTRICT,
  CONSTRAINT fk_pricing_price_rules_approved_by FOREIGN KEY (approved_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_pricing_price_rules_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_pricing_price_rules_updated_by FOREIGN KEY (updated_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

-- INV-PRX-01 / INV-PRX-03 : une règle ACTIVE ou RETIRED est immuable, à l'exception d'une
-- réduction de `valid_to` (BR-PRX-007) ; seules les colonnes non structurelles (`valid_to`,
-- `status` DRAFT->CANCELLED, STD-AUDIT de mise à jour) peuvent changer. Une règle DRAFT reste
-- librement modifiable par le gestionnaire de commande jusqu'à son activation.
CREATE TRIGGER trg_pricing_price_rules_update_guard BEFORE UPDATE ON pricing_price_rules FOR EACH ROW
BEGIN
  IF OLD.status IN ('ACTIVE', 'RETIRED') THEN
    IF NOT (
      NEW.code <=> OLD.code AND NEW.version <=> OLD.version AND
      NEW.supersedes_rule_id <=> OLD.supersedes_rule_id AND
      NEW.product_id <=> OLD.product_id AND NEW.unit_price_xaf <=> OLD.unit_price_xaf AND
      NEW.pricing_unit_code <=> OLD.pricing_unit_code AND NEW.zone_id <=> OLD.zone_id AND
      NEW.site_id <=> OLD.site_id AND NEW.customer_category_id <=> OLD.customer_category_id AND
      NEW.channel_code <=> OLD.channel_code AND NEW.min_quantity <=> OLD.min_quantity AND
      NEW.commercial_campaign_id <=> OLD.commercial_campaign_id AND
      NEW.priority <=> OLD.priority AND NEW.specificity <=> OLD.specificity AND
      NEW.valid_from <=> OLD.valid_from AND
      NEW.approved_by <=> OLD.approved_by AND NEW.approved_at <=> OLD.approved_at AND
      NEW.created_at <=> OLD.created_at AND NEW.created_by <=> OLD.created_by AND
      (NEW.valid_to <=> OLD.valid_to OR (NEW.valid_to IS NOT NULL AND (OLD.valid_to IS NULL OR NEW.valid_to < OLD.valid_to)))
    ) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'pricing_price_rules : règle active ou terminée immuable, sauf réduction de valid_to (BR-PRX-007).';
    END IF;
    IF NEW.status NOT IN ('ACTIVE', 'RETIRED') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'pricing_price_rules : une règle active ou terminée ne redevient jamais brouillon.';
    END IF;
  END IF;
END;

CREATE TRIGGER trg_pricing_price_rules_no_delete BEFORE DELETE ON pricing_price_rules FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'pricing_price_rules : suppression physique interdite (INV-PRX-03).';
END;

-- Droits par table (INV-GLO-05).
GRANT SELECT, INSERT, UPDATE ON pricing_commercial_campaigns TO 'gic_app'@'%';
GRANT SELECT, INSERT, UPDATE ON pricing_price_rules TO 'gic_app'@'%';

-- migrate:down transaction:false
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS pricing_price_rules;
DROP TABLE IF EXISTS pricing_commercial_campaigns;
SET FOREIGN_KEY_CHECKS = 1;
