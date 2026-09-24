/**
 * RC-02 (07-security-rbac/01-rbac.md §4) + algorithme serveur, point 3
 * (06-offline-sync/02-synchronisation.md §3.2) : « appareil ACTIVE, ou bloqué après
 * occurred_at → sinon CONFLICT DEVICE_REVOKED (quarantaine) ».
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';

export type DeviceCheckResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'DEVICE_REVOKED' };

export async function checkDeviceActive(
  executor: Kysely<DB> | Transaction<DB>,
  deviceId: Buffer,
  occurredAt: Date,
): Promise<DeviceCheckResult> {
  const device = await executor
    .selectFrom('identity_devices')
    .select(['status', 'status_changed_at'])
    .where('id', '=', deviceId)
    .executeTakeFirst();

  if (!device) return { ok: false, reason: 'DEVICE_REVOKED' };
  if (device.status === 'ACTIVE') return { ok: true };
  // Était actif à occurred_at, bloqué/perdu/retiré seulement depuis (statut désormais
  // non-ACTIVE mais transition postérieure au fait constaté) : toléré (BR-SYN-007).
  if (device.status_changed_at > occurredAt) return { ok: true };
  return { ok: false, reason: 'DEVICE_REVOKED' };
}
