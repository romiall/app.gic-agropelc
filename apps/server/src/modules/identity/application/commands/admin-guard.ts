/**
 * INV-ADM-01 (docs/02-domain-model/01-invariants.md) : « Au moins un utilisateur ADMIN
 * actif. » Garde appliquée par `identity.user.suspend`/`.deactivate` (SM-USER, condition
 * « pas le dernier Admin ») et par `identity.role_assignment.revoke` (P0-10, même invariant :
 * révoquer la dernière affectation ADMIN active a le même effet qu'une désactivation) avant
 * d'écrire — jamais après coup.
 */
import type { UnitOfWork } from '../../../../platform/unit-of-work.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';

/** Vrai s'il existe, hors `excludeUserId`, un ADMIN actif dont l'affectation est valide à `now`. */
export async function hasOtherActiveAdmin(
  uow: UnitOfWork,
  excludeUserId: string,
  now: Date,
): Promise<boolean> {
  const row = await uow
    .selectFrom('identity_user_role_assignments as ura')
    .innerJoin('identity_roles as r', 'r.id', 'ura.role_id')
    .innerJoin('identity_users as u', 'u.id', 'ura.user_id')
    .select('ura.id')
    .where('r.code', '=', 'ADMIN')
    .where('u.id', '!=', toBin(excludeUserId))
    .where('u.status', '=', 'ACTIVE')
    .where('ura.valid_from', '<=', now)
    .where((eb) => eb.or([eb('ura.valid_to', 'is', null), eb('ura.valid_to', '>', now)]))
    .where((eb) => eb.or([eb('ura.revoked_at', 'is', null), eb('ura.revoked_at', '>', now)]))
    .executeTakeFirst();
  return row !== undefined;
}

/** Vrai s'il existe, hors `excludeAssignmentId`, une affectation ADMIN active (utilisateur
 * actif compris) — utilisé par `identity.role_assignment.revoke` : contrairement à
 * {@link hasOtherActiveAdmin}, exclut une affectation précise, pas tout un utilisateur (qui
 * peut détenir plusieurs affectations ADMIN). */
export async function hasOtherActiveAdminAssignment(
  uow: UnitOfWork,
  excludeAssignmentId: string,
  now: Date,
): Promise<boolean> {
  const row = await uow
    .selectFrom('identity_user_role_assignments as ura')
    .innerJoin('identity_roles as r', 'r.id', 'ura.role_id')
    .innerJoin('identity_users as u', 'u.id', 'ura.user_id')
    .select('ura.id')
    .where('r.code', '=', 'ADMIN')
    .where('ura.id', '!=', toBin(excludeAssignmentId))
    .where('u.status', '=', 'ACTIVE')
    .where('ura.valid_from', '<=', now)
    .where((eb) => eb.or([eb('ura.valid_to', 'is', null), eb('ura.valid_to', '>', now)]))
    .where((eb) => eb.or([eb('ura.revoked_at', 'is', null), eb('ura.revoked_at', '>', now)]))
    .executeTakeFirst();
  return row !== undefined;
}
