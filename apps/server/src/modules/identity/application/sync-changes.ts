/**
 * Lignes de flux de changements émises par `identity` (P5-23, AV-195 (3)). La fiche d'un appareil (statut,
 * appareil partagé, site de rattachement — `identity.device.designate`, BR-DIS-003) n'était publiée que par
 * le repli générique du pipeline (une ligne `GLOBAL`, servie à **tous** les appareils, sans `is_shared` ni
 * `designated_site_id`). Elle l'est désormais à l'appareil lui-même (portée `DEVICE`, toujours dans son
 * périmètre, `device-scope.ts`) ; la projection `DEVICE` ignore la ligne `GLOBAL` du repli.
 *
 * Même principe pour les affectations de rôle (ADR-071) : publiées à leur utilisateur (portée `USER`).
 */
import type { UnitOfWork } from '../../../platform/unit-of-work.js';
import { recordChanges } from '../../../platform/sync/change-feed.js';
import { fromBin, toBin } from '../../../platform/kysely/uuid-columns.js';

export const DEVICE_DATASET_NAME = 'device';
export const ROLE_ASSIGNMENT_DATASET_NAME = 'role_assignment';

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

/**
 * Affectation de rôle publiée à son utilisateur seul (ADR-071, AV-533, Q24 du 08/11/2026) : ligne `USER` dont la portée est
 * le titulaire de l'affectation. Avant, elle l'était par le repli générique du pipeline (une ligne `GLOBAL`, servie à
 * **tous** les appareils : chaque téléphone connaissait qui a quel rôle, sur quel périmètre) ; la projection `ROLE_ASSIGNMENT`
 * ignore désormais cette ligne `GLOBAL`, qui reste insérée par le pipeline à chaque octroi ou révocation sans être servie.
 *
 * À appeler à chaque écriture de la table : à l'insertion (`insertRoleAssignment`, donc l'octroi par commande, la création d'un
 * compte et les scripts d'exploitation) et à la révocation (`revoke`, qui incrémente `version`). Aucune ligne à l'échéance
 * (`valid_to`) : l'appareil juge la validité à son heure, comme le serveur (`isActiveAt`).
 */
export async function emitRoleAssignmentChange(
  uow: UnitOfWork,
  assignmentId: string,
): Promise<void> {
  const row = await uow
    .selectFrom('identity_user_role_assignments')
    .select(['user_id', 'version'])
    .where('id', '=', toBin(assignmentId))
    .executeTakeFirst();
  if (!row) return;
  await recordChanges(uow, [
    {
      dataset: ROLE_ASSIGNMENT_DATASET_NAME,
      entityType: 'ROLE_ASSIGNMENT',
      entityId: assignmentId,
      scopeType: 'USER',
      scopeId: fromBin(row.user_id),
      rowVersion: row.version,
    },
  ]);
}
