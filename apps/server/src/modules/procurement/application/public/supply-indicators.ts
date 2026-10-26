/**
 * Indicateurs d'approvisionnement sans fonction publique avant P9 (P9-15 ; KPI-APP-01 et 02, ADR-075 §1,
 * AV-493) :
 * - **Taux de service fournisseur** : quantités acceptées ÷ quantités commandées de la période. Le commandé est
 *   celui des lignes non annulées des bons engagés (ni brouillon, ni en attente d'approbation, ni annulés), au
 *   jour de l'approbation du bon ; l'accepté, celui des lignes des réceptions comptabilisées (livré moins rejeté),
 *   au jour de la réception — comme la vue `analytics_f_purchases` ;
 * - **Taux de rejet** : quantités rejetées ÷ quantités livrées des réceptions comptabilisées de la période.
 *
 * Périmètre (`ReadScope`) : le site du bon ou de la réception ; les lectures des achats ne jugent que le site
 * (pas de portée par personne) : un périmètre de personnes ne lit rien.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { num, ratio, type DayWindow } from '../../../../platform/indicator-window.js';
import { scopeSql, type ReadScope } from '../../../../platform/read-scope.js';

type Executor = Kysely<DB> | Transaction<DB>;

/** Statuts de réception dont les quantités comptent au bon (`purchaseOrderMatching`). */
const COUNTED_RECEIPT_STATUSES = ['POSTED', 'POSTED_PENDING_REVIEW', 'REVIEW_REJECTED', 'CANCELLATION_PENDING'] as const;
const receiptStatuses = sql.join(COUNTED_RECEIPT_STATUSES.map((status) => sql`${status}`));

/** Les achats ne se jugent que par le site : un périmètre de personnes est un périmètre vide. */
const siteScope = (scope: ReadScope): ReadScope =>
  scope.userIds === undefined ? scope : { ...scope, userIds: [] };

export interface SupplierServiceRate {
  readonly orderedQuantity: number;
  readonly acceptedQuantity: number;
  readonly rate: number | null;
}

export interface ReceiptRejectRate {
  readonly deliveredQuantity: number;
  readonly rejectedQuantity: number;
  readonly rate: number | null;
}

export async function supplierServiceRate(
  executor: Executor,
  scope: ReadScope,
  window: DayWindow,
): Promise<SupplierServiceRate> {
  const restricted = siteScope(scope);
  const ordered = await sql<{ qty: unknown }>`
    SELECT COALESCE(SUM(pol.ordered_qty_base), 0) AS qty
      FROM procurement_purchase_order_lines pol
      JOIN procurement_purchase_orders po ON po.id = pol.order_id
     WHERE po.status NOT IN ('DRAFT', 'PENDING_APPROVAL', 'CANCELLED') AND pol.status <> 'CANCELLED'
       AND CAST(CONVERT_TZ(COALESCE(po.approved_at, po.occurred_at), '+00:00', '+01:00') AS DATE)
           BETWEEN ${window.fromDay} AND ${window.toDay}
       AND ${scopeSql(restricted, { site: 'po.site_id', users: [] })}
  `.execute(executor);
  const accepted = await sql<{ qty: unknown }>`
    SELECT COALESCE(SUM(rl.qty_delivered_base - rl.qty_rejected_base), 0) AS qty
      FROM procurement_goods_receipt_lines rl
      JOIN procurement_goods_receipts r ON r.id = rl.receipt_id
     WHERE r.status IN (${receiptStatuses})
       AND CAST(CONVERT_TZ(r.occurred_at, '+00:00', '+01:00') AS DATE)
           BETWEEN ${window.fromDay} AND ${window.toDay}
       AND ${scopeSql(restricted, { site: 'r.site_id', users: [] })}
  `.execute(executor);
  const orderedQuantity = num(ordered.rows[0]?.qty);
  const acceptedQuantity = num(accepted.rows[0]?.qty);
  return { orderedQuantity, acceptedQuantity, rate: ratio(acceptedQuantity, orderedQuantity) };
}

export async function receiptRejectRate(
  executor: Executor,
  scope: ReadScope,
  window: DayWindow,
): Promise<ReceiptRejectRate> {
  const { rows } = await sql<{ delivered: unknown; rejected: unknown }>`
    SELECT COALESCE(SUM(rl.qty_delivered_base), 0) AS delivered,
           COALESCE(SUM(rl.qty_rejected_base), 0) AS rejected
      FROM procurement_goods_receipt_lines rl
      JOIN procurement_goods_receipts r ON r.id = rl.receipt_id
     WHERE r.status IN (${receiptStatuses})
       AND CAST(CONVERT_TZ(r.occurred_at, '+00:00', '+01:00') AS DATE)
           BETWEEN ${window.fromDay} AND ${window.toDay}
       AND ${scopeSql(siteScope(scope), { site: 'r.site_id', users: [] })}
  `.execute(executor);
  const deliveredQuantity = num(rows[0]?.delivered);
  const rejectedQuantity = num(rows[0]?.rejected);
  return { deliveredQuantity, rejectedQuantity, rate: ratio(rejectedQuantity, deliveredQuantity) };
}
