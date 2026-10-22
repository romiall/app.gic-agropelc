-- Module `analytics` (P9-13) : jeux de faits de stock et de production de la couche sémantique — mouvements,
-- soldes, pertes, production du jour par lot, écritures de coût.
-- Source : docs/decisions/ADR-074 (§2, §7) ; ADR-075 ; D11 §7 et §8 ; BR-ANA-002, BR-ANA-004, BR-ANA-009.
-- Mêmes principes que `20261201090400` : lecture seule (`SQL SECURITY INVOKER`), `business_day` alias de la
-- colonne générée de la table source quand elle existe, portée dérivée dans la vue, documents annulés exclus.
-- migrate:up transaction:false

-- Mouvements de stock : une ligne par mouvement (les contre-écritures sont des mouvements à part entière, de même
-- `move_type` que le mouvement qu'elles défont : `is_reversal` et `source_doc_type` les distinguent, comme le
-- font les flux d'un emplacement).
-- Le site d'une extrémité se déduit de son emplacement ; un emplacement virtuel n'en a pas. Le titulaire
-- n'existe que pour un emplacement mobile. `value_xaf` est une valeur au coût (mesure protégée).
CREATE ALGORITHM = TEMPTABLE SQL SECURITY INVOKER VIEW analytics_f_stock_moves AS
SELECT
  m.business_date AS business_day,
  m.id AS move_id,
  m.product_id,
  m.from_location_id,
  m.to_location_id,
  m.move_type,
  m.is_reversal,
  m.source_doc_type,
  rc.code AS reason_code,
  m.lot_id AS stock_lot_id,
  fl.site_id AS from_site_id,
  tl.site_id AS to_site_id,
  fl.custodian_user_id AS from_custodian_user_id,
  tl.custodian_user_id AS to_custodian_user_id,
  m.quantity AS quantity_base,
  m.value_xaf
FROM inventory_stock_moves m
JOIN organization_locations fl ON fl.id = m.from_location_id
JOIN organization_locations tl ON tl.id = m.to_location_id
LEFT JOIN catalog_reason_codes rc ON rc.id = m.reason_code_id;

-- Soldes de stock : jeu d'état, lu à l'instant de la lecture. Comme `GET /stock` : le disponible exclut le
-- réservé, et l'alloué sauf sur un emplacement à garde exclusive (`availableQty`) ; la valeur est le solde
-- multiplié par le coût unitaire moyen courant arrondi au franc, arrondie au franc (BR-STK-054,
-- `stockValueXaf`) — pas la valeur du registre (AV-487). Le lot de stock est vide pour un produit sans suivi par
-- lot (clé nulle de la table source). Les emplacements virtuels qui ne sont que la source ou le puits d'un
-- mouvement (fournisseur, client, perte, production, consommation, ajustement, ouverture) n'ont pas de stock et
-- n'entrent pas ; restent les emplacements physiques, le transit, les pertes en attente de validation et les
-- marchandises vendues à livrer, que `location_type` distingue (KPI-STK-02 les annonce à part, AV-256). L'alloué
-- reste nul dans la projection (ADR-033 §3) : les quotas d'appareil se lisent dans le tableau de distribution.
CREATE ALGORITHM = TEMPTABLE SQL SECURITY INVOKER VIEW analytics_f_stock_balance AS
SELECT
  b.location_id,
  b.product_id,
  CASE WHEN b.lot_key <> UNHEX('00000000000000000000000000000000') THEN b.lot_key END AS stock_lot_id,
  p.stock_family AS family,
  l.location_type,
  l.site_id,
  l.custodian_user_id,
  b.qty_on_hand AS balance_base,
  b.qty_allocated AS allocated_base,
  CASE WHEN l.custody_mode IN ('EXCLUSIVE_USER', 'EXCLUSIVE_DEVICE')
       THEN b.qty_on_hand - b.qty_reserved
       ELSE b.qty_on_hand - b.qty_reserved - b.qty_allocated
  END AS available_base,
  ROUND(b.qty_on_hand * FLOOR(COALESCE(v.avg_unit_cost_xaf, 0) + 0.5), 0) AS value_xaf
FROM inventory_stock_balances b
JOIN organization_locations l ON l.id = b.location_id
JOIN catalog_products p ON p.id = b.product_id
LEFT JOIN inventory_product_valuations v ON v.product_id = b.product_id
WHERE l.is_virtual = 0 OR l.location_type IN ('V_TRANSIT', 'V_PENDING_LOSS', 'V_TO_DELIVER');

-- Pertes déclarées : déclarations non annulées, avec leur statut. Comme `lossValueSummary`, la quantité et la
-- valeur (coût figé de la déclaration) ne comptent que les pertes constatées (enregistrée, approuvée, non
-- justifiée, en cours d'annulation) ; celles en attente de validation sont dans les colonnes `pending_*` ; une
-- déclaration rejetée et rendue n'est pas une perte (lignes lisibles par le statut, mesures vides).
CREATE ALGORITHM = TEMPTABLE SQL SECURITY INVOKER VIEW analytics_f_losses AS
SELECT
  d.business_date AS business_day,
  d.id AS loss_id,
  d.category,
  rc.code AS reason_code,
  d.product_id,
  d.lot_id AS stock_lot_id,
  d.production_lot_id,
  d.location_id,
  d.declared_by,
  d.status,
  d.site_id,
  CASE WHEN d.status IN ('RECORDED', 'APPROVED', 'REJECTED_UNJUSTIFIED', 'CANCELLATION_PENDING')
       THEN d.quantity_base END AS quantity_base,
  CASE WHEN d.status IN ('RECORDED', 'APPROVED', 'REJECTED_UNJUSTIFIED', 'CANCELLATION_PENDING')
       THEN d.value_xaf END AS value_xaf,
  CASE WHEN d.status = 'PENDING_APPROVAL' THEN d.quantity_base END AS pending_quantity_base,
  CASE WHEN d.status = 'PENDING_APPROVAL' THEN d.value_xaf END AS pending_value_xaf
FROM inventory_loss_declarations d
LEFT JOIN catalog_reason_codes rc ON rc.id = d.reason_code_id
WHERE d.status <> 'CANCELLED';

-- Production du jour par lot : quatre sortes de faits, chacun avec son auteur, dans les colonnes des mesures
-- qu'il porte (les autres sont vides) — mortalité comptée (statuts du résumé du lot : enregistrée, validée,
-- non justifiée, en cours d'annulation), aliment consommé (consommations enregistrées), œufs collectés
-- (collectes enregistrées, jour de la collecte) et pesées enregistrées (moyenne des pesées du jour). Le
-- bâtiment est l'emplacement principal du lot s'il en est un, sinon son parent.
CREATE ALGORITHM = TEMPTABLE SQL SECURITY INVOKER VIEW analytics_f_production_daily AS
SELECT
  d.business_date AS business_day,
  d.production_lot_id AS lot_id,
  pl.lot_type,
  pl.site_id,
  CASE WHEN ml.location_type = 'BUILDING' THEN ml.id ELSE ml.parent_location_id END AS building_id,
  d.declared_by AS recorded_by,
  d.quantity_base AS mortality_heads,
  NULL AS feed_quantity,
  NULL AS eggs_collected,
  NULL AS eggs_sellable,
  NULL AS average_weight_kg
FROM inventory_loss_declarations d
JOIN production_production_lots pl ON pl.id = d.production_lot_id
LEFT JOIN organization_locations ml ON ml.id = pl.main_location_id
WHERE d.category = 'MORTALITE'
  AND d.status IN ('RECORDED', 'APPROVED', 'REJECTED_UNJUSTIFIED', 'CANCELLATION_PENDING')
UNION ALL
SELECT
  CAST(CONVERT_TZ(c.occurred_at, '+00:00', '+01:00') AS DATE) AS business_day,
  c.cost_object_id AS lot_id,
  pl.lot_type,
  pl.site_id,
  CASE WHEN ml.location_type = 'BUILDING' THEN ml.id ELSE ml.parent_location_id END AS building_id,
  c.recorded_by,
  NULL AS mortality_heads,
  c.quantity_base AS feed_quantity,
  NULL AS eggs_collected,
  NULL AS eggs_sellable,
  NULL AS average_weight_kg
FROM inventory_consumptions c
JOIN production_production_lots pl ON pl.id = c.cost_object_id
LEFT JOIN organization_locations ml ON ml.id = pl.main_location_id
WHERE c.cost_object_type = 'PRODUCTION_LOT' AND c.cost_type = 'ALIMENT' AND c.status = 'RECORDED'
UNION ALL
SELECT
  e.collection_date AS business_day,
  e.production_lot_id AS lot_id,
  pl.lot_type,
  pl.site_id,
  CASE WHEN ml.location_type = 'BUILDING' THEN ml.id ELSE ml.parent_location_id END AS building_id,
  e.created_by AS recorded_by,
  NULL AS mortality_heads,
  NULL AS feed_quantity,
  e.collected_qty AS eggs_collected,
  e.marketable_qty AS eggs_sellable,
  NULL AS average_weight_kg
FROM production_egg_collections e
JOIN production_production_lots pl ON pl.id = e.production_lot_id
LEFT JOIN organization_locations ml ON ml.id = pl.main_location_id
WHERE e.status = 'RECORDED'
UNION ALL
SELECT
  CAST(CONVERT_TZ(w.occurred_at, '+00:00', '+01:00') AS DATE) AS business_day,
  w.production_lot_id AS lot_id,
  pl.lot_type,
  pl.site_id,
  CASE WHEN ml.location_type = 'BUILDING' THEN ml.id ELSE ml.parent_location_id END AS building_id,
  w.created_by AS recorded_by,
  NULL AS mortality_heads,
  NULL AS feed_quantity,
  NULL AS eggs_collected,
  NULL AS eggs_sellable,
  w.avg_weight_g / 1000 AS average_weight_kg
FROM production_lot_weighings w
JOIN production_production_lots pl ON pl.id = w.production_lot_id
LEFT JOIN organization_locations ml ON ml.id = pl.main_location_id
WHERE w.status = 'RECORDED';

-- Écritures de coût : montant signé (débit positif, crédit négatif) ; le site se déduit de l'objet de coût
-- (le site lui-même, le site du lot de production ou celui du lot d'incubation). Tout le jeu est une valeur
-- au coût (mesure protégée).
CREATE ALGORITHM = TEMPTABLE SQL SECURITY INVOKER VIEW analytics_f_costs AS
SELECT
  CAST(CONVERT_TZ(e.occurred_at, '+00:00', '+01:00') AS DATE) AS business_day,
  e.id AS entry_id,
  e.cost_object_type,
  e.cost_object_id,
  e.cost_type,
  CASE e.cost_object_type
    WHEN 'SITE' THEN e.cost_object_id
    WHEN 'PRODUCTION_LOT' THEN pl.site_id
    WHEN 'INCUBATION_BATCH' THEN ib.site_id
  END AS site_id,
  e.created_by,
  CASE WHEN e.direction = 'DEBIT' THEN e.amount_xaf ELSE -e.amount_xaf END AS amount_xaf
FROM inventory_cost_entries e
LEFT JOIN production_production_lots pl
  ON e.cost_object_type = 'PRODUCTION_LOT' AND pl.id = e.cost_object_id
LEFT JOIN production_incubation_batches ib
  ON e.cost_object_type = 'INCUBATION_BATCH' AND ib.id = e.cost_object_id;

GRANT SELECT ON analytics_f_stock_moves TO 'gic_app'@'%';
GRANT SELECT ON analytics_f_stock_balance TO 'gic_app'@'%';
GRANT SELECT ON analytics_f_losses TO 'gic_app'@'%';
GRANT SELECT ON analytics_f_production_daily TO 'gic_app'@'%';
GRANT SELECT ON analytics_f_costs TO 'gic_app'@'%';

-- migrate:down transaction:false
DROP VIEW IF EXISTS analytics_f_costs;
DROP VIEW IF EXISTS analytics_f_production_daily;
DROP VIEW IF EXISTS analytics_f_losses;
DROP VIEW IF EXISTS analytics_f_stock_balance;
DROP VIEW IF EXISTS analytics_f_stock_moves;
