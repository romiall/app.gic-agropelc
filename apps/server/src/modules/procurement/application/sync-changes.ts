/**
 * Lignes de flux de changements émises par `procurement` (01-architecture-offline.md §3.1, jeu
 * `procurement` : « BC livrables sur le site, fournisseurs actifs (liste courte), DA de
 * l'utilisateur », filtres `SITE`, `USER`) :
 * - demande d'achat → son demandeur (`USER`) ;
 * - bon de commande → son site de livraison (`SITE`) tant qu'il est livrable (`SENT`,
 *   `PARTIALLY_RECEIVED`), `SCOPE_EXIT` ensuite (reçu, clôturé, annulé : l'appareil le retire) ;
 * - réception → son site (`SITE`, 30 jours) ;
 * - fournisseur → tous (`GLOBAL`, liste courte des actifs), `SCOPE_EXIT` à la désactivation.
 * Les projections (`sync/entity-projections.ts`) ne servent une ligne que dans ce périmètre.
 */
import { recordChanges } from '../../../platform/sync/change-feed.js';
import type { UnitOfWork } from '../../../platform/unit-of-work.js';
import { fromBin, toBin } from '../../../platform/kysely/uuid-columns.js';

export const PROCUREMENT_DATASET = 'procurement';

export async function emitPurchaseRequestChange(uow: UnitOfWork, requestId: string): Promise<void> {
  const row = await uow
    .selectFrom('procurement_purchase_requests')
    .select(['requested_by', 'version'])
    .where('id', '=', toBin(requestId))
    .executeTakeFirst();
  if (!row) return;
  await recordChanges(uow, [
    {
      dataset: PROCUREMENT_DATASET,
      entityType: 'PURCHASE_REQUEST',
      entityId: requestId,
      scopeType: 'USER',
      scopeId: fromBin(row.requested_by),
      rowVersion: row.version,
    },
  ]);
}

/** BC livrables hors ligne (D08 §12) : réceptionnables par le magasinier du site. */
export const DELIVERABLE_ORDER_STATUSES: readonly string[] = ['SENT', 'PARTIALLY_RECEIVED'];

export async function emitPurchaseOrderChange(uow: UnitOfWork, orderId: string): Promise<void> {
  const row = await uow
    .selectFrom('procurement_purchase_orders')
    .select(['site_id', 'status', 'version'])
    .where('id', '=', toBin(orderId))
    .executeTakeFirst();
  if (!row) return;
  await recordChanges(uow, [
    {
      dataset: PROCUREMENT_DATASET,
      entityType: 'PURCHASE_ORDER',
      entityId: orderId,
      scopeType: 'SITE',
      scopeId: fromBin(row.site_id),
      changeType: DELIVERABLE_ORDER_STATUSES.includes(row.status) ? 'UPSERT' : 'SCOPE_EXIT',
      rowVersion: row.version,
    },
  ]);
}

export async function emitSupplierChange(uow: UnitOfWork, supplierId: string): Promise<void> {
  const row = await uow
    .selectFrom('procurement_suppliers')
    .select(['status', 'version'])
    .where('id', '=', toBin(supplierId))
    .executeTakeFirst();
  if (!row) return;
  await recordChanges(uow, [
    {
      dataset: PROCUREMENT_DATASET,
      entityType: 'SUPPLIER',
      entityId: supplierId,
      scopeType: 'GLOBAL',
      scopeId: null,
      changeType: row.status === 'ACTIVE' ? 'UPSERT' : 'SCOPE_EXIT',
      rowVersion: row.version,
    },
  ]);
}

export async function emitGoodsReceiptChange(uow: UnitOfWork, receiptId: string): Promise<void> {
  const row = await uow
    .selectFrom('procurement_goods_receipts')
    .select(['site_id', 'version'])
    .where('id', '=', toBin(receiptId))
    .executeTakeFirst();
  if (!row) return;
  await recordChanges(uow, [
    {
      dataset: PROCUREMENT_DATASET,
      entityType: 'GOODS_RECEIPT',
      entityId: receiptId,
      scopeType: 'SITE',
      scopeId: fromBin(row.site_id),
      rowVersion: row.version,
    },
  ]);
}
