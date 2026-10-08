/**
 * Clôture des conflits `STOCK_NEGATIVE` par un inventaire (P5-10 ; INV-STK-05, AT-049, C-08) : un fait
 * hors ligne qui a rendu un solde négatif est appliqué et ouvre un conflit informatif ; le solde
 * négatif est « une anomalie à résoudre, jamais un état normal » (BR-STK-018). L'inventaire de
 * l'emplacement la résout : dès que l'ajustement a rendu tous les soldes du produit à l'emplacement
 * positifs ou nuls, les conflits ouverts de ce couple sont clos, avec la référence de l'inventaire.
 */
import type { Transaction } from 'kysely';
import type { DB } from '../../../platform/kysely/database.js';
import { resolveOpenConflictsByDetails } from '../../../platform/sync/conflicts.js';
import { toBin } from '../../../platform/kysely/uuid-columns.js';

/** Renvoie le nombre de conflits clos (0 tant qu'un solde du couple reste négatif). */
export async function closeStockNegativeConflicts(
  uow: Transaction<DB>,
  input: {
    readonly locationId: string;
    readonly productId: string;
    readonly resolvedBy: string;
    readonly resolvedAt: Date;
    readonly countId: string;
  },
): Promise<number> {
  const negative = await uow
    .selectFrom('inventory_stock_balances')
    .select('lot_key')
    .where('location_id', '=', toBin(input.locationId))
    .where('product_id', '=', toBin(input.productId))
    .where('qty_on_hand', '<', '0')
    .executeTakeFirst();
  if (negative) return 0;
  return resolveOpenConflictsByDetails(uow, {
    conflictType: 'STOCK_NEGATIVE',
    details: { locationId: input.locationId, productId: input.productId },
    resolution: 'COMPENSATE',
    resolvedBy: input.resolvedBy,
    resolvedAt: input.resolvedAt,
    comment: 'Solde négatif régularisé par l’inventaire.',
    refs: [input.countId],
  });
}
