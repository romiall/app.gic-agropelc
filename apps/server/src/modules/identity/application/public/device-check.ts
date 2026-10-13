/**
 * RC-02 (07-security-rbac/01-rbac.md §4) + algorithme serveur, point 3
 * (06-offline-sync/02-synchronisation.md §3.2) : « appareil ACTIVE, ou bloqué après
 * occurred_at → sinon CONFLICT DEVICE_REVOKED (quarantaine) ».
 *
 * P5-23 :
 * - AV-212 (INV-ADM-03) : un fait daté dans une période hors service **close** de l'appareil
 *   (`identity_device_status_periods`, consignée par `unblock` et `retire`) est en quarantaine, même si
 *   l'appareil est redevenu `ACTIVE` ou a été retiré depuis. Une seule instruction : la ligne vivante et ses
 *   périodes sont lues dans le même instantané (un déblocage intercalé entre deux lectures laisserait passer
 *   le fait).
 * - AV-228 : un appareil encore `PENDING` n'est pas une quarantaine mais une attente (`DEVICE_PENDING`,
 *   le pipeline répond `RETRY_LATER`) : ses faits s'appliquent s'il est approuvé ensuite ; un appareil
 *   refusé avant toute approbation (`approved_by` vide) met tous ses faits en quarantaine.
 *
 * Ordre de décision : appareil inconnu → révoqué ; période close contenant le fait → révoqué ; `ACTIVE` →
 * accepté ; `PENDING` → en attente ; jamais approuvé → révoqué ; hors service depuis une date postérieure
 * au fait → accepté (BR-SYN-007) ; sinon révoqué. Lecture simple, hors transaction métier (comme le
 * contrôle de l'utilisateur et des droits).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';

export type DeviceCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'DEVICE_REVOKED' | 'DEVICE_PENDING' };

export async function checkDeviceActive(
  executor: Kysely<DB> | Transaction<DB>,
  deviceId: Buffer,
  occurredAt: Date,
): Promise<DeviceCheckResult> {
  const device = await executor
    .selectFrom('identity_devices as d')
    .select((eb) => [
      'd.status',
      'd.status_changed_at',
      'd.approved_by',
      eb
        .exists(
          eb
            .selectFrom('identity_device_status_periods as p')
            .select(sql<number>`1`.as('one'))
            .whereRef('p.device_id', '=', 'd.id')
            .where('p.valid_from', '<=', occurredAt)
            .where('p.valid_to', '>', occurredAt),
        )
        .as('in_closed_period'),
    ])
    .where('d.id', '=', deviceId)
    .executeTakeFirst();

  if (!device) return { ok: false, reason: 'DEVICE_REVOKED' };
  if (Number(device.in_closed_period) === 1) return { ok: false, reason: 'DEVICE_REVOKED' };
  if (device.status === 'ACTIVE') return { ok: true };
  if (device.status === 'PENDING') return { ok: false, reason: 'DEVICE_PENDING' };
  // Refusé avant toute approbation : aucun de ses faits n'a de caution (AV-228).
  if (device.approved_by === null) return { ok: false, reason: 'DEVICE_REVOKED' };
  // Était actif à occurred_at, bloqué/perdu/retiré seulement depuis (statut désormais
  // non-ACTIVE mais transition postérieure au fait constaté) : toléré (BR-SYN-007).
  if (device.status_changed_at > occurredAt) return { ok: true };
  return { ok: false, reason: 'DEVICE_REVOKED' };
}
