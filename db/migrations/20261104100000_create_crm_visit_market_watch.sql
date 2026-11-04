-- Espace de noms `crm` : veille marché relevée pendant une visite (PP-D ; REQ-308, AV-315).
-- Source : docs/03-data/dictionnaire/04-crm-fieldwork.md ; D02-CRM ; fiche de visite VC.
--
-- La visite n'avait que des notes, un résultat et une prochaine action : rien sur le fournisseur ou le prix d'un
-- concurrent. Table fille de la visite (AV-315 (a)) : un relevé par ligne, plusieurs par visite. Le nom du fournisseur
-- ou du concurrent est un libellé libre (pas de référentiel de concurrents tant que la veille ne s'étend pas).
-- Ajout seul, comme la visite (BR-CRM-016) : une visite annulée garde ses relevés, la correction passe par une
-- nouvelle visite ; aucune suppression physique (règle 4).
--
-- Expand seulement : une table nouvelle, que la version précédente du code ignore.
--
-- migrate:up transaction:false

CREATE TABLE crm_visit_market_watch (
  id                  BINARY(16)   NOT NULL,
  visit_id            BINARY(16)   NOT NULL,
  position_no         SMALLINT     NOT NULL,
  watch_type          VARCHAR(12)  NOT NULL,
  source_name         VARCHAR(120) NOT NULL,
  product_id          BINARY(16)   NULL,
  unit_code           VARCHAR(20)  NULL,
  observed_price_xaf  BIGINT       NULL,
  created_at          DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by          BINARY(16)   NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_crm_visit_market_watch_position (visit_id, position_no),
  KEY ix_crm_visit_market_watch_product (product_id),
  CONSTRAINT ck_crm_visit_market_watch_type CHECK (watch_type IN ('SUPPLIER', 'COMPETITOR')),
  CONSTRAINT ck_crm_visit_market_watch_price CHECK (observed_price_xaf IS NULL OR observed_price_xaf >= 0),
  CONSTRAINT fk_crm_visit_market_watch_visit FOREIGN KEY (visit_id) REFERENCES crm_visits (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_visit_market_watch_product FOREIGN KEY (product_id) REFERENCES catalog_products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_crm_visit_market_watch_created_by FOREIGN KEY (created_by) REFERENCES identity_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_cs;

CREATE TRIGGER trg_crm_visit_market_watch_no_delete BEFORE DELETE ON crm_visit_market_watch FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_visit_market_watch : suppression physique interdite (BR-CRM-016).';
END;

CREATE TRIGGER trg_crm_visit_market_watch_no_update BEFORE UPDATE ON crm_visit_market_watch FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'crm_visit_market_watch : relevé en ajout seul, modification interdite (BR-CRM-016).';
END;

GRANT SELECT, INSERT ON crm_visit_market_watch TO 'gic_app'@'%';

-- migrate:down transaction:false

DROP TABLE IF EXISTS crm_visit_market_watch;
