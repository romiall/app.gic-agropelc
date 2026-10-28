/**
 * Instantanés personnels d'indicateurs (P9-18 ; ADR-066 §5 à §7, dictionnaire `analytics.kpi_snapshots`) : une ligne
 * par `(utilisateur, tableau, période)`, écrite au changement de contenu ou à la republication horaire, avec
 * l'instant de la dernière publication (« à jour au », jusqu'à 1 h 15 de retard sur le calcul ; TB-2, AV-381). Le
 * module `analytics` est le seul à écrire `analytics_kpi_snapshots` ; la tâche (`analytics-api/jobs/`) calcule le
 * contenu avec les mêmes fonctions que les tableaux, sous l'étendue exacte de l'utilisateur.
 *
 * Publication au flux de changements du jeu hors ligne `kpi` (portée `USER`) dans la même transaction que
 * l'écriture : la ligne est republiée quand son contenu change **ou** au plus toutes les heures pour la seule date
 * (« à jour au » ne doit pas tromper), une suppression est publiée en `DELETE`. L'identifiant d'entité est dérivé de
 * `(utilisateur, tableau, période)` (ADR-031).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { jsonValue } from '../../../../platform/kysely/json-value.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';
import { recordChanges } from '../../../../platform/sync/change-feed.js';
import { codeEntityId } from '../../../../platform/sync/code-entity-id.js';

type Executor = Kysely<DB> | Transaction<DB>;

export const KPI_DATASET = 'kpi';
export const KPI_ENTITY_TYPE = 'KPI_SNAPSHOT';
/** Au plus toutes les heures, la ligne est republiée pour sa seule date de calcul. */
export const SNAPSHOT_REPUBLISH_MS = 3_600_000;

export const SNAPSHOT_PERIOD_KEYS = ['TODAY', 'WEEK', 'MONTH'] as const;
export type SnapshotPeriodKey = (typeof SNAPSHOT_PERIOD_KEYS)[number];

export interface SnapshotKey {
  readonly userId: string;
  readonly scopeKey: string;
  readonly periodKey: SnapshotPeriodKey;
}

export interface StoredSnapshot extends SnapshotKey {
  readonly kpis: readonly unknown[];
  readonly computedAt: Date;
}

export const snapshotEntityId = (key: SnapshotKey): string =>
  codeEntityId(KPI_ENTITY_TYPE, `${key.userId}:${key.scopeKey}:${key.periodKey}`);

const pairOf = (scopeKey: string, periodKey: string): string => `${scopeKey}|${periodKey}`;

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortKeys(record[key])]),
    );
  }
  return value;
}

/**
 * Forme canonique d'un contenu JSON (clés triées) : MySQL range les clés d'un objet JSON à sa façon (par longueur,
 * puis par ordre alphabétique), si bien que le contenu relu n'a pas l'ordre des clés du contenu écrit ; seule la
 * valeur compte pour décider de republier.
 */
const canonicalJson = (value: unknown): string => JSON.stringify(sortKeys(value));

/**
 * Écrit et publie l'instantané quand son contenu change, à la première écriture ou quand sa date a plus d'une
 * heure ; sinon n'écrit rien. Rend `true` si une ligne du flux a été publiée. `kpis` est le contenu des
 * indicateurs (JSON) ; `computedAt` l'instant du calcul.
 */
export async function saveSnapshot(
  executor: Executor,
  input: SnapshotKey & { readonly kpis: readonly unknown[]; readonly computedAt: Date },
): Promise<boolean> {
  const previous = await executor
    .selectFrom('analytics_kpi_snapshots')
    .select(['payload', 'computed_at'])
    .where('user_id', '=', toBin(input.userId))
    .where('scope_key', '=', input.scopeKey)
    .where('period_key', '=', input.periodKey)
    .executeTakeFirst();
  // Contenu identique et dernière publication de moins d'une heure : rien n'est écrit. `computed_at` est l'instant
  // de la dernière publication (TB-2, AV-381) ; c'est lui que la republication horaire compare à l'instant du calcul.
  if (
    previous !== undefined &&
    canonicalJson((previous.payload as { kpis?: unknown } | null)?.kpis ?? null) ===
      canonicalJson(input.kpis) &&
    input.computedAt.getTime() - previous.computed_at.getTime() < SNAPSHOT_REPUBLISH_MS
  ) {
    return false;
  }
  const payload = { kpis: input.kpis };
  await executor
    .insertInto('analytics_kpi_snapshots')
    .values({
      user_id: toBin(input.userId),
      scope_key: input.scopeKey,
      period_key: input.periodKey,
      payload: jsonValue(payload),
      computed_at: input.computedAt,
    })
    .onDuplicateKeyUpdate({
      payload: jsonValue(payload),
      computed_at: input.computedAt,
    })
    .execute();
  await recordChanges(executor, [
    {
      dataset: KPI_DATASET,
      entityType: KPI_ENTITY_TYPE,
      entityId: snapshotEntityId(input),
      scopeType: 'USER',
      scopeId: input.userId,
      changeType: 'UPSERT',
    },
  ]);
  return true;
}

/**
 * Supprime les instantanés de l'utilisateur qui ne figurent pas dans `keep` (couples `tableau|période`) et publie
 * chaque suppression (`DELETE`). Rend le nombre de lignes supprimées.
 */
export async function deleteSnapshotsExcept(
  executor: Executor,
  userId: string,
  keep: ReadonlySet<string>,
): Promise<number> {
  const rows = await executor
    .selectFrom('analytics_kpi_snapshots')
    .select(['scope_key', 'period_key'])
    .where('user_id', '=', toBin(userId))
    .execute();
  const stale = rows.filter((row) => !keep.has(pairOf(row.scope_key, row.period_key)));
  for (const row of stale) {
    await executor
      .deleteFrom('analytics_kpi_snapshots')
      .where('user_id', '=', toBin(userId))
      .where('scope_key', '=', row.scope_key)
      .where('period_key', '=', row.period_key)
      .execute();
  }
  await recordChanges(
    executor,
    stale.map((row) => ({
      dataset: KPI_DATASET,
      entityType: KPI_ENTITY_TYPE,
      entityId: snapshotEntityId({
        userId,
        scopeKey: row.scope_key,
        periodKey: row.period_key as SnapshotPeriodKey,
      }),
      scopeType: 'USER' as const,
      scopeId: userId,
      changeType: 'DELETE' as const,
    })),
  );
  return stale.length;
}

export { pairOf as snapshotPair };

/**
 * Supprime (et publie en `DELETE`) les instantanés des utilisateurs qui ne sont plus actifs depuis `since` : compte
 * non actif, aucune session ouverte sur un appareil en service utilisée depuis cette date. Rend le nombre de lignes
 * supprimées. Appelée en fin de passe, jamais au milieu d'une reprise par lots.
 */
export async function deleteSnapshotsOfInactiveUsers(
  executor: Executor,
  since: Date,
): Promise<number> {
  const { rows } = await sql<{ user_id: Buffer; scope_key: string; period_key: string }>`
    SELECT k.user_id AS user_id, k.scope_key AS scope_key, k.period_key AS period_key
      FROM analytics_kpi_snapshots k
     WHERE NOT EXISTS (
       SELECT 1 FROM identity_users u
         JOIN identity_auth_sessions s ON s.user_id = u.id
         JOIN identity_devices d ON d.id = s.device_id
        WHERE u.id = k.user_id AND u.status = 'ACTIVE' AND s.revoked_at IS NULL
          AND d.status = 'ACTIVE' AND s.last_used_at >= ${since})
  `.execute(executor);
  for (const row of rows) {
    await executor
      .deleteFrom('analytics_kpi_snapshots')
      .where('user_id', '=', row.user_id)
      .where('scope_key', '=', row.scope_key)
      .where('period_key', '=', row.period_key)
      .execute();
  }
  await recordChanges(
    executor,
    rows.map((row) => {
      const userId = fromBin(row.user_id);
      return {
        dataset: KPI_DATASET,
        entityType: KPI_ENTITY_TYPE,
        entityId: snapshotEntityId({
          userId,
          scopeKey: row.scope_key,
          periodKey: row.period_key as SnapshotPeriodKey,
        }),
        scopeType: 'USER' as const,
        scopeId: userId,
        changeType: 'DELETE' as const,
      };
    }),
  );
  return rows.length;
}

/** Les instantanés de l'utilisateur, du plus récent au plus ancien — jamais ceux d'un autre. */
export async function listSnapshotsOf(
  executor: Executor,
  userId: string,
): Promise<readonly StoredSnapshot[]> {
  const rows = await executor
    .selectFrom('analytics_kpi_snapshots')
    .select(['scope_key', 'period_key', 'payload', 'computed_at'])
    .where('user_id', '=', toBin(userId))
    .orderBy('scope_key')
    .orderBy('period_key')
    .execute();
  return rows.map((row) => ({
    userId,
    scopeKey: row.scope_key,
    periodKey: row.period_key as SnapshotPeriodKey,
    kpis: ((row.payload as { kpis?: unknown[] } | null)?.kpis ?? []) as unknown[],
    computedAt: row.computed_at,
  }));
}

/** Un instantané précis de l'utilisateur (lecteur du jeu hors ligne `kpi`). */
export async function readSnapshot(
  executor: Executor,
  key: SnapshotKey,
): Promise<StoredSnapshot | undefined> {
  return (await listSnapshotsOf(executor, key.userId)).find(
    (snapshot) => snapshot.scopeKey === key.scopeKey && snapshot.periodKey === key.periodKey,
  );
}

/** Utilisateurs actifs dont un appareil en service a contacté le serveur depuis `since` (reprise après `afterUserId`). */
export async function activeSnapshotUsers(
  executor: Executor,
  input: { readonly since: Date; readonly afterUserId: string | null; readonly limit: number },
): Promise<readonly string[]> {
  const { rows } = await sql<{ id: Buffer }>`
    SELECT u.id AS id
      FROM identity_users u
     WHERE u.status = 'ACTIVE'
       ${input.afterUserId === null ? sql`` : sql`AND u.id > ${toBin(input.afterUserId)}`}
       AND EXISTS (
         SELECT 1 FROM identity_auth_sessions s
           JOIN identity_devices d ON d.id = s.device_id
          WHERE s.user_id = u.id AND s.revoked_at IS NULL AND d.status = 'ACTIVE'
            AND s.last_used_at >= ${input.since})
     ORDER BY u.id
     LIMIT ${sql.lit(input.limit)}
  `.execute(executor);
  return rows.map((row) => fromBin(row.id));
}
