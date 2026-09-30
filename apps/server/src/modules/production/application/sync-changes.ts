/**
 * Lignes de flux de changements émises par `production` (01-architecture-offline.md §3.1, jeu
 * `production` : « lots actifs du site, lots d'incubation en cours, saisies des 30 derniers
 * jours », filtre `SITE`) :
 * - un lot planifié, actif ou en vente est servi aux appareils de sa ferme ; clôturé ou annulé,
 *   il sort du périmètre (`SCOPE_EXIT`) ; de même un lot d'incubation en cours ;
 * - les saisies de la ferme (entrée de lot, pesée, observation, collecte, abattage) sont
 *   renvoyées à chaque changement (annulation comprise) ; la fenêtre de 30 jours est appliquée
 *   par les projections (`sync/entity-projections.ts`, P7-12), au téléchargement.
 * Les pertes et consommations d'un lot sont émises par `inventory`, propriétaire de leurs tables.
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

/** Lots d'incubation servis hors ligne (D07 §12 : « lots d'incubation en cours »). */
export const OPEN_INCUBATION_STATUSES: readonly string[] = ['INCUBATING', 'IN_HATCHER'];

export async function emitIncubationBatchChange(uow: UnitOfWork, batchId: string): Promise<void> {
  const row = await uow
    .selectFrom('production_incubation_batches')
    .select(['site_id', 'status', 'version'])
    .where('id', '=', toBin(batchId))
    .executeTakeFirst();
  if (!row) return;
  await recordChanges(uow, [
    {
      dataset: PRODUCTION_DATASET,
      entityType: 'INCUBATION_BATCH',
      entityId: batchId,
      scopeType: 'SITE',
      scopeId: fromBin(row.site_id),
      changeType: OPEN_INCUBATION_STATUSES.includes(row.status) ? 'UPSERT' : 'SCOPE_EXIT',
      rowVersion: row.version,
    },
  ]);
}

/** Saisies de la ferme servies 30 jours (dictionnaire 07-production : « DL (30 j) »). */
export type ProductionRecordType =
  'LOT_ENTRY' | 'LOT_WEIGHING' | 'LOT_OBSERVATION' | 'EGG_COLLECTION' | 'SLAUGHTER';

async function recordScope(
  uow: UnitOfWork,
  entityType: ProductionRecordType,
  id: Buffer,
): Promise<{ readonly siteId: Buffer; readonly version: number } | undefined> {
  const lotSite = (lotId: Buffer) =>
    uow
      .selectFrom('production_production_lots')
      .select('site_id')
      .where('id', '=', lotId)
      .executeTakeFirst();
  switch (entityType) {
    case 'LOT_ENTRY': {
      const row = await uow
        .selectFrom('production_lot_entries')
        .select(['production_lot_id', 'version'])
        .where('id', '=', id)
        .executeTakeFirst();
      const lot = row && (await lotSite(row.production_lot_id));
      return row && lot ? { siteId: lot.site_id, version: row.version } : undefined;
    }
    case 'LOT_WEIGHING': {
      const row = await uow
        .selectFrom('production_lot_weighings')
        .select(['production_lot_id', 'version'])
        .where('id', '=', id)
        .executeTakeFirst();
      const lot = row && (await lotSite(row.production_lot_id));
      return row && lot ? { siteId: lot.site_id, version: row.version } : undefined;
    }
    case 'LOT_OBSERVATION': {
      // Immuable : une seule version.
      const row = await uow
        .selectFrom('production_lot_observations')
        .select('production_lot_id')
        .where('id', '=', id)
        .executeTakeFirst();
      const lot = row && (await lotSite(row.production_lot_id));
      return lot ? { siteId: lot.site_id, version: 1 } : undefined;
    }
    case 'EGG_COLLECTION': {
      const row = await uow
        .selectFrom('production_egg_collections')
        .select(['site_id', 'version'])
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? { siteId: row.site_id, version: row.version } : undefined;
    }
    case 'SLAUGHTER': {
      const row = await uow
        .selectFrom('production_slaughter_batches')
        .select(['site_id', 'version'])
        .where('id', '=', id)
        .executeTakeFirst();
      return row ? { siteId: row.site_id, version: row.version } : undefined;
    }
  }
}

export async function emitProductionRecordChange(
  uow: UnitOfWork,
  entityType: ProductionRecordType,
  entityId: string,
): Promise<void> {
  const scope = await recordScope(uow, entityType, toBin(entityId));
  if (!scope) return;
  await recordChanges(uow, [
    {
      dataset: PRODUCTION_DATASET,
      entityType,
      entityId,
      scopeType: 'SITE',
      scopeId: fromBin(scope.siteId),
      rowVersion: scope.version,
    },
  ]);
}
