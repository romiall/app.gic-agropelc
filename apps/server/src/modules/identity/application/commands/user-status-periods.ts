/**
 * Périodes hors service closes d'un utilisateur (AV-229, suite d'AV-212 pour les appareils ; BR-ADM-002, AT-034,
 * SM-USER). La ligne `identity_users` est la période **ouverte** (statut courant depuis `status_changed_at`) ; quand
 * `reactivate` (depuis `SUSPENDED` ou `DEACTIVATED`) ou `deactivate` (depuis `SUSPENDED`) la réécrit, la période qu'elle
 * ferme est consignée ici d'abord, dans la même transaction, pour que le contrôle d'utilisateur du pipeline
 * (`checkUserActive`) mette encore en quarantaine un fait daté pendant cette période, quel que soit le statut devenu
 * courant.
 *
 * Table en ajout seul (`identity_user_status_periods`, IMMUABLE). Une période par commande de fermeture (`command_id`,
 * clé primaire). Sans durée (fermeture datée au plus tard de son ouverture : horloge d'administration en retard, données
 * de test), rien n'est écrit — la règle `valid_to > valid_from` le garantit aussi en base.
 */
import type { Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';

/** Statuts hors service d'un utilisateur dont la période se consigne à sa fermeture. */
export const USER_OUT_OF_SERVICE_STATUSES = ['SUSPENDED', 'DEACTIVATED'] as const;
export type UserOutOfServiceStatus = (typeof USER_OUT_OF_SERVICE_STATUSES)[number];

export function isUserOutOfServiceStatus(status: string): status is UserOutOfServiceStatus {
  return (USER_OUT_OF_SERVICE_STATUSES as readonly string[]).includes(status);
}

export async function closeUserOutOfServicePeriod(
  uow: Transaction<DB>,
  input: {
    readonly commandId: string;
    readonly userId: string;
    readonly status: UserOutOfServiceStatus;
    /** Ouverture de la période : `status_changed_at` de la ligne vivante ; absent, la période ne peut pas être datée. */
    readonly validFrom: Date | null;
    readonly closedAt: Date;
    readonly reason: string | null;
    readonly closedBy: string;
  },
): Promise<void> {
  if (input.validFrom === null || input.closedAt.getTime() <= input.validFrom.getTime()) return;
  await uow
    .insertInto('identity_user_status_periods')
    .values({
      command_id: toBin(input.commandId),
      user_id: toBin(input.userId),
      status: input.status,
      valid_from: input.validFrom,
      valid_to: input.closedAt,
      reason: input.reason,
      closed_by: toBin(input.closedBy),
    })
    .execute();
}
