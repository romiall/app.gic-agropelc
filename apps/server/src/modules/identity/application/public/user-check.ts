/**
 * Algorithme serveur, point 3 (06-offline-sync/02-synchronisation.md §3.2) :
 * « utilisateur actif à occurred_at → sinon CONFLICT USER_DEACTIVATED ».
 *
 * AV-229 (BR-ADM-002, AT-034 ; même mécanisme qu'AV-212 pour les appareils) : un fait daté dans une période hors service
 * **close** de l'utilisateur (`identity_user_status_periods`, consignée par `reactivate` et par `deactivate` depuis la
 * suspension) est en quarantaine, même si le compte est redevenu `ACTIVE` ou a été désactivé depuis. Une seule instruction :
 * la ligne vivante et ses périodes sont lues dans le même instantané (une réactivation intercalée entre deux lectures
 * laisserait passer le fait).
 *
 * Ordre de décision : utilisateur inconnu → refusé ; période close contenant le fait → refusé ; `ACTIVE` → accepté ;
 * hors service depuis une date postérieure au fait → accepté (BR-SYN-007) ; sinon refusé.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';

export type UserCheckResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'USER_DEACTIVATED' };

export async function checkUserActive(
  executor: Kysely<DB> | Transaction<DB>,
  userId: Buffer,
  occurredAt: Date,
): Promise<UserCheckResult> {
  const user = await executor
    .selectFrom('identity_users as u')
    .select((eb) => [
      'u.status',
      'u.status_changed_at',
      eb
        .exists(
          eb
            .selectFrom('identity_user_status_periods as p')
            .select(sql<number>`1`.as('one'))
            .whereRef('p.user_id', '=', 'u.id')
            .where('p.valid_from', '<=', occurredAt)
            .where('p.valid_to', '>', occurredAt),
        )
        .as('in_closed_period'),
    ])
    .where('u.id', '=', userId)
    .executeTakeFirst();

  if (!user) return { ok: false, reason: 'USER_DEACTIVATED' };
  if (Number(user.in_closed_period) === 1) return { ok: false, reason: 'USER_DEACTIVATED' };
  if (user.status === 'ACTIVE') return { ok: true };
  // Était actif à occurred_at, suspendu/désactivé seulement depuis : toléré (BR-SYN-007).
  // status_changed_at NULL (aucune transition enregistrée) alors que le statut n'est pas
  // ACTIVE : ne peut pas prouver l'activité à occurred_at, refusé par défaut (aucune
  // interface cliente n'est une autorité de confiance, 02-securite.md).
  if (user.status_changed_at !== null && user.status_changed_at > occurredAt) return { ok: true };
  return { ok: false, reason: 'USER_DEACTIVATED' };
}
