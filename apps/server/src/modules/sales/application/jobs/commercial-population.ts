/**
 * Population suivie par l'alerte `INACTIVE_COMMERCIAL` (P9-07 ; BR-TER-013, AV-409 ; besoin B1) : les
 * utilisateurs **actifs** titulaires d'une affectation de rôle commercial **avant le jour examiné**
 * (un commercial affecté à 14 h n'est pas alerté pour la matinée). `identity` n'expose que la lecture
 * « par utilisateur » : cette requête inverse est isolée ici, remplaçable par une fonction publique
 * d'`identity` (besoin B1 du suivi P9, §5) sans toucher au détecteur.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface TrackedCommercial {
  readonly userId: string;
  readonly roleCode: string;
  /** Zone d'une affectation de portée `ZONE`, sinon `null` (portée des responsables commerciaux). */
  readonly zoneId: string | null;
}

/**
 * Commerciaux à suivre pour le jour métier qui débute à `dayStart` : utilisateur actif, non système,
 * affectation d'un rôle de `roleCodes` valide à l'ouverture du jour (début avant `dayStart`, ni échue ni
 * révoquée). Un commercial à plusieurs affectations n'apparaît qu'une fois.
 */
export async function trackedCommercialsAt(
  executor: Executor,
  filter: { readonly roleCodes: readonly string[]; readonly dayStart: Date },
): Promise<readonly TrackedCommercial[]> {
  if (filter.roleCodes.length === 0) return [];
  const rows = await executor
    .selectFrom('identity_user_role_assignments as a')
    .innerJoin('identity_roles as r', 'r.id', 'a.role_id')
    .innerJoin('identity_users as u', 'u.id', 'a.user_id')
    .select(['a.user_id', 'r.code as role_code', 'a.scope_zone_id'])
    .where('r.code', 'in', [...filter.roleCodes])
    .where('r.is_active', '=', 1)
    .where('u.status', '=', 'ACTIVE')
    .where('u.is_system', '=', 0)
    .where('a.valid_from', '<', filter.dayStart)
    .where((eb) => eb.or([eb('a.valid_to', 'is', null), eb('a.valid_to', '>', filter.dayStart)]))
    .where((eb) =>
      eb.or([eb('a.revoked_at', 'is', null), eb('a.revoked_at', '>', filter.dayStart)]),
    )
    .orderBy('a.user_id')
    .orderBy('a.valid_from')
    .execute();
  const seen = new Map<string, TrackedCommercial>();
  for (const row of rows) {
    const userId = fromBin(row.user_id);
    const existing = seen.get(userId);
    const zoneId = row.scope_zone_id === null ? null : fromBin(row.scope_zone_id);
    if (existing === undefined) {
      seen.set(userId, { userId, roleCode: row.role_code, zoneId });
    } else if (existing.zoneId === null && zoneId !== null) {
      seen.set(userId, { ...existing, zoneId });
    }
  }
  return [...seen.values()];
}
