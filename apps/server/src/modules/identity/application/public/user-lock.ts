/**
 * Verrou de la ligne d'un utilisateur (P9-25, EX-8) : sérialise, par utilisateur, les commandes qui plafonnent ce
 * qu'il a en cours (exports en file, par exemple) — le plafond se lit après le verrou, et la seconde commande voit la
 * première validée. Lecture avec verrou : `identity` reste le seul à écrire `identity_users`.
 */
import type { Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';

/** Verrouille la ligne de l'utilisateur jusqu'à la fin de la transaction ; `false` s'il n'existe pas. */
export async function lockUserById(uow: Transaction<DB>, userId: string): Promise<boolean> {
  const row = await uow
    .selectFrom('identity_users')
    .select('id')
    .where('id', '=', toBin(userId))
    .forUpdate()
    .executeTakeFirst();
  return row !== undefined;
}
