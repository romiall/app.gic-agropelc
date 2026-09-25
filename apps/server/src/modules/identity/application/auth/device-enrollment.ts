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
  readonly label?: string;
  readonly platform?: string;
  readonly appVersion?: string;
  readonly now: Date;
}

export type DeviceLoginCheck =
  | { readonly ok: true; readonly status: 'PENDING' | 'ACTIVE' }
  | { readonly ok: false; readonly reason: 'DEVICE_BLOCKED' };

/** Idempotent par `deviceId` : rejoué, retrouve la même ligne plutôt que d'en recréer une. */
export async function findOrEnrollDevice(
  uow: UnitOfWork,
  input: DeviceLoginInput,
): Promise<DeviceLoginCheck> {
  const deviceIdBin = toBin(input.deviceId);
  const existing = await uow
    .selectFrom('identity_devices')
    .select('status')
    .where('id', '=', deviceIdBin)
    .executeTakeFirst();

  if (existing) {
    if (
      existing.status === 'BLOCKED' ||
      existing.status === 'LOST' ||
      existing.status === 'RETIRED'
    ) {
      return { ok: false, reason: 'DEVICE_BLOCKED' };
    }
    await uow
      .updateTable('identity_devices')
      .set({ last_seen_at: input.now })
      .where('id', '=', deviceIdBin)
      .execute();
    return { ok: true, status: existing.status as 'PENDING' | 'ACTIVE' };
  }

  for (let attempt = 1; attempt <= MAX_SHORT_CODE_ATTEMPTS; attempt++) {
    try {
      await uow
        .insertInto('identity_devices')
        .values({
          id: deviceIdBin,
          short_code: randomShortCode(),
          label: input.label ?? null,
          enrolled_by_user_id: toBin(input.enrolledByUserId),
          status: 'PENDING',
          platform: input.platform ?? null,
          app_version: input.appVersion ?? null,
          last_seen_at: input.now,
          created_by: toBin(input.enrolledByUserId),
        })
        .execute();
      return { ok: true, status: 'PENDING' };
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
