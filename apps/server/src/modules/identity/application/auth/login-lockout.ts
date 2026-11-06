/**
 * Verrouillage progressif de connexion (07-security-rbac/02-securite.md §2 : « 5 échecs →
 * blocage progressif (1, 5, 15 min) par identifiant et par IP »). Compteurs indépendants
 * (`identity.login_attempts`, P0-09) : un essai est compté sur **chacun** (identifiant saisi, compte, IP), un blocage sur
 * l'un OU l'autre suffit à refuser la connexion. AV-297 (a) : l'essai est réservé d'avance et atomiquement
 * (`reserveLoginAttempts`), remis à zéro par une connexion réussie (`resetLoginAttempts`).
 *
 * Un même compte répond à deux identifiants, son téléphone et son adresse e-mail (RP-3) : sans compteur de compte, un
 * attaquant aurait cinq essais sur chacun avant le blocage. Le compteur du **compte** (`accountScope`) est donc partagé
 * par tous ses identifiants ; celui de l'identifiant saisi (`identifierScope`) protège aussi un identifiant inconnu.
 */
import { createHash } from 'node:crypto';
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
 * Compteur d'un identifiant saisi (téléphone ou adresse e-mail). L'identifiant peut compter 200 caractères quand la
 * colonne en tient 64 : la clé est son empreinte SHA-256 (62 caractères hexadécimaux), jamais l'identifiant lui-même. La
 * casse compte, comme dans la recherche du compte (collation sensible à la casse).
 */
export function identifierScope(identifier: string): LoginAttemptScopeRef {
  const digest = createHash('sha256').update(identifier, 'utf8').digest('hex');
  return { scopeType: 'IDENTIFIER', scopeValue: `I:${digest.slice(0, 62)}` };
}

/** Compteur du compte : partagé par son téléphone et son adresse e-mail. */
export function accountScope(userId: string): LoginAttemptScopeRef {
  return { scopeType: 'IDENTIFIER', scopeValue: `U:${userId}` };
}

export function ipScope(ip: string): LoginAttemptScopeRef {
  return { scopeType: 'IP', scopeValue: ip };
}

const byScope = (a: LoginAttemptScopeRef, b: LoginAttemptScopeRef): number =>
  a.scopeType.localeCompare(b.scopeType) || a.scopeValue.localeCompare(b.scopeValue);

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
 * Un blocage déjà posé est refusé par une lecture **sans verrou** : une rafale d'essais depuis une adresse bloquée ne se
 * met pas en file sur la ligne de cette adresse (chaque essai en attente garderait une connexion du pool).
 */
export async function reserveLoginAttempts(
  db: Kysely<DB>,
  scopes: readonly LoginAttemptScopeRef[],
  now: Date,
): Promise<LoginLockStatus> {
  const ordered = [...scopes].sort(byScope);
  // Lecture simple : déjà bloqué ? (refus immédiat, aucun verrou)
  const peeked = await db
    .selectFrom('identity_login_attempts')
    .select('blocked_until')
    .where((eb) =>
      eb.or(
        ordered.map((scope) =>
          eb.and([
            eb('scope_type', '=', scope.scopeType),
            eb('scope_value', '=', scope.scopeValue),
          ]),
        ),
      ),
    )
    .execute();
  const alreadyBlocked = peeked.filter(
    (row) => row.blocked_until !== null && row.blocked_until > now,
  );
  if (alreadyBlocked.length > 0) {
    return {
      blocked: true,
      retryAfter: new Date(Math.max(...alreadyBlocked.map((row) => row.blocked_until!.getTime()))),
    };
  }
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

/** Remet à zéro plusieurs compteurs, dans l'ordre fixe des réservations. */
export async function resetLoginScopes(
  db: Kysely<DB> | Transaction<DB>,
  scopes: readonly LoginAttemptScopeRef[],
): Promise<void> {
  for (const scope of [...scopes].sort(byScope)) {
    await resetLoginAttempts(db, scope.scopeType, scope.scopeValue);
  }
}
