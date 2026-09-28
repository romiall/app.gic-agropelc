/**
 * Lignes de flux de changements émises par `production` (01-architecture-offline.md §3.1, jeu
 * `production` : lots actifs de la ferme, filtre `SITE`) : un lot planifié, actif ou en vente
 * est servi aux appareils de sa ferme ; clôturé ou annulé, il sort du périmètre
 * (`SCOPE_EXIT`). Les projections (`sync/entity-projections.ts`) arrivent avec le jeu hors
 * ligne (P7-12) : d'ici là, une ligne sans lecteur est ignorée au téléchargement.
 */
import { recordChanges } from '../../../platform/sync/change-feed.js';
import type { UnitOfWork } from '../../../platform/unit-of-work.js';
import { fromBin, toBin } from '../../../platform/kysely/uuid-columns.js';

export const PRODUCTION_DATASET = 'production';

/** Lots servis hors ligne (D07 §12 : « lots actifs du site »). */
export const OPEN_LOT_STATUSES: readonly string[] = ['PLANNED', 'ACTIVE', 'SELLING'];

export async function emitProductionLotChange(uow: UnitOfWork, lotId: string): Promise<void> {
  const row = await uow
    .selectFrom('production_production_lots')
    .select(['site_id', 'status', 'version'])
    .where('id', '=', toBin(lotId))
    .executeTakeFirst();
  if (!row) return;
  await recordChanges(uow, [
    {
      dataset: PRODUCTION_DATASET,
      entityType: 'PRODUCTION_LOT',
      entityId: lotId,
      scopeType: 'SITE',
      scopeId: fromBin(row.site_id),
      changeType: OPEN_LOT_STATUSES.includes(row.status) ? 'UPSERT' : 'SCOPE_EXIT',
      rowVersion: row.version,
    },
  ]);
}
