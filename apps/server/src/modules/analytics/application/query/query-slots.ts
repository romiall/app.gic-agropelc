/**
 * Requêtes simultanées par utilisateur (P9-14 ; ADR-068 §1, RISK-13) : au plus `analytics.query_max_concurrent_per_user`
 * requêtes de l'explorateur en cours pour un même utilisateur, quel que soit le processus du serveur qui les sert.
 *
 * Un « emplacement » est un verrou nommé MySQL (`GET_LOCK`, sans attente) tenu par **la connexion qui exécute la
 * requête** : le verrou disparaît avec la connexion si le processus meurt, et se libère explicitement à la fin
 * (`RELEASE_LOCK`). Les emplacements d'un utilisateur sont numérotés de 1 au plafond ; un utilisateur dont tous les
 * emplacements sont tenus est refusé (429 `QUERY_LIMIT_EXCEEDED`, détail `concurrency`).
 *
 * **Plafond global** (P9-25, EP-2 et PF-4, AV-461) : au plus `analytics.query_max_concurrent_global` requêtes de
 * l'explorateur en cours pour tous les utilisateurs, par des emplacements globaux du même mécanisme. Chaque requête
 * épingle une connexion du pool partagé avec les commandes ; le plafond garde des connexions pour elles.
 * Désactivé par défaut (décision du porteur du 29/10/2026) : à 0, l'appelant ne prend ni ne libère aucun emplacement
 * global ; le mécanisme reste disponible en posant une valeur > 0.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';

type Executor = Kysely<DB> | Transaction<DB>;

/** Nom d'un verrou (64 caractères au plus) : jamais un texte de l'utilisateur, un identifiant UUID et un rang. */
export function querySlotName(userId: string, slot: number): string {
  return `analytics:q:${userId.replaceAll('-', '')}:${slot}`;
}

/** Nom d'un emplacement global : aucun identifiant d'utilisateur n'a la forme `global`. */
export function globalQuerySlotName(slot: number): string {
  return `analytics:q:global:${slot}`;
}

async function firstFreeSlot(
  connection: Executor,
  maxConcurrent: number,
  nameOf: (slot: number) => string,
): Promise<number | null> {
  for (let slot = 1; slot <= maxConcurrent; slot += 1) {
    const { rows } = await sql<{ got: number | string | null }>`
      SELECT GET_LOCK(${nameOf(slot)}, 0) AS got`.execute(connection);
    if (Number(rows[0]?.got) === 1) return slot;
  }
  return null;
}

/** Prend le premier emplacement libre ; `null` si tous sont tenus. À appeler sur la connexion de la requête. */
export async function acquireQuerySlot(
  connection: Executor,
  userId: string,
  maxConcurrent: number,
): Promise<number | null> {
  return firstFreeSlot(connection, maxConcurrent, (slot) => querySlotName(userId, slot));
}

/** Prend le premier emplacement global libre ; `null` si tous sont tenus (AV-461). */
export async function acquireGlobalQuerySlot(
  connection: Executor,
  maxConcurrent: number,
): Promise<number | null> {
  return firstFreeSlot(connection, maxConcurrent, globalQuerySlotName);
}

/** Rend l'emplacement global ; sans effet si la connexion ne le tient plus. */
export async function releaseGlobalQuerySlot(connection: Executor, slot: number): Promise<void> {
  await sql`SELECT RELEASE_LOCK(${globalQuerySlotName(slot)})`.execute(connection);
}

/** Rend l'emplacement ; sans effet si la connexion ne le tient plus. */
export async function releaseQuerySlot(
  connection: Executor,
  userId: string,
  slot: number,
): Promise<void> {
  await sql`SELECT RELEASE_LOCK(${querySlotName(userId, slot)})`.execute(connection);
}
