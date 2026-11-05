/**
 * Verrouillage progressif de connexion (07-security-rbac/02-securite.md §2 : « 5 échecs →
 * blocage progressif (1, 5, 15 min) par identifiant et par IP »). Deux compteurs indépendants
 * (`identity.login_attempts`, P0-09) : un essai est compté sur **les deux** (identifiant et IP), un blocage sur l'un OU
 * l'autre suffit à refuser la connexion. AV-297 (a) : l'essai est réservé d'avance et atomiquement
 * (`reserveLoginAttempts`), remis à zéro par une connexion réussie (`resetLoginAttempts`).
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

export interface LoginAttemptScopeRef {
  readonly scopeType: LoginAttemptScope;
  readonly scopeValue: string;
}

/**
 * Réservation atomique d'un essai de connexion (AV-297 (a)) : l'essai est **compté d'avance**, avant la vérification
 * du mot de passe, et remis à zéro par une connexion réussie (`resetLoginAttempts`). Lire le blocage avant la
 * vérification puis compter l'échec après laissait N essais simultanés passer tous le contrôle ; ici les lignes de
 * compteur sont verrouillées (`FOR UPDATE`, ordre fixe : pas d'interblocage) le temps de la réservation — courte, sans
 * hachage dans la transaction — donc les réservations se suivent : au plus `FAILURE_THRESHOLD` essais sont admis avant
 * que le blocage ne tombe, les suivants sont refusés sans être comptés ni vérifiés.
 *
 * Un essai refusé (déjà bloqué sur l'une des portées) ne compte sur aucune. Le blocage se pose dès la réservation du
 * cinquième essai (palier de `blockDurationMinutes`) ; ce cinquième essai est admis, et s'il réussit il remet tout à zéro.
 */
export async function reserveLoginAttempts(
  db: Kysely<DB>,
  scopes: readonly LoginAttemptScopeRef[],
  now: Date,
): Promise<LoginLockStatus> {
  const ordered = [...scopes].sort(
    (a, b) => a.scopeType.localeCompare(b.scopeType) || a.scopeValue.localeCompare(b.scopeValue),
  );
  return db.transaction().execute(async (trx) => {
    for (const scope of ordered) {
      await trx
        .insertInto('identity_login_attempts')
        .values({ scope_type: scope.scopeType, scope_value: scope.scopeValue, failed_count: 0 })
        .onDuplicateKeyUpdate({ failed_count: sql`failed_count` })
        .execute();
    }
    const rows: { scope: LoginAttemptScopeRef; failed: number; blockedUntil: Date | null }[] = [];
    for (const scope of ordered) {
      const row = await trx
        .selectFrom('identity_login_attempts')
        .select(['failed_count', 'blocked_until'])
        .where('scope_type', '=', scope.scopeType)
        .where('scope_value', '=', scope.scopeValue)
        .forUpdate()
        .executeTakeFirstOrThrow();
      rows.push({ scope, failed: row.failed_count, blockedUntil: row.blocked_until });
    }
    const blocked = rows.filter((row) => row.blockedUntil !== null && row.blockedUntil > now);
    if (blocked.length > 0) {
      return {
        blocked: true,
        retryAfter: new Date(Math.max(...blocked.map((row) => row.blockedUntil!.getTime()))),
      };
    }
    for (const row of rows) {
      const failed = row.failed + 1;
      const minutes = blockDurationMinutes(failed);
      await trx
        .updateTable('identity_login_attempts')
        .set({
          failed_count: failed,
          blocked_until: minutes ? new Date(now.getTime() + minutes * 60_000) : null,
        })
        .where('scope_type', '=', row.scope.scopeType)
        .where('scope_value', '=', row.scope.scopeValue)
        .execute();
    }
    return { blocked: false, retryAfter: null };
  });
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
