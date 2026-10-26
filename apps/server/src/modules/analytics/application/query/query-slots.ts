/**
 * Requêtes simultanées par utilisateur (P9-14 ; ADR-078 §1, RISK-13) : au plus `analytics.query_max_concurrent_per_user`
 * requêtes de l'explorateur en cours pour un même utilisateur, quel que soit le processus du serveur qui les sert.
 *
 * Un « emplacement » est un verrou nommé MySQL (`GET_LOCK`, sans attente) tenu par **la connexion qui exécute la
 * requête** : le verrou disparaît avec la connexion si le processus meurt, et se libère explicitement à la fin
 * (`RELEASE_LOCK`). Les emplacements d'un utilisateur sont numérotés de 1 au plafond ; un utilisateur dont tous les
 * emplacements sont tenus est refusé (429 `QUERY_LIMIT_EXCEEDED`, détail `concurrency`).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';

type Executor = Kysely<DB> | Transaction<DB>;

/** Nom d'un verrou (64 caractères au plus) : jamais un texte de l'utilisateur, un identifiant UUID et un rang. */
export function querySlotName(userId: string, slot: number): string {
  return `analytics:q:${userId.replaceAll('-', '')}:${slot}`;
}

/** Prend le premier emplacement libre ; `null` si tous sont tenus. À appeler sur la connexion de la requête. */
export async function acquireQuerySlot(
  connection: Executor,
  userId: string,
  maxConcurrent: number,
): Promise<number | null> {
  for (let slot = 1; slot <= maxConcurrent; slot += 1) {
    const { rows } = await sql<{ got: number | string | null }>`
      SELECT GET_LOCK(${querySlotName(userId, slot)}, 0) AS got`.execute(connection);
    if (Number(rows[0]?.got) === 1) return slot;
  }
  return null;
}

/** Rend l'emplacement ; sans effet si la connexion ne le tient plus. */
export async function releaseQuerySlot(
  connection: Executor,
  userId: string,
  slot: number,
): Promise<void> {
  await sql`SELECT RELEASE_LOCK(${querySlotName(userId, slot)})`.execute(connection);
}
