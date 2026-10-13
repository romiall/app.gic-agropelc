/**
 * Lignes de flux de changements émises par `identity` (P5-23, AV-195 (3)). La fiche d'un appareil (statut,
 * appareil partagé, site de rattachement — `identity.device.designate`, BR-DIS-003) n'était publiée que par
 * le repli générique du pipeline (une ligne `GLOBAL`, servie à **tous** les appareils, sans `is_shared` ni
 * `designated_site_id`). Elle l'est désormais à l'appareil lui-même (portée `DEVICE`, toujours dans son
 * périmètre, `device-scope.ts`) ; la projection `DEVICE` ignore la ligne `GLOBAL` du repli.
 */
import type { UnitOfWork } from '../../../platform/unit-of-work.js';
import { recordChanges } from '../../../platform/sync/change-feed.js';
import { toBin } from '../../../platform/kysely/uuid-columns.js';

export const DEVICE_DATASET_NAME = 'device';

export async function emitDeviceChange(uow: UnitOfWork, deviceId: string): Promise<void> {
  const row = await uow
    .selectFrom('identity_devices')
    .select('version')
    .where('id', '=', toBin(deviceId))
    .executeTakeFirst();
  if (!row) return;
  await recordChanges(uow, [
    {
      dataset: DEVICE_DATASET_NAME,
      entityType: 'DEVICE',
      entityId: deviceId,
      scopeType: 'DEVICE',
      scopeId: deviceId,
      rowVersion: row.version,
    },
  ]);
}
