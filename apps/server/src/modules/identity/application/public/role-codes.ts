/**
 * Codes de rôle actifs inconnus d'une liste (P9-19 ; partage d'une vue sauvegardée, ADR-077 §1). Lecture seule de
 * `identity_roles` pour un autre module : l'écriture reste à `identity`.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';

/** Les codes de `codes` qui ne désignent aucun rôle actif, dans l'ordre reçu. */
export async function unknownRoleCodes(
  executor: Kysely<DB> | Transaction<DB>,
  codes: readonly string[],
): Promise<readonly string[]> {
  if (codes.length === 0) return [];
  const rows = await executor
    .selectFrom('identity_roles')
    .select('code')
    .where('code', 'in', [...codes])
    .where('is_active', '=', 1)
    .execute();
  const known = new Set(rows.map((row) => row.code));
  return codes.filter((code) => !known.has(code));
}

/**
 * Verrou de ligne du rôle de code `code`, tenu jusqu'à la fin de la transaction de l'appelant : sérialise, par rôle,
 * les commandes qui posent la vue par défaut de ce rôle (P9-19) — une seule vue par défaut par rôle, et la seconde
 * commande doit voir la première validée. Rend `false` si le rôle n'existe pas. Lecture avec verrou : `identity`
 * reste le seul à écrire `identity_roles`.
 */
export async function lockRoleByCode(uow: Transaction<DB>, code: string): Promise<boolean> {
  const row = await uow
    .selectFrom('identity_roles')
    .select('id')
    .where('code', '=', code)
    .forUpdate()
    .executeTakeFirst();
  return row !== undefined;
}
