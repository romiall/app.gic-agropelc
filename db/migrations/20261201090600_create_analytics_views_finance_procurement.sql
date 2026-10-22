-- Module `analytics` (P9-13) : jeux de faits de finance et d'achats de la couche sémantique — dépenses,
-- mouvements de trésorerie, achats (commandes et réceptions).
-- Source : docs/decisions/ADR-074 (§2, §7) ; ADR-075 ; D11 §7 et §8 ; BR-ANA-002, BR-ANA-004, BR-ANA-009.
-- Mêmes principes que `20261201090400` : lecture seule (`SQL SECURITY INVOKER`), `business_day` alias de la
-- colonne générée de la table source quand elle existe, portée dérivée dans la vue, documents annulés exclus.
-- migrate:up transaction:false

-- Dépenses (KPI-FIN-04) : toutes les dépenses vivantes, avec leur statut — ni annulées, ni refusées avant
-- paiement. Comme `expensesSummary`, `amount_xaf` ne compte que les dépenses valides (RECORDED, APPROVED, PAID) ;
-- celles en attente de validation (PENDING_APPROVAL, PAID_PENDING_APPROVAL) sont dans `pending_xaf`, celles
-- payées puis refusées (PAID_REJECTED, non justifiées) dans `unjustified_xaf`.
CREATE ALGORITHM = TEMPTABLE SQL SECURITY INVOKER VIEW analytics_f_expenses AS
SELECT
  e.business_date AS business_day,
  e.id AS expense_id,
  e.category_id,
  e.cost_object_type,
  e.site_id,
  e.status,
  e.created_by,
  CASE WHEN e.status IN ('RECORDED', 'APPROVED', 'PAID') THEN e.amount_xaf END AS amount_xaf,
  CASE WHEN e.status IN ('PENDING_APPROVAL', 'PAID_PENDING_APPROVAL') THEN e.amount_xaf END AS pending_xaf,
  CASE WHEN e.status = 'PAID_REJECTED' THEN e.amount_xaf END AS unjustified_xaf
FROM finance_expenses e
WHERE e.status NOT IN ('CANCELLED', 'REJECTED');

-- Mouvements de trésorerie : une ligne par mouvement ; une contre-écriture est un mouvement de sens inverse.
-- Le site se déduit du compte (un compte central n'en a pas) ; la personne est le titulaire du compte, à défaut
-- son responsable, comme la lecture du module `finance`.
CREATE ALGORITHM = TEMPTABLE SQL SECURITY INVOKER VIEW analytics_f_cash AS
SELECT
  m.business_date AS business_day,
  m.id AS movement_id,
  m.cash_account_id,
  m.movement_type,
  a.site_id,
  COALESCE(a.holder_user_id, a.responsible_user_id) AS holder_user_id,
  CASE WHEN m.direction = 'IN' THEN m.amount_xaf ELSE 0 END AS inflow_xaf,
  CASE WHEN m.direction = 'OUT' THEN m.amount_xaf ELSE 0 END AS outflow_xaf
FROM finance_cash_movements m
JOIN finance_cash_accounts a ON a.id = m.cash_account_id;

-- Achats : deux sortes de faits dans les colonnes des mesures qu'ils portent. Les lignes non annulées des bons de
-- commande engagés (ni brouillon, ni en attente d'approbation, ni annulés), au jour du bon : quantité commandée
-- et montant commandé (le total du bon exclut une ligne annulée). Les lignes des
-- réceptions comptabilisées (statuts dont les quantités comptent au bon, `purchaseOrderMatching`), au jour de
-- la réception : livré, rejeté et accepté (livré moins rejeté). Le site est celui du bon ou de la réception,
-- l'auteur celui du document.
CREATE ALGORITHM = TEMPTABLE SQL SECURITY INVOKER VIEW analytics_f_purchases AS
SELECT
  CAST(CONVERT_TZ(po.occurred_at, '+00:00', '+01:00') AS DATE) AS business_day,
  po.id AS order_id,
  NULL AS receipt_id,
  po.supplier_id,
  pol.product_id,
  po.site_id,
  po.created_by,
  pol.ordered_qty_base AS ordered_quantity,
  NULL AS delivered_quantity,
  NULL AS rejected_quantity,
  NULL AS accepted_quantity,
  pol.line_total_xaf AS amount_xaf
FROM procurement_purchase_order_lines pol
JOIN procurement_purchase_orders po ON po.id = pol.order_id
WHERE po.status NOT IN ('DRAFT', 'PENDING_APPROVAL', 'CANCELLED') AND pol.status <> 'CANCELLED'
UNION ALL
SELECT
  CAST(CONVERT_TZ(r.occurred_at, '+00:00', '+01:00') AS DATE) AS business_day,
  r.purchase_order_id AS order_id,
  r.id AS receipt_id,
  r.supplier_id,
  rl.product_id,
  r.site_id,
  r.created_by,
  NULL AS ordered_quantity,
  rl.qty_delivered_base AS delivered_quantity,
  rl.qty_rejected_base AS rejected_quantity,
  rl.qty_delivered_base - rl.qty_rejected_base AS accepted_quantity,
  NULL AS amount_xaf
FROM procurement_goods_receipt_lines rl
JOIN procurement_goods_receipts r ON r.id = rl.receipt_id
WHERE r.status IN ('POSTED', 'POSTED_PENDING_REVIEW', 'REVIEW_REJECTED', 'CANCELLATION_PENDING');

GRANT SELECT ON analytics_f_expenses TO 'gic_app'@'%';
GRANT SELECT ON analytics_f_cash TO 'gic_app'@'%';
GRANT SELECT ON analytics_f_purchases TO 'gic_app'@'%';

-- migrate:down transaction:false
DROP VIEW IF EXISTS analytics_f_purchases;
DROP VIEW IF EXISTS analytics_f_cash;
DROP VIEW IF EXISTS analytics_f_expenses;
