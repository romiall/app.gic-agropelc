/**
 * Verrouillage progressif de connexion (07-security-rbac/02-securite.md §2 : « 5 échecs →
 * blocage progressif (1, 5, 15 min) par identifiant et par IP »). Deux compteurs indépendants
 * (`identity.login_attempts`, P0-09) : un échec incrémente **les deux** (identifiant et IP),
 * un blocage sur l'un OU l'autre suffit à refuser la connexion.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';

export type LoginAttemptScope = 'IDENTIFIER' | 'IP';

const FAILURE_THRESHOLD = 5;
/** Palier atteint à `FAILURE_THRESHOLD`, puis un de plus par échec supplémentaire, plafonné. */
const PROGRESSIVE_BLOCK_MINUTES = [1, 5, 15];

function blockDurationMinutes(failedCount: number): number | null {
  if (failedCount < FAILURE_THRESHOLD) return null;
  const step = Math.min(failedCount - FAILURE_THRESHOLD, PROGRESSIVE_BLOCK_MINUTES.length - 1);
  return PROGRESSIVE_BLOCK_MINUTES[step]!;
}

export interface LoginLockStatus {
  readonly blocked: boolean;
  readonly retryAfter: Date | null;
}

export async function checkLoginLock(
  db: Kysely<DB> | Transaction<DB>,
  scopeType: LoginAttemptScope,
  scopeValue: string,
  now: Date,
): Promise<LoginLockStatus> {
  const row = await db
    .selectFrom('identity_login_attempts')
    .select('blocked_until')
    .where('scope_type', '=', scopeType)
    .where('scope_value', '=', scopeValue)
    .executeTakeFirst();
  if (row?.blocked_until && row.blocked_until > now) {
    return { blocked: true, retryAfter: row.blocked_until };
  }
  return { blocked: false, retryAfter: null };
}

/** Incrémente le compteur d'échecs et (re)calcule `blocked_until` selon le barème progressif. */
export async function recordLoginFailure(
  db: Kysely<DB> | Transaction<DB>,
  scopeType: LoginAttemptScope,
  scopeValue: string,
  now: Date,
): Promise<void> {
  await db
    .insertInto('identity_login_attempts')
    .values({ scope_type: scopeType, scope_value: scopeValue, failed_count: 1 })
    .onDuplicateKeyUpdate({ failed_count: sql`failed_count + 1` })
    .execute();

  const row = await db
    .selectFrom('identity_login_attempts')
    .select('failed_count')
    .where('scope_type', '=', scopeType)
    .where('scope_value', '=', scopeValue)
    .executeTakeFirstOrThrow();

  const blockMinutes = blockDurationMinutes(row.failed_count);
  await db
    .updateTable('identity_login_attempts')
    .set({ blocked_until: blockMinutes ? new Date(now.getTime() + blockMinutes * 60_000) : null })
    .where('scope_type', '=', scopeType)
    .where('scope_value', '=', scopeValue)
    .execute();
}

export async function resetLoginAttempts(
  db: Kysely<DB> | Transaction<DB>,
  scopeType: LoginAttemptScope,
  scopeValue: string,
): Promise<void> {
  await db
    .updateTable('identity_login_attempts')
    .set({ failed_count: 0, blocked_until: null })
    .where('scope_type', '=', scopeType)
    .where('scope_value', '=', scopeValue)
    .execute();
}
