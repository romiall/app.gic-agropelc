/**
 * Lectures des sessions de travail pour les modules qui y rattachent leurs activités (BR-CRM-013
 * « une visite est rattachée automatiquement à la session de travail ouverte de l'utilisateur à
 * `occurred_at` » ; ventes terrain en P4). API publique de `fieldwork`.
 */
import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { fromBin, toBin } from '../../../../platform/kysely/uuid-columns.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface WorkSessionRef {
  readonly id: string;
  readonly userId: string;
  readonly status: string;
  readonly overrideStatus: string;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
}

function toRef(row: {
  readonly id: Buffer;
  readonly user_id: Buffer;
  readonly status: string;
  readonly override_status: string;
  readonly started_at: Date;
  readonly ended_at: Date | null;
}): WorkSessionRef {
  return {
    id: fromBin(row.id),
    userId: fromBin(row.user_id),
    status: row.status,
    overrideStatus: row.override_status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

const COLUMNS = ['id', 'user_id', 'status', 'override_status', 'started_at', 'ended_at'] as const;

export async function findWorkSession(
  executor: Executor,
  sessionId: string,
): Promise<WorkSessionRef | undefined> {
  const row = await executor
    .selectFrom('fieldwork_work_sessions')
    .select([...COLUMNS])
    .where('id', '=', toBin(sessionId))
    .executeTakeFirst();
  return row ? toRef(row) : undefined;
}

/** Session de l'utilisateur couvrant `at` : commencée au plus tard à `at`, pas encore terminée à
 * `at` (ou toujours ouverte). La plus récente si plusieurs (ne devrait pas arriver). */
export async function findWorkSessionAt(
  executor: Executor,
  userId: string,
  at: Date,
): Promise<WorkSessionRef | undefined> {
  const row = await executor
    .selectFrom('fieldwork_work_sessions')
    .select([...COLUMNS])
    .where('user_id', '=', toBin(userId))
    .where('started_at', '<=', at)
    .where((eb) => eb.or([eb('ended_at', 'is', null), eb('ended_at', '>', at)]))
    .orderBy('started_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ? toRef(row) : undefined;
}
