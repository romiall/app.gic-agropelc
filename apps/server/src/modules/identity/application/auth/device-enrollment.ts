/**
 * Enrôlement d'appareil à la première connexion (07-security-rbac/02-securite.md §5 :
 * « Enrôlement → PENDING → approbation (AV-006) → ACTIVE » ; BR-ADM-005 : un appareil
 * PENDING peut se connecter mais pas pousser de commandes — ce contrôle-ci reste au
 * pipeline de commande (P0-06), pas ici). `device_id` est fourni par le client (UUIDv7,
 * ADR-002 : généré par l'appareil) : la première connexion sur un appareil neuf crée sa
 * ligne, les suivantes la retrouvent par cet identifiant stable.
 */
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';
import { publishDeviceEnrollmentRequested } from '../device-events.js';

const SHORT_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const MAX_SHORT_CODE_ATTEMPTS = 5;

function randomShortCode(): string {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += SHORT_CODE_CHARS[Math.floor(Math.random() * SHORT_CODE_CHARS.length)];
  }
  return code;
}

export interface DeviceLoginInput {
  readonly deviceId: string;
  readonly enrolledByUserId: string;
  /**
   * AV-296 (b) : un appareil non partagé (`is_shared` faux) ne sert qu'au compte qui l'a connecté en premier ; un
   * autre compte reçoit `DEVICE_BOUND_TO_OTHER_USER` (l'Admin le désigne « partagé » s'il change de main). Réglage
   * `identity.device_bound_to_enroller` (faux par défaut : comportement d'avant).
   */
  readonly boundToEnroller?: boolean;
  readonly label?: string;
  readonly platform?: string;
  readonly appVersion?: string;
  readonly now: Date;
}

/**
 * Appareil refusé : le motif est rendu à qui a prouvé son mot de passe (AV-253). `DEVICE_BOUND_TO_OTHER_USER` : appareil
 * en service mais réservé au compte qui l'a connecté (AV-296).
 */
export type DeviceLoginRefusal =
  'DEVICE_BLOCKED' | 'DEVICE_LOST' | 'DEVICE_RETIRED' | 'DEVICE_BOUND_TO_OTHER_USER';

export type DeviceLoginCheck =
  | {
      readonly ok: true;
      readonly status: 'PENDING' | 'ACTIVE';
      /** Code court, à communiquer au responsable qui approuve (MP-06, BR-ADM-007). */
      readonly shortCode: string;
    }
  | { readonly ok: false; readonly reason: DeviceLoginRefusal };

/** Idempotent par `deviceId` : rejoué, retrouve la même ligne plutôt que d'en recréer une. */
export async function findOrEnrollDevice(
  uow: UnitOfWork,
  input: DeviceLoginInput,
): Promise<DeviceLoginCheck> {
  const deviceIdBin = toBin(input.deviceId);
  const existing = await uow
    .selectFrom('identity_devices')
    .select(['status', 'short_code', 'is_shared', 'enrolled_by_user_id'])
    .where('id', '=', deviceIdBin)
    .executeTakeFirst();

  if (existing) {
    if (existing.status === 'BLOCKED') return { ok: false, reason: 'DEVICE_BLOCKED' };
    if (existing.status === 'LOST') return { ok: false, reason: 'DEVICE_LOST' };
    if (existing.status === 'RETIRED') return { ok: false, reason: 'DEVICE_RETIRED' };
    if (
      input.boundToEnroller === true &&
      Number(existing.is_shared) === 0 &&
      existing.enrolled_by_user_id !== null &&
      !existing.enrolled_by_user_id.equals(toBin(input.enrolledByUserId))
    ) {
      return { ok: false, reason: 'DEVICE_BOUND_TO_OTHER_USER' };
    }
    await uow
      .updateTable('identity_devices')
      .set({ last_seen_at: input.now })
      .where('id', '=', deviceIdBin)
      .execute();
    return {
      ok: true,
      status: existing.status as 'PENDING' | 'ACTIVE',
      shortCode: existing.short_code,
    };
  }

  for (let attempt = 1; attempt <= MAX_SHORT_CODE_ATTEMPTS; attempt++) {
    const shortCode = randomShortCode();
    try {
      await uow
        .insertInto('identity_devices')
        .values({
          id: deviceIdBin,
          short_code: shortCode,
          label: input.label ?? null,
          enrolled_by_user_id: toBin(input.enrolledByUserId),
          status: 'PENDING',
          platform: input.platform ?? null,
          app_version: input.appVersion ?? null,
          last_seen_at: input.now,
          created_by: toBin(input.enrolledByUserId),
        })
        .execute();
      // AV-432 : les approbateurs sont prévenus dans la transaction de la connexion (un appareil n'est enrôlé qu'une fois).
      await publishDeviceEnrollmentRequested(uow, {
        deviceId: input.deviceId,
        shortCode,
        enrolledByUserId: input.enrolledByUserId,
        occurredAt: input.now,
      });
      return { ok: true, status: 'PENDING', shortCode };
    } catch (error) {
      const isDuplicateShortCode =
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: string }).code === 'ER_DUP_ENTRY' &&
        (error as { message?: string }).message?.includes('short_code');
      if (!isDuplicateShortCode || attempt === MAX_SHORT_CODE_ATTEMPTS) throw error;
    }
  }
  /* istanbul ignore next -- la boucle retourne ou lève systématiquement */
  throw new Error('Impossible d’attribuer un code court unique.');
}
