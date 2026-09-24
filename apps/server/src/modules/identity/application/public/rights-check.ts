/**
 * RC-01 (07-security-rbac/01-rbac.md §4) : droits évalués **à `occurred_at`** — affectation
 * active à cet instant (`valid_from` ≤ occurred_at < `valid_to`, non révoquée avant
 * occurred_at) dont le rôle accorde la permission.
 *
 * Portée volontairement minimale pour P0-06 (pipeline) : existence d'un octroi, sans
 * intersection avec le périmètre de la ressource visée (portée maximale ∩ périmètre de
 * l'affectation, §2 « Droit effectif ») — c'est l'évaluation complète des portées
 * (RC-01 à RC-10, `01-rbac.md` §2 à §4) que P0-10 construit. Signature stable : P0-10
 * enrichit l'implémentation, pas ses appelants (le pipeline de commande).
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';

export async function hasPermissionAt(
  executor: Kysely<DB> | Transaction<DB>,
  userId: Buffer,
  permissionCode: string,
  occurredAt: Date,
): Promise<boolean> {
  const grant = await executor
    .selectFrom('identity_user_role_assignments as ura')
    .innerJoin('identity_role_permissions as rp', 'rp.role_id', 'ura.role_id')
    .select('rp.permission_code')
    .where('ura.user_id', '=', userId)
    .where('rp.permission_code', '=', permissionCode)
    .where('ura.valid_from', '<=', occurredAt)
    .where((eb) => eb.or([eb('ura.valid_to', 'is', null), eb('ura.valid_to', '>', occurredAt)]))
    .where((eb) => eb.or([eb('ura.revoked_at', 'is', null), eb('ura.revoked_at', '>', occurredAt)]))
    .executeTakeFirst();

  return grant !== undefined;
}
