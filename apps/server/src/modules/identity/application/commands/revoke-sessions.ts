/**
 * Révocation de sessions (07-security-rbac/02-securite.md §3 « Révocation ») : « désactivation
 * d'utilisateur, blocage d'appareil, décision de l'Admin : révocation de toutes les sessions
 * concernées ; effet immédiat en ligne (refus du rafraîchissement, jeton d'accès expiré sous
 * 15 min) ». Ne touche que les sessions **actives** (`revoked_at IS NULL`) : une session déjà
 * révoquée (rejeu, ou révoquée pour une autre raison) n'est jamais réécrite (idempotent,
 * BR-SYN-007 — rejouer une commande de blocage ne doit rien casser).
 */
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';

/** `identity_auth_sessions.revoked_reason` — sous-ensemble de la contrainte CHECK en base. */
export type RevokedReason =
  'LOGOUT' | 'ADMIN' | 'USER_DEACTIVATED' | 'DEVICE_BLOCKED' | 'TOKEN_REUSE' | 'EXPIRED';

export async function revokeUserSessions(
  uow: UnitOfWork,
  userId: string,
  reason: RevokedReason,
  now: Date,
): Promise<void> {
  await uow
    .updateTable('identity_auth_sessions')
    .set({ revoked_at: now, revoked_reason: reason })
    .where('user_id', '=', toBin(userId))
    .where('revoked_at', 'is', null)
    .execute();
}

export async function revokeDeviceSessions(
  uow: UnitOfWork,
  deviceId: string,
  reason: RevokedReason,
  now: Date,
): Promise<void> {
  await uow
    .updateTable('identity_auth_sessions')
    .set({ revoked_at: now, revoked_reason: reason })
    .where('device_id', '=', toBin(deviceId))
    .where('revoked_at', 'is', null)
    .execute();
}

/**
 * Révoque toute une famille de rotation (§3 « la réutilisation d'un jeton déjà utilisé
 * révoque toute la famille »). `tokenFamilyId` est déjà sous forme binaire ici (lu depuis
 * une ligne `identity_auth_sessions`, jamais saisi par un appelant externe).
 */
export async function revokeSessionFamily(
  uow: UnitOfWork,
  tokenFamilyId: Buffer,
  reason: RevokedReason,
  now: Date,
): Promise<void> {
  await uow
    .updateTable('identity_auth_sessions')
    .set({ revoked_at: now, revoked_reason: reason })
    .where('token_family_id', '=', tokenFamilyId)
    .where('revoked_at', 'is', null)
    .execute();
}
