/**
 * Anomalies de stock encore présentes (P5-17, AV-190) : une clôture manuelle d'un conflit
 * `ALLOCATION_OVERCOMMITTED` ou `STOCK_NEGATIVE` (`sync.conflict.resolve` / `.dismiss`) est refusée tant
 * que la condition qui l'a ouvert persiste — ces écarts ne sont « jamais corrigés en silence » (matrice
 * des conflits ; BR-STK-018) : la sortie passe par l'inventaire, la révocation ou la libération des
 * quotas, après quoi la clôture devient possible. Lectures verrouillantes, dans l'ordre d'`inventory`
 * (soldes, puis quotas).
 */
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { activeRemainingMilli, stockOnHandMilli } from '../allocation-ledger.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';

/** Σ des restes des quotas actifs du couple (emplacement, produit) au-delà de son solde physique. */
export async function isAllocationOvercommitted(
  uow: UnitOfWork,
  locationId: string,
  productId: string,
): Promise<boolean> {
  const onHand = await stockOnHandMilli(uow, locationId, productId, { lock: true });
  const promised = await activeRemainingMilli(uow, locationId, productId, { lock: true });
  return promised > 0 && onHand < promised;
}

/** Un solde (tous lots) du couple (emplacement, produit) est-il encore négatif ? */
export async function hasNegativeStock(
  uow: UnitOfWork,
  locationId: string,
  productId: string,
): Promise<boolean> {
  const negative = await uow
    .selectFrom('inventory_stock_balances')
    .select('lot_key')
    .where('location_id', '=', toBin(locationId))
    .where('product_id', '=', toBin(productId))
    .where('qty_on_hand', '<', '0')
    .orderBy('lot_key', 'asc')
    .forUpdate()
    .executeTakeFirst();
  return negative !== undefined;
}
