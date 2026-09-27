/**
 * Couverture des demandes d'achat par les bons de commande (BR-APP-004 ; SM-PURCHASE-REQUEST :
 * « création d'un BC référençant les lignes → PARTIALLY_ORDERED / ORDERED ») : la quantité
 * commandée des lignes de DA suit les lignes de BC qui les référencent ; l'annulation d'un BC la
 * rétablit. Le statut de la DA est recalculé par `requestStatusFromLines` (packages/domain).
 */
import { sql } from 'kysely';
import { quantityFromDecimal, requestStatusFromLines } from '@gic/domain';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { emitPurchaseRequestChange } from '../sync-changes.js';
import { rejected, type Uow } from './shared.js';
import type { CommandHandlerOutcome } from '../../../../platform/sync/command-handler-registry.js';

const ORDERABLE = ['APPROVED', 'PARTIALLY_ORDERED'];

/** Réserve `quantityBase` sur une ligne de DA pour une ligne de BC (même produit, reste suffisant). */
export async function reserveRequestLine(
  uow: Uow,
  input: {
    readonly requestLineId: string;
    readonly productId: string;
    readonly quantityBase: number;
  },
): Promise<{ readonly requestId: string } | { readonly rejected: CommandHandlerOutcome }> {
  const line = await uow
    .selectFrom('procurement_purchase_request_lines as l')
    .innerJoin('procurement_purchase_requests as r', 'r.id', 'l.request_id')
    .select([
      'l.id',
      'l.request_id',
      'l.product_id',
      'l.quantity_base',
      'l.ordered_qty_base',
      'r.status',
    ])
    .where('l.id', '=', toBin(input.requestLineId))
    .forUpdate()
    .executeTakeFirst();
  if (!line)
    return { rejected: rejected('REQUEST_LINE_MISMATCH', "Ligne de demande d'achat introuvable.") };
  if (!ORDERABLE.includes(line.status)) {
    return {
      rejected: rejected(
        'REQUEST_NOT_ORDERABLE',
        "La demande d'achat doit être approuvée (ou partiellement commandée) pour être commandée.",
      ),
    };
  }
  if (fromBin(line.product_id) !== input.productId) {
    return {
      rejected: rejected('REQUEST_LINE_MISMATCH', 'Produit différent de la ligne de demande.'),
    };
  }
  // Millièmes entiers (ADR-013) : aucune comparaison en virgule flottante.
  const milli = (value: number) => Math.round(value * 1000);
  const remainingMilli = milli(Number(line.quantity_base)) - milli(Number(line.ordered_qty_base));
  const remaining = remainingMilli / 1000;
  if (milli(input.quantityBase) > remainingMilli) {
    return {
      rejected: rejected(
        'REQUEST_QTY_EXCEEDED',
        `Quantité commandée supérieure au reste à commander de la demande (${remaining}).`,
      ),
    };
  }
  await adjustRequestLine(uow, line.id, input.quantityBase);
  return { requestId: fromBin(line.request_id) };
}

/** Ajoute `deltaBase` (positif ou négatif) à la quantité commandée d'une ligne de DA. */
export async function adjustRequestLine(
  uow: Uow,
  requestLineId: Buffer,
  deltaBase: number,
): Promise<void> {
  await uow
    .updateTable('procurement_purchase_request_lines')
    .set({ ordered_qty_base: sql`GREATEST(0, ordered_qty_base + ${String(deltaBase)})` })
    .where('id', '=', requestLineId)
    .execute();
}

/** Recalcule le statut des DA touchées (APPROVED ↔ PARTIALLY_ORDERED ↔ ORDERED). */
export async function refreshRequestStatuses(
  uow: Uow,
  requestIds: Iterable<string>,
  updatedBy: string,
): Promise<void> {
  for (const requestId of new Set(requestIds)) {
    const request = await uow
      .selectFrom('procurement_purchase_requests')
      .select(['id', 'status'])
      .where('id', '=', toBin(requestId))
      .forUpdate()
      .executeTakeFirst();
    if (!request || !['APPROVED', 'PARTIALLY_ORDERED', 'ORDERED'].includes(request.status))
      continue;
    const lines = await uow
      .selectFrom('procurement_purchase_request_lines')
      .select(['quantity_base', 'ordered_qty_base'])
      .where('request_id', '=', request.id)
      .execute();
    const status = requestStatusFromLines(
      lines.map((line) => ({
        requested: quantityFromDecimal(Number(line.quantity_base)),
        ordered: quantityFromDecimal(Number(line.ordered_qty_base)),
      })),
    );
    if (status === request.status) continue;
    await uow
      .updateTable('procurement_purchase_requests')
      .set({ status, updated_by: toBin(updatedBy), version: sql`version + 1` })
      .where('id', '=', request.id)
      .execute();
    await emitPurchaseRequestChange(uow, requestId);
  }
}
