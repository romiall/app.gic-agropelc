/**
 * Lignes de flux de changements émises par `fieldwork` (P3-07) : jeu `fieldwork`, sessions de
 * travail de l'agent (`USER`). L'appareil ouvre et clôt ses sessions localement ; ce jeu lui
 * renvoie les décisions du serveur (recalcul défavorable et dérogation, remplacement, clôture de
 * 23:59, décision du responsable — D03 §12). DÉDUIT : jeu ajouté au catalogue
 * (01-architecture-offline.md §3.1), aucun jeu existant ne portant les sessions.
 */
import { recordChanges } from '../../../platform/sync/change-feed.js';
import type { UnitOfWork } from '../../../platform/unit-of-work.js';
import { fromBin, toBin } from '../../../platform/kysely/uuid-columns.js';

export const FIELDWORK_DATASET = 'fieldwork';

export async function emitWorkSessionChanges(
  uow: UnitOfWork,
  sessionIds: readonly Buffer[] | readonly string[],
): Promise<void> {
  const ids = sessionIds.map((id) => (typeof id === 'string' ? toBin(id) : id));
  if (ids.length === 0) return;
  const rows = await uow
    .selectFrom('fieldwork_work_sessions')
    .select(['id', 'user_id', 'version'])
    .where('id', 'in', ids)
    .execute();
  await recordChanges(
    uow,
    rows.map((row) => ({
      dataset: FIELDWORK_DATASET,
      entityType: 'WORK_SESSION',
      entityId: fromBin(row.id),
      scopeType: 'USER' as const,
      scopeId: fromBin(row.user_id),
      rowVersion: row.version,
    })),
  );
}

export const PRESENCE_DATASET = 'presence';

/**
 * Jeu `presence` (AV-514 (4)) : feuilles de présence du personnel, ligne `SITE` du site de la feuille. Elle va aux appareils
 * dont l'utilisateur lit la présence sur ce site (`fieldwork.presence.read`, `sync/device-scope.ts`) et leur permet de
 * relire l'historique sans réseau. L'annulation d'une feuille change sa version : la ligne est réémise.
 */
export async function emitPresenceSheetChange(
  uow: UnitOfWork,
  sheetId: Buffer | string,
): Promise<void> {
  const row = await uow
    .selectFrom('fieldwork_presence_sheets')
    .select(['id', 'site_id', 'version'])
    .where('id', '=', typeof sheetId === 'string' ? toBin(sheetId) : sheetId)
    .executeTakeFirst();
  if (!row) return;
  await recordChanges(uow, [
    {
      dataset: PRESENCE_DATASET,
      entityType: 'PRESENCE_SHEET',
      entityId: fromBin(row.id),
      scopeType: 'SITE',
      scopeId: fromBin(row.site_id),
      rowVersion: row.version,
    },
  ]);
}
