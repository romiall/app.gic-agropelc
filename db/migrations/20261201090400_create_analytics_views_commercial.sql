-- Module `analytics` (P9-13) : jeux de faits commerciaux de la couche sémantique — lignes de vente,
-- lignes de commande, encaissements, activité de prospection, présences.
-- Source : docs/decisions/ADR-064 (§2, §3) ; ADR-065 ; D11 §7 et §8 ; BR-ANA-002, BR-ANA-003, BR-ANA-009.
--
-- Principes communs à toutes les vues `analytics_f_*` :
-- - `SQL SECURITY INVOKER`, lecture seule : les droits sont ceux du lecteur sur les tables sources ;
--   aucune écriture dans une table d'autrui ;
-- - `business_day` est l'alias de la colonne de jour métier générée de la table source quand elle existe
--   (indexée avec le site), sinon `CAST(CONVERT_TZ(…, '+00:00', '+01:00') AS DATE)` (Africa/Douala, décalage
--   fixe, sans heure d'été) ;
-- - les colonnes de portée (site, zone, personnes) sont dérivées une fois dans la vue ; le compilateur de
--   l'explorateur n'en invente pas ;
-- - les documents annulés ne comptent pas, sauf quand l'annulation est elle-même un événement daté
--   (vente, encaissement) : elle y est une ligne négative à sa propre date.
-- migrate:up transaction:false

-- Lignes de vente (KPI-COM-07 à 10, 13 à 15) : une ligne de vente, ou une ligne d'annulation appliquée
-- (négative, à la date d'application), comme `saleActivityArms` (`sales/application/public/period-activity.ts`).
-- Deux dates : `business_day` (jour de l'événement) et `sale_day` (jour de la vente d'origine). La remise
-- n'est pas contre-passée par une annulation ; le coût d'une vente est celui figé à la vente sur la ligne
-- (`sales_sale_lines.cost_xaf`, somme des mouvements `SALE` de la ligne) et celui d'une annulation la somme des
-- retours `CUSTOMER_RETURN` de sa ligne. La portée par personne (`owner_user_id`) est celle de la lecture du
-- module `sales` (`GET /sales`) : le commercial, à défaut le vendeur.
CREATE ALGORITHM = TEMPTABLE SQL SECURITY INVOKER VIEW analytics_f_sales_line AS
SELECT
  s.business_date AS business_day,
  s.business_date AS sale_day,
  _utf8mb4'SALE' COLLATE utf8mb4_0900_as_cs AS event_kind,
  s.id AS sale_id,
  l.id AS line_id,
  CASE WHEN s.status <> 'CANCELLED' THEN s.id END AS counted_sale_id,
  l.product_id,
  p.category_id AS product_category_id,
  s.site_id,
  s.from_location_id AS pos_id,
  s.zone_id,
  s.channel_code AS channel,
  s.customer_id,
  s.customer_category_id_snapshot AS customer_category_id,
  s.commercial_user_id,
  s.seller_user_id,
  COALESCE(s.commercial_user_id, s.seller_user_id) AS owner_user_id,
  s.sale_type,
  s.payment_status,
  l.quantity_base,
  l.line_total_xaf AS amount_xaf,
  l.discount_xaf,
  COALESCE(l.cost_xaf, 0) AS cost_xaf,
  l.line_total_xaf - COALESCE(l.cost_xaf, 0) AS margin_xaf
FROM sales_sale_lines l
JOIN sales_sales s ON s.id = l.sale_id
JOIN catalog_products p ON p.id = l.product_id
UNION ALL
SELECT
  c.applied_business_date AS business_day,
  s.business_date AS sale_day,
  _utf8mb4'CANCELLATION' COLLATE utf8mb4_0900_as_cs AS event_kind,
  s.id AS sale_id,
  l.id AS line_id,
  NULL AS counted_sale_id,
  l.product_id,
  p.category_id AS product_category_id,
  s.site_id,
  s.from_location_id AS pos_id,
  s.zone_id,
  s.channel_code AS channel,
  s.customer_id,
  s.customer_category_id_snapshot AS customer_category_id,
  s.commercial_user_id,
  s.seller_user_id,
  COALESCE(s.commercial_user_id, s.seller_user_id) AS owner_user_id,
  s.sale_type,
  s.payment_status,
  -cl.quantity_base AS quantity_base,
  -cl.amount_xaf AS amount_xaf,
  0 AS discount_xaf,
  -COALESCE((
    SELECT SUM(r.value_xaf) FROM inventory_stock_moves r
     WHERE r.source_doc_type = 'SALE_CANCELLATION' AND r.source_doc_id = c.id
       AND r.source_line_id = cl.id AND r.move_type = 'CUSTOMER_RETURN'
  ), 0) AS cost_xaf,
  -cl.amount_xaf + COALESCE((
    SELECT SUM(r.value_xaf) FROM inventory_stock_moves r
     WHERE r.source_doc_type = 'SALE_CANCELLATION' AND r.source_doc_id = c.id
       AND r.source_line_id = cl.id AND r.move_type = 'CUSTOMER_RETURN'
  ), 0) AS margin_xaf
FROM sales_sale_cancellation_lines cl
JOIN sales_sale_cancellations c ON c.id = cl.cancellation_id AND c.status = 'APPLIED'
JOIN sales_sale_lines l ON l.id = cl.sale_line_id
JOIN sales_sales s ON s.id = l.sale_id
JOIN catalog_products p ON p.id = l.product_id;

-- Lignes de commande (KPI-COM-06 « confirmées dans P ») : commandes engagées (ni brouillon ni annulées), au jour
-- de leur confirmation (`occurred_at` est la création du brouillon, immuable ; repli sur lui sans confirmation).
-- La zone est celle du site, comme la lecture du module `sales` ; la portée par personne est le commercial.
-- `delivered_quantity` est le cumul livré à ce jour des commandes datées de la période, pas la livraison faite
-- pendant la période.
CREATE ALGORITHM = TEMPTABLE SQL SECURITY INVOKER VIEW analytics_f_orders AS
SELECT
  CAST(CONVERT_TZ(COALESCE(o.confirmed_at, o.occurred_at), '+00:00', '+01:00') AS DATE) AS business_day,
  o.id AS order_id,
  ol.id AS line_id,
  o.customer_id,
  o.commercial_user_id,
  o.channel_code AS channel,
  ol.product_id,
  o.status,
  o.site_id,
  st.zone_id,
  ol.quantity_base AS ordered_quantity,
  ol.delivered_quantity_base AS delivered_quantity,
  ol.line_total_xaf AS amount_xaf
FROM sales_sales_order_lines ol
JOIN sales_sales_orders o ON o.id = ol.order_id
JOIN organization_sites st ON st.id = o.site_id
WHERE o.status NOT IN ('DRAFT', 'CANCELLED');

-- Encaissements (KPI-FIN-01, KPI-DIS-06) : un encaissement confirmé à son jour métier (enregistré, en demande
-- d'annulation ou annulé depuis) et, s'il est annulé, une ligne négative à la date de l'annulation, comme
-- `cashedActivity` (`sales/application/public/period-activity.ts`). Les remboursements ne sont pas retranchés
-- (D11, AV-244). Portée : le site de l'encaissement et son receveur.
CREATE ALGORITHM = TEMPTABLE SQL SECURITY INVOKER VIEW analytics_f_payments AS
SELECT
  p.business_date AS business_day,
  _utf8mb4'PAYMENT' COLLATE utf8mb4_0900_as_cs AS event_kind,
  p.id AS payment_id,
  p.payment_method_code AS payment_method,
  p.cash_account_id,
  p.site_id,
  p.received_by_user_id,
  p.customer_id,
  p.amount_xaf
FROM sales_customer_payments p
WHERE p.status IN ('RECORDED', 'CANCELLATION_REQUESTED', 'CANCELLED')
UNION ALL
SELECT
  CAST(CONVERT_TZ(p.cancelled_at, '+00:00', '+01:00') AS DATE) AS business_day,
  _utf8mb4'CANCELLATION' COLLATE utf8mb4_0900_as_cs AS event_kind,
  p.id AS payment_id,
  p.payment_method_code AS payment_method,
  p.cash_account_id,
  p.site_id,
  p.received_by_user_id,
  p.customer_id,
  -p.amount_xaf AS amount_xaf
FROM sales_customer_payments p
WHERE p.status = 'CANCELLED' AND p.cancelled_at IS NOT NULL;

-- Activité commerciale (KPI-COM-01 à 05, 11, 12) : trois événements — compte créé (hors fusionné), visite
-- enregistrée, conversion (rattachée au titulaire à l'instant de la conversion) — comme `commercialEffort`
-- (`crm/application/public/activity-query.ts`). La zone est celle du compte ; un contact collecté est un compte
-- créé avec un téléphone. Les colonnes `*_id` des mesures ne sont renseignées que sur l'événement qui les porte.
-- La portée par personne est `user_id`, l'acteur de l'événement (acquéreur, auteur de la visite, titulaire à la
-- conversion), comme `commercialEffort` (BR-CRM-019) : une visite se lit par son auteur comme dans le module `crm`,
-- mais un compte ou une conversion se lit ici par l'acteur de l'événement, non par le titulaire courant que juge
-- `GET /customers` (AV-441). Une conversion sans titulaire reste comptée (`user_id` vide : visible des seules
-- portées sans restriction de personne) ; un compte fusionné n'est compté ni à la création ni à la conversion,
-- sa conversion étant reprise par le compte conservé (AV-442).
CREATE ALGORITHM = TEMPTABLE SQL SECURITY INVOKER VIEW analytics_f_prospecting AS
SELECT
  CAST(CONVERT_TZ(c.acquired_at, '+00:00', '+01:00') AS DATE) AS business_day,
  _utf8mb4'ACCOUNT' COLLATE utf8mb4_0900_as_cs AS event_kind,
  c.acquired_by_user_id AS user_id,
  c.zone_id,
  c.source_code AS source,
  c.stage,
  NULL AS result,
  c.id AS created_customer_id,
  CASE WHEN c.phone_primary IS NOT NULL AND c.phone_primary <> '' THEN c.id END AS contact_customer_id,
  NULL AS visited_prospect_id,
  NULL AS visit_id,
  NULL AS converted_customer_id
FROM crm_customers c
WHERE c.stage <> 'MERGED'
UNION ALL
SELECT
  CAST(CONVERT_TZ(v.occurred_at, '+00:00', '+01:00') AS DATE) AS business_day,
  _utf8mb4'VISIT' COLLATE utf8mb4_0900_as_cs AS event_kind,
  v.user_id,
  cu.zone_id,
  cu.source_code AS source,
  v.customer_stage_at_visit AS stage,
  rc.code AS result,
  NULL AS created_customer_id,
  NULL AS contact_customer_id,
  CASE WHEN v.customer_stage_at_visit = 'PROSPECT' THEN v.customer_id END AS visited_prospect_id,
  v.id AS visit_id,
  NULL AS converted_customer_id
FROM crm_visits v
JOIN crm_customers cu ON cu.id = v.customer_id
LEFT JOIN catalog_reason_codes rc ON rc.id = v.outcome_reason_code_id
WHERE v.status = 'RECORDED'
UNION ALL
SELECT
  CAST(CONVERT_TZ(c.converted_at, '+00:00', '+01:00') AS DATE) AS business_day,
  _utf8mb4'CONVERSION' COLLATE utf8mb4_0900_as_cs AS event_kind,
  a.user_id,
  c.zone_id,
  c.source_code AS source,
  c.stage,
  NULL AS result,
  NULL AS created_customer_id,
  NULL AS contact_customer_id,
  NULL AS visited_prospect_id,
  NULL AS visit_id,
  c.id AS converted_customer_id
FROM crm_customers c
LEFT JOIN crm_customer_assignments a
  ON a.customer_id = c.id AND a.valid_from <= c.converted_at
 AND (a.valid_to IS NULL OR a.valid_to > c.converted_at)
WHERE c.converted_at IS NOT NULL AND c.stage <> 'MERGED';

-- Présences (KPI-COM-17) : une ligne par session de travail, au jour de son début ; la session ne porte pas de
-- site mais la zone déclarée au pointage (portée par la zone et par la personne, comme la lecture du module
-- `fieldwork`). Un jour de présence est un jour distinct avec une session acceptée (sans dérogation exigée, ou
-- dérogation approuvée) ; les sessions et la durée comptent toutes les sessions, dérogations comprises (la
-- dimension `override` et le statut permettent de les écarter) ; la durée n'existe que pour une session terminée.
CREATE ALGORITHM = TEMPTABLE SQL SECURITY INVOKER VIEW analytics_f_attendance AS
SELECT
  CAST(CONVERT_TZ(w.started_at, '+00:00', '+01:00') AS DATE) AS business_day,
  w.id AS session_id,
  w.user_id,
  w.declared_zone_id AS zone_id,
  w.status,
  (w.override_status <> 'NOT_REQUIRED') AS override,
  CASE WHEN w.override_status IN ('NOT_REQUIRED', 'APPROVED')
       THEN CONCAT(HEX(w.user_id), '|', CAST(CONVERT_TZ(w.started_at, '+00:00', '+01:00') AS DATE))
  END AS accepted_day_key,
  1 AS session_count,
  CASE WHEN w.ended_at IS NOT NULL THEN TIMESTAMPDIFF(MINUTE, w.started_at, w.ended_at) END AS duration_minutes
FROM fieldwork_work_sessions w;

GRANT SELECT ON analytics_f_sales_line TO 'gic_app'@'%';
GRANT SELECT ON analytics_f_orders TO 'gic_app'@'%';
GRANT SELECT ON analytics_f_payments TO 'gic_app'@'%';
GRANT SELECT ON analytics_f_prospecting TO 'gic_app'@'%';
GRANT SELECT ON analytics_f_attendance TO 'gic_app'@'%';

-- migrate:down transaction:false
DROP VIEW IF EXISTS analytics_f_attendance;
DROP VIEW IF EXISTS analytics_f_prospecting;
DROP VIEW IF EXISTS analytics_f_payments;
DROP VIEW IF EXISTS analytics_f_orders;
DROP VIEW IF EXISTS analytics_f_sales_line;
