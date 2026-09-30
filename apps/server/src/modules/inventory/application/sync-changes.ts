/**
 * Lignes de flux de changements émises par `inventory` (P2-06 ; 01-architecture-offline.md
 * §3.1 : jeux `stock`, `transfers`, `counts`, tous filtrés par `LOCATION`). Les types d'entité
 * sont les clés des projections de `sync/entity-projections.ts` (même chaîne des deux côtés,
 * comme `PRODUCT`/`PRICE_RULE` en P1-06).
 *
 * Un emplacement virtuel (`V_TRANSIT`, `V_LOSS`…) n'est jamais un périmètre d'appareil : aucun
 * solde virtuel n'est émis (`recordStockMove` filtre avant d'appeler `stockBalanceChange`).
 *
 * Jeu `production` (P7-12 ; §3.1 : « saisies des 30 derniers jours », filtre `SITE`) : les pertes
 * (dont la mortalité) et les consommations imputées à un lot de production sont des documents
 * d'inventaire ; inventory, propriétaire de leurs tables, émet leurs changements vers la ferme du
 * lot, à la saisie comme à chaque changement de statut (décision, retrait, annulation).
 */
import { recordChanges, type ChangeFeedEntry } from '../../../platform/sync/change-feed.js';
import type { UnitOfWork } from '../../../platform/unit-of-work.js';
import { fromBin, toBin } from '../../../platform/kysely/uuid-columns.js';

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

export const PRODUCTION_DATASET = 'production';

/** Perte d'un lot de production (mortalité ou autre catégorie) : `LOT_LOSS`, site de la perte. */
export async function emitLotLossChange(uow: UnitOfWork, lossId: string): Promise<void> {
  const row = await uow
    .selectFrom('inventory_loss_declarations')
    .select(['site_id', 'production_lot_id', 'version'])
    .where('id', '=', toBin(lossId))
    .executeTakeFirst();
  if (!row || row.production_lot_id === null) return;
  await recordChanges(uow, [
    {
      dataset: PRODUCTION_DATASET,
      entityType: 'LOT_LOSS',
      entityId: lossId,
      scopeType: 'SITE',
      scopeId: fromBin(row.site_id),
      rowVersion: row.version,
    },
  ]);
}

/** Consommation imputée à un lot de production : `LOT_CONSUMPTION`, site de l'emplacement. */
export async function emitLotConsumptionChange(
  uow: UnitOfWork,
  consumptionId: string,
): Promise<void> {
  const row = await uow
    .selectFrom('inventory_consumptions as c')
    .innerJoin('organization_locations as l', 'l.id', 'c.location_id')
    .select([
      'l.site_id as site_id',
      'c.cost_object_type as cost_object_type',
      'c.version as version',
    ])
    .where('c.id', '=', toBin(consumptionId))
    .executeTakeFirst();
  if (!row || row.cost_object_type !== 'PRODUCTION_LOT' || row.site_id === null) return;
  await recordChanges(uow, [
    {
      dataset: PRODUCTION_DATASET,
      entityType: 'LOT_CONSUMPTION',
      entityId: consumptionId,
      scopeType: 'SITE',
      scopeId: fromBin(row.site_id),
      rowVersion: row.version,
    },
  ]);
}
