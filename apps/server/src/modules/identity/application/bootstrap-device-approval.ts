/**
 * Approbation d'installation d'un appareil (AV-254, tranché le 13/10/2026 ; MP-06) : sur une installation
 * neuve, personne ne peut encore approuver depuis l'application le premier téléphone de l'administrateur
 * (ECR-ADM-05 exige un appareil actif). L'installateur lance, sur le serveur,
 * `pnpm run db:approve-device -- <code court>` (`apps/server/scripts/approve-device.ts`), qui appelle cette
 * fonction : acteur système (`is_system`), `approved_by`, publication à l'appareil, audit
 * `identity.device.approve` (motif « db:approve-device (AV-254) »). Aucune exception dans le pipeline des
 * commandes (RC-02 inchangé).
 *
 * Gardes : code court de 4 caractères (majuscules et chiffres, BR-ADM-007) ; appareil en attente ;
 * l'utilisateur qui l'a connecté a un rôle `ADMIN` actif — la commande ne sert qu'au téléphone d'un
 * administrateur (amorçage, ou reprise après la perte de tous les appareils d'administration).
 */
import type { Clock, IdGenerator } from '@gic/domain';
import { recordAudit } from '../../../audit/record-audit.js';
import { fromBin } from '../../../platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../../../platform/unit-of-work.js';
import { approveDevice } from './commands/device-commands.js';
import { activeRoleCodesAt } from './public/assignment-query.js';

export const SHORT_CODE_PATTERN = /^[A-Z0-9]{4}$/;

export interface BootstrapDevice {
  readonly id: string;
  readonly shortCode: string;
  readonly platform: string | null;
  readonly enrolledByUserId: string;
  readonly enrolledByName: string;
  readonly enrolledByPhone: string;
  readonly createdAt: Date;
}

export type DeviceBootstrapResult =
  | { readonly kind: 'APPROVED'; readonly device: BootstrapDevice }
  | { readonly kind: 'ALREADY_ACTIVE'; readonly device: BootstrapDevice }
  | {
      readonly kind: 'REFUSED';
      readonly reason:
        'INVALID_CODE' | 'NO_SYSTEM_USER' | 'UNKNOWN_DEVICE' | 'NOT_PENDING' | 'NOT_ADMIN';
      readonly message: string;
    };

export async function approveDeviceByShortCode(
  uow: UnitOfWork,
  deps: { readonly idGenerator: IdGenerator; readonly clock: Clock },
  input: { readonly shortCode: string },
): Promise<DeviceBootstrapResult> {
  const shortCode = input.shortCode.trim().toUpperCase();
  if (!SHORT_CODE_PATTERN.test(shortCode)) {
    return {
      kind: 'REFUSED',
      reason: 'INVALID_CODE',
      message: 'Code court invalide : 4 caractères, lettres majuscules et chiffres (ex. 7KQ2).',
    };
  }
  const system = await uow
    .selectFrom('identity_users')
    .select('id')
    .where('is_system', '=', 1)
    .orderBy('created_at')
    .limit(1)
    .executeTakeFirst();
  if (!system) {
    return {
      kind: 'REFUSED',
      reason: 'NO_SYSTEM_USER',
      message: 'Utilisateur système absent : lancer d’abord `pnpm run db:seed`.',
    };
  }
  const row = await uow
    .selectFrom('identity_devices as d')
    .innerJoin('identity_users as u', 'u.id', 'd.enrolled_by_user_id')
    .select([
      'd.id',
      'd.short_code',
      'd.status',
      'd.platform',
      'd.enrolled_by_user_id',
      'd.created_at',
      'u.full_name',
      'u.phone',
    ])
    .where('d.short_code', '=', shortCode)
    .forUpdate()
    .executeTakeFirst();
  if (!row) {
    return {
      kind: 'REFUSED',
      reason: 'UNKNOWN_DEVICE',
      message: `Aucun appareil n’a le code ${shortCode}.`,
    };
  }
  const device: BootstrapDevice = {
    id: fromBin(row.id),
    shortCode: row.short_code,
    platform: row.platform,
    enrolledByUserId: fromBin(row.enrolled_by_user_id),
    enrolledByName: row.full_name,
    enrolledByPhone: row.phone,
    createdAt: row.created_at,
  };
  if (row.status === 'ACTIVE') return { kind: 'ALREADY_ACTIVE', device };
  if (row.status !== 'PENDING') {
    return {
      kind: 'REFUSED',
      reason: 'NOT_PENDING',
      message: `L’appareil ${shortCode} est à l’état ${row.status} : seul un appareil en attente s’approuve ainsi.`,
    };
  }
  const now = deps.clock.now();
  if (!(await activeRoleCodesAt(uow, device.enrolledByUserId, now)).includes('ADMIN')) {
    return {
      kind: 'REFUSED',
      reason: 'NOT_ADMIN',
      message:
        'L’utilisateur qui a connecté cet appareil n’est pas administrateur : son approbation se fait dans l’application (écran Appareils).',
    };
  }
  const systemUserId = fromBin(system.id);
  const outcome = await approveDevice(uow, {
    deviceId: device.id,
    authorUserId: systemUserId,
    occurredAt: now,
  });
  if (outcome.status !== 'APPLIED') {
    throw new Error(`Approbation impossible : ${JSON.stringify(outcome)}`);
  }
  await recordAudit(uow, deps, {
    occurredAt: now,
    actorUserId: systemUserId,
    actorRoles: [],
    action: 'identity.device.approve',
    entityType: 'DEVICE',
    entityId: device.id,
    before: { status: 'PENDING' },
    after: { status: 'ACTIVE', approvedBy: systemUserId },
    reason: 'db:approve-device (AV-254)',
    result: 'SUCCESS',
  });
  return { kind: 'APPROVED', device };
}
