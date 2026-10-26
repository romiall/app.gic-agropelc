/**
 * Exécution d'une exploration compilée (P9-14 ; BR-ANA-006, ADR-064 §8, ADR-068 §1).
 *
 * - **Une seule connexion** pour l'emplacement de concurrence (verrou nommé, `query-slots.ts`) et pour la lecture :
 *   le verrou vit autant que la requête.
 * - **Un seul instantané** (`REPEATABLE READ`, lecture seule) pour les lignes et le total : un fait validé entre
 *   les deux ne les rend pas incohérents.
 * - **Limites en erreur, jamais en troncature silencieuse** : au-delà de `maxRows` lignes, de `maxExecutionMs`
 *   millisecondes ou du nombre de requêtes simultanées, `ExplorationLimitError`. Une limite de lignes demandée
 *   par l'utilisateur, plus petite que le plafond, est un « premier N » voulu : les N premières lignes sont rendues.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import {
  exploredTotals,
  exploredValues,
  type CompiledColumn,
  type CompiledExploration,
  type ExplorationValue,
} from './compile-exploration.js';
import { acquireQuerySlot, releaseQuerySlot } from './query-slots.js';

type Executor = Kysely<DB> | Transaction<DB>;

/** Nature du dépassement : lignes, durée d'exécution ou requêtes simultanées. */
export type ExplorationLimit = 'rows' | 'time' | 'concurrency';

export class ExplorationLimitError extends Error {
  constructor(
    readonly limit: ExplorationLimit,
    message: string,
  ) {
    super(message);
    this.name = 'ExplorationLimitError';
  }
}

export interface ExplorationResult {
  readonly columns: readonly CompiledColumn[];
  readonly rows: readonly Record<string, ExplorationValue>[];
  readonly rowCount: number;
  /** Totaux des mesures additives ; `null` si une mesure n'est pas additive. */
  readonly totals: Record<string, number> | null;
}

/** `ER_QUERY_TIMEOUT` : `MAX_EXECUTION_TIME` dépassé. */
const QUERY_TIMEOUT_ERRNO = 3024;

const isQueryTimeout = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  ((error as { errno?: unknown }).errno === QUERY_TIMEOUT_ERRNO ||
    (error as { code?: unknown }).code === 'ER_QUERY_TIMEOUT');

/** Lit les lignes et le total d'une exploration compilée sur l'exécuteur donné. */
export async function executeExploration(
  executor: Executor,
  compiled: CompiledExploration,
  limits: { readonly maxRows: number; readonly maxExecutionMs: number },
): Promise<ExplorationResult> {
  try {
    const { rows: raw } = await compiled.rows.execute(executor);
    if (raw.length > compiled.rowLimit && compiled.rowLimit >= limits.maxRows) {
      throw new ExplorationLimitError(
        'rows',
        `Plus de ${limits.maxRows} lignes : affinez la requête (période, filtres, regroupements).`,
      );
    }
    const kept = raw.slice(0, compiled.rowLimit);
    let totals: Record<string, number> | null = null;
    if (compiled.totalsFromRow && kept[0] !== undefined) {
      totals = exploredTotals(compiled.columns, kept[0]);
    } else if (compiled.totals !== null) {
      const { rows: totalRows } = await compiled.totals.execute(executor);
      totals = exploredTotals(compiled.columns, totalRows[0] ?? {});
    }
    return {
      columns: compiled.columns,
      rows: kept.map((row) => exploredValues(compiled.columns, row)),
      rowCount: kept.length,
      totals,
    };
  } catch (error) {
    if (isQueryTimeout(error)) {
      throw new ExplorationLimitError(
        'time',
        `La requête dépasse ${Math.round(limits.maxExecutionMs / 1000)} s : affinez la requête (période, filtres, regroupements).`,
      );
    }
    throw error;
  }
}

/**
 * Exécute l'exploration sous un emplacement de concurrence de l'utilisateur, dans un instantané en lecture
 * seule. `db` est la base entière : la connexion est épinglée ici.
 */
export async function runExploration(
  db: Kysely<DB>,
  input: {
    readonly userId: string;
    readonly compiled: CompiledExploration;
    readonly limits: {
      readonly maxRows: number;
      readonly maxExecutionMs: number;
      readonly maxConcurrentPerUser: number;
    };
  },
): Promise<ExplorationResult> {
  return db.connection().execute(async (connection) => {
    const slot = await acquireQuerySlot(
      connection,
      input.userId,
      input.limits.maxConcurrentPerUser,
    );
    if (slot === null) {
      throw new ExplorationLimitError(
        'concurrency',
        `Au plus ${input.limits.maxConcurrentPerUser} requêtes simultanées : attendez la fin d’une requête en cours.`,
      );
    }
    try {
      return await connection
        .transaction()
        .setIsolationLevel('repeatable read')
        .setAccessMode('read only')
        .execute((trx) => executeExploration(trx, input.compiled, input.limits));
    } finally {
      try {
        await releaseQuerySlot(connection, input.userId, slot);
      } catch {
        // Connexion perdue : MySQL libère le verrou avec elle.
      }
    }
  });
}
