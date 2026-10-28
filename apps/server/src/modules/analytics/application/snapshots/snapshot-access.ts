/**
 * Lecture revérifiée des instantanés personnels (TB-7 ; ADR-066 §5 à §7) : une ligne a été calculée avec les droits
 * de l'utilisateur **d'alors** et la tâche d'instantanés ne retire celles dont le droit est perdu qu'à sa passe
 * suivante (jusqu'à 15 minutes, indéfiniment si la tâche est arrêtée). La route `GET /analytics/snapshots/me` et le
 * lecteur du jeu hors ligne `kpi` lisent donc par ces fonctions : elles écartent la ligne dont le tableau
 * `analytics.dashboard.<tableau>` n'est plus permis et masquent les indicateurs protégés du registre (valeur, période
 * précédente, variation, lien d'exploration) quand `inventory.valuation.read` est perdu.
 *
 * Limites : le contrôle juge l'existence du droit (`hasPermissionAt`), non l'étendue — un changement d'étendue
 * attend la passe suivante — et s'appuie sur le cache RBAC du processus, invalidé par événement ; ce qu'un appareil a
 * déjà tiré n'est retiré que par la republication masquée ou le `DELETE` de la passe suivante.
 */
import type { Kysely, Transaction } from 'kysely';
import { maskProtectedKpi } from '@gic/domain';
import type { DB } from '../../../../platform/kysely/database.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';
import { hasPermissionAt } from '../../../identity/application/public/index.js';
import { VALUATION_PERMISSION } from '../query/validate-for-user.js';
import {
  listSnapshotsOf,
  readSnapshot,
  type SnapshotKey,
  type StoredSnapshot,
} from './snapshot-store.js';

type Executor = Kysely<DB> | Transaction<DB>;

/** Permission du tableau qui fonde les instantanés de `scopeKey` (même convention que le tableau de bord). */
export const snapshotReadPermission = (scopeKey: string): string =>
  `analytics.dashboard.${scopeKey}`;

/** Un indicateur stocké sans valorisation : la règle du registre (`maskProtectedKpi`), si la forme est reconnue. */
function maskedKpi(kpi: unknown): unknown {
  if (typeof kpi !== 'object' || kpi === null) return kpi;
  const code = (kpi as { code?: unknown }).code;
  if (typeof code !== 'string') return kpi;
  return maskProtectedKpi(kpi as { readonly code: string });
}

/**
 * Les lignes dont le tableau est encore permis, masquées si la valorisation est perdue. Un contrôle par tableau
 * distinct et un seul pour la valorisation, même pour plusieurs lignes.
 */
async function revalidated(
  executor: Executor,
  userId: string,
  at: Date,
  snapshots: readonly StoredSnapshot[],
): Promise<readonly StoredSnapshot[]> {
  if (snapshots.length === 0) return snapshots;
  const userBin = toBin(userId);
  const permitted = new Map<string, boolean>();
  for (const snapshot of snapshots) {
    if (permitted.has(snapshot.scopeKey)) continue;
    permitted.set(
      snapshot.scopeKey,
      await hasPermissionAt(executor, userBin, snapshotReadPermission(snapshot.scopeKey), at),
    );
  }
  const readable = snapshots.filter((snapshot) => permitted.get(snapshot.scopeKey) === true);
  if (readable.length === 0) return readable;
  if (await hasPermissionAt(executor, userBin, VALUATION_PERMISSION, at)) return readable;
  return readable.map((snapshot) => ({ ...snapshot, kpis: snapshot.kpis.map(maskedKpi) }));
}

/** Les instantanés de l'utilisateur encore lisibles à `at`, du plus récent au plus ancien (TB-7). */
export async function readableSnapshotsOf(
  executor: Executor,
  userId: string,
  at: Date,
): Promise<readonly StoredSnapshot[]> {
  return revalidated(executor, userId, at, await listSnapshotsOf(executor, userId));
}

/** Un instantané précis de l'utilisateur, s'il est encore lisible à `at` (lecteur du jeu hors ligne `kpi`). */
export async function readableSnapshotOf(
  executor: Executor,
  key: SnapshotKey,
  at: Date,
): Promise<StoredSnapshot | undefined> {
  const found = await readSnapshot(executor, key);
  return found === undefined ? undefined : revalidatedSnapshot(executor, found, at);
}

/**
 * Un instantané déjà lu, revérifié à `at` : le lecteur du jeu `kpi` retrouve la ligne par son identifiant d'entité
 * dans la liste de l'utilisateur, puis ne contrôle que son tableau et la valorisation (une entité, deux contrôles).
 */
export async function revalidatedSnapshot(
  executor: Executor,
  snapshot: StoredSnapshot,
  at: Date,
): Promise<StoredSnapshot | undefined> {
  return (await revalidated(executor, snapshot.userId, at, [snapshot]))[0];
}
