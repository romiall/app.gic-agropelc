/**
 * État d'une session à chaque requête (AV-282, décision du porteur du 14/10/2026 : « blocage
 * immédiat ») : un jeton d'accès ne vaut que si sa session est vivante, son utilisateur actif et son
 * appareil en service. La rotation remplace la ligne de session (ligne `ROTATED`, même famille) : un
 * jeton émis juste avant reste valide tant que sa **famille** a une session vivante. Une révocation
 * (déconnexion, réinitialisation, désactivation, blocage d'appareil, réutilisation) ne laisse aucune
 * session vivante dans la famille : le jeton est refusé dès la requête suivante.
 *
 * Mise en cache par session quelques secondes (une lecture par requête sinon), vidée à chaque
 * révocation dans ce processus (`forgetSessionStates`).
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../../platform/kysely/database.js';
import { toBin } from '../../../../platform/kysely/uuid-columns.js';

export type SessionAccess =
  'ACTIVE' | 'SESSION_REVOKED' | 'USER_INACTIVE' | 'DEVICE_OUT_OF_SERVICE';

/** Durée de validité de l'état lu (AV-282 : « petit cache de quelques secondes »). */
export const SESSION_STATE_TTL_MS = 5_000;

/** Statuts d'appareil qui gardent l'accès (un appareil en attente lit et voit son attente, AV-228). */
const DEVICE_IN_SERVICE: ReadonlySet<string> = new Set(['ACTIVE', 'PENDING']);

const states = new Map<string, { readonly access: SessionAccess; readonly until: number }>();

/** Vide le cache : appelé par chaque révocation de session de ce processus. */
export function forgetSessionStates(): void {
  states.clear();
}

export async function sessionAccessAt(
  executor: Kysely<DB> | Transaction<DB>,
  input: {
    readonly sessionId: string;
    readonly userId: string;
    readonly deviceId: string;
    readonly at: Date;
  },
): Promise<SessionAccess> {
  const row = await executor
    .selectFrom('identity_auth_sessions as s')
    .innerJoin('identity_users as u', 'u.id', 's.user_id')
    .innerJoin('identity_devices as d', 'd.id', 's.device_id')
    .select((eb) => [
      'u.status as user_status',
      'd.status as device_status',
      eb
        .exists(
          eb
            .selectFrom('identity_auth_sessions as f')
            .select(sql<number>`1`.as('one'))
            .whereRef('f.token_family_id', '=', 's.token_family_id')
            .where('f.revoked_at', 'is', null)
            .where('f.expires_at', '>', input.at),
        )
        .as('alive'),
    ])
    .where('s.id', '=', toBin(input.sessionId))
    .where('s.user_id', '=', toBin(input.userId))
    .where('s.device_id', '=', toBin(input.deviceId))
    .executeTakeFirst();
  if (!row || Number(row.alive) !== 1) return 'SESSION_REVOKED';
  if (row.user_status !== 'ACTIVE') return 'USER_INACTIVE';
  if (!DEVICE_IN_SERVICE.has(row.device_status)) return 'DEVICE_OUT_OF_SERVICE';
  return 'ACTIVE';
}

/** `sessionAccessAt` mis en cache `SESSION_STATE_TTL_MS` par session. */
export async function cachedSessionAccess(
  executor: Kysely<DB> | Transaction<DB>,
  input: {
    readonly sessionId: string;
    readonly userId: string;
    readonly deviceId: string;
    readonly at: Date;
  },
): Promise<SessionAccess> {
  const key = `${input.sessionId}:${input.userId}:${input.deviceId}`;
  const now = Date.now();
  const cached = states.get(key);
  if (cached && cached.until > now) return cached.access;
  const access = await sessionAccessAt(executor, input);
  states.set(key, { access, until: now + SESSION_STATE_TTL_MS });
  return access;
}
