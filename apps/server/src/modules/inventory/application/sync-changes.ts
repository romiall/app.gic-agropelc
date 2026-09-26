/**
 * Lignes de flux de changements émises par `inventory` (P2-06 ; 01-architecture-offline.md
 * §3.1 : jeux `stock`, `transfers`, `counts`, tous filtrés par `LOCATION`). Les types d'entité
 * sont les clés des projections de `sync/entity-projections.ts` (même chaîne des deux côtés,
 * comme `PRODUCT`/`PRICE_RULE` en P1-06).
 *
 * Un emplacement virtuel (`V_TRANSIT`, `V_LOSS`…) n'est jamais un périmètre d'appareil : aucun
 * solde virtuel n'est émis (`recordStockMove` filtre avant d'appeler `stockBalanceChange`).
 */
import type { ChangeFeedEntry } from '../../../platform/sync/change-feed.js';

export const STOCK_DATASET = 'stock';
export const TRANSFERS_DATASET = 'transfers';
export const COUNTS_DATASET = 'counts';

/** Solde d'un produit dans un emplacement, tous lots confondus : l'entité est le produit, le
 * périmètre l'emplacement (la clé réelle de `stock_balances` est composite — `entity_id` ne
 * porte qu'un UUID, l'emplacement voyage donc dans `scope_id`). */
export function stockBalanceChange(locationId: string, productId: string): ChangeFeedEntry {
  return {
    dataset: STOCK_DATASET,
    entityType: 'STOCK_BALANCE',
    entityId: productId,
    scopeType: 'LOCATION',
    scopeId: locationId,
  };
}

export function stockThresholdChange(thresholdId: string, locationId: string): ChangeFeedEntry {
  return {
    dataset: STOCK_DATASET,
    entityType: 'STOCK_THRESHOLD',
    entityId: thresholdId,
    scopeType: 'LOCATION',
    scopeId: locationId,
  };
}

/** Un transfert concerne ses deux emplacements (« transferts entrants et sortants du
 * périmètre ») : une ligne par extrémité. */
export function transferChanges(
  transferId: string,
  fromLocationId: string,
  toLocationId: string,
): readonly ChangeFeedEntry[] {
  return [fromLocationId, toLocationId].map((locationId) => ({
    dataset: TRANSFERS_DATASET,
    entityType: 'STOCK_TRANSFER',
    entityId: transferId,
    scopeType: 'LOCATION' as const,
    scopeId: locationId,
  }));
}

export function inventoryCountChange(countId: string, locationId: string): ChangeFeedEntry {
  return {
    dataset: COUNTS_DATASET,
    entityType: 'INVENTORY_COUNT',
    entityId: countId,
    scopeType: 'LOCATION',
    scopeId: locationId,
  };
}
