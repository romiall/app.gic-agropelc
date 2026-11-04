/**
 * Refus des appareils en attente dont l'identifiant n'est pas un UUIDv7 (AV-499, ADR-052) : la connexion les enrôlait
 * avant qu'elle n'exige un UUIDv7, alors que le jeton, le lot d'envoi et l'agrégat des décisions de l'Admin l'exigent.
 * Aucune commande ne peut les viser : l'écran Appareils ne leur propose aucune décision, et ils restent « en
 * attente » (et comptés au signal d'accueil) tant qu'on ne les refuse pas.
 *
 * Commande d'installation lancée sur le serveur (`deploy/hostinger/block-legacy-devices.mjs`), comme
 * `bootstrap-device-approval.ts` : acteur système (`is_system`), même transition que la décision « Refuser »
 * (`blockDevice` : PENDING → BLOCKED, publication, révocation des sessions), audit `identity.device.block`.
 * Rien n'est supprimé ; un appareil bloqué se débloque ensuite comme les autres (SM-DEVICE).
 *
 * Par défaut le lancement ne fait que lister (`apply` faux) ; il n'écrit qu'avec `apply` vrai, et `shortCodes`
 * restreint la liste à des appareils nommés.
 */
import { isUuidv7, type Clock, type IdGenerator } from '@gic/domain';
import { recordAudit } from '../../../audit/record-audit.js';
import { fromBin } from '../../../platform/kysely/uuid-columns.js';
import type { UnitOfWork } from '../../../platform/unit-of-work.js';
import { blockDevice } from './commands/device-commands.js';

/** Motif consigné sur l'appareil et dans l'audit. */
export const LEGACY_DEVICE_REASON =
  'Identifiant d’appareil non conforme (UUIDv7 exigé) : appareil de test refusé à l’installation (AV-499).';

export interface LegacyPendingDevice {
  readonly id: string;
  readonly shortCode: string;
  readonly platform: string | null;
  readonly createdAt: Date;
}

export type LegacyDeviceCleanupResult =
  | { readonly kind: 'LISTED'; readonly devices: readonly LegacyPendingDevice[] }
  | { readonly kind: 'BLOCKED'; readonly devices: readonly LegacyPendingDevice[] }
  | { readonly kind: 'REFUSED'; readonly reason: 'NO_SYSTEM_USER'; readonly message: string };

/** Appareils en attente dont l'identifiant n'est pas un UUIDv7, du plus ancien au plus récent. */
export async function listLegacyPendingDevices(
  uow: UnitOfWork,
): Promise<readonly LegacyPendingDevice[]> {
  const rows = await uow
    .selectFrom('identity_devices')
    .select(['id', 'short_code', 'platform', 'created_at'])
    .where('status', '=', 'PENDING')
    .orderBy('created_at')
    .execute();
  return rows
    .map((row) => ({
      id: fromBin(row.id),
      shortCode: row.short_code,
      platform: row.platform,
      createdAt: row.created_at,
    }))
    .filter((device) => !isUuidv7(device.id));
}

export async function blockLegacyPendingDevices(
  uow: UnitOfWork,
  deps: { readonly idGenerator: IdGenerator; readonly clock: Clock },
  input: { readonly apply: boolean; readonly shortCodes?: readonly string[] },
): Promise<LegacyDeviceCleanupResult> {
  const only = input.shortCodes?.map((code) => code.trim().toUpperCase());
  const devices = (await listLegacyPendingDevices(uow)).filter(
    (device) => only === undefined || only.includes(device.shortCode),
  );
  if (!input.apply || devices.length === 0) return { kind: 'LISTED', devices };

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
  const systemUserId = fromBin(system.id);
  const now = deps.clock.now();
  for (const device of devices) {
    const outcome = await blockDevice(uow, {
      deviceId: device.id,
      authorUserId: systemUserId,
      reason: LEGACY_DEVICE_REASON,
      occurredAt: now,
    });
    if (outcome.status !== 'APPLIED') {
      throw new Error(`Refus impossible pour ${device.shortCode} : ${JSON.stringify(outcome)}`);
    }
    await recordAudit(uow, deps, {
      occurredAt: now,
      actorUserId: systemUserId,
      actorRoles: [],
      action: 'identity.device.block',
      entityType: 'DEVICE',
      entityId: device.id,
      before: { status: 'PENDING' },
      after: { status: 'BLOCKED' },
      reason: LEGACY_DEVICE_REASON,
      result: 'SUCCESS',
    });
  }
  return { kind: 'BLOCKED', devices };
}
