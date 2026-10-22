/**
 * Journal technique des requêtes de l'explorateur (P9-14 ; ADR-074 §10, RC-09, BR-AUD-009) : une ligne par requête,
 * y compris un refus de droit ou de limite. Table `analytics_query_log` (ajout seul, purgée après 90 jours).
 * Le journal technique ne remplace pas l'audit d'un refus de droit (`access.denied`), qui reste écrit par la couche
 * de transport.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { jsonValue } from '../../../../platform/kysely/json-value.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

export type QueryOutcome = 'OK' | 'REFUSED' | 'LIMIT' | 'ERROR';

export interface QueryLogEntry {
  readonly id: string;
  readonly userId: string;
  readonly dataset: string;
  /** Requête telle que reçue, avec la période résolue et la version du catalogue (objet JSON). */
  readonly definition: Record<string, unknown>;
  readonly outcome: QueryOutcome;
  readonly errorCode?: string;
  readonly rowCount?: number;
  readonly durationMs?: number;
}

export async function recordQueryLog(executor: Executor, entry: QueryLogEntry): Promise<void> {
  await executor
    .insertInto('analytics_query_log')
    .values({
      id: toBin(entry.id),
      user_id: toBin(entry.userId),
      dataset: entry.dataset.slice(0, 40),
      definition: jsonValue(entry.definition),
      outcome: entry.outcome,
      error_code: entry.errorCode?.slice(0, 60) ?? null,
      row_count: entry.rowCount ?? null,
      duration_ms: entry.durationMs ?? null,
    })
    .execute();
}
