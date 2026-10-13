/**
 * Périodes hors service closes d'un appareil (P5-23, AV-212 ; INV-ADM-03, BR-ADM-006, SM-DEVICE). La ligne
 * `identity_devices` est la période **ouverte** (statut courant depuis `status_changed_at`) ; quand
 * `unblock`, ou `retire` depuis `BLOCKED` ou `LOST`, la réécrit, la période qu'elle ferme est consignée
 * ici d'abord, dans la même transaction, pour que le contrôle d'appareil du pipeline
 * (`checkDeviceActive`) mette encore en quarantaine un fait daté pendant cette période, quel que soit le
 * statut devenu courant.
 *
 * Table en ajout seul (`identity_device_status_periods`, IMMUABLE). Une période par commande de fermeture
 * (`command_id`, clé primaire). Sans durée (fermeture datée au plus tard de son ouverture : horloge
 * d'administration en retard, données de test), rien n'est écrit — la règle `valid_to > valid_from` le
 * garantit aussi en base.
 */
import type { Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';

/** Statuts hors service dont la période se consigne à sa fermeture. */
export const OUT_OF_SERVICE_STATUSES = ['BLOCKED', 'LOST'] as const;
export type OutOfServiceStatus = (typeof OUT_OF_SERVICE_STATUSES)[number];

export function isOutOfServiceStatus(status: string): status is OutOfServiceStatus {
  return (OUT_OF_SERVICE_STATUSES as readonly string[]).includes(status);
}

export async function closeOutOfServicePeriod(
  uow: Transaction<DB>,
  input: {
    readonly commandId: string;
    readonly deviceId: string;
    readonly status: OutOfServiceStatus;
    readonly validFrom: Date;
    readonly closedAt: Date;
    readonly reason: string | null;
    readonly closedBy: string;
  },
): Promise<void> {
  if (input.closedAt.getTime() <= input.validFrom.getTime()) return;
  await uow
    .insertInto('identity_device_status_periods')
    .values({
      command_id: toBin(input.commandId),
      device_id: toBin(input.deviceId),
      status: input.status,
      valid_from: input.validFrom,
      valid_to: input.closedAt,
      reason: input.reason,
      closed_by: toBin(input.closedBy),
    })
    .execute();
}
