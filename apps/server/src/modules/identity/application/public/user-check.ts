/**
 * Algorithme serveur, point 3 (06-offline-sync/02-synchronisation.md §3.2) :
 * « utilisateur actif à occurred_at → sinon CONFLICT USER_DEACTIVATED ».
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';

export type UserCheckResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'USER_DEACTIVATED' };

export async function checkUserActive(
  executor: Kysely<DB> | Transaction<DB>,
  userId: Buffer,
  occurredAt: Date,
): Promise<UserCheckResult> {
  const user = await executor
    .selectFrom('identity_users')
    .select(['status', 'status_changed_at'])
    .where('id', '=', userId)
    .executeTakeFirst();

  if (!user) return { ok: false, reason: 'USER_DEACTIVATED' };
  if (user.status === 'ACTIVE') return { ok: true };
  // Était actif à occurred_at, suspendu/désactivé seulement depuis : toléré (BR-SYN-007).
  // status_changed_at NULL (aucune transition enregistrée) alors que le statut n'est pas
  // ACTIVE : ne peut pas prouver l'activité à occurred_at, refusé par défaut (aucune
  // interface cliente n'est une autorité de confiance, 02-securite.md).
  if (user.status_changed_at !== null && user.status_changed_at > occurredAt) return { ok: true };
  return { ok: false, reason: 'USER_DEACTIVATED' };
}
